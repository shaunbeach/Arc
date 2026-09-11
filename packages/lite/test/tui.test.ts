import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import type { AssistantMessage, ToolCall } from "../src/llm/types.ts";
import { parseCommand, resolveMode, slashCommands } from "../src/tui/commands.ts";
import { AssistantView, formatFooter, formatTokens, Line, ToolView } from "../src/tui/components.ts";

const WIDTH = 60;
const plainLines = (component: { render(width: number): string[] }, width = WIDTH) =>
	component.render(width).map((line) => stripTerminalSequences(line).trimEnd());

const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content,
	model: "m",
	usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
	stopReason: "stop",
	timestamp: 0,
	...extra,
});

const model: LiteModel = {
	name: "Qwen-27B",
	id: "q.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 12_288,
	maxTokens: 4096,
	modelPath: "/m/q.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};

describe("AssistantView", () => {
	const reasoning = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join("\n");

	it("shows a window with the latest reasoning while the model only thinks", () => {
		const view = new AssistantView(assistant([{ type: "thinking", thinking: reasoning }]), true);
		expect(plainLines(view)).toEqual([
			"",
			" thinking…",
			"   step 15",
			"   step 16",
			"   step 17",
			"   step 18",
			"   step 19",
			"   step 20",
		]);
	});

	it("collapses the reasoning to one line as soon as the answer starts", () => {
		const view = new AssistantView(assistant([{ type: "thinking", thinking: reasoning }]), true);
		view.render(WIDTH);
		view.update(
			assistant([
				{ type: "thinking", thinking: reasoning },
				{ type: "text", text: "The **answer**." },
			]),
			true,
		);
		expect(plainLines(view)).toEqual(["", " thought for 40 words", " The answer."]);
	});

	it("reports errors and aborts", () => {
		expect(
			plainLines(new AssistantView(assistant([], { stopReason: "error", errorMessage: "boom" }), false)),
		).toEqual(["", " error: boom"]);
		expect(plainLines(new AssistantView(assistant([], { stopReason: "aborted" }), false))).toEqual(["", " aborted"]);
	});

	it("renders nothing for a message with only tool calls", () => {
		const call: ToolCall = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } };
		expect(new AssistantView(assistant([call]), false).render(WIDTH)).toEqual([]);
	});
});

describe("ToolView", () => {
	const bash: ToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "seq 1 10" } };
	const output = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n");

	it("shows the tail of live command output, then the final result", () => {
		const view = new ToolView(bash);
		expect(plainLines(view)).toEqual([" … bash seq 1 10"]);
		view.setPartial({ content: [{ type: "text", text: "1\n2" }] });
		expect(plainLines(view)).toEqual([" … bash seq 1 10", "   1", "   2"]);
		view.setResult({ content: [{ type: "text", text: `\x1b[31m${output}\x1b[0m` }] }, false);
		expect(plainLines(view)).toEqual([
			" ✓ bash seq 1 10",
			"   … 4 earlier lines",
			"   5",
			"   6",
			"   7",
			"   8",
			"   9",
			"   10",
		]);
	});

	it("shows an edit's diff and a failed call's error", () => {
		const edit = new ToolView({ type: "toolCall", id: "c2", name: "edit", arguments: { path: "f.ts" } });
		edit.setResult(
			{ content: [{ type: "text", text: "Edited f.ts at line 2." }], details: { diff: " 1 a\n-2 b\n+2 B" } },
			false,
		);
		expect(plainLines(edit)).toEqual([" ✓ edit f.ts", "    1 a", "   -2 b", "   +2 B"]);

		const failed = new ToolView({ type: "toolCall", id: "c3", name: "read", arguments: { path: "nope" } });
		failed.setResult({ content: [{ type: "text", text: "Not found: nope" }] }, true);
		expect(plainLines(failed)).toEqual([" ✗ read nope", "   Not found: nope"]);
	});

	it("never renders a line wider than the terminal", () => {
		const view = new ToolView({ ...bash, arguments: { command: "x".repeat(500) } });
		view.setResult({ content: [{ type: "text", text: "y".repeat(500) }] }, false);
		for (const line of view.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("Line and footer", () => {
	it("cuts a line to the width and renders nothing when empty", () => {
		const line = new Line("a".repeat(100));
		expect(visibleWidth(line.render(20)[0])).toBeLessThanOrEqual(20);
		line.setText("");
		expect(line.render(20)).toEqual([]);
	});

	it("shows model, mode, context fill, speed, and directory", () => {
		const reply = assistant([], {
			usage: { promptTokens: 5000, cachedTokens: 4800, completionTokens: 300 },
			timings: { promptPerSecond: 900, predictedPerSecond: 21.46 },
		});
		expect(
			formatFooter({ model, mode: "thinking", cwd: "/srv/app", lastReply: reply }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · thinking · ctx 5.3k/12.3k · 21.5 tok/s · /srv/app");
		expect(formatTokens(999)).toBe("999");
	});
});

describe("commands", () => {
	it("recognizes known commands with arguments and leaves other slash text as messages", () => {
		expect(parseCommand("/model  qwen 27b ")).toEqual({ name: "model", args: "qwen 27b" });
		expect(parseCommand("/exit")).toEqual({ name: "quit", args: "" });
		expect(parseCommand("/tmp/build.log shows an error")).toBeUndefined();
		expect(parseCommand("/unknown")).toBeUndefined();
		expect(parseCommand("fix /model")).toBeUndefined();
	});

	it("toggles the mode or sets a named one", () => {
		expect(resolveMode("thinking", "")).toBe("instruct");
		expect(resolveMode("instruct", "")).toBe("thinking");
		expect(resolveMode("thinking", "Instruct")).toBe("instruct");
		expect(resolveMode("thinking", "fast")).toBeUndefined();
	});

	it("completes model names and modes", async () => {
		const commands = slashCommands([model]);
		const modelCommand = commands.find((command) => command.name === "model");
		const modeCommand = commands.find((command) => command.name === "mode");
		expect(await modelCommand?.getArgumentCompletions?.("27")).toEqual([{ value: "Qwen-27B", label: "Qwen-27B" }]);
		expect(await modeCommand?.getArgumentCompletions?.("in")).toEqual([{ value: "instruct", label: "instruct" }]);
	});
});
