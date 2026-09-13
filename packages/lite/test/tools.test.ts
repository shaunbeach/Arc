import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTool, ToolResult } from "../src/agent/types.ts";
import { validateToolArguments } from "../src/llm/validation.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import type { CodingToolOptions, ToolLimits } from "../src/tools/options.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createWriteTool } from "../src/tools/write.ts";

const DEFAULT_LIMITS: ToolLimits = { maxLines: 2000, maxBytes: 50 * 1024 };
const BOM = String.fromCharCode(0xfeff);

function setup(limits = DEFAULT_LIMITS, acceptsImages = false): CodingToolOptions {
	return { cwd: realpathSync(mkdtempSync(join(tmpdir(), "pi-lite-tools-"))), limits, acceptsImages };
}

/** Run a tool the way the agent loop does: prepare arguments, validate, execute. */
async function run(tool: AgentTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
	const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
	const params = validateToolArguments(tool, {
		type: "toolCall",
		id: "t1",
		name: tool.name,
		arguments: prepared as Record<string, unknown>,
	});
	return tool.execute("t1", params, signal);
}

const text = (result: ToolResult) =>
	result.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n");

const numberedLines = (count: number) => `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("read", () => {
	it("returns a whole file", async () => {
		const options = setup();
		writeFileSync(join(options.cwd, "a.txt"), "one\ntwo\n");
		expect(text(await run(createReadTool(options), { path: "a.txt" }))).toBe("one\ntwo");
	});

	it("pages with offset and limit", async () => {
		const options = setup();
		writeFileSync(join(options.cwd, "a.txt"), numberedLines(10));
		expect(text(await run(createReadTool(options), { path: "a.txt", offset: 3, limit: 2 }))).toBe(
			"line 3\nline 4\n\n[6 more lines. Use offset=5 to continue.]",
		);
	});

	it("cuts output at the line limit with a continuation hint", async () => {
		const options = setup({ maxLines: 5, maxBytes: 50 * 1024 });
		writeFileSync(join(options.cwd, "a.txt"), numberedLines(12));
		expect(text(await run(createReadTool(options), { path: "a.txt" }))).toBe(
			"line 1\nline 2\nline 3\nline 4\nline 5\n\n[Showing lines 1-5 of 12. Use offset=6 to continue.]",
		);
	});

	it("rejects an offset past the end", async () => {
		const options = setup();
		writeFileSync(join(options.cwd, "a.txt"), numberedLines(10));
		await expect(run(createReadTool(options), { path: "a.txt", offset: 20 })).rejects.toThrow(
			"offset 20 is past the end of a.txt (10 lines).",
		);
	});

	it("lists a directory", async () => {
		const options = setup();
		mkdirSync(join(options.cwd, "sub"));
		writeFileSync(join(options.cwd, "b.txt"), "");
		writeFileSync(join(options.cwd, "a.txt"), "");
		expect(text(await run(createReadTool(options), { path: "." }))).toBe("a.txt\nb.txt\nsub/");
	});

	it("reports missing files, binary files, and images the model cannot view", async () => {
		const options = setup();
		writeFileSync(join(options.cwd, "data.bin"), Buffer.from([0, 1, 2]));
		writeFileSync(join(options.cwd, "shot.png"), "fake");
		const read = createReadTool(options);
		await expect(run(read, { path: "nope.txt" })).rejects.toThrow("Not found: nope.txt");
		expect(text(await run(read, { path: "data.bin" }))).toBe("[Binary file, 3B. Not shown.]");
		expect(text(await run(read, { path: "shot.png" }))).toBe(
			"[Image file, 4B. The current model cannot view images.]",
		);
	});

	it("attaches images for models that accept them", async () => {
		const options = setup(DEFAULT_LIMITS, true);
		writeFileSync(join(options.cwd, "shot.png"), "fake");
		const result = await run(createReadTool(options), { path: "@shot.png" });
		expect(result.content[1]).toEqual({ type: "image", data: "ZmFrZQ==", mimeType: "image/png" });
	});

	it("tells image models they can see, and says nothing about images to the rest", () => {
		// Without this, models with vision reach for OCR through bash or deny they can see at all.
		expect(createReadTool(setup(DEFAULT_LIMITS, true)).description).toContain("attaches it for you to look at");
		expect(createReadTool(setup(DEFAULT_LIMITS, false)).description).not.toContain("image");
	});
});

describe("write", () => {
	it("creates parent directories and reports the line count", async () => {
		const options = setup();
		const result = await run(createWriteTool(options), { path: "nested/dir/x.txt", content: "a\nb\n" });
		expect(text(result)).toBe("Wrote 2 lines to nested/dir/x.txt. Do not repeat its contents in your reply.");
		expect(readFileSync(join(options.cwd, "nested/dir/x.txt"), "utf8")).toBe("a\nb\n");
	});

	it("refuses to overwrite a file with a placeholder left by context trimming", async () => {
		const options = setup();
		writeFileSync(join(options.cwd, "calc.py"), "keep me\n");
		const write = createWriteTool(options);
		await expect(run(write, { path: "calc.py", content: "[elided from context: 319 lines]" })).rejects.toThrow(
			"content is a placeholder for text elided from your context",
		);
		expect(readFileSync(join(options.cwd, "calc.py"), "utf8")).toBe("keep me\n");
	});
});

describe("edit", () => {
	function editFile(content: string, args: Record<string, unknown>) {
		const options = setup();
		const path = join(options.cwd, "f.txt");
		writeFileSync(path, content);
		return {
			result: run(createEditTool(options), { path: "f.txt", ...args }),
			read: () => readFileSync(path, "utf8"),
		};
	}

	it("replaces a unique block and reports the first changed line", async () => {
		const { result, read } = editFile("a\nb\nc\n", { oldText: "b", newText: "B" });
		const done = await result;
		expect(text(done)).toBe("Edited f.txt at line 2. Do not repeat its contents in your reply.");
		expect(read()).toBe("a\nB\nc\n");
		expect(done.details).toEqual({ firstChangedLine: 2, diff: " 1 a\n-2 b\n+2 B\n 3 c" });
	});

	it("keeps CRLF line endings and a byte order mark", async () => {
		const { result, read } = editFile(`${BOM}a\r\nb\r\n`, { oldText: "a\nb", newText: "x\ny" });
		await result;
		expect(read()).toBe(`${BOM}x\r\ny\r\n`);
	});

	it("matches despite typographic quotes and trailing spaces, leaving other lines untouched", async () => {
		const { result, read } = editFile("keep “this”  \nsay “hi”  \nend\n", {
			oldText: 'say "hi"',
			newText: 'say "bye"',
		});
		await result;
		expect(read()).toBe('keep “this”  \nsay "bye"\nend\n');
	});

	it.each([
		["the text is missing", "a\n", { oldText: "zzz", newText: "y" }, "Could not find oldText in f.txt."],
		["the text occurs twice", "x\nx\n", { oldText: "x", newText: "y" }, "oldText occurs 2 times in f.txt."],
		["nothing would change", "a\n", { oldText: "a", newText: "a" }, "newText is identical to oldText"],
		[
			"newText is a trimming placeholder",
			"a\n",
			{ oldText: "a", newText: "[elided from context: 3 lines]" },
			"oldText or newText is a placeholder",
		],
	])("fails when %s", async (_case, content, args, message) => {
		await expect(editFile(content, args).result).rejects.toThrow(message);
	});

	it("accepts snake_case names and a one-entry edits array", async () => {
		const snake = editFile("a\n", { old_string: "a", new_string: "b" });
		await snake.result;
		expect(snake.read()).toBe("b\n");
		const array = editFile("a\n", { edits: [{ oldText: "a", newText: "c" }] });
		await array.result;
		expect(array.read()).toBe("c\n");
	});

	it("rejects several replacements in one call", async () => {
		const { result } = editFile("a\nb\n", {
			edits: [
				{ oldText: "a", newText: "x" },
				{ oldText: "b", newText: "y" },
			],
		});
		await expect(result).rejects.toThrow("edit takes one replacement per call");
	});
});

describe("bash", () => {
	it("returns stdout and stderr from the working directory", async () => {
		const options = setup();
		const output = text(await run(createBashTool(options), { command: "pwd; echo err 1>&2" }));
		expect(output).toContain(options.cwd);
		expect(output).toContain("err");
	});

	it("reports a non-zero exit code together with the output", async () => {
		await expect(run(createBashTool(setup()), { command: "echo boom; exit 3" })).rejects.toThrow(
			"boom\n\nCommand exited with code 3",
		);
	});

	it("kills a command that runs past its timeout", async () => {
		const started = Date.now();
		await expect(run(createBashTool(setup()), { command: "sleep 5", timeout: 0.2 })).rejects.toThrow(
			"Command timed out after 0.2 seconds",
		);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("kills the command when aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		await expect(run(createBashTool(setup()), { command: "sleep 5; echo late" }, controller.signal)).rejects.toThrow(
			"Command aborted",
		);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("keeps the tail of long output and saves all of it to a file", async () => {
		const bash = createBashTool(setup({ maxLines: 5, maxBytes: 50 * 1024 }));
		const output = text(await run(bash, { command: "seq 1 20" }));
		const match = output.match(/^16\n17\n18\n19\n20\n\n\[Showing the last 5 of 20 lines\. Full output: (.+)\]$/);
		expect(match).not.toBeNull();
		const expected = `${Array.from({ length: 20 }, (_, i) => i + 1).join("\n")}\n`;
		expect(readFileSync(match?.[1] ?? "", "utf8")).toBe(expected);
	});
});
