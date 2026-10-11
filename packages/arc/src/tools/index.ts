import type { AgentTool } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import { createBashTool } from "./bash.ts";
import { createBrowserTool } from "./browser.ts";
import { createEditTool } from "./edit.ts";
import { createKbSearchTool } from "./kb-search.ts";
import { createMemoryTool } from "./memory.ts";
import { type CodingToolOptions, toolLimitsFor } from "./options.ts";
import { createReadTool } from "./read.ts";
import { createResearchTool, subagentSharesServer } from "./research.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWebSearchTool } from "./web-search.ts";
import { createWriteTool } from "./write.ts";

export { killRunningCommands } from "./child-process.ts";
export { networkTimeoutMs } from "./network.ts";
export { type CodingToolOptions, type ToolLimits, toolLimitsFor } from "./options.ts";
export { subagentSharesServer } from "./research.ts";
export { createWebFetchTool } from "./web-fetch.ts";
export { createWebSearchTool } from "./web-search.ts";

/** Every built-in tool's name, whether or not it is on now. MCP tools with one of these names are renamed. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"edit",
	"write",
	"bash",
	"web_search",
	"web_fetch",
	"browser_capture",
	"deep_research",
	"kb_search",
	"memory",
]);

/** The coding tools the harness offers, in the order the system prompt lists them. */
export function createCodingTools(options: CodingToolOptions): AgentTool[] {
	return [
		createReadTool(options),
		createEditTool(options),
		createWriteTool(options),
		createBashTool(options),
		createWebSearchTool(options),
		createWebFetchTool(options),
		// It returns screenshots, so only a model that accepts images gets it.
		...(options.browser && options.acceptsImages ? [createBrowserTool(options)] : []),
		...(options.subagent ? [createResearchTool({ ...options, subagent: options.subagent })] : []),
		...(options.knowledgeBase ? [createKbSearchTool(options.knowledgeBase, options.limits)] : []),
		...(options.memory ? [createMemoryTool(options.memory.wing, options.limits)] : []),
	];
}

/** The tools configured for a model: output caps from its context window, images only if it accepts them. */
export function createToolsForModel(
	model: LiteModel,
	cwd: string,
	options: Pick<
		CodingToolOptions,
		"allowLocalNetwork" | "readAnywhere" | "knowledgeBase" | "memory" | "browser" | "subagent"
	> = {},
): AgentTool[] {
	return createCodingTools({
		cwd,
		limits: toolLimitsFor(model.contextWindow, model.maxTokens),
		acceptsImages: model.input.includes("image"),
		allowLocalNetwork: options.allowLocalNetwork,
		readAnywhere: options.readAnywhere,
		knowledgeBase: options.knowledgeBase,
		memory: options.memory,
		browser: options.browser,
		// The subagent runs beside the main model, so it is offered only when the two use different servers.
		subagent: options.subagent && !subagentSharesServer(model, options.subagent.model) ? options.subagent : undefined,
	});
}
