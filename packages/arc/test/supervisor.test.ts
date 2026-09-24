import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import type { AssistantMessage, ToolCall } from "../src/llm/types.ts";
import { asCritic, askCritic, buildVerdictGBNF, CRITIC_CONTEXT, parseVerdict } from "../src/supervisor/critic.ts";
import { formatChecks, runChecks } from "../src/supervisor/gate.ts";
import {
	changedFiles,
	commitPhase,
	diffBudgetChars,
	diffSince,
	EMPTY_TREE,
	isClean,
	passedPhases,
	phaseStartRef,
} from "../src/supervisor/git.ts";
import { RepeatGuard } from "../src/supervisor/guard.ts";
import { nextPhase, PlanError, parsePlan } from "../src/supervisor/plan.ts";
import { formatUsage, tallyUsage } from "../src/usage.ts";

describe("parsePlan", () => {
	it("splits phases, strips verify blocks from the body, and reads their commands", () => {
		const phases = parsePlan(
			[
				"# App plan",
				"Intro text.",
				"## Phase 1: Scaffold",
				"Create the app.",
				"### Details",
				"Use Vite.",
				"```verify",
				"# build first",
				"npm run build",
				"",
				"npm test -- \\",
				"  --run",
				"```",
				"## Phase 2 - Settings window",
				"Add settings.",
				"## Notes",
				"Not a phase.",
			].join("\n"),
		);
		expect(phases).toEqual([
			{
				number: 1,
				title: "Scaffold",
				body: "Create the app.\n### Details\nUse Vite.",
				verify: ["npm run build", "npm test -- --run"],
			},
			{ number: 2, title: "Settings window", body: "Add settings.", verify: [] },
		]);
	});

	it("keeps other code blocks and ignores headings inside them", () => {
		const [phase, ...rest] = parsePlan(
			["## Phase 1: Docs", "````md", "## Phase 9: quoted", "```verify", "rm -rf /", "```", "````"].join("\n"),
		);
		expect(rest).toEqual([]);
		expect(phase.verify).toEqual([]);
		expect(phase.body).toContain("## Phase 9: quoted");
	});

	it("leaves the divider between phases out of the phase", () => {
		const [first] = parsePlan("## Phase 0: A\nDo it.\n```verify\nnpm test\n```\n\n---\n\n## Phase 1: B\nMore.");
		expect(first).toMatchObject({ number: 0, body: "Do it.", verify: ["npm test"] });
	});

	it("numbers untitled, unnumbered phases by position", () => {
		const phases = parsePlan("## Phase\nA\n## Phase\nB");
		expect(phases.map((phase) => [phase.number, phase.title])).toEqual([
			[1, "Phase 1"],
			[2, "Phase 2"],
		]);
	});

	it("rejects plans it cannot follow", () => {
		expect(() => parsePlan("# Just notes")).toThrow(PlanError);
		expect(() => parsePlan("## Phase 1\n## Phase 1")).toThrow(/appears twice/);
		expect(() => parsePlan("## Phase 1\n```verify\nnpm test")).toThrow(/never closed/);
	});

	it("finds the first phase that has not passed", () => {
		const phases = parsePlan("## Phase 1\n## Phase 2\n## Phase 3");
		expect(nextPhase(phases, new Set([1, 3]))?.number).toBe(2);
		expect(nextPhase(phases, new Set([1, 2, 3]))).toBeUndefined();
	});
});

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "arc-supervisor-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	run("init", "-q");
	run("config", "user.email", "test@example.com");
	run("config", "user.name", "Test");
	run("config", "commit.gpgsign", "false");
	return dir;
}

describe("git", () => {
	it("starts from the empty tree, commits phases, and finds them again", async () => {
		const dir = repo();
		try {
			expect(await phaseStartRef(dir)).toBe(EMPTY_TREE);
			writeFileSync(join(dir, "a.txt"), "one\n");
			expect(await isClean(dir)).toBe(false);
			expect(await changedFiles(dir, EMPTY_TREE)).toEqual([{ path: "a.txt", status: "A", untracked: true }]);

			const first = await commitPhase(dir, 1, "Scaffold\nthe app");
			expect(await isClean(dir)).toBe(true);
			expect(await phaseStartRef(dir)).toBe(first);
			expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir }).toString().trim()).toBe(
				"arc: phase 1 passed: Scaffold the app",
			);

			writeFileSync(join(dir, "a.txt"), "two\n");
			writeFileSync(join(dir, "b.txt"), "new\n");
			expect(await changedFiles(dir, first)).toEqual([
				{ path: "a.txt", status: "M" },
				{ path: "b.txt", status: "A", untracked: true },
			]);
			rmSync(join(dir, "a.txt"));
			await commitPhase(dir, 2, "Delete and add");
			await commitPhase(dir, 3, "Nothing changed");
			expect(await passedPhases(dir)).toEqual(new Set([1, 2, 3]));
			expect(execFileSync("git", ["ls-files"], { cwd: dir }).toString()).toBe("b.txt\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("diffs tracked and untracked changes, cutting only the large diffs to fit", async () => {
		const dir = repo();
		try {
			writeFileSync(join(dir, "small.txt"), "a\n");
			const start = await commitPhase(dir, 1, "Start");
			writeFileSync(join(dir, "small.txt"), "b\n");
			writeFileSync(join(dir, "big.txt"), `${"line of generated output\n".repeat(400)}`);

			const whole = await diffSince(dir, start, 100_000);
			expect(whole.truncated).toEqual([]);
			expect(whole.text).toContain("Changed files (2):\nA big.txt\nM small.txt");
			expect(whole.text).toContain("-a\n+b");

			const cut = await diffSince(dir, start, 2_000);
			expect(cut.truncated).toEqual(["big.txt"]);
			expect(cut.text).toContain("-a\n+b");
			expect(cut.text).toMatch(/more lines of this diff cut/);
			expect(cut.text.length).toBeLessThan(2_200);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives the critic 60% of its window for diffs", () => {
		expect(diffBudgetChars(65_536)).toBe(Math.floor(65_536 * 0.6 * 3));
	});
});

