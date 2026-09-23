import { describe, expect, it } from "vitest";
import { ContextWindow } from "../src/context.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "../src/llm/types.ts";
import { buildWorkLog, redirectTargets, testSummary } from "../src/work-log.ts";

const cwd = "/work/app";
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const step = (...content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	model: "m",
	usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
	stopReason: "toolUse",
	timestamp: 0,
});
const result = (id: string, toolName: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError,
	timestamp: 0,
});
/** A step and its result, as two transcript messages. */
const tool = (id: string, name: string, args: Record<string, unknown>, output = "ok", isError = false): Message[] => [
	step(call(id, name, args)),
	result(id, name, output, isError),
];
const all = (messages: readonly Message[]) => ({ earlierBefore: 0, from: 1, to: messages.length });

describe("buildWorkLog", () => {
	it("reports files written and edited, reads, the plan, and the last test run", () => {
		const messages: Message[] = [
			user("build phase 2"),
			...tool("c1", "read", { path: "/work/app/implementation.md" }),
			...tool("c2", "write", { path: "/work/app/src/App.vue", content: "a\nb" }),
			...tool("c3", "write", { path: "/work/app/src/App.vue", content: "a\nb\nc" }),
			...tool("c4", "edit", { path: "src/App.vue", oldText: "a", newText: "x" }),
			...tool("c5", "edit", { path: "/work/app/src/main.js", oldText: "a", newText: "b" }),
			...tool(
				"c6",
				"edit",
				{ path: "/work/app/src/main.js", oldText: "q", newText: "r" },
				"Could not find oldText",
				true,
			),
			...tool("c7", "read", { path: "/work/app/src/stores/theme.js" }),
			...tool("c8", "read", { path: "/work/app/src/main.js" }),
			...tool(
				"c9",
				"bash",
				{ command: "cd /work/app && npm test 2>&1 | tail -5" },
				"\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[32m47 passed\u001b[39m (49)\n   Duration 1.2s",
			),
		];

		expect(buildWorkLog(messages, all(messages), cwd)).toBe(
			[
				"(Work so far, from steps left out to save context:",
				"- Wrote: src/App.vue (3 lines, written 2 times, edited 1 time)",
				"- Edited: src/main.js (2 edits, last one failed)",
				"- Plan: implementation.md",
				"- Read: src/stores/theme.js",
				'- Last test run: `cd /work/app && npm test 2>&1 | tail -5`, exited with code 0: "Tests 2 failed | 47 passed (49)"',
				"The files are on disk as last written; read one again before changing it.)",
			].join("\n"),
		);
	});

	it("reports nothing when nothing is left out, or nothing left out changed or read a file", () => {
		const messages: Message[] = [user("go"), ...tool("c1", "write", { path: "a.txt", content: "a" })];
		expect(buildWorkLog(messages, { earlierBefore: 0, from: 1, to: 1 }, cwd)).toBeUndefined();
		const quiet: Message[] = [user("go"), ...tool("c1", "bash", { command: "ls" })];
		expect(buildWorkLog(quiet, all(quiet), cwd)).toBeUndefined();
	});

	it("leaves out a test run that is still in the request", () => {
		const messages: Message[] = [
			user("go"),
			...tool("c1", "bash", { command: "npm test" }, "Tests 1 failed", true),
			...tool("c2", "bash", { command: "npm test" }, "Tests 3 passed"),
		];
		const log = buildWorkLog(messages, { earlierBefore: 0, from: 1, to: 3 }, cwd);
		expect(log).toBeUndefined();
	});

	it("uses the exit code when the output has no summary", () => {
		const messages: Message[] = [
			user("go"),
			...tool("c1", "bash", { command: "pytest -q" }, "boom\n\nCommand exited with code 2", true),
		];
		expect(buildWorkLog(messages, all(messages), cwd)).toContain(
			"- Last test run: `pytest -q`, exited with code 2\n",
		);
	});

	it("lists files changed through clear shell redirects", () => {
		const messages: Message[] = [
			user("go"),
			...tool("c1", "bash", { command: "cat > src/util.js << 'EOF'\nexport const x = 1;\nEOF" }),
			...tool("c2", "bash", { command: "python3 - << 'PY'\nopen('src/hidden.js','w')\nPY" }),
			...tool("c3", "bash", { command: "npm run dev > /tmp/dev.log 2>&1 &" }),
		];
		expect(buildWorkLog(messages, all(messages), cwd)).toContain("- Changed through bash: src/util.js\n");
	});

	it("sums up earlier tasks in one line", () => {
		const messages: Message[] = [
			user("phase 1"),
			...Array.from({ length: 7 }, (_, i) => tool(`e${i}`, "write", { path: `src/f${i}.js`, content: "x" })).flat(),
			user("phase 2"),
			...tool("c1", "read", { path: "src/f1.js" }),
		];
		const log = buildWorkLog(messages, { earlierBefore: 15, from: 16, to: 16 }, cwd);
		expect(log).toContain(
			"- Earlier tasks in this session changed 7 files: src/f0.js, src/f1.js, src/f2.js, src/f3.js, src/f4.js, and 2 more\n",
		);
		expect(log).not.toContain("Read:");
	});

	it("stays under its size limit by dropping reads, then shortening file lists", () => {
		const messages: Message[] = [user("go")];
		for (let i = 0; i < 40; i++) {
			messages.push(...tool(`w${i}`, "write", { path: `src/components/Component${i}.vue`, content: "x" }));
			messages.push(...tool(`r${i}`, "read", { path: `src/stores/store${i}.js` }));
		}
		const log = buildWorkLog(messages, all(messages), cwd) ?? "";
		expect(log.length).toBeLessThanOrEqual(900);
		expect(log).not.toContain("Read:");
		expect(log).toMatch(/- Wrote: src\/components\/Component0\.vue \(1 line\), .*, and \d+ more\n/);
	});
});

