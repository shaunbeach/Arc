import { basename } from "node:path";
import type { SessionEntry } from "../session.ts";
import { addUsage, NO_USAGE, type TokenUsage } from "../usage.ts";
import type { CommitStats } from "./git.ts";
import type { RunInfo, SupervisorState } from "./supervisor.ts";

export interface PhaseReport {
	phase: number;
	title: string;
	startedAt: number;
	endedAt: number;
	/** The actor working inside the loop. */
	actorMs: number;
	/** The checks, the model swaps, and the critic. */
	reviewMs: number;
	/** The actor working on messages typed while the loop was halted or stopped. Counted in the phase, shown apart. */
	manualMs: number;
	/** The loop halted or stopped, waiting for a person. Not counted in the phase's time. */
	waitingMs: number;
	/** Audits that reached a verdict: 1 is a pass on the first try. */
	audits: number;
	result: "passed" | "running" | "halted" | "stopped";
	actor: TokenUsage;
	critic: TokenUsage;
	/** Every verdict, in order: failed tries with their reasons, then the pass. */
	verdicts: { pass: boolean; reasons: string[] }[];
	/** Turns the loop guard ended. */
	guardTrips: number;
	toolCalls: number;
	failedTools: number;
	/** Messages a person typed during the phase. */
	hints: number;
	/** Automatic trims, each followed by a re-read of the prompt. */
	trims: number;
	/** Processes the actor left running, stopped before the checks. */
	leftovers: number;
	/** The actor reading its prompt and writing its replies, from llama-server's speeds. */
	readingMs: number;
	writingMs: number;
	/** What the phase's commit changed. */
	changes?: CommitStats;
}

export interface RunReport {
	plan: string;
	phases: PhaseReport[];
	startedAt: number;
	endedAt: number;
	status: SupervisorState["status"];
	run?: RunInfo;
	modelLoads: { model: string; ms: number }[];
	peakSwapBytes?: number;
}

export interface ReportOptions {
	now?: number;
	/** Files and lines each passed phase's commit changed. */
	stats?: ReadonlyMap<number, CommitStats>;
}

type Saved = { state: SupervisorState; timestamp: number };

function minus(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		requests: a.requests - b.requests,
		input: a.input - b.input,
		cached: a.cached - b.cached,
		output: a.output - b.output,
	};
}

/**
 * The session's latest `/supervise` run, phase by phase, worked out from what the session file already holds: the
 * supervisor saves its state with a timestamp at every step, and each reply carries the tokens llama-server
 * reported. Time between two saves belongs to the earlier one's phase and stage.
 */
