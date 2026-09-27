import { type Phase, PlanError, parsePlan } from "./plan.ts";

/** A phase this big likely overflows a 20k window once the actor reads its files. */
const MAX_TASKS = 10;
const MAX_PHASE_CHARS = 8000;
/** Commands that run until stopped: a check that starts one in the foreground never finishes. */
const LONG_RUNNING =
	/\b(npm (run )?(dev|start|serve|watch)|yarn (dev|start|serve)|pnpm (run )?(dev|start)|electron-vite (dev|preview)|vite( dev| preview|\s*$)|tauri dev|cargo (run|watch)|python3? -m http\.server|flask run|uvicorn|next (dev|start)|nodemon|tsc (-w|--watch))\b/;

export interface LintFinding {
	phase?: number;
	message: string;
}

/** A background `&`, not `&&`. */
function startsInBackground(command: string): boolean {
	return /(^|[^&])&($|[^&])/.test(command);
}

function lintCheck(phase: Phase, command: string): string[] {
	const findings: string[] = [];
	const background = startsInBackground(command);
	if (LONG_RUNNING.test(command) && !background) {
		findings.push(
			`\`${command}\` never exits on its own. Start it in the background, probe it, and stop it (see the template's startup check).`,
		);
	}
	if (background && !/\b(p?kill|killall)\b/.test(command)) {
		findings.push(`\`${command}\` starts something in the background and never stops it.`);
	}
	if (/^\s*(rg|grep)\s/.test(command) && !/\s-c\b|\s--count\b|\|/.test(command)) {
		findings.push(
			`\`${command}\` passes only when it finds a match. If it checks that something is absent, write \`! ${command.trim()}\`.`,
		);
	}
	if (/\bsleep\s+\d+/.test(command) && /localhost:\d+/.test(command) && !/strictPort/i.test(phase.body)) {
		findings.push(
			"This startup check probes a fixed port. Pin the dev server to it with strictPort, or a leftover app on the port can answer instead.",
		);
	}
	return findings;
}

/**
 * What in a plan is likely to cost a run time or give a wrong verdict: the mistakes the first long runs made. Findings
 * are advice, not errors, except a plan Arc cannot parse.
 */
export function lintPlan(text: string): { phases: Phase[]; findings: LintFinding[] } {
	let phases: Phase[];
	try {
		phases = parsePlan(text);
	} catch (error) {
		if (error instanceof PlanError) return { phases: [], findings: [{ message: error.message }] };
		throw error;
	}
	const findings: LintFinding[] = [];
	phases.forEach((phase, index) => {
		const previous = phases[index - 1];
		if (previous && phase.number !== previous.number + 1) {
			findings.push({ phase: phase.number, message: `Numbered ${phase.number} after phase ${previous.number}.` });
		}
		if (phase.verify.length === 0) {
			findings.push({ phase: phase.number, message: "No ```verify block: only the critic will judge this phase." });
		}
		for (const command of phase.verify) {
			for (const message of lintCheck(phase, command)) findings.push({ phase: phase.number, message });
		}
		const tasks = (phase.body.match(/^\s*- \[[ x]\]/gm) ?? []).length;
		if (tasks > MAX_TASKS || phase.body.length > MAX_PHASE_CHARS) {
			findings.push({
				phase: phase.number,
				message: `Large (${tasks} tasks, about ${Math.round(phase.body.length / 3 / 100) / 10}k tokens of text). Consider splitting it so it fits a small window.`,
			});
		}
	});
	return { phases, findings };
}

export function formatLint(result: ReturnType<typeof lintPlan>): string {
	const { phases, findings } = result;
	if (phases.length === 0) return `Plan check: ${findings[0]?.message ?? "no phases."}`;
	if (findings.length === 0) return `Plan check: ${phases.length} phases, nothing to fix.`;
	const lines = findings.map((finding) =>
		finding.phase === undefined ? `- ${finding.message}` : `- Phase ${finding.phase}: ${finding.message}`,
	);
	const count = `${findings.length} thing${findings.length === 1 ? "" : "s"} to look at`;
	return `Plan check: ${phases.length} phases, ${count}:\n${lines.join("\n")}`;
}
