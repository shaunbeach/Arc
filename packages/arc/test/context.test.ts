import { describe, expect, it } from "vitest";
import {
	ContextWindow,
	describeTrim,
	estimateMessageTokens,
	estimateTokens,
	isElisionPlaceholder,
} from "../src/context.ts";
import { compact, compactHeuristic } from "../src/jev/compact.ts";
import type { JevAsker } from "../src/jev/types.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "../src/llm/types.ts";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string, promptTokens = 0): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model: "m",
	usage: { promptTokens, cachedTokens: 0, completionTokens: 0 },
	stopReason: "stop",
	timestamp: 0,
});
const step = (...content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	model: "m",
	usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
	stopReason: "toolUse",
	timestamp: 0,
});
const think = (length: number) => ({ type: "thinking" as const, thinking: "t".repeat(length) });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const result = (id: string, toolName: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError,
	timestamp: 0,
});

describe("token estimates", () => {
	it("counts about three characters per token plus per-message overhead", () => {
		expect(estimateTokens("abcdef")).toBe(2);
		expect(estimateMessageTokens(user("x".repeat(300)))).toBe(104);
		expect(estimateMessageTokens(assistant("ok"))).toBe(5);
	});

	it("leaves out reasoning on request", () => {
		expect(estimateMessageTokens(step(think(300), { type: "text", text: "ok" }), false)).toBe(5);
	});
});

