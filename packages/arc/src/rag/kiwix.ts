import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unescapeHtml } from "../tools/web-search.ts";
import { topicWords } from "./article.ts";

/** models.yml `rag:`: where the `.zim` archives are, and the kiwix-serve that opens them. */
export interface RagConfig {
	folder: string;
	/** Default: `kiwix-serve` on PATH. */
	kiwixServe: string;
}

export interface SearchHit {
	title: string;
	/** The archive's own title, such as "Wikipedia in simple English". */
	book: string;
	/** `<archive>/<path>`: what the model passes back to read the article. */
	article: string;
	snippet: string;
}

export interface SearchResults {
	total: number;
	hits: SearchHit[];
}

/** What `kb_search` needs. An interface so tests can stand in for kiwix-serve. */
export interface KnowledgeBase {
	search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResults>;
	/** The article's HTML, or undefined when the archive has no such article. */
	article(id: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface KiwixKnowledgeBaseOptions {
	/** Receives kiwix-serve's output. */
	logFile: string;
	fetch?: typeof fetch;
	readyTimeoutMs?: number;
}

/** Most title lookups per archive for one search: the whole query and its first word pairs. */
const MAX_TITLE_PHRASES = 5;

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

function tagText(xml: string, tag: string): string {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? unescapeHtml(match[1].replace(/<[^>]+>/g, "")).trim() : "";
}

/**
 * Parse kiwix-serve's `/search?format=xml` reply. The snippet's `<b>` marks arrive escaped, so tags are stripped
 * after unescaping.
 */
export function parseSearchXml(xml: string): SearchResults {
	const total = Number(/<opensearch:totalResults>(\d+)</.exec(xml)?.[1] ?? 0);
	const hits: SearchHit[] = [];
	for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const link = tagText(item, "link");
		const bookBlock = /<book>([\s\S]*?)<\/book>/.exec(item)?.[1] ?? "";
		const snippet = unescapeHtml(tagText(item, "description"))
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.replace(/^\.\.\.|\.\.\.+$/g, "")
			.trim();
		hits.push({
			title: tagText(item.replace(/<book>[\s\S]*?<\/book>/, ""), "title"),
			book: tagText(bookBlock, "title"),
			article: link.replace(/^\/content\//, ""),
			snippet,
		});
	}
	return { total, hits };
}

/** The archives kiwix-serve lists in `/catalog/v2/entries`: name to title. */
export function parseCatalog(xml: string): Map<string, string> {
	const books = new Map<string, string>();
	for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const name = /href="\/content\/([^"]+)"/.exec(entry)?.[1];
		if (name) books.set(name, tagText(entry, "title") || name);
	}
	return books;
}

/**
 * An article id as the model may write it: `<archive>/<path>`, or with `/content/`, or as a full kiwix URL. Spaces
 * become underscores, as in the archive's own paths.
 */
