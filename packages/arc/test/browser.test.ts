import { describe, expect, it } from "vitest";
import {
	type BrowserDependencies,
	createBrowserTool,
	type Playwright,
	type PlaywrightRoute,
} from "../src/tools/browser.ts";
import { createCodingTools, toolLimitsFor } from "../src/tools/index.ts";

/**
 * A stand-in for Playwright. Loading `page` sends its requests: `routed` ones pass through the page's route, as
 * subresources do; `unrouted` ones only raise the request event, as a redirect can. A `redirects` entry makes the
 * route's own fetch of that URL answer with a redirect to the given location.
 */
interface FakePage {
	routed?: string[];
	unrouted?: string[];
	redirects?: Record<string, string>;
}

function fakePlaywright(page: FakePage) {
	const log = {
		launched: 0,
		closed: 0,
		routedAborted: [] as string[],
		fulfilled: [] as string[],
		routeInstalled: false,
	};
	const playwright: Playwright = {
		chromium: {
			async launch() {
				log.launched++;
				let handler: ((route: PlaywrightRoute) => Promise<void>) | undefined;
				const listeners: ((request: { url(): string }) => void)[] = [];
				return {
					async newPage() {
						return {
							async route(_pattern: string, routeHandler: (route: PlaywrightRoute) => Promise<void>) {
								log.routeInstalled = true;
								handler = routeHandler;
							},
							on(_event: "request", listener: (request: { url(): string }) => void) {
								listeners.push(listener);
							},
							async goto() {
								for (const url of [...(page.routed ?? []), ...(page.unrouted ?? [])]) {
									for (const listener of listeners) listener({ url: () => url });
								}
								for (const url of page.routed ?? []) {
									await handler?.({
										request: () => ({ url: () => url }),
										continue: async () => {},
										abort: async () => {
											log.routedAborted.push(url);
										},
										fetch: async () => ({
											headers: (): Record<string, string> => {
												const location = page.redirects?.[url];
												return location ? { location } : {};
											},
										}),
										fulfill: async () => {
											log.fulfilled.push(url);
										},
									});
								}
							},
							async waitForLoadState() {},
							async screenshot() {
								return Buffer.from("png");
							},
						};
					},
					async close() {
						log.closed++;
					},
				};
			},
		},
	};
	return { playwright, log };
}

const lookup: BrowserDependencies["lookup"] = async (host) =>
	host === "intranet.example" ? ["192.168.1.5"] : ["93.184.216.34"];

function tool(local: boolean, page: FakePage) {
	const fake = fakePlaywright(page);
	const browser = createBrowserTool(
		{ allowLocalNetwork: () => local },
		{ loadPlaywright: async () => fake.playwright, lookup },
	);
	return { browser, log: fake.log };
}

describe("browser_capture", () => {
	it("opens only http and https URLs", async () => {
		const { browser, log } = tool(true, {});
		await expect(browser.execute("1", { url: "file:///etc/passwd" })).rejects.toThrow(/only opens http/);
		await expect(browser.execute("1", { url: "javascript:alert(1)" })).rejects.toThrow(/only opens http/);
		expect(log.launched).toBe(0);
	});

	it("refuses a local URL outside agent mode before starting the browser", async () => {
		const { browser, log } = tool(false, {});
		await expect(browser.execute("1", { url: "http://localhost:3000" })).rejects.toThrow(/localhost:3000 is local/);
		await expect(browser.execute("1", { url: "http://intranet.example/" })).rejects.toThrow(/is local/);
		expect(log.launched).toBe(0);
	});

	it("blocks local subresources but still captures the page", async () => {
		const { browser, log } = tool(false, {
			routed: ["https://example.com/", "http://127.0.0.1:8080/secret.png", "https://cdn.example.com/a.css"],
		});
		const result = await browser.execute("1", { url: "https://example.com/" });
		expect(log.routedAborted).toEqual(["http://127.0.0.1:8080/secret.png"]);
		expect(result.content.some((part) => part.type === "image")).toBe(true);
		expect(log.closed).toBeGreaterThan(0);
	});

	it("refuses a redirect to a local address without following it", async () => {
		const { browser, log } = tool(false, {
			routed: ["https://example.com/go"],
			redirects: { "https://example.com/go": "http://127.0.0.1:8765/" },
		});
		await expect(browser.execute("1", { url: "https://example.com/go" })).rejects.toThrow(
			/127\.0\.0\.1:8765 is local/,
		);
		expect(log.routedAborted).toEqual(["https://example.com/go"]);
		expect(log.fulfilled).toEqual([]);
	});

	it("fails the capture when a request reaches a local address around the route", async () => {
		const { browser, log } = tool(false, { routed: ["https://example.com/"], unrouted: ["http://10.0.0.1/admin"] });
		await expect(browser.execute("1", { url: "https://example.com/" })).rejects.toThrow(/10\.0\.0\.1 is local/);
		expect(log.closed).toBeGreaterThan(0);
	});

	it("reaches local addresses in agent mode", async () => {
		const { browser, log } = tool(true, { routed: ["http://localhost:5173/"] });
		const result = await browser.execute("1", { url: "http://localhost:5173/" });
		expect(log.routeInstalled).toBe(false);
		expect(result.content[0]).toEqual({ type: "text", text: "Screenshot of http://localhost:5173/" });
	});

	it("is offered only to models that accept images", () => {
		const base = { cwd: "/w", limits: toolLimitsFor(12_000), browser: true };
		const names = (acceptsImages: boolean) =>
			createCodingTools({ ...base, acceptsImages }).map((codingTool) => codingTool.name);
		expect(names(false)).not.toContain("browser_capture");
		expect(names(true)).toContain("browser_capture");
	});
});
