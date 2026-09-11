import { describe, expect, it } from "vitest";
import { toChatTools } from "../src/llm/llama-client.ts";
import { buildSystemPrompt, estimateFixedPromptTokens } from "../src/prompt.ts";
import { createCodingTools, toolLimitsFor } from "../src/tools/index.ts";

describe("system prompt", () => {
	const systemPrompt = buildSystemPrompt({ cwd: "/work/project", platform: "darwin" });
	const tools = createCodingTools({ cwd: "/work/project", limits: toolLimitsFor(12_000), acceptsImages: false });

	it("keeps the system prompt and tool definitions under 1000 tokens", () => {
		// Three characters per token overestimates real tokenizers, so the bound holds with margin.
		const characters = systemPrompt.length + JSON.stringify(toChatTools(tools)).length;
		expect(characters).toBeLessThan(3000);
		expect(estimateFixedPromptTokens(systemPrompt, tools)).toBeLessThan(1000);
	});

	it("names the OS and the working directory", () => {
		expect(systemPrompt).toContain("OS: darwin");
		expect(systemPrompt).toContain("Working directory: /work/project");
	});

	it("is byte-identical across calls, so the KV cache prefix is reused", () => {
		expect(buildSystemPrompt({ cwd: "/work/project", platform: "darwin" })).toBe(systemPrompt);
	});

	it("scales tool output caps with the context window", () => {
		expect(toolLimitsFor(12_000).maxBytes).toBe(9000);
		expect(toolLimitsFor(4096).maxBytes).toBe(4096);
		expect(toolLimitsFor(262_144).maxBytes).toBe(50 * 1024);
	});
});