export function buildReport(
	entries: readonly SessionEntry[],
	titles: ReadonlyMap<number, string>,
	options: ReportOptions = {},
): RunReport | undefined {
	const now = options.now ?? Date.now();
	const all = entries.flatMap((entry) =>
		entry.type === "supervisor" ? [{ state: entry.state, timestamp: entry.timestamp }] : [],
	);
	const last = all.at(-1);
	if (!last) return undefined;
	const saves: Saved[] = all.filter((save) => save.state.plan === last.state.plan);
	const messageTimes = entries.flatMap((entry) => (entry.type === "message" ? [entry.message.timestamp] : []));

	const phases = new Map<number, PhaseReport & { criticAtStart: TokenUsage }>();
	for (let i = 0; i < saves.length; i++) {
		const { state, timestamp } = saves[i];
		const next = saves[i + 1];
		const end = next ? next.timestamp : state.status === "running" ? now : timestamp;
		let phase = phases.get(state.phase);
		if (!phase) {
			phase = {
				phase: state.phase,
				title: titles.get(state.phase) ?? `Phase ${state.phase}`,
				startedAt: timestamp,
				endedAt: end,
				actorMs: 0,
				reviewMs: 0,
				manualMs: 0,
				waitingMs: 0,
				audits: 0,
				result: "running",
				actor: NO_USAGE,
				critic: NO_USAGE,
				verdicts: [],
				guardTrips: 0,
				toolCalls: 0,
				failedTools: 0,
				hints: 0,
				trims: 0,
				leftovers: 0,
				readingMs: 0,
				writingMs: 0,
				criticAtStart: state.criticUsage ?? NO_USAGE,
			};
			phases.set(state.phase, phase);
		}
		phase.endedAt = end;
		const span = end - timestamp;
		if (state.status === "running") {
			if (state.stage === "actor") phase.actorMs += span;
			else phase.reviewMs += span;
		} else {
			// Halted or stopped: the actor may still have worked on something a person typed.
			const inside = messageTimes.filter((time) => time > timestamp && time <= end);
			const manual = inside.length > 1 ? (inside.at(-1) as number) - (inside[0] as number) : 0;
			phase.manualMs += manual;
			phase.waitingMs += span - manual;
		}
		if (next && state.status === "running" && state.stage === "audit") {
			const reachedVerdict =
				next.state.stage === "actor" || next.state.phase !== state.phase || next.state.status === "done";
			if (reachedVerdict) {
				phase.audits++;
				if (next.state.lastVerdict) phase.verdicts.push(next.state.lastVerdict);
			}
		}
		if (next?.state.stuck && next.state.stuck !== state.stuck) phase.guardTrips++;
		phase.critic = minus((next ?? saves[i]).state.criticUsage ?? NO_USAGE, phase.criticAtStart);
		if (next && next.state.phase !== state.phase) phase.result = "passed";
		else if (!next) {
			phase.result = state.status === "done" ? "passed" : state.status === "running" ? "running" : state.status;
		}
	}

	const report: PhaseReport[] = [];
	for (const { criticAtStart: _, ...phase } of phases.values()) {
		const inPhase = (time: number) => time >= phase.startedAt && time <= phase.endedAt;
		for (const entry of entries) {
			if (entry.type === "event") {
				if (!inPhase(entry.timestamp)) continue;
				if (entry.event.kind === "trim") phase.trims++;
				else if (entry.event.kind === "leftovers") phase.leftovers += entry.event.count;
				continue;
			}
			if (entry.type !== "message" || !inPhase(entry.message.timestamp)) continue;
			const message = entry.message;
			if (message.role === "toolResult") {
				if (message.isError) phase.failedTools++;
			} else if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : "";
				if (!text.startsWith("[Supervisor]")) phase.hints++;
			} else {
				phase.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
				const { usage, timings } = message;
				if (usage.promptTokens === 0) continue;
				phase.actor = addUsage(phase.actor, {
					requests: 1,
					input: usage.promptTokens,
					cached: usage.cachedTokens,
					output: usage.completionTokens,
				});
				if (timings?.promptPerSecond) {
					phase.readingMs += ((usage.promptTokens - usage.cachedTokens) / timings.promptPerSecond) * 1000;
				}
				if (timings?.predictedPerSecond)
					phase.writingMs += (usage.completionTokens / timings.predictedPerSecond) * 1000;
			}
		}
		const changes = options.stats?.get(phase.phase);
		report.push({ ...phase, ...(changes ? { changes } : {}) });
	}
	const startedAt = saves[0].timestamp;
	const endedAt = report.at(-1)?.endedAt ?? last.timestamp;
	const modelLoads: { model: string; ms: number }[] = [];
	let peakSwapBytes: number | undefined;
	for (const entry of entries) {
		if (entry.type !== "event" || entry.timestamp < startedAt || entry.timestamp > endedAt) continue;
		if (entry.event.kind === "model-load") modelLoads.push({ model: entry.event.model, ms: entry.event.ms });
		if (entry.event.kind === "swap") peakSwapBytes = Math.max(peakSwapBytes ?? 0, entry.event.usedBytes);
	}
	const run = saves.find((save) => save.state.run)?.state.run;
	return {
		plan: last.state.plan,
		phases: report,
		startedAt,
		endedAt,
		status: last.state.status,
		...(run ? { run } : {}),
		modelLoads,
		...(peakSwapBytes !== undefined ? { peakSwapBytes } : {}),
	};
}

