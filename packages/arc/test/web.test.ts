import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.ts";
import type { LiteModel } from "../src/config/models.ts";
import { createCodingTools, networkTimeoutMs, toolLimitsFor } from "../src/tools/index.ts";
import { createWebFetchTool, htmlToMarkdown, isLocalAddress } from "../src/tools/web-fetch.ts";
import { isBlockedSearchPage, parseDuckDuckGoHtml, unescapeHtml, unwrapDdgUrl } from "../src/tools/web-search.ts";

const model: LiteModel = {
	name: "test-model",
	id: "m.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 12_288,
	maxTokens: 4096,
	modelPath: "/m/m.gguf",
	launchArgs: [],
	llamaServer: "llama-server",
};

describe("web_search tool", () => {
	it("unescapes HTML entities and strips inner tags", () => {
		const raw = "<b>Python 3.14</b> &amp; &quot;PEP 649&#x27;s&quot; deferred &lt;evaluation&gt; &copy; &#39;";
		expect(unescapeHtml(raw)).toBe("Python 3.14 & \"PEP 649's\" deferred <evaluation> © '");
	});

	it("decodes each entity once, across the whole Unicode range", () => {
		expect(unescapeHtml("write &amp;lt;br&amp;gt; literally")).toBe("write &lt;br&gt; literally");
		expect(unescapeHtml("emoji &#128512; &#x1F600;")).toBe("emoji 😀 😀");
		expect(unescapeHtml("bad &#99999999; &#xD800; &bogus; &amp")).toBe("bad &#99999999; &#xD800; &bogus; &amp");
	});

	it("decodes uddg query parameter from DuckDuckGo urls", () => {
		const ddgLink = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3.14%2Fwhatsnew&rut=123";
		expect(unwrapDdgUrl(ddgLink)).toBe("https://docs.python.org/3.14/whatsnew");
	});

	it("returns raw url when not a DuckDuckGo redirect", () => {
		expect(unwrapDdgUrl("https://example.com")).toBe("https://example.com");
	});

	it("parses DuckDuckGo HTML result blocks cleanly", () => {
		const mockHtml = `
			<div class="results">
				<div class="result results_links results_links_deep web-result ">
					<h2 class="result__title">
						<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanthropic.com%2Fnews%2Fclaude-3-7-sonnet">Claude 3.7 Sonnet &amp; Hybrid Reasoning</a>
					</h2>
					<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanthropic.com%2Fnews%2Fclaude-3-7-sonnet">
						Today we are announcing <b>Claude 3.7 Sonnet</b>, our most intelligent model to date...
					</a>
				</div>
				<div class="result results_links results_links_deep web-result ">
					<h2 class="result__title">
						<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3.14">What&#39;s New In Python 3.14</a>
					</h2>
					<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3.14">
						Python 3.14 includes deferred evaluation of annotations and new CLI features.
					</a>
				</div>
			</div>
		`;

		const results = parseDuckDuckGoHtml(mockHtml, 5);
		expect(results).toHaveLength(2);
		expect(results[0].title).toBe("Claude 3.7 Sonnet & Hybrid Reasoning");
		expect(results[0].url).toBe("https://anthropic.com/news/claude-3-7-sonnet");
		expect(results[0].snippet).toContain("Today we are announcing Claude 3.7 Sonnet");

		expect(results[1].title).toBe("What's New In Python 3.14");
		expect(results[1].url).toBe("https://docs.python.org/3.14");
		expect(results[1].snippet).toContain("Python 3.14 includes deferred evaluation");
	});

	it("detects blocked/rate-limited search pages", () => {
		const blockPage =
			'<html><head><link rel="canonical" href="https://duckduckgo.com/"></head><body>anomaly</body></html>';
		const resultsPage =
			'<a class="result__a" href="https://example.com">Title</a><a class="result__snippet">Snip</a>';

		expect(isBlockedSearchPage(202, blockPage)).toBe(true);
		expect(isBlockedSearchPage(200, resultsPage)).toBe(false);
		expect(isBlockedSearchPage(202, resultsPage)).toBe(false);
		expect(isBlockedSearchPage(200, "<html><body>No results for that query.</body></html>")).toBe(false);
	});
});

