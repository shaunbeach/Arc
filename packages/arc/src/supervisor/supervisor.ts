import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { LiteModel } from "../config/models.ts";
import { addUsage, NO_USAGE, type TokenUsage } from "../usage.ts";
import { askCritic, type Verdict } from "./critic.ts";
import { checkPassed, formatChecks, type GateResult, runChecks } from "./gate.ts";
import { commitPhase, diffBudgetChars, diffSince, filesFromPassedPhases, passedPhases, phaseStartRef } from "./git.ts";
import { nextPhase, type Phase, parsePlan } from "./plan.ts";

/** Files of earlier phases the brief names; more would crowd a small window. */
const EARLIER_FILES_SHOWN = 30;

/**
 * `running`: the loop is working. `stopped`: esc or an abort ended it. `halted`: a phase failed `maxRetries` times, or
 * something broke that needs a person. `done`: every phase passed.
 */
export type SupervisorStatus = "running" | "stopped" | "halted" | "done";

/** Everything a later `/supervise resume` needs, saved in the session file at every step. */
export interface SupervisorState {
	/** Absolute path of the implementation plan. */
	plan: string;
	status: SupervisorStatus;
	/** The phase being worked on. */
	phase: number;
	/** `actor`: the actor gets `message` next (its kickoff when there is none). `audit`: the checks and critic are next. */
	stage: "actor" | "audit";
	message?: string;
	/** Failed audits of this phase since it started or was resumed. */
	failures: number;
	/** Transcript index of the phase's kickoff: requests leave out everything before it. */
	phaseStart?: number;
	/** The commit the phase's diff is taken against. */
	startRef?: string;
	lastVerdict?: Verdict;
	/** Why the loop halted, when it did. */
	haltReason?: string;
	/** Why the loop guard ended the actor's last turn, until the actor has been told. */
	stuck?: string;
	/** What the critic's requests used. The actor's usage is in the transcript. */
	criticUsage?: TokenUsage;
}

export type ActorOutcome = "done" | "aborted" | "error";
/** How an actor turn ended. `stuck`: the loop guard ended it, for the reason given. */
export type ActorResult = ActorOutcome | { stuck: string };

/** What the loop needs from the app. The app owns the agent, the llama-server manager, and the screen. */
export interface SupervisorHost {
	cwd: string;
	maxRetries: number;
	/** Current transcript length: where a fresh phase's kickoff will land. */
	transcriptLength(): number;
	/** Run the actor on `text` until it ends its turn, sending only the transcript from `contextStart` on. */
	runActor(text: string, contextStart: number, signal: AbortSignal): Promise<ActorResult>;
	/** Stop the actor's server and start the critic's; resolves with the critic as launched. */
	loadCritic(signal: AbortSignal): Promise<LiteModel>;
	save(state: SupervisorState): void;
	notice(text: string, tone: "info" | "good" | "bad"): void;
	status(text: string | undefined): void;
	/** Tell a person who is away from the keyboard. */
	notify(text: string): void;
}

export async function readPlan(path: string): Promise<Phase[]> {
	return parsePlan(await readFile(path, "utf8"));
}

/** State for a new run of `plan`: the first phase without a passed commit. Undefined when every phase has passed. */
export async function startState(plan: string, cwd: string): Promise<SupervisorState | undefined> {
	const phase = nextPhase(await readPlan(plan), await passedPhases(cwd));
	if (!phase) return undefined;
	return { plan, status: "stopped", phase: phase.number, stage: "actor", failures: 0 };
}

