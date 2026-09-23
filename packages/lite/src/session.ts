import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Agent } from "./agent/agent.ts";
import { isSamplingMode, type SamplingMode } from "./config/sampling.ts";
import { userText } from "./llm/text.ts";
import type { Message } from "./llm/types.ts";
import { type InteractionMode, isInteractionMode } from "./prompt.ts";

const SESSION_VERSION = 1;
/** Bytes read from the start of each session file to build the picker preview. */
const PREVIEW_BYTES = 64 * 1024;

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	cwd: string;
	createdAt: string;
}

export interface SessionSettings {
	/** models.yml model name. */
	model: string;
	mode: SamplingMode;
	/** Agent, plan, or chat. Missing in sessions saved before modes were recorded, which ran in agent mode. */
	interactionMode?: InteractionMode;
	/** False after `/web off`. Missing means the web tools are on. */
	web?: boolean;
	/** True after `/rag on`. Missing means kb_search is off. */
	rag?: boolean;
}

function sameSettings(a: SessionSettings | undefined, b: SessionSettings): boolean {
	return (
		a !== undefined &&
		a.model === b.model &&
		a.mode === b.mode &&
		(a.interactionMode ?? "agent") === (b.interactionMode ?? "agent") &&
		(a.web ?? true) === (b.web ?? true) &&
		(a.rag ?? false) === (b.rag ?? false)
	);
}

export type SessionEntry =
	| SessionHeader
	| ({ type: "settings"; timestamp: number } & SessionSettings)
	| { type: "message"; message: Message }
	/** From `/name`; the latest one names the session. */
	| { type: "name"; name: string; timestamp: number };

export interface LoadedSession {
	path: string;
	header: SessionHeader;
	messages: Message[];
	/** The last recorded model and mode, if any. */
	settings?: SessionSettings;
	/** The name given with `/name`, if any. */
	name?: string;
}

export interface SessionSummary {
	id: string;
	path: string;
	modified: Date;
	bytes: number;
	/** First user message, whitespace collapsed. Empty when none was found. */
	preview: string;
	/** The name given with `/name`, if any. */
	name?: string;
}

/** What lists show for a session: its `/name`, else its first message. */
export function sessionLabel(session: Pick<SessionSummary, "name" | "preview">): string {
	return session.name || session.preview || "(no messages)";
}

/**
 * The session `/resume <query>` means, among `sessions` in the order lists show them: a number picks by position
 * (`1` is the most recent), otherwise an id prefix or part of a `/name`, matched when exactly one session fits.
 */
export function matchSession(
	sessions: readonly SessionSummary[],
	query: string,
): { session: SessionSummary } | { error: string } {
	const q = query.trim();
	if (/^\d+$/.test(q)) {
		const session = sessions[Number(q) - 1];
		return session ? { session } : { error: `There is no session ${q}; ${sessions.length} saved here.` };
	}
	const byId = sessions.filter((session) => session.id.startsWith(q));
	if (byId.length === 1) return { session: byId[0] };
	const lower = q.toLowerCase();
	const byName = sessions.filter((session) => session.name?.toLowerCase().includes(lower));
	if (byName.length === 1) return { session: byName[0] };
	if (byId.length + byName.length > 1) return { error: `"${q}" matches more than one session. Use more of it.` };
	return { error: `No saved session matches "${q}".` };
}

/** Sessions are grouped per working directory, so `--continue` and `/resume` only offer this project's sessions. */
export function sessionDirectory(appDir: string, cwd: string): string {
	const name = basename(cwd).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
	return join(appDir, "sessions", `${name}-${hash}`);
}

/**
 * An append-only JSONL transcript. Line 1 is the header; later lines record settings changes and completed
 * messages, each written with a single append as it happens, so a crash loses at most the message in flight.
 * The file is created with the first message, so a session that never sends anything leaves no file behind.
 */
export class SessionFile {
	readonly id: string;
	readonly path: string;
	private readonly cwd: string;
	private settings: SessionSettings;
	private created: boolean;
	/** A `/name` given before the first message, written when the file is created. */
	private pendingName: string | undefined;

	private constructor(id: string, path: string, cwd: string, settings: SessionSettings, created: boolean) {
		this.id = id;
		this.path = path;
		this.cwd = cwd;
		this.settings = settings;
		this.created = created;
	}

	static create(appDir: string, cwd: string, settings: SessionSettings): SessionFile {
		const id = randomUUID();
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		return new SessionFile(id, join(sessionDirectory(appDir, cwd), `${stamp}_${id}.jsonl`), cwd, settings, false);
	}

	/** Keep appending to a loaded session, recording the current settings if they differ from the saved ones. */
	static resume(loaded: LoadedSession, settings: SessionSettings): SessionFile {
		const file = new SessionFile(loaded.header.id, loaded.path, loaded.header.cwd, settings, true);
		if (!sameSettings(loaded.settings, settings)) {
			file.write({ type: "settings", ...settings, timestamp: Date.now() });
		}
		return file;
	}

