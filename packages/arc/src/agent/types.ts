import type { Static, TSchema } from "typebox";
import type { LiteModel } from "../config/models.ts";
import type { SamplingPreset } from "../config/sampling.ts";
import type { AssistantMessageEventStream } from "../llm/event-stream.ts";
import type { ChatRequestOptions } from "../llm/llama-client.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../llm/types.ts";

export interface ToolResult<TDetails = unknown> {
	/** What the model sees. */
	content: (TextContent | ImageContent)[];
	/** Structured data for the UI. Never sent to the model. */
	details?: TDetails;
}

export type ToolUpdateCallback<TDetails = unknown> = (partial: ToolResult<TDetails>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	/** Short name for the UI. */
	label: string;
	/** Rewrite raw arguments before schema validation, to accept shapes models commonly send. May throw. */
	prepareArguments?(args: unknown): unknown;
	/** Throw on failure: the error message becomes the tool result the model sees. */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<TDetails>,
	): Promise<ToolResult<TDetails>>;
}

export type StreamFn = (model: LiteModel, context: Context, options: ChatRequestOptions) => AssistantMessageEventStream;

export interface AgentContext {
	systemPrompt: string;
	/** Full transcript. The loop appends to it in place. */
	messages: Message[];
	tools: AgentTool[];
}

export interface AgentLoopConfig {
	model: LiteModel;
	preset: SamplingPreset;
	/**
	 * Choose the messages sent with one request, for example to fit the context window. Receives the full transcript.
	 * Throwing ends the run with an error message instead of a request.
	 */
	transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
	/** Messages the user queued during the run. Called after each turn; returned messages go out with the next request. */
	takeQueuedMessages?: () => Message[];
	/** Default: `streamChat`. */
	streamFn?: StreamFn;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	/** A turn is one model response plus the tool calls it made. */
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage; event: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCall: ToolCall }
	| { type: "tool_execution_update"; toolCall: ToolCall; partial: ToolResult }
	| { type: "tool_execution_end"; toolCall: ToolCall; result: ToolResult; isError: boolean }
	/** Older content was compacted or left out of requests to fit the context window, changing the prompt prefix. */
	| { type: "context_trimmed"; droppedMessages: number; compactedSteps: number; estimatedTokens: number };
