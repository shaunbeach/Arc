import type { ThinkingHistory } from "./config/sampling.ts";
import { applyJevDecisions, compactHeuristic, joinPruned, recentStepsStart } from "./jev/compact.ts";
import type { CallDecision } from "./jev/types.ts";
import type { ImageContent, Message, TextContent, ThinkingContent, ToolCall } from "./llm/types.ts";
import { buildWorkLog, withWorkLog } from "./work-log.ts";

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

function withoutThinking(message: Message): Message {
	if (message.role !== "assistant" || !message.content.some((block) => block.type === "thinking")) return message;
	return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
}

export interface ContextSelection {
	/** What the request carries: the transcript after the cut, with older steps compacted. */
	messages: Message[];
	/** Messages at the start of the transcript left out of the request. */
	droppedMessages: number;
	/** Steps sent without their reasoning, or with tool calls or results compacted by Jev evaluation. */
	compactedSteps: number;
	estimatedTokens: number;
	/** This call trimmed more than earlier ones did, so the prompt prefix changed. */
	trimmed: boolean;
}

/**
 * Chooses how much of the transcript a request carries, so the prompt plus `maxTokens` fits the model's window.
 *
 * Nothing changes while the prompt fits the budget. Past it:
 * 1. Reasoning of all but the two most recent steps is dropped.
 * 2. Older tool calls with long results or arguments are compacted: the step becomes a prose note in the assistant
 *    message, or its result keeps only its first lines (see `applyJevDecisions`). This uses the heuristic, never the
 *    Jev evaluator: an evaluator request would delay every trim and evict llama.cpp's cached prompt. `/compact` asks
 *    Jev and hands its decisions to `adoptDecisions`.
 *    Steps 1 and 2 repeat for all but the most recent step while the prompt is still over the target.
 * 3. If conversational text or remaining steps still exceed the target budget, older whole turns
 *    are dropped as a fallback.
 * 4. In a single long turn exceeding budget, older intermediate assistant/tool steps are dropped,
 *    preserving the initial user prompt and recent steps.
 *
 * Pruning decisions are cached monotonically, and a later decision can only compact a call further, so earlier
 * messages stay byte-identical across requests,
 * allowing llama.cpp to reuse its prompt KV cache prefix. The transcript itself is never modified: compaction only
 * changes what requests send, so the session file keeps every message as it happened.
 */
export class ContextWindow {
	/** Messages before this index are left out by turn-dropping fallback. */
	private start = 0;
	/** In a single long turn exceeding budget, intermediate assistant/tool messages before this index are omitted. */
	private omittedStepsBefore = 0;
	/** Assistant messages before this index are sent without reasoning. */
	private thinkingBefore = 0;
	/** Cached Jev decisions by toolCallId to preserve KV cache prefix across requests. */
	private cachedDecisions = new Map<string, CallDecision>();
	/**
	 * Index of the first message added after the last trim. Token usage reported on assistant messages from here on
	 * was measured with the current trimming; earlier reports counted content that is no longer sent.
	 */
	private measuredFrom = 0;
	/** What the steps left out of requests did, sent with the first message. Rebuilt only when trimming. */
	private workLog: string | undefined;
	/** Working directory, so the work log names files the way the model's tools take them. */
	cwd: string;

	constructor(options: { cwd?: string } = {}) {
		this.cwd = options.cwd ?? process.cwd();
	}

	get droppedMessages(): number {
		return this.start + (this.omittedStepsBefore > this.start + 1 ? this.omittedStepsBefore - (this.start + 1) : 0);
	}

	reset(): void {
		this.start = 0;
		this.omittedStepsBefore = 0;
		this.thinkingBefore = 0;
		this.cachedDecisions.clear();
		this.measuredFrom = 0;
		this.workLog = undefined;
	}

