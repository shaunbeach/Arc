import { readdir, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "typebox";
import type { AgentTool, ToolResult } from "../agent/types.ts";
import type { CodingToolOptions, ToolLimits } from "./options.ts";
import { resolveToolPath } from "./path-utils.ts";
import { formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path" }),
	offset: Type.Optional(Type.Integer({ description: "Start line (1-based)" })),
	limit: Type.Optional(Type.Integer({ description: "Max lines" })),
});

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
/** A NUL byte this early means the file is not text. */
const BINARY_SNIFF_BYTES = 8192;

function textResult(text: string, details?: ReadToolDetails): ToolResult<ReadToolDetails> {
	return { content: [{ type: "text", text }], details };
}

async function listDirectory(absolutePath: string): Promise<ToolResult<ReadToolDetails>> {
	const entries = await readdir(absolutePath, { withFileTypes: true });
	if (entries.length === 0) return textResult("(empty directory)");
	const names = entries
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.sort((a, b) => a.localeCompare(b));
	const shown = names.slice(0, MAX_DIRECTORY_ENTRIES).join("\n");
	const hidden = names.length - MAX_DIRECTORY_ENTRIES;
	return textResult(hidden > 0 ? `${shown}\n\n[${hidden} more entries. Use bash to filter.]` : shown);
}

function readText(
	text: string,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	limits: ToolLimits,
): ToolResult<ReadToolDetails> {
	if (text.length === 0) return textResult("(empty file)");
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	const total = lines.length;
	// Values below 1 are treated as "from the start" and "no limit" rather than rejected.
	const start = Math.max(1, offset ?? 1) - 1;
	if (start >= total) throw new Error(`offset ${offset} is past the end of ${path} (${total} lines).`);
	const end = limit === undefined || limit < 1 ? total : Math.min(total, start + limit);

	const truncation = truncateHead(lines.slice(start, end).join("\n"), limits);
	const first = start + 1;
	if (truncation.firstLineExceedsLimit) {
		const size = formatSize(Buffer.byteLength(lines[start], "utf8"));
		return textResult(
			`[Line ${first} is ${size}, over the ${formatSize(limits.maxBytes)} limit. Use bash: sed -n '${first}p' ${path} | cut -c1-2000]`,
			{ truncation },
		);
	}
	if (truncation.truncated) {
		const last = first + truncation.outputLines - 1;
		return textResult(
			`${truncation.content}\n\n[Showing lines ${first}-${last} of ${total}. Use offset=${last + 1} to continue.]`,
			{ truncation },
		);
	}
	if (end < total) {
		return textResult(`${truncation.content}\n\n[${total - end} more lines. Use offset=${end + 1} to continue.]`);
	}
	return textResult(truncation.content);
}

export function createReadTool(options: CodingToolOptions): AgentTool<typeof readSchema, ReadToolDetails> {
	const { limits } = options;
	return {
		name: "read",
		label: "read",
		description: "Read a file or list a directory. Long files are cut off; page with offset and limit.",
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, signal) {
			const absolutePath = resolveToolPath(path, options.cwd);
			const info = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
				throw new Error(error.code === "ENOENT" ? `Not found: ${path}` : `Cannot read ${path}: ${error.message}`);
			});
			signal?.throwIfAborted();
			if (info.isDirectory()) return listDirectory(absolutePath);

			const mimeType = IMAGE_MIME_TYPES[extname(absolutePath).toLowerCase()];
			if (mimeType) {
				const size = formatSize(info.size);
				if (!options.acceptsImages)
					return textResult(`[Image file, ${size}. The current model cannot view images.]`);
				if (info.size > MAX_IMAGE_BYTES) {
					return textResult(`[Image file, ${size}: over ${formatSize(MAX_IMAGE_BYTES)}, not attached.]`);
				}
				const data = (await readFile(absolutePath)).toString("base64");
				return {
					content: [
						{ type: "text", text: `[Image file, ${size}]` },
						{ type: "image", data, mimeType },
					],
				};
			}

			const buffer = await readFile(absolutePath);
			if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
				return textResult(`[Binary file, ${formatSize(buffer.length)}. Not shown.]`);
			}
			return readText(buffer.toString("utf8"), path, offset, limit, limits);
		},
	};
}
