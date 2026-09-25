import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "sh";
/** How long to keep reading after exit while a detached descendant still holds the output pipes. */
const EXIT_STDIO_GRACE_MS = 100;

const runningProcessGroups = new Set<number>();
/**
 * Process groups of finished commands that left something running, such as `npm run dev &`, oldest first. Nothing
 * else would ever stop them: each attempt at starting an app would leave another window open.
 */
let leftoverGroups: number[] = [];
/** Most leftovers kept; older ones are stopped when a newer command leaves one. Undefined: no limit. */
let leftoverLimit: number | undefined;

export interface ShellRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onData: (data: Buffer) => void;
}

export interface ShellRunResult {
	/** null when the process was killed by a signal. */
	exitCode: number | null;
	timedOut: boolean;
}

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// EPERM: a member exists but belongs to someone else; it is still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kill every command still running, and what finished ones left behind, for process exit. */
export function killRunningCommands(): void {
	for (const pid of runningProcessGroups) killProcessGroup(pid);
	runningProcessGroups.clear();
	killLeftoverProcesses();
}

/** Stop everything finished commands left running. Returns how many process groups were still alive. */
export function killLeftoverProcesses(): number {
	let killed = 0;
	for (const pid of leftoverGroups) {
		if (!groupAlive(pid)) continue;
		killProcessGroup(pid);
		killed++;
	}
	leftoverGroups = [];
	return killed;
}

/**
 * Keep at most `limit` leftovers from now on (undefined: no limit). One lets a model start a server in one command
 * and use it in the next, while a second server stops the first instead of piling up next to it.
 */
export function setLeftoverLimit(limit: number | undefined): void {
	leftoverLimit = limit;
}

function recordLeftover(pid: number): void {
	leftoverGroups = leftoverGroups.filter(groupAlive);
	if (!groupAlive(pid)) return;
	leftoverGroups.push(pid);
	if (leftoverLimit === undefined) return;
	while (leftoverGroups.length > leftoverLimit) {
		const oldest = leftoverGroups.shift();
		if (oldest !== undefined) killProcessGroup(oldest);
	}
}

/**
 * Run a command with bash (or sh) in its own process group, so a timeout or abort kills everything it started.
 * Stdin is closed and pagers are disabled, so commands cannot wait for input that never comes.
 */
export async function runShellCommand(command: string, cwd: string, options: ShellRunOptions): Promise<ShellRunResult> {
	const { signal, timeoutMs, onData } = options;
	signal?.throwIfAborted();
	const child = spawn(SHELL, ["-c", command], {
		cwd,
		detached: true,
		env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const pid = child.pid;
	if (pid !== undefined) runningProcessGroups.add(pid);

	let timedOut = false;
	const kill = () => {
		if (pid !== undefined) killProcessGroup(pid);
	};
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					kill();
				}, timeoutMs);
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	signal?.addEventListener("abort", kill, { once: true });
	try {
		return { exitCode: await waitForChildProcess(child), timedOut };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
		if (pid !== undefined) {
			runningProcessGroups.delete(pid);
			recordLeftover(pid);
		}
	}
}

/**
 * Wait for a child to exit without hanging on pipes inherited by detached descendants. After `exit`, keep reading
 * while output still arrives, and settle once the pipes close or stay quiet for a short grace period.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let graceTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			clearTimeout(graceTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const armGraceTimer = () => {
			clearTimeout(graceTimer);
			graceTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const finalizeIfDrained = () => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		const onData = () => {
			if (exited && !settled) armGraceTimer();
		};
		const onStdoutEnd = () => {
			stdoutEnded = true;
			finalizeIfDrained();
		};
		const onStderrEnd = () => {
			stderrEnded = true;
			finalizeIfDrained();
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			finalizeIfDrained();
			if (!settled) armGraceTimer();
		};
		const onClose = (code: number | null) => finalize(code);

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
