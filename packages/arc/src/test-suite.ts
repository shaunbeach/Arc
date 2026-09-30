import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LiteModel } from "./config/models.ts";
import type { SamplingMode } from "./config/sampling.ts";
import { serverOrigin } from "./llm/server.ts";

/**
 * `/test` runs the model benchmarks in models.yml's `tests.folder` against the model Arc has loaded. The suites
 * grade the model; the model never runs them, so a weak model cannot misreport its own score.
 *
 * Both suites take the model by its models.yml name. Eval reads Arc's models.yml itself and attaches to the server
 * Arc already started. Work_Bench looks up names it does not list in Arc's models.yml too, and the environment
 * points it at the running server, so no model needs a second entry anywhere.
 */
export const SUITES = ["eval", "workbench"] as const;
export type SuiteName = (typeof SUITES)[number];

export interface TestOptions {
	quick: boolean;
	/** Work_Bench: continue its latest interrupted run. Eval resumes a same-day run by itself. */
	resume: boolean;
}

export interface SuiteCommand {
	suite: SuiteName;
	/** How the transcript names the suite. */
	title: string;
	cwd: string;
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Parses `/test` arguments: suites (`all` is both), then `quick` and `resume` in any order. */
export function parseTestArgs(args: string): { suites: SuiteName[]; options: TestOptions } | { error: string } {
	const words = args.toLowerCase().split(/\s+/).filter(Boolean);
	const suites: SuiteName[] = [];
	const options: TestOptions = { quick: false, resume: false };
	for (const word of words) {
		if (word === "all") suites.push(...SUITES);
		else if (word === "eval") suites.push("eval");
		else if (word === "workbench" || word === "work_bench" || word === "wb") suites.push("workbench");
		else if (word === "quick") options.quick = true;
		else if (word === "resume") options.resume = true;
		else return { error: `Unknown /test argument "${word}". ${TEST_USAGE}` };
	}
	if (suites.length === 0) return { error: TEST_USAGE };
	return { suites: [...new Set(suites)], options };
}

export const TEST_USAGE =
	"Use /test eval, /test workbench, or /test all, with quick for a short run; /test stop ends one.";

/** The command that runs `suite` on `model`, or an error naming what is missing. */
export function suiteCommand(
	folder: string,
	suite: SuiteName,
	model: LiteModel,
	mode: SamplingMode,
	modelsPath: string,
	options: TestOptions,
): SuiteCommand | { error: string } {
	if (suite === "eval") {
		const cwd = join(folder, "Eval");
		if (!existsSync(join(cwd, "src", "cli.ts"))) return { error: `No Eval suite at ${cwd}.` };
		const args = ["src/cli.ts", "run", "-m", model.name, "--mode", mode, "--models", modelsPath];
		if (options.quick) args.push("--quick", "-n", "1");
		return { suite, title: "Eval", cwd, command: process.execPath, args, env: { ...process.env } };
	}
	const cwd = join(folder, "Work_Bench");
	if (!existsSync(join(cwd, "evalctl"))) return { error: `No Work_Bench suite at ${cwd}.` };
	const args = ["run", "--model", model.name];
	args.push(...(options.quick ? ["--profile", "smoke", "-k", "1"] : ["-k", "3"]));
	if (options.resume) args.push("--resume");
	return {
		suite,
		title: "Work_Bench",
		cwd,
		command: join(cwd, "evalctl"),
		args,
		env: {
			...process.env,
			ARC_MODELS: modelsPath,
			// The server as Arc connected to it, which a discovered entry's models.yml line cannot describe.
			EVAL_BASE_URL: serverOrigin(model.baseUrl),
			EVAL_MODEL: model.servedModel ?? model.name,
			EVAL_CONTEXT: String(model.contextWindow),
			PYTHONUNBUFFERED: "1",
		},
	};
}

/** A report path a suite printed, and whether it is the one for this run (rather than a dashboard of all runs). */
export function reportIn(line: string): { path: string; thisRun: boolean } | undefined {
	const match = /^\s*(Run report|report|All-runs dashboard):\s+(\S.*?)\s*$/.exec(line);
	if (!match) return undefined;
	return { path: match[2], thisRun: match[1] !== "All-runs dashboard" };
}

/** What a progress line says, for the status line: a result, or the task starting. */
export function progressIn(line: string): { pass: boolean } | { task: string } | undefined {
	const result = /^(PASS|FAIL) /.exec(line);
	if (result) return { pass: result[1] === "PASS" };
	const task = /^\s*\[(\d+\/\d+)\]\s+(\S+)/.exec(line);
	return task ? { task: `${task[1]} ${task[2]}` } : undefined;
}

export interface SuiteResult {
	code: number | null;
	/** Reports the run printed, this run's first. */
	reports: { path: string; thisRun: boolean }[];
}

/**
 * Run a suite, passing each line of its output to `onLine`, and a line still being written to `onPartial`: Work_Bench
 * names a task, then adds its score to the same line when the task is done. Aborting stops the suite's whole process
 * group: its coding cases start Arc, which may have started servers of its own.
 */
export function runSuite(
	run: SuiteCommand,
	onLine: (line: string) => void,
	signal: AbortSignal,
	onPartial?: (line: string) => void,
): Promise<SuiteResult> {
	return new Promise((resolve) => {
		const reports: SuiteResult["reports"] = [];
		let child: ChildProcess;
		try {
			child = spawn(run.command, run.args, {
				cwd: run.cwd,
				env: run.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
		} catch (error) {
			onLine(`Could not start ${run.title}: ${error instanceof Error ? error.message : String(error)}`);
			resolve({ code: null, reports });
			return;
		}
		const stopGroup = (sig: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, sig);
			} catch {
				// Already gone.
			}
		};
		let forceKill: NodeJS.Timeout | undefined;
		const onAbort = () => {
			stopGroup("SIGTERM");
			forceKill = setTimeout(() => stopGroup("SIGKILL"), 5000);
		};
		const onExit = () => stopGroup("SIGKILL");
		signal.addEventListener("abort", onAbort, { once: true });
		process.once("exit", onExit);

		// Work_Bench prints a task's name, then its score on the same line once it finishes: only whole lines go out.
		const pending = { stdout: "", stderr: "" };
		const take = (stream: "stdout" | "stderr", data: string, flush: boolean) => {
			const text = pending[stream] + data;
			const lines = text.split("\n");
			pending[stream] = flush ? "" : (lines.pop() ?? "");
			for (const line of lines) {
				if (!line.trim()) continue;
				const report = reportIn(line);
				if (report) reports.push(report);
				onLine(line);
			}
			if (pending[stream].trim()) onPartial?.(pending[stream]);
		};
		child.stdout?.setEncoding("utf8").on("data", (data: string) => take("stdout", data, false));
		child.stderr?.setEncoding("utf8").on("data", (data: string) => take("stderr", data, false));
		let settled = false;
		const settle = (code: number | null) => {
			if (settled) return;
			settled = true;
			take("stdout", "", true);
			take("stderr", "", true);
			clearTimeout(forceKill);
			signal.removeEventListener("abort", onAbort);
			process.removeListener("exit", onExit);
			reports.sort((a, b) => Number(b.thisRun) - Number(a.thisRun));
			resolve({ code, reports });
		};
		// A command that cannot start reports an error and may never close.
		child.on("error", (error) => {
			onLine(`Could not start ${run.title}: ${error.message}`);
			settle(null);
		});
		child.on("close", (code) => settle(code));
	});
}

/** Open a report in the default browser. Quietly does nothing where there is no opener. */
export function openReport(path: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
	if (!opener || !existsSync(path)) return;
	const child = spawn(opener, [path], { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}
