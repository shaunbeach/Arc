import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { runMempalace } from "../rag/mempalace.ts";
import type { ToolLimits } from "./options.ts";

const memorySchema = Type.Object({
	query: Type.String(),
	wing: Type.Optional(Type.String({ description: "Another project's wing" })),
});

const RESULTS = 5;

/**
 * Search the MemPalace: past sessions, saved when they ended. It searches this project's wing unless the model names
 * another, so a project can recall what was done in a different one.
 */
export function createMemoryTool(projectWing: string | undefined, limits: ToolLimits): AgentTool<typeof memorySchema> {
	return {
		name: "memory",
		label: "memory",
		description: "Search notes from past sessions: decisions, fixes, context. Default: this project.",
		parameters: memorySchema,
		async execute(_toolCallId, { query, wing: named }, signal, onUpdate) {
			const q = query.trim();
			if (!q) throw new Error("query is required.");
			const wing = named?.trim() || projectWing;
			if (!wing) throw new Error("This project has no wing (/mempalace). Pass the wing to search.");
			onUpdate?.({ content: [{ type: "text", text: `Searching memory (${wing}) for "${q}"…` }] });
			const output = (
				await runMempalace(["search", q, "--wing", wing, "--results", String(RESULTS)], signal)
			).trim();
			const text = output || `Nothing in memory matches "${q}".`;
			return {
				content: [{ type: "text", text: text.length > limits.maxBytes ? text.slice(0, limits.maxBytes) : text }],
			};
		},
	};
}
