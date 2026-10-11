import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import type { LiteModel } from "../config/models.ts";
import { serverOrigin } from "../llm/server.ts";
import type { CodingToolOptions, SubagentToolOptions } from "./options.ts";
import { formatSize, truncateHead } from "./truncate.ts";

const researchSchema = Type.Object({
	task: Type.String({ description: "What to find out, with any file or symbol names you already know" }),
});

/** Extra time past the subagent's own limit for its report and shutdown, before the parent stops it. */
const GRACE_MS = 2 * 60_000;

/**
 * Whether the subagent's model would use the main model's server. Both run at once, so they need different ports:
 * with the same one, the subagent would find the main model there and refuse to start.
 */
export function subagentSharesServer(main: LiteModel, subagent: LiteModel): boolean {
	return serverOrigin(main.baseUrl) === serverOrigin(subagent.baseUrl);
}

export interface ResearchDependencies {
	/** The program and arguments that run the subagent. Default: this Arc in `--research` mode. */
	command?: (task: string) => { file: string; args: string[] };
}

/**
 * `deep_research`: hand a broad question to a subagent on a small model of its own, which searches and reads in its
 * own context and returns only its report. It runs as a child Arc (`--research`): its bash is read-only, its own
 * limits make it report before it runs long, and a crash or stray llama-server stays in that process.
 */
export function createResearchTool(
	options: Pick<CodingToolOptions, "cwd" | "limits"> & { subagent: SubagentToolOptions },
	dependencies: ResearchDependencies = {},
): AgentTool<typeof researchSchema> {
	const { cwd, limits, subagent } = options;
	const command =
		dependencies.command ??
		((task: string) => ({
			file: process.execPath,
			args: [
				...process.execArgv,
				process.argv[1] ?? "",
				"--research",
				"--no-session",
				`--models=${subagent.configPath}`,
				`--model=${subagent.model.name}`,
				`--print=${task}`,
			],
		}));
	return {
		name: "deep_research",
		label: "research",
		description:
			"Hand a broad question about this codebase to a read-only research subagent. It searches and reads files in its own context and returns only its report. Use it when answering would take many searches or long files; do quick lookups yourself.",
		parameters: researchSchema,
		async execute(_toolCallId, { task }, signal, onUpdate) {
			signal?.throwIfAborted();
			const { file, args } = command(task);
			const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			const stop = () => child.kill("SIGTERM");
			process.once("exit", stop);
			signal?.addEventListener("abort", stop, { once: true });
			let timedOut = false;
			const timer = setTimeout(
				() => {
					timedOut = true;
					stop();
				},
				subagent.timeoutMinutes * 60_000 + GRACE_MS,
			);

			let stdout = "";
			const progress: string[] = [];
			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString("utf8");
			});
			let partial = "";
			child.stderr.on("data", (data: Buffer) => {
				const lines = (partial + data.toString("utf8")).split("\n");
				partial = lines.pop() ?? "";
				progress.push(...lines.filter((line) => line.trim()));
				onUpdate?.({ content: [{ type: "text", text: progress.slice(-3).join("\n") }] });
			});

			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			}).finally(() => {
				clearTimeout(timer);
				process.off("exit", stop);
				signal?.removeEventListener("abort", stop);
			});
			if (partial.trim()) progress.push(partial);

			signal?.throwIfAborted();
			if (timedOut) throw new Error(`The subagent ran past ${subagent.timeoutMinutes} minutes and was stopped.`);
			if (exitCode !== 0) {
				const detail = progress.slice(-5).join("\n") || `exit code ${exitCode}`;
				throw new Error(`The subagent failed:\n${detail}`);
			}

			const report = stdout.trim();
			if (!report) throw new Error("The subagent returned no report.");
			const notes: string[] = [];
			const stopped = progress.find((line) => line.startsWith("Stopped at the"));
			if (stopped) notes.push(`[${stopped} The report may be incomplete.]`);
			const truncation = truncateHead(report, limits);
			if (truncation.truncated) {
				notes.push(
					`[Report truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.]`,
				);
			}
			return { content: [{ type: "text", text: [truncation.content, ...notes].join("\n\n") }] };
		},
	};
}
