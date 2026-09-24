import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiteModel } from "../src/config/models.ts";
import {
	buildServerArgs,
	isServerBusy,
	LlamaServerManager,
	serverOrigin,
	waitForSlotsIdle,
	withSlotSavePath,
} from "../src/llm/server.ts";

const model: LiteModel = {
	name: "test-model",
	id: "test.gguf",
	provider: "llamacpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 1024,
	modelPath: "/models/test.gguf",
	launchArgs: ["--ctx-size", "4096"],
	llamaServer: "llama-server",
};

class FakeChild extends EventEmitter {
	pid: number | undefined = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	spawnfile: string;
	signals: NodeJS.Signals[] = [];

	constructor(spawnfile: string) {
		super();
		this.spawnfile = spawnfile;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		this.exit(null, signal);
		return true;
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		queueMicrotask(() => this.emit("exit", code, signal));
	}
}

/** Fetch stub routed by path. Returning "down" simulates a refused connection. */
function routes(handler: (path: string) => Response | "down"): typeof fetch {
	return (async (input: string | URL | Request) => {
		const result = handler(new URL(String(input)).pathname);
		if (result === "down") throw new TypeError("fetch failed");
		return result;
	}) as typeof fetch;
}

function logFile(): string {
	return join(mkdtempSync(join(tmpdir(), "arc-server-")), "llama-server.log");
}

describe("server addressing", () => {
	it("derives the server origin from baseUrl", () => {
		expect(serverOrigin("http://localhost:8080/v1")).toBe("http://localhost:8080");
		expect(serverOrigin("http://localhost:8080/")).toBe("http://localhost:8080");
		expect(serverOrigin("http://gpu-box/llama/v1/")).toBe("http://gpu-box/llama");
	});

	it("adds --port and --host from baseUrl only when launchArgs omit them", () => {
		expect(buildServerArgs(model)).toEqual(["-m", "/models/test.gguf", "--ctx-size", "4096", "--port", "8080"]);
		expect(buildServerArgs({ ...model, launchArgs: ["--port", "8080"] })).toEqual([
			"-m",
			"/models/test.gguf",
			"--port",
			"8080",
		]);
		expect(buildServerArgs({ ...model, baseUrl: "http://192.168.1.5:9000/v1", launchArgs: [] })).toEqual([
			"-m",
			"/models/test.gguf",
			"--port",
			"9000",
			"--host",
			"192.168.1.5",
		]);
	});

	it("forces --host 0.0.0.0 when isHost is true", () => {
		expect(buildServerArgs(model, true)).toEqual([
			"-m",
			"/models/test.gguf",
			"--ctx-size",
			"4096",
			"--port",
			"8080",
			"--host",
			"0.0.0.0",
		]);
	});
});