/** The first message of a phase. It opens a fresh context, so it says everything the actor needs to start. */
export function kickoffMessage(
	phase: Phase,
	phases: readonly Phase[],
	plan: string,
	earlierFiles: readonly string[],
): string {
	const lines = [`[Supervisor] Phase ${phase.number} of ${phases.length}: ${phase.title}`, "", phase.body];
	if (phase.verify.length > 0) {
		lines.push(
			"",
			"When you finish, these checks run:",
			...phase.verify.map((command) => `- ${command}`),
			"Run these exact commands before you end your turn, and do not change what they test.",
		);
	}
	if (earlierFiles.length > 0) {
		const shown = earlierFiles.slice(0, EARLIER_FILES_SHOWN).join(", ");
		const more =
			earlierFiles.length > EARLIER_FILES_SHOWN ? `, and ${earlierFiles.length - EARLIER_FILES_SHOWN} more` : "";
		lines.push("", `Earlier phases built: ${shown}${more}. Read a file before changing it.`);
	}
	lines.push(
		"",
		`The whole plan is in ${plan}. Work on this phase only, and end your turn when it is complete: a reviewer then checks it.`,
	);
	return lines.join("\n");
}

/** What the actor reads after a failed audit. */
export function failureMessage(
	phase: Phase,
	failures: number,
	maxRetries: number,
	verdict: Verdict,
	gate: GateResult,
	stuck?: string,
): string {
	const lines = [`[Supervisor] Phase ${phase.number} failed review (attempt ${failures} of ${maxRetries}).`];
	if (stuck) lines.push("", `Your last turn was stopped because ${stuck}. Try a different approach.`);
	lines.push("", "Reasons:", ...verdict.reasons.map((reason) => `- ${reason}`));
	if (!gate.passed) lines.push("", "Check output:", "", formatChecks(gate.checks));
	lines.push("", "Fix these, then end your turn.");
	return lines.join("\n");
}

function describeCheck(check: GateResult["checks"][number]): string {
	return check.timedOut
		? `Check timed out: ${check.command}`
		: `Check failed with exit code ${check.exitCode ?? "none"}: ${check.command}`;
}

/**
 * The actor-critic loop. Each phase: the actor works until it ends its turn; the phase's checks run; if they pass,
 * the critic judges the diff. A pass commits the phase and starts the next one in a fresh context. A fail sends the
 * reasons back to the actor, which keeps the phase's history; after `maxRetries` fails the loop halts and notifies.
 * Every step is saved first, so a resume picks up where the loop stopped.
 */
export class Supervisor {
	state: SupervisorState;
	private readonly host: SupervisorHost;

	constructor(host: SupervisorHost, state: SupervisorState) {
		this.host = host;
		this.state = state;
	}

	private update(changes: Partial<SupervisorState>): void {
		this.state = { ...this.state, ...changes };
		this.host.save(this.state);
	}

