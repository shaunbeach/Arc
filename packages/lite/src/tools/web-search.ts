import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { networkTimeoutMs } from "./network.ts";
import type { CodingToolOptions } from "./options.ts";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Integer({ description: "Max results (1-10)" })),
});

function searchTimeoutMs(): number {
	return networkTimeoutMs(process.env.PI_WEB_TIMEOUT_MS ?? process.env.DSH_WEB_TIMEOUT_MS, 20_000);
}

function searchSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
};

/**
 * Strips tags and decodes HTML entities. Each entity is decoded once, in a single pass, so `&amp;lt;` stays the text
 * `&lt;`; numeric entities cover the whole Unicode range. Unknown or invalid entities are left as written.
 */
export function unescapeHtml(str: string): string {
	return str
		.replace(/<[^>]+>/g, "")
		.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, name: string) => {
			if (name[0] !== "#") return NAMED_ENTITIES[name] ?? entity;
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
			return valid ? String.fromCodePoint(code) : entity;
		})
		.trim();
}

export function unwrapDdgUrl(rawUrl: string): string {
	try {
		const full = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
		const parsed = new URL(full, "https://duckduckgo.com");
		const uddg = parsed.searchParams.get("uddg");
		if (uddg) return decodeURIComponent(uddg);
		return full;
	} catch {
		return rawUrl;
	}
}

export function parseDuckDuckGoHtml(html: string, limit = 5): SearchResult[] {
	const results: SearchResult[] = [];
	const resultRegex =
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

	let match: RegExpExecArray | null = resultRegex.exec(html);
	while (match !== null) {
		const rawUrl = match[1];
		const rawTitle = match[2];
		const rawSnippet = match[3];

		const url = unwrapDdgUrl(rawUrl);
		const title = unescapeHtml(rawTitle);
		const snippet = unescapeHtml(rawSnippet);

		if (url && title && !url.includes("duckduckgo.com/y.js")) {
			results.push({ title, url, snippet });
			if (results.length >= limit) break;
		}
		match = resultRegex.exec(html);
	}

	if (results.length === 0) {
		const titleRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
		let titleMatch: RegExpExecArray | null = titleRegex.exec(html);
		while (titleMatch !== null) {
			const url = unwrapDdgUrl(titleMatch[1]);
			const title = unescapeHtml(titleMatch[2]);
			if (url && title && !url.includes("duckduckgo.com/y.js")) {
				results.push({ title, url, snippet: "" });
				if (results.length >= limit) break;
			}
			titleMatch = titleRegex.exec(html);
		}
	}

	return results;
}

export function isBlockedSearchPage(status: number, html: string): boolean {
	if (/class="[^"]*result__a/.test(html)) return false;
	return status === 202 || /anomaly|unusual traffic|captcha|blocked/i.test(html);
}

async function fetchDuckDuckGoHtml(
	query: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ status: number; html: string }> {
	const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(endpoint, {
		method: "GET",
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: searchSignal(timeoutMs, signal),
	});

	if (!res.ok) {
		throw new Error(`DuckDuckGo search failed with status ${res.status} ${res.statusText}`);
	}

	return { status: res.status, html: await res.text() };
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const timeoutMs = searchTimeoutMs();
	let attempt = await fetchDuckDuckGoHtml(query, timeoutMs, signal);

	if (isBlockedSearchPage(attempt.status, attempt.html)) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		signal?.throwIfAborted();
		attempt = await fetchDuckDuckGoHtml(query, timeoutMs, signal);
	}

	if (isBlockedSearchPage(attempt.status, attempt.html)) {
		throw new Error(
			"DuckDuckGo is rate-limiting this machine. Retry shortly, set TAVILY_API_KEY or BRAVE_API_KEY, or fetch a known URL with web_fetch.",
		);
	}

	return parseDuckDuckGoHtml(attempt.html, limit);
}

interface TavilyResponse {
	results?: { title?: string; url?: string; content?: string }[];
}

async function searchTavily(
	apiKey: string,
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const timeoutMs = searchTimeoutMs();
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ query, max_results: limit }),
		signal: searchSignal(timeoutMs, signal),
	});
	if (res.status === 401) {
		throw new Error("Tavily rejected TAVILY_API_KEY. Check the key, or unset it to fall back to DuckDuckGo.");
	}
	if (!res.ok) throw new Error(`Tavily search failed (${res.status})`);
	const data = (await res.json()) as TavilyResponse;
	return (data.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

interface BraveResponse {
	web?: { results?: { title?: string; url?: string; description?: string }[] };
}

async function searchBrave(
	apiKey: string,
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const timeoutMs = searchTimeoutMs();
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
	const res = await fetch(url, {
		headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
		signal: searchSignal(timeoutMs, signal),
	});
	if (!res.ok) throw new Error(`Brave search failed (${res.status})`);
	const data = (await res.json()) as BraveResponse;
	return (data.web?.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

export function createWebSearchTool(_options?: CodingToolOptions): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "search",
		description: "Search the web. Returns titles, URLs, and snippets.",
		parameters: webSearchSchema,
		async execute(_toolCallId, { query, limit }, signal, onUpdate) {
			const q = query.trim();
			if (!q) throw new Error("Search query is required.");

			const maxResults = Math.min(Math.max(limit ?? 5, 1), 10);
			onUpdate?.({ content: [{ type: "text", text: `Searching web for: "${q}"…` }] });

			let results: SearchResult[];
			if (process.env.TAVILY_API_KEY) {
				results = await searchTavily(process.env.TAVILY_API_KEY, q, maxResults, signal);
			} else if (process.env.BRAVE_API_KEY) {
				results = await searchBrave(process.env.BRAVE_API_KEY, q, maxResults, signal);
			} else {
				results = await searchDuckDuckGo(q, maxResults, signal);
			}

			if (results.length === 0) {
				return { content: [{ type: "text", text: `No web results found for "${q}".` }] };
			}

			const formatted = results
				.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet || "No snippet available."}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: `Web search results for "${q}":\n\n${formatted}` }],
			};
		},
	};
}
