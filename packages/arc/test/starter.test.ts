import { describe, expect, it } from "vitest";
import { parseModelsConfig } from "../src/config/models.ts";
import { STARTER_MODELS_YML } from "../src/config/starter.ts";

describe("starter models.yml", () => {
	it("parses without warnings", () => {
		const config = parseModelsConfig(STARTER_MODELS_YML, "/home/me/.arc/models.yml", { env: {} });
		expect(config.warnings).toEqual([]);
		expect(config.models.map((model) => [model.name, model.contextWindow, model.maxTokens])).toEqual([
			["Qwen3.8-27B", 16384, 4096],
		]);
	});
});
