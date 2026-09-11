#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "./agent/agent.ts";
import type { AgentEvent, StreamFn } from "./agent/types.ts";
import { readLastUsed, writeLastUsed } from "./config/last-used.ts";
import { findModel, findModelsFile, type LiteModel, loadModelsConfig } from "./config/models.ts";
import { getAppDir } from "./config/paths.ts";
import { defaultSamplingMode, isSamplingMode, type SamplingMode } from "./config/sampling.ts";
import { STARTER_MODELS_YML } from "./config/starter.ts";
import { describeTrim } from "./context.ts";
import { buildRequestBody, streamChat, toChatTools } from "./llm/llama-client.ts";
import { LlamaServerManager, stopServerOnExit } from "./llm/server.ts";
import type { AssistantMessage } from "./llm/types.ts";
import { buildSystemPrompt, estimateFixedPromptTokens } from "./prompt.ts";
import {
	type LoadedSession,
	listSessions,
	loadSession,
	recordSession,
	resolveSessionPath,
	SessionFile,
} from "./session.ts";
import { createToolsForModel, killRunningCommands } from "./tools/index.ts";
import { runInteractive } from "./tui/app.ts";

const HELP = `Usage:
  pi-lite [options]                Start an interactive session
  pi-lite [options] -p <prompt>    Run one prompt with tools and print the reply

Options:
  -p, --print <prompt>        Run one prompt, stream the reply to stdout, and exit
  -m, --model <name>          Model from models.yml; any unique part of a name works
                              (default: the session's model, else the last one used, else the first)
      --mode <mode>           thinking or instruct (default: as last used, else thinking for reasoning models)
  -c, --continue              Continue the most recent session in this directory
  -r, --resume                Pick a saved session to resume (interactive)
      --session <id|path>     Resume a specific session (id prefix or file path)
      --no-session            Do not save this session
      --models <path>         models.yml location (default: ./models.yml, then ~/.pi-lite/models.yml)
      --init                  Write a starter ~/.pi-lite/models.yml and exit
      --list-models           List models from models.yml, * marking the default, and exit
      --show-prompt           Print the system prompt and tool definitions with a token estimate, and exit
      --verbose               Print every request body to stderr (print mode)
  -h, --help                  Show this help

Interactive commands: /model [name]  /mode [thinking|instruct]  /new  /resume [id]  /quit
`;

function dim(text: string): string {
	return process.stderr.isTTY ? `\x1b[2m${text}\x1b[22m` : text;
}

function fail(message: string): number {
	process.stderr.write(`error: ${message}\n`);
	return 1;
}

/** Write a starter models.yml into the app directory, never over an existing one. */
function initModels(appDir: string): number {
	const path = join(appDir, "models.yml");
	try {
		mkdirSync(appDir, { recursive: true });
		writeFileSync(path, STARTER_MODELS_YML, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return fail(`${path} already exists. Edit it, or move it away and run --init again.`);
		}
		throw error;
	}
	process.stdout.write(`Wrote ${path}\nSet the GGUF path and llama-server arguments in it, then run pi-lite.\n`);
	return 0;
}

function showPrompt(model: LiteModel): void {
	const cwd = process.cwd();
	const systemPrompt = buildSystemPrompt({ cwd });
	const tools = createToolsForModel(model, cwd);
	const estimate = estimateFixedPromptTokens(systemPrompt, tools);
	process.stdout.write(
		`${systemPrompt}\n\n${JSON.stringify(toChatTools(tools), null, 2)}\n\n` +
			`Estimated tokens: ${estimate} (system prompt and tools, before chat-template overhead)\n`,
	);
}

/** Print mode output: reply text on stdout; reasoning, tool activity, and notices dimmed on stderr. */
function printEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_update": {
			const update = event.event;
			if (update.type === "thinking_delta") process.stderr.write(dim(update.delta));
			else if (update.type === "thinking_end") process.stderr.write("\n");
			else if (update.type === "text_delta") process.stdout.write(update.delta);
			else if (update.type === "text_end") process.stdout.write("\n");
			break;
		}
		case "tool_execution_start": {
			const { name, arguments: args } = event.toolCall;
			const subject =
				typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "";
			process.stderr.write(`${dim(`→ ${name} ${subject}`)}\n`);
			break;
		}
		case "tool_execution_end": {
			const text = event.result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
			const preview = text.split("\n").slice(0, 3).join("\n");
			process.stderr.write(`${dim(`${event.isError ? "✗" : "✓"} ${preview}`)}\n`);
			break;
		}
		case "message_end":
			if (event.message.role === "assistant" && event.message.errorMessage) {
				process.stderr.write(`error: ${event.message.errorMessage}\n`);
			}
			break;
		case "context_trimmed":
			process.stderr.write(`${dim(`[${describeTrim(event)}]`)}\n`);
			break;
	}
}

interface PrintOptions {
	model: LiteModel;
	mode: SamplingMode;
	prompt: string;
	cwd: string;
	manager: LlamaServerManager;
	session: LoadedSession | undefined;
	saveSessions: boolean;
	verbose: boolean;
}

