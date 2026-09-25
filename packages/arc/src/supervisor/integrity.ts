import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { EMPTY_TREE, git } from "./git.ts";
import type { Phase } from "./plan.ts";

/**
 * The actor can reach every file with its shell, so nothing here makes a file untouchable. What it does is make
 * tampering visible: a run reads its plan from a commit, and a phase that changes the plan, what its checks run, or
 * the record of passed phases fails instead of passing.
 */

const PASSED_COMMIT = /^arc: phase (\d+) passed\b/;
/** Scripts a check runs through a package manager: `npm test`, `npm run build`, `yarn lint`, `pnpm run check`. */
const SCRIPT_RUN = /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?([\w:.-]+)/g;
const PACKAGE_MANAGER_COMMANDS = new Set(["install", "i", "ci", "add", "remove", "exec", "x", "create", "init"]);

/** The plan as a run uses it: the file at `path` (relative to the project) in `commit`. */
export interface FrozenPlan {
	commit: string;
	path: string;
}

export interface PassedPhase {
	phase: number;
	commit: string;
}

/** Freeze `plan` at HEAD. It must be committed as it is on disk, so the frozen copy is the one the user wrote. */
export async function freezePlan(cwd: string, plan: string): Promise<FrozenPlan> {
	const path = relative(cwd, plan);
	if (path.startsWith("..") || isAbsolute(path)) throw new Error("The plan must be inside the project folder.");
	if ((await git(cwd, ["ls-files", "--error-unmatch", "--", path])).code !== 0) {
		throw new Error(`Commit the plan first: git add ${path} && git commit -m "plan"`);
	}
	if ((await git(cwd, ["diff", "--quiet", "HEAD", "--", path])).code !== 0) {
		throw new Error(`${path} has uncommitted changes. Commit them first, so the run follows the plan you wrote.`);
	}
	const head = await git(cwd, ["rev-parse", "HEAD"]);
	return { commit: head.stdout.trim(), path };
}

export async function readFrozenPlan(cwd: string, frozen: FrozenPlan, signal?: AbortSignal): Promise<string> {
	const result = await git(cwd, ["show", `${frozen.commit}:./${frozen.path}`], signal);
	if (result.code !== 0) {
		throw new Error(`The plan's commit ${frozen.commit.slice(0, 8)} is gone: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** Whether the plan file on disk differs from the frozen copy. A missing file counts as changed. */
export async function planChanged(cwd: string, frozen: FrozenPlan): Promise<boolean> {
	const onDisk = await readFile(join(cwd, frozen.path), "utf8").catch(() => undefined);
	return onDisk !== (await readFrozenPlan(cwd, frozen));
}

/**
 * Put the frozen plan back on disk. The edited file is kept in the temp folder first, in case a person made the
 * edit. Returns that copy's path, or undefined when there was no file to keep.
 */
export async function restorePlan(cwd: string, frozen: FrozenPlan): Promise<string | undefined> {
	const file = join(cwd, frozen.path);
	const edited = await readFile(file, "utf8").catch(() => undefined);
	let backup: string | undefined;
	if (edited !== undefined) {
		backup = join(tmpdir(), `arc-plan-edited-${Date.now()}-${basename(frozen.path)}`);
		await writeFile(backup, edited);
	}
	await writeFile(file, await readFrozenPlan(cwd, frozen));
	return backup;
}

/** `arc: phase N passed` commits in HEAD's history, newest first, one per phase. */
export async function passedCommits(cwd: string, signal?: AbortSignal): Promise<PassedPhase[]> {
	const result = await git(cwd, ["log", "--format=%H %s"], signal);
	if (result.code !== 0) return [];
	const passed = new Map<number, string>();
	for (const line of result.stdout.split("\n")) {
		const space = line.indexOf(" ");
		const match = PASSED_COMMIT.exec(line.slice(space + 1));
		if (match && !passed.has(Number(match[1]))) passed.set(Number(match[1]), line.slice(0, space));
	}
	return [...passed].map(([phase, commit]) => ({ phase, commit }));
}

async function inHistory(cwd: string, commit: string, signal?: AbortSignal): Promise<boolean> {
	return (await git(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"], signal)).code === 0;
}

/** Why the run cannot trust git any more, when a passed phase's commit or the phase's start left HEAD's history. */
export async function historyProblem(
	cwd: string,
	passed: readonly PassedPhase[],
	startRef: string | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	for (const { phase, commit } of passed) {
		if (!(await inHistory(cwd, commit, signal))) {
			return `Git history was rewritten: phase ${phase}'s passed commit ${commit.slice(0, 8)} is no longer part of it.`;
		}
	}
	if (startRef && startRef !== EMPTY_TREE && !(await inHistory(cwd, startRef, signal))) {
		return `Git history was rewritten: the commit this phase started from (${startRef.slice(0, 8)}) is no longer part of it.`;
	}
	return undefined;
}

