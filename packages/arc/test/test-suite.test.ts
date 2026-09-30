import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import { parseTestArgs, progressIn, reportIn, runSuite, type SuiteCommand, suiteCommand } from "../src/test-suite.ts";

const MODEL: LiteModel = {
	name: "Qwen3.5-4B-Q6_K",
	id: "q.gguf",
	provider: "llamacpp",
	baseUrl: "http://localhost:8080/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 131072,
	maxTokens: 16384,
	modelPath: "/models/q.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};

/** A suites folder with both suites' entry points, empty. */
function suitesFolder(): string {
	const folder = mkdtempSync(join(tmpdir(), "arc-suites-"));
	mkdirSync(join(folder, "Eval", "src"), { recursive: true });
	writeFileSync(join(folder, "Eval", "src", "cli.ts"), "");
	mkdirSync(join(folder, "Work_Bench"));
	writeFileSync(join(folder, "Work_Bench", "evalctl"), "");
	return folder;
}

const QUICK = { quick: true, resume: false };
const FULL = { quick: false, resume: false };

describe("parseTestArgs", () => {
	it("reads suites and options in any order", () => {
		expect(parseTestArgs("eval")).toEqual({ suites: ["eval"], options: FULL });
		expect(parseTestArgs("quick workbench")).toEqual({ suites: ["workbench"], options: QUICK });
		expect(parseTestArgs("all quick")).toEqual({ suites: ["eval", "workbench"], options: QUICK });
		expect(parseTestArgs("work_bench resume")).toEqual({
			suites: ["workbench"],
			options: { quick: false, resume: true },
		});
	});

	it("explains what it takes", () => {
		expect(parseTestArgs("")).toEqual({ error: expect.stringContaining("/test eval") });
		expect(parseTestArgs("eval fast")).toEqual({ error: expect.stringContaining('Unknown /test argument "fast"') });
	});
});

describe("suiteCommand", () => {
	it("runs Eval on the model by name, in the chosen mode, with Arc's models.yml", () => {
		const folder = suitesFolder();
		const run = suiteCommand(folder, "eval", MODEL, "instruct", "/cfg/models.yml", QUICK);
		expect(run).toMatchObject({
			cwd: join(folder, "Eval"),
			command: process.execPath,
			args: [
				"src/cli.ts",
				"run",
				"-m",
				"Qwen3.5-4B-Q6_K",
				"--mode",
				"instruct",
				"--models",
				"/cfg/models.yml",
				"--quick",
				"-n",
				"1",
			],
		});
	});

	it("points Work_Bench at the server Arc runs, so the model needs no entry of its own", () => {
		const folder = suitesFolder();
		const discovered = { ...MODEL, name: "mac", servedModel: "tiny-7b", contextWindow: 65536 };
		const run = suiteCommand(folder, "workbench", discovered, "thinking", "/cfg/models.yml", FULL);
		expect(run).toMatchObject({
			command: join(folder, "Work_Bench", "evalctl"),
			args: ["run", "--model", "mac", "-k", "3"],
			env: {
				ARC_MODELS: "/cfg/models.yml",
				EVAL_BASE_URL: "http://localhost:8080",
				EVAL_MODEL: "tiny-7b",
				EVAL_CONTEXT: "65536",
			},
		});
		const quick = suiteCommand(folder, "workbench", MODEL, "thinking", "/m.yml", { quick: true, resume: true });
		expect(quick).toMatchObject({
			args: ["run", "--model", MODEL.name, "--profile", "smoke", "-k", "1", "--resume"],
		});
	});

	it("names a suite that is missing", () => {
		const empty = mkdtempSync(join(tmpdir(), "arc-suites-"));
		expect(suiteCommand(empty, "eval", MODEL, "thinking", "/m.yml", FULL)).toEqual({
			error: `No Eval suite at ${join(empty, "Eval")}.`,
		});
		expect(suiteCommand(empty, "workbench", MODEL, "thinking", "/m.yml", FULL)).toEqual({
			error: `No Work_Bench suite at ${join(empty, "Work_Bench")}.`,
		});
	});
});

describe("suite output", () => {
	it("finds report paths, this run's apart from the dashboard", () => {
		expect(reportIn("Run report: /s/Eval/runs/x/report.html")).toEqual({
			path: "/s/Eval/runs/x/report.html",
			thisRun: true,
		});
		expect(reportIn("  report:  /s/Work_Bench/reports/r.html")).toEqual({
			path: "/s/Work_Bench/reports/r.html",
			thisRun: true,
		});
		expect(reportIn("All-runs dashboard: /s/Eval/runs/report.html")).toEqual({
			path: "/s/Eval/runs/report.html",
			thisRun: false,
		});
		expect(reportIn("PASS T-01 r1  2.0s  score 1.00")).toBeUndefined();
	});

	it("reads results and task starts", () => {
		expect(progressIn("PASS T-SCH-01 r1  2.0s  score 1.00")).toEqual({ pass: true });
		expect(progressIn("FAIL W-02 r3  9.1s  score 0.40  x word limit")).toEqual({ pass: false });
		expect(progressIn("  [3/9] DOC-08  Triage the inbox ... 0.812")).toEqual({ task: "3/9 DOC-08" });
		expect(progressIn("  tokenizer: 3.10 chars/token prose")).toBeUndefined();
	});
});

/** A suite stand-in: a shell script in a temp folder. */
function script(body: string): SuiteCommand {
	const cwd = mkdtempSync(join(tmpdir(), "arc-suite-run-"));
	const path = join(cwd, "suite.sh");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return { suite: "workbench", title: "Fake", cwd, command: path, args: [], env: { ...process.env } };
}

describe("runSuite", () => {
	it("passes whole lines on, joins a line printed in parts, and collects reports", async () => {
		const lines: string[] = [];
		const partials: string[] = [];
		const result = await runSuite(
			script(
				'printf "  [1/2] DOC-01  title ... "; sleep 0.1; echo "0.900"\necho "All-runs dashboard: /d.html" >&2\necho "  report:  /r.html"\nexit 0',
			),
			(line) => lines.push(line),
			new AbortController().signal,
			(partial) => partials.push(partial),
		);
		expect(partials).toEqual(["  [1/2] DOC-01  title ... "]);
		expect(lines).toContain("  [1/2] DOC-01  title ... 0.900");
		expect(result).toEqual({
			code: 0,
			reports: [
				{ path: "/r.html", thisRun: true },
				{ path: "/d.html", thisRun: false },
			],
		});
	});

	it("stops the suite and everything it started when aborted", async () => {
		const controller = new AbortController();
		const run = script("echo started\nsleep 30 &\nwait");
		const started = Date.now();
		const result = runSuite(
			run,
			(line) => {
				if (line === "started") controller.abort();
			},
			controller.signal,
		);
		expect((await result).code).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(10_000);
		// A loaded machine can be slow to start the script; the check above is what matters.
	}, 15_000);

	it("reports a suite that cannot start", async () => {
		const lines: string[] = [];
		const result = await runSuite(
			{ suite: "eval", title: "Eval", cwd: tmpdir(), command: "/nonexistent/suite", args: [], env: {} },
			(line) => lines.push(line),
			new AbortController().signal,
		);
		expect(result.code).toBeNull();
		expect(lines[0]).toMatch(/^Could not start Eval: /);
	});
});
