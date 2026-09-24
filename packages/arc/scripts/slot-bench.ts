/**
 * Measures what the supervisor's slot save and restore buy on a real model. It runs the rebound the supervisor
 * runs -- request, save slot 0, stop the server, start it, restore, follow-up request -- then the same follow-up on a
 * fresh server without a restore, and prints both.
 *
 *   node packages/arc/scripts/slot-bench.ts --model <name> [--tokens 15000] [--models <path>]
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findModel, findModelsFile, type LiteModel, loadModelsConfig } from "../src/config/models.ts";
import { getAppDir } from "../src/config/paths.ts";
import { LlamaServerManager, serverOrigin, stopServerOnExit, withSlotSavePath } from "../src/llm/server.ts";

interface Reply {
	content: string;
	promptN: number;
	cacheN: number;
	promptMs: number;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const { values } = parseArgs({
	options: { model: { type: "string" }, tokens: { type: "string", default: "15000" }, models: { type: "string" } },
});
if (!values.model) {
	process.stderr.write("usage: node packages/arc/scripts/slot-bench.ts --model <name> [--tokens N]\n");
	process.exit(1);
}
const config = loadModelsConfig(findModelsFile({ explicit: values.models }));
const found = findModel(config.models, values.model);
if (!found || found.discover) {
	process.stderr.write(`No local model matches "${values.model}".\n`);
	process.exit(1);
}
const appDir = getAppDir();
const slotDir = join(appDir, "slots");
const model = withSlotSavePath(found, slotDir);
const filename = "slot-bench.bin";
const manager = new LlamaServerManager({ logFile: join(appDir, "logs", "llama-server.log") });
stopServerOnExit(manager);

/** Arc's own sources, repeated as needed: real code, about 3 characters per token. */
function filler(tokens: number): string {
	const dir = join(import.meta.dirname, "..", "src", "tui");
	const text = readdirSync(dir)
		.map((name) => `// ${name}\n${readFileSync(join(dir, name), "utf8")}`)
		.join("\n\n");
	return text.repeat(Math.ceil((tokens * 3) / text.length)).slice(0, tokens * 3);
}

/**
 * Streamed, because Node's fetch gives up when no response headers arrive within 5 minutes, and a non-streamed reply
 * sends none until the whole prompt is processed. llama-server puts the timings in the last chunk.
 */
async function chat(target: LiteModel, messages: ChatMessage[]): Promise<Reply> {
	const response = await fetch(`${serverOrigin(target.baseUrl)}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
		},
		body: JSON.stringify({ messages, max_tokens: 64, temperature: 0, cache_prompt: true, stream: true }),
	});
	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const reply: Reply = { content: "", promptN: 0, cacheN: 0, promptMs: 0 };
	let buffered = "";
	for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
			const event = JSON.parse(line.slice(6)) as {
				choices?: { delta?: { content?: string } }[];
				timings?: { prompt_n?: number; cache_n?: number; prompt_ms?: number };
			};
			reply.content += event.choices?.[0]?.delta?.content ?? "";
			if (event.timings) {
				reply.promptN = event.timings.prompt_n ?? reply.promptN;
				reply.cacheN = event.timings.cache_n ?? reply.cacheN;
				reply.promptMs = event.timings.prompt_ms ?? reply.promptMs;
			}
		}
	}
	return reply;
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
	const started = Date.now();
	const result = await run();
	process.stdout.write(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
	return result;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const describe = (reply: Reply) =>
	`${reply.promptN} tokens processed, ${reply.cacheN} reused, prompt ${seconds(reply.promptMs)}`;

try {
	const first: ChatMessage[] = [
		{ role: "system", content: "You are a coding assistant. Answer briefly." },
		{ role: "user", content: `${filler(Number(values.tokens))}\n\nName the first file above in one line.` },
	];
	await timed("start server", () => manager.ensure(model));
	process.stdout.write("request A: reading the prompt (several minutes)...\n");
	const a = await chat(model, first);
	process.stdout.write(`request A: ${describe(a)}\n`);

	// The follow-up the actor gets after a verdict: everything so far, the reply without its reasoning, a new message.
	const followUp: ChatMessage[] = [
		...first,
		{ role: "assistant", content: a.content },
		{ role: "user", content: "[Supervisor] Phase 1 failed. Name the second file above in one line." },
	];

	const saved = await manager.saveSlot(filename);
	process.stdout.write(`save: ${saved.tokens} tokens, ${(saved.bytes / 1e9).toFixed(2)} GB in ${seconds(saved.ms)}\n`);
	await manager.stop();
	await timed("restart server", () => manager.ensure(model));
	const restored = await manager.restoreSlot(filename);
	process.stdout.write(`restore: ${restored.tokens} tokens in ${seconds(restored.ms)}\n`);
	const b = await chat(model, followUp);
	process.stdout.write(`request B after restore: ${describe(b)}\n`);

	await manager.stop();
	await timed("restart server", () => manager.ensure(model));
	const c = await chat(model, followUp);
	process.stdout.write(`request B without restore: ${describe(c)}\n`);

	const withRestore = restored.ms + b.promptMs;
	process.stdout.write(
		`\nRebound cost: ${seconds(withRestore)} with restore, ${seconds(c.promptMs)} without` +
			(b.cacheN === 0 ? ". The restored cache was not reused." : ".") +
			"\n",
	);
} finally {
	await manager.stop();
	rmSync(join(slotDir, filename), { force: true });
}