describe("gate", () => {
	it("runs checks in order, stops at the first failure, and keeps the end of the output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "arc-gate-"));
		try {
			const ran: string[] = [];
			const result = await runChecks(["echo built", "seq 1 500; exit 3", "echo never"], dir, {
				onCheck: (command) => ran.push(command),
			});
			expect(ran).toEqual(["echo built", "seq 1 500; exit 3"]);
			expect(result.passed).toBe(false);
			expect(result.checks.map((check) => check.exitCode)).toEqual([0, 3]);
			expect(result.checks[0].output).toBe("built");
			expect(result.checks[1].output).toMatch(/^\[Last 200 of 500 lines\. Full output: /);
			expect(result.checks[1].output.endsWith("\n500")).toBe(true);
			expect(formatChecks(result.checks)).toContain("$ seq 1 500; exit 3\n[exit code 3]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a timeout and finds the screenshots the checks wrote", async () => {
		const dir = mkdtempSync(join(tmpdir(), "arc-gate-"));
		try {
			writeFileSync(join(dir, "old.png"), "");
			utimesSync(join(dir, "old.png"), new Date(0), new Date(0));
			const passed = await runChecks(
				["mkdir -p shots node_modules/x && touch shots/home.png node_modules/x/icon.png notes.txt"],
				dir,
			);
			expect(passed.passed).toBe(true);
			expect(passed.screenshots).toEqual([join(dir, "shots", "home.png")]);

			const slow = await runChecks(["sleep 5"], dir, { timeoutMs: 100 });
			expect(slow.passed).toBe(false);
			expect(slow.checks[0].timedOut).toBe(true);
			expect(formatChecks(slow.checks)).toMatch(/timed out after/);
			expect(formatChecks([])).toBe("No checks are defined for this phase.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const critic: LiteModel = {
	name: "Ornith",
	id: "ornith.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 131_072,
	maxTokens: 16_384,
	modelPath: "/models/ornith.gguf",
	launchArgs: ["--port", "8080", "--ctx-size", "131072", "-ngl", "99"],
	llamaServer: "llama-server",
};

const request = {
	phase: { number: 2, title: "Settings", body: "Add a settings window.", verify: ["npm test"] },
	phaseCount: 3,
	diff: "Changed files (1):\nA settings.ts",
	checks: [{ command: "npm test", exitCode: 0, timedOut: false, output: "3 passed", ms: 10 }],
	screenshots: ["/p/shots/settings.png"],
};

/** A fake llama-server: /apply-template echoes a prompt, /completion streams `reply` in two chunks. */
function criticServer(reply: string) {
	const bodies: Record<string, Record<string, unknown>> = {};
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		bodies[path] = JSON.parse(String(init?.body));
		if (path === "/apply-template") return Response.json({ prompt: "<templated>" });
		const half = Math.floor(reply.length / 2);
		const events = [reply.slice(0, half), reply.slice(half)]
			.map((content) => `data: ${JSON.stringify({ content, stop: false })}\n\n`)
			.join("")
			.concat(
				`data: ${JSON.stringify({ content: "", stop: true, timings: { prompt_n: 900, cache_n: 100, predicted_n: 20 } })}\n\n`,
			);
		return new Response(events);
	}) as typeof fetch;
	return { fetchFn, bodies };
}

describe("critic", () => {
	it("caps the critic's window at 64k, replacing --ctx-size", () => {
		const capped = asCritic(critic);
		expect(capped.contextWindow).toBe(CRITIC_CONTEXT);
		expect(capped.launchArgs).toEqual(["--port", "8080", "-ngl", "99", "--ctx-size", "65536"]);
		expect(asCritic({ ...critic, contextWindow: 32_768, launchArgs: ["-c", "32768"] }).launchArgs).toEqual([
			"--ctx-size",
			"32768",
		]);
	});

	it("builds a grammar with only rule names llama.cpp accepts", () => {
		const grammar = buildVerdictGBNF();
		for (const line of grammar.split("\n")) expect(line).toMatch(/^[a-z][a-z0-9-]* ::= /);
		expect(grammar).toContain("{0,4}");
	});

	it("reads verdicts and treats anything else as unreadable", () => {
		expect(parseVerdict('{"verdict":"pass","reasons":[]}')).toEqual({ pass: true, reasons: [] });
		expect(parseVerdict(' {"verdict": "fail", "reasons": ["settings.ts: no save button"]} ')).toEqual({
			pass: false,
			reasons: ["settings.ts: no save button"],
		});
		expect(parseVerdict('{"verdict":"fail","reasons":[]}')?.reasons[0]).toMatch(/without giving a reason/);
		expect(parseVerdict("It looks fine")).toBeUndefined();
		expect(parseVerdict('{"verdict":"maybe"}')).toBeUndefined();
	});

	it("templates the prompt, then streams /completion under the grammar, listing screenshots as paths", async () => {
		const { fetchFn, bodies } = criticServer('{"verdict":"fail","reasons":["settings.ts: no save button"]}');
		const verdict = await askCritic(asCritic(critic), request, { fetch: fetchFn });
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toEqual(["settings.ts: no save button"]);
		expect(verdict.usage).toEqual({ requests: 1, input: 1000, cached: 100, output: 20 });

		const messages = bodies["/apply-template"].messages as { role: string; content: { text?: string }[] }[];
		expect(bodies["/apply-template"].chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(messages[1].content).toHaveLength(2);
		expect(messages[1].content[0].text).toContain("which you cannot see:\n- /p/shots/settings.png");
		expect(messages[1].content[1].text).toMatch(/^Phase 2 of 3: Settings/);
		expect(bodies["/completion"]).toMatchObject({
			prompt: "<templated>",
			grammar: buildVerdictGBNF(),
			temperature: 0,
			stream: true,
		});
	});

	it("sends screenshots as images to a critic with a vision projector", async () => {
		const { fetchFn, bodies } = criticServer('{"verdict":"pass","reasons":[]}');
		const verdict = await askCritic({ ...asCritic(critic), mmproj: "/models/mm.gguf" }, request, {
			fetch: fetchFn,
			readImage: async () => Buffer.from("png-bytes"),
		});
		expect(verdict).toMatchObject({ pass: true, reasons: [] });
		const content = (bodies["/apply-template"].messages as { content: Record<string, unknown>[] }[])[1].content;
		expect(content[1]).toEqual({
			type: "image_url",
			image_url: { url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` },
		});
		expect(bodies["/completion"].prompt).toEqual({
			prompt_string: "<templated>",
			multimodal_data: [Buffer.from("png-bytes").toString("base64")],
		});
	});

	it("fails the phase when the reply cannot be read", async () => {
		const { fetchFn } = criticServer("not json");
		const verdict = await askCritic(critic, { ...request, screenshots: [] }, { fetch: fetchFn });
		expect(verdict).toMatchObject({ pass: false, reasons: ["The critic returned no readable verdict."] });
	});
});

describe("RepeatGuard", () => {
	const call = (command: string): ToolCall => ({
		type: "toolCall",
		id: command,
		name: "bash",
		arguments: { command },
	});

	it("trips on the third identical call among the last five, alternating or not", () => {
		const guard = new RepeatGuard();
		expect(guard.check(call("cat cli.js"))).toBeUndefined();
		expect(guard.check(call("ls"))).toBeUndefined();
		expect(guard.check(call("cat cli.js"))).toBeUndefined();
		expect(guard.check(call("ls"))).toBeUndefined();
		expect(guard.check(call("cat cli.js"))).toBe("it made the same call 3 times in its last 5: bash cat cli.js");
	});

	it("lets varied work through, and forgets calls that left the window", () => {
		const guard = new RepeatGuard();
		for (const command of ["npm test", "a", "b", "c", "npm test", "d", "e", "f", "npm test"]) {
			expect(guard.check(call(command))).toBeUndefined();
		}
	});
});

describe("usage", () => {
	it("tallies what replies reported, skipping ones without usage", () => {
		const reply = (promptTokens: number, cachedTokens: number, completionTokens: number): AssistantMessage => ({
			role: "assistant",
			content: [],
			model: "m",
			usage: { promptTokens, cachedTokens, completionTokens },
			stopReason: "stop",
			timestamp: 0,
		});
		const usage = tallyUsage([reply(1000, 0, 50), reply(1200, 1000, 40), reply(0, 0, 0)]);
		expect(usage).toEqual({ requests: 2, input: 2200, cached: 1000, output: 90 });
		expect(formatUsage(usage)).toBe("2,200 in (1,000 cached, 1,200 new) · 90 out · 2 requests");
	});
});
