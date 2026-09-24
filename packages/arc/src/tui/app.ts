import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
import { findModel, type LiteModel, type ModelsConfig, modelLabel } from "../config/models.ts";
import { getAppDir } from "../config/paths.ts";
import { defaultSamplingMode, type SamplingMode } from "../config/sampling.ts";
import { describeTrim } from "../context.ts";
import { fetchServerProps, resolveDiscoveredModel, type ServerProps } from "../llm/discover.ts";
import { getLocalIpAddress, type LlamaServerManager, serverOrigin, serverPort } from "../llm/server.ts";
import {
	DEFAULT_SWAP_THRESHOLD_BYTES,
	describeMemory,
	formatGigabytes,
	readSwapUsage,
	SwapGuard,
	SwapMonitor,
	underPressure,
} from "../llm/swap-monitor.ts";
import { userText } from "../llm/text.ts";
import type { AssistantMessage, Message } from "../llm/types.ts";
import { isPonytailLevel, PONYTAIL_LEVEL_RULES, PONYTAIL_LEVELS } from "../ponytail.ts";
import type { InteractionMode } from "../prompt.ts";
import { KiwixKnowledgeBase } from "../rag/kiwix.ts";
import {
	type LoadedSession,
	listSessions,
	loadSession,
	matchSession,
	recordSession,
	SessionFile,
	type SessionSettings,
	type SessionSummary,
	sessionLabel,
} from "../session.ts";
import { asCritic } from "../supervisor/critic.ts";
import { isClean, isGitRepo } from "../supervisor/git.ts";
import { RepeatGuard } from "../supervisor/guard.ts";
import { PlanError } from "../supervisor/plan.ts";
import {
	type ActorOutcome,
	type ActorResult,
	readPlan,
	Supervisor,
	type SupervisorHost,
	type SupervisorState,
	startState,
} from "../supervisor/supervisor.ts";
import { type CodingToolOptions, createToolsForModel } from "../tools/index.ts";
import { formatUsage, tallyUsage } from "../usage.ts";
import { type CommandName, parseCommand, resolveMode, slashCommands } from "./commands.ts";
import {
	type AiStatus,
	AssistantView,
	BANNER_RECENT,
	BannerView,
	formatDuration,
	formatFooter,
	formatSessionDate,
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
	/** The archives `/rag` searches, when models.yml has a `rag:` section. kiwix-serve starts on first use. */
	private readonly knowledgeBase: KiwixKnowledgeBase | undefined;
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
	/** The current session's `/name`, if any. */
	private sessionName: string | undefined;
	private lastReply: AssistantMessage | undefined;
	/** The prompt size `/compact` estimated, shown in the footer until the next reply measures it. */
	private contextEstimate: number | undefined;
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
	/** The session's `/supervise` loop, running or not. */
	private supervisor: Supervisor | undefined;
	/** The running `/supervise` loop; esc stops it. */
	private supervisorRun: AbortController | undefined;
	/** A critic named with `/audit <model>`, used instead of models.yml's until the loop stops. */
	private criticOverride: string | undefined;
	/** Serializes llama-server startups, so a model switch and a prompt never start two servers. */
	private serverTask: Promise<boolean> = Promise.resolve(true);
	private serverStart: AbortController | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private picking = false;
	private stopped = false;
	private finish = () => {};
	/** The mode to keep when a `discover` entry connects: one picked on the command line, in a session, or before a reconnect. */
	private connectMode: SamplingMode | undefined;

	constructor(options: InteractiveOptions) {
		this.options = options;
		const { model, cwd } = options;
		this.swapGuard = options.maxSwapBytes === undefined ? undefined : new SwapGuard(options.maxSwapBytes);
		const rag = options.config.rag;
		if (rag) {
			const knowledgeBase = new KiwixKnowledgeBase(rag, { logFile: join(this.appDir, "logs", "kiwix-serve.log") });
			this.knowledgeBase = knowledgeBase;
			process.once("exit", () => knowledgeBase.stop());
		}
		const mode = options.mode ?? (model ? defaultSamplingMode(model) : "thinking");
		if (model?.discover) this.connectMode = options.mode;
		this.agent = new Agent({
			model,
			mode,
			cwd,
			interactionMode: options.session?.settings?.interactionMode,
			web: options.session?.settings?.web,
			rag: rag !== undefined && options.session?.settings?.rag === true,
			ponytail: options.session?.settings?.ponytail,
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
		this.sessionName = options.session?.name;
		this.supervisor = this.restoredSupervisor(options.session?.supervisor);
		this.contextEstimate = undefined;
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

		this.tui.terminal.setTitle("Arc");
		this.tui.start();
		this.showHeader();
		if (this.options.session) {
			this.showTranscript(this.options.session.messages);
			this.notice(style.gray(this.resumedNotice(this.options.session.header.id)));
		}
		this.updateFooter();
		// Only for a discover entry: an ordinary model still waits for the first prompt to start its server.
		if (this.agent.model && isUnresolved(this.agent.model)) void this.ensureServer();
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
			this.compactRun !== undefined ||
			this.supervisorRun !== undefined;
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
		} else if (this.busy || this.supervisorRun) {
			// While the loop runs the checks or the critic, a message waits for the actor's next turn.
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
		this.supervisorRun?.abort();
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

	/**
	 * Send `input`, then anything queued meanwhile, until the agent is done. Says how the last turn ended. With
	 * `restoreInput` false (the supervisor's own messages), a failed start hands back only what the user typed.
	 */
	private async runPrompt(input: string, restoreInput = true): Promise<ActorOutcome> {
		if (!this.agent.model) {
			this.notice(style.yellow("No model loaded. Please select a model with /model"));
			this.pickModel();
			return "error";
		}
		this.busy = true;
		let outcome: ActorOutcome = "done";
		try {
			let next: string | undefined = input;
			while (next !== undefined) {
				if (!(await this.ensureServer())) {
					this.restoreQueued(next === input && !restoreInput ? "" : next);
					outcome = this.supervisorRun?.signal.aborted ? "aborted" : "error";
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

				const last = this.agent.messages.at(-1);
				outcome =
					last?.role === "assistant" && last.stopReason === "aborted"
						? "aborted"
						: last?.role === "assistant" && last.stopReason === "error"
							? "error"
							: "done";

				await this.checkSwapAndRecycleIfNeeded();

				const queued = [...this.pending, ...this.agent.takeQueued().map(userText)];
				this.pending = [];
				if (queued.length === 0) break;
				if (outcome === "aborted") {
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
		return outcome;
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
				`[Memory Guard] Memory is short (${describeMemory(usage)}; limit ${limitStr}). Stopping the server to reclaim it.`,
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
		const postStr = postUsage ? ` (now ${describeMemory(postUsage)})` : "";
		if (guard.recycled(postUsage)) {
			this.notice(
				style.yellow(
					`[Memory Guard] Server stopped${postStr}. Memory is still short without it, so other applications hold it; the guard pauses until that changes.`,
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

	/**
	 * Make the current model's server ready, after any startup already in progress. False if it failed or was
	 * aborted. An unresolved `discover` placeholder is connected first, so every route to a prompt -- `-m mac`,
	 * a resumed session, `/model mac` -- goes through the same step.
	 */
	private ensureServer(): Promise<boolean> {
		if (!this.agent.model) return Promise.resolve(false);
		this.serverTask = this.serverTask.then(async () => {
			const model = this.agent.model;
			if (!model) return false;
			if (isUnresolved(model) && !(await this.resolveDiscovered(model))) return false;
			return this.agent.model ? this.startServer(this.agent.model) : false;
		});
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
					: style.red(model.discover ? errorText(error) : `llama-server: ${errorText(error)}`),
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
					if (event.message.usage.promptTokens > 0) {
						this.lastReply = event.message;
						this.contextEstimate = undefined;
					}
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
			case "rag":
				this.switchRag(args);
				return;
			case "ponytail":
				if (args) this.setPonytail(args);
				else this.pickPonytail();
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
			case "clear":
				this.newSession();
				return;
			case "resume":
				if (args) this.resumeById(args);
				else this.pickSession();
				return;
			case "name":
				this.nameSession(args);
				return;
			case "supervise":
				void this.superviseCommand(args);
				return;
			case "audit":
				void this.audit(args);
				return;
			case "usage":
				this.showUsage();
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
	private toolOptions(): Pick<CodingToolOptions, "allowLocalNetwork" | "knowledgeBase"> {
		return { allowLocalNetwork: () => this.agent.interactionMode === "agent", knowledgeBase: this.knowledgeBase };
	}

	/** What the session file records: the model, its sampling mode, and the interaction mode. */
	private sessionSettings(model: LiteModel): SessionSettings {
		return {
			model: model.name,
			mode: this.agent.mode,
			interactionMode: this.agent.interactionMode,
			...(this.agent.web ? {} : { web: false }),
			...(this.agent.rag ? { rag: true } : {}),
			...(this.agent.ponytail === "off" ? {} : { ponytail: this.agent.ponytail }),
		};
	}

	private resumedNotice(id: string): string {
		const mode = this.agent.interactionMode;
		const inMode = mode === "agent" ? "" : ` in ${mode} mode`;
		const named = this.sessionName ? ` "${this.sessionName}"` : "";
		const ponytail = this.agent.ponytail === "off" ? "" : `, ponytail ${this.agent.ponytail}`;
		const tools = `${this.agent.web ? "" : ", web off"}${this.agent.rag ? ", rag on" : ""}${ponytail}`;
		return `Resumed session ${id.slice(0, 8)}${named}${inMode}${tools}.`;
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

	/**
	 * `/rag on`, `/rag off`, or `/rag` to switch: give the model kb_search over the models.yml `rag:` archives.
	 * kiwix-serve starts here rather than at the first search, so a missing binary or an empty folder shows now.
	 */
	private switchRag(arg: string): void {
		const knowledgeBase = this.knowledgeBase;
		if (!knowledgeBase) {
			this.notice(
				style.yellow(
					"No knowledge base is set up. Add this to models.yml:\n  rag:\n    zimFolder: <folder of .zim files>",
				),
			);
			return;
		}
		const choice = arg.trim().toLowerCase();
		if (choice && choice !== "on" && choice !== "off") {
			this.notice(style.yellow("Use /rag on, /rag off, or /rag to switch."));
			return;
		}
		const rag = choice ? choice === "on" : !this.agent.rag;
		if (rag === this.agent.rag) {
			this.notice(style.gray(`The knowledge base is already ${rag ? "on" : "off"}.`));
			return;
		}
		let archives = 0;
		if (rag) {
			try {
				archives = knowledgeBase.archives().length;
			} catch (error) {
				this.notice(style.red(errorText(error)));
				return;
			}
		}
		this.agent.setRag(rag);
		if (this.agent.model) this.session?.updateSettings(this.sessionSettings(this.agent.model));
		const note = this.agent.isRunning ? " (from the next message)" : "";
		if (rag) {
			this.notice(style.gray(`Knowledge base on${note}: ${archives} archives the model can search with kb_search.`));
			knowledgeBase.start().catch((error: unknown) => this.notice(style.red(`Knowledge base: ${errorText(error)}`)));
		} else {
			// A search in flight would fail if kiwix-serve went away under it; it stops with the app instead.
			if (!this.agent.isRunning) knowledgeBase.stop();
			this.notice(style.gray(`Knowledge base off${note}.`));
		}
		this.updateFooter();
	}

	/** `/ponytail` with no argument: pick a level. */
	private pickPonytail(): void {
		const current = this.agent.ponytail;
		const items: SelectItem[] = PONYTAIL_LEVELS.map((level) => ({
			value: level,
			label: level === current ? `${level} (current)` : level,
			description: level === "off" ? "No ponytail rules" : PONYTAIL_LEVEL_RULES[level],
		}));
		this.pick("Ponytail level", items, (level) => this.setPonytail(level));
	}

	/** `/ponytail <level>`: add the ponytail rules to the system prompt at that level, or take them out with off. */
	private setPonytail(arg: string): void {
		const level = arg.trim().toLowerCase();
		if (!isPonytailLevel(level)) {
			this.notice(style.yellow("Use /ponytail off, lite, full, or ultra, or /ponytail to pick."));
			return;
		}
		if (level === this.agent.ponytail) {
			this.notice(style.gray(`Ponytail is already ${level}.`));
			return;
		}
		this.agent.setPonytail(level);
		if (this.agent.model) this.session?.updateSettings(this.sessionSettings(this.agent.model));
		const note = this.agent.isRunning ? " (from the next message)" : "";
		this.notice(style.gray(level === "off" ? `Ponytail off${note}.` : `Ponytail ${level}${note}.`));
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
			if (res.compactedCalls > 0) this.contextEstimate = res.estimatedTokens;
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

	// Supervisor

	/** What the `/supervise` loop needs from the app: the actor turns, the critic's server, the screen, the session. */
	private supervisorHost(): SupervisorHost {
		return {
			cwd: this.options.cwd,
			maxRetries: this.options.config.supervisor?.maxRetries ?? 3,
			transcriptLength: () => this.agent.messages.length,
			runActor: async (text, contextStart, signal): Promise<ActorResult> => {
				if (signal.aborted) return "aborted";
				this.agent.startContextAt(contextStart);
				// The loop guard: a turn that repeats itself or runs too long is ended, and the phase checked.
				let stuck: string | undefined;
				const stop = (reason: string) => {
					if (stuck) return;
					stuck = reason;
					this.agent.abort();
				};
				const guard = new RepeatGuard();
				const unsubscribe = this.agent.subscribe((event) => {
					if (event.type !== "tool_execution_start") return;
					const reason = guard.check(event.toolCall);
					if (reason) stop(reason);
				});
				const minutes = this.options.config.supervisor?.attemptMinutes ?? 90;
				const timer = setTimeout(() => stop(`the turn ran past ${minutes} minutes`), minutes * 60_000);
				// Messages typed while the checks or the critic ran go with this turn.
				const typed = this.pending.splice(0);
				try {
					const outcome = await this.runPrompt([text, ...typed].join("\n\n"), false);
					return stuck && !signal.aborted ? { stuck } : outcome;
				} finally {
					clearTimeout(timer);
					unsubscribe();
				}
			},
			loadCritic: async (signal) => {
				const name = this.criticOverride ?? this.options.config.supervisor?.critic;
				const found = name ? findModel(this.options.config.models, name) : undefined;
				if (!found) throw new Error(`No critic: ${name ?? "models.yml has no supervisor.critic"}.`);
				const critic = asCritic(found);
				await this.serverTask;
				this.setAiStatus("working");
				try {
					await this.options.manager.ensure(critic, { signal, onStatus: (message) => this.setStatus(message) });
				} finally {
					this.setAiStatus("idle");
				}
				return critic;
			},
			save: (state) => {
				this.session?.setSupervisor(state);
				this.updateFooter();
			},
			notice: (text, tone) =>
				this.notice(tone === "good" ? style.green(text) : tone === "bad" ? style.red(text) : style.gray(text)),
			status: (text) => this.setStatus(text, "esc to stop the supervisor"),
			notify: (text) => notify(text),
		};
	}

	/** A loop saved in a session. One that was running when Arc last exited is stopped now. */
	private restoredSupervisor(state: SupervisorState | undefined): Supervisor | undefined {
		if (!state) return undefined;
		return new Supervisor(
			this.supervisorHost(),
			state.status === "running" ? { ...state, status: "stopped" } : state,
		);
	}

	/** `/supervise <plan>` starts, `/supervise resume` continues, `/supervise stop` stops, `/supervise` shows status. */
	private async superviseCommand(args: string): Promise<void> {
		const arg = args.trim();
		if (arg === "stop") {
			if (this.supervisorRun) this.abort();
			else this.notice(style.gray("The supervisor is not running."));
			return;
		}
		if (arg === "") {
			this.notice(style.gray(this.describeSupervisor()));
			return;
		}
		if (!this.requireIdle()) return;
		if (arg === "resume") {
			const state = this.supervisor?.state;
			if (!state) this.notice(style.yellow("Nothing to resume. Start with /supervise <plan.md>."));
			else if (state.status === "done") this.notice(style.gray("Every phase of this plan has passed."));
			else await this.runSupervisor();
			return;
		}
		await this.startSupervisor(arg);
	}

	private async startSupervisor(planArg: string): Promise<void> {
		const config = this.options.config.supervisor;
		const cwd = this.options.cwd;
		const refuse = (text: string) => this.notice(style.yellow(text));
		if (!config) {
			refuse(
				"No critic is set up. Add this to models.yml:\n  supervisor:\n    critic: <model name>\n    maxRetries: 3",
			);
			return;
		}
		if (!this.agent.model) return refuse("Pick the actor with /model first.");
		if (this.agent.model.name === config.critic) return refuse("The actor and the critic must be different models.");
		if (this.agent.interactionMode !== "agent") return refuse("The actor needs its tools. Switch with /agent first.");
		const plan = resolve(cwd, planArg);
		if (!existsSync(plan)) return refuse(`No plan at ${plan}.`);
		try {
			if (!(await isGitRepo(cwd))) return refuse("The supervisor commits each passed phase: run git init first.");
			if (!(await isClean(cwd))) {
				return refuse("Commit or stash your changes first, or they would land in the first phase's commit.");
			}
			await readPlan(plan);
			const state = await startState(plan, cwd);
			if (!state) return refuse("Every phase of this plan already has a passed commit.");
			this.supervisor = new Supervisor(this.supervisorHost(), state);
		} catch (error) {
			this.notice(style.red(error instanceof PlanError ? `Plan: ${error.message}` : errorText(error)));
			return;
		}
		await this.runSupervisor();
	}

	/** `/audit [critic]`: judge the current phase now instead of waiting for the actor, then carry on. */
	private async audit(args: string): Promise<void> {
		if (!this.requireIdle()) return;
		const state = this.supervisor?.state;
		if (!state || state.status === "done") {
			this.notice(style.yellow("No phase to audit. Start with /supervise <plan.md>."));
			return;
		}
		if (args.trim()) {
			const critic = findModel(this.options.config.models, args.trim());
			if (!critic || critic.discover) {
				this.notice(style.red(`No local model matches "${args.trim()}".`));
				return;
			}
			this.criticOverride = critic.name;
		}
		await this.runSupervisor("audit");
	}

	private async runSupervisor(begin?: "audit"): Promise<void> {
		const supervisor = this.supervisor;
		if (!supervisor) return;
		const controller = new AbortController();
		this.supervisorRun = controller;
		this.updateFooter();
		try {
			await supervisor.run(controller.signal, begin);
		} finally {
			this.supervisorRun = undefined;
			this.criticOverride = undefined;
			this.setStatus(undefined);
			this.updateFooter();
		}
		// A critic left loaded would hold its memory until the next message; the user may be away for hours.
		const { manager } = this.options;
		if (manager.model && manager.model.name !== this.agent.model?.name) await manager.stop();
		if (this.pending.length > 0) {
			const next = this.pending.join("\n\n");
			this.pending = [];
			void this.runPrompt(next);
		}
	}

	/** `/usage`: the tokens this session's replies used, and the critic's while supervising. */
	private showUsage(): void {
		const actor = tallyUsage(this.agent.messages);
		const critic = this.supervisor?.state.criticUsage;
		const lines = [`Tokens this session: ${formatUsage(actor)}.`];
		if (critic) lines.push(`Critic: ${formatUsage(critic)}.`);
		this.notice(style.gray(lines.join("\n")));
	}

	private describeSupervisor(): string {
		const state = this.supervisor?.state;
		if (!state) return "No supervisor in this session. Start one with /supervise <plan.md>.";
		const plan = relative(this.options.cwd, state.plan) || state.plan;
		const lines = [`Supervising ${plan}: phase ${state.phase}, ${state.status}, ${state.failures} failed attempts.`];
		if (state.haltReason) lines.push(`Halted: ${state.haltReason}`);
		lines.push(`Actor tokens this session: ${formatUsage(tallyUsage(this.agent.messages))}.`);
		if (state.criticUsage) lines.push(`Critic tokens: ${formatUsage(state.criticUsage)}.`);
		if (state.lastVerdict) {
			lines.push(
				state.lastVerdict.pass
					? "Last verdict: pass."
					: `Last verdict: fail.\n${state.lastVerdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
			);
		}
		return lines.join("\n");
	}

	/** Commands that replace the model, transcript, or session must wait for the current request. */
	private requireIdle(): boolean {
		if (this.isServing) {
			this.notice(style.yellow("Currently serving a model. Press esc to stop serving first."));
			return false;
		}
		if (!this.busy && !this.agent.isRunning && !this.supervisorRun) return true;
		this.notice(
			style.yellow(
				this.supervisorRun
					? "The supervisor is running. /supervise stop or esc stops it."
					: "Wait for the current request to finish, or press esc to abort it.",
			),
		);
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
		// stop() ends a server Arc started and only forgets one it attached to, so say which happened.
		const owned = manager.ownsServer;
		const attachedTo = !owned && manager.model ? serverOrigin(manager.model.baseUrl) : undefined;
		await manager.stop();
		this.agent.model = undefined;
		this.agent.tools = [];
		this.lastReply = undefined;
		this.contextEstimate = undefined;
		this.lastTurnMs = undefined;
		this.setAiStatus("idle");
		this.updateBanner(undefined, undefined);
		if (owned) {
			this.notice(style.gray("Disconnected: llama-server stopped."));
		} else if (attachedTo) {
			this.notice(
				style.gray(`Disconnected. The llama-server at ${attachedTo} was running before Arc and is still running.`),
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
		this.updateBanner(this.agent.model?.name, mode);
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
		if (model.name === this.agent.model?.name && !model.discover) {
			this.notice(style.gray(`Already using ${modelLabel(this.agent.model)}.`));
			return;
		}
		// Reconnecting to the same discover entry keeps the mode in use.
		this.connectMode = model.discover && model.name === this.agent.model?.name ? this.agent.mode : undefined;
		this.adoptModel(model, this.connectMode);
		void this.ensureServer();
	}

	/**
	 * Ask the server at the placeholder's baseUrl what it is running, then adopt that. The model, its window, and
	 * whether it takes images all come from the reply, so models.yml never has to describe a machine it cannot see.
	 */
	private async resolveDiscovered(placeholder: LiteModel): Promise<boolean> {
		const origin = serverOrigin(placeholder.baseUrl);
		this.setAiStatus("working");
		this.setStatus(`Asking ${origin} what it is running`);
		try {
			const props = await fetchServerProps(placeholder.baseUrl, undefined, AbortSignal.timeout(10_000));
			if (!props) {
				this.notice(style.red(`Nothing is serving at ${origin}. Start llama-server there, then try again.`));
				return false;
			}
			const model = resolveDiscoveredModel(placeholder, props);
			this.adoptModel(model, this.connectMode);
			this.connectMode = undefined;
			this.notice(style.gray(describeDiscovered(model, props, origin)));
			return true;
		} finally {
			this.setStatus(undefined);
			if (!this.agent.isRunning) this.setAiStatus("idle");
		}
	}

	/** Everything that changes when a model becomes the current one, once it is fully known. */
	private adoptModel(model: LiteModel, mode = defaultSamplingMode(model)): void {
		this.agent.model = model;
		this.agent.mode = mode;
		this.agent.tools = createToolsForModel(model, this.options.cwd, this.toolOptions());
		this.lastReply = undefined;
		this.contextEstimate = undefined;
		this.lastTurnMs = undefined;
		if (this.options.saveSessions && !this.session) {
			this.session = SessionFile.create(this.appDir, this.options.cwd, this.sessionSettings(model));
		} else {
			this.session?.updateSettings(this.sessionSettings(model));
		}
		writeLastUsed(getAppDir(), { model: model.name, mode: this.agent.mode });
		if (!model.discover) this.notice(style.gray(`Model: ${modelLabel(model)} (${this.agent.mode})`));
		this.updateFooter();
		this.updateBanner(modelLabel(model), this.agent.mode);
	}

	private pickModel(): void {
		const current = this.agent.model?.name;
		const items = this.options.config.models.map((model) => ({
			value: model.name,
			label: current && model.name === current ? `${modelLabel(this.agent.model ?? model)} (current)` : model.name,
			description: model.discover
				? `connect to whatever ${serverOrigin(model.baseUrl)} is running`
				: `${defaultSamplingMode(model)} · ctx ${formatTokens(model.contextWindow)}`,
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

		// Hosting runs llama-server here, which needs a GGUF on this machine: a discover entry has neither.
		const models = this.options.config.models.filter((model) => !model.discover);
		if (models.length === 0) {
			this.notice(style.red("No models in models.yml can be served from this machine."));
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
				const styleColor = underPressure(usage, thresholdBytes) ? style.red : isHigh ? style.yellow : style.dim;
				const free = usage.freePercent === undefined ? "" : ` · ${Math.round(usage.freePercent)}% free`;
				serveView.setSwapText(styleColor(`Swap: ${usedStr} / ${limitStr} limit${free}`));
				this.tui.requestRender();
			},
			onThresholdExceeded: async (usage) => {
				if (!this.isServing || this.serveAbortController?.signal.aborted) return;
				const limitStr = formatGigabytes(thresholdBytes);

				serveView.addLogLine(`[Memory Guard] Memory is short (${describeMemory(usage)}; limit ${limitStr}).`);
				serveView.addLogLine("[Memory Guard] Waiting for in-flight requests to finish…");
				this.setStatus("Memory is short · waiting for in-flight requests to finish…", "esc to stop");

				const isIdle = await this.options.manager.waitForIdle(60_000, this.serveAbortController?.signal);
				if (this.serveAbortController?.signal.aborted) return;
				if (!isIdle) {
					serveView.addLogLine("[Memory Guard] Timed out waiting for active requests. Forcing stop…");
				}

				serveView.addLogLine("[Memory Guard] Stopping server to reclaim memory…");
				this.setStatus("Stopping server to reclaim memory…", "esc to stop");
				await this.options.manager.stop();
				if (this.serveAbortController?.signal.aborted) return;

				serveView.addLogLine("[Memory Guard] Pausing 15s for the system to settle…");
				this.setStatus("Reclaiming memory (15s cooldown)…", "esc to stop");
				try {
					await delay(15_000, undefined, { signal: this.serveAbortController?.signal });
				} catch {
					return;
				}
				if (this.serveAbortController?.signal.aborted) return;

				const postUsage = await readSwapUsage();
				const postStr = postUsage ? describeMemory(postUsage) : "memory unknown";
				serveView.addLogLine(`[Memory Guard] With the server stopped: ${postStr}. Restarting host server…`);
				this.setStatus(`Restarting host server (${postStr})…`, "esc to stop");

				try {
					await startHostServer();
					serveView.addLogLine("[Memory Guard] Server restarted successfully and ready for requests.");
					if (postUsage && underPressure(postUsage, thresholdBytes)) {
						serveView.addLogLine(
							"[Memory Guard] Memory stayed short with the server stopped, so other applications hold it. Auto-recycle paused until that changes.",
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
				serveView.addLogLine(`[Memory Guard] Memory recovered (${describeMemory(usage)}). Memory guard re-armed.`);
			},
		});

		try {
			// Memory is system-wide. If it is already short before the server starts, other applications hold it, and
			// recycling the new server would only reload it, so the guard starts paused until that changes.
			const initialSwap = await readSwapUsage();
			const alreadyOver = initialSwap !== undefined && underPressure(initialSwap, thresholdBytes);
			await startHostServer();
			if (alreadyOver) {
				serveView.addLogLine(
					`[Memory Guard] Memory is already short (${describeMemory(initialSwap)}; limit ${formatGigabytes(thresholdBytes)}) from other applications. Guard paused until that changes.`,
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

	/** `/clear`, also reached as `/new`, `/cls`, and `/reset`. */
	private newSession(): void {
		if (!this.requireIdle()) return;
		this.agent.setMessages([]);
		this.supervisor = undefined;
		this.sessionName = undefined;
		this.lastReply = undefined;
		this.contextEstimate = undefined;
		this.lastTurnMs = undefined;
		this.setAiStatus("idle");
		// The interaction mode and web setting belong to a session, so a new one starts in agent mode with web on.
		const leftMode = this.agent.interactionMode !== "agent";
		if (leftMode) this.agent.setInteractionMode("agent");
		const webBack = !this.agent.web;
		if (webBack) this.agent.setWeb(true);
		const ragOff = this.agent.rag;
		if (ragOff) this.agent.setRag(false);
		const ponytailOff = this.agent.ponytail !== "off";
		if (ponytailOff) this.agent.setPonytail("off");
		if (this.options.saveSessions && this.agent.model) {
			this.session = SessionFile.create(this.appDir, this.options.cwd, this.sessionSettings(this.agent.model));
		} else {
			this.session = undefined;
		}
		this.resetTranscript();
		const back = [
			leftMode ? "agent mode" : "",
			webBack ? "web tools on" : "",
			ragOff ? "knowledge base off" : "",
			ponytailOff ? "ponytail off" : "",
		]
			.filter(Boolean)
			.join(", ");
		this.notice(style.gray(back ? `New session. Back to ${back}.` : "New session."));
		this.updateFooter();
	}

	/** This directory's saved sessions, most recent first, without the one in use. */
	private resumableSessions(): SessionSummary[] {
		try {
			return listSessions(this.appDir, this.options.cwd).filter((session) => session.id !== this.session?.id);
		} catch {
			return [];
		}
	}

	private pickSession(): void {
		if (!this.requireIdle()) return;
		const sessions = this.resumableSessions();
		if (sessions.length === 0) {
			this.notice(style.gray("No saved sessions for this directory."));
			return;
		}
		const items = sessions.slice(0, 50).map((session) => ({
			value: session.path,
			label: sessionLabel(session),
			description: `${formatAge(session.modified)} · ${session.id.slice(0, 8)}`,
		}));
		this.pick("Resume session", items, (path) => this.resumePath(path));
	}

	/** `/resume 2`, `/resume toolbar`, or `/resume 1a2b`: a position in the banner's list, a `/name`, or an id. */
	private resumeById(query: string): void {
		const match = matchSession(this.resumableSessions(), query);
		if ("session" in match) this.resumePath(match.session.path);
		else this.notice(style.red(match.error));
	}

	/** `/name <text>` names the current session for the banner and `/resume`; `/name` alone shows the name. */
	private nameSession(text: string): void {
		const name = text.trim().replace(/\s+/g, " ");
		if (!this.session) {
			this.notice(
				style.yellow("This session is not saved (no model loaded, or --no-session), so it cannot be named."),
			);
			return;
		}
		if (!name) {
			this.notice(
				style.gray(this.sessionName ? `This session is named "${this.sessionName}".` : "Usage: /name <text>"),
			);
			return;
		}
		this.session.setName(name);
		this.sessionName = name;
		this.notice(style.gray(`Session named "${name}". Resume it later with /resume ${name.split(" ")[0]}.`));
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
		this.sessionName = loaded.name;
		this.supervisor = this.restoredSupervisor(loaded.supervisor);
		this.agent.model = model;
		this.agent.mode = savedModel && saved ? saved.mode : this.agent.mode;
		this.agent.setInteractionMode(saved?.interactionMode ?? "agent");
		this.agent.setWeb(saved?.web ?? true);
		this.agent.setRag(this.knowledgeBase !== undefined && saved?.rag === true);
		this.agent.setPonytail(saved?.ponytail ?? "off");
		if (model && modelChanged) this.agent.tools = createToolsForModel(model, this.options.cwd, this.toolOptions());
		if (this.options.saveSessions && model) {
			this.session = SessionFile.resume(loaded, this.sessionSettings(model));
		}
		this.lastReply = lastReplyWithUsage(loaded.messages);
		this.contextEstimate = undefined;

		this.resetTranscript();
		this.showTranscript(loaded.messages);
		this.notice(style.gray(this.resumedNotice(loaded.header.id)));
		if (saved && !savedModel)
			this.notice(style.yellow(`Saved model ${saved.model} is not in models.yml; using ${model?.name ?? "none"}.`));
		if (modelChanged && model) void this.ensureServer();
	}

	/** Temporarily put a picker where the editor is. */
	private pick(title: string, items: SelectItem[], onSelect: (value: string) => void): void {
		const list = new SelectList(items, Math.min(items.length, 10), selectListTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 72,
		});
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

	/**
	 * Shows a model change under the banner's logo while the banner is still on screen: before the conversation
	 * starts, only a few notices sit below it. Later it has scrolled up, and rewriting lines above the screen would
	 * make the renderer redraw everything and clear the scrollback, so it keeps what it showed.
	 */
	private updateBanner(modelName: string | undefined, mode: string | undefined): void {
		if (this.agent.messages.length === 0) this.banner?.setModel(modelName, mode);
	}

	private showHeader(): void {
		this.banner = new BannerView({
			version: this.options.version ?? "0.0.1",
			cwd: this.options.cwd,
			modelName: this.agent.model?.name,
			mode: this.agent.model ? this.agent.mode : undefined,
			// The same list, in the same order, that `/resume 1` picks from.
			recent: this.resumableSessions()
				.slice(0, BANNER_RECENT.wide)
				.map((session) => ({ when: formatSessionDate(session.modified), label: sessionLabel(session) })),
		});
		this.chat.addChild(this.banner);
	}

	/** Replace the transcript. This redraws the whole screen, so it is used only for /clear and /resume. */
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
				rag: this.agent.rag,
				ponytail: this.agent.ponytail,
				supervisor: this.supervisor?.state,
				serving: this.serving,
				aiStatus: this.aiStatus,
				contextTokens: this.contextEstimate,
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
		this.knowledgeBase?.stop();
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

/** A macOS notification, for a person away from the terminal. Elsewhere, or if it fails, nothing happens. */
function notify(text: string): void {
	if (process.platform !== "darwin") return;
	const quoted = text.replace(/["\\]/g, "");
	execFile("osascript", ["-e", `display notification "${quoted}" with title "Arc Supervisor"`], () => {});
}

/** A `discover` entry that has not been connected yet: it still names no GGUF. */
function isUnresolved(model: LiteModel): boolean {
	return model.discover === true && model.modelPath === "";
}

/**
 * What a fresh connection found, for the line printed under `/model`: the GGUF, where it is, and the facts that
 * change how Arc talks to it.
 */
function describeDiscovered(model: LiteModel, props: ServerProps, origin: string): string {
	const facts = [`ctx ${formatTokens(model.contextWindow)}`, `reply ${formatTokens(model.maxTokens)}`];
	if (props.reasoning) facts.push("thinking");
	if (props.vision) facts.push("vision");
	if (props.reasoningEffort) facts.push("reasoning effort");
	if (!props.tools) facts.push("no tool support");
	if (props.buildInfo) facts.push(props.buildInfo);
	return `Connected to ${modelLabel(model)} at ${origin} · ${facts.join(" · ")}`;
}

/** Run the interactive UI until the user quits. The caller stops llama-server afterwards. */
export async function runInteractive(options: InteractiveOptions): Promise<void> {
	await new InteractiveApp(options).run();
}
