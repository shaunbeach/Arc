import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasFlag, type LiteModel } from "../config/models.ts";

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface LlamaServerManagerOptions {
	/** Server stdout and stderr are appended here rather than buffered in memory. */
	logFile: string;
	fetch?: typeof fetch;
	spawn?: SpawnFunction;
	/** How long to wait for /health after spawning. Default: 10 minutes, since large models load slowly. */
	readyTimeoutMs?: number;
	/** Default: 250 ms. */
	pollIntervalMs?: number;
}

export interface EnsureServerOptions {
	signal?: AbortSignal;
	onStatus?: (message: string) => void;
}

/** `foreign`: something answers on the port, but not like llama-server. */
type HealthState = "down" | "loading" | "ready" | "foreign";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `http://localhost:8080/v1` -> `http://localhost:8080`, where /health and /props live. */
export function serverOrigin(baseUrl: string): string {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
	return `${url.origin}${path}`;
}

export function serverPort(baseUrl: string): string {
	const url = new URL(baseUrl);
	return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function getLocalIpAddress(): string {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const net of interfaces[name] ?? []) {
			if (net.family === "IPv4" && !net.internal) {
				return net.address;
			}
		}
	}
	return "127.0.0.1";
}

/** Check whether any llama-server slot is actively processing a request. */
export async function isServerBusy(
	origin: string,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const res = await fetchFn(`${origin}/slots`, { signal });
		if (!res.ok) return false;
		const slots = (await res.json()) as Array<{ is_processing?: boolean }>;
		if (Array.isArray(slots)) {
			return slots.some((slot) => slot.is_processing === true);
		}
		return false;
	} catch {
		return false;
	}
}

/** Poll /slots until all slots are idle, or timeout expires. */
export async function waitForSlotsIdle(
	origin: string,
	timeoutMs = 60_000,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
	pollIntervalMs = 500,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (signal?.aborted) return false;
		const busy = await isServerBusy(origin, fetchFn, signal);
		if (!busy) return true;
		await delay(pollIntervalMs, undefined, { signal }).catch(() => {});
	}
	return false;
}

/** `-m <modelPath>`, the model's launchArgs, then --port/--host from baseUrl when launchArgs leave them out. */
export function buildServerArgs(model: LiteModel, isHost = false): string[] {
	const url = new URL(model.baseUrl);
	const args = ["-m", model.modelPath, ...model.launchArgs];
	if (!hasFlag(model.launchArgs, ["--port"])) {
		args.push("--port", url.port || (url.protocol === "https:" ? "443" : "80"));
	}
	if (isHost) {
		if (!hasFlag(model.launchArgs, ["--host"])) {
			args.push("--host", "0.0.0.0");
		}
	} else if (!hasFlag(model.launchArgs, ["--host"]) && !LOCAL_HOSTS.has(url.hostname)) {
		args.push("--host", url.hostname);
	}
	return args;
}

