import type { AgentTool } from "./agent/types.ts";
import { estimateTokens } from "./context.ts";
import { toChatTools } from "./llm/llama-client.ts";

export interface SystemPromptOptions {
	cwd: string;
	/** Default: `process.platform`. */
	platform?: string;
}

/**
 * The whole system prompt. It has no dates or counters, so it stays byte-identical for a session and llama.cpp
 * reuses its KV cache on every request.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	return `You are a coding assistant running in the user's terminal. Use tools to inspect and change files; never guess what a file contains.

Rules:
- Read a file before editing it. Use edit for changes; use write only for new files or full rewrites.
- oldText must match the file exactly, including indentation, and occur once. Keep it short.
- Search with rg or grep through bash instead of reading many files. Run tests and builds with bash.
- Ask before destructive actions such as deleting files or discarding git changes.
- Be brief. When done, say which files changed.

OS: ${options.platform ?? process.platform}
Working directory: ${options.cwd}`;
}

/** Estimated tokens for the part sent with every request: the system prompt and the tool definitions. */
export function estimateFixedPromptTokens(systemPrompt: string, tools: readonly AgentTool[]): number {
	return estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(toChatTools(tools)));
}
