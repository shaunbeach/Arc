import type { LiteModel } from "../config/models.ts";
import { resolvePreset, type SamplingMode } from "../config/sampling.ts";
import { ContextWindow, estimateMessageTokens } from "../context.ts";
import { type CompactResult, compact, compactHeuristic, type JevAsker, LocalLlamaJevAsker } from "../jev/index.ts";
import type { AssistantMessage, Message, UserMessage } from "../llm/types.ts";
import type { PonytailLevel } from "../ponytail.ts";
import {
	buildSystemPrompt,
	estimateFixedPromptTokens,
	type InteractionMode,
	RAG_TOOLS,
	type SystemPromptOptions,
	TOOLS_BY_MODE,
	WEB_TOOLS,
} from "../prompt.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { AgentEvent, AgentTool, StreamFn } from "./types.ts";

export type AgentListener = (event: AgentEvent) => void | Promise<void>;

/** A request goes out only while at least this many tokens (or maxTokens, if smaller) remain for the reply. */
const MIN_REPLY_TOKENS = 1024;

export interface AgentOptions {
	model?: LiteModel;
	mode?: SamplingMode;
	interactionMode?: InteractionMode;
	/** Whether the model has the web tools. Default: yes. */
	web?: boolean;
	/** Whether the model has kb_search. Default: no. */
	rag?: boolean;
	/** The `/ponytail` level. Default: off. */
	ponytail?: PonytailLevel;
	cwd?: string;
	systemPrompt?: string;
	tools?: AgentTool[];
	messages?: Message[];
	/** Default: `streamChat` against the model's llama-server. */
	streamFn?: StreamFn;
	/** Evaluator for `/compact`. Default: the model's own llama-server. */
	jevAsker?: JevAsker;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/**
 * Owns the transcript and runs one prompt at a time. Model, mode, system prompt, and tools may change between
 * runs. Each request carries only as much history as fits the model's window; the transcript itself keeps everything.
 */
export class Agent {
	model: LiteModel | undefined;
	mode: SamplingMode;
	interactionMode: InteractionMode;
	web: boolean;
	rag: boolean;
	ponytail: PonytailLevel;
	cwd: string;
	systemPrompt: string;
	tools: AgentTool[];
	private transcript: Message[];
	private readonly streamFn: StreamFn | undefined;
	private readonly jevAsker: JevAsker | undefined;
	private readonly listeners = new Set<AgentListener>();
	private readonly contextWindow: ContextWindow;
	private queue: UserMessage[] = [];
	private run: { controller: AbortController; done: Promise<void> } | undefined;

	constructor(options: AgentOptions) {
		this.model = options.model;
		this.mode = options.mode ?? "thinking";
		this.interactionMode = options.interactionMode ?? "agent";
		this.web = options.web ?? true;
		this.rag = options.rag ?? false;
		this.ponytail = options.ponytail ?? "off";
		this.cwd = options.cwd ?? process.cwd();
		this.contextWindow = new ContextWindow({ cwd: this.cwd });
		this.systemPrompt = options.systemPrompt ?? buildSystemPrompt(this.promptOptions());
		this.tools = options.tools ? [...options.tools] : [];
		this.transcript = options.messages ? [...options.messages] : [];
		this.streamFn = options.streamFn;
		this.jevAsker = options.jevAsker;
	}

	get messages(): readonly Message[] {
		return this.transcript;
	}

	get isRunning(): boolean {
		return this.run !== undefined;
	}

	/** Messages queued with `enqueue` that no request has carried yet. */
	get queuedMessages(): readonly UserMessage[] {
		return this.queue;
	}

	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Replace the transcript, for a new or resumed session. */
	setMessages(messages: readonly Message[]): void {
		if (this.run) throw new Error("Cannot replace the transcript while the agent is running.");
		this.transcript = [...messages];
		this.contextWindow.reset();
	}

	/** Queue a message typed while the agent works. It goes out with the next request of the current run. */
	enqueue(text: string): void {
		this.queue.push(userMessage(text));
	}

	/** Remove and return queued messages, for example to start a new run with them after an abort. */
	takeQueued(): UserMessage[] {
		return this.queue.splice(0);
	}

	abort(): void {
		this.run?.controller.abort();
	}

	waitForIdle(): Promise<void> {
		return this.run?.done ?? Promise.resolve();
	}

	/**
	 * Compacts past tool calls and results using Jev evaluation, falling back to the heuristic when the evaluator
	 * fails. Like automatic trimming, it changes only what later requests send: the transcript and the session file
	 * keep every message. Aborting `signal` cancels without compacting anything.
	 */
	async compact(
		options: { keepThreshold?: number; preserveRecentSteps?: number; signal?: AbortSignal } = {},
	): Promise<{
		compactedCalls: number;
		tokensSaved: number;
		estimatedTokens: number;
		/** Calls Jev decided; the rest were decided by the heuristic. */
		askedCalls: number;
		/** Why Jev was not used, when it was not. */
		fallbackReason?: string;
	}> {
		if (this.run) throw new Error("Cannot compact while the agent is running.");
		const keepThreshold = options.keepThreshold ?? 0.5;
		const preserveRecentSteps = options.preserveRecentSteps ?? 1;
		const tokensOf = (messages: readonly Message[]) =>
			messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

		const asker = this.jevAsker ?? (this.model ? this.getJevAsker(this.model) : undefined);
		const before = this.contextWindow.view(this.transcript);
		const { settled, isSent } = this.contextWindow.compactionScope(this.transcript);

		let result: CompactResult;
		let fallbackReason: string | undefined;
		if (asker && this.model) {
			try {
				result = await compact(this.transcript, asker, {
					keepThreshold,
					preserveRecentSteps,
					exclude: settled,
					isSent,
					// The evaluator shares the model's window: its request gets half, in characters (3 per token).
					maxRequestChars: Math.floor(this.model.contextWindow * 0.5 * 3),
					signal: options.signal,
				});
			} catch (error) {
				if (options.signal?.aborted) throw new Error("Compaction cancelled.");
				fallbackReason = error instanceof Error ? error.message : String(error);
				result = compactHeuristic(this.transcript, preserveRecentSteps);
			}
		} else {
			fallbackReason = "no model is loaded";
			result = compactHeuristic(this.transcript, preserveRecentSteps);
		}
		this.contextWindow.adoptDecisions(this.transcript, result.decisions);

		const after = this.contextWindow.view(this.transcript);
		// The whole prompt, as the footer's measured figure counts it: instructions and tools included.
		const estimatedTokens = estimateFixedPromptTokens(this.systemPrompt, this.activeTools) + tokensOf(after.messages);
		return {
			compactedCalls: Math.max(0, after.compactedCalls - before.compactedCalls),
			tokensSaved: Math.max(0, tokensOf(before.messages) - estimatedTokens),
			estimatedTokens,
			askedCalls: result.askedCalls,
			fallbackReason,
		};
	}

