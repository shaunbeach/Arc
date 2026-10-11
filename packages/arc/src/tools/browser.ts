import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { getAppDir } from "../config/paths.ts";
import { networkTimeoutMs } from "./network.ts";
import type { CodingToolOptions } from "./options.ts";
import { isLocalHost, type LookupFunction, lookupAll } from "./web-fetch.ts";

/** Installed into `~/.arc/browser` on first use rather than bundled: it is large and most sessions never need it. */
export const PLAYWRIGHT_VERSION = "1.63.0";
/** A first install downloads Playwright and Chromium, a few hundred megabytes. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const browserSchema = Type.Object({
	url: Type.String({ description: "http(s) URL" }),
	width: Type.Optional(Type.Integer({ description: "Viewport width, default 1280" })),
	height: Type.Optional(Type.Integer({ description: "Viewport height, default 800" })),
});

/** The parts of Playwright this tool uses. It is loaded at run time from the install, so its own types are not available. */
interface PlaywrightRequest {
	url(): string;
}
interface PlaywrightResponse {
	headers(): Record<string, string>;
}
export interface PlaywrightRoute {
	request(): PlaywrightRequest;
	continue(): Promise<void>;
	abort(): Promise<void>;
	fetch(options: { maxRedirects: number }): Promise<PlaywrightResponse>;
	fulfill(options: { response: PlaywrightResponse }): Promise<void>;
}
interface PlaywrightPage {
	route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
	on(event: "request", listener: (request: PlaywrightRequest) => void): void;
	goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
	screenshot(options: { type: "png"; timeout: number }): Promise<Buffer>;
}
interface PlaywrightBrowser {
	newPage(options: { viewport: { width: number; height: number } }): Promise<PlaywrightPage>;
	close(): Promise<void>;
}
export interface Playwright {
	chromium: { launch(options: { headless: boolean }): Promise<PlaywrightBrowser> };
}

export interface BrowserDependencies {
	/** Install Playwright if needed and load it. Default: `~/.arc/browser`. */
	loadPlaywright?: (signal: AbortSignal | undefined, onStatus: (message: string) => void) => Promise<Playwright>;
	lookup?: LookupFunction;
}

function run(file: string, args: string[], cwd: string, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{ cwd, signal, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(error, _out, err) => {
				if (!error) return resolve();
				const tail = err.trim().split("\n").slice(-10).join("\n");
				reject(new Error(`${file} ${args.join(" ")} failed: ${error.message}${tail ? `\n${tail}` : ""}`));
			},
		);
	});
}

let installing: Promise<void> | undefined;

/** Install Playwright and its Chromium once into `dir`. A marker file records a finished install of this version. */
async function installPlaywright(dir: string, signal: AbortSignal | undefined, onStatus: (message: string) => void) {
	mkdirSync(dir, { recursive: true });
	// Its own package.json, so npm installs here instead of into a parent project.
	writeFileSync(join(dir, "package.json"), '{"name":"arc-browser","private":true}\n');
	onStatus(`Installing Playwright ${PLAYWRIGHT_VERSION} into ${dir} (first use only)…`);
	await run("npm", ["install", "--no-audit", "--no-fund", `playwright@${PLAYWRIGHT_VERSION}`], dir, signal);
	onStatus("Downloading Chromium (first use only)…");
	await run(process.execPath, [join(dir, "node_modules", "playwright", "cli.js"), "install", "chromium"], dir, signal);
	writeFileSync(join(dir, `installed-${PLAYWRIGHT_VERSION}`), "");
}

async function loadInstalledPlaywright(
	signal: AbortSignal | undefined,
	onStatus: (message: string) => void,
): Promise<Playwright> {
	const dir = join(getAppDir(), "browser");
	if (!existsSync(join(dir, `installed-${PLAYWRIGHT_VERSION}`))) {
		installing ??= installPlaywright(dir, signal, onStatus).finally(() => {
			installing = undefined;
		});
		await installing;
	}
	return createRequire(join(dir, "package.json"))("playwright") as Playwright;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value ?? fallback));
}

/**
 * `browser_capture`: open a page in headless Chromium and return a screenshot. Like web_fetch, it reaches only public
 * addresses outside agent mode. Requests the page makes are checked as they go, and a redirect to a local address
 * fails the capture, so a public page cannot show the model what is on the local network.
 */
