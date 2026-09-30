import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Only the copy in /usr/bin: one earlier on PATH could be anything. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * What bash and the supervisor's checks may do. `on` limits writes to the project, temp folders, and caches, and
 * connections to this machine. `net` keeps the write limit and allows the internet. `off` limits nothing.
 */
export type SandboxLevel = "on" | "net" | "off";
export const SANDBOX_LEVELS: readonly SandboxLevel[] = ["on", "net", "off"] as const;

export function isSandboxLevel(value: string): value is SandboxLevel {
	return (SANDBOX_LEVELS as readonly string[]).includes(value);
}

export interface SandboxPolicy {
	level: Exclude<SandboxLevel, "off">;
	/** Real paths commands may write under. */
	writableRoots: string[];
	/** The project root among them, for the model-facing notes. */
	project: string;
}

/** models.yml `sandbox:`. */
export interface SandboxConfig {
	/** The level Arc starts at. Default: `off`. */
	level: SandboxLevel;
	/** More folders commands may write, as absolute paths. */
	writable: string[];
}

let current: SandboxPolicy | undefined;

/** The policy every shell command runs under from now on; undefined runs them unconfined. */
export function setSandbox(policy: SandboxPolicy | undefined): void {
	current = policy;
}

export function currentSandbox(): SandboxPolicy | undefined {
	return current;
}

/** Seatbelt ships with macOS; elsewhere there is nothing to confine commands with. */
export function sandboxAvailable(platform: string = process.platform): boolean {
	return platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** Seatbelt matches resolved paths: /tmp is /private/tmp, and a symlinked project is its target. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** The nearest folder at or above `cwd` holding `.git`, so a session started in a subfolder can still commit. */
export function projectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

/**
 * Package managers, compilers, and matplotlib keep caches in the home folder, and fail in odd ways or rebuild them on
 * every run when they cannot write them. Writing a cache is harmless; reaching the network to fill one is what `on` stops.
 */
function cacheRoots(home: string): string[] {
	return [join(home, "Library", "Caches"), join(home, ".cache"), join(home, ".npm"), join(home, ".matplotlib")];
}

export function sandboxPolicy(
	level: SandboxLevel,
	cwd: string,
	extraWritable: readonly string[] = [],
	home: string = homedir(),
): SandboxPolicy | undefined {
	if (level === "off") return undefined;
	const project = realPath(projectRoot(cwd));
	const roots = [project, realPath(tmpdir()), "/private/tmp", ...cacheRoots(home), ...extraWritable.map(realPath)];
	return { level, project, writableRoots: [...new Set(roots)] };
}

/**
 * The Seatbelt profile for `policy`. It starts from `allow default` and takes away only what the sandbox is for:
 * writes outside the roots, connections beyond this machine, and the two ways around both. AppleEvents would let a
 * command ask Finder to delete a file, and LaunchServices (`open`) starts apps and browsers outside the sandbox.
 * Roots are passed as parameters, so a path needs no quoting.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
	const roots = policy.writableRoots.map((_, index) => `(subpath (param "WRITABLE_ROOT_${index}"))`).join(" ");
	const lines = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* ${roots} (regex #"^/dev/(null|zero|tty.*|fd/.*|dtracehelper)$"))`,
		"(deny appleevent-send)",
		'(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-regex #"^com\\.apple\\.lsd\\."))',
	];
	if (policy.level === "on") {
		lines.push("(deny network-outbound)", '(allow network-outbound (remote ip "localhost:*"))');
	}
	return `${lines.join("\n")}\n`;
}

/** The program and arguments that run `shell -c command` under `policy`. */
export function sandboxedSpawn(
	shell: string,
	command: string,
	policy: SandboxPolicy,
): { file: string; args: string[] } {
	const params = policy.writableRoots.map((root, index) => `-DWRITABLE_ROOT_${index}=${root}`);
	return { file: SANDBOX_EXEC, args: ["-p", seatbeltProfile(policy), ...params, "--", shell, "-c", command] };
}

/** Name lookups fail first; a bare address fails to connect. A localhost server that is not up yet is not the sandbox. */
const NETWORK_DENIED =
	/Could not resolve host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|\bENOTFOUND\b|nodename nor servname|Temporary failure in name resolution|Name or service not known|NameResolutionError|Failed to establish a new connection|Network is unreachable|ENETUNREACH|connect EPERM|connectx? to (?!localhost|127\.|::1)\S+ port \d+.*Operation not permitted|Failed to connect to (?!localhost|127\.|::1|\[::1\])/i;
const WRITE_DENIED = /Operation not permitted|\bEPERM\b|Read-only file system|\bEROFS\b/;
/** `open` reports the blocked LaunchServices as a missing app, e.g. "No application knows how to open URL". */
const OPEN_DENIED = /No application knows how to open|LSOpenURLsWithRole|\bkLS[A-Z]\w+Err|kLSExecutableIncorrectFormat/;

/**
 * A note for the model when a command's output looks like the sandbox stopped it. Small models otherwise read
 * "Could not resolve host" as a flaky network and retry, or hunt for another way out.
 */
export function sandboxNote(output: string, policy: SandboxPolicy | undefined = current): string | undefined {
	if (!policy) return undefined;
	if (policy.level === "on" && NETWORK_DENIED.test(output)) {
		return "[Arc's sandbox blocks internet access for commands; only localhost is reachable. Do not retry or look for another way: tell the user what you need from the internet. They can allow it with /sandbox net.]";
	}
	if (OPEN_DENIED.test(output)) {
		return "[Arc's sandbox blocks opening files in apps. Do not look for another app or run one directly: tell the user the file's path so they can open it.]";
	}
	if (WRITE_DENIED.test(output)) {
		return `[Arc's sandbox may have blocked this: commands can write only inside ${policy.project}, temp folders, and caches. Keep your work there; do not retry elsewhere.]`;
	}
	return undefined;
}
