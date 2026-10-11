import type { LiteModel } from "../config/models.ts";
import type { KnowledgeBase } from "../rag/kiwix.ts";

export interface ToolLimits {
	/** Most lines one tool result may return. */
	maxLines: number;
	/** Most bytes one tool result may return. */
	maxBytes: number;
}

export interface SubagentToolOptions {
	/** The models.yml entry the subagent runs on. */
	model: LiteModel;
	/** The models.yml the subagent reads, so it sees the same models as this session. */
	configPath: string;
	/** The subagent's own time limit; the parent stops it a little after. */
	timeoutMinutes: number;
}

export interface CodingToolOptions {
	/** Directory that relative paths and commands resolve against. */
	cwd: string;
	limits: ToolLimits;
	/** Whether the model accepts images (models.yml `input`). The read tool attaches image files only then. */
	acceptsImages: boolean;
	/** Whether the headless browser tool is enabled. */
	browser?: boolean;
	/** The deep_research subagent (`/subagent on` with a models.yml `subagent:`). Without it, there is no deep_research. */
	subagent?: SubagentToolOptions;
	/**
	 * Whether web_fetch may reach loopback and private addresses right now. Default: yes. The app allows it only in
	 * agent mode, where bash reaches them anyway.
	 */
	allowLocalNetwork?: () => boolean;
	/**
	 * Whether read may open files outside the project right now. Default: yes. The app allows it only in agent mode:
	 * in plan and chat modes read sits beside the web tools with nothing else, and a page must not be able to steer
	 * the model into reading ~/.ssh and sending it out in a URL.
	 */
	readAnywhere?: () => boolean;
	/** The offline archives kb_search reads (models.yml `rag:`). Without one, there is no kb_search. */
	knowledgeBase?: KnowledgeBase;
	/**
	 * The memory tool, when a MemPalace exists: `wing` is this project's (`/mempalace`), searched by default. Without
	 * this, there is no memory tool.
	 */
	memory?: { wing?: string };
}

const MIN_OUTPUT_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Output caps scaled to the room the conversation has: the context window minus the reply reserve. One tool result
 * may use about a fifth of it, at roughly three bytes per token. Sized from the whole window instead, a single test
 * run could fill most of what is left after trimming. A 20k window with 8k reserved allows about 7KB per result;
 * large windows stop at 50KB.
 */
export function toolLimitsFor(contextWindow: number, maxTokens = 0): ToolLimits {
	const room = Math.max(0, contextWindow - maxTokens);
	const maxBytes = Math.min(MAX_OUTPUT_BYTES, Math.max(MIN_OUTPUT_BYTES, Math.floor(room * 0.2 * 3)));
	return { maxLines: 2000, maxBytes };
}
