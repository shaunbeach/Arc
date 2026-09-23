import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("cli", () => {
	it("refuses --serve with --resume instead of silently dropping --serve", () => {
		for (const args of [
			["--serve", "--resume"],
			["--resume", "--serve", "fake"],
		]) {
			const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10_000 });
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("error: --serve cannot be combined with --resume");
		}
	});
});
