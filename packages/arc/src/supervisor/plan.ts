/** One `## Phase` section of an implementation plan. */
export interface Phase {
	/** The number in the heading (`## Phase 3: ...`), else the phase's position counting from 1. */
	number: number;
	title: string;
	/** The section's text without its heading and without its verify blocks: what the actor is asked to build. */
	body: string;
	/** Shell commands from the section's ```verify blocks, in order. Empty: only the critic judges the phase. */
	verify: string[];
}

export class PlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanError";
	}
}

const PHASE_HEADING = /^##\s+phase\b\s*(\d+)?\s*[:.\-–—]?\s*(.*?)\s*#*\s*$/i;
/** A level 1 or 2 heading ends a phase; deeper headings belong to it. */
const SECTION_HEADING = /^#{1,2}\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * Split an implementation plan into phases. A phase starts at a `## Phase` heading and runs to the next level 1 or 2
 * heading. Its ```verify blocks hold the Verification Gate's commands, one per line; `#` lines are comments and a
 * trailing backslash continues a command. Headings inside fenced code are text, so a plan can quote Markdown.
 */
export function parsePlan(text: string): Phase[] {
	const phases: Phase[] = [];
	let current: { number?: number; title: string; body: string[]; verify: string[] } | undefined;
	let fence: { marker: string; verify: boolean } | undefined;
	let pending = "";

	const close = () => {
		if (!current) return;
		const number = current.number ?? phases.length + 1;
		if (phases.some((phase) => phase.number === number)) throw new PlanError(`Phase ${number} appears twice.`);
		phases.push({
			number,
			title: current.title || `Phase ${number}`,
			// A `---` between phases is layout, not part of the phase.
			body: current.body
				.join("\n")
				.trim()
				.replace(/(\n\s*(-{3,}|\*{3,}|_{3,})\s*)+$/, "")
				.trim(),
			verify: current.verify,
		});
		current = undefined;
	};

	for (const line of text.split(/\r?\n/)) {
		if (fence) {
			const closing = FENCE.exec(line);
			if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length && !closing[2]) {
				if (fence.verify && pending) throw new PlanError(`A verify command ends in "\\": ${pending.trim()}`);
				if (!fence.verify) current?.body.push(line);
				fence = undefined;
				continue;
			}
			if (!fence.verify) {
				current?.body.push(line);
				continue;
			}
			const command = line.trim();
			if (!pending && (command === "" || command.startsWith("#"))) continue;
			if (command.endsWith("\\")) {
				pending += `${command.slice(0, -1).trim()} `;
				continue;
			}
			current?.verify.push(`${pending}${command}`.trim());
			pending = "";
			continue;
		}

		const opening = FENCE.exec(line);
		if (opening) {
			fence = { marker: opening[1], verify: current !== undefined && opening[2].toLowerCase() === "verify" };
			if (!fence.verify) current?.body.push(line);
			continue;
		}
		const heading = PHASE_HEADING.exec(line);
		if (heading) {
			close();
			current = { number: heading[1] ? Number(heading[1]) : undefined, title: heading[2], body: [], verify: [] };
			continue;
		}
		if (SECTION_HEADING.test(line)) {
			close();
			continue;
		}
		current?.body.push(line);
	}
	if (fence?.verify) throw new PlanError("A ```verify block is never closed.");
	close();
	if (phases.length === 0)
		throw new PlanError('The plan has no phases. Start each one with a "## Phase N: title" heading.');
	return phases;
}

/** The first phase without a passed commit, or undefined when every phase has passed. */
export function nextPhase(phases: readonly Phase[], passed: ReadonlySet<number>): Phase | undefined {
	return phases.find((phase) => !passed.has(phase.number));
}
