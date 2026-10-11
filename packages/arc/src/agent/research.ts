import type { AssistantMessage } from "../llm/types.ts";
import type { Agent } from "./agent.ts";

export interface ResearchLimits {
	/** Model turns before the subagent must write its report. */
	maxTurns: number;
	/** Milliseconds before the subagent must write its report. */
	timeoutMs: number;
}

export interface ResearchResult {
	/** The subagent's report: the text of its last reply. */
	answer: string;
	/** Which limit cut the investigation short, if one did. */
	stoppedBy?: "turns" | "time";
	/** Why the run failed, when it ended in an error instead of a report. */
	error?: string;
}

const WRAP_UP = (limit: string) =>
	`You have reached the ${limit} limit for this task. Stop investigating and write your report now from what you have found so far. Say what you could not finish.`;

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

/**
 * Run `task` on `agent` until it answers, then return its last reply. The limits are checked between turns: when one
 * is reached the run stops there, the tools are taken away, and the agent is asked once for its report, so a
 * subagent that runs long still hands back what it found instead of nothing.
 */
export async function runResearch(
	agent: Agent,
	task: string,
	limits: ResearchLimits,
	now: () => number = Date.now,
): Promise<ResearchResult> {
	const deadline = now() + limits.timeoutMs;
	let turns = 0;
	let stoppedBy: ResearchResult["stoppedBy"];
	const unsubscribe = agent.subscribe((event) => {
		if (event.type !== "turn_end" || stoppedBy) return;
		turns++;
		// Only a turn that called tools leads to another; one that answered ends the run anyway.
		const continues = event.toolResults.length > 0;
		if (!continues) return;
		if (turns >= limits.maxTurns) stoppedBy = "turns";
		else if (now() >= deadline) stoppedBy = "time";
		if (stoppedBy) agent.abort();
	});
	try {
		await agent.prompt(task);
		if (stoppedBy) {
			agent.tools = [];
			await agent.prompt(WRAP_UP(stoppedBy === "turns" ? "turn" : "time"));
		}
	} finally {
		unsubscribe();
	}

	const last = [...agent.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	if (!last) return { answer: "", stoppedBy, error: "The subagent did not reply." };
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		return {
			answer: textOf(last),
			stoppedBy,
			error: last.errorMessage ?? `The subagent's reply was ${last.stopReason}.`,
		};
	}
	return { answer: textOf(last), stoppedBy };
}
