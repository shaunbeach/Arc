import type { ToolLimits } from "./options.ts";

export interface TruncationResult {
	content: string;
	truncated: boolean;
	/** Which limit was hit, or null when nothing was cut. */
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	/** Complete lines in `content`. */
	outputLines: number;
	outputBytes: number;
	/** Tail truncation only: the single kept line was cut from its start. */
	lastLinePartial: boolean;
	/** Head truncation only: the first line alone is over the byte limit, so `content` is empty. */
	firstLineExceedsLimit: boolean;
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function untruncated(content: string, totalLines: number, totalBytes: number): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/** Keep the first lines that fit both limits. Never returns a partial line. For file reads. */
export function truncateHead(content: string, limits: ToolLimits): TruncationResult {
	const { maxLines, maxBytes } = limits;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLines(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) return untruncated(content, totalLines, totalBytes);

	if (Buffer.byteLength(lines[0], "utf8") > maxBytes) {
		return {
			...untruncated("", totalLines, totalBytes),
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			outputBytes: 0,
			firstLineExceedsLimit: true,
		};
	}

	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf8") + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(lines[i]);
		bytes += lineBytes;
	}
	const output = kept.join("\n");
	return {
		...untruncated(output, totalLines, totalBytes),
		truncated: true,
		truncatedBy,
		outputLines: kept.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
	};
}

/** Cut a string to its last `maxBytes` bytes without splitting a UTF-8 character. */
function lastBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

/** Keep the last lines that fit both limits. For command output, where errors and results come last. */
export function truncateTail(content: string, limits: ToolLimits): TruncationResult {
	const { maxLines, maxBytes } = limits;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLines(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) return untruncated(content, totalLines, totalBytes);

	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const lineBytes = Buffer.byteLength(lines[i], "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (kept.length === 0) {
				const partial = lastBytes(lines[i], maxBytes);
				kept.unshift(partial);
				lastLinePartial = true;
			}
			break;
		}
		kept.unshift(lines[i]);
		bytes += lineBytes;
	}
	const output = kept.join("\n");
	return {
		...untruncated(output, totalLines, totalBytes),
		truncated: true,
		truncatedBy,
		outputLines: kept.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
		lastLinePartial,
	};
}
