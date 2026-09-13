import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import { resolvePreset } from "../src/config/sampling.ts";
import { buildRequestBody, convertMessages, streamChat } from "../src/llm/llama-client.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	StopReason,
	ToolResultMessage,
	UserMessage,
} from "../src/llm/types.ts";

const model: LiteModel = {
	name: "test-model",
	id: "test.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 32768,
	maxTokens: 4096,
	modelPath: "/models/test.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};
const thinking = resolvePreset("thinking");
const instruct = resolvePreset("instruct");

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: AssistantMessage["content"], stopReason: StopReason = "stop"): AssistantMessage => ({
	role: "assistant",
	content,
	model: "test-model",
	usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
	stopReason,
	timestamp: 0,
});
const toolResult = (toolCallId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});
const readCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a.ts" } });
const context = (messages: Context["messages"]): Context => ({ systemPrompt: "sys", messages });

describe("convertMessages", () => {
	const turn = context([
		user("hi"),
		assistant(
			[{ type: "thinking", thinking: "plan" }, { type: "text", text: "Reading." }, readCall("c1")],
			"toolUse",
		),
		toolResult("c1", "contents"),
	]);

	it("replays reasoning from the current turn as reasoning_content", () => {
		expect(convertMessages(model, turn, thinking)).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: "Reading.",
				reasoning_content: "plan",
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "contents" },
		]);
	});

	it("drops reasoning when thinkingHistory is none", () => {
		expect(convertMessages(model, turn, instruct)[2]).not.toHaveProperty("reasoning_content");
	});

	it("puts tool-result images in the tool message and adds no user turn after it", () => {
		// A user message directly after a tool result is rejected outright by Mistral chat templates, so images
		// ride inside the tool message. Verified against Qwen, Ornith and Ministral servers.
		const withImage: ToolResultMessage = {
			...toolResult("c1", "(see attached image)"),
			content: [
				{ type: "text", text: "(see attached image)" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			],
		};
		const turnWithImage = context([user("hi"), assistant([readCall("c1")], "toolUse"), withImage]);
		const seeing: LiteModel = { ...model, input: ["text", "image"] };

		const messages = convertMessages(seeing, turnWithImage, thinking);
		// Exactly four: the absence of a fifth message is the regression this guards against.
		expect(messages).toHaveLength(4);
		expect(messages[3]).toEqual({
			role: "tool",
			tool_call_id: "c1",
			content: [
				{ type: "text", text: "(see attached image)" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
			],
		});

		// Text-only models keep a plain string, so the common path stays byte-identical.
		expect(convertMessages(model, turnWithImage, thinking)[3]).toEqual({
			role: "tool",
			tool_call_id: "c1",
			content: "(see attached image)",
		});
	});

	it("replays reasoning from earlier turns only when thinkingHistory is all", () => {
		const history = context([...turn.messages, assistant([{ type: "text", text: "Done." }]), user("next")]);
		expect(convertMessages(model, history, thinking)[2]).not.toHaveProperty("reasoning_content");
		const all = { ...thinking, thinkingHistory: "all" as const };
		expect(convertMessages(model, history, all)[2]).toMatchObject({ reasoning_content: "plan" });
	});

	it("replays reasoning inline when configured", () => {
		const inline = { ...thinking, thinkingReplay: "inline" as const };
		expect(convertMessages(model, turn, inline)[2]).toMatchObject({ content: "<think>\nplan\n</think>\n\nReading." });
	});

	it("drops aborted turns with their results and closes unanswered tool calls", () => {
		const messages = convertMessages(
			model,
			context([
				user("a"),
				assistant([readCall("c1")], "aborted"),
				toolResult("c1", "late"),
				user("b"),
				assistant([readCall("c2")], "toolUse"),
				user("c"),
			]),
			instruct,
		);
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "tool", "user"]);
		expect(messages[4]).toEqual({ role: "tool", tool_call_id: "c2", content: "No result provided" });
	});

	it("skips assistant turns that hold only reasoning", () => {
		const messages = convertMessages(
			model,
			context([user("a"), assistant([{ type: "thinking", thinking: "hm" }], "length")]),
			thinking,
		);
		expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
	});

	it("replaces images for text-only models", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const messages = convertMessages(
			model,
			context([user([{ type: "text", text: "look" }, image, image])]),
			instruct,
		);
		expect(messages[1]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "text", text: "(image omitted: model does not support images)" },
			],
		});
	});
});

describe("buildRequestBody", () => {
	it("combines messages, tools, limits, and sampling fields", () => {
		const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];
		const body = JSON.parse(JSON.stringify(buildRequestBody(model, { ...context([user("hi")]), tools }, thinking)));
		expect(body).toMatchObject({
			model: "test-model",
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 4096,
			cache_prompt: true,
			temperature: 1,
			top_k: 20,
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: false },
			tools: [
				{
					type: "function",
					function: {
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
			],
		});
	});
});

