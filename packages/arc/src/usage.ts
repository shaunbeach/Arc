import type { Message } from "./llm/types.ts";

/** Tokens a run of requests used, as a hosted provider would bill them. */
export interface TokenUsage {
	requests: number;
	/** Every prompt token sent, counted again with each request, cached or not. */
	input: number;
	/** The part of `input` llama.cpp reused from its cache instead of processing again. */
	cached: number;
	/** Generated tokens, reasoning included. */
	output: number;
}

export const NO_USAGE: TokenUsage = { requests: 0, input: 0, cached: 0, output: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		requests: a.requests + b.requests,
		input: a.input + b.input,
		cached: a.cached + b.cached,
		output: a.output + b.output,
	};
}

/** What the replies in a transcript used, from the usage llama-server reported with each one. */
export function tallyUsage(messages: readonly Message[]): TokenUsage {
	let usage = NO_USAGE;
	for (const message of messages) {
		if (message.role !== "assistant" || message.usage.promptTokens === 0) continue;
		const { promptTokens, cachedTokens, completionTokens } = message.usage;
		usage = addUsage(usage, { requests: 1, input: promptTokens, cached: cachedTokens, output: completionTokens });
	}
	return usage;
}

/** `731,163 in (672,051 cached, 59,112 new) · 6,716 out · 59 requests` */
export function formatUsage(usage: TokenUsage): string {
	const n = (value: number) => value.toLocaleString("en-US");
	const requests = `${n(usage.requests)} request${usage.requests === 1 ? "" : "s"}`;
	return `${n(usage.input)} in (${n(usage.cached)} cached, ${n(usage.input - usage.cached)} new) · ${n(usage.output)} out · ${requests}`;
}
