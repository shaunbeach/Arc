import { basename } from "node:path";
import type { SessionEntry } from "../session.ts";
import { addUsage, NO_USAGE, type TokenUsage } from "../usage.ts";
import type { SupervisorState } from "./supervisor.ts";

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
}

export interface RunReport {
	plan: string;
	phases: PhaseReport[];
	startedAt: number;
	endedAt: number;
	status: SupervisorState["status"];
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
	now = Date.now(),
): RunReport | undefined {
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
			if (reachedVerdict) phase.audits++;
		}
		phase.critic = minus((next ?? saves[i]).state.criticUsage ?? NO_USAGE, phase.criticAtStart);
		if (next && next.state.phase !== state.phase) phase.result = "passed";
		else if (!next) {
			phase.result = state.status === "done" ? "passed" : state.status === "running" ? "running" : state.status;
		}
	}

	const report: PhaseReport[] = [];
	for (const { criticAtStart: _, ...phase } of phases.values()) {
		let actor = NO_USAGE;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const { timestamp, usage } = entry.message;
			if (timestamp < phase.startedAt || timestamp > phase.endedAt || usage.promptTokens === 0) continue;
			actor = addUsage(actor, {
				requests: 1,
				input: usage.promptTokens,
				cached: usage.cachedTokens,
				output: usage.completionTokens,
			});
		}
		report.push({ ...phase, actor });
	}
	return {
		plan: last.state.plan,
		phases: report,
		startedAt: saves[0].timestamp,
		endedAt: report.at(-1)?.endedAt ?? last.timestamp,
		status: last.state.status,
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
		actor: report.phases.reduce((total, phase) => addUsage(total, phase.actor), NO_USAGE),
		critic: report.phases.reduce((total, phase) => addUsage(total, phase.critic), NO_USAGE),
	};
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
	return `${lines.join("\n")}\n`;
}
