export interface ToolLimits {
	/** Most lines one tool result may return. */
	maxLines: number;
	/** Most bytes one tool result may return. */
	maxBytes: number;
}

export interface CodingToolOptions {
	/** Directory that relative paths and commands resolve against. */
	cwd: string;
	limits: ToolLimits;
	/** Whether the model accepts images (models.yml `input`). The read tool attaches image files only then. */
	acceptsImages: boolean;
}

const MIN_OUTPUT_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Output caps scaled to the context window: one tool result may use about a quarter of it, at roughly three bytes
 * per token. A 12k window allows about 9KB per result; large windows stop at 50KB.
 */
export function toolLimitsFor(contextWindow: number): ToolLimits {
	const maxBytes = Math.min(MAX_OUTPUT_BYTES, Math.max(MIN_OUTPUT_BYTES, Math.floor(contextWindow * 0.25 * 3)));
	return { maxLines: 2000, maxBytes };
}
