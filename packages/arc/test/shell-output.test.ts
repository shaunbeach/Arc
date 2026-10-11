import { describe, expect, it } from "vitest";
import { displayUserText, formatShellOutput, withShellOutputs } from "../src/tui/shell-output.ts";

describe("!cmd output", () => {
	it("goes ahead of the next message and collapses to one line in the transcript", () => {
		const message = withShellOutputs(
			[formatShellOutput("git status", 0, "On branch main"), formatShellOutput("npm test", 1, "1 failed")],
			"Why does the test fail?",
		);
		expect(message).toContain("[Output of `git status` (exit 0)]\n```\nOn branch main\n```");
		expect(message.endsWith("Why does the test fail?")).toBe(true);
		expect(displayUserText(message)).toBe(
			"[ran `git status` · exit 0]\n[ran `npm test` · exit 1]\nWhy does the test fail?",
		);
	});

	it("fences output that holds backticks so the block stays whole", () => {
		const output = "```js\nconst a = 1;\n```";
		const block = formatShellOutput("cat README.md", 0, output);
		expect(block).toContain("````\n```js");
		expect(displayUserText(withShellOutputs([block], "Summarize it"))).toBe(
			"[ran `cat README.md` · exit 0]\nSummarize it",
		);
	});

	it("leaves messages without attached output alone", () => {
		expect(withShellOutputs([], "hello")).toBe("hello");
		expect(displayUserText("Use `[Output of` literally")).toBe("Use `[Output of` literally");
	});
});
