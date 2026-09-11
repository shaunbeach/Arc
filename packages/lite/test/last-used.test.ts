import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLastUsed, writeLastUsed } from "../src/config/last-used.ts";

const appDir = () => mkdtempSync(join(tmpdir(), "pi-lite-last-used-"));

describe("last used model", () => {
	it("round-trips the model and mode, creating the app directory", () => {
		const dir = join(appDir(), "nested");
		writeLastUsed(dir, { model: "Qwen3.8-27B-IQ3_XXS-medium", mode: "thinking" });
		expect(readLastUsed(dir)).toEqual({ model: "Qwen3.8-27B-IQ3_XXS-medium", mode: "thinking" });
	});

	it("ignores a missing, corrupt, or malformed file", () => {
		const dir = appDir();
		expect(readLastUsed(dir)).toBeUndefined();
		writeFileSync(join(dir, "last-used.json"), "{not json");
		expect(readLastUsed(dir)).toBeUndefined();
		writeFileSync(join(dir, "last-used.json"), JSON.stringify({ model: "m", mode: "fast" }));
		expect(readLastUsed(dir)).toBeUndefined();
	});
});
