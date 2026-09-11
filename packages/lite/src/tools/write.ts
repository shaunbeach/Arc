import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { isElisionPlaceholder } from "../context.ts";
import type { CodingToolOptions } from "./options.ts";
import { resolveToolPath } from "./path-utils.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	content: Type.String({ description: "Full file content" }),
});

export function createWriteTool(options: CodingToolOptions): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description: "Create or overwrite a file, creating parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, signal) {
			if (isElisionPlaceholder(content)) {
				throw new Error(
					"content is a placeholder for text elided from your context, not file content. Send the complete file content.",
				);
			}
			const absolutePath = resolveToolPath(path, options.cwd);
			signal?.throwIfAborted();
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content, "utf8");
			const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
			return { content: [{ type: "text", text: `Wrote ${lines} line${lines === 1 ? "" : "s"} to ${path}.` }] };
		},
	};
}
