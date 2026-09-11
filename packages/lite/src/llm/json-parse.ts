import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repair malformed JSON string literals, which small models emit often: escape raw control characters
 * inside strings and double backslashes before invalid escape characters.
 */
function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') inString = true;
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}
			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}
			repaired += "\\\\";
			continue;
		}

		const codePoint = char.codePointAt(0);
		repaired += codePoint !== undefined && codePoint <= 0x1f ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/**
 * Parse possibly incomplete tool-call arguments while they stream. Always returns an object: complete JSON,
 * repaired JSON, a partial parse, or `{}`.
 */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
	if (!partialJson || partialJson.trim() === "") return {};

	try {
		return JSON.parse(partialJson);
	} catch {
		const repaired = repairJson(partialJson);
		try {
			return JSON.parse(repaired);
		} catch {
			for (const candidate of [partialJson, repaired]) {
				try {
					const result = partialParse(candidate);
					if (typeof result === "object" && result !== null && !Array.isArray(result)) return result;
				} catch {
					// Try the next candidate.
				}
			}
			return {};
		}
	}
}
