import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWing, readMemoryWing, transcriptText, wingName, writeMemoryWing } from "../src/rag/mempalace.ts";
import { createCodingTools, toolLimitsFor } from "../src/tools/index.ts";

describe("mempalace", () => {
	it("names the wing after the project folder", () => {
		expect(defaultWing("/work/My App")).toBe("my_app");
		expect(defaultWing("/")).toBe("project");
		expect(wingName("mempal-a")).toBe("mempal_a");
	});

	it("reads back the wing /mempalace wrote", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arc-mempalace-"));
		expect(readMemoryWing(cwd)).toBeUndefined();
		writeMemoryWing(cwd, "arc");
		expect(readMemoryWing(cwd)).toBe("arc");
	});

	it("keeps user and assistant text, not tool calls or thinking", () => {
		const text = transcriptText([
			{ role: "user", content: "why\nthis?", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "Because." },
					{ type: "toolCall", id: "1", name: "read", arguments: {} },
				],
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				stopReason: "stop",
				timestamp: 0,
			},
		] as never);
		expect(text).toBe("> why\n> this?\n\nBecause.\n");
	});

	it("offers the memory tool only when there is a palace", () => {
		const base = { cwd: "/w", limits: toolLimitsFor(12_000), acceptsImages: false };
		expect(createCodingTools(base).map((tool) => tool.name)).not.toContain("memory");
		expect(createCodingTools({ ...base, memory: { wing: "w" } }).map((tool) => tool.name)).toContain("memory");
	});
});
