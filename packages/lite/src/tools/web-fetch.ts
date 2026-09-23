import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { networkTimeoutMs } from "./network.ts";
import type { CodingToolOptions } from "./options.ts";
import { unescapeHtml } from "./web-search.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "Web page URL" }),
	maxLength: Type.Optional(Type.Integer({ description: "Max characters" })),
	start: Type.Optional(Type.Integer({ description: "Offset to continue from" })),
});

/** Most bytes of a text page read; pages come to the model in parts. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Most bytes of a binary file saved for the model. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function requestTimeoutMs(): number {
	return networkTimeoutMs(process.env.PI_WEB_TIMEOUT_MS ?? process.env.DSH_WEB_TIMEOUT_MS, 30_000);
}

function requestSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

/** The first `maxBytes` of the body, and whether there was more. */
async function readBytes(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
	if (!res.body) return { bytes: new Uint8Array(0), complete: true };
	const chunks: Uint8Array[] = [];
	let read = 0;
	let complete = false;
	const reader = res.body.getReader();
	try {
		while (read < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				complete = true;
				break;
			}
			chunks.push(value);
			read += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = Buffer.concat(chunks);
	return { bytes: bytes.subarray(0, Math.min(bytes.byteLength, maxBytes)), complete: complete && read <= maxBytes };
}

function ipv4Parts(address: string): number[] | undefined {
	const parts = address.split(".").map(Number);
	return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: undefined;
}

/** Loopback, private, link-local, carrier-grade NAT, unspecified, multicast, or reserved: not the public internet. */
export function isLocalAddress(address: string): boolean {
	const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
	const v4 = ipv4Parts(mapped ?? bare);
	if (v4) {
		const [a, b] = v4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		);
	}
	if (isIP(bare) !== 6) return false;
	return bare === "::" || bare === "::1" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) || bare.startsWith("ff");
}

export type LookupFunction = (hostname: string) => Promise<readonly string[]>;

