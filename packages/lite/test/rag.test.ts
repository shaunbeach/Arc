import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { articleText, selectPassages, topicWords } from "../src/rag/article.ts";
import {
	KiwixKnowledgeBase,
	type KnowledgeBase,
	normalizeArticleId,
	parseCatalog,
	parseSearchXml,
} from "../src/rag/kiwix.ts";
import { createKbSearchTool } from "../src/tools/kb-search.ts";
import { toolLimitsFor } from "../src/tools/options.ts";

/** Shaped like kiwix-serve 3.8's `/search?format=xml`, trimmed to one item. */
const SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <channel>
    <title>Search: pandas groupby</title>
    <opensearch:totalResults>182</opensearch:totalResults>
    <item>
      <title>pandas.DataFrame.groupby</title>
      <link>/content/devdocs_en_pandas_2026-07/reference/api/pandas.dataframe.groupby</link>
        <description>...Group DataFrame using a mapper &lt;b&gt;groupby&lt;/b&gt; &amp;amp; more......</description>
        <book>
          <title>pandas Docs</title>
        </book>
        <wordCount>609</wordCount>
    </item>
  </channel>
</rss>`;

const CATALOG_XML = `<feed>
  <entry>
    <title>PyTorch Docs</title>
    <link type="text/html" href="/content/devdocs_en_pytorch_2026-07" />
  </entry>
  <entry>
    <title>Wikipedia in simple English</title>
    <link type="text/html" href="/content/wikipedia_en-simple_all_nopic_2026-06" />
  </entry>
</feed>`;

describe("kiwix replies", () => {
	it("reads search results with plain-text snippets and article ids", () => {
		expect(parseSearchXml(SEARCH_XML)).toEqual({
			total: 182,
			hits: [
				{
					title: "pandas.DataFrame.groupby",
					book: "pandas Docs",
					article: "devdocs_en_pandas_2026-07/reference/api/pandas.dataframe.groupby",
					snippet: "Group DataFrame using a mapper groupby & more",
				},
			],
		});
		expect(parseSearchXml("<rss><opensearch:totalResults>0</opensearch:totalResults></rss>")).toEqual({
			total: 0,
			hits: [],
		});
	});

	it("maps each archive to its title", () => {
		expect([...parseCatalog(CATALOG_XML)]).toEqual([
			["devdocs_en_pytorch_2026-07", "PyTorch Docs"],
			["wikipedia_en-simple_all_nopic_2026-06", "Wikipedia in simple English"],
		]);
	});

	it("accepts an article id in the shapes a model writes it", () => {
		const id = "wikipedia_en_physics_nopic_2026-07/Quantum_entanglement";
		expect(normalizeArticleId(id)).toBe(id);
		expect(normalizeArticleId(`/content/${id}`)).toBe(id);
		expect(normalizeArticleId(`http://127.0.0.1:8290/content/${id}`)).toBe(id);
		expect(normalizeArticleId("wikipedia_en_physics_nopic_2026-07/Quantum entanglement")).toBe(id);
		expect(normalizeArticleId("wikipedia_en_physics_nopic_2026-07/Schr%C3%B6dinger_equation")).toBe(
			"wikipedia_en_physics_nopic_2026-07/Schrödinger_equation",
		);
	});

	it("keeps topic words only", () => {
		expect(topicWords("What is the deepest point of the Atlantic Ocean?")).toEqual([
			"deepest",
			"point",
			"atlantic",
			"ocean",
		]);
	});
});

describe("articleText", () => {
	it("keeps the prose and drops links, citation marks, sidebars, formulas' markup, and reference lists", () => {
		const html = `<html><head><title>Quantum entanglement</title></head><body>
			<table class="sidebar nomobile"><tr><td><table class="inner"><tr><td>Part of a series</td></tr></table></td></tr></table>
			<p>Entanglement links <a href="./Particle">particles</a> at a distance.<sup class="mw-ref reference"><a href="#cite_note-1">[1]</a></sup></p>
			<p>The state <math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle |\\Psi \\rangle }"><semantics><mi>Ψ</mi></semantics></math> evolves.</p>
			<h2 id="History">History</h2>
			<p>Einstein called it spooky.</p>
			<h2 id="References">References</h2>
			<p>A long list of sources.</p>
			<h3>Sources</h3>
			<p>More sources.</p>
		</body></html>`;
		const { title, text } = articleText(html);
		expect(title).toBe("Quantum entanglement");
		expect(text).toContain("Entanglement links particles at a distance.");
		expect(text).toContain("$|\\Psi \\rangle$ evolves");
		expect(text).toContain("## History\n\nEinstein called it spooky.");
		expect(text).not.toMatch(/Part of a series|\[1\]|\]\(|<math|Ψ/);
		// Reference lists go at the section level, in selectPassages.
		expect(selectPassages(text, "anything", 1_000_000)).toContain("A long list");
	});
});

