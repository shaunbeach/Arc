import type { Message, TextContent, ToolCall, ToolResultMessage } from "../llm/types.ts";
import { formatCompactionPrompt, formatHistoryEntry, formatQuestion } from "./asker.ts";
import type {
	CallAnswer,
	CallDecision,
	CompactionState,
	CompactOptions,
	CompactResult,
	HistoryEntry,
	HistoryToolCall,
	JevAsker,
	JevAskResult,
	JevQuestions,
	JevToolCall,
} from "./types.ts";

const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_PRESERVE_RECENT_STEPS = 2;
/** Placeholders older versions stored in session files. Such text is never compacted again. */
const PLACEHOLDER_PREFIX = "[elided";
/** Tool-call arguments this long make a step worth compacting (a written file, an edit's text). */
export const ELIDE_MIN_CHARS = 300;
/** Characters of a compacted tool result that stay in the request. */
export const RESULT_HEAD_CHARS = 300;
/** Results shorter than the head plus this are sent whole: the note would save little. */
const RESULT_MIN_SAVING = 200;

export function lines(text: string): string {
	const count = text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function resultText(message: ToolResultMessage): string {
	return message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export function hasElidableArguments(args: Record<string, unknown>, minChars = ELIDE_MIN_CHARS): boolean {
	return Object.values(args).some(
		(value) =>
			typeof value === "string" && value.length >= minChars && !value.trimStart().startsWith(PLACEHOLDER_PREFIX),
	);
}

/**
 * A tool result cut to its first lines plus a note, or undefined when cutting would save little. The head is real
 * output, so the model can still see what the call returned and quote from it.
 */
export function truncatedToolResult(
	message: ToolResultMessage,
	headChars = RESULT_HEAD_CHARS,
): ToolResultMessage | undefined {
	const text = resultText(message);
	const images = message.content.filter((b) => b.type === "image").length;
	if (text.trimStart().startsWith(PLACEHOLDER_PREFIX)) return undefined;
	if (images === 0 && text.length < headChars + RESULT_MIN_SAVING) return undefined;
	let head = text.slice(0, headChars);
	const lineEnd = head.lastIndexOf("\n");
	if (text.length > headChars && lineEnd > headChars / 3) head = head.slice(0, lineEnd);
	const leftOut: string[] = [];
	if (head.length < text.length) {
		const rest = text.slice(head.length).replace(/^\n/, "");
		leftOut.push(`the other ${lines(rest)} of this output`);
	}
	if (images > 0) leftOut.push(`${images} image${images === 1 ? "" : "s"}`);
	const note = `(${leftOut.join(" and ")} left out to save context. Run the tool again if you need ${images > 0 && head.length === text.length ? "them" : "it"}.)`;
	return { ...message, content: [{ type: "text", text: head ? `${head}\n${note}` : note }] };
}

function shorten(text: string, max: number): string {
	const line = text.split("\n")[0];
	return line.length > max || line.length < text.length ? `${line.slice(0, max)}…` : line;
}

/** One step of a compacted call, as the assistant would say it: `wrote src/a.ts (120 lines)`. */
export function describeCompactedCall(call: ToolCall, result: ToolResultMessage | undefined): string {
	const text = (key: string) => (typeof call.arguments[key] === "string" ? (call.arguments[key] as string) : "");
	const path = text("path") || text("file_path");
	let step: string;
	switch (call.name) {
		case "write":
			step = `wrote ${path} (${lines(text("content"))})`;
			break;
		case "edit":
			step = `edited ${path}`;
			break;
		case "read":
			step = `read ${path}`;
			break;
		case "bash":
			step = `ran \`${shorten(text("command"), 80)}\``;
			break;
		case "web_search":
			step = `searched the web for "${shorten(text("query"), 80)}"`;
			break;
		case "web_fetch":
			step = `fetched ${text("url")}`;
			break;
		default:
			step = `called ${call.name}`;
	}
	return result?.isError ? `${step}, which failed` : step;
}

/** The prose that stands in for compacted calls. It reads as the assistant's own words, never as a tool argument. */
export function compactedStepsNote(steps: readonly string[]): string {
	const s = steps.length === 1 ? "" : "s";
	return `(Earlier tool call${s} left out to save context: ${steps.join("; ")}. Their results are not shown; run a tool again, or read a file, if you need them.)`;
}

export function recentStepsStart(messages: readonly Message[], steps: number): number {
	let found = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant" && ++found === steps) return i;
	}
	return 0;
}

export function collectCandidateCalls(
	messages: readonly Message[],
	preserveRecentSteps = DEFAULT_PRESERVE_RECENT_STEPS,
): JevToolCall[] {
	const results = new Map<string, { index: number; message: ToolResultMessage }>();
	messages.forEach((message, index) => {
		if (message.role === "toolResult") {
			results.set(message.toolCallId, { index, message });
		}
	});

	const recentStart = recentStepsStart(messages, preserveRecentSteps);
	const calls: JevToolCall[] = [];

	messages.forEach((message, callIndex) => {
		if (message.role !== "assistant") return;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const found = results.get(block.id);
			if (!found) continue;

			const resultText = found.message.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");

			const pinned = callIndex >= recentStart || found.index >= recentStart;

			calls.push({
				id: `t${calls.length + 1}`,
				toolCallId: block.id,
				tool: block.name,
				input: block.arguments,
				callIndex,
				resultIndex: found.index,
				resultChars: resultText.length,
				inputChars: JSON.stringify(block.arguments).length,
				isError: found.message.isError,
				pinned,
			});
		}
	});

	return calls;
}

