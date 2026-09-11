import { homedir } from "node:os";
import {
	type Component,
	Container,
	Markdown,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolResult } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import type { SamplingMode } from "../config/sampling.ts";
import type { AssistantMessage, ToolCall } from "../llm/types.ts";
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

export function formatTokens(count: number): string {
	return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

export interface FooterState {
	model: LiteModel;
	mode: SamplingMode;
	cwd: string;
	/** The latest reply with token usage, for context fill and speed. */
	lastReply?: AssistantMessage;
}

/** `model · mode · ctx used/window · tok/s · cwd` */
export function formatFooter(state: FooterState): string {
	const parts = [state.model.name, state.mode];
	const usage = state.lastReply?.usage;
	if (usage && usage.promptTokens > 0) {
		const used = formatTokens(usage.promptTokens + usage.completionTokens);
		parts.push(`ctx ${used}/${formatTokens(state.model.contextWindow)}`);
	}
	const speed = state.lastReply?.timings?.predictedPerSecond;
	if (speed) parts.push(`${speed.toFixed(1)} tok/s`);
	const home = homedir();
	parts.push(state.cwd.startsWith(home) ? `~${state.cwd.slice(home.length)}` : state.cwd);
	return style.gray(` ${parts.join(" · ")}`);
}