/** `2h 26m`, `7m`, `45s`. */
export function formatSpan(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const n = (value: number) => value.toLocaleString("en-US");

function totals(report: RunReport) {
	const sum = (pick: (phase: PhaseReport) => number) => report.phases.reduce((total, phase) => total + pick(phase), 0);
	return {
		actorMs: sum((phase) => phase.actorMs),
		reviewMs: sum((phase) => phase.reviewMs),
		manualMs: sum((phase) => phase.manualMs),
		waitingMs: sum((phase) => phase.waitingMs),
		audits: sum((phase) => phase.audits),
		guardTrips: sum((phase) => phase.guardTrips),
		toolCalls: sum((phase) => phase.toolCalls),
		failedTools: sum((phase) => phase.failedTools),
		hints: sum((phase) => phase.hints),
		trims: sum((phase) => phase.trims),
		leftovers: sum((phase) => phase.leftovers),
		readingMs: sum((phase) => phase.readingMs),
		writingMs: sum((phase) => phase.writingMs),
		files: sum((phase) => phase.changes?.files ?? 0),
		added: sum((phase) => phase.changes?.added ?? 0),
		removed: sum((phase) => phase.changes?.removed ?? 0),
		actor: report.phases.reduce((total, phase) => addUsage(total, phase.actor), NO_USAGE),
		critic: report.phases.reduce((total, phase) => addUsage(total, phase.critic), NO_USAGE),
	};
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** One line naming what the run ran on. */
function describeRun(run: RunInfo): string {
	const llama = run.llamaServer ? ` · llama.cpp ${run.llamaServer.replace(/^version:\s*/i, "")}` : "";
	return `${run.actor} (${run.mode}, ponytail ${run.ponytail}) · critic ${run.critic} · Arc ${run.arc}${llama} · ${run.memoryGB} GB, ${run.platform}`;
}

/** Model loads, grouped by model: `Qwen x9 (avg 14s), Ornith x9 (avg 6s)`. */
function describeLoads(loads: RunReport["modelLoads"]): string {
	const byModel = new Map<string, number[]>();
	for (const load of loads) byModel.set(load.model, [...(byModel.get(load.model) ?? []), load.ms]);
	return [...byModel]
		.map(
			([model, times]) =>
				`${model} x${times.length} (avg ${formatSpan(times.reduce((a, b) => a + b, 0) / times.length)})`,
		)
		.join(", ");
}

/** Time a phase took: the actor, manual work, and review; not time spent waiting for a person. */
function worked(phase: Pick<PhaseReport, "actorMs" | "manualMs" | "reviewMs">): number {
	return phase.actorMs + phase.manualMs + phase.reviewMs;
}

/** An aligned table for the terminal. */
export function formatReportText(report: RunReport): string {
	const header = ["Phase", "Time", "Actor", "Review", "Tries", "Actor in", "new", "out", "Critic in"];
	const rows = report.phases.map((phase) => [
		`${phase.phase} ${phase.title}${phase.result === "passed" ? "" : ` (${phase.result})`}`,
		formatSpan(worked(phase)),
		`${formatSpan(phase.actorMs + phase.manualMs)}${phase.manualMs > 0 ? "*" : ""}`,
		formatSpan(phase.reviewMs),
		String(phase.audits),
		n(phase.actor.input),
		n(phase.actor.input - phase.actor.cached),
		n(phase.actor.output),
		n(phase.critic.input),
	]);
	const t = totals(report);
	rows.push([
		"Total",
		formatSpan(worked(t)),
		`${formatSpan(t.actorMs + t.manualMs)}${t.manualMs > 0 ? "*" : ""}`,
		formatSpan(t.reviewMs),
		String(t.audits),
		n(t.actor.input),
		n(t.actor.input - t.actor.cached),
		n(t.actor.output),
		n(t.critic.input),
	]);
	const titleWidth = 30;
	const widths = header.map((_, column) =>
		column === 0 ? titleWidth : Math.max(header[column].length, ...rows.map((row) => row[column].length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, column) => {
				if (column > 0) return cell.padStart(widths[column]);
				const cut = cell.length > titleWidth ? `${cell.slice(0, titleWidth - 3)}...` : cell;
				return cut.padEnd(titleWidth);
			})
			.join("  ");
	const lines = [
		`Supervisor report: ${basename(report.plan)} (${report.status})`,
		line(header),
		...rows.slice(0, -1).map(line),
		line(rows.at(-1) as string[]),
	];
	if (t.manualMs > 0)
		lines.push(`* includes ${formatSpan(t.manualMs)} of work on messages typed while the loop was halted.`);
	if (t.waitingMs > 0) lines.push(`Waiting for you, not counted above: ${formatSpan(t.waitingMs)}.`);
	const events = [
		plural(t.trims, "trim"),
		plural(t.guardTrips, "loop-guard stop"),
		plural(t.hints, "hint"),
		`${plural(t.failedTools, "failed tool call")} of ${n(t.toolCalls)}`,
		...(report.modelLoads.length > 0 ? [`loads: ${describeLoads(report.modelLoads)}`] : []),
		...(report.peakSwapBytes !== undefined ? [`peak swap ${gigabytes(report.peakSwapBytes)}`] : []),
	];
	lines.push(`Events: ${events.join(" · ")}.`);
	if (report.run) lines.push(`Setup: ${describeRun(report.run)}.`);
	return lines.join("\n");
}

/** The report as a Markdown file, for keeping and comparing runs. */
export function formatReportMarkdown(report: RunReport): string {
	const t = totals(report);
	const date = (ms: number) => {
		const d = new Date(ms);
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};
	const passed = report.phases.filter((phase) => phase.result === "passed").length;
	const lines = [
		`# Supervisor report: ${basename(report.plan)}`,
		"",
		`- Run: ${date(report.startedAt)} to ${date(report.endedAt)}, ${report.status}, ${passed} of ${report.phases.length} phases passed`,
		`- Time: ${formatSpan(worked(t))} (actor ${formatSpan(t.actorMs + t.manualMs)}, review ${formatSpan(t.reviewMs)})${t.waitingMs > 0 ? `, plus ${formatSpan(t.waitingMs)} waiting for you` : ""}`,
		`- Actor tokens: ${n(t.actor.input)} in (${n(t.actor.cached)} cached, ${n(t.actor.input - t.actor.cached)} new), ${n(t.actor.output)} out, ${n(t.actor.requests)} requests`,
		`- Critic tokens: ${n(t.critic.input)} in, ${n(t.critic.output)} out, ${n(t.critic.requests)} reviews`,
		"",
		"| Phase | Result | Time | Actor | Review | Tries | Actor in | Actor new | Actor out | Critic in | Critic out |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...report.phases.map(
			(phase) =>
				`| ${phase.phase} ${phase.title.replace(/\|/g, "\\|")} | ${phase.result} | ${formatSpan(worked(phase))} | ${formatSpan(phase.actorMs + phase.manualMs)}${phase.manualMs > 0 ? "\\*" : ""} | ${formatSpan(phase.reviewMs)} | ${phase.audits} | ${n(phase.actor.input)} | ${n(phase.actor.input - phase.actor.cached)} | ${n(phase.actor.output)} | ${n(phase.critic.input)} | ${n(phase.critic.output)} |`,
		),
		`| **Total** | | **${formatSpan(worked(t))}** | ${formatSpan(t.actorMs + t.manualMs)} | ${formatSpan(t.reviewMs)} | ${t.audits} | ${n(t.actor.input)} | ${n(t.actor.input - t.actor.cached)} | ${n(t.actor.output)} | ${n(t.critic.input)} | ${n(t.critic.output)} |`,
		"",
		"Time is from a phase's start to its passed commit, without time the loop spent halted or stopped. Actor is the model working; Review is the checks, both model swaps, and the critic. Tries counts audits that reached a verdict. Actor in counts every prompt token sent with every request, as a hosted provider would bill it; new is the part llama.cpp had to process.",
	];
	if (t.manualMs > 0) {
		lines.push("", `\\* Includes ${formatSpan(t.manualMs)} of work on messages typed while the loop was halted.`);
	}
	const cell = (value: string) => value.replace(/\|/g, "\\|");
	lines.push(
		"",
		"## Work",
		"",
		"| Phase | Files | Lines | Tool calls | Failed | Trims | Loop guard | Hints | Leftovers | Reading | Writing |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...report.phases.map(
			(phase) =>
				`| ${phase.phase} ${cell(phase.title)} | ${phase.changes ? n(phase.changes.files) : ""} | ${phase.changes ? `+${n(phase.changes.added)} / -${n(phase.changes.removed)}` : ""} | ${n(phase.toolCalls)} | ${n(phase.failedTools)} | ${phase.trims} | ${phase.guardTrips} | ${phase.hints} | ${phase.leftovers} | ${formatSpan(phase.readingMs)} | ${formatSpan(phase.writingMs)} |`,
		),
		`| **Total** | ${n(t.files)} | +${n(t.added)} / -${n(t.removed)} | ${n(t.toolCalls)} | ${n(t.failedTools)} | ${t.trims} | ${t.guardTrips} | ${t.hints} | ${t.leftovers} | ${formatSpan(t.readingMs)} | ${formatSpan(t.writingMs)} |`,
		"",
		"Reading and Writing are the actor's time processing prompts and generating replies, from llama-server's measured speeds; the rest of its time is tools and model loads.",
	);
	const failed = report.phases.flatMap((phase) =>
		phase.verdicts.flatMap((verdict, index) =>
			verdict.pass ? [] : [`- Phase ${phase.phase}, try ${index + 1}: ${verdict.reasons.join(" / ")}`],
		),
	);
	lines.push(
		"",
		"## Failed tries",
		"",
		...(failed.length > 0 ? failed : ["None: every phase passed its first audit."]),
	);
	lines.push("", "## Setup and events", "");
	if (report.run) lines.push(`- Setup: ${describeRun(report.run)}`);
	if (report.modelLoads.length > 0) lines.push(`- Model loads: ${describeLoads(report.modelLoads)}`);
	if (report.peakSwapBytes !== undefined) lines.push(`- Peak swap: ${gigabytes(report.peakSwapBytes)}`);
	lines.push(`- Processes the actor left running, stopped before checks: ${t.leftovers}`);
	return `${lines.join("\n")}\n`;
}
