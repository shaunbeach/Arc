import type { CompactionState, HistoryEntry, JevAsker, JevAskResult, JevQuestion, JevQuestions } from "./types.ts";

/** Tokens the grammar lets one answer take (`"result_t12": { "noul": 1 },`), with room to spare. */
const TOKENS_PER_ANSWER = 16;

/**
 * Builds a strict GBNF grammar constraining llama.cpp to output valid JSON
 * with exact question keys and binary scores (0 or 1).
 * Uses character class ["] to avoid quote-escaping ambiguity in llama.cpp's GBNF parser.
 */
export function buildJevGBNF(questionKeys: readonly string[]): string {
	if (questionKeys.length === 0) {
		return 'root ::= "{" ws ["] "answers" ["] ws ":" ws "{" ws "}" ws "}" ws\nws ::= [ \\t\\n\\r]*';
	}

	const entryRules = questionKeys.map((key, i) => `entry_${i} ::= ["] "${key}" ["] ws ":" ws answer`);
	const entriesSequence = questionKeys.map((_, i) => `entry_${i}`).join(' ws "," ws ');

	return [
		'root ::= "{" ws ["] "answers" ["] ws ":" ws "{" ws entries ws "}" ws "}" ws',
		`entries ::= ${entriesSequence}`,
		...entryRules,
		'answer ::= "{" ws ["] "noul" ["] ws ":" ws score ws "}"',
		'score ::= "0" | "1" | "0.0" | "1.0"',
		"ws ::= [ \\t\\n\\r]*",
	].join("\n");
}

/** One history entry as the evaluator reads it. The compaction budget measures entries with this. */
export function formatHistoryEntry(entry: HistoryEntry): string {
	const toolDetails = (entry.tool_calls ?? [])
		.map((tc) => `\n    -> Tool [${tc.id}] ${tc.tool}(${tc.input}): ${tc.result}`)
		.join("");
	const textPreview = entry.text ? `\n    Message: ${entry.text}` : "";
	return `[Turn ${entry.i}] ${entry.role}:${textPreview}${toolDetails}`;
}

export function formatQuestion(key: string, question: JevQuestion): string {
	return `- ${key}: ${question.instructions}`;
}

export function formatCompactionPrompt(
	state: CompactionState,
	questions: JevQuestions,
): { system: string; user: string } {
	const goal = state.goal || "(infer goal from context)";
	const context = state.context || "";

	const historyLines = state.history.map(formatHistoryEntry).join("\n\n");

	const questionLines = Object.entries(questions)
		.map(([key, q]) => formatQuestion(key, q))
		.join("\n");

	const system = `You are a precision context compaction evaluator for an AI agent.
Your mission is to keep conversation history lean and relevant by deciding which previous tool calls and results are still needed, and which can be pruned.

Scoring Criteria:
- Score 1 (Keep): The tool call or output contains essential context, active code definitions, unresolved errors, or decisions crucial for the current goal.
- Score 0 (Drop): The tool call or output is stale, an intermediate file listing/search, routine confirmation, repetitive data, or already superseded by newer actions.

Respond strictly with valid JSON conforming to:
{
  "answers": {
    "question_key": { "noul": 0 or 1 }
  }
}`;

	const user = `Task Goal:
${goal}
${context ? `\nAdditional Context:\n${context}` : ""}

Recent Conversation State:
${historyLines}

Questions to evaluate:
${questionLines}

Output a score (1 = keep, 0 = drop) for every question key inside the JSON "answers" dictionary.`;

	return { system, user };
}

export interface LocalLlamaJevAskerOptions {
	llamaUrl?: string;
	timeoutMs?: number;
}

export class LocalLlamaJevAsker implements JevAsker {
	private readonly llamaUrl: string;
	private readonly timeoutMs: number;

	constructor(options: LocalLlamaJevAskerOptions = {}) {
		this.llamaUrl = (options.llamaUrl ?? process.env.LLAMA_ENDPOINT ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
		// A request near half the context window can take a local model a minute or more to read; esc cancels sooner.
		this.timeoutMs = options.timeoutMs ?? 180_000;
	}

	async ask(state: CompactionState, questions: JevQuestions, signal?: AbortSignal): Promise<JevAskResult> {
		const questionKeys = Object.keys(questions);
		if (questionKeys.length === 0) {
			return { answers: {} };
		}

		const grammar = buildJevGBNF(questionKeys);
		const { system, user } = formatCompactionPrompt(state, questions);
		const chatEndpoint = `${this.llamaUrl}/v1/chat/completions`;
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const maxTokens = 64 + questionKeys.length * TOKENS_PER_ANSWER;

		try {
			let rawContent = "";
			const res = await fetch(chatEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					grammar,
					temperature: 0.0,
					max_tokens: maxTokens,
				}),
				signal: requestSignal,
			});

			if (res.ok) {
				const data = (await res.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				rawContent = data.choices?.[0]?.message?.content ?? "";
			} else {
				// Retry with response_format: { type: "json_object" } if llama-server failed on the grammar
				const retryRes = await fetch(chatEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messages: [
							{ role: "system", content: system },
							{ role: "user", content: user },
						],
						response_format: { type: "json_object" },
						temperature: 0.0,
						max_tokens: maxTokens,
					}),
					signal: requestSignal,
				});

				if (!retryRes.ok) {
					const errText = await retryRes.text();
					throw new Error(`llama-server returned HTTP ${retryRes.status}: ${errText.slice(0, 300)}`);
				}

				const data = (await retryRes.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				rawContent = data.choices?.[0]?.message?.content ?? "";
			}

			const parsed = JSON.parse(rawContent) as {
				answers?: Record<string, { noul?: number } | number>;
			};

			if (!parsed || typeof parsed !== "object" || !parsed.answers) {
				throw new Error(`Invalid response structure from local evaluator: ${rawContent}`);
			}

			const normalizedAnswers: Record<string, { noul: number; type: "noul" }> = {};
			for (const key of questionKeys) {
				const raw = parsed.answers[key];
				const num = typeof raw === "object" && raw !== null ? Number(raw.noul) : Number(raw);
				normalizedAnswers[key] = {
					type: "noul",
					noul: Number.isFinite(num) ? num : 1.0,
				};
			}

			return {
				model: "local-llama-gbnf",
				answers: normalizedAnswers,
			};
		} catch (error) {
			if (timeout.aborted && !signal?.aborted) {
				throw new Error(`the evaluator did not answer within ${Math.round(this.timeoutMs / 1000)}s`);
			}
			throw error;
		}
	}
}
