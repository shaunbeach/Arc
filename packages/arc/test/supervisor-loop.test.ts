import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import { ContextWindow } from "../src/context.ts";
import type { Message } from "../src/llm/types.ts";
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
	saved: SupervisorState[];
	cleanup: () => void;
}

/**
 * A temp git repo with `plan`, and a host whose actor runs `act` for each message: it may write files, and its
 * result is the turn's outcome.
 */
function harness(planText: string, act: (text: string, turn: number, dir: string) => ActorResult | undefined): Harness {
	const dir = mkdtempSync(join(tmpdir(), "arc-loop-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "commit.gpgsign", "false");
	const plan = join(dir, "implementation.md");
	writeFileSync(plan, planText);
	git("add", "implementation.md");
	git("commit", "-q", "-m", "plan");

	let transcript = 0;
	const h: Harness = {
		dir,
		plan,
		sent: [],
		critics: 0,
		cleanups: 0,
		notified: [],
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
			notice: () => {},
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
