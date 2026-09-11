import type { AgentTool } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { type CodingToolOptions, toolLimitsFor } from "./options.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export { killRunningCommands } from "./child-process.ts";
export { type CodingToolOptions, type ToolLimits, toolLimitsFor } from "./options.ts";

/** The four tools the harness offers, in the order the system prompt lists them. */
export function createCodingTools(options: CodingToolOptions): AgentTool[] {
	return [createReadTool(options), createEditTool(options), createWriteTool(options), createBashTool(options)];
}

/** The tools configured for a model: output caps from its context window, images only if it accepts them. */
export function createToolsForModel(model: LiteModel, cwd: string): AgentTool[] {
	return createCodingTools({
		cwd,
		limits: toolLimitsFor(model.contextWindow),
		acceptsImages: model.input.includes("image"),
	});
}