export function normalizeArticleId(id: string): string {
	let cleaned = id.trim();
	try {
		if (/^https?:\/\//.test(cleaned)) cleaned = new URL(cleaned).pathname;
	} catch {}
	cleaned = cleaned.replace(/^\/+/, "").replace(/^content\//, "");
	try {
		cleaned = decodeURIComponent(cleaned);
	} catch {}
	return cleaned.replace(/ /g, "_");
}

/**
 * The `.zim` archives in a folder, served by one kiwix-serve started on first use. Search combines kiwix's full-text
 * ranking with title matches: full text alone ranks *Caribbean Sea* above *Atlantic Ocean* for "atlantic ocean
 * depth", while a title match finds the article the question is about.
 */
export class KiwixKnowledgeBase implements KnowledgeBase {
	private readonly config: RagConfig;
	private readonly logFile: string;
	private readonly fetchFn: typeof fetch;
	private readonly readyTimeoutMs: number;
	private child: ChildProcess | undefined;
	private starting: Promise<string> | undefined;
	/** Archive name (as in `/content/<name>`) to its title, from the catalog. */
	private books: Map<string, string> | undefined;

	constructor(config: RagConfig, options: KiwixKnowledgeBaseOptions) {
		this.config = config;
		this.logFile = options.logFile;
		this.fetchFn = options.fetch ?? fetch;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
	}

	/** The archive files, or an error naming the folder when it has none. */
	archives(): string[] {
		let names: string[];
		try {
			names = readdirSync(this.config.folder);
		} catch {
			throw new Error(`The knowledge base folder ${this.config.folder} does not exist.`);
		}
		const zims = names.filter((name) => name.toLowerCase().endsWith(".zim")).sort();
		if (zims.length === 0) throw new Error(`${this.config.folder} holds no .zim archives.`);
		return zims;
	}

	/** kiwix-serve's origin, starting it on first use. */
	start(): Promise<string> {
		this.starting ??= this.launch().catch((error: unknown) => {
			this.starting = undefined;
			throw error;
		});
		return this.starting;
	}

	/** Stop kiwix-serve. The next search starts it again. */
	stop(): void {
		this.child?.kill("SIGTERM");
		this.child = undefined;
		this.starting = undefined;
		this.books = undefined;
	}

	private async launch(): Promise<string> {
		const zims = this.archives().map((name) => join(this.config.folder, name));
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		mkdirSync(dirname(this.logFile), { recursive: true });
		const fd = openSync(this.logFile, "a");
		let logStart = 0;
		let spawnError: Error | undefined;
		let child: ChildProcess;
		try {
			writeSync(fd, `\n=== ${new Date().toISOString()} ${this.config.kiwixServe} on port ${port}\n`);
			logStart = fstatSync(fd).size;
			child = spawn(this.config.kiwixServe, ["--address", "127.0.0.1", "--port", String(port), ...zims], {
				stdio: ["ignore", fd, fd],
			});
		} finally {
			closeSync(fd);
		}
		child.once("error", (error) => {
			spawnError = error;
		});
		// Arc exits without waiting for it; stop() and the owner's exit handler end it.
		child.unref();
		this.child = child;

		const deadline = Date.now() + this.readyTimeoutMs;
		while (Date.now() < deadline) {
			if (spawnError) {
				this.child = undefined;
				const missing = (spawnError as NodeJS.ErrnoException).code === "ENOENT";
				throw new Error(
					missing
						? `${this.config.kiwixServe} was not found. Install kiwix-tools, or set rag.kiwixServe in models.yml.`
						: `kiwix-serve failed to start: ${spawnError.message}`,
				);
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				this.child = undefined;
				const output = readFileSync(this.logFile).subarray(logStart).toString("utf8").trim();
				throw new Error(`kiwix-serve exited while starting${output ? `: ${output.slice(-300)}` : "."}`);
			}
			try {
				const response = await this.fetchFn(`${origin}/catalog/v2/entries?count=1000`);
				if (response.ok) {
					this.books = parseCatalog(await response.text());
					return origin;
				}
			} catch {}
			await delay(200);
		}
		this.stop();
		throw new Error(`kiwix-serve did not answer within ${Math.round(this.readyTimeoutMs / 1000)}s.`);
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResults> {
		const origin = await this.start();
		const params = new URLSearchParams({ pattern: query, format: "xml", pageLength: String(limit) });
		const [fullText, titles] = await Promise.all([
			this.fetchFn(`${origin}/search?${params}`, { signal }).then(async (response) =>
				response.ok ? parseSearchXml(await response.text()) : { total: 0, hits: [] },
			),
			this.titleMatches(origin, query, signal),
		]);
		const seen = new Set(titles.map((hit) => hit.article));
		const hits = [...titles, ...fullText.hits.filter((hit) => !seen.has(hit.article))].slice(0, limit);
		return { total: Math.max(fullText.total, hits.length), hits };
	}

	/**
	 * Articles whose title is made only of the query's words, from every archive's title index. Titles are looked
	 * up for the whole query and for each pair of neighboring words, since a question rarely starts with a title:
	 * "deepest point of the atlantic ocean" reaches *Atlantic Ocean* through "atlantic ocean". A title covering more
	 * of the query ranks first, so *Atlantic Ocean* beats *Ocean*; *Atlantic City* never matches.
	 */
	private async titleMatches(origin: string, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
		const content = topicWords(query);
		const wanted = new Set(content);
		if (wanted.size === 0) return [];
		const phrases = new Set([content.join(" ")]);
		for (let i = 0; i + 1 < content.length && phrases.size < MAX_TITLE_PHRASES; i++) {
			phrases.add(`${content[i]} ${content[i + 1]}`);
		}
		const lookups = [...(this.books ?? new Map<string, string>())].flatMap(([book, bookTitle]) =>
			[...phrases].map(async (term) => {
				const params = new URLSearchParams({ content: book, term, count: "3" });
				try {
					const response = await this.fetchFn(`${origin}/suggest?${params}`, { signal });
					if (!response.ok) return [];
					const entries = (await response.json()) as { value?: string; kind?: string; path?: string }[];
					return entries.flatMap((entry) => {
						if (entry.kind !== "path" || !entry.path || !entry.value) return [];
						const titleWords = topicWords(entry.value);
						if (titleWords.length === 0 || !titleWords.every((word) => wanted.has(word))) return [];
						return [
							{
								title: entry.value,
								book: bookTitle,
								article: `${book}/${entry.path}`,
								snippet: "",
								covers: titleWords.length,
							},
						];
					});
				} catch {
					return [];
				}
			}),
		);
		const seen = new Set<string>();
		return (await Promise.all(lookups))
			.flat()
			.sort((a, b) => b.covers - a.covers || a.title.length - b.title.length)
			.filter((hit) => !seen.has(hit.article) && seen.add(hit.article))
			.slice(0, 2)
			.map(({ covers: _, ...hit }) => hit);
	}

	async article(id: string, signal?: AbortSignal): Promise<string | undefined> {
		const origin = await this.start();
		const path = normalizeArticleId(id)
			.split("/")
			.map((part) => encodeURIComponent(part))
			.join("/");
		const response = await this.fetchFn(`${origin}/content/${path}`, { signal });
		if (!response.ok) return undefined;
		return response.text();
	}
}
