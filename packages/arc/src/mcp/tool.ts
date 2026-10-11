import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "typebox";
import type { AgentTool, ToolResult } from "../agent/types.ts";

type McpContent = { type: string; text?: string; data?: string; mimeType?: string };

function textOf(content: readonly McpContent[]): string {
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/**
 * An MCP server's tool as an Arc tool. `name` is what the model calls it, which differs from the server's name for it
 * when that collides; calls always go to the server under its own name.
 */
export function createMcpAgentTool(
	serverName: string,
	mcpTool: McpTool,
	client: Client,
	options: { name: string; readOnly: boolean },
): AgentTool {
	return {
		name: options.name,
		label: `mcp: ${serverName}`,
		description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverName}`,
		readOnly: options.readOnly,
		// The server's JSON Schema, passed through as is.
		parameters: Type.Unsafe<Record<string, unknown>>(mcpTool.inputSchema as TSchema),
		async execute(_toolCallId, params, signal) {
			const result = await client.callTool(
				{ name: mcpTool.name, arguments: params as Record<string, unknown> },
				undefined,
				{ signal },
			);
			const content = (result.content ?? []) as McpContent[];
			if (result.isError) throw new Error(`MCP tool ${mcpTool.name} failed: ${textOf(content)}`);
			const parts: ToolResult["content"] = content.map((part) =>
				part.type === "text"
					? { type: "text", text: part.text ?? "" }
					: part.type === "image" && part.data && part.mimeType
						? { type: "image", data: part.data, mimeType: part.mimeType }
						: { type: "text", text: JSON.stringify(part) },
			);
			return { content: parts };
		},
	};
}
