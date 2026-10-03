import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
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
	/** The shelves searched, such as "python"; undefined when the search covered every archive. */
	shelf?: string;
	/** The shelves that had no results, so the search went on to every archive. */
	emptyShelf?: string;
}

/** A group of archives from the folder's `shelves.yml`, which maps questions to the archives that answer them. */
export interface Shelf {
	name: string;
	/** Catalog names: the archive's file name without its date, such as `devdocs_en_python`. */
	books: string[];
	/** Lowercase words or phrases that route a query here. The shelf's name is one too. */
	keywords: string[];
}

/** The map's file name, in the folder of archives. */
export const SHELVES_FILE = "shelves.yml";

/** What `kb_search` needs. An interface so tests can stand in for kiwix-serve. */
export interface KnowledgeBase {
	/** The shelves a search can name. Fixed for the session, since the tool definition lists them. */
	readonly shelves?: readonly Shelf[];
	search(query: string, limit: number, signal?: AbortSignal, shelf?: string): Promise<SearchResults>;
	/** The article's HTML, or undefined when the archive has no such article. */
	article(id: string, signal?: AbortSignal): Promise<string | undefined>;
	/** The full id of an article named by its title or without its archive, or undefined when none matches. */
	resolveArticle?(id: string, query: string, signal?: AbortSignal, shelf?: string): Promise<string | undefined>;
}

export interface KiwixKnowledgeBaseOptions {
	/** Receives kiwix-serve's output. */
	logFile: string;
	fetch?: typeof fetch;
	readyTimeoutMs?: number;
}

/** A title as the model may write it: any case, `_` for space. */
function titleKey(title: string): string {
	return title.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
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

/** An archive kiwix-serve lists in `/catalog/v2/entries`. */
export interface CatalogBook {
	/** As in `/content/<content>` and the search filter: the file name, date included. */
	content: string;
	/** The archive's own name, without the date: what `shelves.yml` uses. */
	name: string;
	title: string;
}

export function parseCatalog(xml: string): CatalogBook[] {
	const books: CatalogBook[] = [];
	for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const content = /href="\/content\/([^"]+)"/.exec(entry)?.[1];
		if (!content) continue;
		// The entry's <author> and <publisher> hold <name> too; the archive's own comes first.
		const name = tagText(entry.replace(/<(author|publisher)>[\s\S]*?<\/\1>/g, ""), "name") || content;
		books.push({ content, name, title: tagText(entry, "title") || content });
	}
	return books;
}

function stringList(value: unknown, where: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" || typeof item === "number")) {
		throw new Error(`${where} must be a list of names.`);
	}
	return value.map((item) => String(item).trim()).filter(Boolean);
}

/** Parse `shelves.yml`: `shelves:` maps each shelf's name to its `books` and `keywords`. Anything else is ignored. */
export function parseShelves(text: string): Shelf[] {
	const root: unknown = parseYaml(text);
	const shelves = (root as { shelves?: unknown } | null)?.shelves;
	if (typeof shelves !== "object" || shelves === null || Array.isArray(shelves)) {
		throw new Error("needs a `shelves:` mapping of shelf names.");
	}
	return Object.entries(shelves).map(([name, entry]) => {
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
			throw new Error(`shelf "${name}": use lowercase letters, digits, - and _.`);
		}
		const fields = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
		const books = stringList(fields.books, `shelves.${name}.books`);
		if (books.length === 0) throw new Error(`shelves.${name}.books names no archives.`);
		const keywords = stringList(fields.keywords, `shelves.${name}.keywords`).map((word) => word.toLowerCase());
		return { name, books, keywords: [...new Set([name, ...keywords])] };
	});
}

