import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.ts";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentEvent, AgentTool, StreamFn } from "../src/agent/types.ts";
import type { LiteModel } from "../src/config/models.ts";
import { resolvePreset } from "../src/config/sampling.ts";
import { AssistantMessageEventStream } from "../src/llm/event-stream.ts";
import type { AssistantMessage, Message, StopReason, ToolCall, UserMessage } from "../src/llm/types.ts";

const model: LiteModel = {
	name: "test-model",
	id: "test.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 32768,
	maxTokens: 4096,
	modelPath: "/models/test.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};
const preset = resolvePreset("instruct");

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const say = (text: string) => ({ type: "text" as const, text });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

interface Reply {
	content: AssistantMessage["content"];
	stopReason?: StopReason;
}

/** Stream function that answers with scripted replies and records the messages each request carried. */
function script(...replies: Reply[]) {
	const requests: Message[][] = [];
	const streamFn: StreamFn = (_model, context) => {
		requests.push([...context.messages]);
		const reply = replies.shift();
		if (!reply) throw new Error("unexpected extra request");
		const hasToolCalls = reply.content.some((block) => block.type === "toolCall");
		const message: AssistantMessage = {
			role: "assistant",
			content: reply.content,
			model: model.name,
			usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
			stopReason: reply.stopReason ?? (hasToolCalls ? "toolUse" : "stop"),
			timestamp: 0,
		};
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const reason = message.stopReason;
			if (reason === "error" || reason === "aborted") {
				stream.push({ type: "error", reason, error: message });
			} else {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason, message });
			}
			stream.end();
		});
		return stream;
	};
	return { streamFn, requests };
}

const echoSchema = Type.Object({ text: Type.String() });

function echoTool(log: string[], onExecute?: () => void): AgentTool<typeof echoSchema> {
	return {
		name: "echo",
		label: "echo",
		description: "Echo text",
		parameters: echoSchema,
		async execute(_toolCallId, { text }) {
			onExecute?.();
			log.push(text);
			return { content: [say(`echo: ${text}`)] };
		},
	};
}

interface RunOptions {
	signal?: AbortSignal;
	takeQueuedMessages?: () => Message[];
	transformContext?: (messages: Message[]) => Message[];
	messages?: Message[];
}

async function run(streamFn: StreamFn, tools: AgentTool[], options: RunOptions = {}) {
	const events: AgentEvent[] = [];
	const context = { systemPrompt: "sys", messages: options.messages ?? [], tools };
	const added = await runAgentLoop(
		[user("go")],
		context,
		{
			model,
			preset,
			streamFn,
			takeQueuedMessages: options.takeQueuedMessages,
			transformContext: options.transformContext,
		},
		(event) => {
			events.push(event);
		},
		options.signal,
	);
	return { added, events, context };
}

const textOf = (message: Message | undefined) =>
	message && typeof message.content !== "string" && message.content[0]?.type === "text" ? message.content[0].text : "";