/** Text of a message for the evaluator: user messages longer, since they carry the task. */
function entryText(message: Message): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((b): b is TextContent => b.type === "text")
					.map((b) => b.text)
					.join("\n");
	return text.slice(0, message.role === "user" ? 400 : 300);
}

function inferGoal(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : m.content.find((b) => b.type === "text")?.text;
		if (text) return text.slice(0, 400);
	}
	return "(infer task from history)";
}

/**
 * The evaluator's view of the conversation, and the calls it can be asked about, within `maxChars`.
 *
 * Problem: the whole history of a long session does not fit the model's window, so the request failed after its
 * timeout and nothing was decided. Here history is added newest first, each message with the questions about its
 * calls, until the budget is spent. Older calls that do not fit are not asked about; the caller decides them another
 * way. Messages `isSent` rejects are left out, since their calls are no longer sent anyway.
 */
export function buildCompactionState(
	messages: readonly Message[],
	calls: readonly JevToolCall[],
	options: {
		goal?: string;
		maxChars?: number;
		candidates?: ReadonlySet<string>;
		isSent?: (index: number) => boolean;
	} = {},
): { state: CompactionState; asked: JevToolCall[] } {
	const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
	const isCandidate = (call: JevToolCall) => options.candidates?.has(call.toolCallId) ?? !call.pinned;
	const callsByMsgIndex = new Map<number, JevToolCall[]>();
	for (const c of calls) callsByMsgIndex.set(c.callIndex, [...(callsByMsgIndex.get(c.callIndex) ?? []), c]);

	const goal = options.goal || inferGoal(messages);
	const context = "A terminal coding agent is evaluating which past tool calls and results are still relevant.";
	// The system prompt, instructions, goal, and context around the history.
	const frame = formatCompactionPrompt({ context, goal, history: [] }, {});
	let used = frame.system.length + frame.user.length;
	const history: HistoryEntry[] = [];
	const asked: JevToolCall[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult" || (options.isSent && !options.isSent(i))) continue;
		const msgCalls = callsByMsgIndex.get(i) ?? [];
		const toolCalls: HistoryToolCall[] = msgCalls.map((c) => {
			const result = messages[c.resultIndex] as ToolResultMessage | undefined;
			return {
				id: c.id,
				tool: c.tool,
				input: JSON.stringify(c.input).slice(0, 300),
				result: result ? resultText(result).slice(0, 300) : "",
			};
		});
		const entry: HistoryEntry = { i, role: msg.role, text: entryText(msg), tool_calls: toolCalls };
		const entryAsked = msgCalls.filter(isCandidate);
		const cost =
			formatHistoryEntry(entry).length +
			2 +
			entryAsked.reduce(
				(sum, call) =>
					sum +
					Object.entries(questionsFor(call)).reduce((n, [key, q]) => n + formatQuestion(key, q).length + 1, 0),
				0,
			);
		if (used + cost > maxChars) break;
		used += cost;
		history.unshift(entry);
		asked.push(...entryAsked);
	}

	return { state: { context, goal, history }, asked: asked.reverse() };
}

