import { describe, expect, it } from "vitest";
import {
	ContextWindow,
	describeTrim,
	estimateMessageTokens,
	estimateTokens,
	isElisionPlaceholder,
} from "../src/context.ts";
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
const result = (id: string, toolName: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});
const blocks = (message: Message) => (typeof message.content === "string" ? [] : message.content);

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

	it("sends everything while the prompt fits", () => {
		const messages = [long("a"), reply(), long("b")];
		const selection = new ContextWindow().select(messages, 1000, 10);
		expect(selection).toEqual({
			messages,
			droppedMessages: 0,
			compactedSteps: 0,
			estimatedTokens: 232,
			trimmed: false,
		});
	});

	it("drops whole old turns down to 60% of the budget, keeping the current turn", () => {
		const messages = [long("a"), reply(), long("b"), reply(), long("c")];
		const selection = new ContextWindow().select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(4);
		expect(selection.messages).toEqual([messages[4]]);
		expect(selection.estimatedTokens).toBe(114);
		expect(selection.trimmed).toBe(true);
	});

	it("keeps the cut in place while later requests still fit", () => {
		const window = new ContextWindow();
		const messages: Message[] = [long("a"), reply(), long("b"), reply(), long("c")];
		window.select(messages, 300, 10);
		messages.push(reply(), long("d"));
		const selection = window.select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(4);
		expect(selection.messages).toHaveLength(3);
		expect(selection.trimmed).toBe(false);
	});

	it("trims on reported usage when the character estimate is too low", () => {
		const messages = [long("a"), assistant("r".repeat(30), 250), user("x".repeat(300))];
		const selection = new ContextWindow().select(messages, 300, 10);
		expect(selection.droppedMessages).toBe(2);
	});

	it("ignores usage measured before the last cut", () => {
		const window = new ContextWindow();
		// a1's usage makes the first request look too big; the cut lands at u2, leaving a2, whose usage still counted u1.
		const messages: Message[] = [user("x".repeat(600)), assistant("ok"), user("u"), assistant("ok", 1100), user("v")];
		expect(window.select(messages, 1000, 0).droppedMessages).toBe(2);
		messages.push(assistant("ok"), user("w"));
		expect(window.select(messages, 1000, 0).droppedMessages).toBe(2);
	});

	it("never drops the turn in progress, even when it alone is over budget", () => {
		const selection = new ContextWindow().select([user("x".repeat(3000))], 10, 0);
		expect(selection.droppedMessages).toBe(0);
		expect(selection.messages).toHaveLength(1);
	});

	it("starts over when the transcript is replaced by a shorter one", () => {
		const window = new ContextWindow();
		window.select([long("a"), reply(), long("b"), reply(), long("c")], 300, 10);
		expect(window.select([user("new")], 300, 10).droppedMessages).toBe(0);
	});

	it("does not count reasoning the request will not replay", () => {
		const messages: Message[] = [user("a"), step(think(3000), { type: "text", text: "answer" }), user("b")];
		expect(new ContextWindow().select(messages, 500, 0, "turn").trimmed).toBe(false);
		expect(new ContextWindow().select(messages, 500, 0, "all").trimmed).toBe(true);
	});

	it("drops reasoning of older steps first, keeping the two most recent steps whole", () => {
		// One task: each step estimates to 1010 tokens, 1000 of them reasoning.
		const messages: Message[] = [
			user("go"),
			step(think(3000), call("c1", "read", { path: "a" })),
			result("c1", "read", "ok"),
			step(think(3000), call("c2", "read", { path: "b" })),
			result("c2", "read", "ok"),
			step(think(3000), call("c3", "read", { path: "c" })),
			result("c3", "read", "ok"),
		];
		const selection = new ContextWindow().select(messages, 3000, 0, "turn");

		expect(selection.trimmed).toBe(true);
		expect(selection.estimatedTokens).toBe(2050);
		expect(selection.compactedSteps).toBe(1);
		expect(blocks(selection.messages[1])).toEqual([call("c1", "read", { path: "a" })]);
		expect(selection.messages[3]).toBe(messages[3]);
		expect(selection.messages[5]).toBe(messages[5]);
		expect(blocks(messages[1])).toHaveLength(2);
	});

	it("elides long tool payloads oldest first, keeping call ids and short results", () => {
		const messages: Message[] = [
			user("go"),
			step(call("c1", "write", { path: "a.py", content: "x\n".repeat(600) })),
			result("c1", "write", "Wrote 600 lines to a.py."),
			step(call("c2", "bash", { command: "python3 -m unittest" })),
			result("c2", "bash", "F\n".repeat(300)),
			step(call("c3", "read", { path: "a.py" })),
			result("c3", "read", "y".repeat(1200)),
			step(call("c4", "read", { path: "b.py" })),
			result("c4", "read", "z".repeat(1200)),
		];
		const window = new ContextWindow();
		const first = window.select(messages, 1600, 0, "turn");

		expect(first.trimmed).toBe(true);
		expect(first.estimatedTokens).toBeLessThanOrEqual(1600 * 0.6);
		expect(blocks(first.messages[1])).toEqual([
			call("c1", "write", { path: "a.py", content: "[elided from context: 601 lines]" }),
		]);
		expect(first.messages[2]).toBe(messages[2]);
		expect(first.messages[3]).toBe(messages[3]);
		expect(first.messages[4]).toEqual({
			...messages[4],
			content: [
				{
					type: "text",
					text: "[elided from context: 301 lines of bash output; call the tool again if you need it]",
				},
			],
		});
		expect(first.messages.slice(5)).toEqual(messages.slice(5));
		expect((messages[1] as AssistantMessage).content[0]).toMatchObject({ arguments: { content: "x\n".repeat(600) } });

		// Trimmed messages look the same in later requests, so llama.cpp can reuse the prompt prefix.
		messages.push(step(call("c5", "read", { path: "c.py" })), result("c5", "read", "ok"));
		const second = window.select(messages, 1600, 0, "turn");
		expect(second.trimmed).toBe(false);
		expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
	});

	it("compacts the second most recent step only while the recent steps alone exceed the budget", () => {
		const messages: Message[] = [
			user("go"),
			step(think(3000), call("c1", "read", { path: "a" })),
			result("c1", "read", "ok"),
			step(think(3000), call("c2", "read", { path: "b" })),
			result("c2", "read", "ok"),
		];
		const selection = new ContextWindow().select(messages, 1500, 0, "turn");
		expect(selection.estimatedTokens).toBe(1035);
		expect(blocks(selection.messages[1])).toEqual([call("c1", "read", { path: "a" })]);
		expect(selection.messages[3]).toBe(messages[3]);
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