describe("runAgentLoop", () => {
	it("executes tool calls and sends the results back until the model stops calling tools", async () => {
		const log: string[] = [];
		const { streamFn, requests } = script(
			{ content: [call("c1", "echo", { text: "hi" })] },
			{ content: [say("done")] },
		);
		const { added, events } = await run(streamFn, [echoTool(log)]);

		expect(log).toEqual(["hi"]);
		expect(requests[1].map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(added.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(added[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: false });
		expect(textOf(added[2])).toBe("echo: hi");
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"turn_start",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("reports unknown tools and invalid arguments as error results", async () => {
		const { streamFn } = script(
			{ content: [call("c1", "bogus", {}), call("c2", "echo", {})] },
			{ content: [say("sorry")] },
		);
		const { added } = await run(streamFn, [echoTool([])]);
		const results = added.filter((message) => message.role === "toolResult");
		expect(results.map((result) => result.role === "toolResult" && result.isError)).toEqual([true, true]);
		expect(textOf(results[0])).toBe('Unknown tool "bogus". Available tools: echo.');
		expect(textOf(results[1])).toMatch(/^Validation failed for tool "echo"/);
	});

	it("does not execute tool calls from a response cut off by max_tokens", async () => {
		const log: string[] = [];
		const { streamFn } = script(
			{ content: [call("c1", "echo", { text: "partial" })], stopReason: "length" },
			{ content: [say("retrying later")] },
		);
		const { added } = await run(streamFn, [echoTool(log)]);
		expect(log).toEqual([]);
		expect(textOf(added[2])).toMatch(/response hit max_tokens/);
	});

	it("runs the finished tool calls of a response cut off by max_tokens and refuses only the last one", async () => {
		const log: string[] = [];
		const { streamFn } = script(
			{
				content: [call("c1", "echo", { text: "whole" }), call("c2", "echo", { text: "cut" })],
				stopReason: "length",
			},
			{ content: [say("resending")] },
		);
		const { added } = await run(streamFn, [echoTool(log)]);
		const results = added.filter((message) => message.role === "toolResult");
		expect(log).toEqual(["whole"]);
		expect(results.map((result) => result.role === "toolResult" && result.isError)).toEqual([false, true]);
		expect(textOf(results[1])).toMatch(/response hit max_tokens/);
	});

	it("runs every tool call when max_tokens cuts off text after them", async () => {
		const log: string[] = [];
		const { streamFn } = script(
			{ content: [call("c1", "echo", { text: "a" }), say("and now I will")], stopReason: "length" },
			{ content: [say("done")] },
		);
		await run(streamFn, [echoTool(log)]);
		expect(log).toEqual(["a"]);
	});

	it("ends the run on a failed response", async () => {
		const { streamFn, requests } = script({ content: [], stopReason: "error" });
		const { added, events } = await run(streamFn, []);
		expect(requests).toHaveLength(1);
		expect(added.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("stops after the running tool when the run is aborted", async () => {
		const controller = new AbortController();
		const log: string[] = [];
		const { streamFn, requests } = script({
			content: [call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
		});
		const { added } = await run(streamFn, [echoTool(log, () => controller.abort())], { signal: controller.signal });
		expect(log).toEqual(["a"]);
		expect(requests).toHaveLength(1);
		expect(added.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("sends queued messages with the next request", async () => {
		const queued = [user("also this")];
		const { streamFn, requests } = script({ content: [say("first")] }, { content: [say("second")] });
		await run(streamFn, [], { takeQueuedMessages: () => queued.splice(0) });
		expect(requests).toHaveLength(2);
		expect(requests[1].map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[1][2]).toMatchObject({ content: "also this" });
	});

	it("sends the transformed context but keeps the full transcript", async () => {
		const { streamFn, requests } = script({ content: [say("ok")] });
		const history = [user("old"), user("older")];
		const { context } = await run(streamFn, [], {
			messages: history,
			transformContext: (messages) => messages.slice(-1),
		});
		expect(requests[0]).toHaveLength(1);
		expect(requests[0][0]).toMatchObject({ content: "go" });
		expect(context.messages).toHaveLength(4);
	});
});

describe("Agent", () => {
	it("keeps the whole transcript but sends only the turns that fit the window", async () => {
		const small: LiteModel = { ...model, contextWindow: 1000, maxTokens: 200 };
		const { streamFn, requests } = script({ content: [say("one")] }, { content: [say("two")] });
		const agent = new Agent({ model: small, mode: "instruct", systemPrompt: "sys", tools: [], streamFn });
		const trimmed: number[] = [];
		agent.subscribe((event) => {
			if (event.type === "context_trimmed") trimmed.push(event.droppedMessages);
		});

		await agent.prompt("a".repeat(1500));
		await agent.prompt("b".repeat(1500));

		expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(requests[1]).toHaveLength(1);
		expect(requests[1][0]).toMatchObject({ content: "b".repeat(1500) });
		expect(trimmed).toEqual([2]);
	});

	it("ends the run with an error instead of sending a request that leaves no room for the reply", async () => {
		const small: LiteModel = { ...model, contextWindow: 1000, maxTokens: 200 };
		const { streamFn, requests } = script();
		const agent = new Agent({ model: small, mode: "instruct", systemPrompt: "sys", tools: [], streamFn });

		await agent.prompt("a".repeat(3000));

		expect(requests).toHaveLength(0);
		expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(agent.messages[1]).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringMatching(/^Context full: this request needs about \d+ tokens/),
		});
		expect(agent.isRunning).toBe(false);
	});

	it("sends a message queued during a run with that run's next request", async () => {
		const { streamFn, requests } = script({ content: [say("first")] }, { content: [say("second")] });
		const agent = new Agent({ model, mode: "instruct", systemPrompt: "sys", tools: [], streamFn });
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && agent.messages.length === 2) {
				agent.enqueue("more");
			}
		});

		await agent.prompt("go");

		expect(requests).toHaveLength(2);
		expect(requests[1].map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(agent.queuedMessages).toHaveLength(0);
		expect(agent.isRunning).toBe(false);
	});

	it("refuses a second prompt while running", async () => {
		const { streamFn } = script({ content: [say("slow")] });
		const agent = new Agent({ model, mode: "instruct", systemPrompt: "sys", tools: [], streamFn });
		const first = agent.prompt("go");
		await expect(agent.prompt("again")).rejects.toThrow("already running");
		await first;
	});
});