/** Package scripts the phase's checks run. */
export function checkedScripts(commands: readonly string[]): string[] {
	const names = new Set<string>();
	for (const command of commands) {
		for (const match of command.matchAll(SCRIPT_RUN)) {
			if (!PACKAGE_MANAGER_COMMANDS.has(match[1])) names.add(match[1]);
		}
	}
	return [...names];
}

/** Words in the checks that look like file paths: they contain a slash or end in an extension. */
export function checkedPaths(commands: readonly string[]): string[] {
	const paths = new Set<string>();
	for (const command of commands) {
		for (const raw of command.split(/[\s;&|()<>=]+/)) {
			const word = raw.replace(/^["']+|["']+$/g, "");
			if (!word || word.startsWith("-") || word.startsWith("$") || /[*?[\]{}\\]/.test(word)) continue;
			if (word.includes("://") || isAbsolute(word) || word.startsWith("..")) continue;
			if (word.includes("/") || /\.[A-Za-z0-9]+$/.test(word)) paths.add(word.replace(/^\.\//, ""));
		}
	}
	return [...paths];
}

async function scriptsAt(cwd: string, ref: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
	const text =
		ref === "working tree"
			? await readFile(join(cwd, "package.json"), "utf8").catch(() => undefined)
			: await git(cwd, ["show", `${ref}:./package.json`], signal).then((result) =>
					result.code === 0 ? result.stdout : undefined,
				);
	if (text === undefined) return undefined;
	try {
		const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
		return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Ways this phase tampered with its own verdict, as instructions for the actor. A phase may change a script or a file
 * its checks use only when its text names it: a script as `"name":`, the way a plan lists package.json scripts, and a
 * file by its path. Files and scripts that did not exist when the phase started are the phase's to create.
 */
export async function findTampering(
	cwd: string,
	phase: Phase,
	startRef: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const reasons: string[] = [];

	const range = startRef === EMPTY_TREE ? ["HEAD"] : [`${startRef}..HEAD`];
	const log = await git(cwd, ["log", "--format=%s", ...range], signal);
	for (const subject of log.code === 0 ? log.stdout.split("\n") : []) {
		if (PASSED_COMMIT.test(subject)) {
			reasons.push(
				`A commit made during this phase is titled like a passed phase ("${subject}"). Only the supervisor makes those.`,
			);
		}
	}

	const before = startRef === EMPTY_TREE ? undefined : await scriptsAt(cwd, startRef, signal);
	const now = await scriptsAt(cwd, "working tree", signal);
	for (const name of checkedScripts(phase.verify)) {
		const was = before?.[name];
		const is = now?.[name];
		if (was === undefined || JSON.stringify(was) === JSON.stringify(is) || phase.body.includes(`"${name}":`))
			continue;
		reasons.push(
			`The "${name}" script in package.json, which a check runs, changed from ${JSON.stringify(was)} to ${is === undefined ? "nothing" : JSON.stringify(is)}. Restore it: the checks must not be changed.`,
		);
	}

	if (startRef !== EMPTY_TREE) {
		for (const path of checkedPaths(phase.verify)) {
			if (path === "package.json" || phase.body.includes(path)) continue;
			const type = await git(cwd, ["cat-file", "-t", `${startRef}:./${path}`], signal);
			if (type.code !== 0 || type.stdout.trim() !== "blob") continue;
			if ((await git(cwd, ["diff", "--quiet", startRef, "--", path], signal)).code === 0) continue;
			reasons.push(`${path}, which a check uses, was changed. Restore it: the checks must not be changed.`);
		}
	}
	return reasons;
}
