import { isAbsolute, relative } from "node:path";
import type { Message, TextContent, ToolCall, ToolResultMessage, UserMessage } from "./llm/types.ts";

/** Most characters a work log may take, about 300 tokens. */
const MAX_LOG_CHARS = 900;
/** Files named in the line about earlier tasks. */
const EARLIER_FILES_SHOWN = 5;

const TEST_COMMAND = /\b(npm (run )?test|npx (vitest|jest)|vitest|jest|pytest|cargo test|go test|make test)\b/;
const TEST_SUMMARY = /\b\d+\s+(passed|failed)\b/i;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

interface FileWork {
	writes: number;
	edits: number;
	/** Line count of the last write. */
	lines?: number;
	lastFailed: boolean;
}

/** Which transcript messages a request leaves out, and where the current task starts. */
export interface LeftOut {
	/** Messages before this index belong to earlier tasks the request no longer carries. */
	earlierBefore: number;
	/** Steps of the current task the request leaves out: `[from, to)`. Empty when `from >= to`. */
	from: number;
	to: number;
}

function resultText(message: ToolResultMessage | undefined): string {
	return (message?.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function lineCount(text: string): number {
	return text.split("\n").length;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Files a shell command clearly writes through a redirect or tee. Anything less clear is left out. */
export function redirectTargets(command: string): string[] {
	const firstLine = command.split("\n")[0];
	const targets: string[] = [];
	for (const match of firstLine.matchAll(/(?<![0-9&>=-])>>?\s*(["']?)([^\s"';&|<>()]+)\1/g)) targets.push(match[2]);
	for (const match of firstLine.matchAll(/\btee\s+(?:-a\s+)?(["']?)([^\s"';&|<>()]+)\1/g)) targets.push(match[2]);
	return targets.filter((target) => !target.startsWith("/dev/") && !target.startsWith("&"));
}

/** The last line of test output that reports counts, such as `Tests 2 failed | 47 passed (49)`. */
export function testSummary(output: string): string | undefined {
	const lines = output.replace(ANSI, "").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (TEST_SUMMARY.test(lines[i])) return lines[i].replace(/\s+/g, " ").trim().slice(0, 100);
	}
	return undefined;
}

function exitCode(result: ToolResultMessage | undefined): string {
	if (!result?.isError) return "0";
	return /Command exited with code (\S+)/.exec(resultText(result))?.[1] ?? "an error";
}

/** Shows `path` relative to the working directory when it is inside it, as the model's tools accept it. */
function display(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	if (!rel) return ".";
	return !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function describeFile(path: string, work: FileWork): string {
	const details: string[] = [];
	if (work.writes > 0 && work.lines !== undefined) details.push(plural(work.lines, "line"));
	if (work.writes > 1) details.push(`written ${plural(work.writes, "time")}`);
	if (work.edits > 0)
		details.push(work.writes > 0 ? `edited ${plural(work.edits, "time")}` : plural(work.edits, "edit"));
	if (work.lastFailed) details.push(work.writes + work.edits > 1 ? "last one failed" : "it failed");
	return details.length > 0 ? `${path} (${details.join(", ")})` : path;
}

/** Lists up to `max` items and says how many more there are. */
function listed(items: readonly string[], max = items.length): string {
	const shown = items.slice(0, max).join(", ");
	return items.length > max ? `${shown}, and ${items.length - max} more` : shown;
}

/**
 * A short account of the work a request leaves out, built from tool calls without asking a model. Trimming drops
 * whole steps and turns, and with them the only record that a file was written or a test run failed; without that
 * record a small model writes the same file again. Returns undefined when nothing worth reporting was left out.
 */
export function buildWorkLog(messages: readonly Message[], leftOut: LeftOut, cwd: string): string | undefined {
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const isLeftOut = (index: number) => index < leftOut.earlierBefore || (index >= leftOut.from && index < leftOut.to);

	const files = new Map<string, FileWork>();
	const earlierFiles = new Set<string>();
	const reads = new Set<string>();
	const bashWrites = new Set<string>();
	let lastTest: { call: ToolCall; index: number } | undefined;

	messages.forEach((message, index) => {
		if (message.role !== "assistant") return;
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			const args = call.arguments;
			const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
			const command = call.name === "bash" ? text("command") : "";
			if (TEST_COMMAND.test(command.split("\n")[0])) lastTest = { call, index };
			if (!isLeftOut(index)) continue;

			const path = display(text("path") || text("file_path"), cwd);
			// Redirects outside the project, such as `> /tmp/server.log`, capture output rather than change files.
			const changed =
				call.name === "write" || call.name === "edit"
					? [path]
					: redirectTargets(command)
							.map((target) => display(target, cwd))
							.filter((target) => !isAbsolute(target));
			if (index < leftOut.earlierBefore) {
				for (const file of changed) if (file) earlierFiles.add(file);
				continue;
			}
			const failed = results.get(call.id)?.isError === true;
			if ((call.name === "write" || call.name === "edit") && path) {
				const work = files.get(path) ?? { writes: 0, edits: 0, lastFailed: false };
				if (call.name === "write") {
					work.writes++;
					if (!failed) work.lines = lineCount(text("content"));
				} else {
					work.edits++;
				}
				work.lastFailed = failed;
				files.set(path, work);
			} else if (call.name === "read" && path) {
				reads.add(path);
			} else {
				for (const target of changed) bashWrites.add(target);
			}
		}
	});

	const written = [...files].filter(([, work]) => work.writes > 0);
	const edited = [...files].filter(([, work]) => work.writes === 0);
	const touched = new Set([...files.keys(), ...bashWrites]);
	// A Markdown file the model only read is most likely the plan it works from.
	const plans = [...reads].filter((path) => path.endsWith(".md") && !touched.has(path));
	const onlyRead = [...reads].filter((path) => !touched.has(path) && !plans.includes(path));

	let testLine: string | undefined;
	if (lastTest && isLeftOut(lastTest.index)) {
		const result = results.get(lastTest.call.id);
		const command = (lastTest.call.arguments.command as string).split("\n")[0].slice(0, 80);
		const summary = testSummary(resultText(result));
		testLine = `Last test run: \`${command}\`, exited with code ${exitCode(result)}${summary ? `: "${summary}"` : ""}`;
	}

	const build = (maxWritten: number, withReads: boolean): string | undefined => {
		const lines: string[] = [];
		if (written.length > 0) {
			lines.push(
				`- Wrote: ${listed(
					written.map(([path, work]) => describeFile(path, work)),
					maxWritten,
				)}`,
			);
		}
		if (edited.length > 0) {
			lines.push(
				`- Edited: ${listed(
					edited.map(([path, work]) => describeFile(path, work)),
					maxWritten,
				)}`,
			);
		}
		if (bashWrites.size > 0) lines.push(`- Changed through bash: ${listed([...bashWrites], maxWritten)}`);
		if (plans.length > 0) lines.push(`- Plan: ${plans.join(", ")}`);
		if (withReads && onlyRead.length > 0) lines.push(`- Read: ${onlyRead.join(", ")}`);
		if (testLine) lines.push(`- ${testLine}`);
		if (earlierFiles.size > 0) {
			lines.push(
				`- Earlier tasks in this session changed ${plural(earlierFiles.size, "file")}: ${listed([...earlierFiles], EARLIER_FILES_SHOWN)}`,
			);
		}
		if (lines.length === 0) return undefined;
		return `(Work so far, from steps left out to save context:\n${lines.join("\n")}\nThe files are on disk as last written; read one again before changing it.)`;
	};

	// Over the limit, reads go first, then long file lists shrink.
	let log = build(Number.POSITIVE_INFINITY, true);
	if (log && log.length > MAX_LOG_CHARS) log = build(Number.POSITIVE_INFINITY, false);
	for (let max = 8; log && log.length > MAX_LOG_CHARS && max >= 1; max = Math.floor(max / 2)) log = build(max, false);
	return log;
}

/** `message` with the work log after its text. The request carries it; the transcript does not. */
export function withWorkLog(message: UserMessage, log: string): UserMessage {
	const content =
		typeof message.content === "string"
			? `${message.content}\n\n${log}`
			: [...message.content, { type: "text" as const, text: log }];
	return { ...message, content };
}
