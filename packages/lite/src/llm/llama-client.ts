import { randomUUID } from "node:crypto";
import type { LiteModel } from "../config/models.ts";
import { buildSamplingBody, type SamplingPreset } from "../config/sampling.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";
import { parseStreamingJson } from "./json-parse.ts";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "./types.ts";

export interface ChatRequestOptions {
	preset: SamplingPreset;
	signal?: AbortSignal;
	/** Injectable for tests. */
	fetch?: typeof fetch;
}

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type AssistantChatMessage = {
	role: "assistant";
	content: string | null;
	reasoning_content?: string;
	tool_calls?: ChatToolCall[];
};

export type ChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | ChatContentPart[] }
	| AssistantChatMessage
	| { role: "tool"; tool_call_id: string; content: string };

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/** Above this many characters, streamed tool-call arguments are parsed only once, when the call completes. */
const MAX_LIVE_ARGUMENT_PARSE = 2048;

/** Unpaired UTF-16 surrogates make llama.cpp reject the request body. */
function sanitize(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function imagePart(image: ImageContent): ChatContentPart {
	return { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } };
}

function convertAssistant(
	message: AssistantMessage,
	preset: SamplingPreset,
	replayReasoning: boolean,
): AssistantChatMessage | undefined {
	let text = "";
	let thinking = "";
	const toolCalls: ChatToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") thinking += thinking ? `\n${block.thinking}` : block.thinking;
		else {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: JSON.stringify(block.arguments) },
			});
		}
	}
	// A turn with only reasoning (for example cut off by max_tokens) has nothing the template can render.
	if (!text.trim() && toolCalls.length === 0) return undefined;

	const chat: AssistantChatMessage = { role: "assistant", content: text.trim() ? sanitize(text) : null };
	const reasoning = replayReasoning ? sanitize(thinking.trim()) : "";
	if (reasoning && preset.thinkingReplay === "inline") {
		chat.content = `<think>\n${reasoning}\n</think>\n\n${chat.content ?? ""}`;
	} else if (reasoning) {
		chat.reasoning_content = reasoning;
	}
	if (toolCalls.length > 0) chat.tool_calls = toolCalls;
	return chat;
}

/**
 * Transcript to chat messages:
 * - errored or aborted assistant turns are dropped, since they can hold half a tool call;
 * - a tool call without a result gets a synthetic error result, so the chat template sees matched pairs;
 * - reasoning is replayed as `preset.thinkingHistory` says: never, since the last user message, or always;
 * - images reach the model only when its models.yml `input` includes `image`.
 */
export function convertMessages(model: LiteModel, context: Context, preset: SamplingPreset): ChatMessage[] {
	const acceptsImages = model.input.includes("image");
	let lastUser = -1;
	for (const [index, message] of context.messages.entries()) {
		if (message.role === "user") lastUser = index;
	}
	const messages: ChatMessage[] = [];
	if (context.systemPrompt) messages.push({ role: "system", content: sanitize(context.systemPrompt) });

	let pendingCalls: ToolCall[] = [];
	let answered = new Set<string>();
	let toolImages: ChatContentPart[] = [];
	const closeToolTurn = () => {
		for (const call of pendingCalls) {
			if (!answered.has(call.id))
				messages.push({ role: "tool", tool_call_id: call.id, content: "No result provided" });
		}
		if (toolImages.length > 0) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...toolImages],
			});
		}
		pendingCalls = [];
		answered = new Set();
		toolImages = [];
	};

	for (const [index, message] of context.messages.entries()) {
		if (message.role === "user") {
			closeToolTurn();
			if (typeof message.content === "string") {
				messages.push({ role: "user", content: sanitize(message.content) });
				continue;
			}
			const parts: ChatContentPart[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push({ type: "text", text: sanitize(block.text) });
				else if (acceptsImages) parts.push(imagePart(block));
				else if (parts.at(-1)?.type !== "text" || (parts.at(-1) as TextContent).text !== USER_IMAGE_PLACEHOLDER) {
					parts.push({ type: "text", text: USER_IMAGE_PLACEHOLDER });
				}
			}
			if (parts.length > 0) messages.push({ role: "user", content: parts });
		} else if (message.role === "assistant") {
			closeToolTurn();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const history = preset.thinkingHistory;
			const chat = convertAssistant(message, preset, history === "all" || (history === "turn" && index > lastUser));
			if (!chat) continue;
			messages.push(chat);
			pendingCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		} else {
			// Results for calls that were dropped with their assistant turn would have no matching tool_calls.
			if (!pendingCalls.some((call) => call.id === message.toolCallId)) continue;
			answered.add(message.toolCallId);
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const images = message.content.filter((block): block is ImageContent => block.type === "image");
			let content = text;
			if (!content) {
				if (images.length === 0) content = "(no tool output)";
				else content = acceptsImages ? "(see attached image)" : TOOL_IMAGE_PLACEHOLDER;
			}
			messages.push({ role: "tool", tool_call_id: message.toolCallId, content: sanitize(content) });
			if (acceptsImages) toolImages.push(...images.map(imagePart));
		}
	}
	closeToolTurn();
	return messages;
}