describe("ContextWindow", () => {
	// Each long user message estimates to 104 tokens, each short reply to 14.
	const long = (tag: string) => user(tag.repeat(300));
	const reply = () => assistant("r".repeat(30));

	it("sends everything while the prompt fits", async () => {
		const messages = [long("a"), reply(), long("b")];
		const selection = await new ContextWindow().select(messages, 1000, 10);
		expect(selection).toEqual({
			messages,
			droppedMessages: 0,
			compactedSteps: 0,
			estimatedTokens: 232,
			trimmed: false,
		});
	});

	it("drops whole old turns down to 60% of the budget, keeping the current turn", async () => {
		const messages = [long("a"), reply(), long("b"), reply(), long("c")];
		const selection = await new ContextWindow().select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(4);
		expect(selection.messages).toEqual([messages[4]]);
		expect(selection.estimatedTokens).toBe(114);
		expect(selection.trimmed).toBe(true);
	});

	it("keeps the cut in place while later requests still fit", async () => {
		const window = new ContextWindow();
		const messages: Message[] = [long("a"), reply(), long("b"), reply(), long("c")];
		await window.select(messages, 300, 10);
		messages.push(reply(), long("d"));
		const selection = await window.select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(4);
		expect(selection.messages).toHaveLength(3);
		expect(selection.trimmed).toBe(false);
	});

	it("trims on reported usage when the character estimate is too low", async () => {
		const messages = [long("a"), assistant("r".repeat(30), 250), user("x".repeat(300))];
		const selection = await new ContextWindow().select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(2);
	});

	it("ignores usage measured before the last cut", async () => {
		const window = new ContextWindow();
		const messages: Message[] = [user("x".repeat(600)), assistant("ok"), user("u"), assistant("ok", 1100), user("v")];
		expect((await window.select(messages, 1000, 0)).droppedMessages).toBe(2);
		messages.push(assistant("ok"), user("w"));
		expect((await window.select(messages, 1000, 0)).droppedMessages).toBe(2);
	});

	it("never drops the turn in progress, even when it alone is over budget", async () => {
		const selection = await new ContextWindow().select([user("x".repeat(3000))], 10, 0);
		expect(selection.droppedMessages).toBe(0);
		expect(selection.messages).toHaveLength(1);
	});

	it("starts over when the transcript is replaced by a shorter one", async () => {
		const window = new ContextWindow();
		await window.select([long("a"), reply(), long("b"), reply(), long("c")], 300, 10);
		expect((await window.select([user("new")], 300, 10)).droppedMessages).toBe(0);
	});

	it("does not count reasoning the request will not replay", async () => {
		const messages: Message[] = [user("a"), step(think(3000), { type: "text", text: "answer" }), user("b")];
		expect((await new ContextWindow().select(messages, 500, 0, "turn")).trimmed).toBe(false);
		expect((await new ContextWindow().select(messages, 500, 0, "all")).trimmed).toBe(true);
	});

	it("applies Jev decisions from /compact: unneeded results cut, needed ones kept verbatim", async () => {
		const messages: Message[] = [
			user("go"),
			step(call("c1", "search", { query: "files" })),
			result("c1", "search", "lots of search output\n".repeat(80)), // unneeded
			step(call("c2", "read", { path: "important.ts" })),
			result("c2", "read", "export const KEY = 42;\n".repeat(20)), // needed verbatim
			step(call("c3", "read", { path: "recent.ts" })),
			result("c3", "read", "recent 1"), // recent step 2
			step(call("c4", "read", { path: "recent2.ts" })),
			result("c4", "read", "recent 2"), // recent step 1
		];

		const mockAsker: JevAsker = {
			ask: async (_state, _questions) => ({
				answers: {
					call_t1: { noul: 1.0 },
					result_t1: { noul: 0.0 }, // drop result of c1
					call_t2: { noul: 1.0 },
					result_t2: { noul: 1.0 }, // keep result of c2 verbatim!
				},
			}),
		};

		const window = new ContextWindow();
		const decided = await compact(messages, mockAsker, { preserveRecentSteps: 2 });
		expect(decided.askedCalls).toBe(2);
		window.adoptDecisions(messages, decided.decisions);
		const selection = window.select(messages, 100_000, 0, "turn");

		expect(selection.trimmed).toBe(false);
		// c1 toolResult keeps its first lines and a note
		const cut = (selection.messages[2] as ToolResultMessage).content[0] as { text: string };
		expect(cut.text.startsWith("lots of search output\nlots of search output\n")).toBe(true);
		expect(cut.text).toMatch(/\(the other \d+ lines of this output left out to save context\. Run the tool again/);
		expect(cut.text.length).toBeLessThan(500);
		// c2 toolResult was kept verbatim!
		expect((selection.messages[4] as ToolResultMessage).content[0]).toEqual({
			type: "text",
			text: "export const KEY = 42;\n".repeat(20),
		});
	});

	it("keeps Jev decisions in later requests, and automatic trims never undo them", async () => {
		const messages: Message[] = [
			user("go"),
			step(call("c1", "bash", { command: "ls" })),
			result("c1", "bash", "a.ts"),
			step(call("c2", "read", { path: "a.ts" })),
			result("c2", "read", "a\n".repeat(1500)),
			step(call("c3", "read", { path: "b" })),
			result("c3", "read", "b"),
			step(call("c4", "read", { path: "c" })),
			result("c4", "read", "c"),
		];
		// Jev: c1 is not needed at all; c2's result is needed verbatim.
		const asker: JevAsker = {
			ask: async () => ({
				answers: {
					call_t1: { noul: 0 },
					result_t1: { noul: 0 },
					call_t2: { noul: 1 },
					result_t2: { noul: 1 },
				},
			}),
		};
		const window = new ContextWindow();
		window.adoptDecisions(messages, (await compact(messages, asker, { preserveRecentSteps: 2 })).decisions);
		const first = window.select(messages, 100_000, 0, "turn");
		expect((first.messages[1] as AssistantMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("ran `ls`"),
		});

		// A tight budget makes the heuristic keep c1 (short) and cut c2 (long). The dropped c1 stays dropped.
		messages.push(step(call("c5", "read", { path: "d" })), result("c5", "read", "d"));
		const trimmed = window.select(messages, 1000, 0, "turn");
		expect(trimmed.trimmed).toBe(true);
		expect(JSON.stringify(trimmed.messages)).not.toContain('"command":"ls"');
		expect((trimmed.messages[2] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("left out to save context"),
		});

		// Later requests that fit send the same prefix.
		messages.push(step(call("c6", "read", { path: "e" })), result("c6", "read", "e"));
		const later = window.select(messages, 1000, 0, "turn");
		expect(later.trimmed).toBe(false);
		expect(later.messages.slice(0, trimmed.messages.length)).toEqual(trimmed.messages);
	});

	it("drops reasoning of older steps first, keeping the two most recent steps whole", async () => {
		// One task: each step estimates to 1010 tokens, 1000 of them reasoning.
		const messages: Message[] = [
			user("go"),
			step(think(3000), call("c1", "read", { path: "a" })),
			result("c1", "read", "ok"),
			step(think(3000), call("c2", "read", { path: "b" })),
			result("c2", "read", "ok"),
			step(think(3000), call("c3", "read", { path: "c" })),
			result("c3", "read", "ok"),
			step(think(3000), call("c4", "read", { path: "d" })),
			result("c4", "read", "ok"),
		];
		const selection = new ContextWindow().select(messages, 3500, 0, "turn");

		expect(selection.trimmed).toBe(true);
		expect(selection.estimatedTokens).toBeLessThanOrEqual(3500 * 0.6);
		expect(selection.droppedMessages).toBe(0);
		expect(selection.compactedSteps).toBe(2);
		expect((selection.messages[1] as AssistantMessage).content).toEqual([call("c1", "read", { path: "a" })]);
		expect((selection.messages[3] as AssistantMessage).content).toEqual([call("c2", "read", { path: "b" })]);
		expect(selection.messages[5]).toBe(messages[5]);
		expect(selection.messages[7]).toBe(messages[7]);
		expect((messages[1] as AssistantMessage).content).toHaveLength(2);
	});

	it("keeps reasoning dropped in later requests", async () => {
		const messages: Message[] = [
			user("go"),
			step(think(3000), call("c1", "read", { path: "a" })),
			result("c1", "read", "ok"),
			step(think(3000), call("c2", "read", { path: "b" })),
			result("c2", "read", "ok"),
			step(think(3000), call("c3", "read", { path: "c" })),
			result("c3", "read", "ok"),
		];
		const window = new ContextWindow();
		const first = await window.select(messages, 3000, 0, "turn");
		const later = await window.select([...messages, step(call("c4", "read", { path: "d" }))], 3000, 0, "turn");

		expect(later.trimmed).toBe(false);
		expect(later.messages.slice(0, 7)).toEqual(first.messages);
	});

	it("compacts long results when trimming, without asking an evaluator", async () => {
		const messages: Message[] = [
			user("go"),
			step(call("c1", "search", { query: "files" })),
			result("c1", "search", "large output\n".repeat(60)),
			step(call("c2", "read", { path: "a" })),
			result("c2", "read", "a"),
			step(call("c3", "read", { path: "b" })),
			result("c3", "read", "b"),
		];

		const selection = new ContextWindow().select(messages, 300, 0, "turn");
		expect(selection.trimmed).toBe(true);
		expect((selection.messages[2] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("left out to save context"),
		});
	});

	it("progressively compacts older step when only 2 steps exist and exceed budget", async () => {
		const messages: Message[] = [
			user("go"),
			step(call("c1", "read", { path: "huge.ts" })),
			result("c1", "read", "huge content\n".repeat(80)), // step 2
			step(call("c2", "read", { path: "recent.ts" })),
			result("c2", "read", "recent"), // step 1
		];

		const selection = new ContextWindow().select(messages, 200, 0, "turn");
		expect(selection.trimmed).toBe(true);
		expect((selection.messages[2] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/^huge content\n[\s\S]*left out to save context/),
		});
	});

	it("turns a compacted write into a note instead of a placeholder argument", async () => {
		const largeContent = "export function test() {\n  return 1;\n}\n".repeat(40);
		const messages: Message[] = [
			user("write code"),
			step(call("c1", "write", { path: "src/large.ts", content: largeContent })),
			result("c1", "write", "Wrote 120 lines to src/large.ts"),
			step(call("c2", "read", { path: "a.ts" })),
			result("c2", "read", "content a"),
			step(call("c3", "read", { path: "b.ts" })),
			result("c3", "read", "content b"),
		];

		const selection = await new ContextWindow().select(messages, 200, 0, "turn");
		expect(selection.trimmed).toBe(true);
		// The write and its result leave; the next step says in prose what happened, then makes its own call.
		expect(selection.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
		expect((selection.messages[1] as AssistantMessage).content).toEqual([
			{
				type: "text",
				text: "(Earlier tool call left out to save context: wrote src/large.ts (121 lines). Their results are not shown; run a tool again, or read a file, if you need them.)",
			},
			call("c2", "read", { path: "a.ts" }),
		]);
		expect(JSON.stringify(selection.messages)).not.toContain("elided");
		// The transcript still holds the write as it happened.
		expect((messages[1] as AssistantMessage).content[0]).toEqual(
			call("c1", "write", { path: "src/large.ts", content: largeContent }),
		);
	});

	it("never shows placeholders in tool arguments, whatever Jev decides", async () => {
		const messages: Message[] = [
			user("go"),
			step(
				{ type: "text", text: "Reading and writing." },
				call("c1", "read", { path: "a.ts" }),
				call("c2", "write", { path: "b.ts", content: "b\n".repeat(400) }),
			),
			result("c1", "read", "a\n".repeat(400)),
			result("c2", "write", "Wrote b.ts", true),
			step(call("c3", "bash", { command: "npm test\necho done" })),
			result("c3", "bash", "ok"),
			step(call("c4", "read", { path: "c.ts" })),
			result("c4", "read", "c"),
			step(call("c5", "read", { path: "d.ts" })),
			result("c5", "read", "d"),
		];
		const dropAll: JevAsker = {
			ask: async (_state, questions) => ({
				answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0 }])),
			}),
		};

		const window = new ContextWindow();
		window.adoptDecisions(messages, (await compact(messages, dropAll, { preserveRecentSteps: 2 })).decisions);
		const selection = window.select(messages, 100_000, 0, "turn");
		const roles = selection.messages.map((m) => m.role);
		// Roles still alternate, and every tool result still follows its call.
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult"]);
		for (const message of selection.messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") expect(JSON.stringify(block.arguments)).not.toMatch(/elided|left out/);
			}
		}
		expect((selection.messages[1] as AssistantMessage).content).toEqual([
			{ type: "text", text: "Reading and writing." },
			{
				type: "text",
				text: "(Earlier tool calls left out to save context: read a.ts; wrote b.ts (401 lines), which failed. Their results are not shown; run a tool again, or read a file, if you need them.)",
			},
			{
				type: "text",
				text: "(Earlier tool call left out to save context: ran `npm test…`. Their results are not shown; run a tool again, or read a file, if you need them.)",
			},
			call("c4", "read", { path: "c.ts" }),
		]);
	});

	it("leaves placeholders stored by older versions as they are", () => {
		const messages: Message[] = [
			user("write code"),
			step(call("c1", "write", { path: "src/large.ts", content: "x".repeat(1000) })),
			result("c1", "write", "[elided from context: 1 line of write output]"),
			step(call("c2", "read", { path: "a.ts" })),
			result("c2", "read", "[elided from context: 40 lines of read output; call the tool again if you need it]"),
			step(call("c3", "read", { path: "b.ts" })),
			result("c3", "read", "content b"),
		];

		const heuristic = compactHeuristic(messages, 1);
		// The write is collapsed to a note; the stored read placeholder is not cut again.
		expect(heuristic.compactedCalls).toBe(1);
	});

	it("drops intermediate steps within a single long turn when budget is exceeded", async () => {
		// Single user prompt with many steps exceeding budget
		const messages: Message[] = [user("solve complex task")];
		for (let i = 1; i <= 10; i++) {
			messages.push(
				step(call(`c${i}`, "bash", { command: `echo ${i}` })),
				result(`c${i}`, "bash", `step output ${i}\n`.repeat(10)),
			);
		}

		const window = new ContextWindow();
		// Very low budget forcing intermediate step dropping
		const selection = await window.select(messages, 150, 0, "all");
		expect(selection.trimmed).toBe(true);
		// Initial user prompt must be preserved at index 0
		expect(selection.messages[0]).toEqual(messages[0]);
		// First message after user prompt must be an assistant step (not an orphaned toolResult)
		expect(selection.messages[1].role).toBe("assistant");
		// The most recent step must still be present
		const lastMsg = selection.messages[selection.messages.length - 1];
		expect(lastMsg).toEqual(messages[messages.length - 1]);
		expect(selection.droppedMessages).toBeGreaterThan(0);
	});
});

describe("elision placeholders", () => {
	it("recognizes placeholders so tools can refuse to write them", () => {
		expect(isElisionPlaceholder("[elided from context: 319 lines]")).toBe(true);
		expect(isElisionPlaceholder("  [elided: 3 lines]")).toBe(true);
		expect(isElisionPlaceholder("print('[elided')")).toBe(false);
	});

	it("describes a trim for the transcript", () => {
		expect(describeTrim({ droppedMessages: 4, compactedSteps: 12, estimatedTokens: 7400 })).toBe(
			"context trimmed to ~7400 tokens (12 older steps compacted, 4 old messages left out); the prompt is re-read before the next reply",
		);
	});
});
