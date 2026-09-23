import { describe, expect, it, vi } from "vitest";
import {
	formatGigabytes,
	parseDarwinSwap,
	parseLinuxMeminfo,
	parseSwapLimit,
	SwapGuard,
	SwapMonitor,
	type SwapUsage,
	underPressure,
} from "../src/llm/swap-monitor.ts";

describe("parseDarwinSwap", () => {
	it("parses standard macOS sysctl vm.swapusage output", () => {
		const output = "total = 2048.00M  used = 387.69M  free = 1660.31M  (encrypted)\n";
		const parsed = parseDarwinSwap(output);
		expect(parsed).toBeDefined();
		expect(parsed?.totalBytes).toBe(2048 * 1024 * 1024);
		expect(parsed?.usedBytes).toBeCloseTo(387.69 * 1024 * 1024, 0);
		expect(parsed?.freeBytes).toBeCloseTo(1660.31 * 1024 * 1024, 0);
	});

	it("parses gigabyte units properly", () => {
		const output = "total = 8.00G  used = 4.50G  free = 3.50G  (encrypted)";
		const parsed = parseDarwinSwap(output);
		expect(parsed).toBeDefined();
		expect(parsed?.totalBytes).toBe(8 * 1024 * 1024 * 1024);
		expect(parsed?.usedBytes).toBe(4.5 * 1024 * 1024 * 1024);
		expect(parsed?.freeBytes).toBe(3.5 * 1024 * 1024 * 1024);
	});

	it("returns undefined for invalid output", () => {
		expect(parseDarwinSwap("invalid output")).toBeUndefined();
	});
});

describe("parseLinuxMeminfo", () => {
	it("parses SwapTotal and SwapFree from /proc/meminfo content", () => {
		const meminfo = `
MemTotal:       16384000 kB
MemFree:         4096000 kB
SwapTotal:       4194304 kB
SwapFree:        1048576 kB
`;
		const parsed = parseLinuxMeminfo(meminfo);
		expect(parsed).toBeDefined();
		expect(parsed?.totalBytes).toBe(4194304 * 1024);
		expect(parsed?.freeBytes).toBe(1048576 * 1024);
		expect(parsed?.usedBytes).toBe((4194304 - 1048576) * 1024);
	});

	it("returns undefined when swap fields are missing", () => {
		expect(parseLinuxMeminfo("MemTotal: 16384000 kB")).toBeUndefined();
	});
});

describe("parseSwapLimit", () => {
	const gb = 1024 * 1024 * 1024;
	it("reads gigabytes by default, and GB or MB units in any case", () => {
		expect(parseSwapLimit("4.5")).toBe(4.5 * gb);
		expect(parseSwapLimit("4.5GB")).toBe(4.5 * gb);
		expect(parseSwapLimit(" 6 g ")).toBe(6 * gb);
		expect(parseSwapLimit("512MB")).toBe(512 * 1024 * 1024);
		expect(parseSwapLimit("512m")).toBe(512 * 1024 * 1024);
		expect(parseSwapLimit(".5")).toBe(0.5 * gb);
	});

	it("rejects anything else instead of reading a prefix", () => {
		for (const text of ["4abc", "4.5 TB", "", "0", "0GB", "-1", "Infinity", "1e3", "4.5.1", "GB"]) {
			expect(parseSwapLimit(text), text).toBeUndefined();
		}
	});
});

describe("formatGigabytes", () => {
	it("formats byte count into gigabytes with 1 decimal", () => {
		expect(formatGigabytes(4.5 * 1024 * 1024 * 1024)).toBe("4.5 GB");
		expect(formatGigabytes(0)).toBe("0.0 GB");
		expect(formatGigabytes(512 * 1024 * 1024)).toBe("0.5 GB");
	});
});

