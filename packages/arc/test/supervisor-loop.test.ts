import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import { ContextWindow } from "../src/context.ts";
import type { Message } from "../src/llm/types.ts";
import type { SessionEntry } from "../src/session.ts";
import { checkedPaths, checkedScripts } from "../src/supervisor/integrity.ts";
import { buildReport, formatReportMarkdown, formatReportText } from "../src/supervisor/report.ts";
import {
	type ActorResult,
	Supervisor,
	type SupervisorHost,
	type SupervisorState,
	startState,
} from "../src/supervisor/supervisor.ts";

const critic: LiteModel = {
	name: "critic",
	id: "critic.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 65_536,
	maxTokens: 1024,
	modelPath: "/models/critic.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};

/** The critic's next replies, in order. */
function stubCritic(...replies: string[]): { prompts: string[] } {
	const prompts: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		if (input.endsWith("/apply-template")) {
			prompts.push(body.messages[1].content.map((part: { text?: string }) => part.text ?? "").join("\n"));
			return Response.json({ prompt: "p" });
		}
		return new Response(`data: ${JSON.stringify({ content: replies.shift() ?? "" })}\n\n`);
	});
	return { prompts };
}

const PASS = '{"verdict":"pass","reasons":[]}';

interface Harness {
	host: SupervisorHost;
	dir: string;
	plan: string;
	sent: { text: string; contextStart: number }[];
	critics: number;
	cleanups: number;
	notified: string[];
	notices: string[];
	saved: SupervisorState[];
	cleanup: () => void;
}

/**
 * A temp git repo with `plan`, and a host whose actor runs `act` for each message: it may write files, and its
 * result is the turn's outcome.
 */
