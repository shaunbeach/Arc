import type { ToolCall } from "../llm/types.ts";

/** How many of the latest tool calls the guard compares. */
const WINDOW = 5;
/** Identical calls within the window that count as a loop. */
const REPEATS = 3;

function describe(call: ToolCall): string {
	const args = call.arguments;
	const detail = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "";
	const line = detail.split("\n")[0];
	return line ? `${call.name} ${line.length > 80 ? `${line.slice(0, 80)}...` : line}` : call.name;
}

/**
 * Notices an actor going in circles: the same tool call, with the same arguments, 3 times among its last 5 calls.
 * That catches a command run again and again, and two commands alternating. A small model in such a loop seldom
 * leaves it by itself; failing the attempt gives it the checks' output and a fresh instruction instead.
 */
export class RepeatGuard {
	private recent: string[] = [];

	/** Record a call. Returns why the turn should stop, when this call completes a loop. */
	check(call: ToolCall): string | undefined {
		const key = `${call.name}\0${JSON.stringify(call.arguments)}`;
		this.recent = [...this.recent, key].slice(-WINDOW);
		const count = this.recent.filter((seen) => seen === key).length;
		if (count < REPEATS) return undefined;
		return `it made the same call ${count} times in its last ${this.recent.length}: ${describe(call)}`;
	}
}