	/**
	 * Applies compaction decisions made outside a request, such as `/compact`. Later requests send the compacted steps
	 * the same way automatic trimming would; the transcript is left as it is.
	 */
	adoptDecisions(messages: readonly Message[], decisions: readonly CallDecision[]): void {
		if (Math.max(this.start, this.omittedStepsBefore, this.thinkingBefore) > messages.length) this.reset();
		for (const decision of decisions) this.cacheDecision(decision);
		// Usage reported so far was measured before these decisions.
		this.measuredFrom = messages.length;
	}

	/**
	 * What `/compact` need not ask about: calls already compacted, and whether a message is still sent at all. Asking
	 * about either would spend the evaluator's budget on calls whose fate is settled.
	 */
	compactionScope(messages: readonly Message[]): { settled: Set<string>; isSent: (index: number) => boolean } {
		const settled = new Set<string>();
		for (const [id, decision] of this.cachedDecisions) if (decision.action !== "keep") settled.add(id);
		const start = this.start <= messages.length ? this.start : 0;
		const omitting = this.omittedStepsBefore > start + 1;
		return {
			settled,
			isSent: (index) => index === start || (index > start && (!omitting || index >= this.omittedStepsBefore)),
		};
	}

	/**
	 * Caches a decision unless it would undo an earlier one. A call compacted once stays compacted: sending it whole
	 * again would change the prompt prefix and bring back what the budget already had to give up.
	 */
	private cacheDecision(decision: CallDecision): void {
		if (decision.reason === "pinned") return;
		const strength = { keep: 0, drop_result: 1, drop_call: 2 } as const;
		const cached = this.cachedDecisions.get(decision.toolCallId);
		if (!cached || strength[decision.action] > strength[cached.action]) {
			this.cachedDecisions.set(decision.toolCallId, decision);
		}
	}

	/** What a request would carry now, without trimming further. */
	view(messages: readonly Message[]): { messages: Message[]; compactedCalls: number } {
		const { messages: pruned, compactedCalls } = this.pruned(messages);
		return { messages: this.selected(pruned), compactedCalls };
	}

	/**
	 * The transcript as requests send it, aligned with `messages`: cached Jev decisions applied, older reasoning
	 * dropped, and `undefined` where a message is left out.
	 */
	private pruned(messages: readonly Message[]): { messages: (Message | undefined)[]; compactedCalls: number } {
		const { messages: pruned, compactedCalls } = applyJevDecisions(messages, [...this.cachedDecisions.values()]);
		for (let i = 0; i < Math.min(this.thinkingBefore, pruned.length); i++) {
			const message = pruned[i];
			if (message) pruned[i] = withoutThinking(message);
		}
		return { messages: pruned, compactedCalls };
	}

