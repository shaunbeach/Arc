import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Overrides the app directory, which holds sessions, logs, and the fallback models.yml. */
export const APP_DIR_ENV = "ARC_DIR";
/** What `ARC_DIR` was called before Arc was renamed from pi-lite. Still read, so old setups keep working. */
const LEGACY_APP_DIR_ENV = "PI_LITE_DIR";
/** The app directory before the rename. */
const LEGACY_APP_DIR = ".pi-lite";

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function getAppDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[APP_DIR_ENV] ?? env[LEGACY_APP_DIR_ENV];
	return configured ? resolve(expandHome(configured)) : join(homedir(), ".arc");
}

/**
 * Move `~/.pi-lite` to `~/.arc` the first time Arc runs, so sessions, logs, the last-used model, and models.yml
 * carry over from pi-lite. Nothing happens when the directory is configured, when `~/.arc` already exists, or when
 * there is no `~/.pi-lite`. Returns a line to show the user, or undefined.
 */
export function migrateLegacyAppDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
	if (env[APP_DIR_ENV] || env[LEGACY_APP_DIR_ENV]) return undefined;
	const legacy = join(home, LEGACY_APP_DIR);
	const current = join(home, ".arc");
	if (existsSync(current) || !existsSync(legacy)) return undefined;
	try {
		renameSync(legacy, current);
		return `Moved ${legacy} to ${current}.`;
	} catch (error) {
		return `Could not move ${legacy} to ${current} (${error instanceof Error ? error.message : String(error)}); move it yourself to keep your sessions.`;
	}
}