function harness(
	planText: string,
	act: (text: string, turn: number, dir: string) => ActorResult | undefined,
	files: Record<string, string> = {},
): Harness {
	const dir = mkdtempSync(join(tmpdir(), "arc-loop-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "commit.gpgsign", "false");
	const plan = join(dir, "implementation.md");
	writeFileSync(plan, planText);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git("add", ".");
	git("commit", "-q", "-m", "plan");

	let transcript = 0;
	const h: Harness = {
		dir,
		plan,
		sent: [],
		critics: 0,
		cleanups: 0,
		notified: [],
		notices: [],
		saved: [],
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
		host: {
			cwd: dir,
			maxRetries: 2,
			transcriptLength: () => transcript,
			runActor: async (text, contextStart) => {
				h.sent.push({ text, contextStart });
				transcript += 4;
				return act(text, h.sent.length, dir) ?? "done";
			},
			loadCritic: async () => {
				h.critics++;
				return critic;
			},
			stopLeftovers: () => {
				h.cleanups++;
				return 0;
			},
			save: (state) => h.saved.push(state),
			notice: (text) => h.notices.push(text),
			status: () => {},
			notify: (text) => h.notified.push(text),
		},
	};
	return h;
}

const TWO_PHASES = [
	"## Phase 1: A",
	"Create a.txt.",
	"```verify",
	"test -f a.txt",
	"```",
	"## Phase 2: B",
	"Create b.txt.",
	"```verify",
	"test -f b.txt",
	"```",
].join("\n");

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Supervisor", () => {
	it("runs each phase, commits it on a pass, and starts the next in a fresh context", async () => {
		const h = harness(TWO_PHASES, (_text, turn, dir) => {
			writeFileSync(join(dir, turn === 1 ? "a.txt" : "b.txt"), "x");
			return undefined;
		});
		try {
			const { prompts } = stubCritic(PASS, PASS);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const final = await new Supervisor(h.host, state).run(new AbortController().signal);

			expect(final.status).toBe("done");
			// Before and after the checks of each phase.
			expect(h.cleanups).toBe(4);
			expect(h.sent.map((turn) => turn.contextStart)).toEqual([0, 4]);
			expect(h.sent[0].text).toMatch(
				/^\[Supervisor\] Phase 1 of 2: A\n\nCreate a\.txt\.\n\nWhen you finish, these checks run:\n- test -f a\.txt/,
			);
			expect(h.sent[0].text).toContain(
				"- test -f a.txt\nRun these exact commands before you end your turn, and do not change what they test.",
			);
			expect(h.sent[1].text).toContain("Earlier phases built: a.txt.");
			expect(h.sent[1].text).toContain("The whole plan is in implementation.md.");
			expect(prompts[1]).toContain("A b.txt");
			expect(prompts[1]).not.toContain("a.txt");
			const log = execFileSync("git", ["log", "--format=%s"], { cwd: h.dir }).toString();
			expect(log).toBe("arc: phase 2 passed: B\narc: phase 1 passed: A\nplan\n");
			expect(await startState(h.plan, h.dir)).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});

	it("fails a phase on its checks without loading the critic, and keeps the phase's context", async () => {
		const h = harness(TWO_PHASES, (_text, turn, dir) => {
			if (turn === 2) writeFileSync(join(dir, "a.txt"), "x");
			if (turn === 3) writeFileSync(join(dir, "b.txt"), "x");
			return undefined;
		});
		try {
			stubCritic(PASS, PASS);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const final = await new Supervisor(h.host, state).run(new AbortController().signal);
			expect(final.status).toBe("done");
			expect(h.critics).toBe(2);
			expect(h.sent.map((turn) => turn.contextStart)).toEqual([0, 0, 8]);
			expect(h.sent[1].text).toMatch(/^\[Supervisor\] Phase 1 failed review \(attempt 1 of 2\)\./);
			expect(h.sent[1].text).toContain("- Check failed with exit code 1: test -f a.txt");
			expect(h.sent[1].text).toContain("Check output:\n\n$ test -f a.txt\n[exit code 1]");
		} finally {
			h.cleanup();
		}
	});

	it("sends the critic's reasons back, halts after maxRetries with a notification, and resumes with fresh retries", async () => {
		const h = harness("## Phase 1: A\nDo it.", () => undefined);
		try {
			const fail = '{"verdict":"fail","reasons":["a.ts: missing export"]}';
			stubCritic(fail, fail, fail, fail);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const supervisor = new Supervisor(h.host, state);
			const halted = await supervisor.run(new AbortController().signal);
			expect(halted).toMatchObject({ status: "halted", failures: 2, haltReason: "Phase 1/1 failed 2 times." });
			expect(h.notified).toEqual(["Arc Supervisor halted. Intervention required."]);
			expect(h.sent[1].text).toContain("- a.ts: missing export");
			expect(halted.message).toContain("attempt 2 of 2");

			const again = await supervisor.run(new AbortController().signal);
			expect(again.status).toBe("halted");
			expect(h.sent[2].text).toContain("attempt 2 of 2");
			expect(h.sent[3].text).toContain("attempt 1 of 2");
			expect(h.saved.at(-1)).toEqual(again);
		} finally {
			h.cleanup();
		}
	});

	it("stops when the actor's turn is aborted, and resumes by asking it to continue", async () => {
		const h = harness("## Phase 1: A\nDo it.", (_text, turn) => (turn === 1 ? "aborted" : undefined));
		try {
			stubCritic(PASS);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const supervisor = new Supervisor(h.host, state);
			expect((await supervisor.run(new AbortController().signal)).status).toBe("stopped");
			expect(h.critics).toBe(0);
			expect((await supervisor.run(new AbortController().signal)).status).toBe("done");
			expect(h.sent[1]).toEqual({ text: "[Supervisor] Continue phase 1, then end your turn.", contextStart: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("audits at once with /audit, and stops cleanly when aborted during the checks", async () => {
		const h = harness("## Phase 1: A\n```verify\nsleep 5\n```", () => undefined);
		try {
			stubCritic(PASS);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);
			const stopped = await new Supervisor(h.host, state).run(controller.signal, "audit");
			expect(stopped).toMatchObject({ status: "stopped", stage: "audit" });
			expect(h.sent).toEqual([]);
		} finally {
			h.cleanup();
		}
	});
});

describe("Supervisor loop guard", () => {
	it("checks the phase at once when the guard stops the actor, and tells it why on a fail", async () => {
		const h = harness("## Phase 1: A\n```verify\ntest -f a.txt\n```", (_text, turn, dir) => {
			if (turn === 1) return { stuck: "it made the same call 3 times in its last 3: bash cat x" };
			writeFileSync(join(dir, "a.txt"), "x");
			return undefined;
		});
		try {
			stubCritic(PASS);
			const state = await startState(h.plan, h.dir);
			if (!state) throw new Error("no phase");
			const final = await new Supervisor(h.host, state).run(new AbortController().signal);
			expect(final.status).toBe("done");
			expect(h.sent[1].text).toContain(
				"Your last turn was stopped because it made the same call 3 times in its last 3: bash cat x. Try a different approach.",
			);
			expect(h.sent[1].text).toContain("attempt 1 of 2");
			expect(final.stuck).toBeUndefined();
			expect(final.criticUsage).toEqual({ requests: 1, input: 0, cached: 0, output: 0 });
		} finally {
			h.cleanup();
		}
	});
});

describe("ContextWindow.startAt", () => {
	const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

	it("leaves out everything before a phase's kickoff and never moves back", () => {
		const window = new ContextWindow();
		const messages = [user("phase 1"), user("more"), user("phase 2")];
		window.startAt(2);
		expect(window.select(messages, 10_000, 0).messages).toEqual([user("phase 2")]);
		window.startAt(1);
		expect(window.select(messages, 10_000, 0).messages).toEqual([user("phase 2")]);
	});
});

describe("supervisor report", () => {
	const s = 1000;
	const state = (phase: number, status: SupervisorState["status"], stage: "actor" | "audit", critic?: number[]) => ({
		plan: "/p/implementation.md",
		status,
		phase,
		stage,
		failures: 0,
		...(critic ? { criticUsage: { requests: critic[0], input: critic[1], cached: 0, output: critic[2] } } : {}),
	});
	const save = (timestamp: number, value: SupervisorState): SessionEntry => ({
		type: "supervisor",
		state: value,
		timestamp,
	});
	const reply = (timestamp: number, promptTokens: number, cachedTokens: number, completionTokens: number) =>
		({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				model: "m",
				usage: { promptTokens, cachedTokens, completionTokens },
				stopReason: "stop",
				timestamp,
			},
		}) as SessionEntry;
	const entries: SessionEntry[] = [
		save(0, state(1, "running", "actor")),
		reply(30 * s, 100, 0, 10),
		save(60 * s, state(1, "running", "audit")),
		save(70 * s, state(1, "running", "actor", [1, 1000, 5])),
		save(130 * s, state(1, "running", "audit", [1, 1000, 5])),
		save(140 * s, state(2, "running", "actor", [2, 2500, 10])),
		save(200 * s, state(2, "halted", "actor", [2, 2500, 10])),
		{ type: "message", message: { role: "user", content: "hint", timestamp: 250 * s } },
		reply(310 * s, 200, 50, 20),
		save(500 * s, state(2, "running", "actor", [2, 2500, 10])),
		save(560 * s, state(2, "running", "audit", [2, 2500, 10])),
		save(600 * s, state(2, "done", "audit", [3, 3000, 12])),
	];

	it("splits each phase into actor, review, manual work, and waiting, with its tries and tokens", () => {
		const report = buildReport(entries, new Map([[1, "Types"]]));
		expect(report?.status).toBe("done");
		expect(report?.phases).toEqual([
			{
				phase: 1,
				title: "Types",
				startedAt: 0,
				endedAt: 140 * s,
				actorMs: 120 * s,
				reviewMs: 20 * s,
				manualMs: 0,
				waitingMs: 0,
				audits: 2,
				result: "passed",
				actor: { requests: 1, input: 100, cached: 0, output: 10 },
				critic: { requests: 2, input: 2500, cached: 0, output: 10 },
			},
			{
				phase: 2,
				title: "Phase 2",
				startedAt: 140 * s,
				endedAt: 600 * s,
				actorMs: 120 * s,
				reviewMs: 40 * s,
				manualMs: 60 * s,
				waitingMs: 240 * s,
				audits: 1,
				result: "passed",
				actor: { requests: 1, input: 200, cached: 50, output: 20 },
				critic: { requests: 1, input: 500, cached: 0, output: 2 },
			},
		]);
	});

	it("formats a table for the terminal and a Markdown file", () => {
		const report = buildReport(entries, new Map([[1, "Types"]]));
		if (!report) throw new Error("no report");
		const text = formatReportText(report);
		expect(text).toMatch(/^Supervisor report: implementation\.md \(done\)/);
		expect(text).toMatch(/\nTotal\s+6m\s+5m\*\s+1m\s+3\s+300\s+250\s+30\s+3,000\n/);
		expect(text).toContain("* includes 1m of work on messages typed while the loop was halted.");
		expect(text).toContain("Waiting for you, not counted above: 4m.");
		const markdown = formatReportMarkdown(report);
		expect(markdown).toContain("| 1 Types | passed | 2m | 2m | 20s | 2 | 100 | 100 | 10 | 2,500 | 10 |");
		expect(markdown).toContain("- Critic tokens: 3,000 in, 12 out, 3 reviews");
	});

	it("reports nothing for a session without a supervisor run", () => {
		expect(buildReport([], new Map())).toBeUndefined();
	});
});

describe("tampering", () => {
	const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
	async function run(h: Harness): Promise<{ final: SupervisorState; supervisor: Supervisor }> {
		const state = await startState(h.plan, h.dir);
		if (!state) throw new Error("no phase");
		const supervisor = new Supervisor(h.host, state);
		return { final: await supervisor.run(new AbortController().signal), supervisor };
	}
	const CHECKED = "## Phase 1: A\nCreate a.txt.\n```verify\ntest -f a.txt\n```\n";

	it("reads checks from the plan as committed, and restores a plan the actor edited", async () => {
		const h = harness(CHECKED, (_text, turn, dir) => {
			// First turn: delete the check instead of doing the work.
			if (turn === 1) writeFileSync(join(dir, "implementation.md"), "## Phase 1: A\nCreate a.txt.\n");
			else writeFileSync(join(dir, "a.txt"), "x");
			return undefined;
		});
		try {
			stubCritic(PASS);
			const { final } = await run(h);
			expect(final.status).toBe("done");
			expect(h.sent[1].text).toContain("The plan file implementation.md was changed. It has been restored");
			expect(readFileSync(h.plan, "utf8")).toBe(CHECKED);
			expect(h.critics).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	it("fails a phase that changes a package script its checks run", async () => {
		const h = harness(
			"## Phase 1: A\nCreate a.txt.\n```verify\nnpm run check\n```\n",
			(_text, turn, dir) => {
				const pkg = (check: string) => JSON.stringify({ name: "t", scripts: { check } });
				if (turn === 1) writeFileSync(join(dir, "package.json"), pkg("true"));
				else {
					writeFileSync(join(dir, "package.json"), pkg("test -f a.txt"));
					writeFileSync(join(dir, "a.txt"), "x");
				}
				return undefined;
			},
			{ "package.json": JSON.stringify({ name: "t", scripts: { check: "test -f a.txt" } }) },
		);
		try {
			stubCritic(PASS);
			const { final } = await run(h);
			expect(final.status).toBe("done");
			expect(h.sent[1].text).toContain(
				'The "check" script in package.json, which a check runs, changed from "test -f a.txt" to "true".',
			);
			expect(h.critics).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	it("lets a phase change a script its text names", async () => {
		const h = harness(
			'## Phase 1: A\nSet the script: "check": "test -f b.txt"\n```verify\nnpm run check\n```\n',
			(_text, _turn, dir) => {
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({ name: "t", scripts: { check: "test -f b.txt" } }),
				);
				writeFileSync(join(dir, "b.txt"), "x");
				return undefined;
			},
			{ "package.json": JSON.stringify({ name: "t", scripts: { check: "false" } }) },
		);
		try {
			stubCritic(PASS);
			const { final } = await run(h);
			expect(final.status).toBe("done");
			expect(h.sent).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});

	it("fails a phase that changes a file its checks run", async () => {
		const h = harness(
			"## Phase 1: A\nCreate a.txt.\n```verify\nsh checks/verify.sh\n```\n",
			(_text, turn, dir) => {
				if (turn === 1) writeFileSync(join(dir, "checks/verify.sh"), "exit 0\n");
				else {
					writeFileSync(join(dir, "checks/verify.sh"), "test -f a.txt\n");
					writeFileSync(join(dir, "a.txt"), "x");
				}
				return undefined;
			},
			{ "checks/verify.sh": "test -f a.txt\n" },
		);
		try {
			stubCritic(PASS);
			const { final } = await run(h);
			expect(final.status).toBe("done");
			expect(h.sent[1].text).toContain("checks/verify.sh, which a check uses, was changed.");
		} finally {
			h.cleanup();
		}
	});

	it("fails a phase that makes its own passed-phase commit, and never skips the phase it named", async () => {
		const h = harness(TWO_PHASES, (_text, turn, dir) => {
			if (turn === 1) {
				writeFileSync(join(dir, "a.txt"), "x");
				git(dir, "add", "a.txt");
				git(dir, "commit", "-q", "-m", "arc: phase 2 passed: B");
			} else if (turn === 2) {
				git(dir, "reset", "-q", "--soft", "HEAD~1");
			} else {
				writeFileSync(join(dir, "b.txt"), "x");
			}
			return undefined;
		});
		try {
			stubCritic(PASS, PASS);
			const { final } = await run(h);
			expect(final.status).toBe("done");
			expect(h.sent[1].text).toContain('titled like a passed phase ("arc: phase 2 passed: B")');
			expect(h.sent[2].text).toMatch(/^\[Supervisor\] Phase 2 of 2: B/);
			expect(final.passed?.map((entry) => entry.phase)).toEqual([1, 2]);
		} finally {
			h.cleanup();
		}
	});

	it("halts when the actor rewrites the history of a passed phase", async () => {
		const h = harness(TWO_PHASES, (_text, turn, dir) => {
			if (turn === 1) writeFileSync(join(dir, "a.txt"), "x");
			else {
				git(dir, "reset", "-q", "--hard", "HEAD~1");
				writeFileSync(join(dir, "b.txt"), "x");
			}
			return undefined;
		});
		try {
			stubCritic(PASS, PASS);
			const { final } = await run(h);
			expect(final.status).toBe("halted");
			expect(final.haltReason).toMatch(
				/^Git history was rewritten: phase 1's passed commit [0-9a-f]{8} is no longer part of it\.$/,
			);
			expect(h.critics).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	it("will not resume over a person's edit to the plan, and follows it after a commit and reload", async () => {
		const h = harness(CHECKED, (_text, turn, dir) => {
			if (turn === 1) return "aborted";
			writeFileSync(join(dir, "b.txt"), "x");
			return undefined;
		});
		try {
			stubCritic(PASS);
			const { supervisor } = await run(h);
			expect(supervisor.state.status).toBe("stopped");
			const edited = "## Phase 1: A\nCreate b.txt.\n```verify\ntest -f b.txt\n```\n";
			writeFileSync(h.plan, edited);

			const refused = await supervisor.run(new AbortController().signal);
			expect(refused.status).toBe("stopped");
			expect(h.sent).toHaveLength(1);
			expect(h.notices.at(-1)).toContain("implementation.md changed since this run started");
			expect(readFileSync(h.plan, "utf8")).toBe(edited);

			await expect(supervisor.reload()).rejects.toThrow(/uncommitted changes/);
			git(h.dir, "commit", "-q", "-am", "plan: b.txt");
			await supervisor.reload();
			expect((await supervisor.run(new AbortController().signal)).status).toBe("done");
		} finally {
			h.cleanup();
		}
	});

	it("refuses to start from a plan that is not committed as it is on disk", async () => {
		const h = harness(CHECKED, () => undefined);
		try {
			writeFileSync(h.plan, `${CHECKED}\nMore.\n`);
			await expect(startState(h.plan, h.dir)).rejects.toThrow(/uncommitted changes/);
		} finally {
			h.cleanup();
		}
	});
});

describe("check parsing for tamper detection", () => {
	it("finds the scripts and files a check runs", () => {
		const commands = [
			"npm run typecheck",
			"npm test && yarn lint && pnpm run build:web",
			"npm install && npx tsc",
			"sh checks/verify.sh && test -f out/main/index.js",
			"! rg 'node:|fetch\\(' src/renderer src/preload",
			'test "$(grep -c x src/shared/constants.ts)" = 1',
		];
		expect(checkedScripts(commands)).toEqual(["typecheck", "test", "lint", "build:web"]);
		expect(checkedPaths(commands)).toEqual([
			"checks/verify.sh",
			"out/main/index.js",
			"src/renderer",
			"src/preload",
			"src/shared/constants.ts",
		]);
	});
});
