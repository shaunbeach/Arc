import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolLimits } from "./options.ts";
import { type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Temp file holding the complete output, once it outgrew the limits or `saveAfterLines`. */
	fullOutputPath?: string;
}

/**
 * Collects streaming command output in bounded memory: it keeps a decoded tail for display and, once the output
 * outgrows the limits or runs past `saveAfterLines`, writes the complete raw output to a temp file instead of holding
 * it. The file outlives the result: once trimming cuts the result from the model's context, the model can still
 * search the file rather than run the command again.
 */
export class OutputBuffer {
	private readonly limits: ToolLimits;
	private readonly maxTailBytes: number;
	private readonly decoder = new TextDecoder();
	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private finished = false;
	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private readonly saveAfterLines: number;

	constructor(limits: ToolLimits, options: { saveAfterLines?: number } = {}) {
		this.limits = limits;
		this.maxTailBytes = Math.max(limits.maxBytes * 2, 1);
		this.saveAfterLines = options.saveAfterLines ?? Number.POSITIVE_INFINITY;
	}

	append(data: Buffer): void {
		if (this.finished) throw new Error("Cannot append to a finished output buffer");
		this.totalRawBytes += data.length;
		this.appendText(this.decoder.decode(data, { stream: true }));
		if (this.tempFileStream || this.worthSaving()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.appendText(this.decoder.decode());
		if (this.worthSaving()) this.ensureTempFile();
	}

	snapshot(): OutputSnapshot {
		const tail = truncateTail(this.snapshotText(), this.limits);
		const truncated = this.outgrewLimits();
		const truncation: TruncationResult = {
			...tail,
			truncated,
			truncatedBy: truncated
				? (tail.truncatedBy ?? (this.totalDecodedBytes > this.limits.maxBytes ? "bytes" : "lines"))
				: null,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
		};
		return { content: tail.content, truncation, fullOutputPath: this.tempFilePath };
	}

	async closeTempFile(): Promise<void> {
		const stream = this.tempFileStream;
		if (!stream) return;
		this.tempFileStream = undefined;
		await new Promise<void>((resolve, reject) => {
			stream.once("error", reject);
			stream.end(resolve);
		});
	}

	private appendText(text: string): void {
		if (text.length === 0) return;
		const bytes = Buffer.byteLength(text, "utf8");
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxTailBytes * 2) this.trimTail();

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		this.completedLines += newlines;
		// Text after the last newline (all of it when there is none) leaves a line open.
		const openLine = lastNewline < text.length - 1;
		this.totalLines = this.completedLines + (openLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf8");
		let start = buffer.length - this.maxTailBytes;
		if (start <= 0) {
			this.tailBytes = buffer.length;
			return;
		}
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf8");
		this.tailBytes = buffer.length - start;
	}

	/** The tail, starting at a line boundary so the first displayed line is complete. */
	private snapshotText(): string {
		if (this.tailStartsAtLineBoundary) return this.tailText;
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private outgrewLimits(): boolean {
		return (
			this.totalRawBytes > this.limits.maxBytes ||
			this.totalDecodedBytes > this.limits.maxBytes ||
			this.totalLines > this.limits.maxLines
		);
	}

	private worthSaving(): boolean {
		return this.outgrewLimits() || this.totalLines > this.saveAfterLines;
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return;
		this.tempFilePath = join(tmpdir(), `pi-lite-bash-${randomBytes(8).toString("hex")}.log`);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
		this.rawChunks = [];
	}
}
