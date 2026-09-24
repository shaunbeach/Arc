import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "../tools/child-process.ts";
import type { ToolLimits } from "../tools/options.ts";
import { OutputBuffer } from "../tools/output-buffer.ts";

/** Each check's output is cut to its end, about 2k tokens: the actor reads it in a 20k window after a failure. */
export const CHECK_OUTPUT_LIMITS: ToolLimits = { maxLines: 200, maxBytes: 6 * 1024 };
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const IMAGE = /\.(png|jpe?g|webp)$/i;
/** Directories the screenshot search never enters. */
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "vendor", "__pycache__"]);
const MAX_SCREENSHOTS = 4;
const MAX_ENTRIES_SCANNED = 50_000;

export interface CheckResult {
	command: string;
	/** null when a signal ended the command, including a timeout. */
	exitCode: number | null;
	timedOut: boolean;
	/** The end of the command's output, with where the full output was saved when it was cut. */
	output: string;
	ms: number;
}

export interface GateResult {
	passed: boolean;
	/** The checks that ran, in order. The first failure stops the gate, so later ones are missing. */
	checks: CheckResult[];
	/** Images the checks wrote, newest first, for the critic. */
	screenshots: string[];
}

export interface GateOptions {
	signal?: AbortSignal;
	/** Per command. Default: 15 minutes. */
	timeoutMs?: number;
	onCheck?: (command: string) => void;
}

export function checkPassed(check: CheckResult): boolean {
	return check.exitCode === 0 && !check.timedOut;
}

/**
 * Run a phase's verify commands in `cwd`, one at a time, stopping at the first failure: later checks usually depend
 * on earlier ones, such as tests on a build. A UI test that saves screenshots needs nothing special: every image file
 * the checks write is found afterwards and handed to the critic.
 */
export async function runChecks(
	commands: readonly string[],
	cwd: string,
	options: GateOptions = {},
): Promise<GateResult> {
	const started = Date.now();
	const checks: CheckResult[] = [];
	for (const command of commands) {
		options.signal?.throwIfAborted();
		options.onCheck?.(command);
		const output = new OutputBuffer(CHECK_OUTPUT_LIMITS, { saveAfterLines: CHECK_OUTPUT_LIMITS.maxLines });
		const commandStarted = Date.now();
		let result: Awaited<ReturnType<typeof runShellCommand>>;
		try {
			result = await runShellCommand(command, cwd, {
				signal: options.signal,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				onData: (data) => output.append(data),
			});
		} finally {
			output.finish();
			await output.closeTempFile();
		}
		const snapshot = output.snapshot();
		let text = snapshot.content.trimEnd();
		if (snapshot.truncation.truncated && snapshot.fullOutputPath) {
			text = `[Last ${snapshot.truncation.outputLines} of ${snapshot.truncation.totalLines} lines. Full output: ${snapshot.fullOutputPath}]\n${text}`;
		}
		const check: CheckResult = {
			command,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			output: text,
			ms: Date.now() - commandStarted,
		};
		checks.push(check);
		if (!checkPassed(check)) break;
	}
	options.signal?.throwIfAborted();
	return { passed: checks.every(checkPassed), checks, screenshots: imagesWrittenSince(cwd, started) };
}

/** Image files under `dir` modified at or after `since`, newest first, skipping dot and dependency directories. */
export function imagesWrittenSince(dir: string, since: number, max = MAX_SCREENSHOTS): string[] {
	const found: { path: string; mtime: number }[] = [];
	const pending = [dir];
	let scanned = 0;
	while (pending.length > 0 && scanned < MAX_ENTRIES_SCANNED) {
		const current = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++scanned > MAX_ENTRIES_SCANNED) break;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) pending.push(path);
			} else if (entry.isFile() && IMAGE.test(entry.name)) {
				try {
					// Filesystem times can trail the clock by a moment; a second of slack keeps a fast check's image.
					const mtime = statSync(path).mtimeMs;
					if (mtime >= since - 1000) found.push({ path, mtime });
				} catch {}
			}
		}
	}
	return found
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, max)
		.map((file) => file.path);
}

/** The gate's result as the actor or the critic reads it. */
export function formatChecks(checks: readonly CheckResult[]): string {
	if (checks.length === 0) return "No checks are defined for this phase.";
	return checks
		.map((check) => {
			const status = check.timedOut
				? `timed out after ${Math.round(check.ms / 1000)}s`
				: `exit code ${check.exitCode ?? "none (killed by a signal)"}`;
			return `$ ${check.command}\n[${status}]\n${check.output || "(no output)"}`;
		})
		.join("\n\n");
}
