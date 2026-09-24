import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/context.ts";
import { toChatTools } from "../src/llm/llama-client.ts";
import { PONYTAIL_LEVEL_RULES } from "../src/ponytail.ts";
import { buildSystemPrompt, estimateFixedPromptTokens } from "../src/prompt.ts";
import { createCodingTools, toolLimitsFor } from "../src/tools/index.ts";

describe("system prompt", () => {
	const systemPrompt = buildSystemPrompt({ cwd: "/work/project", platform: "darwin" });
	const tools = createCodingTools({ cwd: "/work/project", limits: toolLimitsFor(12_000), acceptsImages: false });

	it("drops every mention of the web tools when web is off", () => {
		for (const mode of ["agent", "plan", "chat"] as const) {
			const on = buildSystemPrompt({ cwd: "/work/project", platform: "darwin", interactionMode: mode });
			const off = buildSystemPrompt({ cwd: "/work/project", platform: "darwin", interactionMode: mode, web: false });
			expect(off).not.toMatch(/web_search|web_fetch|internet/);
			expect(off).toContain("Working directory: /work/project");
			expect(on).toContain("web_search");
		}
		expect(buildSystemPrompt({ cwd: "/w", interactionMode: "chat", web: false })).toContain(
			"no tools and no web access",
		);
	});

	it("keeps the system prompt and tool definitions under 1000 tokens", () => {
		// Three characters per token overestimates real tokenizers, so the bound holds with margin.
		const characters = systemPrompt.length + JSON.stringify(toChatTools(tools)).length;
		expect(characters).toBeLessThan(3000);
		expect(estimateFixedPromptTokens(systemPrompt, tools)).toBeLessThan(1000);
	});

	it("keeps plan and chat prompts and their tools under 1000 tokens", () => {
		for (const mode of ["plan", "chat"] as const) {
			const prompt = buildSystemPrompt({ cwd: "/work/project", platform: "darwin", interactionMode: mode });
			const modeTools = tools.filter((t) =>
				mode === "chat"
					? ["web_search", "web_fetch"].includes(t.name)
					: ["read", "web_search", "web_fetch"].includes(t.name),
			);
			const characters = prompt.length + JSON.stringify(toChatTools(modeTools)).length;
			expect(characters).toBeLessThan(3000);
			expect(estimateFixedPromptTokens(prompt, modeTools)).toBeLessThan(1000);
		}
	});

	it("mentions kb_search only while rag is on, for about a hundred more tokens", () => {
		const knowledgeBase = { search: async () => ({ total: 0, hits: [] }), article: async () => undefined };
		const withKb = createCodingTools({
			cwd: "/work/project",
			limits: toolLimitsFor(12_000),
			acceptsImages: false,
			knowledgeBase,
		});
		expect(withKb.map((tool) => tool.name)).toContain("kb_search");
		for (const mode of ["agent", "plan", "chat"] as const) {
			for (const web of [true, false]) {
				const off = buildSystemPrompt({ cwd: "/work/project", platform: "darwin", interactionMode: mode, web });
				const on = buildSystemPrompt({
					cwd: "/work/project",
					platform: "darwin",
					interactionMode: mode,
					web,
					rag: true,
				});
				expect(off).not.toContain("kb_search");
				expect(on).toContain("kb_search");
			}
		}
		const rag = buildSystemPrompt({ cwd: "/work/project", platform: "darwin", rag: true });
		const added = estimateFixedPromptTokens(rag, withKb) - estimateFixedPromptTokens(systemPrompt, tools);
		expect(added).toBeLessThan(150);
	});

	it("adds the ponytail rules only while ponytail is on, for under 300 more tokens", () => {
		for (const mode of ["agent", "plan", "chat"] as const) {
			const options = { cwd: "/work/project", platform: "darwin", interactionMode: mode };
			expect(buildSystemPrompt({ ...options, ponytail: "off" })).toBe(buildSystemPrompt(options));
			for (const level of ["lite", "full", "ultra"] as const) {
				const prompt = buildSystemPrompt({ ...options, ponytail: level });
				expect(prompt).toContain(`Ponytail (${level})`);
				expect(prompt).toContain(PONYTAIL_LEVEL_RULES[level]);
				expect(estimateTokens(prompt) - estimateTokens(buildSystemPrompt(options))).toBeLessThan(300);
			}
		}
	});

	it("names the OS and the working directory", () => {
		expect(systemPrompt).toContain("OS: darwin");
		expect(systemPrompt).toContain("Working directory: /work/project");
	});

	it("is byte-identical across calls, so the KV cache prefix is reused", () => {
		expect(buildSystemPrompt({ cwd: "/work/project", platform: "darwin" })).toBe(systemPrompt);
	});

	it("scales tool output caps with the context window", () => {
		expect(toolLimitsFor(12_000).maxBytes).toBe(7200);
		// The reply reserve does not count: 20k with 8k reserved leaves room for about 7KB per result.
		expect(toolLimitsFor(20_000, 8192).maxBytes).toBe(7084);
		expect(toolLimitsFor(4096).maxBytes).toBe(4096);
		expect(toolLimitsFor(262_144).maxBytes).toBe(50 * 1024);
	});
});
