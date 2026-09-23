import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJevGBNF, formatCompactionPrompt, LocalLlamaJevAsker } from "../src/jev/asker.ts";
import { compact } from "../src/jev/compact.ts";
import type { CompactionState, JevAsker, JevQuestions } from "../src/jev/types.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "../src/llm/types.ts";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const step = (...content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	model: "m",
	usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
	stopReason: "toolUse",
	timestamp: 0,
});
const result = (id: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

/** A task with `count` reads; even ones return long output, odd ones short. */
function reads(count: number): Message[] {
	const messages: Message[] = [user("fix the bug")];
	for (let i = 0; i < count; i++) {
		messages.push(
			step(call(`c${i}`, "read", { path: `src/f${i}.ts` })),
			result(`c${i}`, i % 2 === 0 ? "x\n".repeat(400) : "ok"),
		);
	}
	return messages;
}

/** Keeps every call and records what it was asked. */
function recorder() {
	const seen: { state?: CompactionState; questions?: JevQuestions; signal?: AbortSignal } = {};
	const asker: JevAsker = {
		ask: async (state, questions, signal) => {
			Object.assign(seen, { state, questions, signal });
			return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])) };
		},
	};
	return { asker, seen };
}

describe("compact", () => {
	it("asks about the newest calls that fit the request budget and decides older ones by heuristic", async () => {
		const messages = reads(200);
		const { asker, seen } = recorder();
		const maxRequestChars = 20_000;

		const res = await compact(messages, asker, { preserveRecentSteps: 1, maxRequestChars });

		const { system, user: prompt } = formatCompactionPrompt(
			seen.state as CompactionState,
			seen.questions as JevQuestions,
		);
		expect(system.length + prompt.length).toBeLessThanOrEqual(maxRequestChars);
		expect(res.askedCalls).toBeGreaterThan(10);
		expect(res.askedCalls).toBeLessThan(199);
		// The newest unpinned call (c198) was asked; the oldest was not.
		const history = (seen.state as CompactionState).history;
		expect(history.at(-1)?.i).toBe(messages.length - 2);
		expect(Object.keys(seen.questions ?? {})).not.toContain("call_t1");
		// Jev kept what it was asked about; the heuristic cut the long results it was not asked about.
		const byId = new Map(res.decisions.map((d) => [d.toolCallId, d]));
		expect(byId.get("c196")?.reason).toBe("kept");
		expect(byId.get("c0")).toMatchObject({ action: "drop_result", reason: "result_dropped" });
		expect(byId.get("c1")).toMatchObject({ action: "keep", reason: "kept" });
	});

	it("leaves out settled calls and messages that are no longer sent", async () => {
		const messages = reads(6);
		const { asker, seen } = recorder();
		// c0 is no longer sent; c2 was compacted before.
		const isSent = (index: number) => index === 0 || index > 2;

		const res = await compact(messages, asker, { preserveRecentSteps: 1, exclude: new Set(["c2"]), isSent });

		const decided = res.decisions.map((d) => d.toolCallId);
		expect(decided).not.toContain("c0");
		expect(decided).not.toContain("c2");
		expect((seen.state as CompactionState).history.map((entry) => entry.i)).not.toContain(1);
		expect(res.askedCalls).toBe(3);
	});

	it("passes the abort signal to the evaluator", async () => {
		const { asker, seen } = recorder();
		const controller = new AbortController();
		await compact(reads(4), asker, { preserveRecentSteps: 1, signal: controller.signal });
		expect(seen.signal).toBe(controller.signal);
	});
});

describe("LocalLlamaJevAsker", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("builds a grammar llama.cpp accepts: rule names of letters, digits, and hyphens only", () => {
		// llama-server rejected the whole grammar over one underscore in a rule name.
		for (const keys of [[], ["call_t1", "result_t1"], ["call_t12", "result_t12", "call_t13"]]) {
			for (const line of buildJevGBNF(keys).split("\n")) {
				expect(line, line).toMatch(/^[A-Za-z0-9-]+ ::= /);
			}
		}
	});

	it("turns thinking off and names an empty answer", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }));
		});
		const asker = new LocalLlamaJevAsker({ llamaUrl: "http://127.0.0.1:9" });
		const questions: JevQuestions = { call_t1: { type: "noul", instructions: "keep?" } };
		await expect(asker.ask({ context: "", goal: "g", history: [] }, questions)).rejects.toThrow(
			"the model returned an empty answer",
		);
		expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("reserves reply tokens for the answers only", async () => {
		const bodies: { max_tokens: number }[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body)));
			const content = JSON.stringify({ answers: { call_t1: { noul: 1 }, result_t1: { noul: 0 } } });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
		});
		const asker = new LocalLlamaJevAsker({ llamaUrl: "http://127.0.0.1:9" });
		const questions: JevQuestions = {
			call_t1: { type: "noul", instructions: "keep call?" },
			result_t1: { type: "noul", instructions: "keep result?" },
		};

		const answer = await asker.ask({ context: "", goal: "g", history: [] }, questions);
		expect(bodies[0].max_tokens).toBe(64 + 2 * 16);
		expect(answer.answers.result_t1).toEqual({ type: "noul", noul: 0 });
	});

	it("stops when the caller aborts, and names a timeout when the evaluator is too slow", async () => {
		vi.stubGlobal(
			"fetch",
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const questions: JevQuestions = { call_t1: { type: "noul", instructions: "keep?" } };
		const state = { context: "", goal: "g", history: [] };

		const controller = new AbortController();
		const pending = new LocalLlamaJevAsker({ llamaUrl: "http://127.0.0.1:9" }).ask(
			state,
			questions,
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toThrow();

		const slow = new LocalLlamaJevAsker({ llamaUrl: "http://127.0.0.1:9", timeoutMs: 20 });
		await expect(slow.ask(state, questions)).rejects.toThrow("the evaluator did not answer within 0s");
	});
});