	updateSettings(settings: SessionSettings): void {
		if (sameSettings(this.settings, settings)) return;
		this.settings = settings;
		if (this.created) this.write({ type: "settings", ...settings, timestamp: Date.now() });
	}

	appendMessage(message: Message): void {
		if (!this.created) {
			mkdirSync(dirname(this.path), { recursive: true });
			this.created = true;
			const createdAt = new Date().toISOString();
			this.write({ type: "session", version: SESSION_VERSION, id: this.id, cwd: this.cwd, createdAt });
			this.write({ type: "settings", ...this.settings, timestamp: Date.now() });
			if (this.pendingName !== undefined)
				this.write({ type: "name", name: this.pendingName, timestamp: Date.now() });
			this.pendingName = undefined;
		}
		this.write({ type: "message", message });
	}

	/** Names the session for `/resume` and the banner. Before the first message, it is written with the file. */
	setName(name: string): void {
		if (this.created) this.write({ type: "name", name, timestamp: Date.now() });
		else this.pendingName = name;
	}

	private write(entry: SessionEntry): void {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}
}

/** Save every message the agent completes into the current session file. Returns the unsubscribe function. */
export function recordSession(agent: Agent, currentFile: () => SessionFile | undefined): () => void {
	return agent.subscribe((event) => {
		if (event.type === "message_end") currentFile()?.appendMessage(event.message);
	});
}

export function loadSession(path: string): LoadedSession {
	const lines = readFileSync(path, "utf8").split("\n");
	let header: SessionHeader | undefined;
	let settings: SessionSettings | undefined;
	let name: string | undefined;
	const messages: Message[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim()) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			// A crash mid-write can leave the final line incomplete; damage anywhere else is an error.
			if (index === lines.length - 1) break;
			throw new Error(`${path}: line ${index + 1} is not valid JSON.`);
		}
		if (!header) {
			if (entry.type !== "session") throw new Error(`${path} is not a pi-lite session file.`);
			header = entry;
		} else if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "settings" && isSamplingMode(entry.mode)) {
			settings = { model: entry.model, mode: entry.mode };
			if (typeof entry.interactionMode === "string" && isInteractionMode(entry.interactionMode)) {
				settings.interactionMode = entry.interactionMode;
			}
			if (entry.web === false) settings.web = false;
			if (entry.rag === true) settings.rag = true;
		} else if (entry.type === "name" && typeof entry.name === "string") {
			name = entry.name;
		}
	}
	if (!header) throw new Error(`${path} is empty.`);
	return { path, header, messages, settings, ...(name ? { name } : {}) };
}

/**
 * The latest `/name` in a session file. Names are rare and may sit anywhere in a long file, so the whole file is
 * searched rather than the preview's head; session files are small enough for that.
 */
function nameIn(path: string, size: number): { name?: string } {
	if (size === 0) return {};
	const text = readFileSync(path, "utf8");
	const at = text.lastIndexOf('{"type":"name"');
	if (at === -1) return {};
	const end = text.indexOf("\n", at);
	try {
		const entry = JSON.parse(text.slice(at, end === -1 ? undefined : end)) as { name?: unknown };
		return typeof entry.name === "string" && entry.name ? { name: entry.name } : {};
	} catch {
		return {};
	}
}

function readSummary(path: string): SessionSummary {
	const info = statSync(path);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(PREVIEW_BYTES, info.size));
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
		const header = JSON.parse(lines[0]) as SessionHeader;
		let preview = "";
		for (const line of lines.slice(1)) {
			let entry: SessionEntry;
			try {
				entry = JSON.parse(line) as SessionEntry;
			} catch {
				break;
			}
			if (entry.type === "message" && entry.message.role === "user") {
				preview = userText(entry.message).replace(/\s+/g, " ").trim();
				break;
			}
		}
		return { id: header.id, path, modified: info.mtime, bytes: info.size, preview, ...nameIn(path, info.size) };
	} finally {
		closeSync(fd);
	}
}

/** Saved sessions for a working directory, most recently written first. Unreadable files are skipped. */
export function listSessions(appDir: string, cwd: string): SessionSummary[] {
	const directory = sessionDirectory(appDir, cwd);
	if (!existsSync(directory)) return [];
	const summaries: SessionSummary[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			summaries.push(readSummary(join(directory, name)));
		} catch {
			// Not a session file, or damaged at the start.
		}
	}
	return summaries.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** A session file path from a path, or from a unique id prefix among this directory's sessions. */
export function resolveSessionPath(appDir: string, cwd: string, query: string): string | undefined {
	if (query.endsWith(".jsonl") && existsSync(query)) return resolve(query);
	const matches = listSessions(appDir, cwd).filter((session) => session.id.startsWith(query));
	return matches.length === 1 ? matches[0].path : undefined;
}
