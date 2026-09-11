import type { ThinkingHistory } from "./config/sampling.ts";
import type { ImageContent, Message, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "./llm/types.ts";

/** Characters per token assumed by estimates. Real tokenizers average more, so estimates err high. */
const CHARS_PER_TOKEN = 3;
/** Rough cost of one attached image. */
const IMAGE_TOKENS = 1000;
/** Chat-template overhead per message (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Once trimming starts, cut down to this share of the budget, so the following requests keep the same prefix. */
const TRIM_TARGET = 0.6;
/** Steps (an assistant message and its tool results) at the end of the transcript that trimming keeps whole. */
const RECENT_STEPS = 2;
/** Tool-call arguments and tool output shorter than this are never elided: the placeholder would save little. */
const ELIDE_MIN_CHARS = 400;

const PLACEHOLDER_PREFIX = "[elided from context";

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** @param includeThinking whether the request replays this message's reasoning. */
export function estimateMessageTokens(message: Message, includeThinking = true): number {
	const blocks: readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[] =
		typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	let tokens = MESSAGE_OVERHEAD_TOKENS;
	for (const block of blocks) {
		if (block.type === "text") tokens += estimateTokens(block.text);
		else if (block.type === "thinking") tokens += includeThinking ? estimateTokens(block.thinking) : 0;
		else if (block.type === "image") tokens += IMAGE_TOKENS;
		else tokens += estimateTokens(block.name + JSON.stringify(block.arguments));
	}
	return tokens;
}

/** Whether text is a placeholder that trimming put in place of an old tool payload. Tools refuse to write these. */
export function isElisionPlaceholder(text: string): boolean {
	return text.trimStart().startsWith("[elided");
}

function lines(text: string): string {
	const count = text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function elideToolCall(call: ToolCall): ToolCall {
	let args: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(call.arguments)) {
		if (typeof value === "string" && value.length >= ELIDE_MIN_CHARS) {
			args ??= { ...call.arguments };
			args[key] = `${PLACEHOLDER_PREFIX}: ${lines(value)}]`;
		}
	}
	return args ? { ...call, arguments: args } : call;
}

function elideToolResult(message: ToolResultMessage): ToolResultMessage {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = message.content.length - message.content.filter((block) => block.type === "text").length;
	if (text.length < ELIDE_MIN_CHARS && images === 0) return message;
	const imageNote = images > 0 ? ` and ${images} image${images === 1 ? "" : "s"}` : "";
	const placeholder = `${PLACEHOLDER_PREFIX}: ${lines(text)} of ${message.toolName} output${imageNote}; call the tool again if you need it]`;
	return { ...message, content: [{ type: "text", text: placeholder }] };
}

/** Index of the `steps`-th assistant message from the end, where the steps trimming keeps whole begin. */
function recentStepsStart(messages: readonly Message[], steps: number): number {
	let found = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant" && ++found === steps) return i;
	}
	return 0;
}

export interface ContextSelection {
	/** What the request carries: the transcript after the cut, with older steps compacted. */
	messages: Message[];
	/** Messages at the start of the transcript left out of the request. */
	droppedMessages: number;
	/** Assistant messages sent without their reasoning, and possibly with long tool payloads elided. */
	compactedSteps: number;
	estimatedTokens: number;
	/** This call trimmed more than earlier ones did, so the prompt prefix changed. */
	trimmed: boolean;
}

/**
 * Chooses how much of the transcript a request carries, so the prompt plus `maxTokens` fits the model's window.
 *
 * Nothing changes while the prompt fits the budget. Past it, trimming goes down to 60% of the budget in one go, in
 * this order, oldest first:
 * 1. reasoning of all but the two most recent steps;
 * 2. long tool-call arguments (a written file) and long tool output of those steps, replaced by short placeholders;
 * 3. whole old turns (a user message and everything after it, up to the next user message), never the turn in
 *    progress;
 * 4. only while still over budget: the same as 1 and 2 for all but the most recent step.
 *
 * Every limit only moves forward, so a trimmed message looks the same in every later request. Trimming changes the
 * prompt prefix, which makes llama.cpp re-evaluate everything after the first changed message, so it should happen
 * rarely rather than a little on every request. The transcript itself is never modified.
 */
export class ContextWindow {
	/** Messages before this index are left out. */
	private start = 0;
	/** Assistant messages before this index are sent without reasoning. */
	private thinkingBefore = 0;
	/** Messages before this index are sent with long tool-call arguments and tool output elided. */
	private payloadsBefore = 0;
	/**
	 * Index of the first message added after the last trim. Token usage reported on assistant messages from here on
	 * was measured with the current trimming; earlier reports counted content that is no longer sent.
	 */
	private measuredFrom = 0;

	get droppedMessages(): number {
		return this.start;
	}

	reset(): void {
		this.start = 0;
		this.thinkingBefore = 0;
		this.payloadsBefore = 0;
		this.measuredFrom = 0;
	}

