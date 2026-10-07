import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";

export function createMcpAgentTool(serverName: string, mcpTool: McpTool, client: Client): AgentTool {
	return {
		name: mcpTool.name,
		label: `mcp: ${serverName}`,
		description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverName}`,
		parameters: Type.Unsafe<any>(mcpTool.inputSchema),
		async execute(_toolCallId, params) {
			try {
				const result = await client.callTool({
					name: mcpTool.name,
					arguments: params as any,
				});

				if (result.isError) {
					const contentArray = result.content as any[];
					throw new Error(
						`MCP Tool Error: ${contentArray.map((c) => (c.type === "text" ? c.text : "")).join("\n")}`,
					);
				}

				const contentArray = result.content as any[];
				return {
					content: contentArray.map((c) => {
						if (c.type === "text") return { type: "text", text: c.text };
						if (c.type === "image") {
							return {
								type: "image",
								mimeType: c.mimeType,
								data: c.data,
							};
						}
						return { type: "text", text: JSON.stringify(c) };
					}),
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(`MCP Tool failed: ${msg}`);
			}
		},
	};
}