describe("SwapMonitor", () => {
	it("samples usage and triggers onThresholdExceeded when threshold is reached", async () => {
		let currentUsage: SwapUsage = {
			totalBytes: 8 * 1024 * 1024 * 1024,
			usedBytes: 2 * 1024 * 1024 * 1024,
			freeBytes: 6 * 1024 * 1024 * 1024,
		};

		const samples: SwapUsage[] = [];
		const onExceeded = vi.fn();
		const onRecovered = vi.fn();

		const monitor = new SwapMonitor({
			thresholdBytes: 4 * 1024 * 1024 * 1024,
			readUsage: async () => currentUsage,
			onSample: (u) => samples.push(u),
			onThresholdExceeded: onExceeded,
			onRecovered,
		});

		monitor.start();

		// Check 1: below threshold
		await monitor.check();
		expect(samples).toHaveLength(1);
		expect(onExceeded).not.toHaveBeenCalled();
		expect(monitor.isPaused).toBe(false);

		// Check 2: exceed threshold
		currentUsage = {
			totalBytes: 8 * 1024 * 1024 * 1024,
			usedBytes: 4.5 * 1024 * 1024 * 1024,
			freeBytes: 3.5 * 1024 * 1024 * 1024,
		};
		await monitor.check();
		expect(onExceeded).toHaveBeenCalledTimes(1);
		expect(monitor.isPaused).toBe(true);

		// Check 3: while paused and still high, does not re-trigger
		await monitor.check();
		expect(onExceeded).toHaveBeenCalledTimes(1);
		expect(onRecovered).not.toHaveBeenCalled();
		expect(monitor.isPaused).toBe(true);

		// Check 4: drops below threshold, recovers
		currentUsage = {
			totalBytes: 8 * 1024 * 1024 * 1024,
			usedBytes: 1 * 1024 * 1024 * 1024,
			freeBytes: 7 * 1024 * 1024 * 1024,
		};
		await monitor.check();
		expect(onRecovered).toHaveBeenCalledTimes(1);
		expect(monitor.isPaused).toBe(false);

		monitor.stop();
	});

	it("starts paused when swap is already over the threshold, and re-arms once it drops", async () => {
		const gb = 1024 * 1024 * 1024;
		let used = 6 * gb;
		const onExceeded = vi.fn();
		const onRecovered = vi.fn();
		const monitor = new SwapMonitor({
			thresholdBytes: 4 * gb,
			readUsage: async () => ({ totalBytes: 8 * gb, usedBytes: used, freeBytes: 8 * gb - used }),
			onThresholdExceeded: onExceeded,
			onRecovered,
		});

		monitor.start({ paused: true });
		await monitor.check();
		expect(onExceeded).not.toHaveBeenCalled();
		expect(monitor.isPaused).toBe(true);

		used = 2 * gb;
		await monitor.check();
		expect(onRecovered).toHaveBeenCalledTimes(1);

		used = 5 * gb;
		await monitor.check();
		expect(onExceeded).toHaveBeenCalledTimes(1);
		monitor.stop();
	});
});

describe("SwapGuard", () => {
	const gb = 1024 * 1024 * 1024;
	const usage = (used: number) => ({ totalBytes: 16 * gb, usedBytes: used * gb, freeBytes: (16 - used) * gb });

	it("frees memory over the limit, and keeps doing so while each stop brings swap back down", () => {
		const guard = new SwapGuard(4 * gb);
		expect(guard.shouldRecycle(usage(2))).toBe(false);
		expect(guard.shouldRecycle(usage(5))).toBe(true);
		expect(guard.recycled(usage(1))).toBe(false);
		expect(guard.shouldRecycle(usage(5))).toBe(true);
	});

	it("pauses when stopping did not help, and re-arms once swap drops", () => {
		const guard = new SwapGuard(4 * gb);
		expect(guard.shouldRecycle(usage(6))).toBe(true);
		// Other applications hold the swap: stopping the model changed nothing.
		expect(guard.recycled(usage(6))).toBe(true);
		expect(guard.shouldRecycle(usage(6))).toBe(false);
		expect(guard.shouldRecycle(usage(7))).toBe(false);
		expect(guard.shouldRecycle(usage(3))).toBe(false);
		expect(guard.shouldRecycle(usage(5))).toBe(true);
	});

	it("stays armed when swap cannot be read after a stop", () => {
		const guard = new SwapGuard(4 * gb);
		guard.shouldRecycle(usage(5));
		expect(guard.recycled(undefined)).toBe(false);
		expect(guard.shouldRecycle(usage(5))).toBe(true);
	});
});

describe("memory pressure", () => {
	const gb = 1024 * 1024 * 1024;
	const usage = (swap: number, freePercent?: number) => ({
		totalBytes: 16 * gb,
		usedBytes: swap * gb,
		freeBytes: (16 - swap) * gb,
		freePercent,
	});

	it("needs swap over the limit and little free memory, or swap alone without a reading", () => {
		expect(underPressure(usage(6, 5), 4 * gb)).toBe(true);
		expect(underPressure(usage(6, 40), 4 * gb)).toBe(false);
		expect(underPressure(usage(2, 5), 4 * gb)).toBe(false);
		expect(underPressure(usage(6), 4 * gb)).toBe(true);
	});

	it("stays armed when stopping the server freed memory, though swap still reads high", () => {
		const guard = new SwapGuard(4 * gb);
		expect(guard.shouldRecycle(usage(6, 4))).toBe(true);
		// macOS keeps pages in swap until their owner touches them, so the figure barely moves.
		expect(guard.recycled(usage(5.9, 70))).toBe(false);
		expect(guard.shouldRecycle(usage(6, 4))).toBe(true);
	});

	it("pauses when memory stays short without the server, and re-arms once it is not", () => {
		const guard = new SwapGuard(4 * gb);
		expect(guard.shouldRecycle(usage(6, 4))).toBe(true);
		expect(guard.recycled(usage(6, 5))).toBe(true);
		expect(guard.shouldRecycle(usage(6, 4))).toBe(false);
		expect(guard.shouldRecycle(usage(6, 30))).toBe(false);
		expect(guard.shouldRecycle(usage(6, 4))).toBe(true);
	});

	it("does not trigger the serve monitor on swap alone when memory is free", async () => {
		const onExceeded = vi.fn();
		let current = usage(6, 50);
		const monitor = new SwapMonitor({
			thresholdBytes: 4 * gb,
			readUsage: async () => current,
			onThresholdExceeded: onExceeded,
		});
		monitor.start();
		await monitor.check();
		expect(onExceeded).not.toHaveBeenCalled();
		current = usage(6, 3);
		await monitor.check();
		expect(onExceeded).toHaveBeenCalledTimes(1);
		monitor.stop();
	});
});
