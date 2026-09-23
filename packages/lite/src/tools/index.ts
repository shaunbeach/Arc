import type { AgentTool } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createKbSearchTool } from "./kb-search.ts";
import { type CodingToolOptions, toolLimitsFor } from "./options.ts";
import { createReadTool } from "./read.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWebSearchTool } from "./web-search.ts";
import { createWriteTool } from "./write.ts";

export { killRunningCommands } from "./child-process.ts";
export { networkTimeoutMs } from "./network.ts";
export { type CodingToolOptions, type ToolLimits, toolLimitsFor } from "./options.ts";
export { createWebFetchTool } from "./web-fetch.ts";
export { createWebSearchTool } from "./web-search.ts";

/** The coding tools the harness offers, in the order the system prompt lists them. */
export function createCodingTools(options: CodingToolOptions): AgentTool[] {
	return [
		createReadTool(options),
		createEditTool(options),
		createWriteTool(options),
		createBashTool(options),
		createWebSearchTool(options),
		createWebFetchTool(options),
		...(options.knowledgeBase ? [createKbSearchTool(options.knowledgeBase, options.limits)] : []),
	];
}

/** The tools configured for a model: output caps from its context window, images only if it accepts them. */
export function createToolsForModel(
	model: LiteModel,
	cwd: string,
	options: Pick<CodingToolOptions, "allowLocalNetwork" | "knowledgeBase"> = {},
): AgentTool[] {
	return createCodingTools({
		cwd,
		limits: toolLimitsFor(model.contextWindow, model.maxTokens),
		acceptsImages: model.input.includes("image"),
		allowLocalNetwork: options.allowLocalNetwork,
		knowledgeBase: options.knowledgeBase,
	});
}
