import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type KeyId,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	Text,
	type TuiInputListenerResult,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Agent } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/types.ts";
import { writeLastUsed } from "../config/last-used.ts";
import { findModel, type LiteModel, type ModelsConfig } from "../config/models.ts";
import { getAppDir } from "../config/paths.ts";
import { defaultSamplingMode, type SamplingMode } from "../config/sampling.ts";
import { describeTrim } from "../context.ts";
import type { LlamaServerManager } from "../llm/server.ts";
import { userText } from "../llm/text.ts";
import type { AssistantMessage, Message } from "../llm/types.ts";
import { buildSystemPrompt } from "../prompt.ts";
import {
	type LoadedSession,
	listSessions,
	loadSession,
	recordSession,
	resolveSessionPath,
	SessionFile,
} from "../session.ts";
import { createToolsForModel } from "../tools/index.ts";
import { COMMANDS, type CommandName, parseCommand, resolveMode, slashCommands } from "./commands.ts";
import { AssistantView, formatFooter, formatTokens, Line, ToolView, UserView } from "./components.ts";
import { editorTheme, selectListTheme, style } from "./theme.ts";

export type AppAction = "abort" | "interrupt" | "exit" | "toggleMode";

/** Keys for app-level actions. All app key checks go through this table, so it is the one place to change them. */
export const APP_KEYBINDINGS: Readonly<Record<AppAction, readonly KeyId[]>> = {
	/** Abort the running request. When idle, Escape goes to the editor (for example to close autocomplete). */
	abort: ["escape"],
	/** Abort when busy, clear the editor when it has text, otherwise exit. */
	interrupt: ["ctrl+c"],
	/** Exit when idle and the editor is empty. */
	exit: ["ctrl+d"],
	toggleMode: ["shift+tab"],
};

function matchesAction(data: string, action: AppAction): boolean {
	return APP_KEYBINDINGS[action].some((key) => matchesKey(data, key));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatAge(date: Date): string {
	const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
	return `${Math.round(minutes / (60 * 24))}d ago`;
}

function lastReplyWithUsage(messages: readonly Message[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.usage.promptTokens > 0) return message;
	}
	return undefined;
}

export interface InteractiveOptions {
	config: ModelsConfig;
	model: LiteModel;
	mode: SamplingMode;
	cwd: string;
	manager: LlamaServerManager;
	/** Session to continue, from `--continue` or `--session`. */
	session?: LoadedSession;
	/** False with `--no-session`. */
	saveSessions: boolean;
	/** Open the session picker at startup (`--resume`). */
	pickSession: boolean;
}

/**
 * The interactive terminal UI, rendered on the main screen so the terminal (or tmux) keeps ownership of scrollback.
 * The transcript only ever grows at the bottom; the lines that change while working are the streaming message, the
 * status line, the editor, and the footer.
 */
class InteractiveApp {
	private readonly options: InteractiveOptions;
	private readonly appDir = getAppDir();
	private readonly tui = new TuiMainScreen(new ProcessTerminal());
	private readonly chat = new Container();
	private readonly status = new Line();
	private readonly editorSlot = new Container();
	private readonly footer = new Line();
	private readonly editor: Editor;
	private readonly agent: Agent;
	private session: SessionFile | undefined;
	private lastReply: AssistantMessage | undefined;
	/** Wall time of the last finished turn, shown in the footer. */
	private lastTurnMs: number | undefined;
	private streamingView: AssistantView | undefined;
	private readonly toolViews = new Map<string, ToolView>();
	/** Messages typed while llama-server was starting, sent once the current prompt finishes. */
	private pending: string[] = [];
	/** True from submitting a prompt until the agent and its follow-ups finish. */
	private busy = false;
	/** Serializes llama-server startups, so a model switch and a prompt never start two servers. */
	private serverTask: Promise<boolean> = Promise.resolve(true);
	private serverStart: AbortController | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private picking = false;
	private stopped = false;
	private finish = () => {};

