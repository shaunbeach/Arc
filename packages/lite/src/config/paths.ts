import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Overrides the app directory, which holds sessions, logs, and the fallback models.yml. */
export const APP_DIR_ENV = "PI_LITE_DIR";

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function getAppDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[APP_DIR_ENV];
	return configured ? resolve(expandHome(configured)) : join(homedir(), ".pi-lite");
}
