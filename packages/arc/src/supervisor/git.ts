import { execFile } from "node:child_process";
import { basename } from "node:path";

/** Git's empty tree: the phase-start ref of a repository with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PASSED_COMMIT = /^arc: phase (\d+) passed\b/;
/** Characters per token when turning a token budget into characters, as `/compact` does. */
const CHARS_PER_TOKEN = 3;
/**
 * Generated dependency locks. Their diffs run to thousands of lines a reviewer cannot judge, so the critic learns
 * only that they changed, and its window goes to the code.
 */
const LOCK_FILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
]);

export function isLockFile(path: string): boolean {
	return LOCK_FILES.has(basename(path));
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run git in `cwd`. Resolves with the exit code rather than rejecting, since `git diff --no-index` exits 1 on a difference. */
export function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, signal, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
			(error, stdout, stderr) => {
				const code = error ? (error as { code?: unknown }).code : 0;
				if (typeof code !== "number") {
					reject(error);
					return;
				}
				resolve({ code, stdout, stderr });
			},
		);
	});
}

async function gitOk(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
	const result = await git(cwd, args, signal);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

/** HEAD's commit, or the empty tree before the first commit. A phase's diff is taken against this. */
export async function phaseStartRef(cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], signal);
	return result.code === 0 ? result.stdout.trim() : EMPTY_TREE;
}

export interface ChangedFile {
	path: string;
	/** A (added), M (modified), D (deleted), T (type changed); untracked files count as added. */
	status: "A" | "M" | "D" | "T";
	/** Not yet known to git, so diffed against /dev/null. */
	untracked?: boolean;
}

/** Files that differ from `ref` in the working tree, untracked ones included, ignored ones not. */
export async function changedFiles(cwd: string, ref: string, signal?: AbortSignal): Promise<ChangedFile[]> {
	const tracked = await gitOk(cwd, ["diff", "--name-status", "--no-renames", "-z", ref, "--"], signal);
	const fields = tracked.split("\0").filter(Boolean);
	const files: ChangedFile[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const status = fields[i][0];
		files.push({ path: fields[i + 1], status: status === "A" || status === "D" || status === "T" ? status : "M" });
	}
	const untracked = await gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
	for (const path of untracked.split("\0").filter(Boolean)) files.push({ path, status: "A", untracked: true });
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Uncommitted changes, untracked files included. A dirty tree at `/supervise` would land in phase 1's commit. */
export async function isClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
	return (await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"], signal)).trim() === "";
}

/** How many characters of diff the critic's request may carry: 60% of its window. */
export function diffBudgetChars(criticContextTokens: number): number {
	return Math.floor(criticContextTokens * 0.6 * CHARS_PER_TOKEN);
}

export interface PhaseDiff {
	files: ChangedFile[];
	/** The file list, then each file's diff; long diffs cut to fit the budget. */
	text: string;
	/** Files whose diff was cut short. */
	truncated: string[];
}

function cut(diff: string, limit: number): string {
	if (diff.length <= limit) return diff;
	const kept = diff.slice(0, Math.max(0, limit)).replace(/\n[^\n]*$/, "");
	const dropped = diff.slice(kept.length).split("\n").length;
	return `${kept}\n[... ${dropped} more lines of this diff cut to fit the critic's window]`;
}

/**
 * What changed since `ref`, as the critic reads it: a list of files, then one diff per file, within `maxChars`. When
 * everything does not fit, small diffs stay whole and the remaining room is shared evenly among the large ones, so one
 * generated file cannot crowd out the rest.
 */
export async function diffSince(cwd: string, ref: string, maxChars: number, signal?: AbortSignal): Promise<PhaseDiff> {
	const files = await changedFiles(cwd, ref, signal);
	const diffs: string[] = [];
	for (const file of files) {
		if (isLockFile(file.path)) {
			diffs.push(`${file.path}: dependency lock file changed; contents left out.`);
			continue;
		}
		const args = file.untracked
			? ["diff", "--no-color", "--no-index", "--", "/dev/null", file.path]
			: ["diff", "--no-color", "--no-renames", ref, "--", file.path];
		diffs.push((await git(cwd, args, signal)).stdout.trimEnd());
	}

	const header = `Changed files (${files.length}):\n${files.map((file) => `${file.status} ${file.path}`).join("\n")}`;
	let room = Math.max(0, maxChars - header.length - 2 * files.length);
	const limits = new Map<number, number>();
	const order = diffs.map((_, index) => index).sort((a, b) => diffs[a].length - diffs[b].length);
	order.forEach((index, position) => {
		const share = Math.floor(room / (order.length - position));
		const limit = Math.min(diffs[index].length, share);
		limits.set(index, limit);
		room -= limit;
	});

	const truncated: string[] = [];
	const parts = diffs.map((diff, index) => {
		const limit = limits.get(index) ?? 0;
		if (diff.length <= limit) return diff;
		truncated.push(files[index].path);
		return cut(diff, limit);
	});
	return { files, text: [header, ...parts].filter(Boolean).join("\n\n"), truncated };
}

/**
 * Commit every change in the working tree as `arc: phase N passed: title`. The paths are staged by name from
 * `git status`, deletions included. A phase that changed nothing still gets an empty commit, since the commits are
 * how a later `/supervise` knows which phases passed. Returns the new commit's hash.
 */
export async function commitPhase(cwd: string, number: number, title: string, signal?: AbortSignal): Promise<string> {
	const status = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all", "--no-renames", "-z"], signal);
	const paths = status
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3));
	for (let i = 0; i < paths.length; i += 200) {
		await gitOk(cwd, ["add", "--", ...paths.slice(i, i + 200)], signal);
	}
	const subject = `arc: phase ${number} passed: ${title.replace(/\s+/g, " ").trim()}`;
	await gitOk(cwd, ["commit", "--allow-empty", "-m", subject], signal);
	return (await gitOk(cwd, ["rev-parse", "HEAD"], signal)).trim();
}

/** Phase numbers with an `arc: phase N passed` commit in HEAD's history. */
export async function passedPhases(cwd: string, signal?: AbortSignal): Promise<Set<number>> {
	const result = await git(cwd, ["log", "--format=%s"], signal);
	const passed = new Set<number>();
	if (result.code !== 0) return passed;
	for (const subject of result.stdout.split("\n")) {
		const match = PASSED_COMMIT.exec(subject);
		if (match) passed.add(Number(match[1]));
	}
	return passed;
}

/** Files that `arc: phase N passed` commits changed, most recently changed first, for the next phase's brief. */
export async function filesFromPassedPhases(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await git(cwd, ["log", "--name-only", "--format=", "-E", "--grep=^arc: phase [0-9]+ passed"], signal);
	if (result.code !== 0) return [];
	return [...new Set(result.stdout.split("\n").filter(Boolean))];
}
