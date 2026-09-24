import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { hasFlag, type LiteModel } from "../config/models.ts";
import { serverOrigin } from "../llm/server.ts";
import type { TokenUsage } from "../usage.ts";
import { type CheckResult, formatChecks } from "./gate.ts";
import type { Phase } from "./plan.ts";

/**
 * The critic's window. llama-server reserves memory for the whole `--ctx-size` at launch, so a 131k Ornith would
 * push a 17 GB Mac into swap before it read a token; 64k fits.
 */
export const CRITIC_CONTEXT = 65_536;
/** Tokens the verdict may take: five reasons of up to 300 characters, with room to spare. */
const VERDICT_TOKENS = 1024;
const MAX_REASONS = 5;
const MAX_REASON_CHARS = 300;

export interface Verdict {
	pass: boolean;
	/** Empty on a pass; one to five concrete problems on a fail. */
	reasons: string[];
}

export interface CriticRequest {
	phase: Phase;
	phaseCount: number;
	/** `diffSince` text, already cut to the critic's budget. */
	diff: string;
	/** The gate's checks. The critic only runs once they all passed. */
	checks: readonly CheckResult[];
	/** Image files the checks wrote. */
	screenshots: readonly string[];
}

/** `model` as the supervisor launches its critic: `--ctx-size` replaced by at most `CRITIC_CONTEXT`. */
export function asCritic(model: LiteModel): LiteModel {
	const contextWindow = Math.min(model.contextWindow, CRITIC_CONTEXT);
	const launchArgs: string[] = [];
	for (let i = 0; i < model.launchArgs.length; i++) {
		const arg = model.launchArgs[i];
		if (arg === "-c" || arg === "--ctx-size") i++;
		else if (!arg.startsWith("--ctx-size=")) launchArgs.push(arg);
	}
	launchArgs.push("--ctx-size", String(contextWindow));
	return { ...model, contextWindow, maxTokens: Math.min(model.maxTokens, VERDICT_TOKENS), launchArgs };
}

/** Whether the critic loads a vision projector, so screenshots go to it as images rather than as paths. */
export function criticSeesImages(model: LiteModel): boolean {
	return model.mmproj !== undefined || hasFlag(model.launchArgs, ["--mmproj", "-mm"]);
}

/**
 * A GBNF grammar allowing exactly `{"verdict":"pass","reasons":[]}` or `{"verdict":"fail","reasons":[...]}` with one
 * to five short reasons. Quotes are written as the character class ["], and rule names use only letters, digits, and
 * hyphens, which llama.cpp's GBNF parser requires.
 */
export function buildVerdictGBNF(): string {
	const key = (name: string) => `["] "${name}" ["] ws ":" ws`;
	return [
		`root ::= "{" ws ${key("verdict")} (pass | fail) ws "}" ws`,
		`pass ::= ["] "pass" ["] ws "," ws ${key("reasons")} "[" ws "]"`,
		`fail ::= ["] "fail" ["] ws "," ws ${key("reasons")} "[" ws reason (ws "," ws reason){0,${MAX_REASONS - 1}} ws "]"`,
		`reason ::= ["] char{1,${MAX_REASON_CHARS}} ["]`,
		`char ::= [^"\\\\\\x00-\\x1f] | [\\\\] ["\\\\/bfnrt]`,
		"ws ::= [ \\t\\n]{0,16}",
	].join("\n");
}

/** The verdict in the critic's reply, or undefined when there is none to read. */
export function parseVerdict(raw: string): Verdict | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw.trim());
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { verdict, reasons } = value as { verdict?: unknown; reasons?: unknown };
	if (verdict !== "pass" && verdict !== "fail") return undefined;
	const list = Array.isArray(reasons)
		? reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim() !== "")
		: [];
	if (verdict === "pass") return { pass: true, reasons: [] };
	return { pass: false, reasons: list.length > 0 ? list : ["The critic failed the phase without giving a reason."] };
}

const SYSTEM = `You are a strict reviewer. A developer has finished one phase of an implementation plan. Decide whether that phase is complete and correct.

Pass only if every requirement of this phase is met by the changes and nothing they touch is broken. Do not fail the phase for work that belongs to later phases, for style, or for choices the requirements leave open. The checks listed have already passed.

On a fail, give at most ${MAX_REASONS} reasons. Each names the file and says what is wrong or missing, as an instruction the developer can act on.

Reply with JSON only: {"verdict":"pass","reasons":[]} or {"verdict":"fail","reasons":["..."]}`;

/**
 * The critic's request, requirements last so they are freshest when it answers. With `images`, the screenshots are
 * attached between the check output and the requirements; without, their paths are listed.
 */
