import { setTimeout as delay } from "node:timers/promises";
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
import { getLocalIpAddress, type LlamaServerManager, serverOrigin, serverPort } from "../llm/server.ts";
import {
	DEFAULT_SWAP_THRESHOLD_BYTES,
	formatGigabytes,
	readSwapUsage,
	SwapGuard,
	SwapMonitor,
} from "../llm/swap-monitor.ts";
import { userText } from "../llm/text.ts";
import type { AssistantMessage, Message } from "../llm/types.ts";
import type { InteractionMode } from "../prompt.ts";
import {
	type LoadedSession,
	listSessions,
	loadSession,
	recordSession,
	resolveSessionPath,
	SessionFile,
	type SessionSettings,
} from "../session.ts";
import { createToolsForModel } from "../tools/index.ts";
import { type CommandName, parseCommand, resolveMode, slashCommands } from "./commands.ts";
import {
	type AiStatus,
	AssistantView,
	BannerView,
	formatDuration,
	formatFooter,
	formatTokens,
	Line,
	ServeView,
	ToolView,
	UserView,
} from "./components.ts";
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
	model?: LiteModel;
	mode?: SamplingMode;
	cwd: string;
	manager: LlamaServerManager;
	/** Session to continue, from `--continue` or `--session`. */
	session?: LoadedSession;
	/** False with `--no-session`. */
	saveSessions: boolean;
	/** Open the session picker at startup (`--resume`). */
	pickSession: boolean;
	/** Model to host on startup (`--serve`). */
	serveModel?: string;
	/** Maximum swap memory in bytes before triggering auto-reclaim. */
	maxSwapBytes?: number;
	version?: string;
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
	/**
	 * The live `/serve` panel. It sits below the transcript, with the status line and editor, because its log lines
	 * change constantly: in the transcript they would scroll above the screen, where updating them clears scrollback.
	 */
	private readonly servePanel = new Container();
	private readonly status = new Line();
	private readonly editorSlot = new Container();
	private readonly footer = new Line();
	private readonly editor: Editor;
	private readonly agent: Agent;
	private banner: BannerView | undefined;
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
	private aiStatus: AiStatus = "idle";
	private isServing = false;
	/** The hosted model and port, for the footer. */
	private serving: { modelName: string; port: string } | undefined;
	/** When the current `/serve` began, for the summary line once it stops. */
	private servedSince: { at: number; modelName: string; url: string } | undefined;
	private serveAbortController: AbortController | undefined;
	private swapMonitor: SwapMonitor | undefined;
	/**
	 * Frees the model's memory between agent turns when swap passes `--max-swap`. Only with that flag: in ordinary
	 * work other applications are the likelier cause of swap. Serving guards memory either way.
	 */
	private readonly swapGuard: SwapGuard | undefined;
	/** The cooldown after the swap guard stops the server; esc skips it. */
	private swapCooldown: AbortController | undefined;
	/** A running `/compact`; esc cancels it. */
	private compactRun: AbortController | undefined;
	/** Serializes llama-server startups, so a model switch and a prompt never start two servers. */
	private serverTask: Promise<boolean> = Promise.resolve(true);
	private serverStart: AbortController | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private picking = false;
	private stopped = false;
	private finish = () => {};

	constructor(options: InteractiveOptions) {
		this.options = options;
		const { model, cwd } = options;
		this.swapGuard = options.maxSwapBytes === undefined ? undefined : new SwapGuard(options.maxSwapBytes);
		const mode = options.mode ?? (model ? defaultSamplingMode(model) : "thinking");
		this.agent = new Agent({
			model,
			mode,
			cwd,
			interactionMode: options.session?.settings?.interactionMode,
			web: options.session?.settings?.web,
			tools: model ? createToolsForModel(model, cwd, this.toolOptions()) : [],
			messages: options.session?.messages,
		});
		if (options.saveSessions && model) {
			const settings = this.sessionSettings(model);
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
		this.tui.addChild(this.servePanel);
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
			this.notice(style.gray(this.resumedNotice(this.options.session.header.id)));
		}
		this.updateFooter();
		if (this.options.pickSession) this.pickSession();
		else if (this.options.serveModel !== undefined) {
			this.serveModel(this.options.serveModel);
		}

		await done;
		process.removeListener("exit", restoreTerminal);
		await Promise.race([this.agent.waitForIdle(), new Promise((resolve) => setTimeout(resolve, 2000))]);
	}

	// Input

	private onInput(data: string): TuiInputListenerResult {
		// The picker handles its own navigation, confirm, and cancel keys.
		if (this.picking) return undefined;
		// While serving, esc and ctrl+c stop the server; exit and the mode switch work as usual.
		if (this.isServing && (matchesAction(data, "abort") || matchesAction(data, "interrupt"))) {
			void this.stopServe();
			return { consume: true };
		}
		const working =
			this.agent.isRunning ||
			this.serverStart !== undefined ||
			this.swapCooldown !== undefined ||
			this.compactRun !== undefined;
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
		} else if (this.isServing) {
			this.notice(style.yellow("Currently serving a model. Press esc to stop serving before sending prompts."));
		} else if (!this.agent.model) {
			this.editor.setText(input);
			this.notice(style.yellow("No model loaded. Please select a model with /model"));
			this.pickModel();
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
		this.swapCooldown?.abort();
		this.compactRun?.abort();
		this.serveAbortController?.abort();
		this.swapMonitor?.stop();
		this.swapMonitor = undefined;
		this.setAiStatus("idle");
	}

	private setAiStatus(status: AiStatus): void {
		if (this.aiStatus === status) return;
		this.aiStatus = status;
		this.updateFooter();
	}

	private async runPrompt(input: string): Promise<void> {
		if (!this.agent.model) {
			this.notice(style.yellow("No model loaded. Please select a model with /model"));
			this.pickModel();
			return;
		}
		this.busy = true;
		try {
			let next: string | undefined = input;
			while (next !== undefined) {
				if (!(await this.ensureServer())) {
					this.restoreQueued(next);
					break;
				}
				this.setStatus("working");
				this.setAiStatus(this.agent.mode === "thinking" ? "thinking" : "working");
				const turnStarted = Date.now();
				await this.agent.prompt(next);
				this.lastTurnMs = Date.now() - turnStarted;
				this.setStatus(undefined);
				this.setAiStatus("idle");
				this.updateFooter();

				await this.checkSwapAndRecycleIfNeeded();

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
			this.setAiStatus("idle");
		}
	}

	private async checkSwapAndRecycleIfNeeded(): Promise<void> {
		const guard = this.swapGuard;
		if (!guard || this.isServing) return;
		if (!this.options.manager.ownsServer || !this.agent.model) return;

		const threshold = guard.thresholdBytes;
		const usage = await readSwapUsage();
		if (!usage || !guard.shouldRecycle(usage)) return;

		const limitStr = formatGigabytes(threshold);
		this.notice(
			style.yellow(
				`[Memory Guard] Swap threshold exceeded (${formatGigabytes(usage.usedBytes)} >= ${limitStr}). Stopping the server to reclaim memory.`,
			),
		);
		const cooldown = new AbortController();
		this.swapCooldown = cooldown;
		try {
			await this.options.manager.stop();
			this.setStatus("Reclaiming swap memory (15s cooldown)…");
			await delay(15_000, undefined, { signal: cooldown.signal }).catch(() => {});
		} finally {
			this.swapCooldown = undefined;
		}
		const postUsage = await readSwapUsage();
		const postStr = postUsage ? ` (swap now ${formatGigabytes(postUsage.usedBytes)})` : "";
		if (guard.recycled(postUsage)) {
			this.notice(
				style.yellow(
					`[Memory Guard] Server stopped${postStr}. Swap stays over ${limitStr} from other applications, so the guard pauses until it drops.`,
				),
			);
		} else {
			this.notice(style.gray(`[Memory Guard] Server stopped${postStr}. It restarts with the next message.`));
		}
		this.setStatus(undefined);
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
		const model = this.agent.model;
		if (!model) return Promise.resolve(false);
		this.serverTask = this.serverTask.then(() => (this.agent.model ? this.startServer(this.agent.model) : false));
		return this.serverTask;
	}

	private async startServer(model: LiteModel): Promise<boolean> {
		const controller = new AbortController();
		this.serverStart = controller;
		this.setAiStatus("working");
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
			if (!this.agent.isRunning) {
				this.setStatus(undefined);
				this.setAiStatus("idle");
			}
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
					this.setAiStatus(this.agent.mode === "thinking" ? "thinking" : "working");
				}
				break;
			case "message_update":
				this.streamingView?.update(event.message, true);
				if (event.event.type === "thinking_start" || event.event.type === "thinking_delta") {
					this.setAiStatus("thinking");
				} else if (
					event.event.type === "text_start" ||
					event.event.type === "text_delta" ||
					event.event.type === "toolcall_start" ||
					event.event.type === "toolcall_delta"
				) {
					this.setAiStatus("working");
				}
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
				this.setAiStatus("working");
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
			case "agent":
			case "plan":
			case "chat":
				this.switchInteractionMode(name);
				return;
			case "web":
				this.switchWeb(args);
				return;
			case "model":
				if (args) this.switchModel(args);
				else this.pickModel();
				return;
			case "serve":
				this.serveModel(args);
				return;
			case "disconnect":
				void this.disconnectServer();
				return;
			case "compact":
				void this.manualCompact(args);
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

	/**
	 * Tool settings that follow the session. web_fetch reaches local addresses only in agent mode: in plan and chat
	 * modes the web tools are all the model has, and a page must not be able to steer it into the local network.
	 */
	private toolOptions(): { allowLocalNetwork: () => boolean } {
		return { allowLocalNetwork: () => this.agent.interactionMode === "agent" };
	}

	/** What the session file records: the model, its sampling mode, and the interaction mode. */
	private sessionSettings(model: LiteModel): SessionSettings {
		return {
			model: model.name,
			mode: this.agent.mode,
			interactionMode: this.agent.interactionMode,
			...(this.agent.web ? {} : { web: false }),
		};
	}

	private resumedNotice(id: string): string {
		const mode = this.agent.interactionMode;
		const inMode = mode === "agent" ? "" : ` in ${mode} mode`;
		return `Resumed session ${id.slice(0, 8)}${inMode}${this.agent.web ? "" : ", web off"}.`;
	}

	/** `/web on`, `/web off`, or `/web` to switch. Applies from the next request; the session file records it. */
	private switchWeb(arg: string): void {
		const choice = arg.trim().toLowerCase();
		if (choice && choice !== "on" && choice !== "off") {
			this.notice(style.yellow("Use /web on, /web off, or /web to switch."));
			return;
		}
		const web = choice ? choice === "on" : !this.agent.web;
		if (web === this.agent.web) {
			this.notice(style.gray(`Web tools are already ${web ? "on" : "off"}.`));
			return;
		}
		this.agent.setWeb(web);
		if (this.agent.model) this.session?.updateSettings(this.sessionSettings(this.agent.model));
		const note = this.agent.isRunning ? " (from the next message)" : "";
		this.notice(
			style.gray(web ? `Web tools on${note}.` : `Web tools off${note}: the model cannot search or fetch pages.`),
		);
		this.updateFooter();
	}

	private switchInteractionMode(mode: InteractionMode): void {
		if (this.agent.interactionMode === mode) {
			this.notice(style.gray(`Already in ${mode} mode.`));
			return;
		}
		this.agent.setInteractionMode(mode);
		if (this.agent.model) this.session?.updateSettings(this.sessionSettings(this.agent.model));
		const note = this.agent.isRunning ? " (from the next message)" : "";
		this.notice(style.gray(`Switched to ${mode} mode${note}.`));
		this.updateFooter();
	}

	private async manualCompact(args: string): Promise<void> {
		if (!this.requireIdle()) return;
		if (this.agent.messages.length === 0) {
			this.notice(style.gray("Transcript is empty; nothing to compact."));
			return;
		}

		let threshold = 0.5;
		if (args) {
			const parsed = parseFloat(args);
			if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
				threshold = parsed;
			}
		}

		// Prompts typed meanwhile wait in `pending`; esc cancels.
		this.busy = true;
		const controller = new AbortController();
		this.compactRun = controller;
		try {
			// Jev runs on the model's own server, so load it first. Without it, the heuristic decides.
			if (this.agent.model) await this.ensureServer();
			if (controller.signal.aborted) throw new Error("Compaction cancelled.");
			this.setStatus("Compacting context…");
			const res = await this.agent.compact({ keepThreshold: threshold, signal: controller.signal });
			const how =
				res.fallbackReason !== undefined
					? `heuristic, because ${res.fallbackReason}`
					: res.askedCalls === 0
						? "no older calls to evaluate"
						: `Jev decided ${res.askedCalls} call${res.askedCalls === 1 ? "" : "s"}`;
			if (res.compactedCalls === 0) {
				this.notice(
					style.dim(`No tool calls compacted (${how}; context is ~${formatTokens(res.estimatedTokens)} tokens).`),
				);
			} else {
				this.notice(
					style.green(
						`Compacted ${res.compactedCalls} tool call${res.compactedCalls === 1 ? "" : "s"} ` +
							`(${how}; freed ~${formatTokens(res.tokensSaved)} tokens; context is now ~${formatTokens(res.estimatedTokens)} tokens).`,
					),
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notice(
				controller.signal.aborted
					? style.gray("Compaction cancelled.")
					: style.red(`Compaction failed: ${message}`),
			);
		} finally {
			this.compactRun = undefined;
			this.busy = false;
			this.setStatus(undefined);
			this.updateFooter();
		}
		if (this.pending.length > 0) {
			const next = this.pending.join("\n\n");
			this.pending = [];
			void this.runPrompt(next);
		}
	}

	/** Commands that replace the model, transcript, or session must wait for the current request. */
	private requireIdle(): boolean {
		if (this.isServing) {
			this.notice(style.yellow("Currently serving a model. Press esc to stop serving first."));
			return false;
		}
		if (!this.busy && !this.agent.isRunning) return true;
		this.notice(style.yellow("Wait for the current request to finish, or press esc to abort it."));
		return false;
	}

	private async disconnectServer(): Promise<void> {
		if (this.isServing) {
			await this.stopServe();
			return;
		}
		if (!this.requireIdle()) return;
		const { manager } = this.options;
		if (!this.agent.model && !manager.model) {
			this.notice(style.gray("No active model or server to disconnect."));
			return;
		}
		this.setStatus("Disconnecting…");
		this.serverStart?.abort();
		// Stop only once the aborted load has cleaned up, so the two never stop the server at the same time.
		await this.serverTask;
		// stop() ends a server pi-lite started and only forgets one it attached to, so say which happened.
		const owned = manager.ownsServer;
		const attachedTo = !owned && manager.model ? serverOrigin(manager.model.baseUrl) : undefined;
		await manager.stop();
		this.agent.model = undefined;
		this.agent.tools = [];
		this.lastReply = undefined;
		this.lastTurnMs = undefined;
		this.setAiStatus("idle");
		// The banner is at the top; rewriting it once the transcript has grown would redraw the whole screen.
		if (this.chat.children.length === 1) this.banner?.setModel(undefined, undefined);
		if (owned) {
			this.notice(style.gray("Disconnected: llama-server stopped."));
		} else if (attachedTo) {
			this.notice(
				style.gray(
					`Disconnected. The llama-server at ${attachedTo} was running before pi-lite and is still running.`,
				),
			);
		} else {
			this.notice(style.gray("Disconnected: model unloaded."));
		}
		this.setStatus(undefined);
		this.updateFooter();
	}

	private switchMode(arg: string): void {
		const mode = resolveMode(this.agent.mode, arg);
		if (!mode) {
			this.notice(style.red("/mode takes thinking or instruct."));
			return;
		}
		this.agent.mode = mode;
		if (this.agent.model) {
			this.session?.updateSettings(this.sessionSettings(this.agent.model));
			writeLastUsed(getAppDir(), { model: this.agent.model.name, mode });
		}
		const note = this.agent.isRunning ? " (from the next message)" : "";
		this.notice(style.gray(`Mode: ${mode}${note}`));
		this.updateFooter();
		if (this.chat.children.length === 1) {
			this.banner?.setModel(this.agent.model?.name, mode);
		}
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
		if (model.name === this.agent.model?.name) {
			this.notice(style.gray(`Already using ${model.name}.`));
			return;
		}
		this.agent.model = model;
		this.agent.mode = defaultSamplingMode(model);
		this.agent.tools = createToolsForModel(model, this.options.cwd, this.toolOptions());
		this.lastReply = undefined;
		this.lastTurnMs = undefined;
		if (this.options.saveSessions && !this.session) {
			this.session = SessionFile.create(this.appDir, this.options.cwd, this.sessionSettings(model));
		} else {
			this.session?.updateSettings(this.sessionSettings(model));
		}
		writeLastUsed(getAppDir(), { model: model.name, mode: this.agent.mode });
		this.notice(style.gray(`Model: ${model.name} (${this.agent.mode})`));
		this.updateFooter();
		if (this.chat.children.length === 1) {
			this.banner?.setModel(model.name, this.agent.mode);
		}
		void this.ensureServer();
	}

	private pickModel(): void {
		const current = this.agent.model?.name;
		const items = this.options.config.models.map((model) => ({
			value: model.name,
			label: current && model.name === current ? `${model.name} (current)` : model.name,
			description: `${defaultSamplingMode(model)} · ctx ${formatTokens(model.contextWindow)}`,
		}));
		this.pick(current ? "Switch model" : "Select model", items, (name) => {
			const model = findModel(this.options.config.models, name);
			if (model) this.applyModel(model);
		});
	}

	private serveModel(query?: string): void {
		if (this.isServing) {
			this.notice(style.yellow("Already serving. Press esc to stop serving first."));
			return;
		}
		if (!this.requireIdle()) return;

		const models = this.options.config.models;
		if (models.length === 0) {
			this.notice(style.red("No models found in models.yml to serve."));
			return;
		}

		const trimmed = query?.trim();
		if (trimmed) {
			const model = findModel(models, trimmed);
			if (model) {
				void this.startServe(model);
				return;
			}
			const names = models.map((m) => m.name).join(", ");
			this.notice(style.red(`No model matches "${trimmed}". Models: ${names}`));
			return;
		}

		const items: SelectItem[] = models.map((model) => ({
			value: model.name,
			label: model.name,
			description: `${defaultSamplingMode(model)} · ctx ${formatTokens(model.contextWindow)} · port ${serverPort(model.baseUrl)}`,
		}));
		this.pick("Select model to serve", items, (name) => {
			const model = findModel(models, name);
			if (model) void this.startServe(model);
		});
	}

	private async startServe(model: LiteModel): Promise<void> {
		this.isServing = true;
		this.setAiStatus("serving");
		const controller = new AbortController();
		this.serveAbortController = controller;
		// A model load still in progress would stop the server started here once its abort lands. Let it finish first.
		this.serverStart?.abort();
		await this.serverTask;
		if (controller.signal.aborted) return;
		const port = serverPort(model.baseUrl);
		this.serving = { modelName: model.name, port };
		const localIp = getLocalIpAddress();
		const thresholdBytes = this.options.maxSwapBytes ?? DEFAULT_SWAP_THRESHOLD_BYTES;

		const remoteUrl = `http://${localIp}:${port}/v1`;
		const serveView = new ServeView({
			modelName: model.name,
			port,
			localUrl: `http://localhost:${port}/v1`,
			remoteUrl,
			// Leave room for the status line, the editor, and the footer below the panel.
			maxHeight: () => this.tui.terminal.rows - 6,
		});
		this.servePanel.addChild(serveView);
		this.servedSince = { at: Date.now(), modelName: model.name, url: remoteUrl };
		this.setStatus(`Starting host server for ${model.name}…`, "esc to stop");
		this.updateFooter();
		this.tui.requestRender();

		const startHostServer = async () => {
			await this.options.manager.startHost(
				model,
				(line) => {
					serveView.addLogLine(line);
					this.tui.requestRender();
				},
				this.serveAbortController?.signal,
			);
			this.setStatus(`Serving ${model.name} on http://${localIp}:${port}/v1`, "esc to stop");
		};

		this.swapMonitor?.stop();
		this.swapMonitor = new SwapMonitor({
			thresholdBytes,
			pollIntervalMs: 5000,
			onSample: (usage) => {
				const usedStr = formatGigabytes(usage.usedBytes);
				const limitStr = formatGigabytes(thresholdBytes);
				const isHigh = usage.usedBytes >= thresholdBytes * 0.8;
				const styleColor = usage.usedBytes >= thresholdBytes ? style.red : isHigh ? style.yellow : style.dim;
				serveView.setSwapText(styleColor(`Swap: ${usedStr} / ${limitStr} limit`));
				this.tui.requestRender();
			},
			onThresholdExceeded: async (usage) => {
				if (!this.isServing || this.serveAbortController?.signal.aborted) return;
				const usedStr = formatGigabytes(usage.usedBytes);
				const limitStr = formatGigabytes(thresholdBytes);

				serveView.addLogLine(`[Memory Guard] Swap threshold exceeded (${usedStr} >= ${limitStr}).`);
				serveView.addLogLine("[Memory Guard] Waiting for in-flight requests to finish…");
				this.setStatus("Swap threshold exceeded · waiting for in-flight requests to finish…", "esc to stop");

				const isIdle = await this.options.manager.waitForIdle(60_000, this.serveAbortController?.signal);
				if (this.serveAbortController?.signal.aborted) return;
				if (!isIdle) {
					serveView.addLogLine("[Memory Guard] Timed out waiting for active requests. Forcing stop…");
				}

				serveView.addLogLine("[Memory Guard] Stopping server to reclaim swap…");
				this.setStatus("Stopping server to reclaim swap…", "esc to stop");
				await this.options.manager.stop();
				if (this.serveAbortController?.signal.aborted) return;

				serveView.addLogLine("[Memory Guard] Pausing 15s for macOS to deallocate swapfiles…");
				this.setStatus("Reclaiming swap memory (15s cooldown)…", "esc to stop");
				try {
					await delay(15_000, undefined, { signal: this.serveAbortController?.signal });
				} catch {
					return;
				}
				if (this.serveAbortController?.signal.aborted) return;

				const postUsage = await readSwapUsage();
				const postStr = postUsage ? formatGigabytes(postUsage.usedBytes) : "unknown";
				serveView.addLogLine(`[Memory Guard] Swap after recycle: ${postStr}. Restarting host server…`);
				this.setStatus(`Restarting host server (swap: ${postStr})…`, "esc to stop");

				try {
					await startHostServer();
					serveView.addLogLine("[Memory Guard] Server restarted successfully and ready for requests.");
					if (postUsage && postUsage.usedBytes >= thresholdBytes) {
						serveView.addLogLine(
							`[Memory Guard] Notice: Swap remains at ${postStr} from other applications. Auto-recycle paused until swap drops.`,
						);
					} else {
						this.swapMonitor?.resume();
					}
				} catch (err) {
					if (!this.serveAbortController?.signal.aborted) {
						const msg = errorText(err);
						serveView.addLogLine(`[Memory Guard] Error restarting server: ${msg}`);
						this.notice(style.red(`Failed to restart server: ${msg}`));
					}
				}
			},
			onRecovered: (usage) => {
				serveView.addLogLine(
					`[Memory Guard] Swap dropped back to ${formatGigabytes(usage.usedBytes)}. Memory guard re-armed.`,
				);
			},
		});

		try {
			// Swap is system-wide. If other applications already hold more than the limit, recycling the new server
			// would only reload it, so the guard starts paused until swap drops.
			const initialSwap = await readSwapUsage();
			const alreadyOver = initialSwap !== undefined && initialSwap.usedBytes >= thresholdBytes;
			await startHostServer();
			if (alreadyOver) {
				serveView.addLogLine(
					`[Memory Guard] Swap is already ${formatGigabytes(initialSwap.usedBytes)} (limit ${formatGigabytes(thresholdBytes)}) from other applications. Guard paused until it drops.`,
				);
			}
			this.swapMonitor.start({ paused: alreadyOver });
		} catch (err) {
			this.swapMonitor.stop();
			this.swapMonitor = undefined;
			if (!this.serveAbortController?.signal.aborted) {
				const msg = errorText(err);
				serveView.addLogLine(`Error starting server: ${msg}`);
				this.notice(style.red(`Failed to serve ${model.name}: ${msg}`));
			}
			this.isServing = false;
			this.serving = undefined;
			this.servePanel.clear();
			this.servedSince = undefined;
			this.setAiStatus("idle");
			this.serveAbortController = undefined;
			this.setStatus(undefined);
			this.updateFooter();
			this.tui.requestRender();
		}
	}

	private async stopServe(): Promise<void> {
		if (!this.isServing) return;
		this.swapMonitor?.stop();
		this.swapMonitor = undefined;
		this.setStatus("Stopping host server…");
		this.serveAbortController?.abort();
		await this.options.manager.stop();
		this.isServing = false;
		this.serving = undefined;
		// The live panel goes; one line in the transcript records what was served.
		this.servePanel.clear();
		const served = this.servedSince;
		this.servedSince = undefined;
		this.setAiStatus("idle");
		this.serveAbortController = undefined;
		this.setStatus(undefined);
		this.notice(
			style.gray(
				served
					? `Served ${served.modelName} on ${served.url} for ${formatDuration(Date.now() - served.at)}. Host server stopped.`
					: "Host server stopped.",
			),
		);
		this.updateFooter();
		this.tui.requestRender();
	}

	/** `/new`, also reached as `/clear`, `/cls`, and `/reset`. */
	private newSession(): void {
		if (!this.requireIdle()) return;
		this.agent.setMessages([]);
		this.lastReply = undefined;
		this.lastTurnMs = undefined;
		this.setAiStatus("idle");
		// The interaction mode and web setting belong to a session, so a new one starts in agent mode with web on.
		const leftMode = this.agent.interactionMode !== "agent";
		if (leftMode) this.agent.setInteractionMode("agent");
		const webBack = !this.agent.web;
		if (webBack) this.agent.setWeb(true);
		if (this.options.saveSessions && this.agent.model) {
			this.session = SessionFile.create(this.appDir, this.options.cwd, this.sessionSettings(this.agent.model));
		} else {
			this.session = undefined;
		}
		this.resetTranscript();
		const back = [leftMode ? "agent mode" : "", webBack ? "web tools on" : ""].filter(Boolean).join(", ");
		this.notice(style.gray(back ? `New session. Back to ${back}.` : "New session."));
		this.updateFooter();
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
		const modelChanged = model?.name !== this.agent.model?.name;

		this.agent.setMessages(loaded.messages);
		this.agent.model = model;
		this.agent.mode = savedModel && saved ? saved.mode : this.agent.mode;
		this.agent.setInteractionMode(saved?.interactionMode ?? "agent");
		this.agent.setWeb(saved?.web ?? true);
		if (model && modelChanged) this.agent.tools = createToolsForModel(model, this.options.cwd, this.toolOptions());
		if (this.options.saveSessions && model) {
			this.session = SessionFile.resume(loaded, this.sessionSettings(model));
		}
		this.lastReply = lastReplyWithUsage(loaded.messages);

		this.resetTranscript();
		this.showTranscript(loaded.messages);
		this.notice(style.gray(this.resumedNotice(loaded.header.id)));
		if (saved && !savedModel)
			this.notice(style.yellow(`Saved model ${saved.model} is not in models.yml; using ${model?.name ?? "none"}.`));
		if (modelChanged && model) void this.ensureServer();
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
		this.banner = new BannerView({
			version: this.options.version ?? "0.0.1",
			cwd: this.options.cwd,
			modelName: this.agent.model?.name,
			mode: this.agent.model ? this.agent.mode : undefined,
		});
		this.chat.addChild(this.banner);
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
	/** @param hint what esc does now, shown after the elapsed time. */
	private setStatus(label: string | undefined, hint = "esc to abort"): void {
		clearInterval(this.statusTimer);
		this.statusTimer = undefined;
		if (!label) {
			this.status.setText("");
			this.tui.requestRender();
			return;
		}
		const started = Date.now();
		const paint = () => {
			const elapsed = formatDuration(Math.floor((Date.now() - started) / 1000) * 1000);
			const queued = this.pending.length + this.agent.queuedMessages.length;
			const extra = queued > 0 ? ` · ${queued} queued` : "";
			this.status.setText(`${style.yellow(` ● ${label} ${elapsed}`)}${style.gray(` · ${hint}${extra}`)}`);
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
				interactionMode: this.agent.interactionMode,
				web: this.agent.web,
				serving: this.serving,
				aiStatus: this.aiStatus,
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
		if (this.isServing) {
			void this.stopServe();
		}
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
