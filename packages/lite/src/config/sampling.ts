export type SamplingMode = "thinking" | "instruct";

export const SAMPLING_MODES: readonly SamplingMode[] = ["thinking", "instruct"];

export function isSamplingMode(value: string): value is SamplingMode {
	return (SAMPLING_MODES as readonly string[]).includes(value);
}

/**
 * Which earlier reasoning goes back to the model with the next request.
 * - `none`: never.
 * - `turn`: only reasoning written since the last user message, so the model keeps its chain of thought across the
 *   tool calls of one request without spending the context window on old turns.
 * - `all`: every turn. Also sends `chat_template_kwargs.preserve_thinking` for templates that honor it.
 */
export type ThinkingHistory = "none" | "turn" | "all";

/**
 * How replayed reasoning is encoded.
 * - `reasoning_content`: the assistant message field llama.cpp parses reasoning into (default server setup).
 * - `inline`: `<think>...</think>` at the start of `content`, for servers started with `--reasoning-format none`.
 */
export type ThinkingReplay = "reasoning_content" | "inline";

export interface SamplingPreset {
	temperature: number;
	top_p: number;
	top_k: number;
	min_p: number;
	presence_penalty: number;
	/** Sent as `chat_template_kwargs.enable_thinking` for reasoning models. */
	enableThinking: boolean;
	thinkingHistory: ThinkingHistory;
	thinkingReplay: ThinkingReplay;
	/** Sent as top-level `reasoning_effort` when set. */
	reasoningEffort?: string;
	/**
	 * Extra request-body fields, merged last so they override everything above. `chat_template_kwargs` here is merged
	 * key by key. Use this for any llama.cpp parameter without a named field, e.g. `thinking_budget_tokens`.
	 */
	extra: Record<string, unknown>;
}

/**
 * Defaults for every model. Edit these to change them globally; a model's `sampling:` block in models.yml
 * overrides individual fields per mode.
 */
export const SAMPLING_PRESETS: Readonly<Record<SamplingMode, Readonly<SamplingPreset>>> = {
	thinking: {
		temperature: 1.0,
		top_p: 0.95,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 0.0,
		enableThinking: true,
		thinkingHistory: "turn",
		thinkingReplay: "reasoning_content",
		reasoningEffort: undefined,
		extra: {},
	},
	instruct: {
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 1.5,
		enableThinking: false,
		thinkingHistory: "none",
		thinkingReplay: "reasoning_content",
		reasoningEffort: undefined,
		extra: {},
	},
};

export type SamplingOverrides = Partial<Record<SamplingMode, Partial<SamplingPreset>>>;

/** models.yml `mode`, else thinking for reasoning models and instruct for the rest. */
export function defaultSamplingMode(model: { reasoning: boolean; defaultMode?: SamplingMode }): SamplingMode {
	return model.defaultMode ?? (model.reasoning ? "thinking" : "instruct");
}

export function resolvePreset(mode: SamplingMode, overrides?: SamplingOverrides): SamplingPreset {
	const base = SAMPLING_PRESETS[mode];
	const override = overrides?.[mode];
	return { ...base, ...override, extra: { ...base.extra, ...override?.extra } };
}

/**
 * Request-body fields for a preset. `reasoning` is the model's models.yml flag: only reasoning models get
 * `chat_template_kwargs`, because instruct-only templates have no thinking switch.
 */
export function buildSamplingBody(preset: SamplingPreset, reasoning: boolean): Record<string, unknown> {
	const body: Record<string, unknown> = {
		temperature: preset.temperature,
		top_p: preset.top_p,
		top_k: preset.top_k,
		min_p: preset.min_p,
		presence_penalty: preset.presence_penalty,
	};
	let kwargs: Record<string, unknown> | undefined = reasoning
		? { enable_thinking: preset.enableThinking, preserve_thinking: preset.thinkingHistory === "all" }
		: undefined;
	if (preset.reasoningEffort !== undefined) body.reasoning_effort = preset.reasoningEffort;

	const { chat_template_kwargs: extraKwargs, ...extra } = preset.extra;
	Object.assign(body, extra);
	if (typeof extraKwargs === "object" && extraKwargs !== null && !Array.isArray(extraKwargs)) {
		kwargs = { ...kwargs, ...extraKwargs };
	}
	if (kwargs) body.chat_template_kwargs = kwargs;
	return body;
}