describe("web_fetch tool", () => {
	const fetchTool = createWebFetchTool();

	it("refuses non-http and non-https schemes", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi"]) {
			await expect(fetchTool.execute("call1", { url })).rejects.toThrow(
				"Only http: and https: protocols are supported.",
			);
		}
	});

	it("converts HTML to clean Markdown, stripping scripts and boilerplate", () => {
		const mockPageHtml = `
			<!DOCTYPE html>
			<html>
				<head><title>Docs</title><style>.hidden{display:none;}</style></head>
				<body>
					<header><nav><a href="/home">Home</a></nav></header>
					<main>
						<h1>Python 3.14 Features</h1>
						<p>Here is an introduction to deferred evaluation.</p>
						<h2>Code Example</h2>
						<pre><code class="python">def compute(x: int) -> int:
    return x * 2</code></pre>
						<p>Read more at <a href="https://peps.python.org/pep-0649/">PEP 649</a>.</p>
						<ul>
							<li>Item 1</li>
							<li>Item 2</li>
						</ul>
					</main>
					<footer><p>Copyright 2026</p></footer>
					<script>console.log('tracker');</script>
				</body>
			</html>
		`;

		const md = htmlToMarkdown(mockPageHtml, 5000);
		expect(md).not.toContain("<style");
		expect(md).not.toContain("<script");
		expect(md).not.toContain("tracker");
		expect(md).not.toContain("Home");
		expect(md).not.toContain("Copyright 2026");

		expect(md).toContain("# Python 3.14 Features");
		expect(md).toContain("## Code Example");
		expect(md).toContain("```\ndef compute(x: int) -> int:\n    return x * 2\n```");
		expect(md).toContain("[PEP 649](https://peps.python.org/pep-0649/)");
		expect(md).toContain("- Item 1");
	});

	it("keeps angle brackets in code verbatim", () => {
		const html = `<body>
			<pre><code><span class="k">#include</span> &lt;stdio.h&gt;

const xs: Array&lt;string&gt; = [];</code></pre>
			<p>Compare with <code>a &lt;b&gt; c</code> inline.</p>
		</body>`;
		const md = htmlToMarkdown(html);
		expect(md).toContain("```\n#include <stdio.h>\n\nconst xs: Array<string> = [];\n```");
		expect(md).toContain("`a <b> c`");
	});

	it("truncates content exceeding maxLength", () => {
		const text = `<p>${"A".repeat(2000)}</p>`;
		const md = htmlToMarkdown(text, 500);
		expect(md.length).toBeLessThan(600);
		expect(md).toContain("content truncated");
	});

	it("accepts snake_case max_length via prepareArguments", () => {
		const prepared = fetchTool.prepareArguments?.({ url: "https://example.com", max_length: 5000 });
		expect(prepared).toEqual({ url: "https://example.com", max_length: 5000, maxLength: 5000 });
	});
});

describe("network timeout helper", () => {
	it("parses valid timeouts and falls back gracefully", () => {
		expect(networkTimeoutMs("45000", 30_000)).toBe(45_000);
		expect(networkTimeoutMs(undefined, 30_000)).toBe(30_000);
		expect(networkTimeoutMs("not-a-number", 30_000)).toBe(30_000);
		expect(networkTimeoutMs("0", 30_000)).toBe(30_000);
		expect(networkTimeoutMs("-5", 30_000)).toBe(30_000);
	});
});