function sse(chunks: unknown[], tail = "data: [DONE]\n\n"): string {
	return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + tail;
}

/** Serves `body` in small byte slices, so SSE lines and UTF-8 characters are split across reads. */
function fakeFetch(body: string, status = 200) {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		const bytes = new TextEncoder().encode(body);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		});
		return new Response(stream, { status });
	}) as typeof fetch;
	return { fetch: fetchFn, requests };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("streamChat", () => {
	it("streams reasoning, text, and a tool call split across chunks", async () => {
		const { fetch, requests } = fakeFetch(
			sse([
				{ choices: [{ delta: { role: "assistant", content: null } }] },
				{ choices: [{ delta: { reasoning_content: "Need " } }] },
				{ choices: [{ delta: { reasoning_content: "a file." } }] },
				{ choices: [{ delta: { content: "Café " } }] },
				{
					choices: [
						{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }] } },
					],
				},
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
				{
					choices: [{ delta: {}, finish_reason: "tool_calls" }],
					timings: { prompt_n: 20, cache_n: 80, prompt_per_second: 500, predicted_per_second: 42.5 },
				},
				{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } },
			]),
		);
		const stream = streamChat(model, context([user("hi")]), { preset: thinking, fetch });
		const events = await collect(stream);
		const message = await stream.result();

		expect(requests[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"text_start",
			"text_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"thinking_end",
			"text_end",
			"toolcall_end",
			"done",
		]);
		expect(message).toMatchObject({
			content: [
				{ type: "thinking", thinking: "Need a file." },
				{ type: "text", text: "Café " },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
			stopReason: "toolUse",
			usage: { promptTokens: 100, cachedTokens: 80, completionTokens: 12 },
			timings: { promptPerSecond: 500, predictedPerSecond: 42.5 },
		});
	});

	it("assigns ids to tool calls without one and treats stop with tool calls as toolUse", async () => {
		const { fetch } = fakeFetch(
			sse([
				{
					choices: [
						{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"b"}' } }] } },
					],
				},
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			]),
		);
		const message = await streamChat(model, context([user("hi")]), { preset: instruct, fetch }).result();
		expect(message.stopReason).toBe("toolUse");
		expect(message.content[0]).toMatchObject({ type: "toolCall", id: expect.stringMatching(/^call_\w+$/) });
	});

	it("reports the error message from an HTTP error body", async () => {
		const { fetch } = fakeFetch(
			JSON.stringify({ error: { code: 400, message: "the request exceeds the context size" } }),
			400,
		);
		const stream = streamChat(model, context([user("hi")]), { preset: instruct, fetch });
		const events = await collect(stream);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "llama-server returned HTTP 400: the request exceeds the context size",
		});
	});

	it("names the server when the connection is refused", async () => {
		const refused = (async () => {
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
		}) as typeof fetch;
		const message = await streamChat(model, context([user("hi")]), { preset: instruct, fetch: refused }).result();
		expect(message.errorMessage).toBe("Cannot reach llama-server at http://127.0.0.1:8080/v1 (ECONNREFUSED)");
	});

	it("fails when the stream ends without a finish_reason", async () => {
		const { fetch } = fakeFetch(sse([{ choices: [{ delta: { content: "cut" } }] }]));
		const message = await streamChat(model, context([user("hi")]), { preset: instruct, fetch }).result();
		expect(message).toMatchObject({
			stopReason: "error",
			errorMessage: "llama-server closed the stream without a finish_reason",
		});
	});

	it("surfaces an error chunk sent mid-stream", async () => {
		const { fetch } = fakeFetch(
			sse([{ choices: [{ delta: { content: "a" } }] }, { error: { message: "slot crashed" } }]),
		);
		const message = await streamChat(model, context([user("hi")]), { preset: instruct, fetch }).result();
		expect(message).toMatchObject({ stopReason: "error", errorMessage: "slot crashed" });
	});

	it("keeps partial content and reports aborted when the signal fires", async () => {
		const abortable = (async (_url: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(sse([{ choices: [{ delta: { content: "partial" } }] }], "")),
					);
					signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				},
			});
			return new Response(stream);
		}) as typeof fetch;
		const controller = new AbortController();
		const stream = streamChat(model, context([user("hi")]), {
			preset: instruct,
			fetch: abortable,
			signal: controller.signal,
		});
		for await (const event of stream) {
			if (event.type === "text_delta") controller.abort();
		}
		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			content: [{ type: "text", text: "partial" }],
		});
	});
});
