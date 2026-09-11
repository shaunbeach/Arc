import type { SlashCommand } from "@earendil-works/pi-tui";
import type { LiteModel } from "../config/models.ts";
import { isSamplingMode, SAMPLING_MODES, type SamplingMode } from "../config/sampling.ts";

export type CommandName = "model" | "mode" | "new" | "resume" | "quit";

export const COMMANDS: readonly { name: CommandName; description: string; argumentHint?: string }[] = [
	{ name: "model", description: "Switch model (restarts llama-server)", argumentHint: "[name]" },
	{ name: "mode", description: "Switch between thinking and instruct sampling", argumentHint: "[thinking|instruct]" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "Resume a saved session from this directory", argumentHint: "[id]" },
	{ name: "quit", description: "Exit" },
];

const ALIASES: Record<string, CommandName> = { exit: "quit" };

export interface ParsedCommand {
	name: CommandName;
	args: string;
}

/**
 * A known slash command, or undefined. Anything else, including text that merely starts with a slash such as a
 * path, is sent to the model as a message.
 */
export function parseCommand(input: string): ParsedCommand | undefined {
	const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
	if (!match) return undefined;
	const name = ALIASES[match[1]] ?? COMMANDS.find((command) => command.name === match[1])?.name;
	return name ? { name, args: (match[2] ?? "").trim() } : undefined;
}

/** `/mode` with no argument toggles; otherwise the argument must name a mode. */
export function resolveMode(current: SamplingMode, arg: string): SamplingMode | undefined {
	if (!arg) return current === "thinking" ? "instruct" : "thinking";
	const mode = arg.toLowerCase();
	return isSamplingMode(mode) ? mode : undefined;
}

/** Commands for the editor's autocomplete, with completions for model names and modes. */
export function slashCommands(models: readonly LiteModel[]): SlashCommand[] {
	// Prefer values that start with what was typed; fall back to substrings, so "27" still finds "Qwen3.8-27B".
	const complete = (values: readonly string[]) => (prefix: string) => {
		const lower = prefix.toLowerCase();
		const starting = values.filter((value) => value.toLowerCase().startsWith(lower));
		const matches = starting.length > 0 ? starting : values.filter((value) => value.toLowerCase().includes(lower));
		return matches.map((value) => ({ value, label: value }));
	};
	const argumentCompletions: Partial<Record<CommandName, (prefix: string) => { value: string; label: string }[]>> = {
		model: complete(models.map((model) => model.name)),
		mode: complete(SAMPLING_MODES),
	};
	return COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		argumentHint: command.argumentHint,
		getArgumentCompletions: argumentCompletions[command.name],
	}));
}
