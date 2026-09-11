import { streamChat } from "../llm/llama-client.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../llm/types.ts";
import { validateToolArguments } from "../llm/validation.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool, ToolResult } from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

/**
 * Run prompts to completion: stream a response, execute its tool calls one at a time, send the results back, and
 * repeat until the model answers without tool calls. Failures end the run as messages, never as exceptions.
 * `context.messages` is extended in place. Returns the messages this run added.
 */
export async function runAgentLoop(
	prompts: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<Message[]> {
	const added: Message[] = [];
	const append = async (message: Message) => {
		context.messages.push(message);
		added.push(message);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	};

	await emit({ type: "agent_start" });
	let pending = prompts;
	while (true) {
		await emit({ type: "turn_start" });
		for (const message of pending) await append(message);
		pending = [];

		const message = await streamAssistant(context, config, emit, signal);
		added.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			break;
		}

		const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		// Blocks stream in order, so max_tokens can only cut off the last one. Earlier calls finished streaming and run.
		const cutOff = message.stopReason === "length" ? message.content.at(-1) : undefined;
		const toolResults: ToolResultMessage[] = [];
		for (const toolCall of toolCalls) {
			if (signal?.aborted) break;
			const result = await runToolCall(context.tools, toolCall, toolCall === cutOff, emit, signal);
			toolResults.push(result);
			await append(result);
		}
		await emit({ type: "turn_end", message, toolResults });

		if (signal?.aborted) break;
		pending = config.takeQueuedMessages?.() ?? [];
		if (toolCalls.length === 0 && pending.length === 0) break;
	}
	await emit({ type: "agent_end", messages: added });
	return added;
}

async function streamAssistant(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	let messages: Message[];
	try {
		messages = config.transformContext ? await config.transformContext(context.messages) : context.messages;
	} catch (error) {
		// For example a context window too full to leave room for a reply: end the run without sending anything.
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			model: config.model.name,
			usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		context.messages.push(message);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		return message;
	}
	const stream = (config.streamFn ?? streamChat)(
		config.model,
		{ systemPrompt: context.systemPrompt, messages, tools: context.tools },
		{ preset: config.preset, signal },
	);

	let started = false;
	for await (const event of stream) {
		if (event.type === "start") {
			started = true;
			context.messages.push(event.partial);
			await emit({ type: "message_start", message: event.partial });
		} else if (event.type === "done" || event.type === "error") {
			break;
		} else if (started) {
			await emit({ type: "message_update", message: event.partial, event });
		}
	}

	const message = await stream.result();
	if (started) {
		context.messages[context.messages.length - 1] = message;
	} else {
		context.messages.push(message);
		await emit({ type: "message_start", message });
	}
	await emit({ type: "message_end", message });
	return message;
}

async function runToolCall(
	tools: readonly AgentTool[],
	toolCall: ToolCall,
	truncated: boolean,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolResultMessage> {
	await emit({ type: "tool_execution_start", toolCall });
	let result: ToolResult;
	let isError = false;
	const updates: Promise<void>[] = [];
	let acceptingUpdates = true;
	try {
		if (truncated) {
			// Streamed arguments are salvaged from partial JSON, so a cut-off call can validate yet be incomplete.
			throw new Error(
				`Not executed: the response hit max_tokens, so the arguments may be cut off. Send the ${toolCall.name} call again with complete arguments.`,
			);
		}
		const tool = tools.find((candidate) => candidate.name === toolCall.name);
		if (!tool) {
			const names = tools.map((candidate) => candidate.name).join(", ");
			throw new Error(`Unknown tool "${toolCall.name}". Available tools: ${names}.`);
		}
		const args = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
		const params = validateToolArguments(tool, { ...toolCall, arguments: args as Record<string, unknown> });
		signal?.throwIfAborted();
		result = await tool.execute(toolCall.id, params, signal, (partial) => {
			if (acceptingUpdates)
				updates.push(Promise.resolve(emit({ type: "tool_execution_update", toolCall, partial })));
		});
	} catch (error) {
		result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
		isError = true;
	}
	acceptingUpdates = false;
	await Promise.all(updates);
	await emit({ type: "tool_execution_end", toolCall, result, isError });
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}
