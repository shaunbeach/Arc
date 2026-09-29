import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "typebox";
import type { AgentTool, ToolResult } from "../agent/types.ts";
import type { CodingToolOptions, ToolLimits } from "./options.ts";
import { resolveExistingToolPath, similarNamesHint } from "./path-utils.ts";
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
/** Above this size, a file is read only up to the requested page instead of loaded whole. */
const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

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

/**
 * The lines of a file from line `skip` (0-based), read a chunk at a time. Skipped lines are only counted, so paging
 * deep into a file stays fast. A line longer than `maxLineBytes` comes back as undefined, so one huge line (minified
 * JSON, say) never has to fit in memory. Lines end like `split` after dropping a final newline. `seen.lines` counts
 * every line passed, skipped or yielded, so a caller can tell how long a file was that ended before `skip`.
 */
async function* fileLines(
	file: FileHandle,
	skip: number,
	maxLineBytes: number,
	seen: { lines: number },
	signal: AbortSignal | undefined,
): AsyncGenerator<string | undefined> {
	const buffer = Buffer.alloc(CHUNK_BYTES);
	let parts: Buffer[] = [];
	let bytes = 0;
	let over = false;
	/** Whether the current line has begun, kept or skipped, and is not yet counted. */
	let open = false;
	const line = () => {
		const text = over ? undefined : Buffer.concat(parts).toString("utf8");
		parts = [];
		bytes = 0;
		over = false;
		open = false;
		seen.lines++;
		return text;
	};
	while (true) {
		signal?.throwIfAborted();
		const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null);
		if (bytesRead === 0) break;
		const chunk = buffer.subarray(0, bytesRead);
		let from = 0;
		while (seen.lines < skip && from < bytesRead) {
			const newline = chunk.indexOf(0x0a, from);
			if (newline === -1) {
				open = true;
				from = bytesRead;
			} else {
				seen.lines++;
				open = false;
				from = newline + 1;
			}
		}
		if (from >= bytesRead) continue;
		for (let newline = chunk.indexOf(0x0a, from); ; newline = chunk.indexOf(0x0a, from)) {
			const end = newline === -1 ? bytesRead : newline;
			if (end > from) open = true;
			if (!over && bytes + end - from > maxLineBytes) over = true;
			if (!over) {
				parts.push(Buffer.from(chunk.subarray(from, end)));
				bytes += end - from;
			}
			if (newline === -1) break;
			from = newline + 1;
			yield line();
		}
	}
	if (open) {
		if (seen.lines < skip) seen.lines++;
		else yield line();
	}
}

/**
 * A page of a large file. Reading a 500MB log whole to return its first 50KB would take 500MB of memory next to
 * the model, so this reads from the start only until the page is full. The total line count is known only when the
 * page reaches the end, so the hints name the file size instead.
 */
async function readLargeText(
	file: FileHandle,
	path: string,
	size: number,
	offset: number | undefined,
	limit: number | undefined,
	limits: ToolLimits,
	signal: AbortSignal | undefined,
): Promise<ToolResult<ReadToolDetails>> {
	const start = Math.max(1, offset ?? 1) - 1;
	const wanted = limit === undefined || limit < 1 ? Number.POSITIVE_INFINITY : limit;
	const kept: string[] = [];
	let keptBytes = 0;
	const seen = { lines: 0 };
	let cut = false;
	for await (const text of fileLines(file, start, limits.maxBytes, seen, signal)) {
		const lineBytes = text === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(text, "utf8") + 1;
		if (kept.length >= wanted || kept.length >= limits.maxLines || keptBytes + lineBytes > limits.maxBytes + 1) {
			cut = true;
			break;
		}
		kept.push(text as string);
		keptBytes += lineBytes;
	}
	if (start >= seen.lines) throw new Error(`offset ${offset} is past the end of ${path} (${seen.lines} lines).`);
	const first = start + 1;
	if (kept.length === 0) {
		return textResult(
			`[Line ${first} is over the ${formatSize(limits.maxBytes)} limit. Use bash: sed -n '${first}p' ${path} | cut -c1-2000]`,
		);
	}
	const content = kept.join("\n");
	if (!cut) return textResult(content);
	const last = first + kept.length - 1;
	return textResult(
		`${content}\n\n[Showing lines ${first}-${last} of a ${formatSize(size)} file. Use offset=${last + 1} to continue.]`,
	);
}

export function createReadTool(options: CodingToolOptions): AgentTool<typeof readSchema, ReadToolDetails> {
	const { limits } = options;
	return {
		name: "read",
		label: "read",
		// Models that can see images have no other way to learn it: without this they reach for OCR through bash,
		// or refuse outright. Only image models pay the extra tokens, so the text-only prompt stays byte-identical.
		description: options.acceptsImages
			? "Read a file or list a directory. Long files are cut off; page with offset and limit. Reading an image (png, jpg, gif, webp) attaches it for you to look at directly."
			: "Read a file or list a directory. Long files are cut off; page with offset and limit.",
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, signal) {
			const absolutePath = resolveExistingToolPath(path, options.cwd);
			const info = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw new Error(`Cannot read ${path}: ${error.message}`);
				const hint = similarNamesHint(path, options.cwd);
				throw new Error(hint ? `Not found: ${path}.${hint}` : `Not found: ${path}`);
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

			if (info.size > LARGE_FILE_BYTES) {
				const file = await open(absolutePath);
				try {
					const head = Buffer.alloc(BINARY_SNIFF_BYTES);
					const { bytesRead } = await file.read(head, 0, head.length, 0);
					if (head.subarray(0, bytesRead).includes(0)) {
						return textResult(`[Binary file, ${formatSize(info.size)}. Not shown.]`);
					}
					return await readLargeText(file, path, info.size, offset, limit, limits, signal);
				} finally {
					await file.close();
				}
			}

			const buffer = await readFile(absolutePath);
			if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
				return textResult(`[Binary file, ${formatSize(buffer.length)}. Not shown.]`);
			}
			return readText(buffer.toString("utf8"), path, offset, limit, limits);
		},
	};
}