describe("interaction modes and tool filtering", () => {
	it("creates tools including web_search and web_fetch", () => {
		const tools = createCodingTools({ cwd: "/work", limits: toolLimitsFor(12_000), acceptsImages: false });
		const names = tools.map((t) => t.name);
		expect(names).toEqual(["read", "edit", "write", "bash", "web_search", "web_fetch"]);
	});

	it("offers kb_search only while rag is on, in every mode", () => {
		const knowledgeBase = { search: async () => ({ total: 0, hits: [] }), article: async () => undefined };
		const tools = createCodingTools({
			cwd: "/work",
			limits: toolLimitsFor(12_000),
			acceptsImages: false,
			knowledgeBase,
		});
		const agent = new Agent({ model, mode: "thinking", cwd: "/work", tools });
		expect(agent.activeTools.map((t) => t.name)).not.toContain("kb_search");
		expect(agent.systemPrompt).not.toContain("kb_search");

		agent.setRag(true);
		expect(agent.activeTools.map((t) => t.name)).toContain("kb_search");
		expect(agent.systemPrompt).toContain("kb_search");
		agent.setInteractionMode("plan");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["read", "web_search", "web_fetch", "kb_search"]);
		agent.setInteractionMode("chat");
		agent.setWeb(false);
		expect(agent.activeTools.map((t) => t.name)).toEqual(["kb_search"]);
		expect(agent.systemPrompt).not.toContain("no tools");
		expect(agent.systemPrompt).toContain("no web access");

		agent.setRag(false);
		expect(agent.activeTools).toEqual([]);
	});

	it("filters tools appropriately in plan and chat modes", () => {
		const tools = createCodingTools({ cwd: "/work", limits: toolLimitsFor(12_000), acceptsImages: false });
		const agent = new Agent({
			model,
			mode: "thinking",
			cwd: "/work",
			tools,
		});

		expect(agent.interactionMode).toBe("agent");
		expect(agent.activeTools.map((t) => t.name)).toEqual([
			"read",
			"edit",
			"write",
			"bash",
			"web_search",
			"web_fetch",
		]);

		agent.setInteractionMode("plan");
		expect(agent.interactionMode).toBe("plan");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["read", "web_search", "web_fetch"]);
		expect(agent.systemPrompt).toContain("expert AI planning assistant");

		agent.setInteractionMode("chat");
		expect(agent.interactionMode).toBe("chat");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
		expect(agent.systemPrompt).toContain("conversational assistant");

		// /web off takes the web tools away in every mode, and the prompt stops offering them.
		agent.setWeb(false);
		expect(agent.activeTools).toEqual([]);
		expect(agent.systemPrompt).toContain("no tools and no web access");
		agent.setInteractionMode("plan");
		expect(agent.activeTools.map((t) => t.name)).toEqual(["read"]);
		agent.setInteractionMode("chat");
		agent.setWeb(true);
		expect(agent.activeTools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);

		agent.setInteractionMode("agent");
		expect(agent.interactionMode).toBe("agent");
		expect(agent.activeTools.map((t) => t.name)).toEqual([
			"read",
			"edit",
			"write",
			"bash",
			"web_search",
			"web_fetch",
		]);
	});
});

