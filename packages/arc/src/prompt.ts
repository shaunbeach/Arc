import type { AgentTool } from "./agent/types.ts";
import { estimateTokens } from "./context.ts";
import { toChatTools } from "./llm/llama-client.ts";

export type InteractionMode = "agent" | "plan" | "chat";
export const INTERACTION_MODES: readonly InteractionMode[] = ["agent", "plan", "chat"] as const;

export function isInteractionMode(value: string): value is InteractionMode {
	return (INTERACTION_MODES as readonly string[]).includes(value);
}

/** Tools each restricted mode exposes. Agent mode exposes all registered tools. */
export const TOOLS_BY_MODE: Record<"plan" | "chat", readonly string[]> = {
	plan: ["read", "web_search", "web_fetch", "kb_search"],
	chat: ["web_search", "web_fetch", "kb_search"],
};

/** The tools `/web off` takes away in every mode. */
export const WEB_TOOLS: readonly string[] = ["web_search", "web_fetch"];

/** The tools the model has only while `/rag` is on. */
export const RAG_TOOLS: readonly string[] = ["kb_search"];

export interface SystemPromptOptions {
	cwd: string;
	/** Default: `process.platform`. */
	platform?: string;
	interactionMode?: InteractionMode;
	/** Whether the model has the web tools. Default: yes. */
	web?: boolean;
	/** Whether the model has kb_search (`/rag on`). Default: no. */
	rag?: boolean;
}

/** The line that tells the model about kb_search, or nothing while `/rag` is off. */
function kbLine(web: boolean, rag: boolean): string {
	if (!rag) return "";
	return web
		? "\n- Try kb_search (offline docs, Wikipedia) before the web."
		: "\n- kb_search searches offline docs and Wikipedia.";
}

function buildAgentPrompt(cwd: string, platform: string, web: boolean, rag: boolean): string {
	const search = web
		? "- Search with rg or grep through bash; use web_search and web_fetch for docs and APIs."
		: "- Search with rg or grep through bash instead of reading many files. Run tests and builds with bash.";
	return `You are a coding assistant running in the user's terminal. Use tools to inspect and change files; never guess what a file contains.

Rules:
- Read a file before editing it. Use edit for changes; use write only for new files or full rewrites.
- oldText must match the file exactly, including indentation, and occur once. Keep it short.
${search}${kbLine(web, rag)}
- When output names a full-output file, grep it instead of rerunning the command.
- Ask before destructive actions such as deleting files or discarding git changes.
- Be brief. Name the files you changed; never paste back a file you wrote, edited, or read.
- When the user asks for code without asking for a file, put the code in your reply.

OS: ${platform}
Working directory: ${cwd}`;
}

function buildPlanPrompt(cwd: string, platform: string, web: boolean, rag: boolean): string {
	const research = web
		? "- Use read and web tools (web_search, web_fetch) to research the repository, documentation, and dependencies."
		: "- Use read to research the repository. You have no web access in this session.";
	return `You are an expert AI planning assistant running in the user's terminal.
Your task is to work collaboratively with the user to explore the project and produce a clear, actionable implementation plan before any code is written.

Rules:
${research}${kbLine(web, rag)}
- Do NOT create or edit files in plan mode. Output your findings and plan directly to the screen.
- Highlight key trade-offs, architecture decisions, and open questions.
- Provide a concrete, phased step-by-step plan that can be followed when the user switches to agent mode.
- Be concise, direct, and structured.

OS: ${platform}
Working directory: ${cwd}`;
}

function buildChatPrompt(cwd: string, platform: string, web: boolean, rag: boolean): string {
	if (!web && rag) {
		return `You are a helpful, knowledgeable, and concise AI conversational assistant running in the user's terminal.
Answer the user's questions clearly and directly. Provide explanations or code blocks in your responses when asked.

You have no web access, but kb_search searches an offline knowledge base (Wikipedia, programming docs). Use it when you are unsure of a fact, and name the article you used. If the user asks you to inspect or change the project, tell them to switch with /agent, or /plan to draw up an approach first.

OS: ${platform}
Working directory: ${cwd}`;
	}
	if (!web) {
		return `You are a helpful, knowledgeable, and concise AI conversational assistant running in the user's terminal.
Answer the user's questions clearly and directly. Provide explanations or code blocks in your responses when asked.

You have no tools and no web access in this session. Answer from your own knowledge, and say when something may be out of date. If the user asks you to inspect or change the project, tell them to switch with /agent, or /plan to draw up an approach first.

OS: ${platform}
Working directory: ${cwd}`;
	}
	return `You are a helpful, knowledgeable, and concise AI conversational assistant running in the user's terminal.
Answer the user's questions clearly and directly. Provide explanations or code blocks in your responses when asked.

You can reach the internet:
- web_search finds pages for a query. Use it when the answer depends on current information or documentation.
- web_fetch reads one page as text. Use it to read a result you found, or a URL the user gives you.
- Answer from your own knowledge when it is sufficient; do not search for settled facts.
- Cite the URL when you use something you read.${kbLine(web, rag)}

You have no file or shell tools in this mode. If the user asks you to inspect or change the project, tell them to switch with /agent, or /plan to draw up an approach first.

OS: ${platform}
Working directory: ${cwd}`;
}

/**
 * The system prompt for the given mode. It has no dates or counters, so it stays byte-identical for a session and llama.cpp
 * reuses its KV cache on every request.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	const platform = options.platform ?? process.platform;
	const mode = options.interactionMode ?? "agent";
	const web = options.web ?? true;
	const rag = options.rag ?? false;
	switch (mode) {
		case "plan":
			return buildPlanPrompt(options.cwd, platform, web, rag);
		case "chat":
			return buildChatPrompt(options.cwd, platform, web, rag);
		default:
			return buildAgentPrompt(options.cwd, platform, web, rag);
	}
}

/** Estimated tokens for the part sent with every request: the system prompt and the tool definitions. */
export function estimateFixedPromptTokens(systemPrompt: string, tools: readonly AgentTool[]): number {
	return estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(toChatTools(tools)));
}
