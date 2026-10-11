import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.ts";
import type { AgentTool } from "../src/agent/types.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "mcp-server.mjs");

function project(servers: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "arc-mcp-")));
	writeFileSync(join(dir, "mcp.yml"), `servers:\n${servers}`);
	return dir;
}

const fixture = (name: string, extra = "") =>
	`  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FIXTURE)}]\n${extra}`;

describe("McpManager", () => {
	const managers: McpManager[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const manager = (servers: string) => {
		const dir = project(servers);
		dirs.push(dir);
		const created = new McpManager(dir);
		managers.push(created);
		return { dir, mcp: created };
	};

	it("runs servers in the project and renames tools that clash", async () => {
		const { dir, mcp } = manager(fixture("notes") + fixture("other"));
		await mcp.startServer("notes");
		await mcp.startServer("other");
		const { tools, renamed } = await mcp.tools(BUILTIN_TOOL_NAMES);
		expect(tools.map((tool) => tool.name)).toEqual([
			"notes_read",
			"where",
			"change",
			"other_read",
			"other_where",
			"other_change",
		]);
		expect(renamed).toContain("read → notes_read");
		const where = tools.find((tool) => tool.name === "where")!;
		expect((await where.execute("1", {})).content).toEqual([{ type: "text", text: dir }]);
	}, 30_000);

	it("marks tools read-only from the server's hint or mcp.yml", async () => {
		const { mcp } = manager(fixture("hinted") + fixture("trusted", "    readOnly: true\n"));
		await mcp.startServer("hinted");
		await mcp.startServer("trusted");
		const { tools } = await mcp.tools(BUILTIN_TOOL_NAMES);
		const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.readOnly]));
		expect(readOnly).toMatchObject({ where: true, change: false, trusted_change: true });
	}, 30_000);

	it("kills every server at once when quitting", async () => {
		const { mcp } = manager(fixture("notes"));
		await mcp.startServer("notes");
		const running = await mcp.tools(BUILTIN_TOOL_NAMES);
		expect(running.tools.length).toBeGreaterThan(0);
		const pids = execFileSync("pgrep", ["-f", FIXTURE]).toString().trim().split("\n");
		mcp.killAllSync();
		expect(mcp.getRunningNames()).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		for (const pid of pids) expect(() => process.kill(Number(pid), 0)).toThrow();
	}, 30_000);

	it("explains a server that does not start, with its stderr", async () => {
		const { mcp } = manager(fixture("broken", '    env:\n      MCP_FIXTURE_FAIL: "1"\n'));
		await expect(mcp.startServer("broken")).rejects.toThrow(/MCP server broken did not start[\s\S]*missing API key/);
		expect(mcp.getRunningNames()).toEqual([]);
	}, 30_000);
});

describe("MCP tools by mode", () => {
	const tool = (name: string, readOnly: boolean): AgentTool => ({
		name,
		label: name,
		description: name,
		readOnly,
		parameters: { type: "object", properties: {} } as never,
		execute: async () => ({ content: [] }),
	});

	it("offers only read-only MCP tools outside agent mode", () => {
		const agent = new Agent({ systemPrompt: "s", tools: [] });
		agent.setMcpTools([tool("docs", true), tool("click", false)]);
		expect(agent.activeTools.map((t) => t.name)).toEqual(["docs", "click"]);
		agent.setInteractionMode("plan");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["docs"]);
		agent.setInteractionMode("chat");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["docs"]);
	});
});
