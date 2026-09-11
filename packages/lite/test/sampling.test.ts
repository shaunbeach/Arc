import { describe, expect, it } from "vitest";
import { buildSamplingBody, defaultSamplingMode, resolvePreset, SAMPLING_PRESETS } from "../src/config/sampling.ts";

describe("sampling presets", () => {
	it("builds the thinking body for a reasoning model", () => {
		expect(buildSamplingBody(resolvePreset("thinking"), true)).toEqual({
			temperature: 1.0,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 0.0,
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: false },
		});
	});

	it("builds the instruct body for a reasoning model", () => {
		expect(buildSamplingBody(resolvePreset("instruct"), true)).toEqual({
			temperature: 0.7,
			top_p: 0.8,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 1.5,
			chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
		});
	});

	it("asks the template to preserve thinking only when the whole history is replayed", () => {
		const preset = resolvePreset("thinking", { thinking: { thinkingHistory: "all" } });
		expect(buildSamplingBody(preset, true)).toMatchObject({
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
		});
	});

	it("omits chat_template_kwargs for models without reasoning", () => {
		expect(buildSamplingBody(resolvePreset("instruct"), false)).not.toHaveProperty("chat_template_kwargs");
	});

	it("sends reasoning_effort and merges extra fields last", () => {
		const preset = resolvePreset("thinking", {
			thinking: {
				reasoningEffort: "high",
				extra: { temperature: 0.6, thinking_budget_tokens: 1024, chat_template_kwargs: { custom: 1 } },
			},
		});
		expect(buildSamplingBody(preset, true)).toEqual({
			temperature: 0.6,
			top_p: 0.95,
			top_k: 20,
			min_p: 0,
			presence_penalty: 0,
			reasoning_effort: "high",
			thinking_budget_tokens: 1024,
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: false, custom: 1 },
		});
	});

	it("applies overrides without mutating the shared presets", () => {
		const preset = resolvePreset("instruct", { instruct: { presence_penalty: 0.5, extra: { seed: 1 } } });
		expect(preset.presence_penalty).toBe(0.5);
		expect(preset.extra).toEqual({ seed: 1 });
		expect(SAMPLING_PRESETS.instruct.presence_penalty).toBe(1.5);
		expect(SAMPLING_PRESETS.instruct.extra).toEqual({});
	});

	it("defaults to thinking only for reasoning models", () => {
		expect(defaultSamplingMode({ reasoning: true })).toBe("thinking");
		expect(defaultSamplingMode({ reasoning: false })).toBe("instruct");
		expect(defaultSamplingMode({ reasoning: true, defaultMode: "instruct" })).toBe("instruct");
	});
});