export function questionsFor(call: JevToolCall): JevQuestions {
	return {
		[`call_${call.id}`]: {
			type: "noul",
			instructions: `Tool call ${call.id} (${call.tool}) should stay in history: knowing this call was made with its parameters still matters for next steps.`,
		},
		[`result_${call.id}`]: {
			type: "noul",
			instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay verbatim: exact contents are still needed and re-running the tool would not do.`,
		},
	};
}

export function decideCall(call: JevToolCall, answer: CallAnswer, keepThreshold: number): CallDecision {
	const base = { id: call.id, toolCallId: call.toolCallId, tool: call.tool, ...answer };
	if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
	if (answer.keepResult >= keepThreshold) {
		return { ...base, action: "keep", reason: "kept" };
	}
	if (answer.keepCall >= keepThreshold) {
		return { ...base, action: "drop_result", reason: "result_dropped" };
	}
	return { ...base, action: "drop_call", reason: "call_dropped" };
}

/**
 * The transcript as a request sends it under `decisions`, aligned with the input: entry `i` stands for message `i`,
 * and `undefined` marks a message left out. Unchanged messages are returned as the same objects.
 *
 * A compacted step never shows a placeholder where a tool argument was: small models copy such placeholders into
 * the files they write. Instead:
 * - a dropped call, or a call whose arguments hold a whole file or edit, disappears with its result, and the
 *   assistant message says in prose what the call did (`wrote src/a.ts (120 lines)`);
 * - a dropped result of a call with short arguments keeps its first lines and a note.
 */
export function applyJevDecisions(
	messages: readonly Message[],
	decisions: readonly CallDecision[],
): { messages: (Message | undefined)[]; compactedCalls: number } {
	const actions = new Map<string, CallDecision["action"]>();
	for (const d of decisions) if (d.action !== "keep") actions.set(d.toolCallId, d.action);
	if (actions.size === 0) return { messages: [...messages], compactedCalls: 0 };

	const results = new Map<string, ToolResultMessage>();
	for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);

	/** Calls that leave the request with their results, replaced by a note. */
	const collapsed = new Set<string>();
	/** Results cut to their head. */
	const truncated = new Map<string, ToolResultMessage>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const action = actions.get(block.id);
			const result = results.get(block.id);
			if (!action || !result) continue;
			if (action === "drop_call" || hasElidableArguments(block.arguments)) {
				collapsed.add(block.id);
			} else {
				const cut = truncatedToolResult(result);
				if (cut) truncated.set(block.id, cut);
			}
		}
	}

	const pruned = messages.map((message): Message | undefined => {
		if (message.role === "toolResult") {
			if (collapsed.has(message.toolCallId)) return undefined;
			return truncated.get(message.toolCallId) ?? message;
		}
		if (message.role !== "assistant" || !message.content.some((b) => b.type === "toolCall" && collapsed.has(b.id))) {
			return message;
		}
		// Each run of collapsed calls becomes one note, in the place the calls were.
		const content: typeof message.content = [];
		let steps: string[] = [];
		const flush = () => {
			if (steps.length > 0) content.push({ type: "text", text: compactedStepsNote(steps) });
			steps = [];
		};
		for (const block of message.content) {
			if (block.type === "toolCall" && collapsed.has(block.id)) {
				steps.push(describeCompactedCall(block, results.get(block.id)));
			} else {
				flush();
				content.push(block);
			}
		}
		flush();
		return { ...message, content };
	});
	return { messages: pruned, compactedCalls: collapsed.size + truncated.size };
}

/**
 * Closes the gaps `applyJevDecisions` leaves. An assistant message that lost all its tool calls is merged into the
 * assistant message that follows it, so the request keeps alternating roles as chat templates expect.
 */
export function joinPruned(messages: readonly (Message | undefined)[]): Message[] {
	const joined: Message[] = [];
	for (const message of messages) {
		if (!message) continue;
		const previous = joined[joined.length - 1];
		if (
			message.role === "assistant" &&
			previous?.role === "assistant" &&
			!previous.content.some((b) => b.type === "toolCall")
		) {
			joined[joined.length - 1] = { ...message, content: [...previous.content, ...message.content] };
		} else {
			joined.push(message);
		}
	}
	return joined;
}

const pinnedDecision = (call: JevToolCall): CallDecision => ({
	id: call.id,
	toolCallId: call.toolCallId,
	tool: call.tool,
	keepCall: 1.0,
	keepResult: 1.0,
	action: "keep",
	reason: "pinned",
});

/** Without an evaluator: compact a call whose result or arguments are long, keep the rest. */
function heuristicDecision(call: JevToolCall, messages: readonly Message[]): CallDecision {
	const resultMsg = messages[call.resultIndex] as ToolResultMessage | undefined;
	const elidable =
		(resultMsg !== undefined && truncatedToolResult(resultMsg) !== undefined) || hasElidableArguments(call.input);
	return elidable
		? {
				id: call.id,
				toolCallId: call.toolCallId,
				tool: call.tool,
				keepCall: 1.0,
				keepResult: 0.0,
				action: "drop_result",
				reason: "result_dropped",
			}
		: {
				id: call.id,
				toolCallId: call.toolCallId,
				tool: call.tool,
				keepCall: 1.0,
				keepResult: 1.0,
				action: "keep",
				reason: "kept",
			};
}

function score(answer: JevAskResult["answers"][string] | undefined): number {
	const value = typeof answer === "object" && answer !== null ? Number(answer.noul ?? 1.0) : Number(answer ?? 1.0);
	return Number.isFinite(value) ? value : 1.0;
}

/**
 * Asks the evaluator which older calls and results are still needed. Calls in `exclude` get no decision, so earlier
 * ones stand; candidates that do not fit `maxRequestChars` get heuristic decisions. Throws when the evaluator fails
 * or `signal` aborts; the caller decides whether to fall back to `compactHeuristic`.
 */
export async function compact(
	messages: readonly Message[],
	asker: JevAsker,
	options: CompactOptions = {},
): Promise<CompactResult> {
	const keepThreshold = options.keepThreshold ?? DEFAULT_KEEP_THRESHOLD;
	const preserveRecentSteps = options.preserveRecentSteps ?? DEFAULT_PRESERVE_RECENT_STEPS;

	const calls = collectCandidateCalls(messages, preserveRecentSteps).filter(
		(c) => !options.exclude?.has(c.toolCallId) && (!options.isSent || options.isSent(c.callIndex)),
	);
	const candidates = new Set(calls.filter((c) => !c.pinned).map((c) => c.toolCallId));
	if (candidates.size === 0) {
		return { decisions: calls.map(pinnedDecision), askedCalls: 0, compactedCalls: 0 };
	}

	const { state, asked } = buildCompactionState(messages, calls, {
		goal: options.goal,
		maxChars: options.maxRequestChars,
		candidates,
		isSent: options.isSent,
	});
	const answers = new Map<string, CallAnswer>();
	if (asked.length > 0) {
		const questions: JevQuestions = {};
		for (const call of asked) Object.assign(questions, questionsFor(call));
		const response = await asker.ask(state, questions, options.signal);
		for (const call of asked) {
			answers.set(call.id, {
				keepCall: score(response.answers[`call_${call.id}`]),
				keepResult: score(response.answers[`result_${call.id}`]),
			});
		}
	}

	const decisions = calls.map((call) => {
		if (call.pinned) return pinnedDecision(call);
		const answer = answers.get(call.id);
		return answer ? decideCall(call, answer, keepThreshold) : heuristicDecision(call, messages);
	});
	return {
		decisions,
		askedCalls: asked.length,
		compactedCalls: applyJevDecisions(messages, decisions).compactedCalls,
	};
}

/**
 * Compacts older calls with long results or arguments, without an evaluator. Automatic trimming uses this: it is
 * instant and predictable, and it sends no extra request that would evict llama.cpp's cached prompt.
 */
export function compactHeuristic(
	messages: readonly Message[],
	preserveRecentSteps = DEFAULT_PRESERVE_RECENT_STEPS,
): CompactResult {
	const calls = collectCandidateCalls(messages, preserveRecentSteps);
	const decisions = calls.map((call) => (call.pinned ? pinnedDecision(call) : heuristicDecision(call, messages)));
	return { decisions, askedCalls: 0, compactedCalls: applyJevDecisions(messages, decisions).compactedCalls };
}
