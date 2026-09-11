import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSamplingMode, type SamplingMode } from "./sampling.ts";

/** Model and mode of the latest interactive session, so a plain `pi-lite` opens them again. */
export interface LastUsed {
	model: string;
	mode: SamplingMode;
}

const FILE_NAME = "last-used.json";

/** Undefined when the file is missing, unreadable, or not in the expected shape. */
export function readLastUsed(appDir: string): LastUsed | undefined {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(join(appDir, FILE_NAME), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null) return undefined;
	const { model, mode } = data as Record<string, unknown>;
	if (typeof model !== "string" || typeof mode !== "string" || !isSamplingMode(mode)) return undefined;
	return { model, mode };
}

/** Best effort: when the write fails, the next start falls back to the first model in models.yml. */
export function writeLastUsed(appDir: string, lastUsed: LastUsed): void {
	const path = join(appDir, FILE_NAME);
	try {
		mkdirSync(appDir, { recursive: true });
		// Write, then rename, so an interrupted write never leaves a truncated file.
		writeFileSync(`${path}.tmp`, `${JSON.stringify(lastUsed)}\n`);
		renameSync(`${path}.tmp`, path);
	} catch {
		// Remembering the model is a convenience; never fail a session over it.
	}
}
