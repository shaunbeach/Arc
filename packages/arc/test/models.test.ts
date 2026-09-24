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

function parse(text: string, options: { env?: NodeJS.ProcessEnv } = {}) {
	return parseModelsConfig(text, "/cfg/models.yml", { env: options.env ?? {} });
}

/** Add another provider to CONFIG's `providers:` block, before the unrelated top-level key. */
function withProvider(yaml: string): string {
	expect(CONFIG).toContain("\nask:");
	return CONFIG.replace("\nask:", `${yaml}\nask:`);
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

	it("warns about the api field, a port mismatch, and a small ctx-size", () => {
		const { warnings } = parse(CONFIG);
		expect(warnings).toEqual([
			'providers.llamacpp.api is "openai-responses"; Arc always uses /v1/chat/completions.',
			"Qwen3.5-4B-Q6_K: launchArgs --port 8081 does not match baseUrl port 8080.",
			"Qwen3.5-4B-Q6_K: launchArgs --ctx-size 16384 is smaller than contextWindow 32768.",
		]);
	});

	it("does not warn about a model file that is not on this machine", () => {
		// Remote entries name paths on another machine; a path that is wrong locally fails at load
		// time with llama-server's own error, which names the file.
		expect(parse(CONFIG).warnings).not.toContainEqual(expect.stringContaining("not found"));
	});

	it("reads a discover provider as one placeholder with no models list", () => {
		const text = withProvider(`  mac:
    baseUrl: http://localhost:8081/v1
    auth: none
    discover: true
`);
		const model = parse(text).models.at(-1);
		expect(model?.name).toBe("mac");
		expect(model?.discover).toBe(true);
		expect(model?.baseUrl).toBe("http://localhost:8081/v1");
		// Nothing about the model is known until something is serving there.
		expect(model?.modelPath).toBe("");
		expect(model?.launchArgs).toEqual([]);
		expect(model?.configuredMaxTokens).toBeUndefined();
	});

	it("names a discover provider with name, and carries mode and maxTokens", () => {
		const text = withProvider(`  mac:
    baseUrl: http://localhost:8081/v1
    discover: true
    name: remote
    mode: instruct
    maxTokens: 4096
`);
		const model = parse(text).models.at(-1);
		expect(model?.name).toBe("remote");
		expect(model?.defaultMode).toBe("instruct");
		expect(model?.configuredMaxTokens).toBe(4096);
	});

	it("rejects a discover provider that also lists models", () => {
		const text = withProvider(`  mac:
    baseUrl: http://localhost:8081/v1
    discover: true
    models:
      - id: a.gguf
        contextWindow: 4096
`);
		expect(() => parse(text)).toThrow(/discover: true/);
	});

	it("rejects a discover provider whose name is already taken", () => {
		const text = withProvider(`  mac:
    baseUrl: http://localhost:8081/v1
    discover: true
    name: Qwen3-4B-Instruct
`);
		expect(() => parse(text)).toThrow(/duplicates another model/);
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

describe("mmproj", () => {
	const vision = (extra: string) => `
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    modelDir: /models
    models:
      - id: ornith.gguf
        contextWindow: 65536
${extra}`;

	it("resolves mmproj like id and turns on image input", () => {
		const [model] = parse(vision("        mmproj: mmproj-ornith.gguf")).models;
		expect(model.mmproj).toBe("/models/mmproj-ornith.gguf");
		expect(model.input).toEqual(["text", "image"]);
	});

	it("leaves a model without one as it was", () => {
		const [model] = parse(vision("")).models;
		expect(model.mmproj).toBeUndefined();
		expect(model.input).toEqual(["text"]);
	});

	it("refuses mmproj next to --mmproj in launchArgs", () => {
		expect(() => parse(vision('        mmproj: /p.gguf\n        launchArgs: ["--mmproj", "/p.gguf"]'))).toThrow(
			/keep one/,
		);
	});
});

describe("supervisor", () => {
	const withSupervisor = (block: string) => `${CONFIG}\n${block}`;

	it("resolves the critic to its model name and defaults maxRetries to 3", () => {
		expect(parse(withSupervisor("supervisor:\n  critic: qwen3.5")).supervisor).toEqual({
			critic: "Qwen3.5-4B-Q6_K",
			maxRetries: 3,
			attemptMinutes: 90,
		});
		expect(
			parse(withSupervisor("supervisor:\n  critic: Qwen3.5-4B-Q6_K\n  maxRetries: 5")).supervisor?.maxRetries,
		).toBe(5);
		expect(parse(CONFIG).supervisor).toBeUndefined();
	});

	it("needs a critic that names a model", () => {
		expect(() => parse(withSupervisor("supervisor:\n  maxRetries: 2"))).toThrow(/supervisor.critic is required/);
		expect(() => parse(withSupervisor("supervisor:\n  critic: nobody"))).toThrow(/names no model: nobody/);
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

describe("rag", () => {
	it("reads the knowledge base folder, relative to models.yml, and a kiwix-serve path", () => {
		expect(parse(CONFIG).rag).toBeUndefined();
		const config = parse(`${CONFIG}\nrag:\n  zimFolder: zims\n  kiwixServe: /opt/kiwix/kiwix-serve\n`);
		expect(config.rag).toEqual({ folder: "/cfg/zims", kiwixServe: "/opt/kiwix/kiwix-serve" });
		expect(config.warnings).toContain("rag.zimFolder not found: /cfg/zims");
		expect(parse(`${CONFIG}\nrag:\n  zimFolder: /z\n`).rag?.kiwixServe).toBe("kiwix-serve");
	});

	it("needs a folder", () => {
		expect(() => parse(`${CONFIG}\nrag:\n  kiwixServe: kiwix-serve\n`)).toThrow("rag.zimFolder is required");
		expect(() => parse(`${CONFIG}\nrag: yes\n`)).toThrow("rag must be a mapping");
	});
});
