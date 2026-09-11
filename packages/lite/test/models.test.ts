import { describe, expect, it } from "vitest";
import { findModel, flagValue, parseModelsConfig } from "../src/config/models.ts";

const CONFIG = `
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    auth: none
    api: openai-responses
    modelDir: /models
    models:
      - id: Qwen3-4B-Instruct-2507/Qwen3-4B-Instruct-2507.gguf
        name: Qwen3-4B-Instruct
        reasoning: false
        input:
          - text
        contextWindow: 32768
        maxTokens: 8192
        launchArgs: ["--port", "8080", "--ctx-size", "32768"]
      - id: Qwen3.5-4B/Qwen3.5-4B-Q6_K.gguf
        name: Qwen3.5-4B-Q6_K
        reasoning: true
        contextWindow: 32768
        launchArgs: ["--port", "8081", "--ctx-size", "16384"]
        sampling:
          thinking:
            temperature: 0.6
            extra:
              thinking_budget_tokens: 2048

ask:
  rag:
    zimFolder: /somewhere
`;

function parse(text: string, options: { exists?: boolean; env?: NodeJS.ProcessEnv } = {}) {
	return parseModelsConfig(text, "/cfg/models.yml", {
		env: options.env ?? {},
		fileExists: () => options.exists ?? true,
	});
}

/** Replace one line of CONFIG, failing loudly if the line is not there. */
function withLine(from: string, to: string): string {
	expect(CONFIG).toContain(from);
	return CONFIG.replace(from, to);
}

describe("parseModelsConfig", () => {
	it("reads providers and ignores other top-level keys", () => {
		const { models } = parse(CONFIG);
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual({
			name: "Qwen3-4B-Instruct",
			id: "Qwen3-4B-Instruct-2507/Qwen3-4B-Instruct-2507.gguf",
			provider: "llamacpp",
			baseUrl: "http://localhost:8080/v1",
			apiKey: undefined,
			reasoning: false,
			input: ["text"],
			contextWindow: 32768,
			maxTokens: 8192,
			modelPath: "/models/Qwen3-4B-Instruct-2507/Qwen3-4B-Instruct-2507.gguf",
			launchArgs: ["--port", "8080", "--ctx-size", "32768"],
			llamaServer: "llama-server",
			defaultMode: undefined,
			sampling: undefined,
		});
		expect(models[1].maxTokens).toBe(8192);
		expect(models[1].sampling).toEqual({ thinking: { temperature: 0.6, extra: { thinking_budget_tokens: 2048 } } });
	});

	it("warns about the api field, a port mismatch, a small ctx-size, and missing files", () => {
		const { warnings } = parse(CONFIG, { exists: false });
		expect(warnings).toEqual([
			'providers.llamacpp.api is "openai-responses"; pi-lite always uses /v1/chat/completions.',
			"Qwen3-4B-Instruct: model file not found: /models/Qwen3-4B-Instruct-2507/Qwen3-4B-Instruct-2507.gguf",
			"Qwen3.5-4B-Q6_K: model file not found: /models/Qwen3.5-4B/Qwen3.5-4B-Q6_K.gguf",
			"Qwen3.5-4B-Q6_K: launchArgs --port 8081 does not match baseUrl port 8080.",
			"Qwen3.5-4B-Q6_K: launchArgs --ctx-size 16384 is smaller than contextWindow 32768.",
		]);
	});

	it("resolves an apiKey from the environment unless auth is none", () => {
		const text = withLine("    auth: none", "    apiKey: $LLAMA_KEY");
		expect(parse(text, { env: { LLAMA_KEY: "secret" } }).models[0].apiKey).toBe("secret");
		expect(parse(withLine("    auth: none", "    auth: none\n    apiKey: literal")).models[0].apiKey).toBeUndefined();
	});

	it("uses LLAMA_SERVER when llamaServer is not set", () => {
		expect(parse(CONFIG, { env: { LLAMA_SERVER: "/opt/llama-server" } }).models[0].llamaServer).toBe(
			"/opt/llama-server",
		);
	});

	it.each([
		[
			"a required field is missing",
			withLine("        contextWindow: 32768\n        maxTokens: 8192", "        maxTokens: 8192"),
			/providers\.llamacpp\.models\[0\]\.contextWindow is required/,
		],
		[
			"maxTokens does not fit",
			withLine("        maxTokens: 8192", "        maxTokens: 40000"),
			/models\[0\]\.maxTokens must be smaller than contextWindow \(32768\)/,
		],
		[
			"a sampling key is unknown",
			withLine("            temperature: 0.6", "            temp: 0.6"),
			/sampling\.thinking\.temp is not a sampling setting/,
		],
		[
			"a sampling value has the wrong type",
			withLine("            temperature: 0.6", '            temperature: "hot"'),
			/sampling\.thinking\.temperature must be a number/,
		],
		[
			"launchArgs sets the model",
			withLine('["--port", "8080", "--ctx-size", "32768"]', '["-m", "x.gguf"]'),
			/launchArgs must not set -m\/--model/,
		],
		[
			"a relative id has no modelDir",
			withLine("    modelDir: /models\n", ""),
			/models\[0\]\.id is a relative path but providers\.llamacpp\.modelDir is not set/,
		],
		[
			"two models share a name",
			withLine("        name: Qwen3.5-4B-Q6_K", "        name: Qwen3-4B-Instruct"),
			/models\[1\]\.name duplicates another model named "Qwen3-4B-Instruct"/,
		],
		[
			"mode is unknown",
			withLine("        reasoning: true", "        reasoning: true\n        mode: fast"),
			/models\[1\]\.mode must be thinking or instruct/,
		],
		["providers is missing", "ask: {}\n", /\/cfg\/models\.yml: providers must be a mapping/],
		["the YAML is invalid", "providers: [\n", /\/cfg\/models\.yml: invalid YAML/],
	])("rejects the file when %s", (_case, text, message) => {
		expect(() => parse(text)).toThrow(message);
	});
});

describe("findModel", () => {
	const { models } = parse(CONFIG);

	it("matches exact names and ids, then case-insensitive names, then a unique substring", () => {
		expect(findModel(models, "Qwen3.5-4B-Q6_K")?.name).toBe("Qwen3.5-4B-Q6_K");
		expect(findModel(models, "Qwen3.5-4B/Qwen3.5-4B-Q6_K.gguf")?.name).toBe("Qwen3.5-4B-Q6_K");
		expect(findModel(models, "qwen3-4b-instruct")?.name).toBe("Qwen3-4B-Instruct");
		expect(findModel(models, "3.5")?.name).toBe("Qwen3.5-4B-Q6_K");
	});

	it("returns undefined for ambiguous or unknown queries", () => {
		expect(findModel(models, "qwen")).toBeUndefined();
		expect(findModel(models, "llama")).toBeUndefined();
	});
});

describe("flagValue", () => {
	it("returns the last value in either flag form", () => {
		expect(flagValue(["--port", "8080", "--port=9090"], ["--port"])).toBe("9090");
		expect(flagValue(["-c", "4096"], ["-c", "--ctx-size"])).toBe("4096");
		expect(flagValue(["--jinja"], ["--port"])).toBeUndefined();
	});
});