export function createBrowserTool(
	options: Pick<CodingToolOptions, "allowLocalNetwork">,
	dependencies: BrowserDependencies = {},
): AgentTool<typeof browserSchema> {
	const loadPlaywright = dependencies.loadPlaywright ?? loadInstalledPlaywright;
	const lookup = dependencies.lookup ?? lookupAll;
	return {
		name: "browser_capture",
		label: "browser",
		description: "Open a URL in a headless browser and return a screenshot of the page.",
		parameters: browserSchema,
		async execute(_toolCallId, { url, width, height }, signal, onUpdate) {
			let target: URL;
			try {
				target = new URL(url.trim());
			} catch {
				throw new Error(`Invalid URL "${url}".`);
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error("browser_capture only opens http: and https: URLs.");
			}

			const localAllowed = options.allowLocalNetwork?.() ?? true;
			const verdicts = new Map<string, Promise<boolean>>();
			const isLocal = (hostname: string) => {
				let verdict = verdicts.get(hostname);
				if (!verdict) {
					verdict = isLocalHost(hostname, lookup).catch(() => true);
					verdicts.set(hostname, verdict);
				}
				return verdict;
			};
			const refusal = (host: string) =>
				`browser_capture only reaches public addresses in plan and chat modes; ${host} is local. Switch to /agent to open it.`;
			if (!localAllowed && (await isLocal(target.hostname))) throw new Error(refusal(target.host));

			const status = (message: string) => onUpdate?.({ content: [{ type: "text", text: message }] });
			const playwright = await loadPlaywright(signal, status);
			signal?.throwIfAborted();
			status(`Opening ${target.href}…`);

			const timeout = networkTimeoutMs(process.env.ARC_WEB_TIMEOUT_MS, 30_000);
			const browser = await playwright.chromium.launch({ headless: true });
			const closeOnAbort = () => void browser.close().catch(() => {});
			signal?.addEventListener("abort", closeOnAbort, { once: true });
			try {
				const page = await browser.newPage({
					viewport: { width: clamp(width, 1280, 320, 3840), height: clamp(height, 800, 240, 2160) },
				});
				// The route blocks local requests. Chromium follows redirects without passing them through a route, so the
				// route makes each request itself without following redirects and checks where a redirect points before
				// handing it to the browser. As a backstop, every request is also checked as it goes out, and a local one
				// the route did not block fails the capture.
				const aborted = new Set<string>();
				const leaked = new Set<string>();
				const redirected = new Set<string>();
				const checks: Promise<void>[] = [];
				if (!localAllowed) {
					await page.route("**/*", async (route) => {
						const request = new URL(route.request().url());
						if (request.protocol === "data:" || request.protocol === "blob:") return route.continue();
						if (
							(request.protocol !== "http:" && request.protocol !== "https:") ||
							(await isLocal(request.hostname))
						) {
							aborted.add(request.href);
							return route.abort();
						}
						const response = await route.fetch({ maxRedirects: 0 });
						const location = response.headers().location;
						if (location) {
							const next = new URL(location, request);
							if ((next.protocol !== "http:" && next.protocol !== "https:") || (await isLocal(next.hostname))) {
								redirected.add(next.href);
								return route.abort();
							}
						}
						return route.fulfill({ response });
					});
					page.on("request", (request) => {
						const requestUrl = new URL(request.url());
						if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") return;
						checks.push(
							isLocal(requestUrl.hostname).then((local) => {
								if (local) leaked.add(requestUrl.href);
							}),
						);
					});
				}

				// A redirect to a local address was never followed, but the page is not what was asked for: refuse it too.
				const refuseLocal = async () => {
					await Promise.all(checks);
					const reached = [...redirected, ...[...leaked].filter((href) => !aborted.has(href))];
					if (reached.length > 0) throw new Error(refusal(reached.map((href) => new URL(href).host).join(", ")));
				};
				try {
					await page.goto(target.href, { waitUntil: "load", timeout });
				} catch (error) {
					// An aborted redirect fails the navigation; say why rather than pass on net::ERR_FAILED.
					await refuseLocal();
					throw error;
				}
				// Let late requests settle, but do not wait on pages that never go quiet.
				await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
				await refuseLocal();

				const image = await page.screenshot({ type: "png", timeout });
				return {
					content: [
						{ type: "text", text: `Screenshot of ${target.href}` },
						{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
					],
				};
			} finally {
				signal?.removeEventListener("abort", closeOnAbort);
				await browser.close().catch(() => {});
			}
		},
	};
}
