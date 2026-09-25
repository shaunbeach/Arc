import type { SlashCommand } from "@earendil-works/pi-tui";
import type { LiteModel } from "../config/models.ts";
import { isSamplingMode, SAMPLING_MODES, type SamplingMode } from "../config/sampling.ts";
import { PONYTAIL_LEVELS } from "../ponytail.ts";

export type CommandName =
	| "agent"
	| "plan"
	| "chat"
	| "web"
	| "rag"
	| "ponytail"
	| "model"
	| "mode"
	| "serve"
	| "disconnect"
	| "compact"
	| "clear"
	| "resume"
	| "name"
	| "supervise"
	| "audit"
	| "usage"
	| "quit";

export const COMMANDS: readonly { name: CommandName; description: string; argumentHint?: string }[] = [
	{ name: "agent", description: "Switch to agent mode (autonomous coding with all tools)" },
	{ name: "plan", description: "Switch to plan mode (design & planning, read-only tools)" },
	{ name: "chat", description: "Switch to chat mode (conversation & web search, no file tools)" },
	{ name: "web", description: "Turn the model's web tools on or off", argumentHint: "[on|off]" },
	{ name: "rag", description: "Let the model search the offline knowledge base", argumentHint: "[on|off]" },
	{
		name: "ponytail",
		description: "Steer the model to the smallest code that works",
		argumentHint: "[off|lite|full|ultra]",
	},
	{ name: "model", description: "Switch model (restarts llama-server)", argumentHint: "[name]" },
	{ name: "mode", description: "Switch between thinking and instruct sampling", argumentHint: "[thinking|instruct]" },
	{ name: "serve", description: "Serve a model as a remote host with live server logs", argumentHint: "[name]" },
	{ name: "disconnect", description: "Stop llama-server and unload model without exiting app" },
	{
		name: "compact",
		description: "Run context compaction on past tool calls and results",
		argumentHint: "[threshold]",
	},
	{ name: "clear", description: "Clear the conversation and start a new session" },
	{
		name: "resume",
		description: "Resume a saved session: its number in the banner, its /name, or its id",
		argumentHint: "[number|name|id]",
	},
	{ name: "name", description: "Name this session, for the banner and /resume", argumentHint: "<text>" },
	{
		name: "supervise",
		description: "Work through a phased plan: actor builds, checks and a critic judge each phase",
		argumentHint: "[plan.md|resume|stop|report|reload]",
	},
	{ name: "audit", description: "Check and judge the current supervised phase now", argumentHint: "[critic]" },
	{ name: "usage", description: "Show the tokens this session used, in and out" },
	{ name: "quit", description: "Exit" },
];

const ALIASES: Record<string, CommandName> = {
	exit: "quit",
	models: "model",
	host: "serve",
	stop: "disconnect",
	new: "clear",
	cls: "clear",
	reset: "clear",
	compress: "compact",
	prune: "compact",
};

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
		serve: complete(models.map((model) => model.name)),
		mode: complete(SAMPLING_MODES),
		web: complete(["on", "off"]),
		rag: complete(["on", "off"]),
		ponytail: complete(PONYTAIL_LEVELS),
		supervise: complete(["resume", "stop", "report", "reload"]),
		audit: complete(models.filter((model) => !model.discover).map((model) => model.name)),
	};
	return COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		argumentHint: command.argumentHint,
		getArgumentCompletions: argumentCompletions[command.name],
	}));
}
