import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RagConfig } from "../rag/kiwix.ts";
import { expandHome, getAppDir } from "./paths.ts";
import {
	isSamplingMode,
	SAMPLING_MODES,
	type SamplingMode,
	type SamplingOverrides,
	type SamplingPreset,
} from "./sampling.ts";

export interface LiteModel {
	/** models.yml `name` (falls back to `id`). Unique; the stable handle for lookup, last-used, and sessions. */
	name: string;
	/**
	 * What to show instead of `name` once a `discover` entry has been connected: the GGUF the server turned out to
	 * be running. Undefined for an ordinary entry, which shows its `name`.
	 */
	displayName?: string;
	/**
	 * `discover: true`: a placeholder for whatever llama-server is already running at `baseUrl`. Its real fields
	 * arrive from `/props` at connect time, and pi-lite never spawns a server for it.
	 */
	discover?: boolean;
	/** `maxTokens` as written in models.yml, so discovery can tell an explicit value from the default. */
	configuredMaxTokens?: number;
	/** llama-server's `build_info`, when a discovered server reported one. */
	buildInfo?: string;
	/** models.yml `id`: the GGUF path, relative to `modelDir` unless absolute. */
	id: string;
	/** Key under `providers:` that defined this model. */
	provider: string;
	/** OpenAI-compatible base URL without a trailing slash, e.g. http://localhost:8080/v1. */
	baseUrl: string;
	apiKey?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	/** Absolute GGUF path passed to `llama-server -m`. */
	modelPath: string;
	launchArgs: string[];
	/** llama-server executable. */
	llamaServer: string;
	defaultMode?: SamplingMode;
	sampling?: SamplingOverrides;
}

/** What to call a model on screen: the GGUF a `discover` entry connected to, else its models.yml name. */
export function modelLabel(model: LiteModel): string {
	return model.displayName ?? model.name;
}

export interface ModelsConfig {
	path: string;
	models: LiteModel[];
	/** Non-fatal problems to show once at startup. */
	warnings: string[];
	/** The knowledge base for `/rag`, when models.yml has a `rag:` section. */
	rag?: RagConfig;
}

export class ModelsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelsConfigError";
	}
}

export interface ModelsFileSearch {
	/** Value of `--models <path>`. */
	explicit?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

/** Resolution order: `--models`, `$PI_MODELS`, `./models.yml`, `<app dir>/models.yml`. */
export function findModelsFile(search: ModelsFileSearch = {}): string {
	const env = search.env ?? process.env;
	const cwd = search.cwd ?? process.cwd();
	const pinned = search.explicit ?? env.PI_MODELS;
	if (pinned) {
		const path = resolve(cwd, expandHome(pinned));
		if (!existsSync(path)) throw new ModelsConfigError(`models file not found: ${path}`);
		return path;
	}
	const candidates = [join(cwd, "models.yml"), join(getAppDir(env), "models.yml")];
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		const searched = candidates.map((path) => `  ${path}`).join("\n");
		throw new ModelsConfigError(
			`No models.yml found. Looked in:\n${searched}\nRun pi-lite --init to create a starter file, or pass --models <path> or set PI_MODELS.`,
		);
	}
	return found;
}

export function loadModelsConfig(path: string, env: NodeJS.ProcessEnv = process.env): ModelsConfig {
	return parseModelsConfig(readFileSync(path, "utf8"), path, { env });
}

export interface ParseModelsOptions {
	env?: NodeJS.ProcessEnv;
}

type YamlRecord = Record<string, unknown>;

const NUMBER_SAMPLING_FIELDS = new Set(["temperature", "top_p", "top_k", "min_p", "presence_penalty"]);
const BOOLEAN_SAMPLING_FIELDS = new Set(["enableThinking"]);
const SAMPLING_FIELDS = [
	...NUMBER_SAMPLING_FIELDS,
	...BOOLEAN_SAMPLING_FIELDS,
	"thinkingHistory",
	"thinkingReplay",
	"reasoningEffort",
	"extra",
];

