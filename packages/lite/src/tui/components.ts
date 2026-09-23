import { homedir } from "node:os";
import {
	type Component,
	Container,
	Markdown,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolResult } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import type { SamplingMode } from "../config/sampling.ts";
import type { AssistantMessage, ToolCall } from "../llm/types.ts";
import type { InteractionMode } from "../prompt.ts";
import { markdownTheme, style } from "./theme.ts";

/** Lines of streamed reasoning shown while the model thinks. */
const THINKING_WINDOW_LINES = 6;
/** Only the end of the reasoning is wrapped for that window, so long reasoning costs the same per frame. */
const THINKING_TAIL_CHARS = 4000;
/** Lines of command output, or of an error, shown under a tool call. */
const TOOL_PREVIEW_LINES = 6;
const DIFF_PREVIEW_LINES = 16;

/**
 * One line of text cut to the terminal width, or nothing when empty. Used for the status line and footer, which
 * change often and must never wrap.
 */
export class Line implements Component {
	private text: string;
	private cached: { width: number; lines: string[] } | undefined;

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width !== width) {
			this.cached = { width, lines: this.text ? [truncateToWidth(this.text, width)] : [] };
		}
		return this.cached.lines;
	}
}

export interface BannerOptions {
	version: string;
	cwd: string;
	modelName?: string;
	mode?: string;
}

export class BannerView implements Component {
	options: BannerOptions;
	private cached?: { width: number; lines: string[] };

	constructor(options: BannerOptions) {
		this.options = options;
	}

	setModel(modelName?: string, mode?: string): void {
		this.options.modelName = modelName;
		this.options.mode = mode;
		this.cached = undefined;
	}

	setCwd(cwd: string): void {
		this.options.cwd = cwd;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;

		const boxWidth = Math.min(width, Math.min(Math.max(40, width - 2), 62));
		const contentWidth = Math.max(0, boxWidth - 4);

		const home = homedir();
		const displayCwd = this.options.cwd.startsWith(home)
			? `~${this.options.cwd.slice(home.length)}`
			: this.options.cwd;

		const innerLines: string[] = [];

		// Title line
		const title = `${style.bold(style.cyan("⚡ Pi-Lite CLI"))} ${style.gray(`v${this.options.version}`)}`;
		innerLines.push(title);

		// Model line (ONLY if loaded by user!)
		if (this.options.modelName) {
			const modeTag = this.options.mode ? ` (${this.options.mode})` : "";
			const modelLine = `${style.dim("Model:     ")}${style.green(this.options.modelName)}${style.dim(modeTag)}`;
			innerLines.push(modelLine);
		}

		// Workspace line
		const cwdLine = `${style.dim("Workspace: ")}${style.yellow(displayCwd)}`;
		innerLines.push(cwdLine);

		// Hint line
		const hint = `${style.dim("Commands:  type ")}${style.cyan("/")}${style.dim(" for menu, ")}${style.cyan("/model")}${style.dim(" to select")}`;
		innerLines.push(hint);

		// Build the bordered box
		const top = style.cyan(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`);
		const bottom = style.cyan(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`);

		const lines: string[] = ["", top];
		for (const line of innerLines) {
			const truncated = truncateToWidth(line, contentWidth);
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
			lines.push(`${style.cyan("│")}  ${truncated}${pad}${style.cyan("│")}`);
		}
		lines.push(bottom);

		this.cached = { width, lines };
		return lines;
	}
}

