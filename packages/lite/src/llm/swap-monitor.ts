import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SwapUsage {
	totalBytes: number;
	usedBytes: number;
	freeBytes: number;
}

export function parseDarwinSwap(output: string): SwapUsage | undefined {
	const match = output.match(
		/total\s*=\s*([0-9.]+)([BKMGT]?)\s+used\s*=\s*([0-9.]+)([BKMGT]?)\s+free\s*=\s*([0-9.]+)([BKMGT]?)/i,
	);
	if (!match) return undefined;

	const parseUnit = (value: string, unit: string) => {
		const num = parseFloat(value);
		const u = unit.toUpperCase();
		switch (u) {
			case "T":
				return num * 1024 * 1024 * 1024 * 1024;
			case "G":
				return num * 1024 * 1024 * 1024;
			case "M":
				return num * 1024 * 1024;
			case "K":
				return num * 1024;
			default:
				return num;
		}
	};

	return {
		totalBytes: parseUnit(match[1], match[2]),
		usedBytes: parseUnit(match[3], match[4]),
		freeBytes: parseUnit(match[5], match[6]),
	};
}

export function parseLinuxMeminfo(content: string): SwapUsage | undefined {
	const totalMatch = content.match(/SwapTotal:\s+(\d+)\s+kB/i);
	const freeMatch = content.match(/SwapFree:\s+(\d+)\s+kB/i);
	if (!totalMatch || !freeMatch) return undefined;

	const totalKb = parseInt(totalMatch[1], 10);
	const freeKb = parseInt(freeMatch[1], 10);
	const usedKb = Math.max(0, totalKb - freeKb);

	return {
		totalBytes: totalKb * 1024,
		usedBytes: usedKb * 1024,
		freeBytes: freeKb * 1024,
	};
}

export async function readSwapUsage(): Promise<SwapUsage | undefined> {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("sysctl", ["-n", "vm.swapusage"]);
			return parseDarwinSwap(stdout);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "linux") {
		try {
			const content = readFileSync("/proc/meminfo", "utf8");
			return parseLinuxMeminfo(content);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function formatGigabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const DEFAULT_SWAP_THRESHOLD_BYTES = 4.5 * 1024 * 1024 * 1024; // 4.5 GB

/**
 * `--max-swap` in bytes: gigabytes by default (`4.5`), or with a unit (`4.5GB`, `512MB`, any case). Undefined for
 * anything else, including sizes that are not positive and finite: `parseFloat` would read `512MB` as 512 GB.
 */
export function parseSwapLimit(text: string): number | undefined {
	const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(g|gb|m|mb)?\s*$/i.exec(text);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = (match[2] ?? "g").toLowerCase();
	const bytes = Math.round(value * 1024 * 1024 * (unit.startsWith("g") ? 1024 : 1));
	return bytes > 0 ? bytes : undefined;
}

/**
 * Decides when to free the model's memory between agent turns. Swap is system-wide: when stopping the server did not
 * bring it under the limit, other applications hold it, so the guard pauses until swap drops, instead of reloading
 * the model after every turn.
 */
export class SwapGuard {
	readonly thresholdBytes: number;
	private armed = true;

	constructor(thresholdBytes: number) {
		this.thresholdBytes = thresholdBytes;
	}

	/** Whether to stop the server now. Swap under the limit re-arms a paused guard. */
	shouldRecycle(usage: SwapUsage): boolean {
		if (usage.usedBytes < this.thresholdBytes) {
			this.armed = true;
			return false;
		}
		return this.armed;
	}

	/** Records swap after a stop. Returns true when the guard pauses, because swap stayed over the limit. */
	recycled(after: SwapUsage | undefined): boolean {
		this.armed = after === undefined || after.usedBytes < this.thresholdBytes;
		return !this.armed;
	}
}

export interface SwapMonitorOptions {
	/** Threshold in bytes to trigger. Default: 4.5 GB. */
	thresholdBytes?: number;
	/** Polling interval in ms. Default: 5000ms. */
	pollIntervalMs?: number;
	/** Reader function, defaults to readSwapUsage. */
	readUsage?: () => Promise<SwapUsage | undefined>;
	/** Called on every sample. */
	onSample?: (usage: SwapUsage) => void;
	/** Called when swap usage exceeds thresholdBytes. */
	onThresholdExceeded?: (usage: SwapUsage) => void | Promise<void>;
	/** Called when swap drops back below threshold after being exceeded. */
	onRecovered?: (usage: SwapUsage) => void;
}

export class SwapMonitor {
	readonly thresholdBytes: number;
	private readonly pollIntervalMs: number;
	private readonly readUsage: () => Promise<SwapUsage | undefined>;
	private readonly onSample?: (usage: SwapUsage) => void;
	private readonly onThresholdExceeded?: (usage: SwapUsage) => void | Promise<void>;
	private readonly onRecovered?: (usage: SwapUsage) => void;

	private timer: NodeJS.Timeout | undefined;
	private checking = false;
	private active = false;
	private paused = false;

	constructor(options: SwapMonitorOptions = {}) {
		this.thresholdBytes = options.thresholdBytes ?? DEFAULT_SWAP_THRESHOLD_BYTES;
		this.pollIntervalMs = options.pollIntervalMs ?? 5000;
		this.readUsage = options.readUsage ?? readSwapUsage;
		this.onSample = options.onSample;
		this.onThresholdExceeded = options.onThresholdExceeded;
		this.onRecovered = options.onRecovered;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/**
	 * @param options.paused start with the guard paused, as when swap is already over the threshold before the server
	 *   runs: stopping the server would not bring it down. The guard re-arms once swap drops below the threshold.
	 */
	start(options: { paused?: boolean } = {}): void {
		if (this.active) return;
		this.active = true;
		this.paused = options.paused ?? false;
		this.timer = setInterval(() => {
			void this.check();
		}, this.pollIntervalMs);
		this.timer.unref();
		void this.check();
	}

	stop(): void {
		this.active = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	async check(): Promise<SwapUsage | undefined> {
		if (!this.active || this.checking) return undefined;
		this.checking = true;
		try {
			const usage = await this.readUsage();
			if (!usage) return undefined;
			this.onSample?.(usage);
			if (this.paused) {
				if (usage.usedBytes < this.thresholdBytes) {
					this.paused = false;
					this.onRecovered?.(usage);
				}
				return usage;
			}
			if (usage.usedBytes >= this.thresholdBytes) {
				this.paused = true;
				await this.onThresholdExceeded?.(usage);
			}
			return usage;
		} finally {
			this.checking = false;
		}
	}
}
