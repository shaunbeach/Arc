import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAppDir, migrateLegacyAppDir } from "../src/config/paths.ts";

describe("app directory", () => {
	it("reads ARC_DIR, then the old PI_LITE_DIR", () => {
		expect(getAppDir({ ARC_DIR: "/a", PI_LITE_DIR: "/b" })).toBe("/a");
		expect(getAppDir({ PI_LITE_DIR: "/b" })).toBe("/b");
		expect(getAppDir({})).toMatch(/\.arc$/);
	});

	it("moves ~/.pi-lite to ~/.arc once, keeping what it holds", () => {
		const home = mkdtempSync(join(tmpdir(), "arc-home-"));
		mkdirSync(join(home, ".pi-lite", "sessions"), { recursive: true });
		writeFileSync(join(home, ".pi-lite", "last-used.json"), "{}");

		expect(migrateLegacyAppDir({}, home)).toBe(`Moved ${join(home, ".pi-lite")} to ${join(home, ".arc")}.`);
		expect(existsSync(join(home, ".pi-lite"))).toBe(false);
		expect(readFileSync(join(home, ".arc", "last-used.json"), "utf8")).toBe("{}");
		expect(existsSync(join(home, ".arc", "sessions"))).toBe(true);
		// Nothing left to move.
		expect(migrateLegacyAppDir({}, home)).toBeUndefined();
	});

	it("leaves both alone when ~/.arc exists or a directory is configured", () => {
		const home = mkdtempSync(join(tmpdir(), "arc-home-"));
		mkdirSync(join(home, ".pi-lite"));
		expect(migrateLegacyAppDir({ ARC_DIR: "/x" }, home)).toBeUndefined();
		expect(migrateLegacyAppDir({ PI_LITE_DIR: "/x" }, home)).toBeUndefined();
		mkdirSync(join(home, ".arc"));
		expect(migrateLegacyAppDir({}, home)).toBeUndefined();
		expect(existsSync(join(home, ".pi-lite"))).toBe(true);
	});
});
