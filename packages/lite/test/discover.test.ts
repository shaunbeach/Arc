import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import { fetchServerProps, modelNameFromPath, resolveDiscoveredModel } from "../src/llm/discover.ts";

/** Shaped like llama-server b10809's /props, trimmed to the fields discovery reads. */
const PROPS = {
	model_path: "/Users/sbeach/Documents/GGUFs/ornith-1.5/Ornith-1.5-9B-Q4_K_M.gguf",
	model_alias: "/Users/sbeach/Documents/GGUFs/ornith-1.5/Ornith-1.5-9B-Q4_K_M.gguf",
	build_info: "b10809-5266f24da",
	total_slots: 1,
	modalities: { vision: true, video: true, audio: false },
	chat_template_caps: {
		supports_preserve_reasoning: true,
		supports_reasoning_effort: false,
		supports_tools: true,
	},
	default_generation_settings: { n_ctx: 65536 },
};

function jsonFetch(body: unknown, ok = true): typeof fetch {
	return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

const PLACEHOLDER: LiteModel = {
	name: "remote",
	discover: true,
	id: "",
	provider: "remote",
	baseUrl: "http://localhost:8081/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 1024,
	modelPath: "",
	launchArgs: [],
	llamaServer: "llama-server",
};

describe("fetchServerProps", () => {
	it("reads the model, window, and capabilities llama-server advertises", async () => {
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(PROPS));
		expect(props).toEqual({
			modelPath: PROPS.model_path,
			contextWindow: 65536,
			vision: true,
			reasoning: true,
			reasoningEffort: false,
			tools: true,
			buildInfo: "b10809-5266f24da",
		});
	});

	it("falls back to model_alias when model_path is absent", async () => {
		const { model_path, ...withoutPath } = PROPS;
		expect(model_path).toBeTruthy();
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(withoutPath));
		expect(props?.modelPath).toBe(PROPS.model_alias);
	});

	it("gives up rather than guess when nothing usable answers", async () => {
		const unreachable = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await fetchServerProps("http://localhost:8081/v1", unreachable)).toBeUndefined();
		expect(await fetchServerProps("http://localhost:8081/v1", jsonFetch(PROPS, false))).toBeUndefined();
		expect(await fetchServerProps("http://localhost:8081/v1", jsonFetch({ hello: "world" }))).toBeUndefined();
		// A server with no usable window is no better than no answer.
		const noCtx = { ...PROPS, default_generation_settings: { n_ctx: 0 } };
		expect(await fetchServerProps("http://localhost:8081/v1", jsonFetch(noCtx))).toBeUndefined();
	});
});

describe("resolveDiscoveredModel", () => {
	it("fills the placeholder from the server and keeps its name as the handle", async () => {
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(PROPS));
		if (!props) throw new Error("expected props");
		const model = resolveDiscoveredModel(PLACEHOLDER, props);

		// The name stays put so /model, last-used, and saved sessions keep working across reconnects.
		expect(model.name).toBe("remote");
		expect(model.displayName).toBe("Ornith-1.5-9B-Q4_K_M");
		expect(model.modelPath).toBe(PROPS.model_path);
		expect(model.contextWindow).toBe(65536);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		// Not advertised, so it follows the same default as an entry that omits maxTokens.
		expect(model.maxTokens).toBe(8192);
		// Never spawn a server for something discovered on another machine.
		expect(model.discover).toBe(true);
		expect(model.launchArgs).toEqual([]);
	});

	it("takes maxTokens from models.yml when it is set there", async () => {
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(PROPS));
		if (!props) throw new Error("expected props");
		const model = resolveDiscoveredModel({ ...PLACEHOLDER, configuredMaxTokens: 2048 }, props);
		expect(model.maxTokens).toBe(2048);
	});

	it("keeps the reply reserve below the window on a small server", async () => {
		const small = { ...PROPS, default_generation_settings: { n_ctx: 2048 } };
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(small));
		if (!props) throw new Error("expected props");
		// A configured 8192 reserve against a 2048 window would leave nothing for the conversation.
		const model = resolveDiscoveredModel({ ...PLACEHOLDER, configuredMaxTokens: 8192 }, props);
		expect(model.contextWindow).toBe(2048);
		expect(model.maxTokens).toBeLessThan(model.contextWindow);
	});

	it("reports a text-only server as text-only", async () => {
		const textOnly = {
			...PROPS,
			modalities: { vision: false },
			chat_template_caps: { supports_preserve_reasoning: false, supports_tools: true },
		};
		const props = await fetchServerProps("http://localhost:8081/v1", jsonFetch(textOnly));
		if (!props) throw new Error("expected props");
		const model = resolveDiscoveredModel(PLACEHOLDER, props);
		expect(model.input).toEqual(["text"]);
		expect(model.reasoning).toBe(false);
	});
});

describe("modelNameFromPath", () => {
	it("reduces a GGUF path to the name worth showing", () => {
		expect(modelNameFromPath("/a/b/Ornith-1.5-9B-Q4_K_M.gguf")).toBe("Ornith-1.5-9B-Q4_K_M");
		expect(modelNameFromPath("Qwen3.5-2B-Q4_K_M.gguf")).toBe("Qwen3.5-2B-Q4_K_M");
		expect(modelNameFromPath("/a/b/model")).toBe("model");
	});
});
