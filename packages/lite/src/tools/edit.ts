import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { isElisionPlaceholder } from "../context.ts";
import { applyEdit, detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings } from "./edit-diff.ts";
import type { CodingToolOptions } from "./options.ts";
import { resolveExistingToolPath, similarNamesHint } from "./path-utils.ts";

const editSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	oldText: Type.String({ description: "Exact text to replace; must occur once" }),
	newText: Type.String({ description: "Replacement text" }),
});

export interface EditToolDetails {
	/** Line-numbered diff for display. */
	diff: string;
	firstChangedLine?: number;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const OLD_TEXT_KEYS = ["oldText", "old_text", "old_string", "oldString", "old_str"];
const NEW_TEXT_KEYS = ["newText", "new_text", "new_string", "newString", "new_str"];

/**
 * Accept argument shapes that models trained on other harnesses send: snake_case names, and a pi-style `edits`
 * array (or its JSON string) holding one replacement.
 */
function prepareEditArguments(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const record: Record<string, unknown> = { ...(args as Record<string, unknown>) };

	let edits = record.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			// Leave it for validation to report.
		}
	}
	if (Array.isArray(edits)) {
		if (edits.length > 1) {
			throw new Error("edit takes one replacement per call. Send each change as a separate edit call.");
		}
		edits = edits[0];
	}
	if (typeof edits === "object" && edits !== null) Object.assign(record, edits);

	const pick = (keys: readonly string[]) => keys.map((key) => record[key]).find((value) => typeof value === "string");
	const prepared: Record<string, unknown> = {};
	for (const [key, aliases] of [
		["path", PATH_KEYS],
		["oldText", OLD_TEXT_KEYS],
		["newText", NEW_TEXT_KEYS],
	] as const) {
		const value = pick(aliases);
		if (value !== undefined) prepared[key] = value;
	}
	return prepared;
}

export function createEditTool(options: CodingToolOptions): AgentTool<typeof editSchema, EditToolDetails> {
	return {
		name: "edit",
		label: "edit",
		description: "Replace one exact, unique block of text in a file. Read the file first.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, { path, oldText, newText }, signal) {
			if (isElisionPlaceholder(oldText) || isElisionPlaceholder(newText)) {
				throw new Error(
					"oldText or newText is a placeholder for text elided from your context. Read the file and send the exact text.",
				);
			}
			const absolutePath = resolveExistingToolPath(path, options.cwd);
			const raw = await readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
				throw new Error(
					error.code === "ENOENT"
						? `Cannot edit ${path}: file not found.${similarNamesHint(path, options.cwd)}`
						: `Cannot edit ${path}: ${error.message}`,
				);
			});
			signal?.throwIfAborted();

			// Models never include an invisible byte order mark in oldText, and they write LF line endings.
			const bom = raw.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
			const content = raw.slice(bom.length);
			const normalized = normalizeToLF(content);
			const updated = applyEdit(normalized, oldText, newText, path);
			await writeFile(absolutePath, bom + restoreLineEndings(updated, detectLineEnding(content)), "utf8");

			const { diff, firstChangedLine } = generateDiffString(normalized, updated);
			const where = firstChangedLine === undefined ? "" : ` at line ${firstChangedLine}`;
			return {
				content: [{ type: "text", text: `Edited ${path}${where}. Do not repeat its contents in your reply.` }],
				details: { diff, firstChangedLine },
			};
		},
	};
}
