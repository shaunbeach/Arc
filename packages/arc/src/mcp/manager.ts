import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
}

export interface McpConfig {
	servers?: Record<string, McpServerConfig>;
}

export class McpManager {
	private clients = new Map<string, { client: Client; transport: StdioClientTransport }>();
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	public async startAll(): Promise<AgentTool[]> {
		const configPathLocal = join(this.cwd, "mcp.yml");
		const configPathGlobal = join(getAppDir(), "mcp.yml");

		let targetPath: string | undefined;
		if (existsSync(configPathLocal)) targetPath = configPathLocal;
		else if (existsSync(configPathGlobal)) targetPath = configPathGlobal;

		if (!targetPath) return [];

		let config: McpConfig;
		try {
			const content = readFileSync(targetPath, "utf-8");
			config = parseYaml(content) as McpConfig;
		} catch (error) {
			console.error(`Failed to parse MCP config at ${targetPath}:`, error);
			return [];
		}

		if (!config || !config.servers) return [];

		const agentTools: AgentTool[] = [];

		for (const [serverName, serverConfig] of Object.entries(config.servers)) {
			if (this.clients.has(serverName)) {
				// Already started; retrieve existing tools
				try {
					const { client } = this.clients.get(serverName)!;
					const listResult = await client.listTools();
					for (const tool of listResult.tools) {
						agentTools.push(createMcpAgentTool(serverName, tool, client));
					}
				} catch {}
				continue;
			}

			try {
				const transport = new StdioClientTransport({
					command: serverConfig.command,
					args: serverConfig.args,
					env: { ...process.env, ...serverConfig.env } as Record<string, string>,
				});

				const client = new Client({ name: "arc", version: "1.0.0" }, { capabilities: {} });

				await client.connect(transport);
				this.clients.set(serverName, { client, transport });

				const listResult = await client.listTools();
				for (const tool of listResult.tools) {
					agentTools.push(createMcpAgentTool(serverName, tool, client));
				}
			} catch (error) {
				console.error(`Failed to start MCP server ${serverName}:`, error);
			}
		}

		return agentTools;
	}

	public async stopAll(): Promise<void> {
		for (const [_serverName, { client, transport }] of this.clients.entries()) {
			try {
				await client.close();
				await transport.close();
			} catch (_error) {
				// Ignore close errors
			}
		}
		this.clients.clear();
	}
}