describe("web_fetch", () => {
	/** A fetch stub serving `pages` by URL, recording each request. */
	function site(pages: Record<string, () => Response>) {
		const requested: string[] = [];
		const fetchFn = (async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			const page = pages[url];
			return page ? page() : new Response("missing", { status: 404, statusText: "Not Found" });
		}) as typeof fetch;
		return { fetchFn, requested };
	}
	const html = (body: string, headers: Record<string, string> = {}) =>
		new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html", ...headers } });
	const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
	const text = async (
		tool: ReturnType<typeof createWebFetchTool>,
		args: { url: string; start?: number; maxLength?: number },
	) => {
		const result = await tool.execute("c1", args);
		return (result.content[0] as { text: string }).text;
	};
	const publicDns = async () => ["93.184.216.34"];

	it("reaches local addresses when allowed, and refuses them, redirects included, when not", async () => {
		const { fetchFn, requested } = site({
			"http://localhost:3000/": () => html("<p>dev server</p>"),
			"https://public.example/": () => redirect("http://192.168.1.1/admin"),
			"https://rebind.example/": () => html("<p>never</p>"),
		});
		const allowed = createWebFetchTool({ allowLocalNetwork: () => true }, { fetch: fetchFn, lookup: publicDns });
		expect(await text(allowed, { url: "http://localhost:3000/" })).toContain("dev server");

		const lookup = async (host: string) => (host === "rebind.example" ? ["10.0.0.7"] : ["93.184.216.34"]);
		const blocked = createWebFetchTool({ allowLocalNetwork: () => false }, { fetch: fetchFn, lookup });
		for (const url of [
			"http://localhost:3000/",
			"http://127.0.0.1:8080/props",
			"http://[::1]/",
			"http://169.254.169.254/latest",
		]) {
			await expect(text(blocked, { url })).rejects.toThrow(
				"web_fetch only reaches public addresses in plan and chat modes",
			);
		}
		// A public page that redirects inward, and a name that resolves inward, are refused before any request.
		requested.length = 0;
		await expect(text(blocked, { url: "https://public.example/" })).rejects.toThrow("192.168.1.1 is local");
		await expect(text(blocked, { url: "https://rebind.example/" })).rejects.toThrow("rebind.example is local");
		expect(requested).toEqual(["https://public.example/"]);
	});

	it("classifies local and public addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"fd00::1",
			"fe80::1",
			"::ffff:127.0.0.1",
		]) {
			expect(isLocalAddress(address), address).toBe(true);
		}
		for (const address of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) {
			expect(isLocalAddress(address), address).toBe(false);
		}
	});

	it("saves binary files for the model's other tools, and returns JSON as it is", async () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
		const { fetchFn } = site({
			"https://docs.example/spec.pdf": () => new Response(pdf, { headers: { "content-type": "application/pdf" } }),
			"https://arxiv.example/pdf/1706.03762": () =>
				new Response(pdf, { headers: { "content-type": "application/pdf" } }),
			"https://api.example/data": () =>
				new Response('{"tags":["<b>","<i>"]}', { headers: { "content-type": "application/json" } }),
		});
		const tool = createWebFetchTool({}, { fetch: fetchFn, lookup: publicDns });

		const saved = await text(tool, { url: "https://docs.example/spec.pdf" });
		const path = /Saved it to (\S+):/.exec(saved)?.[1] ?? "";
		expect(saved).toContain("is application/pdf (10 B), not text.");
		expect(path).toMatch(/arc-fetch\/[0-9a-f]{8}-spec\.pdf$/);
		expect(new Uint8Array(readFileSync(path))).toEqual(pdf);
		rmSync(path);
		// A URL without an extension still saves as .pdf, so tools that go by extension recognize it.
		const named =
			/Saved it to (\S+):/.exec(await text(tool, { url: "https://arxiv.example/pdf/1706.03762" }))?.[1] ?? "";
		expect(named).toMatch(/-1706\.03762\.pdf$/);
		rmSync(named);

		expect(await text(tool, { url: "https://api.example/data" })).toBe(
			'Content from https://api.example/data:\n\n{"tags":["<b>","<i>"]}',
		);
	});

	it("reads long pages in parts, resolves links, and decodes the declared charset", async () => {
		const long = Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i} of the guide.</p>`).join("");
		const latin1 = new Uint8Array([...Buffer.from("<html><body><p>caf"), 0xe9, ...Buffer.from("</p></body></html>")]);
		const { fetchFn } = site({
			"https://docs.example/guide/intro": () => html(`<a href="../api/fetch">API</a> <a href='#top'>Top</a>${long}`),
			"https://old.example/": () =>
				new Response(latin1, { headers: { "content-type": "text/html; charset=iso-8859-1" } }),
		});
		const tool = createWebFetchTool({}, { fetch: fetchFn, lookup: publicDns });

		const first = await text(tool, { url: "https://docs.example/guide/intro", maxLength: 1000 });
		expect(first).toContain("[API](https://docs.example/api/fetch) Top");
		const next = /start: (\d+)/.exec(first)?.[1];
		expect(first).toMatch(/\[Characters 0-1000 of \d+\. Call web_fetch again with start: 1000 for more\.\]$/);
		const second = await text(tool, {
			url: "https://docs.example/guide/intro",
			start: Number(next),
			maxLength: 1000,
		});
		expect(second).toMatch(/Content from https:\/\/docs\.example\/guide\/intro:\n\n/);
		expect(second).toContain("[Characters 1000-2000 of");

		expect(await text(tool, { url: "https://old.example/" })).toContain("café");
	});
});