describe("selectPassages", () => {
	const section = (heading: string, words: string, count: number) =>
		`## ${heading}\n\n${Array.from({ length: count }, (_, i) => `${words} paragraph ${i}.`).join("\n\n")}`;
	const article = [
		"The lead paragraph says what this is.",
		section("History", "Early days and old experiments with little detail", 30),
		section("Bell tests", "A Bell test checks the Bell inequality against local hidden variables", 6),
		section("Applications", "Cryptography and computing use it", 30),
		section("See also", "Bell test link", 5),
	].join("\n\n");

	it("returns an article that fits as it is", () => {
		expect(selectPassages("short text", "bell", 1000)).toBe("short text");
	});

	it("keeps the lead and the sections that match, and names the rest", () => {
		const text = selectPassages(article, "bell inequality", 1200);
		expect(text.length).toBeLessThan(1500);
		expect(text).toContain("The lead paragraph");
		expect(text).toContain("## Bell tests");
		expect(text).not.toContain("## History");
		expect(text).toContain("[Other sections: History; Applications.");
		// "See also" is a list of links, never worth the room.
		expect(text).not.toContain("See also");
	});

	it("reads from the top when no section mentions the query", () => {
		const text = selectPassages(article, "zebra", 1200);
		expect(text).toContain("The lead paragraph");
		expect(text).toContain("## History");
		expect(text).not.toContain("## Bell tests");
	});
});

describe("kb_search", () => {
	const kb: KnowledgeBase = {
		search: async (query) =>
			query === "none"
				? { total: 0, hits: [] }
				: {
						total: 40,
						hits: [
							{ title: "Atlantic Ocean", book: "Wikipedia", article: "wiki/Atlantic_Ocean", snippet: "" },
							{
								title: "Caribbean Sea",
								book: "Wikipedia",
								article: "wiki/Caribbean_Sea",
								snippet: "x".repeat(500),
							},
						],
					},
		article: async (id) =>
			id === "wiki/Atlantic_Ocean"
				? "<html><head><title>Atlantic Ocean</title></head><body><p>The deepest point is the Milwaukee Deep.</p></body></html>"
				: undefined,
	};
	const tool = createKbSearchTool(kb, toolLimitsFor(20_000, 8192));
	const run = async (args: { query: string; article?: string }) => {
		const result = await tool.execute("id", args);
		const [first] = result.content;
		return first.type === "text" ? first.text : "";
	};

	it("lists results with their article ids and short snippets", async () => {
		const text = await run({ query: "deepest point atlantic" });
		expect(text).toContain("(40 matches; showing 2)");
		expect(text).toContain("1. Atlantic Ocean (Wikipedia)\n   article: wiki/Atlantic_Ocean");
		expect(text).toContain(`${"x".repeat(200)}…`);
		expect(text).not.toContain("x".repeat(201));
		expect(await run({ query: "none" })).toBe('Nothing in the knowledge base matches "none".');
	});

	it("reads an article, and says when there is none", async () => {
		expect(await run({ query: "deepest", article: "/content/wiki/Atlantic Ocean" })).toBe(
			"Atlantic Ocean (wiki/Atlantic_Ocean):\n\nThe deepest point is the Milwaukee Deep.",
		);
		await expect(run({ query: "x", article: "wiki/Nowhere" })).rejects.toThrow('No article "wiki/Nowhere"');
		await expect(run({ query: "  " })).rejects.toThrow("query is required");
	});
});

describe("KiwixKnowledgeBase", () => {
	it("names the folder when it is missing or holds no archives", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lite-rag-"));
		const logFile = join(dir, "kiwix.log");
		const missing = new KiwixKnowledgeBase({ folder: join(dir, "nope"), kiwixServe: "kiwix-serve" }, { logFile });
		expect(() => missing.archives()).toThrow(`${join(dir, "nope")} does not exist`);
		mkdirSync(join(dir, "empty"));
		writeFileSync(join(dir, "empty", "notes.txt"), "");
		const empty = new KiwixKnowledgeBase({ folder: join(dir, "empty"), kiwixServe: "kiwix-serve" }, { logFile });
		expect(() => empty.archives()).toThrow("holds no .zim archives");
		writeFileSync(join(dir, "empty", "b.zim"), "");
		writeFileSync(join(dir, "empty", "a.ZIM"), "");
		expect(empty.archives()).toEqual(["a.ZIM", "b.zim"]);
	});

	it("says how to fix a missing kiwix-serve", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lite-rag-"));
		writeFileSync(join(dir, "a.zim"), "");
		const kb = new KiwixKnowledgeBase(
			{ folder: dir, kiwixServe: join(dir, "no-such-kiwix-serve") },
			{ logFile: join(dir, "kiwix.log") },
		);
		await expect(kb.search("x", 5)).rejects.toThrow("was not found. Install kiwix-tools");
	});
});