async function runPrint(options: PrintOptions): Promise<number> {
	const { model, mode, cwd, session } = options;
	const status = (message: string) => process.stderr.write(`${dim(message)}\n`);
	await options.manager.ensure(model, { onStatus: status });

	const logRequests: StreamFn = (requestModel, context, requestOptions) => {
		const body = buildRequestBody(requestModel, context, requestOptions.preset);
		process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
		return streamChat(requestModel, context, requestOptions);
	};
	const agent = new Agent({
		model,
		mode,
		systemPrompt: buildSystemPrompt({ cwd }),
		tools: createToolsForModel(model, cwd),
		messages: session?.messages,
		streamFn: options.verbose ? logRequests : undefined,
	});
	if (options.saveSessions) {
		const settings = { model: model.name, mode };
		const file = session ? SessionFile.resume(session, settings) : SessionFile.create(getAppDir(), cwd, settings);
		recordSession(agent, () => file);
	}
	agent.subscribe(printEvent);

	const earlierMessages = agent.messages.length;
	await agent.prompt(options.prompt);

	const replies = agent.messages
		.slice(earlierMessages)
		.filter((message): message is AssistantMessage => message.role === "assistant");
	const last = replies.at(-1);
	if (!last || last.stopReason === "error" || last.stopReason === "aborted") return 1;
	const output = replies.reduce((sum, reply) => sum + reply.usage.completionTokens, 0);
	const speed = last.timings ? ` · ${last.timings.predictedPerSecond.toFixed(1)} tok/s` : "";
	status(
		`[${model.name} · ${mode}] ${replies.length} requests · last prompt ${last.usage.promptTokens} (cached ${last.usage.cachedTokens}) · output ${output}${speed} · ${last.stopReason}`,
	);
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			print: { type: "string", short: "p" },
			model: { type: "string", short: "m" },
			mode: { type: "string" },
			continue: { type: "boolean", short: "c" },
			resume: { type: "boolean", short: "r" },
			session: { type: "string" },
			"no-session": { type: "boolean" },
			models: { type: "string" },
			init: { type: "boolean" },
			"list-models": { type: "boolean" },
			"show-prompt": { type: "boolean" },
			verbose: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(HELP);
		return 0;
	}

	const appDir = getAppDir();
	if (values.init) return initModels(appDir);

	const config = loadModelsConfig(findModelsFile({ explicit: values.models }));
	for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);
	const lastUsed = readLastUsed(appDir);
	const lastModel = lastUsed ? config.models.find((candidate) => candidate.name === lastUsed.model) : undefined;
	if (values["list-models"]) {
		const opens = lastModel ?? config.models[0];
		for (const model of config.models) {
			process.stdout.write(
				`${model === opens ? "*" : " "} ${model.name}\t${defaultSamplingMode(model)}\tctx ${model.contextWindow}\t${model.modelPath}\n`,
			);
		}
		return 0;
	}

	const cwd = process.cwd();
	let session: LoadedSession | undefined;
	if (values.session !== undefined) {
		const path = resolveSessionPath(appDir, cwd, values.session);
		if (!path) return fail(`no unique saved session matches "${values.session}" in this directory.`);
		session = loadSession(path);
	} else if (values.continue) {
		const latest = listSessions(appDir, cwd)[0];
		if (latest) session = loadSession(latest.path);
		else process.stderr.write("No saved session in this directory; starting a new one.\n");
	}

	const savedModel = session?.settings ? findModel(config.models, session.settings.model) : undefined;
	const model =
		values.model === undefined
			? (savedModel ?? lastModel ?? config.models[0])
			: findModel(config.models, values.model);
	if (!model) {
		const names = config.models.map((candidate) => candidate.name).join(", ");
		return fail(`no model matches "${values.model}". Available: ${names}`);
	}
	if (values["show-prompt"]) {
		showPrompt(model);
		return 0;
	}
	if (values.mode !== undefined && !isSamplingMode(values.mode)) return fail("--mode must be thinking or instruct.");
	let mode = defaultSamplingMode(model);
	if (values.mode !== undefined && isSamplingMode(values.mode)) mode = values.mode;
	else if (session?.settings && savedModel === model) mode = session.settings.mode;
	else if (lastUsed && lastModel === model) mode = lastUsed.mode;

	const prompt = values.print ?? positionals.join(" ");
	if (prompt && values.resume) return fail("--resume opens a picker; with -p, use --session <id> or --continue.");
	if (!prompt && !(process.stdin.isTTY && process.stdout.isTTY)) {
		return fail("interactive mode needs a terminal. Pass a prompt with -p.");
	}

	const manager = new LlamaServerManager({ logFile: join(appDir, "logs", "llama-server.log") });
	stopServerOnExit(manager);
	process.once("exit", killRunningCommands);
	const saveSessions = values["no-session"] !== true;
	try {
		if (prompt) {
			return await runPrint({
				model,
				mode,
				prompt,
				cwd,
				manager,
				session,
				saveSessions,
				verbose: values.verbose === true,
			});
		}
		// Print mode is often scripted, so only interactive sessions change what a plain pi-lite opens.
		writeLastUsed(appDir, { model: model.name, mode });
		await runInteractive({
			config,
			model,
			mode,
			cwd,
			manager,
			session,
			saveSessions,
			pickSession: values.resume === true,
		});
		return 0;
	} finally {
		await manager.stop();
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