	/** Switch interaction mode (agent, plan, or chat), updating the system prompt. */
	setInteractionMode(mode: InteractionMode): void {
		this.interactionMode = mode;
		this.rebuildSystemPrompt();
	}

	/** Give the model the web tools, or take them away (`/web`). The prompt says which it has. */
	setWeb(web: boolean): void {
		this.web = web;
		this.rebuildSystemPrompt();
	}

	/** Give the model kb_search, or take it away (`/rag`). The prompt says which it has. */
	setRag(rag: boolean): void {
		this.rag = rag;
		this.rebuildSystemPrompt();
	}

	/** Add the ponytail rules to the prompt at a level, or take them out (`/ponytail`). */
	setPonytail(level: PonytailLevel): void {
		this.ponytail = level;
		this.rebuildSystemPrompt();
	}

	private promptOptions(): SystemPromptOptions {
		return {
			cwd: this.cwd,
			interactionMode: this.interactionMode,
			web: this.web,
			rag: this.rag,
			ponytail: this.ponytail,
		};
	}

	/** Update working directory and regenerate system prompt. */
	setCwd(cwd: string): void {
		this.cwd = cwd;
		this.contextWindow.cwd = cwd;
		this.rebuildSystemPrompt();
	}

	private rebuildSystemPrompt(): void {
		this.systemPrompt = buildSystemPrompt(this.promptOptions());
	}

	/** The tools available for the current interaction mode, without the web tools while web is off or kb_search while rag is. */
	get activeTools(): AgentTool[] {
		const allowed = this.interactionMode === "agent" ? undefined : TOOLS_BY_MODE[this.interactionMode];
		return this.tools.filter(
			(tool) =>
				(!allowed || allowed.includes(tool.name)) &&
				(this.web || !WEB_TOOLS.includes(tool.name)) &&
				(this.rag || !RAG_TOOLS.includes(tool.name)),
		);
	}

	async prompt(input: string | UserMessage): Promise<void> {
		if (this.run) throw new Error("The agent is already running. Queue the message with enqueue().");
		if (!this.model) throw new Error("No model loaded. Please select a model with /model.");
		const controller = new AbortController();
		let settle = () => {};
		this.run = {
			controller,
			done: new Promise<void>((resolve) => {
				settle = resolve;
			}),
		};

		const model = this.model;
		const preset = resolvePreset(this.mode, model.sampling);
		const budget = model.contextWindow - model.maxTokens;
		const replyFloor = Math.min(MIN_REPLY_TOKENS, model.maxTokens);
		const activeTools = this.activeTools;
		const fixedTokens = estimateFixedPromptTokens(this.systemPrompt, activeTools);
		try {
			await runAgentLoop(
				[typeof input === "string" ? userMessage(input) : input],
				{ systemPrompt: this.systemPrompt, messages: this.transcript.slice(), tools: activeTools.slice() },
				{
					model,
					preset,
					streamFn: this.streamFn,
					transformContext: async (messages) => {
						const selection = this.contextWindow.select(messages, budget, fixedTokens, preset.thinkingHistory);
						if (selection.trimmed) {
							const { droppedMessages, compactedSteps, estimatedTokens } = selection;
							await this.emit({ type: "context_trimmed", droppedMessages, compactedSteps, estimatedTokens });
						}
						if (selection.estimatedTokens > model.contextWindow - replyFloor) {
							throw new Error(
								`Context full: this request needs about ${selection.estimatedTokens} tokens even after trimming, leaving less than ${replyFloor} of the ${model.contextWindow}-token window for the reply. Start a new session with /clear, or raise contextWindow and --ctx-size in models.yml.`,
							);
						}
						return selection.messages;
					},
					takeQueuedMessages: () => this.queue.splice(0),
				},
				(event) => this.emit(event),
				controller.signal,
			);
		} catch (error) {
			// runAgentLoop reports failures as messages, so reaching this is a bug. Surface it like a failed turn.
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				model: model.name,
				usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
				stopReason: controller.signal.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
			await this.emit({ type: "message_start", message });
			await this.emit({ type: "message_end", message });
			await this.emit({ type: "agent_end", messages: [message] });
		} finally {
			this.run = undefined;
			settle();
		}
	}

	private getJevAsker(model: LiteModel): LocalLlamaJevAsker | undefined {
		if (!model.baseUrl) return undefined;
		const llamaUrl = model.baseUrl.replace(/\/v1\/?$/, "");
		return new LocalLlamaJevAsker({ llamaUrl });
	}

	private async emit(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") this.transcript.push(event.message);
		for (const listener of this.listeners) await listener(event);
	}
}
