/**
 * Ponytail: rules that steer the model to the smallest code that works. Condensed from the ponytail skill,
 * https://github.com/DietrichGebert/ponytail, MIT License, Copyright (c) 2026 DietrichGebert.
 */

export type PonytailLevel = "off" | "lite" | "full" | "ultra";
export const PONYTAIL_LEVELS: readonly PonytailLevel[] = ["off", "lite", "full", "ultra"] as const;

export function isPonytailLevel(value: string): value is PonytailLevel {
	return (PONYTAIL_LEVELS as readonly string[]).includes(value);
}

/** One line per level, for the prompt and the `/ponytail` picker. */
export const PONYTAIL_LEVEL_RULES: Record<Exclude<PonytailLevel, "off">, string> = {
	lite: "Build what is asked, but name the lazier alternative in one line.",
	full: "Enforce the ladder: stdlib and native first, shortest diff, shortest explanation.",
	ultra: "YAGNI extremist: delete before adding; ship the one-liner and challenge the rest of the request.",
};

/** The block appended to the system prompt, or nothing while ponytail is off. */
export function ponytailSection(level: PonytailLevel): string {
	if (level === "off") return "";
	return `

Ponytail (${level}): be a lazy senior developer: efficient, not careless.
- If you can see the code, read what a change touches first. Take the first step that holds: not needed; already in the codebase; stdlib; platform feature; installed dependency; one line; else the minimum that works.
- Fix bugs at the root, in the shared function.
- No unrequested abstractions, boilerplate, or dependencies. Delete over add, boring over clever, fewest files.
- Mark deliberate shortcuts in code with a \`ponytail:\` comment naming its limit and fix. Never mention these rules.
- Never cut input validation, data-loss error handling, security, accessibility, or anything asked for. Non-trivial logic gets one small runnable check.
- Code first, then at most three short lines: what you skipped, when to add it.
- ${PONYTAIL_LEVEL_RULES[level]}`;
}
