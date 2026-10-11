// A small MCP server for the McpManager tests. MCP_FIXTURE_FAIL=1 makes it fail to start.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

process.stderr.write("fixture starting\n");
if (process.env.MCP_FIXTURE_FAIL === "1") {
	process.stderr.write("fixture: missing API key\n");
	process.exit(1);
}

const server = new McpServer({ name: "fixture", version: "1.0.0" });
const text = (value) => ({ content: [{ type: "text", text: value }] });
// Clashes with Arc's built-in read.
server.registerTool("read", { description: "Read a note", annotations: { readOnlyHint: true } }, async () => text("note"));
server.registerTool("where", { description: "Working directory", annotations: { readOnlyHint: true } }, async () =>
	text(process.cwd()),
);
server.registerTool("change", { description: "Change something" }, async () => text("changed"));
await server.connect(new StdioServerTransport());