describe("LlamaServerManager", () => {
	it("spawns a server, waits through loading, reuses it, and stops it", async () => {
		const children: FakeChild[] = [];
		const spawnedArgs: (readonly string[])[] = [];
		let healthChecksAfterSpawn = 0;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string, args: readonly string[], _options: SpawnOptions) => {
				spawnedArgs.push(args);
				const child = new FakeChild(command);
				children.push(child);
				return child as unknown as ChildProcess;
			},
			fetch: routes((path) => {
				if (children.length === 0) return "down";
				expect(path).toBe("/health");
				healthChecksAfterSpawn++;
				return new Response("{}", { status: healthChecksAfterSpawn < 3 ? 503 : 200 });
			}),
		});

		await manager.ensure(model);
		expect(spawnedArgs).toEqual([["-m", "/models/test.gguf", "--ctx-size", "4096", "--port", "8080"]]);
		expect(manager.model?.name).toBe("test-model");
		expect(manager.ownsServer).toBe(true);

		await manager.ensure(model);
		expect(children).toHaveLength(1);

		await manager.stop();
		expect(children[0].signals).toEqual(["SIGTERM"]);
		expect(manager.ownsServer).toBe(false);
		expect(manager.model).toBeUndefined();
	});

	it("keeps the server when switching between entries that share a GGUF and launch arguments", async () => {
		const children: FakeChild[] = [];
		const running = () => children.some((child) => child.exitCode === null && child.signalCode === null);
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string) => {
				const child = new FakeChild(command);
				children.push(child);
				return child as unknown as ChildProcess;
			},
			fetch: routes(() => (running() ? new Response("{}", { status: 200 }) : "down")),
		});

		await manager.ensure(model);
		await manager.ensure({ ...model, name: "test-model-low" });
		expect(children).toHaveLength(1);
		expect(manager.model?.name).toBe("test-model-low");

		await manager.ensure({ ...model, name: "bigger-context", launchArgs: ["--ctx-size", "8192"] });
		expect(children).toHaveLength(2);
		expect(children[0].signals).toEqual(["SIGTERM"]);
		expect(manager.model?.name).toBe("bigger-context");
		await manager.stop();
	});

	it("attaches to a running server that already serves the model", async () => {
		let spawned = false;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				spawned = true;
				return new FakeChild("llama-server") as unknown as ChildProcess;
			},
			fetch: routes((path) =>
				path === "/props"
					? Response.json({ model_path: "/models/test.gguf" })
					: new Response("{}", { status: 200 }),
			),
		});
		await manager.ensure(model);
		expect(spawned).toBe(false);
		expect(manager.model?.name).toBe("test-model");
		expect(manager.ownsServer).toBe(false);
	});

	it("never spawns for a discovered model, and says the link is down", async () => {
		let spawned = false;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				spawned = true;
				return new FakeChild("llama-server") as unknown as ChildProcess;
			},
			// Nothing is listening: the tunnel is down, or the other machine is asleep.
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		const discovered: LiteModel = { ...model, discover: true, modelPath: "/Users/someone/elsewhere.gguf" };
		await expect(manager.ensure(discovered)).rejects.toThrow(/Nothing is serving at http:\/\/127\.0\.0\.1:8080/);
		expect(spawned).toBe(false);
	});

	it("distinguishes a lost connection from one that never answered", async () => {
		let reachable = true;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				throw new Error("should not spawn");
			},
			fetch: (async (url: string) => {
				if (!reachable) throw new Error("ECONNREFUSED");
				return new URL(url).pathname === "/props"
					? Response.json({ model_path: "/models/test.gguf" })
					: new Response("{}", { status: 200 });
			}) as unknown as typeof fetch,
		});
		const discovered: LiteModel = { ...model, discover: true };
		await manager.ensure(discovered);

		// The other machine goes away after Arc had been talking to it.
		reachable = false;
		await expect(manager.ensure(discovered)).rejects.toThrow(/Lost the connection to http:\/\/127\.0\.0\.1:8080/);
		// A fresh manager never reached it, so it reads as nothing being there.
		const cold = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				throw new Error("should not spawn");
			},
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(cold.ensure(discovered)).rejects.toThrow(/Nothing is serving at/);
	});

	it("attaches a discovered model to the server that is already running", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				throw new Error("should not spawn");
			},
			fetch: routes((path) =>
				path === "/props"
					? Response.json({ model_path: "/models/test.gguf" })
					: new Response("{}", { status: 200 }),
			),
		});
		await manager.ensure({ ...model, discover: true });
		expect(manager.ownsServer).toBe(false);
	});

	it("refuses a running server that serves another model", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			fetch: routes((path) =>
				path === "/props"
					? Response.json({ model_path: "/models/other.gguf" })
					: new Response("{}", { status: 200 }),
			),
		});
		await expect(manager.ensure(model)).rejects.toThrow(
			"llama-server at http://127.0.0.1:8080 is serving /models/other.gguf, not test-model.",
		);
	});

	it("refuses a port held by something that is not llama-server", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			fetch: routes(() => new Response("not found", { status: 404 })),
		});
		await expect(manager.ensure(model)).rejects.toThrow("is in use by something other than llama-server");
	});

	it("reports the log tail when the server exits during startup", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string, _args: readonly string[], options: SpawnOptions) => {
				const stdout = (options.stdio as unknown[])[1] as number;
				writeSync(stdout, "llama_model_load: error loading model\n");
				const child = new FakeChild(command);
				child.exit(1);
				return child as unknown as ChildProcess;
			},
			fetch: routes(() => "down"),
		});
		await expect(manager.ensure(model)).rejects.toThrow(
			/exited \(1\) before it was ready\.[\s\S]*error loading model/,
		);
		expect(manager.ownsServer).toBe(false);
	});

	it("explains a missing llama-server executable", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string) => {
				const child = new FakeChild(command);
				child.pid = undefined;
				queueMicrotask(() =>
					child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })),
				);
				return child as unknown as ChildProcess;
			},
			fetch: routes(() => "down"),
		});
		await expect(manager.ensure(model)).rejects.toThrow("llama-server executable not found: llama-server");
	});

	it("starts a host server on 0.0.0.0 and returns remote connection info", async () => {
		const children: FakeChild[] = [];
		const spawnedArgs: (readonly string[])[] = [];
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string, args: readonly string[], _options: SpawnOptions) => {
				spawnedArgs.push(args);
				const child = new FakeChild(command);
				children.push(child);
				return child as unknown as ChildProcess;
			},
			fetch: routes((path) => {
				if (children.length === 0) return "down";
				expect(path).toBe("/health");
				return new Response("{}", { status: 200 });
			}),
		});

		const res = await manager.startHost(model, () => {});
		expect(spawnedArgs[0]).toContain("--host");
		expect(spawnedArgs[0]).toContain("0.0.0.0");
		expect(res.port).toBe("8080");
		expect(res.localUrl).toBe("http://localhost:8080/v1");
		expect(res.remoteUrl).toMatch(/^http:\/\/.*:8080\/v1$/);
		await manager.stop();
	});

	it("refuses to host when another server already answers on the port", async () => {
		let spawned = 0;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string) => {
				spawned++;
				return new FakeChild(command) as unknown as ChildProcess;
			},
			fetch: routes(() => new Response("{}", { status: 200 })),
		});

		await expect(manager.startHost(model, () => {})).rejects.toThrow(
			"A llama-server Arc did not start is already running at http://localhost:8080",
		);
		expect(spawned).toBe(0);
		expect(manager.model).toBeUndefined();
	});

	it("checks slots on the server baseUrl names, not always localhost", async () => {
		const remote: LiteModel = { ...model, baseUrl: "http://10.0.0.5:9090/v1" };
		const urls: string[] = [];
		let spawned = false;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string) => {
				spawned = true;
				return new FakeChild(command) as unknown as ChildProcess;
			},
			fetch: (async (input: string | URL | Request) => {
				urls.push(String(input));
				if (!spawned) throw new TypeError("fetch failed");
				const path = new URL(String(input)).pathname;
				return new Response(path === "/slots" ? JSON.stringify([{ is_processing: true }]) : "{}");
			}) as typeof fetch,
		});

		await manager.ensure(remote);
		expect(await manager.isProcessing()).toBe(true);
		expect(urls.at(-1)).toBe("http://10.0.0.5:9090/slots");
		await manager.stop();
	});

	it("closes the log file when the host server cannot be spawned", async () => {
		const openFiles = () => readdirSync("/dev/fd").length;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			spawn: () => {
				throw new Error("spawn EINVAL");
			},
			fetch: routes(() => "down"),
		});
		const before = openFiles();
		await expect(manager.startHost(model, () => {})).rejects.toThrow("spawn EINVAL");
		expect(openFiles()).toBe(before);
	});

	it("detects when slots are busy and waits until idle", async () => {
		let processing = true;
		const fetchMock = routes((path) => {
			if (path === "/slots") {
				return new Response(JSON.stringify([{ id: 0, is_processing: processing }]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("{}", { status: 200 });
		});

		expect(await isServerBusy("http://localhost:8080", fetchMock)).toBe(true);

		setTimeout(() => {
			processing = false;
		}, 20);

		const idle = await waitForSlotsIdle("http://localhost:8080", 500, fetchMock, undefined, 10);
		expect(idle).toBe(true);
	});
});

describe("mmproj", () => {
	it("passes the projector right after the model", () => {
		expect(buildServerArgs({ ...model, mmproj: "/models/mm.gguf" }).slice(0, 4)).toEqual([
			"-m",
			"/models/test.gguf",
			"--mmproj",
			"/models/mm.gguf",
		]);
	});
});

describe("slot save and restore", () => {
	it("adds --slot-save-path and one slot, keeping flags launchArgs set", () => {
		expect(withSlotSavePath(model, "/slots").launchArgs).toEqual([
			"--ctx-size",
			"4096",
			"--slot-save-path",
			"/slots",
			"--parallel",
			"1",
		]);
		const own = { ...model, launchArgs: ["--slot-save-path=/mine", "-np", "2"] };
		expect(withSlotSavePath(own, "/slots").launchArgs).toEqual(own.launchArgs);
	});

	it("posts slot actions to slot 0, creates the slot directory, and reports what moved", async () => {
		const slotDir = join(mkdtempSync(join(tmpdir(), "arc-slots-")), "slots");
		const requests: { url: string; body: string; auth: string | null }[] = [];
		let spawned = false;
		const manager = new LlamaServerManager({
			logFile: logFile(),
			pollIntervalMs: 1,
			spawn: (command: string) => {
				spawned = true;
				return new FakeChild(command) as unknown as ChildProcess;
			},
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/health") return spawned ? new Response("{}") : Promise.reject(new TypeError("down"));
				requests.push({
					url: `${url.pathname}${url.search}`,
					body: String(init?.body),
					auth: new Headers(init?.headers).get("authorization"),
				});
				return url.search === "?action=save"
					? Response.json({ n_saved: 1200, n_written: 5_000_000, timings: { save_ms: 42.5 } })
					: Response.json({ n_restored: 1200, n_read: 5_000_000, timings: { restore_ms: 17 } });
			}) as typeof fetch,
		});

		await expect(manager.saveSlot("s.bin")).rejects.toThrow(/no llama-server is running/);
		await manager.ensure({ ...withSlotSavePath(model, slotDir), apiKey: "k" });
		expect(readdirSync(slotDir)).toEqual([]);
		expect(await manager.saveSlot("s.bin")).toEqual({ tokens: 1200, bytes: 5_000_000, ms: 42.5 });
		expect(await manager.restoreSlot("s.bin")).toEqual({ tokens: 1200, bytes: 5_000_000, ms: 17 });
		expect(requests).toEqual([
			{ url: "/slots/0?action=save", body: '{"filename":"s.bin"}', auth: "Bearer k" },
			{ url: "/slots/0?action=restore", body: '{"filename":"s.bin"}', auth: "Bearer k" },
		]);
		await manager.stop();
	});

	it("says why llama-server refused a slot action", async () => {
		const manager = new LlamaServerManager({
			logFile: logFile(),
			fetch: routes((path) =>
				path === "/props"
					? Response.json({ model_path: "/models/test.gguf" })
					: path === "/health"
						? new Response("{}")
						: Response.json(
								{ error: { message: "This server does not support slots action." } },
								{ status: 501 },
							),
			),
		});
		await manager.ensure(model);
		await expect(manager.restoreSlot("s.bin")).rejects.toThrow(
			"llama-server could not restore slot 0 (HTTP 501): This server does not support slots action.",
		);
	});
});