	constructor(options: InteractiveOptions) {
		this.options = options;
		const { model, mode, cwd } = options;
		this.agent = new Agent({
			model,
			mode,
			systemPrompt: buildSystemPrompt({ cwd }),
			tools: createToolsForModel(model, cwd),
			messages: options.session?.messages,
		});
		if (options.saveSessions) {
			const settings = { model: model.name, mode };
			this.session = options.session
				? SessionFile.resume(options.session, settings)
				: SessionFile.create(this.appDir, cwd, settings);
		}
		this.lastReply = options.session ? lastReplyWithUsage(options.session.messages) : undefined;
		recordSession(this.agent, () => this.session);
		this.agent.subscribe((event) => this.onAgentEvent(event));

		this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(options.config.models), cwd));
		this.editor.onSubmit = (text) => this.submit(text);
		this.editorSlot.addChild(this.editor);

		this.tui.addChild(this.chat);
		this.tui.addChild(this.status);
		this.tui.addChild(this.editorSlot);
		this.tui.addChild(this.footer);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => this.onInput(data));
	}

	async run(): Promise<void> {
		const done = new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		// A signal-driven exit skips stop(); leave the terminal usable anyway.
		const restoreTerminal = () => this.stopTerminal();
		process.once("exit", restoreTerminal);

		this.tui.terminal.setTitle("pi-lite");
		this.tui.start();
		this.showHeader();
		if (this.options.session) {
			this.showTranscript(this.options.session.messages);
			this.notice(style.gray(`Resumed session ${this.options.session.header.id.slice(0, 8)}.`));
		}
		this.updateFooter();
		if (this.options.pickSession) this.pickSession();
		// Load the model right away, so the first prompt does not wait for it.
		void this.ensureServer();

		await done;
		process.removeListener("exit", restoreTerminal);
		await Promise.race([this.agent.waitForIdle(), new Promise((resolve) => setTimeout(resolve, 2000))]);
	}

	// Input

	private onInput(data: string): TuiInputListenerResult {
		// The picker handles its own navigation, confirm, and cancel keys.
		if (this.picking) return undefined;
		const working = this.agent.isRunning || this.serverStart !== undefined;
		if (matchesAction(data, "abort") && working) {
			this.abort();
			return { consume: true };
		}
		if (matchesAction(data, "interrupt")) {
			if (working) this.abort();
			else if (this.editor.getText()) this.editor.setText("");
			else this.stop();
			return { consume: true };
		}
		// Exiting aborts a running request or model load, so it works whenever the editor is empty.
		if (matchesAction(data, "exit") && !this.editor.getText()) {
			this.stop();
			return { consume: true };
		}
		if (matchesAction(data, "toggleMode")) {
			this.runCommand("mode", "");
			return { consume: true };
		}
		return undefined;
	}

	private submit(text: string): void {
		this.editor.setText("");
		const input = text.trim();
		if (!input) return;
		this.editor.addToHistory(input);

		const command = parseCommand(input);
		if (command) {
			this.runCommand(command.name, command.args);
		} else if (this.agent.isRunning) {
			this.agent.enqueue(input);
			this.notice(style.gray(`queued: ${input}`));
		} else if (this.busy) {
			this.pending.push(input);
			this.notice(style.gray(`queued: ${input}`));
		} else {
			void this.runPrompt(input);
		}
	}

	private abort(): void {
		this.agent.abort();
		this.serverStart?.abort();
	}

	private async runPrompt(input: string): Promise<void> {
		this.busy = true;
		try {
			let next: string | undefined = input;
			while (next !== undefined) {
				if (!(await this.ensureServer())) {
					this.restoreQueued(next);
					break;
				}
				this.setStatus("working");
				const turnStarted = Date.now();
				await this.agent.prompt(next);
				this.lastTurnMs = Date.now() - turnStarted;
				this.setStatus(undefined);
				this.updateFooter();

				const queued = [...this.pending, ...this.agent.takeQueued().map(userText)];
				this.pending = [];
				if (queued.length === 0) break;
				const last = this.agent.messages.at(-1);
				if (last?.role === "assistant" && last.stopReason === "aborted") {
					// Do not run queued messages after an abort; hand them back for editing.
					this.restoreQueued(queued.join("\n\n"));
					break;
				}
				next = queued.join("\n\n");
			}
		} finally {
			this.busy = false;
			this.setStatus(undefined);
		}
	}

	private restoreQueued(text: string): void {
		const queued = [text, ...this.pending].filter(Boolean).join("\n\n");
		this.pending = [];
		if (!queued) return;
		const current = this.editor.getText();
		this.editor.setText(current ? `${queued}\n\n${current}` : queued);
		this.tui.requestRender();
	}

	// llama-server

	/** Make the current model's server ready, after any startup already in progress. False if it failed or was aborted. */
	private ensureServer(): Promise<boolean> {
		this.serverTask = this.serverTask.then(() => this.startServer(this.agent.model));
		return this.serverTask;
	}

	private async startServer(model: LiteModel): Promise<boolean> {
		const controller = new AbortController();
		this.serverStart = controller;
		try {
			await this.options.manager.ensure(model, {
				signal: controller.signal,
				onStatus: (message) => this.setStatus(message),
			});
			return true;
		} catch (error) {
			this.notice(
				controller.signal.aborted
					? style.gray("Model loading aborted.")
					: style.red(`llama-server: ${errorText(error)}`),
			);
			return false;
		} finally {
			this.serverStart = undefined;
			if (!this.agent.isRunning) this.setStatus(undefined);
		}
	}

	// Agent events

	private onAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "user") {
					this.chat.addChild(new UserView(userText(event.message)));
				} else if (event.message.role === "assistant") {
					this.streamingView = new AssistantView(event.message, true);
					this.chat.addChild(this.streamingView);
				}
				break;
			case "message_update":
				this.streamingView?.update(event.message, true);
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.streamingView?.update(event.message, false);
					this.streamingView = undefined;
					if (event.message.usage.promptTokens > 0) this.lastReply = event.message;
					this.updateFooter();
				}
				break;
			case "tool_execution_start": {
				const view = new ToolView(event.toolCall);
				this.toolViews.set(event.toolCall.id, view);
				this.chat.addChild(view);
				break;
			}
			case "tool_execution_update":
				this.toolViews.get(event.toolCall.id)?.setPartial(event.partial);
				break;
			case "tool_execution_end":
				this.toolViews.get(event.toolCall.id)?.setResult(event.result, event.isError);
				this.toolViews.delete(event.toolCall.id);
				break;
			case "context_trimmed":
				this.notice(style.gray(`[${describeTrim(event)}]`));
				break;
			default:
				return;
		}
		this.tui.requestRender();
	}

	// Commands

	private runCommand(name: CommandName, args: string): void {
		switch (name) {
			case "model":
				if (args) this.switchModel(args);
				else this.pickModel();
				return;
			case "mode":
				this.switchMode(args);
				return;
			case "new":
				this.newSession();
				return;
			case "resume":
				if (args) this.resumeById(args);
				else this.pickSession();
				return;
			case "quit":
				this.stop();
				return;
		}
	}

	/** Commands that replace the model, transcript, or session must wait for the current request. */
	private requireIdle(): boolean {
		if (!this.busy && !this.agent.isRunning) return true;
		this.notice(style.yellow("Wait for the current request to finish, or press esc to abort it."));
		return false;
	}

	private switchMode(arg: string): void {
		const mode = resolveMode(this.agent.mode, arg);
		if (!mode) {
			this.notice(style.red("/mode takes thinking or instruct."));
			return;
		}
		this.agent.mode = mode;
		this.session?.updateSettings({ model: this.agent.model.name, mode });
		writeLastUsed(getAppDir(), { model: this.agent.model.name, mode });
		const note = this.agent.isRunning ? " (from the next message)" : "";
		this.notice(style.gray(`Mode: ${mode}${note}`));
		this.updateFooter();
	}

	private switchModel(query: string): void {
		const model = findModel(this.options.config.models, query);
		if (model) {
			this.applyModel(model);
			return;
		}
		const names = this.options.config.models.map((candidate) => candidate.name).join(", ");
		this.notice(style.red(`No model matches "${query}". Models: ${names}`));
	}

	private applyModel(model: LiteModel): void {
		if (!this.requireIdle()) return;
		if (model.name === this.agent.model.name) {
			this.notice(style.gray(`Already using ${model.name}.`));
			return;
		}
		this.agent.model = model;
		this.agent.mode = defaultSamplingMode(model);
		this.agent.tools = createToolsForModel(model, this.options.cwd);
		this.lastReply = undefined;
		this.lastTurnMs = undefined;
		this.session?.updateSettings({ model: model.name, mode: this.agent.mode });
		writeLastUsed(getAppDir(), { model: model.name, mode: this.agent.mode });
		this.notice(style.gray(`Model: ${model.name} (${this.agent.mode})`));
		this.updateFooter();
		void this.ensureServer();
	}

	private pickModel(): void {
		const current = this.agent.model.name;
		const items = this.options.config.models.map((model) => ({
			value: model.name,
			label: model.name === current ? `${model.name} (current)` : model.name,
			description: `${defaultSamplingMode(model)} · ctx ${formatTokens(model.contextWindow)}`,
		}));
		this.pick("Switch model", items, (name) => {
			const model = findModel(this.options.config.models, name);
			if (model) this.applyModel(model);
		});
	}

	private newSession(): void {
		if (!this.requireIdle()) return;
		this.agent.setMessages([]);
		this.lastReply = undefined;
		this.lastTurnMs = undefined;
		if (this.options.saveSessions) {
			this.session = SessionFile.create(this.appDir, this.options.cwd, {
				model: this.agent.model.name,
				mode: this.agent.mode,
			});
		}
		this.resetTranscript();
		this.notice(style.gray("New session."));
	}

	private pickSession(): void {
		if (!this.requireIdle()) return;
		const sessions = listSessions(this.appDir, this.options.cwd).filter((session) => session.id !== this.session?.id);
		if (sessions.length === 0) {
			this.notice(style.gray("No saved sessions for this directory."));
			return;
		}
		const items = sessions.slice(0, 50).map((session) => ({
			value: session.path,
			label: session.preview || "(no messages)",
			description: `${formatAge(session.modified)} · ${session.id.slice(0, 8)}`,
		}));
		this.pick("Resume session", items, (path) => this.resumePath(path));
	}

	private resumeById(query: string): void {
		const path = resolveSessionPath(this.appDir, this.options.cwd, query);
		if (path) this.resumePath(path);
		else this.notice(style.red(`No unique saved session matches "${query}".`));
	}

	private resumePath(path: string): void {
		if (!this.requireIdle()) return;
		let loaded: LoadedSession;
		try {
			loaded = loadSession(path);
		} catch (error) {
			this.notice(style.red(errorText(error)));
			return;
		}
		const saved = loaded.settings;
		const savedModel = saved ? findModel(this.options.config.models, saved.model) : undefined;
		const model = savedModel ?? this.agent.model;
		const modelChanged = model.name !== this.agent.model.name;

		this.agent.setMessages(loaded.messages);
		this.agent.model = model;
		this.agent.mode = savedModel && saved ? saved.mode : this.agent.mode;
		if (modelChanged) this.agent.tools = createToolsForModel(model, this.options.cwd);
		if (this.options.saveSessions) {
			this.session = SessionFile.resume(loaded, { model: model.name, mode: this.agent.mode });
		}
		this.lastReply = lastReplyWithUsage(loaded.messages);

		this.resetTranscript();
		this.showTranscript(loaded.messages);
		this.notice(style.gray(`Resumed session ${loaded.header.id.slice(0, 8)}.`));
		if (saved && !savedModel)
			this.notice(style.yellow(`Saved model ${saved.model} is not in models.yml; using ${model.name}.`));
		if (modelChanged) void this.ensureServer();
	}

	/** Temporarily put a picker where the editor is. */
	private pick(title: string, items: SelectItem[], onSelect: (value: string) => void): void {
		const list = new SelectList(items, Math.min(items.length, 10), selectListTheme, { maxPrimaryColumnWidth: 72 });
		const close = () => {
			this.picking = false;
			this.editorSlot.clear();
			this.editorSlot.addChild(this.editor);
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		list.onSelect = (item) => {
			close();
			onSelect(item.value);
		};
		list.onCancel = close;
		this.picking = true;
		this.editorSlot.clear();
		this.editorSlot.addChild(new Text(style.bold(title), 1, 0));
		this.editorSlot.addChild(list);
		this.tui.setFocus(list);
		this.tui.requestRender();
	}

	// Rendering

	private showHeader(): void {
		const commands = COMMANDS.map((command) => `/${command.name}`).join(" ");
		this.chat.addChild(new Text(style.gray(`pi-lite · ${commands} · esc aborts · shift+tab switches mode`), 1, 0));
	}

	/** Replace the transcript. This redraws the whole screen, so it is used only for /new and /resume. */
	private resetTranscript(): void {
		this.chat.clear();
		this.toolViews.clear();
		this.streamingView = undefined;
		this.showHeader();
		this.updateFooter();
		this.tui.requestRender(true);
	}

	private showTranscript(messages: readonly Message[]): void {
		const toolViews = new Map<string, ToolView>();
		for (const message of messages) {
			if (message.role === "user") {
				this.chat.addChild(new UserView(userText(message)));
			} else if (message.role === "assistant") {
				this.chat.addChild(new AssistantView(message, false));
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const view = new ToolView(block);
					toolViews.set(block.id, view);
					this.chat.addChild(view);
				}
			} else {
				toolViews
					.get(message.toolCallId)
					?.setResult({ content: message.content, details: message.details }, message.isError);
			}
		}
		for (const view of toolViews.values()) {
			if (!view.finished) view.setResult({ content: [{ type: "text", text: "(no result recorded)" }] }, true);
		}
		this.tui.requestRender();
	}

	private notice(text: string): void {
		this.chat.addChild(new Text(text, 1, 0));
		this.tui.requestRender();
	}

	/** Show a status above the editor, with elapsed seconds repainted once per second. */
	private setStatus(label: string | undefined): void {
		clearInterval(this.statusTimer);
		this.statusTimer = undefined;
		if (!label) {
			this.status.setText("");
			this.tui.requestRender();
			return;
		}
		const started = Date.now();
		const paint = () => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			const queued = this.pending.length + this.agent.queuedMessages.length;
			const extra = queued > 0 ? ` · ${queued} queued` : "";
			this.status.setText(`${style.yellow(` ● ${label} ${seconds}s`)}${style.gray(` · esc to abort${extra}`)}`);
			this.tui.requestRender();
		};
		paint();
		this.statusTimer = setInterval(paint, 1000);
	}

	private updateFooter(): void {
		this.footer.setText(
			formatFooter({
				model: this.agent.model,
				mode: this.agent.mode,
				cwd: this.options.cwd,
				lastReply: this.lastReply,
				lastTurnMs: this.lastTurnMs,
			}),
		);
		this.tui.requestRender();
	}

	private stop(): void {
		if (this.stopped) return;
		this.abort();
		// Leave the final frame on screen as it is now (for example with the submitted /quit cleared).
		this.status.setText("");
		this.tui.renderNow();
		this.stopTerminal();
		this.finish();
	}

	private stopTerminal(): void {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.statusTimer);
		this.tui.stop();
	}
}

/** Run the interactive UI until the user quits. The caller stops llama-server afterwards. */
export async function runInteractive(options: InteractiveOptions): Promise<void> {
	await new InteractiveApp(options).run();
}