describe("redirectTargets and testSummary", () => {
	it("finds only clear redirects", () => {
		expect(redirectTargets("cat > a.js << 'EOF'")).toEqual(["a.js"]);
		expect(redirectTargets("echo hi >> log.txt && npm test 2>&1 | tee out.txt")).toEqual(["log.txt", "out.txt"]);
		expect(redirectTargets("grep '>' a.js > /dev/null 2>&1")).toEqual([]);
		expect(redirectTargets(`node -e "const f = (x) => x"`)).toEqual([]);
	});

	it("reads count lines from common test runners", () => {
		expect(testSummary("Tests:       1 failed, 5 passed, 6 total\nTime: 1s")).toBe(
			"Tests: 1 failed, 5 passed, 6 total",
		);
		expect(testSummary("==== 2 failed, 10 passed in 0.31s ====")).toBe("==== 2 failed, 10 passed in 0.31s ====");
		expect(testSummary("compiled fine")).toBeUndefined();
	});
});

describe("ContextWindow work log", () => {
	/** One long task: 12 steps that each write a file, then run the tests. */
	const longTask = (): Message[] => {
		const messages: Message[] = [user("build it")];
		for (let i = 0; i < 12; i++) {
			messages.push(...tool(`w${i}`, "write", { path: `/work/app/src/f${i}.js`, content: "x\n".repeat(150) }));
		}
		messages.push(...tool("t1", "bash", { command: "npm test" }, "Tests 1 failed | 3 passed (4)"));
		return messages;
	};

	it("sends the log with the task once steps are left out, and keeps the transcript as it is", async () => {
		const messages = longTask();
		const window = new ContextWindow({ cwd });
		const selection = await window.select(messages, 700, 0, "all");

		expect(selection.trimmed).toBe(true);
		expect(selection.droppedMessages).toBeGreaterThan(0);
		const first = selection.messages[0] as UserMessage;
		expect(first.content).toMatch(
			/^build it\n\n\(Work so far, from steps left out to save context:\n- Wrote: src\/f0\.js/,
		);
		expect(selection.messages[1].role).toBe("assistant");
		expect(messages[0]).toEqual(user("build it"));
	});

	it("keeps the log byte-identical until the next trim", async () => {
		const messages = longTask();
		const window = new ContextWindow({ cwd });
		const first = await window.select(messages, 700, 0, "all");
		messages.push(step(call("r1", "read", { path: "/work/app/src/f11.js" })), result("r1", "read", "x"));
		const next = await window.select(messages, 700, 0, "all");

		expect(next.trimmed).toBe(false);
		expect(next.messages[0]).toEqual(first.messages[0]);
	});

	it("adds no log while nothing is left out", async () => {
		const messages = longTask();
		const selection = await new ContextWindow({ cwd }).select(messages, 100_000, 0, "all");
		expect(selection.messages[0]).toBe(messages[0]);
	});
});
