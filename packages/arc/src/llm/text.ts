import type { UserMessage } from "./types.ts";

/** The text of a user message, with images shown as `[image]`. */
export function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}
