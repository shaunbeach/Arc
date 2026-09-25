import { basename } from "node:path";
import type { LiteModel } from "../config/models.ts";
import { fetchModelIds, serverOrigin } from "./server.ts";

/**
 * What the server tells us about the model it is already running: from llama-server's `/props`, or, for another
 * OpenAI-compatible server, from `/v1/models`. Everything a models.yml entry carries is here except the reply
 * reserve, which is Arc's own budgeting choice rather than a server fact.
 */
export interface ServerProps {
	/** `-m` as llama-server received it, or the model id another server lists. The identity Arc matches on. */
	modelPath: string;
	/**
	 * Context window of ONE slot: what a single conversation gets. Undefined when the server does not advertise
	 * one (anything but llama-server), so models.yml supplies it.
	 */
	contextWindow?: number;
	/**
	 * Set when the server is not llama-server: the id its `/v1/models` lists, which requests must name exactly.
	 * llama-server ignores the request's `model` field; other servers route on it.
	 */
	servedModel?: string;
	/** `modalities.vision`: whether the server loaded a projector. */
	vision: boolean;
	/**
	 * Whether the model has a thinking switch: its chat template reads `enable_thinking`, or the server reports
	 * `supports_preserve_reasoning`. Qwen3.5's template has the switch but reports false for the latter.
	 */
	reasoning: boolean;
	/** `chat_template_caps.supports_reasoning_effort`: whether reasoning_effort levels apply. */
	reasoningEffort: boolean;
	tools: boolean;
	/** e.g. `b10809-5266f24da`. */
	buildInfo?: string;
}

interface RawProps {
	model_path?: unknown;
	model_alias?: unknown;
	build_info?: unknown;
	chat_template?: unknown;
	modalities?: { vision?: unknown };
	chat_template_caps?: {
		supports_preserve_reasoning?: unknown;
		supports_reasoning_effort?: unknown;
		supports_tools?: unknown;
	};
	default_generation_settings?: { n_ctx?: unknown };
}

function asBoolean(value: unknown): boolean {
	return value === true;
}

/**
 * Read `/props`, else `/v1/models`. Returns undefined when neither answers usably, so the caller can report
 * "nothing is serving here" rather than a parse error.
 *
 * `default_generation_settings.n_ctx` is the per-slot window, not the `--ctx-size` the server was started with:
 * `--ctx-size 8192 --parallel 2` reports 4096 across 2 slots. Per-slot is the right budget, since one Arc
 * conversation occupies one slot.
 */
export async function fetchServerProps(
	baseUrl: string,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ServerProps | undefined> {
	let raw: RawProps;
	try {
		const response = await fetchFn(`${serverOrigin(baseUrl)}/props`, { signal });
		// Not llama-server: TinyTitan and other OpenAI-compatible servers answer 404 here.
		if (!response.ok) return fetchListedModel(baseUrl, fetchFn, signal);
		raw = (await response.json()) as RawProps;
	} catch {
		return undefined;
	}

	const modelPath = typeof raw.model_path === "string" ? raw.model_path : raw.model_alias;
	if (typeof modelPath !== "string" || modelPath === "") return undefined;
	const contextWindow = Number(raw.default_generation_settings?.n_ctx);
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

	const caps = raw.chat_template_caps ?? {};
	return {
		modelPath,
		contextWindow: Math.floor(contextWindow),
		vision: asBoolean(raw.modalities?.vision),
		reasoning:
			asBoolean(caps.supports_preserve_reasoning) ||
			(typeof raw.chat_template === "string" && raw.chat_template.includes("enable_thinking")),
		reasoningEffort: asBoolean(caps.supports_reasoning_effort),
		tools: asBoolean(caps.supports_tools),
		buildInfo: typeof raw.build_info === "string" ? raw.build_info : undefined,
	};
}

/**
 * The first model an OpenAI-compatible server lists at `/v1/models`. Such a server reports no window or
 * capabilities, so those stay unset or conservative here and models.yml fills them in.
 */
export async function fetchListedModel(
	baseUrl: string,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ServerProps | undefined> {
	const id = (await fetchModelIds(baseUrl, fetchFn, signal))?.[0];
	if (id === undefined) return undefined;
	return { modelPath: id, servedModel: id, vision: false, reasoning: false, reasoningEffort: false, tools: true };
}

/** `/models/ornith-1.5/Ornith-1.5-9B-Q4_K_M.gguf` -> `Ornith-1.5-9B-Q4_K_M`. */
export function modelNameFromPath(modelPath: string): string {
	const base = basename(modelPath.replace(/[/\\]+$/, ""));
	return base.replace(/\.gguf$/i, "") || modelPath;
}

/** The window assumed for a server that advertises none when models.yml leaves `contextWindow` out. */
export const DEFAULT_CONTEXT_WINDOW = 32768;

/**
 * Fill a `discover: true` placeholder from what the server reports. `name` stays the placeholder's, so the picker,
 * `/model <name>`, the last-used file, and saved sessions keep one stable handle across reconnects; `displayName`
 * is what the banner and footer show. The reply reserve is not advertised, so it follows the same default a
 * models.yml entry gets when it leaves `maxTokens` out.
 */
export function resolveDiscoveredModel(placeholder: LiteModel, props: ServerProps): LiteModel {
	const contextWindow = props.contextWindow ?? placeholder.configuredContextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = placeholder.configuredMaxTokens ?? Math.min(8192, Math.floor(contextWindow / 4));
	return {
		...placeholder,
		id: props.modelPath,
		modelPath: props.modelPath,
		servedModel: props.servedModel,
		displayName: modelNameFromPath(props.modelPath),
		contextWindow,
		// A window smaller than the reserve would leave nothing for the conversation.
		maxTokens: Math.min(maxTokens, Math.max(1, Math.floor(contextWindow / 2))),
		// Only llama-server reports a thinking switch; for another server, models.yml says.
		reasoning: props.servedModel === undefined ? props.reasoning : (placeholder.configuredReasoning ?? false),
		input: props.vision ? ["text", "image"] : ["text"],
		buildInfo: props.buildInfo,
	};
}
