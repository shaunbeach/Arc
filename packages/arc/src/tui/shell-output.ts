// `!cmd` output, attached to the user's next message. The model sees the whole block; the transcript shows one line
// per command, since the output was already on screen when the command ran.

/** A fence longer than any run of backticks in `text`, so output holding ``` cannot close the block early. */
function fenceFor(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** The block the model reads for one command. `status` is the exit code, or a word such as "aborted". */
export function formatShellOutput(command: string, status: number | string, output: string): string {
	const fence = fenceFor(output);
	return `[Output of \`${command}\` (exit ${status})]\n${fence}\n${output}\n${fence}`;
}

const SHELL_BLOCK = /\[Output of `(.*?)` \(exit ([^)]*)\)\]\n(`{3,})\n[\s\S]*?\n\3(?:\n\n|$)/g;

/** A user message as the transcript shows it: each attached output collapsed to `[ran cmd · exit N]`. */
export function displayUserText(text: string): string {
	return text.replace(
		SHELL_BLOCK,
		(_block, command: string, status: string) => `[ran \`${command}\` · exit ${status}]\n`,
	);
}

/** Put the attached outputs ahead of the message the user typed. */
export function withShellOutputs(outputs: readonly string[], input: string): string {
	return outputs.length === 0 ? input : `${outputs.join("\n\n")}\n\n${input}`;
}