export class UserView extends Container {
	constructor(text: string) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${style.bold(style.cyan("›"))} ${text}`, 1, 0));
	}
}

/**
 * An assistant message. While the model is only reasoning, it shows a small window of the latest reasoning; as soon
 * as the answer or a tool call starts, the window collapses to one line. That happens while the window is still on
 * screen, so the main-screen renderer never has to repaint scrollback.
 */
export class AssistantView implements Component {
	private message: AssistantMessage;
	private streaming: boolean;
	private readonly markdown = new Markdown("", 1, 0, markdownTheme);
	private cached: { width: number; lines: string[] } | undefined;

	constructor(message: AssistantMessage, streaming: boolean) {
		this.message = message;
		this.streaming = streaming;
	}

	update(message: AssistantMessage, streaming: boolean): void {
		this.message = message;
		this.streaming = streaming;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;
		let text = "";
		let thinking = "";
		let hasToolCalls = false;
		for (const block of this.message.content) {
			if (block.type === "text") text += block.text;
			else if (block.type === "thinking") thinking += thinking ? `\n${block.thinking}` : block.thinking;
			else hasToolCalls = true;
		}

		const lines: string[] = [];
		const reasoning = thinking.trim();
		if (reasoning) {
			const answering = text.trim().length > 0 || hasToolCalls;
			if (this.streaming && !answering) {
				lines.push(style.dim(" thinking…"));
				const tail = wrapTextWithAnsi(reasoning.slice(-THINKING_TAIL_CHARS), Math.max(10, width - 4));
				for (const line of tail.slice(-THINKING_WINDOW_LINES)) lines.push(style.dim(`   ${line}`));
			} else {
				lines.push(style.dim(` thought for ${reasoning.split(/\s+/).length} words`));
			}
		}
		const answer = text.trim();
		if (answer) {
			this.markdown.setText(answer);
			lines.push(...this.markdown.render(width));
		}
		if (this.message.stopReason === "error") {
			const error = `error: ${this.message.errorMessage ?? "unknown error"}`;
			for (const line of wrapTextWithAnsi(error, Math.max(10, width - 2))) lines.push(style.red(` ${line}`));
		} else if (this.message.stopReason === "aborted") {
			lines.push(style.dim(" aborted"));
		}
		if (lines.length > 0) lines.unshift("");
		this.cached = { width, lines };
		return lines;
	}
}

/** Terminal escapes and tabs from command output would break line-width accounting. */
function plain(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "    ").replace(/\r/g, "");
}

function resultText(result: ToolResult): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

/** What a tool call acts on, for its header line. */
export function describeToolCall(toolCall: ToolCall): string {
	const args = toolCall.arguments;
	const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
	switch (toolCall.name) {
		case "bash":
			return text("command").split("\n")[0];
		case "read": {
			const range = args.offset !== undefined || args.limit !== undefined;
			return range
				? `${text("path")} (from ${args.offset ?? 1}${args.limit ? `, ${args.limit} lines` : ""})`
				: text("path");
		}
		case "edit":
		case "write":
			return text("path") || text("file_path");
		case "web_search":
			return text("query");
		case "web_fetch":
			return text("url");
		default:
			return JSON.stringify(args);
	}
}

/** A tool call: one header line, plus a short body with live command output, an edit diff, or an error. */
export class ToolView implements Component {
	private readonly toolCall: ToolCall;
	private state: "running" | "done" | "error" = "running";
	private result: ToolResult | undefined;
	private cached: { width: number; lines: string[] } | undefined;

	constructor(toolCall: ToolCall) {
		this.toolCall = toolCall;
	}

	get finished(): boolean {
		return this.state !== "running";
	}

	setPartial(result: ToolResult): void {
		this.result = result;
		this.cached = undefined;
	}

	setResult(result: ToolResult, isError: boolean): void {
		this.result = result;
		this.state = isError ? "error" : "done";
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;
		const glyph =
			this.state === "running" ? style.yellow("…") : this.state === "done" ? style.green("✓") : style.red("✗");
		const header = ` ${glyph} ${style.bold(this.toolCall.name)} ${style.gray(plain(describeToolCall(this.toolCall)))}`;
		const lines = [truncateToWidth(header, width)];
		for (const line of this.body()) lines.push(truncateToWidth(`   ${line}`, width));
		this.cached = { width, lines };
		return lines;
	}

	private body(): string[] {
		if (!this.result) return [];
		const text = plain(resultText(this.result)).trimEnd();
		const textLines = text ? text.split("\n") : [];
		if (this.state === "error") return textLines.slice(0, TOOL_PREVIEW_LINES).map(style.red);

		switch (this.toolCall.name) {
			case "bash": {
				const shown = textLines.slice(-TOOL_PREVIEW_LINES).map(style.dim);
				const hidden = textLines.length - shown.length;
				return hidden > 0 ? [style.gray(`… ${hidden} earlier lines`), ...shown] : shown;
			}
			case "edit": {
				const diff = (this.result.details as { diff?: unknown } | undefined)?.diff;
				if (typeof diff !== "string") return textLines.map(style.dim);
				const diffLines = plain(diff).split("\n");
				const shown = diffLines
					.slice(0, DIFF_PREVIEW_LINES)
					.map((line) =>
						line.startsWith("+") ? style.green(line) : line.startsWith("-") ? style.red(line) : style.gray(line),
					);
				const hidden = diffLines.length - shown.length;
				return hidden > 0 ? [...shown, style.gray(`… ${hidden} more lines`)] : shown;
			}
			case "read":
				return this.state === "done" ? [style.gray(`${textLines.length} lines`)] : [];
			default:
				return this.state === "done" ? textLines.slice(0, TOOL_PREVIEW_LINES).map(style.dim) : [];
		}
	}
}

export interface ServeViewOptions {
	modelName: string;
	localUrl: string;
	remoteUrl: string;
	port: string;
	swapText?: string;
	/** Most lines the panel may take; fewer log lines show when it is small. Default: room for 15 log lines. */
	maxHeight?: () => number;
}

/** Log lines ServeView shows at most, and at least before it switches to its one-line header. */
const SERVE_LOG_LINES = { max: 15, min: 3 } as const;

export class ServeView implements Component {
	private readonly options: ServeViewOptions;
	private readonly logLines: string[] = [];
	private readonly maxLogs = 100;
	private swapText: string | undefined;
	private cached: { width: number; height: number; lines: string[] } | undefined;

	constructor(options: ServeViewOptions) {
		this.options = options;
		this.swapText = options.swapText;
	}

	setSwapText(text: string | undefined): void {
		if (this.swapText === text) return;
		this.swapText = text;
		this.cached = undefined;
	}

	addLogLine(line: string): void {
		this.logLines.push(line);
		if (this.logLines.length > this.maxLogs) {
			this.logLines.shift();
		}
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		const height = this.options.maxHeight?.() ?? Number.POSITIVE_INFINITY;
		if (this.cached?.width === width && this.cached.height === height) return this.cached.lines;

		const boxWidth = Math.max(20, Math.min(width, 90));
		const contentWidth = boxWidth - 4;

		const headerLines: string[] = [];
		headerLines.push(`${style.bold(style.cyan("Hosting Remote Model:"))} ${style.green(this.options.modelName)}`);
		headerLines.push(`${style.dim("Remote URL:")} ${style.bold(style.yellow(this.options.remoteUrl))}`);
		headerLines.push(`${style.dim("Local URL: ")} ${style.cyan(this.options.localUrl)}`);
		if (this.swapText) {
			headerLines.push(`${style.dim("Memory:    ")} ${this.swapText}`);
		}
		headerLines.push(
			`${style.dim("Control:   ")} Press ${style.bold(style.cyan("Esc"))} or ${style.bold(style.cyan("Ctrl+C"))} to stop server`,
		);

		const top = style.cyan(`╭${"─".repeat(boxWidth - 2)}╮`);
		const bottom = style.cyan(`╰${"─".repeat(boxWidth - 2)}╯`);

		const lines: string[] = ["", top];
		for (const hLine of headerLines) {
			const truncated = truncateToWidth(hLine, contentWidth);
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
			lines.push(`${style.cyan("│")}  ${truncated}${pad}${style.cyan("│")}`);
		}
		lines.push(bottom);
		lines.push("");
		lines.push(style.bold(style.dim("─── Live Server Logs ───────────────────────────────────────────")));

		// The panel sits above the editor and must fit on screen: lines that scroll off can only be updated by
		// redrawing the whole screen, which clears the scrollback. On a short terminal the box gives way to one line.
		let panel = lines;
		if (height - lines.length < SERVE_LOG_LINES.min) {
			const swap = this.swapText ? ` · ${this.swapText}` : "";
			panel = [
				truncateToWidth(
					`${style.cyan("Hosting")} ${style.green(this.options.modelName)} ${style.dim("·")} ${style.yellow(this.options.remoteUrl)}${swap}`,
					width,
				),
			];
		}
		const logRows = Math.max(1, Math.min(SERVE_LOG_LINES.max, height - panel.length));
		if (this.logLines.length === 0) {
			panel.push(style.dim("  Waiting for llama-server output…"));
		} else {
			for (const log of this.logLines.slice(-logRows)) {
				const shown = `  ${truncateToWidth(log, width - 4)}`;
				if (log.includes("print_timing")) panel.push(style.green(shown));
				else if (log.includes("error") || log.includes("ERR")) panel.push(style.red(shown));
				else panel.push(style.dim(shown));
			}
		}
		this.cached = { width, height, lines: panel };
		return panel;
	}
}

export function formatTokens(count: number): string {
	return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

export type AiStatus = "idle" | "thinking" | "working" | "serving";

export interface FooterState {
	model?: LiteModel;
	mode?: SamplingMode;
	interactionMode?: InteractionMode;
	aiStatus?: AiStatus;
	/** False after `/web off`. */
	web?: boolean;
	/** The model hosted with `/serve`, while it runs. */
	serving?: { modelName: string; port: string };
	cwd: string;
	/** The latest reply with token usage, for context fill and speed. */
	lastReply?: AssistantMessage;
	/** Wall time of the last finished turn, in ms. Absent until one completes. */
	lastTurnMs?: number;
}

/** `47s`, `8m 12s`, `1h 3m`. Elapsed time for the footer and the print-mode summary. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * `model · mode · [status] · ctx used/window · tok/s · took · cwd`, `serving model · port N · [serving] · cwd` while
 * hosting, or `no model · cwd`.
 */
export function formatFooter(state: FooterState): string {
	const parts: string[] = [];
	if (state.serving) {
		// The hosted model is what the server runs, whatever model is selected for prompts.
		parts.push(style.gray(`serving ${state.serving.modelName}`), style.gray(`port ${state.serving.port}`));
		parts.push(style.green("[serving]"));
	} else if (state.model) {
		parts.push(style.gray(state.model.name));
		if (state.mode) parts.push(style.gray(state.mode));

		const status: AiStatus = state.aiStatus ?? "idle";
		let statusBracket: string;
		switch (status) {
			case "thinking":
				statusBracket = style.yellow("[thinking]");
				break;
			case "working":
				statusBracket = style.cyan("[working]");
				break;
			case "serving":
				statusBracket = style.green("[serving]");
				break;
			default:
				statusBracket = style.gray("[idle]");
				break;
		}
		if (state.interactionMode && state.interactionMode !== "agent") {
			parts.push(style.yellow(`[${state.interactionMode}]`));
		}
		if (state.web === false) parts.push(style.yellow("[no web]"));
		parts.push(statusBracket);

		const usage = state.lastReply?.usage;
		if (usage && usage.promptTokens > 0) {
			const used = formatTokens(usage.promptTokens + usage.completionTokens);
			parts.push(style.gray(`ctx ${used}/${formatTokens(state.model.contextWindow)}`));
		}
		const speed = state.lastReply?.timings?.predictedPerSecond;
		if (speed) parts.push(style.gray(`${speed.toFixed(1)} tok/s`));
		if (state.lastTurnMs !== undefined) parts.push(style.gray(`took ${formatDuration(state.lastTurnMs)}`));
	} else {
		parts.push(style.gray("no model"));
	}
	const home = homedir();
	const displayCwd = state.cwd.startsWith(home) ? `~${state.cwd.slice(home.length)}` : state.cwd;
	parts.push(style.gray(displayCwd));
	return ` ${parts.join(style.gray(" · "))}`;
}
