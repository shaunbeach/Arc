export interface JevToolCall {
	/** Identifier used in Jev questions (`t1`, `t2`, ...). */
	id: string;
	toolCallId: string;
	tool: string;
	input: Record<string, unknown>;
	callIndex: number;
	resultIndex: number;
	resultChars: number;
	inputChars: number;
	isError: boolean;
	pinned: boolean;
}

export interface CallAnswer {
	/** Probability that the tool call itself is still relevant (0.0 to 1.0). */
	keepCall: number;
	/** Probability that the full tool result is needed verbatim (0.0 to 1.0). */
	keepResult: number;
}

export type CallAction = "keep" | "drop_result" | "drop_call";

export interface CallDecision extends CallAnswer {
	id: string;
	toolCallId: string;
	tool: string;
	action: CallAction;
	reason: "pinned" | "kept" | "result_dropped" | "call_dropped";
}

export interface HistoryToolCall {
	id: string;
	tool: string;
	input: string;
	result: string;
}

export interface HistoryEntry {
	i: number;
	role: string;
	text: string;
	tool_calls?: HistoryToolCall[];
}

export interface CompactionState {
	context: string;
	goal: string;
	history: HistoryEntry[];
}

export interface JevQuestion {
	type: "noul";
	instructions: string;
}

export type JevQuestions = Record<string, JevQuestion>;

export interface JevAskResult {
	model?: string;
	answers: Record<string, { noul?: number; type?: string } | number>;
}

export interface JevAsker {
	ask(state: CompactionState, questions: JevQuestions, signal?: AbortSignal): Promise<JevAskResult>;
}

export interface CompactOptions {
	goal?: string;
	keepThreshold?: number;
	preserveRecentSteps?: number;
	/** Most characters the evaluator request may take. History that does not fit, newest kept first, is left out. */
	maxRequestChars?: number;
	/** Calls not to ask about again: already compacted, or no longer sent. */
	exclude?: ReadonlySet<string>;
	/** Whether a message is still sent. Messages that are not are left out of the evaluator's history. */
	isSent?: (index: number) => boolean;
	signal?: AbortSignal;
}

/** Decisions only: callers apply them to what a request sends, never to the transcript. */
export interface CompactResult {
	decisions: CallDecision[];
	/** Calls the evaluator was asked about. The other candidates got heuristic decisions. */
	askedCalls: number;
	compactedCalls: number;
}