	/**
	 * @param budgetTokens prompt budget: the context window minus the tokens reserved for the reply.
	 * @param fixedTokens estimate for the system prompt and tool definitions.
	 * @param thinkingHistory which reasoning the request replays, so estimates leave out the rest.
	 */
	select(
		messages: readonly Message[],
		budgetTokens: number,
		fixedTokens: number,
		thinkingHistory: ThinkingHistory = "all",
	): ContextSelection {
		if (Math.max(this.start, this.thinkingBefore, this.payloadsBefore) > messages.length) this.reset();

		let lastUser = -1;
		for (let i = messages.length - 1; i >= 0 && lastUser === -1; i--) {
			if (messages[i].role === "user") lastUser = i;
		}
		const tokensOf = (from: number, to: number) => {
			let tokens = 0;
			for (let i = from; i < to; i++) {
				const replaysThinking = thinkingHistory === "all" || (thinkingHistory === "turn" && i > lastUser);
				tokens += estimateMessageTokens(this.compact(messages[i], i), replaysThinking);
			}
			return tokens;
		};

		const estimated = fixedTokens + tokensOf(this.start, messages.length);
		// With "turn", a new user message stops the replay of earlier reasoning, so older measurements count too much.
		const measuredFrom = Math.max(this.start, this.measuredFrom, thinkingHistory === "turn" ? lastUser : 0);
		let tokens = Math.max(estimated, this.measuredTokens(messages, measuredFrom, thinkingHistory, tokensOf) ?? 0);
		let trimmed = false;
		if (tokens > budgetTokens) {
			// Measured usage beats the estimate; scale estimated savings by the same factor.
			const scale = tokens / estimated;
			const target = budgetTokens * TRIM_TARGET;
			const compactUpTo = (from: number, to: number, advance: () => void) => {
				const before = tokensOf(from, to);
				advance();
				const saved = before - tokensOf(from, to);
				if (saved > 0) {
					tokens -= saved * scale;
					trimmed = true;
				}
			};

			for (const steps of [RECENT_STEPS, 1]) {
				if (steps < RECENT_STEPS && tokens <= budgetTokens) break;
				const recent = recentStepsStart(messages, steps);
				this.thinkingBefore = Math.max(this.thinkingBefore, this.start);
				this.payloadsBefore = Math.max(this.payloadsBefore, this.start);

				if (tokens > target && this.thinkingBefore < recent) {
					compactUpTo(this.thinkingBefore, recent, () => {
						this.thinkingBefore = recent;
					});
				}
				while (tokens > target && this.payloadsBefore < recent) {
					const from = this.payloadsBefore;
					let to = from + 1;
					while (to < recent && messages[to].role !== "assistant") to++;
					compactUpTo(from, to, () => {
						this.payloadsBefore = to;
					});
				}
				if (steps === RECENT_STEPS) {
					while (tokens > target) {
						let next = this.start + 1;
						while (next <= lastUser && messages[next].role !== "user") next++;
						if (next > lastUser) break;
						tokens -= tokensOf(this.start, next) * scale;
						this.start = next;
						trimmed = true;
					}
				}
			}
			if (trimmed) this.measuredFrom = messages.length;
		}

		let compactedSteps = 0;
		for (let i = this.start; i < Math.max(this.thinkingBefore, this.payloadsBefore); i++) {
			if (messages[i].role === "assistant") compactedSteps++;
		}
		return {
			messages: messages.slice(this.start).map((message, offset) => this.compact(message, this.start + offset)),
			droppedMessages: this.start,
			compactedSteps,
			estimatedTokens: Math.round(tokens),
			trimmed,
		};
	}

	/** A message as requests send it under the current trimming. */
	private compact(message: Message, index: number): Message {
		if (message.role === "user") return message;
		const elidePayloads = index < this.payloadsBefore;
		if (message.role === "toolResult") return elidePayloads ? elideToolResult(message) : message;
		const dropThinking = index < this.thinkingBefore;
		if (!dropThinking && !elidePayloads) return message;
		const content = message.content
			.filter((block) => !(dropThinking && block.type === "thinking"))
			.map((block) => (elidePayloads && block.type === "toolCall" ? elideToolCall(block) : block));
		const unchanged =
			content.length === message.content.length && content.every((block, i) => block === message.content[i]);
		return unchanged ? message : { ...message, content };
	}

	/** Prompt size from the latest usage report measured with the current trimming, plus estimates for later messages. */
	private measuredTokens(
		messages: readonly Message[],
		from: number,
		thinkingHistory: ThinkingHistory,
		tokensOf: (from: number, to: number) => number,
	): number | undefined {
		for (let i = messages.length - 1; i >= from; i--) {
			const message = messages[i];
			if (message.role === "assistant" && message.usage.promptTokens > 0) {
				const { promptTokens, completionTokens } = message.usage;
				// Output tokens include reasoning, which a request with thinkingHistory "none" never sends back.
				const hasThinking = message.content.some((block) => block.type === "thinking");
				const output =
					thinkingHistory === "none" && hasThinking ? estimateMessageTokens(message, false) : completionTokens;
				return promptTokens + output + tokensOf(i + 1, messages.length);
			}
		}
		return undefined;
	}
}

/** One-line description of a `context_trimmed` event for the transcript. */
export function describeTrim(trim: {
	droppedMessages: number;
	compactedSteps: number;
	estimatedTokens: number;
}): string {
	const parts: string[] = [];
	if (trim.compactedSteps > 0) parts.push(`${trim.compactedSteps} older steps compacted`);
	if (trim.droppedMessages > 0) parts.push(`${trim.droppedMessages} old messages left out`);
	return `context trimmed to ~${trim.estimatedTokens} tokens (${parts.join(", ")}); the prompt is re-read before the next reply`;
}