function isRunning(child: ChildProcess): boolean {
	return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function samePath(a: string, b: string): boolean {
	const canonical = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return canonical(a) === canonical(b);
}

/**
 * Whether two models.yml entries run on the same server: same GGUF, executable, address, and launch arguments.
 * Entries that differ only in request settings, such as reasoning-effort variants, share one server.
 */
function sameServer(a: LiteModel, b: LiteModel): boolean {
	return (
		samePath(a.modelPath, b.modelPath) &&
		a.baseUrl === b.baseUrl &&
		a.llamaServer === b.llamaServer &&
		a.launchArgs.length === b.launchArgs.length &&
		a.launchArgs.every((arg, index) => arg === b.launchArgs[index])
	);
}

/**
 * Runs at most one llama-server. It reuses a healthy server that already serves the requested GGUF with the same
 * launch arguments, stops a server it spawned when a different one is needed, and never kills a server it did not
 * spawn.
 */
export class LlamaServerManager {
	private readonly logFile: string;
	private readonly fetchFn: typeof fetch;
	private readonly spawnFn: SpawnFunction;
	private readonly readyTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private child: ChildProcess | undefined;
	private spawnError: Error | undefined;
	private logOffset = 0;
	private active: LiteModel | undefined;

	constructor(options: LlamaServerManagerOptions) {
		this.logFile = options.logFile;
		this.fetchFn = options.fetch ?? fetch;
		this.spawnFn = options.spawn ?? spawnProcess;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 10 * 60_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
	}

	/** Model the server currently serves for this process, spawned or attached. */
	get model(): LiteModel | undefined {
		return this.active;
	}

	/** True while a server spawned by this manager is running. */
	get ownsServer(): boolean {
		return this.child !== undefined && isRunning(this.child);
	}

	/** Make `model` reachable at its baseUrl, starting llama-server if needed. */
	async ensure(model: LiteModel, options: EnsureServerOptions = {}): Promise<void> {
		const { signal, onStatus } = options;
		const origin = serverOrigin(model.baseUrl);
		if (this.active && sameServer(this.active, model) && (await this.health(origin, signal)) === "ready") {
			this.active = model;
			return;
		}

		// stop() clears `active`, so note here whether this model was reachable a moment ago.
		const wasAttached = this.active !== undefined && sameServer(this.active, model);
		await this.stop();

		const state = await this.health(origin, signal);
		if (state === "foreign") {
			throw new Error(`${origin} is in use by something other than llama-server. Free the port or change baseUrl.`);
		}
		if (state !== "down") {
			onStatus?.(`Found llama-server at ${origin}, checking its model`);
			if (state === "loading") await this.waitUntilReady(origin, undefined, signal);
			const servedPath = await this.servedModelPath(origin, signal);
			if (servedPath === undefined || !samePath(servedPath, model.modelPath)) {
				throw new Error(
					`llama-server at ${origin} is serving ${servedPath ?? "an unknown model"}, not ${model.name}. ` +
						`Stop that server or give ${model.name} another port in models.yml.`,
				);
			}
			this.active = model;
			return;
		}

		// A discovered entry names no GGUF of its own: there is nothing to start, and the path it last saw belongs
		// to another machine. Say the link is down rather than fail inside llama-server. Once it has answered, the
		// likely cause is the route rather than the server, so the two cases read differently.
		if (model.discover) {
			throw new Error(
				wasAttached
					? `Lost the connection to ${origin}. The server stopped, or the route to it did; ` +
							`check any ssh tunnel, then reconnect with /model ${model.name}.`
					: `Nothing is serving at ${origin}. Start llama-server there, then connect again.`,
			);
		}

		onStatus?.(`Starting llama-server for ${model.name}`);
		const child = this.spawnServer(model);
		this.child = child;
		try {
			await this.waitUntilReady(origin, child, signal);
		} catch (error) {
			await this.stop();
			throw error;
		}
		this.active = model;
	}

	/** Check if any slot on the active server is currently processing. */
	async isProcessing(signal?: AbortSignal): Promise<boolean> {
		if (!this.active) return false;
		return isServerBusy(serverOrigin(this.active.baseUrl), this.fetchFn, signal);
	}

	/** Wait until all slots on the active server are idle, or timeout expires. */
	async waitForIdle(timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
		if (!this.active) return true;
		return waitForSlotsIdle(serverOrigin(this.active.baseUrl), timeoutMs, this.fetchFn, signal);
	}

	/** Start serving model on 0.0.0.0 as a remote host, streaming logs to callback. */
	async startHost(
		model: LiteModel,
		onLogLine: (line: string) => void,
		signal?: AbortSignal,
	): Promise<{ port: string; localIp: string; localUrl: string; remoteUrl: string }> {
		await this.stop();
		const port = serverPort(model.baseUrl);
		const origin = `http://localhost:${port}`;

		// A second server can bind 0.0.0.0 next to one on 127.0.0.1 (macOS allows it), and the health check below
		// would then pass on the old one. Refuse instead: a server this manager did not spawn is never stopped.
		const state = await this.health(origin, signal);
		if (state === "foreign") {
			throw new Error(`${origin} is in use by something other than llama-server. Free the port or change baseUrl.`);
		}
		if (state !== "down") {
			throw new Error(
				`A llama-server Arc did not start is already running at ${origin}. ` +
					`Stop it or give ${model.name} another port in models.yml.`,
			);
		}

		const child = this.spawnServer(model, true, onLogLine);
		this.child = child;

		try {
			await this.waitUntilReady(origin, child, signal);
		} catch (error) {
			await this.stop();
			throw error;
		}

		this.active = model;
		const localIp = getLocalIpAddress();
		return {
			port,
			localIp,
			localUrl: `http://localhost:${port}/v1`,
			remoteUrl: `http://${localIp}:${port}/v1`,
		};
	}

	/** Stop the server this manager spawned. A server it only attached to is forgotten, not stopped. */
	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.active = undefined;
		if (!child || !isRunning(child)) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGTERM");
		const forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(forceKill);
	}

	/** Best-effort synchronous stop for `process.on("exit")`, where awaiting is impossible. */
	stopSync(): void {
		if (this.child && isRunning(this.child)) this.child.kill("SIGTERM");
		this.child = undefined;
		this.active = undefined;
	}

	private spawnServer(model: LiteModel, isHost = false, onLogLine?: (line: string) => void): ChildProcess {
		const args = buildServerArgs(model, isHost);
		mkdirSync(dirname(this.logFile), { recursive: true });
		this.spawnError = undefined;

		if (onLogLine) {
			const fd = openSync(this.logFile, "a");
			let child: ChildProcess;
			try {
				writeSync(fd, `\n=== ${new Date().toISOString()} ${model.llamaServer} ${args.join(" ")}\n`);
				this.logOffset = fstatSync(fd).size;
				child = this.spawnFn(model.llamaServer, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				// The descriptor is closed when the child closes; without a child, close it here.
				closeSync(fd);
				throw error;
			}
			child.once("error", (error) => {
				this.spawnError = error;
			});
			// Both streams go to the log file as they come, and to `onLogLine` one whole line at a time.
			const forward = (stream: NodeJS.ReadableStream | null) => {
				let buffered = "";
				stream?.on("data", (chunk: Buffer) => {
					try {
						writeSync(fd, chunk);
					} catch {}
					buffered += chunk.toString("utf8");
					const lines = buffered.split("\n");
					buffered = lines.pop() ?? "";
					for (const line of lines) {
						if (line.trim()) onLogLine(line);
					}
				});
			};
			forward(child.stdout);
			forward(child.stderr);
			child.once("close", () => {
				try {
					closeSync(fd);
				} catch {}
			});
			return child;
		}

		const fd = openSync(this.logFile, "a");
		try {
			writeSync(fd, `\n=== ${new Date().toISOString()} ${model.llamaServer} ${args.join(" ")}\n`);
			this.logOffset = fstatSync(fd).size;
			const child = this.spawnFn(model.llamaServer, args, { stdio: ["ignore", fd, fd] });
			child.once("error", (error) => {
				this.spawnError = error;
			});
			return child;
		} finally {
			// The child holds its own copy of the descriptor.
			closeSync(fd);
		}
	}

	private async waitUntilReady(
		origin: string,
		child: ChildProcess | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const deadline = Date.now() + this.readyTimeoutMs;
		while (true) {
			signal?.throwIfAborted();
			if (child) this.assertStarting(child);
			if ((await this.health(origin, signal)) === "ready") return;
			if (child) this.assertStarting(child);
			if (Date.now() >= deadline) {
				const seconds = Math.round(this.readyTimeoutMs / 1000);
				throw new Error(`llama-server at ${origin} was not ready after ${seconds}s.${child ? this.logTail() : ""}`);
			}
			await delay(this.pollIntervalMs, undefined, { signal });
		}
	}

	private assertStarting(child: ChildProcess): void {
		if (this.spawnError) {
			if ((this.spawnError as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(
					`llama-server executable not found: ${child.spawnfile}. Install llama.cpp, or set llamaServer in models.yml or $LLAMA_SERVER.`,
				);
			}
			throw new Error(`Could not start llama-server: ${this.spawnError.message}`);
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(
				`llama-server exited (${child.exitCode ?? child.signalCode}) before it was ready.${this.logTail()}`,
			);
		}
	}

	private async health(origin: string, signal: AbortSignal | undefined): Promise<HealthState> {
		const timeout = AbortSignal.timeout(2000);
		try {
			const response = await this.fetchFn(`${origin}/health`, {
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			await response.body?.cancel();
			if (response.ok) return "ready";
			return response.status === 503 ? "loading" : "foreign";
		} catch {
			signal?.throwIfAborted();
			return "down";
		}
	}

	private async servedModelPath(origin: string, signal: AbortSignal | undefined): Promise<string | undefined> {
		try {
			const response = await this.fetchFn(`${origin}/props`, { signal });
			if (!response.ok) return undefined;
			const props = (await response.json()) as { model_path?: unknown };
			return typeof props.model_path === "string" ? props.model_path : undefined;
		} catch {
			signal?.throwIfAborted();
			return undefined;
		}
	}

	/** Last lines this run wrote to the log, for startup errors. */
	private logTail(): string {
		try {
			const fd = openSync(this.logFile, "r");
			try {
				const size = fstatSync(fd).size;
				const start = Math.max(this.logOffset, size - 16_384);
				const buffer = Buffer.alloc(size - start);
				readSync(fd, buffer, 0, buffer.length, start);
				const lines = buffer.toString("utf8").trimEnd().split("\n").slice(-20);
				return lines[0] ? `\n--- ${this.logFile} ---\n${lines.join("\n")}` : "";
			} finally {
				closeSync(fd);
			}
		} catch {
			return "";
		}
	}
}

/** Stop a spawned server when this process exits or receives SIGINT, SIGTERM, or SIGHUP. */
export function stopServerOnExit(manager: LlamaServerManager): void {
	process.once("exit", () => manager.stopSync());
	const signals = [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const;
	for (const [signal, exitCode] of signals) {
		process.once(signal, () => {
			manager.stopSync();
			process.exit(exitCode);
		});
	}
}