const lookupAll: LookupFunction = async (hostname) =>
	(await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Throws when `url` names or resolves to a local address. */
async function assertPublic(url: URL, lookup: LookupFunction): Promise<void> {
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const refuse = () => {
		throw new Error(
			`web_fetch only reaches public addresses in plan and chat modes; ${url.host} is local. Switch to /agent to fetch it.`,
		);
	};
	if (host === "localhost" || host.endsWith(".localhost")) refuse();
	if (isIP(host)) {
		if (isLocalAddress(host)) refuse();
		return;
	}
	const addresses = await lookup(host);
	if (addresses.some(isLocalAddress)) refuse();
}

/** The charset a page declares, in its header or early in its HTML. */
function declaredCharset(contentType: string, head: Uint8Array): string | undefined {
	const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
	if (fromHeader) return fromHeader;
	const start = new TextDecoder("latin1").decode(head.subarray(0, 2048));
	return /<meta[^>]+charset=["']?([\w-]+)/i.exec(start)?.[1];
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

type Kind = "html" | "text" | "binary";

/** The kind a `Content-Type` names, or undefined when there is none and the body has to tell. */
function declaredKind(contentType: string): Kind | undefined {
	const type = contentType.split(";")[0].trim().toLowerCase();
	if (!type) return undefined;
	if (type === "text/html" || type === "application/xhtml+xml") return "html";
	if (
		type.startsWith("text/") ||
		/^application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|toml|x-sh|graphql)$/.test(type) ||
		/\+(json|xml)$/.test(type)
	) {
		return "text";
	}
	return "binary";
}

/** Without a type: text unless it holds a NUL byte, HTML if it opens like a page. */
function sniffKind(head: Uint8Array): Kind {
	if (head.subarray(0, 1024).includes(0)) return "binary";
	return /^\s*<(!doctype html|html|head|body)/i.test(new TextDecoder().decode(head.subarray(0, 256)))
		? "html"
		: "text";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extensions for common downloads, so tools that go by extension (read attaches images) recognize the file. */
const EXTENSIONS: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-gzip": ".gz",
	"application/x-tar": ".tar",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

/** Saves a binary download where the model's other tools can open it. */
function saveDownload(url: URL, bytes: Uint8Array, contentType: string): string {
	const dir = join(tmpdir(), "pi-lite-fetch");
	mkdirSync(dir, { recursive: true });
	let path = url.pathname;
	try {
		path = decodeURIComponent(path);
	} catch {}
	let name =
		basename(path)
			.replace(/[^\w.-]/g, "_")
			.slice(-80) || "download";
	const extension = EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()];
	if (extension && extname(name).toLowerCase() !== extension) name += extension;
	const file = join(dir, `${randomUUID().slice(0, 8)}-${name}`);
	writeFileSync(file, bytes);
	return file;
}

/** One part of `text`, with a note saying how to read the next one. */
export function pageOf(text: string, start: number, limit: number): string {
	if (start >= text.length && text.length > 0) {
		return `[The page has ${text.length} characters; start ${start} is past its end.]`;
	}
	const end = Math.min(text.length, start + limit);
	const part = text.slice(start, end);
	if (end >= text.length && start === 0) return part;
	const more = end < text.length ? ` Call web_fetch again with start: ${end} for more.` : " This is the end.";
	return `${part}\n\n[Characters ${start}-${end} of ${text.length}.${more}]`;
}

/** `href` made absolute against the page, so the model can fetch it. Fragment-only links point back into the page. */
function absoluteLink(href: string, baseUrl: string | undefined): string | undefined {
	const target = unescapeHtml(href);
	if (target.startsWith("#") || /^javascript:/i.test(target)) return undefined;
	if (!baseUrl) return target;
	try {
		return new URL(target, baseUrl).href;
	} catch {
		return target;
	}
}

/**
 * @param baseUrl the page's URL; relative links are resolved against it.
 */
export function htmlToMarkdown(html: string, maxLength = 8000, baseUrl?: string): string {
	// 1. Remove non-content tags
	let text = html
		.replace(/\u0000/g, "")
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
		.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
		.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
		.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
		.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
		.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
		.replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, "");

	// 2. Extract main/article content if present
	const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text);
	const articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(text);
	if (articleMatch) {
		text = articleMatch[1];
	} else if (mainMatch) {
		text = mainMatch[1];
	} else {
		const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(text);
		if (bodyMatch) text = bodyMatch[1];
	}

	// 3. Convert code blocks before other tags. Decoded code holds text such as `<stdio.h>` that the tag
	// stripping below would delete, so it waits behind a marker and goes back in at the end.
	const codeBlocks: string[] = [];
	const keepCode = (markdown: string) => `\u0000${codeBlocks.push(markdown) - 1}\u0000`;
	text = text.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => {
		return `\n${keepCode(`\`\`\`\n${unescapeHtml(code)}\n\`\`\``)}\n`;
	});
	text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
		return ` ${keepCode(`\`${unescapeHtml(code)}\``)} `;
	});

	// 4. Headings
	text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
	text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
	text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
	text = text.replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");

	// 5. Links, lists, formatting
	text = text.replace(
		/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi,
		(_, doubleQuoted, singleQuoted, content) => {
			const cleanContent = content.replace(/<[^>]+>/g, "").trim();
			if (!cleanContent) return "";
			const link = absoluteLink(doubleQuoted ?? singleQuoted, baseUrl);
			return link ? `[${cleanContent}](${link})` : cleanContent;
		},
	);
	text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
	text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

	// 6. Strip all remaining HTML tags
	text = text.replace(/<[^>]+>/g, "");

	// 7. Unescape entities and normalize blank lines
	text = unescapeHtml(text);
	const lines = text.split("\n").map((l) => l.trimEnd());
	const cleanLines: string[] = [];
	let prevBlank = false;
	for (const line of lines) {
		const isBlank = line.trim().length === 0;
		if (isBlank && prevBlank) continue;
		cleanLines.push(line);
		prevBlank = isBlank;
	}

	text = cleanLines
		.join("\n")
		.trim()
		.replace(/\u0000(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)]);

	// 8. Enforce context length ceiling
	if (text.length > maxLength) {
		text = `${text.slice(0, maxLength)}\n\n[… content truncated to preserve context budget (${maxLength} characters) …]`;
	}

	return text;
}

export interface WebFetchDependencies {
	fetch?: typeof fetch;
	lookup?: LookupFunction;
}

export function createWebFetchTool(
	options?: Pick<CodingToolOptions, "allowLocalNetwork">,
	dependencies: WebFetchDependencies = {},
): AgentTool<typeof webFetchSchema> {
	const fetchFn = dependencies.fetch ?? fetch;
	const lookup = dependencies.lookup ?? lookupAll;
	return {
		name: "web_fetch",
		label: "fetch",
		description: "Fetch a web page as text. Long pages come in parts: pass start to continue.",
		parameters: webFetchSchema,
		prepareArguments(args: unknown) {
			if (typeof args !== "object" || args === null) return args;
			const obj = args as Record<string, unknown>;
			if ("max_length" in obj && !("maxLength" in obj)) {
				return { ...obj, maxLength: obj.max_length };
			}
			return obj;
		},
		async execute(_toolCallId, { url, maxLength, start }, signal, onUpdate) {
			const rawUrl = url.trim();
			if (!rawUrl) throw new Error("url is required.");

			let current: URL;
			try {
				current = new URL(rawUrl);
			} catch {
				throw new Error(`Invalid URL "${rawUrl}".`);
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching: ${rawUrl}…` }] });

			// In plan and chat modes the web tools are the model's only tools, so a page must not steer it into the
			// local network. Redirects are followed here, so every hop is checked.
			const localAllowed = options?.allowLocalNetwork?.() ?? true;
			const requestOptions = {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
				},
				redirect: "manual" as const,
				signal: requestSignal(requestTimeoutMs(), signal),
			};
			let res: Response | undefined;
			for (let hop = 0; ; hop++) {
				if (current.protocol !== "http:" && current.protocol !== "https:") {
					throw new Error("Only http: and https: protocols are supported.");
				}
				if (!localAllowed) await assertPublic(current, lookup);
				res = await fetchFn(current.href, requestOptions);
				const location = res.headers.get("location");
				if (res.status < 300 || res.status >= 400 || !location) break;
				await res.body?.cancel();
				if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects fetching "${rawUrl}".`);
				current = new URL(location, current);
			}

			if (!res.ok) {
				throw new Error(`Error fetching "${current.href}": HTTP ${res.status} ${res.statusText}`);
			}

			const contentType = res.headers.get("content-type") || "";
			const declared = declaredKind(contentType);
			const { bytes, complete } = await readBytes(res, declared === "binary" ? MAX_FILE_BYTES : MAX_TEXT_BYTES);
			const kind = declared ?? sniffKind(bytes);
			const source = current.href === rawUrl ? rawUrl : `${rawUrl} (redirected to ${current.href})`;

			if (kind === "binary") {
				const type = contentType.split(";")[0].trim() || "an unknown type";
				if (!complete) {
					return {
						content: [
							{
								type: "text",
								text: `${source} is ${type}, larger than ${formatBytes(declared ? MAX_FILE_BYTES : MAX_TEXT_BYTES)}; it was not downloaded.`,
							},
						],
					};
				}
				const path = saveDownload(current, bytes, contentType);
				return {
					content: [
						{
							type: "text",
							text: `${source} is ${type} (${formatBytes(bytes.byteLength)}), not text. Saved it to ${path}: use bash to extract it (for example pdftotext or unzip), or read it if it is an image.`,
						},
					],
				};
			}

			const decoded = decode(bytes, declaredCharset(contentType, bytes));
			const text =
				kind === "html" ? htmlToMarkdown(decoded, Number.POSITIVE_INFINITY, current.href) : decoded.trim();
			if (!text) {
				return { content: [{ type: "text", text: `Fetched ${source}, but no readable text content was found.` }] };
			}
			const limit = Math.min(Math.max(maxLength ?? 8000, 1000), 25_000);
			const offset = Math.max(0, start ?? 0);
			const cut = complete ? "" : ` (only its first ${formatBytes(MAX_TEXT_BYTES)} were read)`;
			return {
				content: [{ type: "text", text: `Content from ${source}${cut}:\n\n${pageOf(text, offset, limit)}` }],
			};
		},
	};
}
