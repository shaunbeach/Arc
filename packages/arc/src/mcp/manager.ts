import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";
import type { AgentTool } from "../agent/types.ts";
import { getAppDir } from "../config/paths.ts";
import { createMcpAgentTool } from "./tool.ts";

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * Every tool of this server only reads, so plan and chat modes may use them too. Without it, only tools the server
	 * itself marks read-only (`readOnlyHint`) leave agent mode.
	 */
	readOnly?: boolean;
}

export interface McpConfig {
	servers?: Record<string, McpServerConfig>;
}

/** Lines of a server's stderr kept to explain a failed start. */
const STDERR_LINES = 20;

interface RunningServer {
	client: Client;
	transport: StdioClientTransport;
	config: McpServerConfig;
	stderr: string[];
}

/**
 * The MCP servers in mcp.yml: `./mcp.yml` in the working directory, else `~/.arc/mcp.yml`. Servers run in the working
 * directory, and their stderr is captured rather than written over the TUI.
 */
export class McpManager {
	private readonly servers = new Map<string, RunningServer>();
	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** The mcp.yml in effect, and its servers. Throws when the file does not parse. */
	private loadConfig(): { path: string; servers: Record<string, McpServerConfig> } | undefined {
		const local = join(this.cwd, "mcp.yml");
		const path = existsSync(local) ? local : join(getAppDir(), "mcp.yml");
		if (!existsSync(path)) return undefined;
		let config: McpConfig | undefined;
		try {
			config = parseYaml(readFileSync(path, "utf-8")) as McpConfig | undefined;
		} catch (error) {
			throw new Error(`${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
		}
		return config?.servers ? { path, servers: config.servers } : undefined;
	}

	/** Every server defined in mcp.yml, or none when it is missing or broken. */
	getServerNames(): string[] {
		try {
			return Object.keys(this.loadConfig()?.servers ?? {});
		} catch {
			return [];
		}
	}

	getRunningNames(): string[] {
		return [...this.servers.keys()];
	}

	/** Start one server. Throws with the reason, including the end of its stderr, when it does not start. */
	async startServer(name: string): Promise<void> {
		if (this.servers.has(name)) return;
		const config = this.loadConfig()?.servers[name];
		if (!config) throw new Error(`mcp.yml defines no server "${name}".`);

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: { ...process.env, ...config.env } as Record<string, string>,
			cwd: this.cwd,
			stderr: "pipe",
		});
		const stderr: string[] = [];
		(transport.stderr as Readable | null)?.on("data", (data: Buffer) => {
			stderr.push(
				...data
					.toString("utf8")
					.split("\n")
					.filter((line) => line.trim()),
			);
			stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
		});
		const client = new Client({ name: "arc", version: "1.0.0" }, { capabilities: {} });
		try {
			await client.connect(transport);
		} catch (error) {
			await transport.close().catch(() => {});
			const reason = error instanceof Error ? error.message : String(error);
			const tail = stderr.slice(-5).join("\n");
			throw new Error(`MCP server ${name} did not start: ${reason}${tail ? `\n${tail}` : ""}`);
		}
		this.servers.set(name, { client, transport, config, stderr });
	}

	async stopServer(name: string): Promise<void> {
		const server = this.servers.get(name);
		if (!server) return;
		this.servers.delete(name);
		await server.client.close().catch(() => {});
		await server.transport.close().catch(() => {});
	}

	async stopAll(): Promise<void> {
		await Promise.all(this.getRunningNames().map((name) => this.stopServer(name)));
	}

	/**
	 * Kill every server's process now, without the MCP shutdown handshake. For quitting: `stopAll` is async, and the
	 * process may exit before it finishes, leaving a server running.
	 */
	killAllSync(): void {
		for (const { transport } of this.servers.values()) {
			if (transport.pid === null) continue;
			try {
				process.kill(transport.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
		this.servers.clear();
	}

	/**
	 * The tools of every running server. A tool whose name is in `reserved` (the built-in tools) or already taken by
	 * another server is renamed `<server>_<name>`, so no call goes to the wrong tool. A server that fails to list its
	 * tools is skipped and named in `failed`.
	 */
	async tools(reserved: ReadonlySet<string>): Promise<{ tools: AgentTool[]; renamed: string[]; failed: string[] }> {
		const tools: AgentTool[] = [];
		const renamed: string[] = [];
		const failed: string[] = [];
		const taken = new Set(reserved);
		for (const [name, server] of this.servers) {
			let listed: Awaited<ReturnType<Client["listTools"]>>["tools"];
			try {
				listed = (await server.client.listTools()).tools;
			} catch {
				failed.push(name);
				continue;
			}
			for (const mcpTool of listed) {
				const readOnly = server.config.readOnly === true || mcpTool.annotations?.readOnlyHint === true;
				let toolName = mcpTool.name;
				if (taken.has(toolName)) {
					toolName = `${name}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
					renamed.push(`${mcpTool.name} → ${toolName}`);
				}
				taken.add(toolName);
				tools.push(createMcpAgentTool(name, mcpTool, server.client, { name: toolName, readOnly }));
			}
		}
		return { tools, renamed, failed };
	}
}
