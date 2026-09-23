import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import type { AssistantMessage, ToolCall } from "../src/llm/types.ts";
import { parseCommand, resolveMode, slashCommands } from "../src/tui/commands.ts";
import {
	AssistantView,
	BannerView,
	describeToolCall,
	formatFooter,
	formatSessionDate,
	formatTokens,
	Line,
	ServeView,
	ToolView,
} from "../src/tui/components.ts";
import { accent, logoColors, renderLogo } from "../src/tui/logo.ts";

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

	it("describes web_search and web_fetch tool calls", () => {
		expect(
			describeToolCall({ type: "toolCall", id: "c4", name: "web_search", arguments: { query: "hello world" } }),
		).toBe("hello world");
		expect(
			describeToolCall({ type: "toolCall", id: "c5", name: "web_fetch", arguments: { url: "https://example.com" } }),
		).toBe("https://example.com");
	});
});

describe("Line and footer", () => {
	it("cuts a line to the width and renders nothing when empty", () => {
		const line = new Line("a".repeat(100));
		expect(visibleWidth(line.render(20)[0])).toBeLessThanOrEqual(20);
		line.setText("");
		expect(line.render(20)).toEqual([]);
	});

	it("shows model, mode, status, context fill, and speed, but not the directory", () => {
		const reply = assistant([], {
			usage: { promptTokens: 5000, cachedTokens: 4800, completionTokens: 300 },
			timings: { promptPerSecond: 900, predictedPerSecond: 21.46 },
		});
		expect(formatFooter({ model, mode: "thinking", lastReply: reply }).replace(/\x1b\[\d+m/g, "")).toBe(
			" Qwen-27B · thinking · [idle] · ctx 5.3k/12.3k · 21.5 tok/s",
		);
		expect(
			formatFooter({ model, mode: "thinking", aiStatus: "thinking", lastReply: reply }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · thinking · [thinking] · ctx 5.3k/12.3k · 21.5 tok/s");
		expect(
			formatFooter({ model, mode: "thinking", aiStatus: "working", lastReply: reply }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · thinking · [working] · ctx 5.3k/12.3k · 21.5 tok/s");
		expect(
			formatFooter({ model, mode: "thinking", interactionMode: "plan", lastReply: reply }).replace(
				/\x1b\[\d+m/g,
				"",
			),
		).toBe(" Qwen-27B · thinking · [plan] · [idle] · ctx 5.3k/12.3k · 21.5 tok/s");
		expect(
			formatFooter({ model, mode: "thinking", interactionMode: "chat", lastReply: reply }).replace(
				/\x1b\[\d+m/g,
				"",
			),
		).toBe(" Qwen-27B · thinking · [chat] · [idle] · ctx 5.3k/12.3k · 21.5 tok/s");
		expect(
			formatFooter({ model, mode: "thinking", aiStatus: "serving", lastReply: reply }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · thinking · [serving] · ctx 5.3k/12.3k · 21.5 tok/s");
		expect(formatFooter({}).replace(/\x1b\[\d+m/g, "")).toBe(" no model");
		expect(
			formatFooter({ model, mode: "instruct", interactionMode: "plan", web: false }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · instruct · [plan] · [no web] · [idle]");
		expect(formatFooter({ model, mode: "instruct", rag: true }).replace(/\x1b\[\d+m/g, "")).toBe(
			" Qwen-27B · instruct · [rag] · [idle]",
		);
		// While hosting, the footer names the served model, with or without a model selected for prompts.
		const serving = { modelName: "Qwen-27B-host", port: "18555" };
		for (const selected of [undefined, model]) {
			expect(formatFooter({ model: selected, mode: "thinking", serving }).replace(/\x1b\[\d+m/g, "")).toBe(
				" serving Qwen-27B-host · port 18555 · [serving]",
			);
		}
		// After /compact, the estimate stands in for the last measured size until the next reply.
		expect(
			formatFooter({ model, mode: "thinking", lastReply: reply, contextTokens: 4321 }).replace(/\x1b\[\d+m/g, ""),
		).toBe(" Qwen-27B · thinking · [idle] · ctx ~4.3k/12.3k · 21.5 tok/s");
		expect(formatTokens(999)).toBe("999");
	});
});

describe("commands", () => {
	it("recognizes known commands with arguments and leaves other slash text as messages", () => {
		expect(parseCommand("/agent")).toEqual({ name: "agent", args: "" });
		expect(parseCommand("/plan")).toEqual({ name: "plan", args: "" });
		expect(parseCommand("/rag on")).toEqual({ name: "rag", args: "on" });
		expect(parseCommand("/chat")).toEqual({ name: "chat", args: "" });
		expect(parseCommand("/model  qwen 27b ")).toEqual({ name: "model", args: "qwen 27b" });
		expect(parseCommand("/models")).toEqual({ name: "model", args: "" });
		expect(parseCommand("/serve")).toEqual({ name: "serve", args: "" });
		expect(parseCommand("/serve  qwen 27b ")).toEqual({ name: "serve", args: "qwen 27b" });
		expect(parseCommand("/host")).toEqual({ name: "serve", args: "" });
		expect(parseCommand("/disconnect")).toEqual({ name: "disconnect", args: "" });
		expect(parseCommand("/stop")).toEqual({ name: "disconnect", args: "" });
		// /new, /cls, and /reset are the same command as /clear.
		expect(parseCommand("/clear")).toEqual({ name: "clear", args: "" });
		expect(parseCommand("/reset")).toEqual({ name: "clear", args: "" });
		expect(parseCommand("/cls")).toEqual({ name: "clear", args: "" });
		expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
		expect(parseCommand("/compact 0.7")).toEqual({ name: "compact", args: "0.7" });
		expect(parseCommand("/compress")).toEqual({ name: "compact", args: "" });
		expect(parseCommand("/prune")).toEqual({ name: "compact", args: "" });
		expect(parseCommand("/new")).toEqual({ name: "clear", args: "" });
		expect(parseCommand("/web")).toEqual({ name: "web", args: "" });
		expect(parseCommand("/web off")).toEqual({ name: "web", args: "off" });
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
		const serveCommand = commands.find((command) => command.name === "serve");
		expect(await modelCommand?.getArgumentCompletions?.("27")).toEqual([{ value: "Qwen-27B", label: "Qwen-27B" }]);
		expect(await modeCommand?.getArgumentCompletions?.("in")).toEqual([{ value: "instruct", label: "instruct" }]);
		expect(await serveCommand?.getArgumentCompletions?.("27")).toEqual([{ value: "Qwen-27B", label: "Qwen-27B" }]);
	});
});

describe("BannerView", () => {
	const recent = [
		{ when: "today 3:05 AM", label: "Compare Opus 5.5 and GPT-6 Astra" },
		{ when: "yesterday 9:12 PM", label: "Fix the failing highlight tests" },
		{ when: "Sep 20", label: "toolbar phase" },
		{ when: "Sep 19", label: "fourth" },
		{ when: "Sep 18", label: "fifth" },
		{ when: "Sep 17", label: "sixth" },
	];
	const banner = (extra: Partial<ConstructorParameters<typeof BannerView>[0]> = {}) =>
		new BannerView({ version: "1.0.0", cwd: "/srv/app", modelName: "Qwen-27B", mode: "thinking", recent, ...extra });

	it("puts the logo and model on the left, and commands, workspace, and sessions on the right", () => {
		const lines = plainLines(banner(), 100);
		expect(lines[0]).toBe("");
		expect(lines[1]).toMatch(/^╭─ pi-lite v1\.0\.0 ─+╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		const body = lines.slice(2, -1);
		expect(body.every((line) => /^│.{24}│ .* │$/.test(line))).toBe(true);
		expect(body.some((line) => /^│ +Qwen-27B +│/.test(line))).toBe(true);
		// Right column: after "│" + 24 columns + "│ ", before " │".
		const right = body.map((line) => line.slice(27, -2).trimEnd());
		expect(right.slice(0, 9)).toEqual([
			"Commands",
			"/ for the command menu · /model to pick a model",
			"/resume to continue a session · /name to name this one",
			expect.stringMatching(/^─+/),
			"Workspace",
			"/srv/app",
			expect.stringMatching(/^─+/),
			"Recent sessions",
			"1  today 3:05 AM      Compare Opus 5.5 and GPT-6 Astra",
		]);
		// Five sessions fit beside the logo; the sixth is left for /resume.
		expect(right.filter((line) => /^\d {2}/.test(line)).map((line) => line[0])).toEqual(["1", "2", "3", "4", "5"]);
		// Every line is the box's width, so its edges line up.
		expect(new Set(lines.slice(1).map((line) => visibleWidth(line))).size).toBe(1);
	});

	it("follows omp's colors: a gray frame, plain version text, and sky-blue headings", () => {
		const raw = banner().render(100);
		expect(raw[1].startsWith("\x1b[90m╭─\x1b[39m pi-lite v1.0.0 \x1b[90m─")).toBe(true);
		expect(raw[2].startsWith("\x1b[90m│\x1b[39m")).toBe(true);
		const commands = raw.find((line) => line.includes("Commands")) ?? "";
		expect(commands).toContain(`\x1b[1m${accent("Commands")}\x1b[22m`);
		expect(accent("x", "truecolor")).toBe("\x1b[38;2;79;168;240mx\x1b[39m");
		expect(accent("x", "256")).toMatch(/^\x1b\[38;5;\d+mx\x1b\[39m$/);
		expect(accent("x", "none")).toBe("x");
	});

	it("keeps three sessions and one column on a narrow terminal", () => {
		const lines = plainLines(banner(), 60);
		expect(lines.some((line) => /[▀▄█]/.test(line))).toBe(false);
		expect(lines.filter((line) => /│ {2}\d {2}/.test(line))).toHaveLength(3);
		expect(lines.some((line) => line.includes("Workspace: /srv/app"))).toBe(true);
	});

	it("says so when this workspace has no saved sessions, and no model is loaded", () => {
		const lines = plainLines(banner({ recent: [], modelName: undefined, mode: undefined }), 100);
		expect(lines.some((line) => line.includes("No saved sessions in this workspace yet"))).toBe(true);
		expect(lines.some((line) => /^│ +no model +│/.test(line))).toBe(true);
	});

	it("updates when setModel and setCwd are called", () => {
		const view = banner({ modelName: undefined });
		view.setModel("New-Model", "instruct");
		view.setCwd("/srv/other");
		const lines = plainLines(view, 100);
		expect(lines.some((line) => /^│ +New-Model +│/.test(line))).toBe(true);
		expect(lines.some((line) => line.includes("/srv/other"))).toBe(true);
	});

	it("never exceeds terminal width", () => {
		const view = banner({
			cwd: "/a/very/long/path/that/might/exceed/terminal/width/easily/on/a/narrow/terminal/and/more",
			modelName: "VeryLongModelName-ExtraLong-Reasoning-Special",
			recent: [{ when: "yesterday 11:59 PM", label: "x".repeat(200) }],
		});
		for (const w of [30, 40, 50, 60, 71, 72, 80, 100, 160]) {
			for (const line of view.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
		}
		// A long path keeps its end, where the project's name is.
		expect(plainLines(view, 80).some((line) => line.includes("…") && line.includes("/and/more"))).toBe(true);
	});

	it("describes when a session was used", () => {
		const now = new Date(2026, 8, 23, 15, 0);
		const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
		const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m);
		expect(formatSessionDate(at(23, 3, 5), now)).toBe(`today ${time(at(23, 3, 5))}`);
		expect(formatSessionDate(at(22, 21, 12), now)).toBe(`yesterday ${time(at(22, 21, 12))}`);
		expect(formatSessionDate(at(19, 8, 0), now)).toMatch(new RegExp(`^\\S+ ${time(at(19, 8, 0))}$`));
		expect(formatSessionDate(at(10, 8, 0), now)).toBe(
			at(10, 8, 0).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
		);
		expect(formatSessionDate(new Date(2025, 8, 10), now)).toContain("2025");
	});
});

describe("logo", () => {
	it("is 12 lines of 14 columns in any color mode", () => {
		for (const colors of ["truecolor", "256", "none"] as const) {
			const lines = renderLogo(colors);
			expect(lines).toHaveLength(12);
			for (const line of lines) expect(visibleWidth(line)).toBe(14);
		}
	});

	it("uses 24-bit color only when the terminal says so, and no color with NO_COLOR", () => {
		expect(logoColors({ COLORTERM: "truecolor" })).toBe("truecolor");
		expect(logoColors({ COLORTERM: "24bit" })).toBe("truecolor");
		expect(logoColors({})).toBe("256");
		expect(logoColors({ COLORTERM: "truecolor", NO_COLOR: "1" })).toBe("none");
		expect(renderLogo("truecolor").join("")).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
		expect(renderLogo("256").join("")).toMatch(/\x1b\[38;5;\d+m/);
		expect(renderLogo("none").join("")).not.toContain("\x1b");
	});
});

describe("ServeView", () => {
	it("renders boxed serve view with URLs and instruction", () => {
		const serve = new ServeView({
			modelName: "test-model",
			port: "8080",
			localUrl: "http://localhost:8080/v1",
			remoteUrl: "http://192.168.1.10:8080/v1",
		});
		const lines = plainLines(serve, 80);
		expect(lines[0]).toBe("");
		expect(lines[1]).toContain("╭");
		expect(lines.some((line) => line.includes("Hosting Remote Model: test-model"))).toBe(true);
		expect(lines.some((line) => line.includes("Remote URL: http://192.168.1.10:8080/v1"))).toBe(true);
		expect(lines.some((line) => line.includes("Local URL:  http://localhost:8080/v1"))).toBe(true);
		expect(lines.some((line) => line.includes("Press Esc or Ctrl+C to stop server"))).toBe(true);
		expect(lines.some((line) => line.includes("╰"))).toBe(true);
		expect(lines.some((line) => line.includes("Live Server Logs"))).toBe(true);
	});

	it("appends and renders log lines", () => {
		const serve = new ServeView({
			modelName: "test-model",
			port: "8080",
			localUrl: "http://localhost:8080/v1",
			remoteUrl: "http://192.168.1.10:8080/v1",
		});
		serve.addLogLine("HTTP server listening on 0.0.0.0:8080");
		serve.addLogLine("slot prompt evaluation: 15 tok/s");
		const lines = plainLines(serve, 80);
		expect(lines.some((line) => line.includes("HTTP server listening on 0.0.0.0:8080"))).toBe(true);
		expect(lines.some((line) => line.includes("slot prompt evaluation: 15 tok/s"))).toBe(true);
	});

	it("fits its maximum height by showing fewer log lines, down to three", () => {
		let maxHeight = 20;
		const serve = new ServeView({
			modelName: "test-model",
			port: "8080",
			localUrl: "http://localhost:8080/v1",
			remoteUrl: "http://192.168.1.10:8080/v1",
			maxHeight: () => maxHeight,
		});
		for (let i = 1; i <= 40; i++) serve.addLogLine(`log ${i}`);
		const logs = () => plainLines(serve, 80).filter((line) => line.startsWith("  log "));

		expect(plainLines(serve, 80)).toHaveLength(20);
		expect(logs().at(-1)).toBe("  log 40");
		maxHeight = 100;
		expect(logs()).toHaveLength(15);
		// Too short for the box: one header line, then as many log lines as fit.
		maxHeight = 8;
		const compact = plainLines(serve, 80);
		expect(compact).toHaveLength(8);
		expect(compact[0]).toBe("Hosting test-model · http://192.168.1.10:8080/v1");
		expect(logs()).toHaveLength(7);
	});

	it("renders memory swap text when set", () => {
		const serve = new ServeView({
			modelName: "test-model",
			port: "8080",
			localUrl: "http://localhost:8080/v1",
			remoteUrl: "http://192.168.1.10:8080/v1",
		});
		serve.setSwapText("Swap: 0.5 GB / 4.5 GB limit");
		const lines = plainLines(serve, 80);
		expect(lines.some((line) => line.includes("Memory:     Swap: 0.5 GB / 4.5 GB limit"))).toBe(true);
	});
});