/** Tool definitions in the chat-completions `tools` format. */
export function toChatTools(tools: readonly Tool[]): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

/** The /v1/chat/completions request body. Sampling fields come last, so a preset's `extra` can override anything. */
export function buildRequestBody(model: LiteModel, context: Context, preset: SamplingPreset): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.name,
		messages: convertMessages(model, context, preset),
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: model.maxTokens,
		// Reuse the KV cache for the unchanged prefix (system prompt, tools, earlier turns).
		cache_prompt: true,
	};
	if (context.tools && context.tools.length > 0) body.tools = toChatTools(context.tools);
	return Object.assign(body, buildSamplingBody(preset, model.reasoning));
}

/** Yields the `data:` payload of each server-sent event. */
export async function* readSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	const takeLine = (line: string): string | undefined => {
		if (line === "") {
			const event = data.length > 0 ? data.join("\n") : undefined;
			data = [];
			return event;
		}
		if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
		return undefined;
	};

	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const event = takeLine(buffer.slice(0, newline).replace(/\r$/, ""));
			buffer = buffer.slice(newline + 1);
			if (event !== undefined) yield event;
			newline = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer) takeLine(buffer.replace(/\r$/, ""));
	const last = takeLine("");
	if (last !== undefined) yield last;
}

interface ToolCallDelta {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface ChatChunk {
	choices?: {
		delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCallDelta[] };
		finish_reason?: string | null;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	timings?: { prompt_n?: number; cache_n?: number; prompt_per_second?: number; predicted_per_second?: number };
	error?: { message?: string };
}

/** Folds chat-completion chunks into `output` and emits the matching stream events. */
class ChunkAccumulator {
	finishReason: string | undefined;
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private text: TextContent | undefined;
	private thinking: ThinkingContent | undefined;
	private readonly toolCallsByIndex = new Map<number, ToolCall>();
	private readonly argumentJson = new Map<ToolCall, string>();

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
		this.output = output;
		this.stream = stream;
	}

