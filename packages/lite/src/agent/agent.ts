import type { LiteModel } from "../config/models.ts";
import { resolvePreset, type SamplingMode } from "../config/sampling.ts";
import { ContextWindow } from "../context.ts";
import type { AssistantMessage, Message, UserMessage } from "../llm/types.ts";
import { estimateFixedPromptTokens } from "../prompt.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { AgentEvent, AgentTool, StreamFn } from "./types.ts";

export type AgentListener = (event: AgentEvent) => void | Promise<void>;

/** A request goes out only while at least this many tokens (or maxTokens, if smaller) remain for the reply. */
const MIN_REPLY_TOKENS = 1024;

export interface AgentOptions {
	model: LiteModel;
	mode: SamplingMode;
	systemPrompt: string;
	tools: AgentTool[];
	messages?: Message[];
	/** Default: `streamChat` against the model's llama-server. */
	streamFn?: StreamFn;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/**
 * Owns the transcript and runs one prompt at a time. Model, mode, system prompt, and tools may change between
 * runs. Each request carries only as much history as fits the model's window; the transcript itself keeps everything.
 */
export class Agent {
	model: LiteModel;
	mode: SamplingMode;
	systemPrompt: string;
	tools: AgentTool[];
	private transcript: Message[];
	private readonly streamFn: StreamFn | undefined;
	private readonly listeners = new Set<AgentListener>();
	private readonly contextWindow = new ContextWindow();
	private queue: UserMessage[] = [];
	private run: { controller: AbortController; done: Promise<void> } | undefined;

	constructor(options: AgentOptions) {
		this.model = options.model;
		this.mode = options.mode;
		this.systemPrompt = options.systemPrompt;
		this.tools = options.tools;
		this.transcript = options.messages ? [...options.messages] : [];
		this.streamFn = options.streamFn;
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

	async prompt(input: string | UserMessage): Promise<void> {
		if (this.run) throw new Error("The agent is already running. Queue the message with enqueue().");
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
		const fixedTokens = estimateFixedPromptTokens(this.systemPrompt, this.tools);
		try {
			await runAgentLoop(
				[typeof input === "string" ? userMessage(input) : input],
				{ systemPrompt: this.systemPrompt, messages: this.transcript.slice(), tools: this.tools.slice() },
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
								`Context full: this request needs about ${selection.estimatedTokens} tokens even after trimming, leaving less than ${replyFloor} of the ${model.contextWindow}-token window for the reply. Start a new session with /new, or raise contextWindow and --ctx-size in models.yml.`,
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

	private async emit(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") this.transcript.push(event.message);
		for (const listener of this.listeners) await listener(event);
	}
}