	/**
	 * The part of the pruned transcript the current cut keeps, gaps closed. The work log goes with the first message:
	 * a user message is always there at the cut, and the log changes only when the cut does.
	 */
	private selected(pruned: readonly (Message | undefined)[]): Message[] {
		const omitting = this.omittedStepsBefore > this.start + 1;
		const selected = joinPruned(
			omitting ? [pruned[this.start], ...pruned.slice(this.omittedStepsBefore)] : pruned.slice(this.start),
		);
		const first = selected[0];
		if (this.workLog && first?.role === "user") selected[0] = withWorkLog(first, this.workLog);
		return selected;
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
		if (Math.max(this.start, this.omittedStepsBefore, this.thinkingBefore) > messages.length) this.reset();

		let lastUser = -1;
		for (let i = messages.length - 1; i >= 0 && lastUser === -1; i--) {
			if (messages[i].role === "user") lastUser = i;
		}

		// Indexes below always refer to the transcript; a message left out counts as nothing.
		const tokensOf = (msgs: readonly (Message | undefined)[], from: number, to: number) => {
			let tokens = 0;
			for (let i = from; i < to; i++) {
				const message = msgs[i];
				if (!message) continue;
				const replaysThinking = thinkingHistory === "all" || (thinkingHistory === "turn" && i > lastUser);
				tokens += estimateMessageTokens(message, replaysThinking);
			}
			return tokens;
		};

		const logTokens = () => (this.workLog ? estimateTokens(this.workLog) : 0);
		const contextTokens = (msgs: readonly (Message | undefined)[]) => {
			if (this.omittedStepsBefore > this.start + 1) {
				return (
					logTokens() +
					tokensOf(msgs, this.start, this.start + 1) +
					tokensOf(msgs, this.omittedStepsBefore, msgs.length)
				);
			}
			return logTokens() + tokensOf(msgs, this.start, msgs.length);
		};

		let currentMessages = this.pruned(messages).messages;

		let estimated = fixedTokens + contextTokens(currentMessages);
		const measuredFrom = Math.max(this.start, this.measuredFrom, thinkingHistory === "turn" ? lastUser : 0);
		let tokens = Math.max(
			estimated,
			this.measuredTokens(messages, measuredFrom, thinkingHistory, (f, t) => tokensOf(currentMessages, f, t)) ?? 0,
		);
		let trimmed = false;

		if (tokens > budgetTokens) {
			const scale = tokens / estimated;
			const target = budgetTokens * TRIM_TARGET;
			const remeasure = () => {
				currentMessages = this.pruned(messages).messages;
				const newEstimated = fixedTokens + contextTokens(currentMessages);
				if (newEstimated < estimated) {
					tokens -= (estimated - newEstimated) * scale;
					estimated = newEstimated;
					trimmed = true;
				}
			};

			for (const steps of [RECENT_STEPS, 1]) {
				if (steps < RECENT_STEPS && tokens <= target) break;
				// Step 1: reasoning of older steps. It costs the model least and needs no Jev request.
				const recent = recentStepsStart(messages, steps);
				if (this.thinkingBefore < recent) {
					this.thinkingBefore = recent;
					remeasure();
				}
				if (tokens <= target) continue;
				// Step 2: long tool payloads of older steps.
				for (const decision of compactHeuristic(messages, steps).decisions) this.cacheDecision(decision);
				remeasure();
			}

			// Step 3: Turn-dropping fallback if still exceeding target budget
			while (tokens > target) {
				let next = this.start + 1;
				while (next <= lastUser && messages[next].role !== "user") next++;
				if (next > lastUser) break;
				tokens -= tokensOf(currentMessages, this.start, next) * scale;
				this.start = next;
				this.omittedStepsBefore = 0;
				trimmed = true;
			}

			// Step 4: In a single long turn exceeding budgetTokens, drop older intermediate steps
			// so the request does not crash with "Context full"
			if (tokens > budgetTokens && this.start === lastUser && lastUser >= 0) {
				const recent = recentStepsStart(messages, 1);
				let nextStep = Math.max(this.start + 1, this.omittedStepsBefore);
				while (tokens > target && nextStep < recent) {
					let stepEnd = nextStep + 1;
					while (stepEnd < recent && messages[stepEnd].role !== "assistant") stepEnd++;
					tokens -= tokensOf(currentMessages, nextStep, stepEnd) * scale;
					nextStep = stepEnd;
					trimmed = true;
				}
				this.omittedStepsBefore = nextStep;
			}

			if (trimmed) {
				this.measuredFrom = messages.length;
				// The prefix changes anyway, so this is when the log may change too.
				const before = logTokens();
				this.workLog = buildWorkLog(
					messages,
					{ earlierBefore: this.start, from: this.start + 1, to: this.omittedStepsBefore },
					this.cwd,
				);
				tokens += (logTokens() - before) * scale;
			}
		}

		// A step counts once, whether its reasoning, its tool calls, or its tool results were compacted.
		let compactedSteps = 0;
		let step = -1;
		let counted = -1;
		for (
			let i = this.omittedStepsBefore > this.start + 1 ? this.omittedStepsBefore : this.start;
			i < messages.length;
			i++
		) {
			if (messages[i].role === "assistant") step = i;
			if (currentMessages[i] !== messages[i] && step !== -1 && step !== counted) {
				compactedSteps++;
				counted = step;
			}
		}

		return {
			messages: this.selected(currentMessages),
			droppedMessages: this.droppedMessages,
			compactedSteps,
			estimatedTokens: Math.round(tokens),
			trimmed,
		};
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