	accept(chunk: ChatChunk): void {
		if (chunk.error) throw new Error(chunk.error.message ?? "llama-server reported an error mid-stream");
		if (chunk.usage) this.applyUsage(chunk.usage);
		if (chunk.timings) this.applyTimings(chunk.timings);

		const choice = chunk.choices?.[0];
		if (!choice) return;
		const delta = choice.delta;

		if (delta?.reasoning_content) {
			if (!this.thinking) {
				this.thinking = { type: "thinking", thinking: "" };
				this.stream.push({
					type: "thinking_start",
					contentIndex: this.append(this.thinking),
					partial: this.output,
				});
			}
			this.thinking.thinking += delta.reasoning_content;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: this.output.content.indexOf(this.thinking),
				delta: delta.reasoning_content,
				partial: this.output,
			});
		}

		if (delta?.content) {
			if (!this.text) {
				this.text = { type: "text", text: "" };
				this.stream.push({ type: "text_start", contentIndex: this.append(this.text), partial: this.output });
			}
			this.text.text += delta.content;
			this.stream.push({
				type: "text_delta",
				contentIndex: this.output.content.indexOf(this.text),
				delta: delta.content,
				partial: this.output,
			});
		}

		for (const callDelta of delta?.tool_calls ?? []) {
			const index = callDelta.index ?? 0;
			let call = this.toolCallsByIndex.get(index);
			if (!call) {
				call = { type: "toolCall", id: "", name: "", arguments: {} };
				this.toolCallsByIndex.set(index, call);
				this.argumentJson.set(call, "");
				this.stream.push({ type: "toolcall_start", contentIndex: this.append(call), partial: this.output });
			}
			if (callDelta.id) call.id = callDelta.id;
			if (!call.name && callDelta.function?.name) call.name = callDelta.function.name;
			const argumentDelta = callDelta.function?.arguments ?? "";
			const json = (this.argumentJson.get(call) ?? "") + argumentDelta;
			this.argumentJson.set(call, json);
			if (json.length <= MAX_LIVE_ARGUMENT_PARSE) call.arguments = parseStreamingJson(json);
			this.stream.push({
				type: "toolcall_delta",
				contentIndex: this.output.content.indexOf(call),
				delta: argumentDelta,
				partial: this.output,
			});
		}

		if (choice.finish_reason) this.finishReason = choice.finish_reason;
	}

	/** Emit the `*_end` events and settle the stop reason. */
	finish(): void {
		const content = this.output.content;
		for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
			const block = content[contentIndex];
			if (block.type === "text") {
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
			} else if (block.type === "thinking") {
				this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
			} else {
				block.arguments = parseStreamingJson(this.argumentJson.get(block));
				// Chat templates pair tool results with calls by id, so every call needs one.
				if (!block.id) block.id = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
				this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
			}
		}

		const hasToolCalls = this.toolCallsByIndex.size > 0;
		switch (this.finishReason) {
			case undefined:
				throw new Error("llama-server closed the stream without a finish_reason");
			case "tool_calls":
				this.output.stopReason = "toolUse";
				break;
			case "stop":
				this.output.stopReason = hasToolCalls ? "toolUse" : "stop";
				break;
			case "length":
				this.output.stopReason = "length";
				break;
			default:
				throw new Error(`llama-server finish_reason: ${this.finishReason}`);
		}
	}

	private append(block: TextContent | ThinkingContent | ToolCall): number {
		this.output.content.push(block);
		return this.output.content.length - 1;
	}

	private applyUsage(usage: NonNullable<ChatChunk["usage"]>): void {
		const totals = this.output.usage;
		totals.promptTokens = Math.max(totals.promptTokens, usage.prompt_tokens ?? 0);
		totals.completionTokens = usage.completion_tokens ?? totals.completionTokens;
		totals.cachedTokens = Math.max(totals.cachedTokens, usage.prompt_tokens_details?.cached_tokens ?? 0);
	}

	private applyTimings(timings: NonNullable<ChatChunk["timings"]>): void {
		const totals = this.output.usage;
		// prompt_n counts evaluated tokens only; cache_n counts the reused prefix.
		totals.promptTokens = Math.max(totals.promptTokens, (timings.prompt_n ?? 0) + (timings.cache_n ?? 0));
		totals.cachedTokens = Math.max(totals.cachedTokens, timings.cache_n ?? 0);
		if (timings.predicted_per_second !== undefined || timings.prompt_per_second !== undefined) {
			this.output.timings = {
				promptPerSecond: timings.prompt_per_second ?? 0,
				predictedPerSecond: timings.predicted_per_second ?? 0,
			};
		}
	}
}

async function httpErrorMessage(response: Response): Promise<string> {
	const body = (await response.text().catch(() => "")).trim();
	let detail = body;
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		if (parsed.error?.message) detail = parsed.error.message;
	} catch {
		// Not JSON; show the raw body.
	}
	return `llama-server returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 2000)}` : ""}`;
}

function describeError(error: unknown, model: LiteModel): string {
	if (!(error instanceof Error)) return String(error);
	const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
		return `Cannot reach llama-server at ${model.baseUrl} (${code})`;
	}
	return error.message;
}

/**
 * Stream one assistant turn from llama-server's /v1/chat/completions. Failures never throw: the stream
 * ends with an `error` event whose message has `stopReason` "error" or "aborted".
 */
export function streamChat(
	model: LiteModel,
	context: Context,
	options: ChatRequestOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		model: model.name,
		usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const { signal } = options;

	const run = async () => {
		try {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (model.apiKey) headers.authorization = `Bearer ${model.apiKey}`;
			const response = await (options.fetch ?? fetch)(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(buildRequestBody(model, context, options.preset)),
				signal,
			});
			if (!response.ok) throw new Error(await httpErrorMessage(response));
			if (!response.body) throw new Error("llama-server returned an empty response body");

			stream.push({ type: "start", partial: output });
			const accumulator = new ChunkAccumulator(output, stream);
			for await (const data of readSseData(response.body)) {
				if (data === "[DONE]") break;
				accumulator.accept(JSON.parse(data) as ChatChunk);
			}
			signal?.throwIfAborted();
			accumulator.finish();
			stream.push({
				type: "done",
				reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
				message: output,
			});
		} catch (error) {
			const aborted = signal?.aborted === true;
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted ? "Request aborted" : describeError(error, model);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		}
		stream.end();
	};
	void run();
	return stream;
}
