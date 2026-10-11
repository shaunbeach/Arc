import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.ts";
import { runResearch } from "../src/agent/research.ts";
import type { AgentTool, StreamFn } from "../src/agent/types.ts";
import type { LiteModel } from "../src/config/models.ts";
import { AssistantMessageEventStream } from "../src/llm/event-stream.ts";
import type { AssistantMessage, Context } from "../src/llm/types.ts";
import { createCodingTools, toolLimitsFor } from "../src/tools/index.ts";
import { createResearchTool, subagentSharesServer } from "../src/tools/research.ts";

const model = (name: string, port: number): LiteModel => ({
	name,
	id: `${name}.gguf`,
	provider: "llamacpp",
	baseUrl: `http://127.0.0.1:${port}/v1`,
	reasoning: false,
	input: ["text"],
	contextWindow: 16_384,
	maxTokens: 4096,
	modelPath: `/m/${name}.gguf`,
	launchArgs: [],
	llamaServer: "llama-server",
});

/** Replies with a tool call while tools are offered, then with a report once they are taken away. */
function lookingAround(requests: Context[]): StreamFn {
	return (_model, context) => {
		requests.push(context);
		const content: AssistantMessage["content"] =
			context.tools && context.tools.length > 0
				? [{ type: "toolCall", id: `c${requests.length}`, name: "look", arguments: {} }]
				: [{ type: "text", text: "Report: found it in src/a.ts:12" }];
		const message: AssistantMessage = {
			role: "assistant",
			content,
			model: "sub",
			usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
			stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop",
			timestamp: 0,
		};
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason as "stop", message });
			stream.end();
		});
		return stream;
	};
}

const look: AgentTool = {
	name: "look",
	label: "look",
	description: "Look",
	parameters: { type: "object", properties: {} } as never,
	async execute() {
		return { content: [{ type: "text", text: "nothing yet" }] };
	},
};

describe("runResearch", () => {
	it("stops at the turn limit and asks for the report without tools", async () => {
		const requests: Context[] = [];
		const agent = new Agent({
			model: model("sub", 8080),
			systemPrompt: "s",
			tools: [look],
			streamFn: lookingAround(requests),
		});
		const result = await runResearch(agent, "find it", { maxTurns: 3, timeoutMs: 60_000 });
		expect(result).toEqual({ answer: "Report: found it in src/a.ts:12", stoppedBy: "turns" });
		expect(requests).toHaveLength(4);
		expect(requests.at(-1)?.tools ?? []).toEqual([]);
	});

	it("stops at the time limit", async () => {
		let clock = 0;
		const requests: Context[] = [];
		const agent = new Agent({
			model: model("sub", 8080),
			systemPrompt: "s",
			tools: [look],
			streamFn: lookingAround(requests),
		});
		agent.subscribe((event) => {
			if (event.type === "turn_end") clock += 40_000;
		});
		const result = await runResearch(agent, "find it", { maxTurns: 50, timeoutMs: 100_000 }, () => clock);
		expect(result.stoppedBy).toBe("time");
		expect(result.answer).toMatch(/^Report/);
	});
});

describe("deep_research tool", () => {
	const subagent = { model: model("MiniCPM", 8080), configPath: "/c/models.yml", timeoutMinutes: 1 };
	const tool = (script: string) =>
		createResearchTool(
			{ cwd: process.cwd(), limits: toolLimitsFor(16_384), subagent },
			{ command: () => ({ file: process.execPath, args: ["-e", script] }) },
		);

	it("returns only the report from stdout and shows stderr as progress", async () => {
		const updates: string[] = [];
		const result = await tool(
			'process.stderr.write("→ bash rg foo\\n"); process.stdout.write("The answer is in a.ts\\n")',
		).execute("1", { task: "where" }, undefined, (update) => {
			updates.push(update.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
		});
		expect(result.content).toEqual([{ type: "text", text: "The answer is in a.ts" }]);
		expect(updates.at(-1)).toBe("→ bash rg foo");
	});

	it("notes a report cut short by a limit", async () => {
		const result = await tool(
			'process.stderr.write("Stopped at the turn limit.\\n"); process.stdout.write("Partial report\\n")',
		).execute("1", { task: "where" });
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Partial report\n\n[Stopped at the turn limit. The report may be incomplete.]",
		});
	});

	it("fails with the subagent's last error lines", async () => {
		const failing = tool(
			'process.stderr.write("error: llama-server at http://127.0.0.1:8080 is serving X\\n"); process.exit(1)',
		);
		await expect(failing.execute("1", { task: "where" })).rejects.toThrow(/subagent failed:\nerror: llama-server/);
	});

	it("stops the subagent when aborted", async () => {
		const controller = new AbortController();
		const running = tool("setInterval(() => {}, 1000)").execute("1", { task: "where" }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		await expect(running).rejects.toThrow();
	});

	it("is offered only when the subagent has its own server", () => {
		expect(subagentSharesServer(model("Qwen", 8080), subagent.model)).toBe(true);
		expect(subagentSharesServer(model("Stowaway", 8081), subagent.model)).toBe(false);
		const names = createCodingTools({ cwd: "/w", limits: toolLimitsFor(16_384), acceptsImages: false, subagent }).map(
			(codingTool) => codingTool.name,
		);
		expect(names).toContain("deep_research");
	});
});
