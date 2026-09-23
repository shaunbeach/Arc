import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "../src/llm/types.ts";
import {
	listSessions,
	loadSession,
	matchSession,
	resolveSessionPath,
	SessionFile,
	type SessionSettings,
	sessionDirectory,
} from "../src/session.ts";

const settings: SessionSettings = { model: "model-a", mode: "thinking" };
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model: "model-a",
	usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 2 },
	stopReason: "stop",
	timestamp: 2,
});

const appDir = () => mkdtempSync(join(tmpdir(), "pi-lite-sessions-"));
const entries = (path: string) =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

describe("SessionFile", () => {
	it("creates the file with the first message and appends after that", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		expect(existsSync(file.path)).toBe(false);

		file.appendMessage(user("hi"));
		file.appendMessage(assistant("hello"));

		const lines = entries(file.path);
		expect(lines.map((line) => line.type)).toEqual(["session", "settings", "message", "message"]);
		expect(lines[0]).toMatchObject({ type: "session", version: 1, id: file.id, cwd: "/work/project" });
		expect(lines[1]).toMatchObject(settings);
	});

	it("records settings changes, folding changes made before the first message into the header", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		file.updateSettings({ model: "model-b", mode: "instruct" });
		expect(existsSync(file.path)).toBe(false);
		file.appendMessage(user("hi"));
		file.updateSettings({ model: "model-b", mode: "instruct" });
		file.updateSettings({ model: "model-b", mode: "thinking" });

		expect(entries(file.path).filter((line) => line.type === "settings")).toMatchObject([
			{ model: "model-b", mode: "instruct" },
			{ model: "model-b", mode: "thinking" },
		]);
	});

	it("round-trips messages and the latest settings", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		file.appendMessage(user("hi"));
		file.appendMessage(assistant("hello"));
		file.updateSettings({ model: "model-a", mode: "instruct" });

		const loaded = loadSession(file.path);
		expect(loaded.header.id).toBe(file.id);
		expect(loaded.messages).toEqual([user("hi"), assistant("hello")]);
		expect(loaded.settings).toEqual({ model: "model-a", mode: "instruct" });
	});

	it("records and restores the interaction mode, reading old files as agent mode", () => {
		const file = SessionFile.create(appDir(), "/work/project", { ...settings, interactionMode: "agent" });
		file.appendMessage(user("plan the refactor"));
		file.updateSettings({ ...settings, interactionMode: "plan" });
		expect(loadSession(file.path).settings).toEqual({ ...settings, interactionMode: "plan" });

		// Resuming with the same settings writes nothing; a mode change is recorded like a model change.
		const before = entries(file.path).length;
		SessionFile.resume(loadSession(file.path), { ...settings, interactionMode: "plan" });
		expect(entries(file.path)).toHaveLength(before);
		SessionFile.resume(loadSession(file.path), { ...settings, interactionMode: "chat" });
		expect(loadSession(file.path).settings?.interactionMode).toBe("chat");

		// Files written before modes were recorded have no field, and an unknown value is ignored.
		const old = SessionFile.create(appDir(), "/work/project", settings);
		old.appendMessage(user("hi"));
		appendFileSync(
			old.path,
			`${JSON.stringify({ type: "settings", ...settings, interactionMode: "bogus", timestamp: 2 })}\n`,
		);
		expect(loadSession(old.path).settings).toEqual(settings);
		// Missing and "agent" are the same mode, so resuming an old file in agent mode writes nothing.
		const count = entries(old.path).length;
		SessionFile.resume(loadSession(old.path), { ...settings, interactionMode: "agent" });
		expect(entries(old.path)).toHaveLength(count);
	});

	it("records web off and reads a missing value as web on", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		file.appendMessage(user("hi"));
		expect(loadSession(file.path).settings?.web).toBeUndefined();

		file.updateSettings({ ...settings, web: false });
		expect(loadSession(file.path).settings).toEqual({ ...settings, web: false });
		file.updateSettings({ ...settings, web: true });
		expect(loadSession(file.path).settings?.web).toBeUndefined();
	});

	it("resumes appending to an existing file and records a different model", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		file.appendMessage(user("hi"));

		const resumed = SessionFile.resume(loadSession(file.path), { model: "model-b", mode: "instruct" });
		resumed.appendMessage(user("again"));

		const loaded = loadSession(file.path);
		expect(resumed.id).toBe(file.id);
		expect(loaded.messages.map((message) => message.content)).toEqual(["hi", "again"]);
		expect(loaded.settings).toEqual({ model: "model-b", mode: "instruct" });
	});

	it("ignores a final line cut short by a crash but rejects damage earlier in the file", () => {
		const file = SessionFile.create(appDir(), "/work/project", settings);
		file.appendMessage(user("hi"));
		appendFileSync(file.path, '{"type":"message","message":{"role":"us');
		expect(loadSession(file.path).messages).toEqual([user("hi")]);

		const broken = join(appDir(), "broken.jsonl");
		writeFileSync(broken, `${readFileSync(file.path, "utf8").split("\n")[0]}\nnot json\n{"type":"message"}\n`);
		expect(() => loadSession(broken)).toThrow("line 2 is not valid JSON");
	});
});