	/** Run until the plan is done, a phase halts, or `signal` aborts. `audit` skips to the checks and critic. */
	async run(signal: AbortSignal, begin?: "audit"): Promise<SupervisorState> {
		const { host } = this;
		// A person looked at a halted phase before resuming it, so it gets its retries back.
		const failures = this.state.status === "halted" ? 0 : this.state.failures;
		this.update({ status: "running", failures, haltReason: undefined, ...(begin ? { stage: begin } : {}) });
		try {
			while (true) {
				const phases = await readPlan(this.state.plan);
				const phase = phases.find((candidate) => candidate.number === this.state.phase);
				if (!phase) throw new Error(`The plan no longer has a phase ${this.state.phase}.`);
				const label = `Phase ${phase.number}/${phases.length}`;

				if (this.state.stage === "actor") {
					if (this.state.message === undefined) {
						const earlier = await filesFromPassedPhases(host.cwd, signal);
						const plan = relative(host.cwd, this.state.plan) || this.state.plan;
						this.update({
							startRef: await phaseStartRef(host.cwd, signal),
							phaseStart: host.transcriptLength(),
							message: kickoffMessage(phase, phases, plan, earlier),
						});
						host.notice(`Supervisor: ${label}, ${phase.title}.`, "info");
					}
					const message = this.state.message ?? "";
					const outcome = await host.runActor(message, this.state.phaseStart ?? 0, signal);
					if (typeof outcome === "object") {
						// The loop guard ended the turn: check what the actor has so far, and fail it with the output.
						host.notice(`${label}: stopped the actor because ${outcome.stuck}. Checking the phase now.`, "bad");
						this.update({ stage: "audit", message: undefined, stuck: outcome.stuck });
					} else if (outcome !== "done") {
						const reason = outcome === "aborted" ? "the actor's turn was aborted" : "the actor's turn failed";
						this.update({ message: `[Supervisor] Continue phase ${phase.number}, then end your turn.` });
						if (outcome === "error") return this.halt(`${label}: ${reason}.`);
						this.update({ status: "stopped" });
						host.notice(`Supervisor stopped: ${reason}. /supervise resume continues.`, "info");
						return this.state;
					} else {
						this.update({ stage: "audit", message: undefined });
					}
				}

				host.status(`${label}: running checks`);
				const gate = await runChecks(phase.verify, host.cwd, {
					signal,
					onCheck: (command) => host.status(`${label}: ${command}`),
				});
				let verdict: Verdict;
				if (!gate.passed) {
					verdict = {
						pass: false,
						reasons: gate.checks.filter((check) => !checkPassed(check)).map(describeCheck),
					};
					host.notice(`${label}: ${verdict.reasons[0]}. Skipping the critic.`, "bad");
				} else {
					host.status(`${label}: loading the critic`);
					const critic = await host.loadCritic(signal);
					host.status(`${label}: the critic is reviewing`);
					const diff = await diffSince(
						host.cwd,
						this.state.startRef ?? (await phaseStartRef(host.cwd, signal)),
						diffBudgetChars(critic.contextWindow),
						signal,
					);
					if (diff.truncated.length > 0) {
						host.notice(`${label}: diffs cut to fit the critic: ${diff.truncated.join(", ")}.`, "info");
					}
					const answer = await askCritic(
						critic,
						{
							phase,
							phaseCount: phases.length,
							diff: diff.text,
							checks: gate.checks,
							screenshots: gate.screenshots,
						},
						{ signal },
					);
					verdict = { pass: answer.pass, reasons: answer.reasons };
					this.update({ criticUsage: addUsage(this.state.criticUsage ?? NO_USAGE, answer.usage) });
				}
				host.status(undefined);

				if (verdict.pass) {
					await commitPhase(host.cwd, phase.number, phase.title, signal);
					host.notice(`${label} passed and was committed.`, "good");
					const next = nextPhase(phases, await passedPhases(host.cwd, signal));
					if (!next) {
						this.update({ status: "done", lastVerdict: verdict });
						host.notice("Supervisor: every phase passed.", "good");
						return this.state;
					}
					this.update({
						phase: next.number,
						stage: "actor",
						message: undefined,
						failures: 0,
						stuck: undefined,
						lastVerdict: verdict,
						startRef: undefined,
						phaseStart: undefined,
					});
					continue;
				}

				const failures = this.state.failures + 1;
				const message = failureMessage(phase, failures, host.maxRetries, verdict, gate, this.state.stuck);
				this.update({ stage: "actor", message, failures, lastVerdict: verdict, stuck: undefined });
				host.notice(
					`${label} failed (${failures} of ${host.maxRetries}):\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
					"bad",
				);
				if (failures >= host.maxRetries) return this.halt(`${label} failed ${failures} times.`);
			}
		} catch (error) {
			host.status(undefined);
			if (signal.aborted) {
				this.update({ status: "stopped" });
				host.notice("Supervisor stopped. /supervise resume continues.", "info");
				return this.state;
			}
			return this.halt(error instanceof Error ? error.message : String(error));
		}
	}

	private halt(reason: string): SupervisorState {
		this.update({ status: "halted", haltReason: reason });
		this.host.notice(`Supervisor halted: ${reason} Fix what is needed, then /supervise resume.`, "bad");
		this.host.notify("Arc Supervisor halted. Intervention required.");
		return this.state;
	}
}
