import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { expandHome } from "../config/paths.ts";
import { userText } from "../llm/text.ts";
import type { Message } from "../llm/types.ts";

/** The MemPalace CLI (`uv tool install mempalace`). */
export const MEMPALACE_BIN = "mempalace";

/** Whether a palace exists, so the memory tool can search other projects' wings from one not linked itself. */
export function palaceExists(env: NodeJS.ProcessEnv = process.env): boolean {
	const configured = env.MEMPALACE_PALACE_PATH;
	if (configured) return existsSync(expandHome(configured));
	return [join(homedir(), ".config", "mempalace", "palace"), join(homedir(), ".mempalace")].some(existsSync);
}

/** Links a project to its wing in the palace. Written by `/mempalace`. */
export function memoryConfigPath(cwd: string): string {
	return join(cwd, ".arc", "mempalace.json");
}

/** The wing this project saves to and searches, or undefined when `/mempalace` has not been run here. */
export function readMemoryWing(cwd: string): string | undefined {
	const path = memoryConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const wing = (parsed as { wing?: unknown }).wing;
		return typeof wing === "string" && wing.trim() ? wing.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function writeMemoryWing(cwd: string, wing: string): void {
	const path = memoryConfigPath(cwd);
	mkdirSync(join(cwd, ".arc"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ wing }, null, "\t")}\n`);
}

/** A wing name from the project folder: "My App" becomes "my_app". */
export function defaultWing(cwd: string): string {
	return (
		basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "project"
	);
}

/** Run the CLI and return stdout. A missing binary gets an install hint instead of ENOENT. */
export function runMempalace(args: readonly string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(MEMPALACE_BIN, args, { signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(stdout);
				return;
			}
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("mempalace is not installed. Install it with: uv tool install mempalace"));
				return;
			}
			reject(new Error(stderr.trim() || error.message));
		});
	});
}

/**
 * The conversation as plain text for `mempalace mine --mode convos`: user turns start with "> ", replies follow.
 * Tool calls, results, and thinking are left out; they are large and the files and commands they came from remain.
 */
export function transcriptText(messages: readonly Message[]): string {
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = userText(message).trim();
			if (text) turns.push(`> ${text.replace(/\n/g, "\n> ")}`);
		} else if (message.role === "assistant") {
			const text = message.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("")
				.trim();
			if (text) turns.push(text);
		}
	}
	return turns.length > 0 ? `${turns.join("\n\n")}\n` : "";
}

/**
 * Write the session's transcript under `<appDir>/mempalace/<wing>/` and mine that folder into the wing. The miner
 * runs detached, so quitting Arc does not wait for embeddings. Sessions with no user turn are skipped.
 */
export function saveToPalace(appDir: string, wing: string, sessionId: string, messages: readonly Message[]): boolean {
	if (!messages.some((message) => message.role === "user")) return false;
	const text = transcriptText(messages);
	if (!text) return false;
	const folder = join(appDir, "mempalace", wing);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${sessionId}.txt`), text);
	try {
		const child = spawn(MEMPALACE_BIN, ["mine", folder, "--mode", "convos", "--wing", wing], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		return false;
	}
	return true;
}
