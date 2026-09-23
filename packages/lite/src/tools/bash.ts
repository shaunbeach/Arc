import { stat } from "node:fs/promises";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { runShellCommand, type ShellRunResult } from "./child-process.ts";
import type { CodingToolOptions } from "./options.ts";
import { OutputBuffer } from "./output-buffer.ts";
import type { TruncationResult } from "./truncate.ts";

/** Output longer than this is also saved to a file, so the model can search it instead of running it again. */
const SAVE_OUTPUT_AFTER_LINES = 30;

const bashSchema = Type.Object({
	command: Type.String({ description: "Command" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export interface BashToolDetails {
	truncation?: TruncationResult;
	/** Complete output, when it was longer than the result shows. */
	fullOutputPath?: string;
}

/** Live output reaches the UI at most this often. */
const UPDATE_INTERVAL_MS = 200;

export function createBashTool(options: CodingToolOptions): AgentTool<typeof bashSchema, BashToolDetails> {
	const { cwd, limits } = options;
	return {
		name: "bash",
		label: "bash",
		description:
			"Run a bash command in the working directory. Returns stdout and stderr; long output keeps the end and saves all of it to a file.",
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
			if (timeout !== undefined && !(timeout > 0)) throw new Error("timeout must be a positive number of seconds.");
			if (command.includes("[elided from context")) {
				throw new Error(
					"command contains a placeholder for text elided from your context, not executable code. Re-read the file or supply the real content.",
				);
			}
			await stat(cwd).catch(() => {
				throw new Error(`Working directory does not exist: ${cwd}`);
			});

			const output = new OutputBuffer(limits, { saveAfterLines: SAVE_OUTPUT_AFTER_LINES });
			let updateTimer: NodeJS.Timeout | undefined;
			let lastUpdate = 0;
			const sendUpdate = () => {
				updateTimer = undefined;
				lastUpdate = Date.now();
				onUpdate?.({ content: [{ type: "text", text: output.snapshot().content }] });
			};

			let result: ShellRunResult;
			try {
				result = await runShellCommand(command, cwd, {
					signal,
					timeoutMs: timeout === undefined ? undefined : timeout * 1000,
					onData: (data) => {
						output.append(data);
						if (onUpdate && !updateTimer) {
							updateTimer = setTimeout(sendUpdate, Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - lastUpdate)));
						}
					},
				});
			} finally {
				clearTimeout(updateTimer);
				output.finish();
				await output.closeTempFile();
			}

			const snapshot = output.snapshot();
			let text = snapshot.content.trimEnd();
			if (snapshot.fullOutputPath) {
				// Name the file even when everything is shown: trimming may cut this result later, and searching the
				// file beats running a slow command, such as a test suite, again.
				const { outputLines, totalLines } = snapshot.truncation;
				const shown = snapshot.truncation.truncated
					? `Showing the last ${outputLines} of ${totalLines} lines. Full output: ${snapshot.fullOutputPath}`
					: `Full output also saved to ${snapshot.fullOutputPath}`;
				const notice = `[${shown}. Search it with grep instead of running the command again.]`;
				text = text ? `${text}\n\n${notice}` : notice;
			}
			const failure = (status: string) => new Error(text ? `${text}\n\n${status}` : status);
			if (signal?.aborted) throw failure("Command aborted");
			if (result.timedOut) throw failure(`Command timed out after ${timeout} seconds`);
			if (result.exitCode !== 0) {
				throw failure(`Command exited with code ${result.exitCode ?? "unknown (killed by a signal)"}`);
			}
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: {
					truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
					fullOutputPath: snapshot.fullOutputPath,
				},
			};
		},
	};
}