describe("listing sessions", () => {
	it("lists this directory's sessions newest first, with the first user message as preview", () => {
		const dir = appDir();
		const older = SessionFile.create(dir, "/work/project", settings);
		older.appendMessage(user("first   question\nabout things"));
		const newer = SessionFile.create(dir, "/work/project", settings);
		newer.appendMessage(user("second question"));
		SessionFile.create(dir, "/work/other", settings).appendMessage(user("elsewhere"));
		const past = new Date(Date.now() - 60_000);
		utimesSync(older.path, past, past);

		const sessions = listSessions(dir, "/work/project");
		expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id]);
		expect(sessions[1].preview).toBe("first question about things");
	});

	it("resolves a session from a unique id prefix or a path", () => {
		const dir = appDir();
		const file = SessionFile.create(dir, "/work/project", settings);
		file.appendMessage(user("hi"));

		expect(resolveSessionPath(dir, "/work/project", file.id.slice(0, 8))).toBe(file.path);
		expect(resolveSessionPath(dir, "/work/project", file.path)).toBe(file.path);
		expect(resolveSessionPath(dir, "/work/project", "zzzz")).toBeUndefined();
	});

	it("keeps directories with the same name apart", () => {
		expect(sessionDirectory("/app", "/a/project")).not.toBe(sessionDirectory("/app", "/b/project"));
		expect(sessionDirectory("/app", "/a/project")).toMatch(/\/app\/sessions\/project-[0-9a-f]{8}$/);
	});
});

describe("naming and matching sessions", () => {
	it("keeps a name given before the first message, and the latest name after", () => {
		const dir = appDir();
		const file = SessionFile.create(dir, "/work/project", settings);
		file.setName("toolbar phase");
		expect(existsSync(file.path)).toBe(false);
		file.appendMessage(user("build the toolbar"));
		expect(loadSession(file.path).name).toBe("toolbar phase");
		file.appendMessage(user("x".repeat(100_000)));
		file.setName("toolbar and shortcuts");
		file.appendMessage(user("more"));
		expect(loadSession(file.path).name).toBe("toolbar and shortcuts");
		expect(listSessions(dir, "/work/project")[0]).toMatchObject({
			name: "toolbar and shortcuts",
			preview: "build the toolbar",
		});
	});

	it("resumes by position, id prefix, or part of a name, and says why not", () => {
		const sessions = [
			{ id: "aaaa1111", path: "/a", modified: new Date(), bytes: 1, preview: "first", name: "Toolbar phase" },
			{ id: "bbbb2222", path: "/b", modified: new Date(), bytes: 1, preview: "second" },
			{ id: "cccc3333", path: "/c", modified: new Date(), bytes: 1, preview: "third", name: "tool picker" },
		];
		expect(matchSession(sessions, "2")).toMatchObject({ session: { path: "/b" } });
		expect(matchSession(sessions, "cccc")).toMatchObject({ session: { path: "/c" } });
		expect(matchSession(sessions, "toolbar")).toMatchObject({ session: { path: "/a" } });
		expect(matchSession(sessions, "tool")).toEqual({
			error: '"tool" matches more than one session. Use more of it.',
		});
		expect(matchSession(sessions, "9")).toEqual({ error: "There is no session 9; 3 saved here." });
		expect(matchSession(sessions, "nothing")).toEqual({ error: 'No saved session matches "nothing".' });
	});
});
