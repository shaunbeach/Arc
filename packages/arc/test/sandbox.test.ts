import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelsConfig } from "../src/config/models.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { runShellCommand } from "../src/tools/child-process.ts";
import {
	projectRoot,
	type SandboxPolicy,
	sandboxAvailable,
	sandboxNote,
	sandboxPolicy,
	seatbeltProfile,
	setSandbox,
} from "../src/tools/sandbox.ts";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const CONFIG = `
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    auth: none
    modelDir: /models
    models:
      - id: a.gguf
        contextWindow: 8192
`;
const parse = (text: string) => parseModelsConfig(text, "/cfg/models.yml");

describe("sandbox config", () => {
	it("is absent without a sandbox section, and defaults to off with one", () => {
		expect(parse(CONFIG).sandbox).toBeUndefined();
		expect(parse(`${CONFIG}\nsandbox:\n  writable: [out, ~/x]`).sandbox).toEqual({
			level: "off",
			writable: ["/cfg/out", join(homedir(), "x")],
		});
	});

	it("reads a level, including YAML booleans", () => {
		expect(parse(`${CONFIG}\nsandbox:\n  level: net`).sandbox?.level).toBe("net");
		expect(parse(`${CONFIG}\nsandbox:\n  level: false`).sandbox?.level).toBe("off");
		expect(() => parse(`${CONFIG}\nsandbox:\n  level: loose`)).toThrow(/sandbox.level must be one of on, net, off/);
	});
});

describe("sandbox policy", () => {
	it("writes to the git root above a subfolder, temp folders, and caches", () => {
		const repo = tempDir("arc-sb-repo-");
		mkdirSync(join(repo, ".git"));
		mkdirSync(join(repo, "packages", "app"), { recursive: true });
		expect(projectRoot(join(repo, "packages", "app"))).toBe(repo);

		const policy = sandboxPolicy("on", join(repo, "packages", "app"), [], "/home/u");
		expect(policy?.project).toBe(repo);
		expect(policy?.writableRoots).toEqual([
			repo,
			realpathSync(tmpdir()),
			"/private/tmp",
			"/home/u/Library/Caches",
			"/home/u/.cache",
			"/home/u/.npm",
			"/home/u/.matplotlib",
		]);
		expect(sandboxPolicy("off", repo)).toBeUndefined();
	});

	it("limits the network only at on", () => {
		const policy = sandboxPolicy("on", "/p", [], "/h") as SandboxPolicy;
		expect(seatbeltProfile(policy)).toContain("(deny network-outbound)");
		expect(seatbeltProfile({ ...policy, level: "net" })).not.toContain("network-outbound");
		expect(seatbeltProfile(policy)).toContain('(subpath (param "WRITABLE_ROOT_5"))');
	});

	it("explains blocked commands to the model", () => {
		const on = sandboxPolicy("on", "/p", [], "/h") as SandboxPolicy;
		expect(sandboxNote("curl: (6) Could not resolve host: pypi.org", on)).toMatch(/blocks internet access/);
		expect(sandboxNote("curl: (6) Could not resolve host: pypi.org", { ...on, level: "net" })).toBeUndefined();
		expect(sandboxNote("curl: (7) Failed to connect to 192.0.2.1 port 80 after 1 ms", on)).toMatch(/internet/);
		expect(sandboxNote("nc: connectx to 192.0.2.1 port 80 (tcp) failed: Operation not permitted", on)).toMatch(
			/internet/,
		);
		// A dev server that has not started yet is the model's problem, not the sandbox's.
		expect(sandboxNote("curl: (7) Failed to connect to localhost port 3000 after 0 ms", on)).toBeUndefined();
		expect(sandboxNote("touch: /x: Operation not permitted", on)).toMatch(/write only inside \/p/);
		expect(sandboxNote("No application knows how to open URL file:///p/chart.png", on)).toMatch(
			/blocks opening files/,
		);
		expect(sandboxNote("all good", on)).toBeUndefined();
		expect(sandboxNote("Could not resolve host", undefined)).toBeUndefined();
	});
});

describe.skipIf(!sandboxAvailable())("sandboxed commands", () => {
	afterEach(() => setSandbox(undefined));

	const run = async (command: string, cwd: string) => {
		let output = "";
		const result = await runShellCommand(command, cwd, {
			onData: (data) => {
				output += data.toString();
			},
		});
		return { exitCode: result.exitCode, output };
	};

	it("write in the project but not outside it", async () => {
		const project = tempDir("arc-sb-project-");
		// Outside every writable root: temp folders are writable, so this one lives in the home folder.
		const outside = mkdtempSync(join(homedir(), ".arc-sb-outside-"));
		try {
			writeFileSync(join(outside, "keep.txt"), "keep");
			setSandbox(sandboxPolicy("on", project));
			expect((await run("echo hi > inside.txt && cat inside.txt", project)).output).toBe("hi\n");
			const blocked = await run(`echo x >> ${outside}/keep.txt; rm ${outside}/keep.txt`, project);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.output).toMatch(/Operation not permitted/);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("reach localhost but not other hosts at on", async () => {
		const project = tempDir("arc-sb-net-");
		const server = createServer((_request, response) => response.end("local"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			setSandbox(sandboxPolicy("on", project));
			expect((await run(`curl -sS http://localhost:${port}/`, project)).output).toBe("local");
			// 192.0.2.1 is reserved for documentation: unsandboxed it times out, sandboxed it fails at once.
			const blocked = await run("/usr/bin/nc -vz -G 2 192.0.2.1 80", project);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.output).toMatch(/Operation not permitted/);
		} finally {
			server.close();
		}
	});

	it("tell the model through bash when a command was blocked", async () => {
		const cwd = tempDir("arc-sb-bash-");
		setSandbox(sandboxPolicy("on", cwd));
		const bash = createBashTool({ cwd, limits: { maxLines: 2000, maxBytes: 50 * 1024 }, acceptsImages: false });
		await expect(bash.execute("t1", { command: "curl -sS -m 5 https://example.com" })).rejects.toThrow(
			/blocks internet access/,
		);
	});
});