function isRecord(value: unknown): value is YamlRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Last value of a flag in an argv list (`--port 8080` or `--port=8080`), matching llama.cpp's last-wins parsing. */
export function flagValue(args: readonly string[], flags: readonly string[]): string | undefined {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		for (const flag of flags) {
			if (args[i] === flag) value = args[i + 1];
			else if (args[i].startsWith(`${flag}=`)) value = args[i].slice(flag.length + 1);
		}
	}
	return value;
}

export function hasFlag(args: readonly string[], flags: readonly string[]): boolean {
	return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

/**
 * Parse models.yml. Only `providers:` and `rag:` are read; other top-level keys (such as another tool's `ask:` block)
 * are ignored. Errors name the file and the offending key.
 */
export function parseModelsConfig(text: string, path: string, options: ParseModelsOptions = {}): ModelsConfig {
	const env = options.env ?? process.env;
	const configError = (key: string, problem: string) => new ModelsConfigError(`${path}: ${key} ${problem}`);

	const readString = (record: YamlRecord, key: string, at: string): string | undefined => {
		const value = record[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "string" || value.trim() === "")
			throw configError(`${at}.${key}`, "must be a non-empty string");
		return value;
	};
	const readBoolean = (record: YamlRecord, key: string, at: string): boolean | undefined => {
		const value = record[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "boolean") throw configError(`${at}.${key}`, "must be true or false");
		return value;
	};
	const readPositiveInt = (record: YamlRecord, key: string, at: string): number | undefined => {
		const value = record[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw configError(`${at}.${key}`, "must be a positive integer");
		}
		return value;
	};
	const readStringList = (record: YamlRecord, key: string, at: string): string[] | undefined => {
		const value = record[key];
		if (value === undefined || value === null) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" && typeof item !== "number")) {
			throw configError(`${at}.${key}`, "must be a list of strings");
		}
		return value.map(String);
	};
	const readSamplingOverrides = (value: unknown, at: string): SamplingOverrides | undefined => {
		if (value === undefined || value === null) return undefined;
		if (!isRecord(value)) throw configError(at, `must be a mapping with ${SAMPLING_MODES.join(" and/or ")}`);
		const overrides: SamplingOverrides = {};
		for (const [mode, fields] of Object.entries(value)) {
			const modeAt = `${at}.${mode}`;
			if (!isSamplingMode(mode))
				throw configError(modeAt, `is not a mode (expected ${SAMPLING_MODES.join(" or ")})`);
			if (!isRecord(fields)) throw configError(modeAt, "must be a mapping");
			const preset: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(fields)) {
				const fieldAt = `${modeAt}.${key}`;
				if (NUMBER_SAMPLING_FIELDS.has(key)) {
					if (typeof field !== "number" || !Number.isFinite(field)) throw configError(fieldAt, "must be a number");
				} else if (BOOLEAN_SAMPLING_FIELDS.has(key)) {
					if (typeof field !== "boolean") throw configError(fieldAt, "must be true or false");
				} else if (key === "thinkingReplay") {
					if (field !== "reasoning_content" && field !== "inline") {
						throw configError(fieldAt, "must be reasoning_content or inline");
					}
				} else if (key === "thinkingHistory") {
					if (field !== "none" && field !== "turn" && field !== "all") {
						throw configError(fieldAt, "must be none, turn, or all");
					}
				} else if (key === "reasoningEffort") {
					if (typeof field !== "string") throw configError(fieldAt, "must be a string");
				} else if (key === "extra") {
					if (!isRecord(field)) throw configError(fieldAt, "must be a mapping of request-body fields");
				} else {
					throw configError(fieldAt, `is not a sampling setting (expected one of: ${SAMPLING_FIELDS.join(", ")})`);
				}
				preset[key] = field;
			}
			overrides[mode] = preset as Partial<SamplingPreset>;
		}
		return overrides;
	};

	let root: unknown;
	try {
		root = parseYaml(text);
	} catch (error) {
		throw new ModelsConfigError(`${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(root) || !isRecord(root.providers)) {
		throw configError("providers", "must be a mapping of provider name to settings");
	}

	const configDir = dirname(path);
	const models: LiteModel[] = [];
	const warnings: string[] = [];

	for (const [providerName, provider] of Object.entries(root.providers)) {
		const at = `providers.${providerName}`;
		if (!isRecord(provider)) throw configError(at, "must be a mapping");

		const baseUrlText = readString(provider, "baseUrl", at);
		if (!baseUrlText) throw configError(`${at}.baseUrl`, "is required");
		let baseUrl: URL;
		try {
			baseUrl = new URL(baseUrlText);
		} catch {
			throw configError(`${at}.baseUrl`, `is not a valid URL: ${baseUrlText}`);
		}

		const api = readString(provider, "api", at);
		if (api !== undefined && api !== "openai-completions") {
			warnings.push(`${at}.api is "${api}"; pi-lite always uses /v1/chat/completions.`);
		}

		let apiKey = readString(provider, "apiKey", at);
		if (apiKey?.startsWith("$")) apiKey = env[apiKey.slice(1)];
		if (readString(provider, "auth", at) === "none") apiKey = undefined;

		const modelDirText = readString(provider, "modelDir", at);
		const modelDir = modelDirText === undefined ? undefined : resolve(configDir, expandHome(modelDirText));
		const llamaServer = readString(provider, "llamaServer", at) ?? env.LLAMA_SERVER ?? "llama-server";

		const providerMode = readString(provider, "mode", at);
		if (providerMode !== undefined && !isSamplingMode(providerMode)) {
			throw configError(`${at}.mode`, `must be ${SAMPLING_MODES.join(" or ")}`);
		}

		// `discover: true`: one placeholder standing for whatever the server at baseUrl is already running. Its
		// fields are filled from /props on connect, so models.yml says nothing about the model itself.
		if (readBoolean(provider, "discover", at) === true) {
			if (provider.models !== undefined) {
				throw configError(`${at}.models`, "is not allowed with discover: true; the running server names the model");
			}
			const name = readString(provider, "name", at) ?? providerName;
			if (models.some((model) => model.name === name)) {
				throw configError(`${at}.name`, `duplicates another model named "${name}"`);
			}
			models.push({
				name,
				discover: true,
				id: "",
				provider: providerName,
				baseUrl: baseUrl.href.replace(/\/+$/, ""),
				apiKey,
				reasoning: false,
				input: ["text"],
				// Replaced from /props before anything is sent. Nothing reads these while unconnected.
				contextWindow: 4096,
				maxTokens: 1024,
				configuredMaxTokens: readPositiveInt(provider, "maxTokens", at),
				modelPath: "",
				launchArgs: [],
				llamaServer,
				defaultMode: providerMode,
				sampling: readSamplingOverrides(provider.sampling, `${at}.sampling`),
			});
			continue;
		}

		const rawModels = provider.models;
		if (!Array.isArray(rawModels) || rawModels.length === 0)
			throw configError(`${at}.models`, "must be a non-empty list");

		for (let index = 0; index < rawModels.length; index++) {
			const raw: unknown = rawModels[index];
			const modelAt = `${at}.models[${index}]`;
			if (!isRecord(raw)) throw configError(modelAt, "must be a mapping");

			const id = readString(raw, "id", modelAt);
			if (!id) throw configError(`${modelAt}.id`, "is required");
			const name = readString(raw, "name", modelAt) ?? id;
			if (models.some((model) => model.name === name)) {
				throw configError(`${modelAt}.name`, `duplicates another model named "${name}"`);
			}

			const contextWindow = readPositiveInt(raw, "contextWindow", modelAt);
			if (contextWindow === undefined) throw configError(`${modelAt}.contextWindow`, "is required");
			const maxTokens = readPositiveInt(raw, "maxTokens", modelAt) ?? Math.min(8192, Math.floor(contextWindow / 4));
			if (maxTokens >= contextWindow) {
				throw configError(`${modelAt}.maxTokens`, `must be smaller than contextWindow (${contextWindow})`);
			}

			const input: LiteModel["input"] = [];
			for (const kind of readStringList(raw, "input", modelAt) ?? ["text"]) {
				if (kind !== "text" && kind !== "image") {
					throw configError(`${modelAt}.input`, `has unknown kind "${kind}" (expected text or image)`);
				}
				input.push(kind);
			}

			const launchArgs = readStringList(raw, "launchArgs", modelAt) ?? [];
			if (hasFlag(launchArgs, ["-m", "--model"])) {
				throw configError(`${modelAt}.launchArgs`, "must not set -m/--model; the model path comes from id");
			}

			const expandedId = expandHome(id);
			let modelPath: string;
			if (isAbsolute(expandedId)) modelPath = expandedId;
			else if (modelDir) modelPath = join(modelDir, expandedId);
			else throw configError(`${modelAt}.id`, `is a relative path but ${at}.modelDir is not set`);

			const urlPort = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
			const port = flagValue(launchArgs, ["--port"]);
			if (port !== undefined && port !== urlPort) {
				warnings.push(`${name}: launchArgs --port ${port} does not match baseUrl port ${urlPort}.`);
			}
			const ctxSize = Number(flagValue(launchArgs, ["-c", "--ctx-size"]));
			if (ctxSize > 0 && ctxSize < contextWindow) {
				warnings.push(`${name}: launchArgs --ctx-size ${ctxSize} is smaller than contextWindow ${contextWindow}.`);
			}

			const mode = readString(raw, "mode", modelAt);
			if (mode !== undefined && !isSamplingMode(mode)) {
				throw configError(`${modelAt}.mode`, `must be ${SAMPLING_MODES.join(" or ")}`);
			}

			models.push({
				name,
				id,
				provider: providerName,
				baseUrl: baseUrl.href.replace(/\/+$/, ""),
				apiKey,
				reasoning: readBoolean(raw, "reasoning", modelAt) ?? false,
				input,
				contextWindow,
				maxTokens,
				modelPath,
				launchArgs,
				llamaServer,
				defaultMode: mode,
				sampling: readSamplingOverrides(raw.sampling, `${modelAt}.sampling`),
			});
		}
	}

	if (models.length === 0) throw configError("providers", "defines no models");

	// `rag:` names the folder of .zim archives `/rag on` searches.
	let rag: RagConfig | undefined;
	if (root.rag !== undefined) {
		if (!isRecord(root.rag)) throw configError("rag", "must be a mapping");
		const folder = readString(root.rag, "zimFolder", "rag");
		if (!folder) throw configError("rag.zimFolder", "is required");
		rag = {
			folder: resolve(configDir, expandHome(folder)),
			kiwixServe: readString(root.rag, "kiwixServe", "rag") ?? "kiwix-serve",
		};
		if (!existsSync(rag.folder)) warnings.push(`rag.zimFolder not found: ${rag.folder}`);
	}
	return { path, models, warnings, ...(rag ? { rag } : {}) };
}

/** Exact name or id, then case-insensitive name, then a unique case-insensitive substring of a name. */
export function findModel(models: readonly LiteModel[], query: string): LiteModel | undefined {
	const exact = models.find((model) => model.name === query || model.id === query);
	if (exact) return exact;
	const lower = query.toLowerCase();
	const insensitive = models.find((model) => model.name.toLowerCase() === lower);
	if (insensitive) return insensitive;
	const partial = models.filter((model) => model.name.toLowerCase().includes(lower));
	return partial.length === 1 ? partial[0] : undefined;
}