/** The folder's shelves, or none and why when its `shelves.yml` cannot be read. No file means no shelves. */
export function loadShelves(folder: string): { shelves: Shelf[]; error?: string } {
	const file = join(folder, SHELVES_FILE);
	if (!existsSync(file)) return { shelves: [] };
	try {
		return { shelves: parseShelves(readFileSync(file, "utf8")) };
	} catch (error) {
		return { shelves: [], error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * The shelves whose keywords a query mentions most. Words keep the characters of names like `c++`, `nn.module`, and
 * `async/await`; `std::vector` splits at the colons. A phrase keyword matches whole words in order.
 */
export function routeShelves(shelves: readonly Shelf[], query: string): Shelf[] {
	const words = (query.toLowerCase().match(/[a-z0-9][a-z0-9+#._/-]*/g) ?? []).map((word) =>
		word.replace(/[._/-]+$/, ""),
	);
	const wordSet = new Set(words);
	const spaced = ` ${words.join(" ")} `;
	let best = 0;
	let picked: Shelf[] = [];
	for (const shelf of shelves) {
		const score = shelf.keywords.filter((keyword) =>
			keyword.includes(" ") ? spaced.includes(` ${keyword} `) : wordSet.has(keyword),
		).length;
		if (score > best) {
			best = score;
			picked = [shelf];
		} else if (score === best && score > 0) {
			picked.push(shelf);
		}
	}
	return picked;
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
	/** The archives kiwix-serve opened, from its catalog. */
	private books: CatalogBook[] | undefined;
	readonly shelves: readonly Shelf[];
	/** Why `shelves.yml` could not be read, if it could not. */
	readonly shelfError: string | undefined;

	constructor(config: RagConfig, options: KiwixKnowledgeBaseOptions) {
		this.config = config;
		this.logFile = options.logFile;
		this.fetchFn = options.fetch ?? fetch;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
		// Read once: the shelf names are part of kb_search's definition, which must not change within a session.
		const { shelves, error } = loadShelves(config.folder);
		this.shelves = shelves;
		this.shelfError = error;
	}

	/** Shelf books kiwix-serve did not open, as `shelf/book`: a misspelled name, or an archive since removed. */
	async missingShelfBooks(): Promise<string[]> {
		await this.start();
		const names = new Set((this.books ?? []).map((book) => book.name));
		return this.shelves.flatMap((shelf) =>
			shelf.books.filter((book) => !names.has(book)).map((book) => `${shelf.name}/${book}`),
		);
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

	/**
	 * Search the named shelf, or the shelves the query's keywords point to, or else every archive. A shelf with no
	 * results falls back to every archive, so a wrong guess costs a search, not the answer.
	 */
	async search(query: string, limit: number, signal?: AbortSignal, shelf?: string): Promise<SearchResults> {
		const origin = await this.start();
		const shelves = this.shelvesFor(query, shelf);
		const names = new Set(shelves.flatMap((candidate) => candidate.books));
		const books = (this.books ?? []).filter((book) => names.has(book.name));
		if (books.length > 0) {
			const label = shelves.map((candidate) => candidate.name).join(", ");
			const results = await this.searchBooks(origin, query, limit, books, signal);
			if (results.hits.length > 0) return { ...results, shelf: label };
			return { ...(await this.searchBooks(origin, query, limit, undefined, signal)), emptyShelf: label };
		}
		return this.searchBooks(origin, query, limit, undefined, signal);
	}

	/** The named shelf, or else the shelves the query's keywords point to; none means every archive. */
	private shelvesFor(query: string, shelf: string | undefined): Shelf[] {
		const named = this.shelves.find((candidate) => candidate.name === shelf?.trim().toLowerCase());
		return named ? [named] : routeShelves(this.shelves, query);
	}

	/** Full text and titles, in the given archives or (undefined) all of them. */
	private async searchBooks(
		origin: string,
		query: string,
		limit: number,
		books: CatalogBook[] | undefined,
		signal?: AbortSignal,
	): Promise<SearchResults> {
		const params = new URLSearchParams({ pattern: query, format: "xml", pageLength: String(limit) });
		for (const book of books ?? []) params.append("books.name", book.content);
		const [fullText, titles] = await Promise.all([
			this.fetchFn(`${origin}/search?${params}`, { signal }).then(async (response) =>
				response.ok ? parseSearchXml(await response.text()) : { total: 0, hits: [] },
			),
			this.titleMatches(origin, query, books ?? this.books ?? [], signal),
		]);
		const seen = new Set(titles.map((hit) => hit.article));
		const hits = [...titles, ...fullText.hits.filter((hit) => !seen.has(hit.article))].slice(0, limit);
		return { total: Math.max(fullText.total, hits.length), hits };
	}

	/**
	 * Articles whose title is made only of the query's words, from the given archives' title indexes. Titles are looked
	 * up for the whole query and for each pair of neighboring words, since a question rarely starts with a title:
	 * "deepest point of the atlantic ocean" reaches *Atlantic Ocean* through "atlantic ocean". A title covering more
	 * of the query ranks first, so *Atlantic Ocean* beats *Ocean*; *Atlantic City* never matches.
	 */
	private async titleMatches(
		origin: string,
		query: string,
		books: CatalogBook[],
		signal?: AbortSignal,
	): Promise<SearchHit[]> {
		const content = topicWords(query);
		const wanted = new Set(content);
		if (wanted.size === 0) return [];
		const phrases = new Set([content.join(" ")]);
		for (let i = 0; i + 1 < content.length && phrases.size < MAX_TITLE_PHRASES; i++) {
			phrases.add(`${content[i]} ${content[i + 1]}`);
		}
		const lookups = books.flatMap(({ content: book, title: bookTitle }) =>
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

	/**
	 * The full id of an article the model named the way small models do: by title (`Atlantic_Ocean`,
	 * `pandas.Series.groupby`), by a path without its archive, or with the archive's date left off
	 * (`devdocs_en_pandas/reference/frame`). A title must match exactly, ignoring case and `_` for space, so a near
	 * miss is reported rather than swapped for another article. A title is looked up only on the named shelf, or else
	 * the shelves the query points to, so "pandas" asked on the python shelf never opens Wikipedia's *Panda*.
	 */
	async resolveArticle(id: string, query: string, signal?: AbortSignal, shelf?: string): Promise<string | undefined> {
		const origin = await this.start();
		const books = this.books ?? [];
		const cleaned = normalizeArticleId(id);
		const slash = cleaned.indexOf("/");
		const prefix = slash > 0 ? cleaned.slice(0, slash) : "";
		const rest = cleaned.slice(slash + 1);
		const named = books.find((book) => book.content === prefix) ?? books.find((book) => book.name === prefix);
		if (named) {
			const full = `${named.content}/${rest}`;
			if (full !== cleaned && (await this.article(full, signal)) !== undefined) return full;
			return this.titleLookup(origin, [named], rest, signal);
		}
		const shelves = this.shelvesFor(query, shelf);
		const onShelves = new Set(shelves.flatMap((candidate) => candidate.books));
		const ordered = shelves.length > 0 ? books.filter((book) => onShelves.has(book.name)) : books;
		const lastPart = cleaned.slice(cleaned.lastIndexOf("/") + 1);
		return (
			(await this.titleLookup(origin, ordered, cleaned, signal)) ??
			(lastPart !== cleaned ? this.titleLookup(origin, ordered, lastPart, signal) : undefined)
		);
	}

	/** The id of the first article, in the order of `books`, whose title is exactly `title`. */
	private async titleLookup(
		origin: string,
		books: CatalogBook[],
		title: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const wanted = titleKey(title);
		if (!wanted) return undefined;
		const found = await Promise.all(
			books.map(async (book) => {
				const params = new URLSearchParams({ content: book.content, term: title.replace(/_/g, " "), count: "5" });
				try {
					const response = await this.fetchFn(`${origin}/suggest?${params}`, { signal });
					if (!response.ok) return undefined;
					const entries = (await response.json()) as { value?: string; kind?: string; path?: string }[];
					const entry = entries.find(
						(e) => e.kind === "path" && e.path && e.value && titleKey(e.value) === wanted,
					);
					return entry?.path ? `${book.content}/${entry.path}` : undefined;
				} catch {
					return undefined;
				}
			}),
		);
		return found.find((id) => id !== undefined);
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