export function formatCriticPrompt(request: CriticRequest, images: boolean): { system: string; parts: string[] } {
	const { phase, phaseCount, diff, checks, screenshots } = request;
	const before = `Changes made during this phase:\n\n${diff || "(no changes)"}\n\nChecks run after the phase:\n\n${formatChecks(checks)}`;
	const listed = screenshots.map((path) => `- ${path}`).join("\n");
	const shots =
		screenshots.length === 0
			? ""
			: images
				? `\n\nScreenshots the checks saved, in this order:\n${listed}`
				: `\n\nThe checks saved these screenshots, which you cannot see:\n${listed}`;
	const after = `Phase ${phase.number} of ${phaseCount}: ${phase.title}\n\nRequirements:\n${phase.body || "(none written)"}\n\nIs phase ${phase.number} complete and correct? Reply with the JSON verdict.`;
	return { system: SYSTEM, parts: [before + shots, after] };
}

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

export interface AskCriticOptions {
	signal?: AbortSignal;
	fetch?: typeof fetch;
	readImage?: (path: string) => Promise<Buffer>;
}

/**
 * Ask the critic for a verdict. llama-server applies the model's chat template (`/apply-template`, thinking off), then
 * `/completion` generates under the verdict grammar at temperature 0. The request streams: Node's fetch gives up on a
 * response whose headers take 5 minutes, and a streamed reply sends them at once while a 64k prompt is still being
 * read. A reply the grammar should have made impossible still comes back as a fail, so the loop never stalls on it.
 */
export async function askCritic(
	model: LiteModel,
	request: CriticRequest,
	options: AskCriticOptions = {},
): Promise<Verdict & { raw: string; usage: TokenUsage }> {
	const fetchFn = options.fetch ?? fetch;
	const readImage = options.readImage ?? ((path: string) => readFile(path));
	const origin = serverOrigin(model.baseUrl);
	const headers = {
		"Content-Type": "application/json",
		...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
	};
	const images = criticSeesImages(model) ? request.screenshots : [];
	const { system, parts } = formatCriticPrompt(request, images.length > 0);
	const encoded = await Promise.all(images.map(async (path) => (await readImage(path)).toString("base64")));
	const content = [
		{ type: "text", text: parts[0] },
		...encoded.map((data, index) => ({
			type: "image_url",
			image_url: { url: `data:${IMAGE_TYPES[extname(images[index]).toLowerCase()] ?? "image/png"};base64,${data}` },
		})),
		{ type: "text", text: parts[1] },
	];

	const templated = await fetchFn(`${origin}/apply-template`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			messages: [
				{ role: "system", content: system },
				{ role: "user", content },
			],
			chat_template_kwargs: { enable_thinking: false },
		}),
		signal: options.signal,
	});
	if (!templated.ok)
		throw new Error(`critic /apply-template: HTTP ${templated.status}: ${await errorText(templated)}`);
	const { prompt } = (await templated.json()) as { prompt?: unknown };
	if (typeof prompt !== "string") throw new Error("critic /apply-template returned no prompt.");

	const response = await fetchFn(`${origin}/completion`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			prompt: encoded.length > 0 ? { prompt_string: prompt, multimodal_data: encoded } : prompt,
			grammar: buildVerdictGBNF(),
			temperature: 0,
			n_predict: VERDICT_TOKENS,
			stream: true,
		}),
		signal: options.signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(`critic /completion: HTTP ${response.status}: ${await errorText(response)}`);
	}
	let raw = "";
	let buffered = "";
	const usage: TokenUsage = { requests: 1, input: 0, cached: 0, output: 0 };
	for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const event = JSON.parse(line.slice(6)) as {
				content?: string;
				error?: { message?: string };
				timings?: { prompt_n?: number; cache_n?: number; predicted_n?: number };
			};
			if (event.error) throw new Error(`critic /completion: ${event.error.message ?? "error"}`);
			raw += event.content ?? "";
			if (event.timings) {
				usage.cached = event.timings.cache_n ?? 0;
				usage.input = (event.timings.prompt_n ?? 0) + usage.cached;
				usage.output = event.timings.predicted_n ?? 0;
			}
		}
	}
	const verdict = parseVerdict(raw) ?? { pass: false, reasons: ["The critic returned no readable verdict."] };
	return { ...verdict, raw, usage };
}

async function errorText(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const body = JSON.parse(text) as { error?: { message?: string } };
		if (body.error?.message) return body.error.message;
	} catch {}
	return text.slice(0, 300) || response.statusText;
}
