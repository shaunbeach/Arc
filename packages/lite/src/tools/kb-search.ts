import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { articleText, selectPassages } from "../rag/article.ts";
import { type KnowledgeBase, normalizeArticleId } from "../rag/kiwix.ts";
import type { ToolLimits } from "./options.ts";

const kbSearchSchema = Type.Object({
	query: Type.String(),
	article: Type.Optional(Type.String({ description: "One from the results, to read" })),
});

const RESULTS = 5;
const SNIPPET_CHARS = 200;

/**
 * Search the offline archives, or read the parts of one article that match the query. One tool for both keeps the
 * prompt small, and reading here rather than through web_fetch works in every mode and returns clean text.
 */
export function createKbSearchTool(kb: KnowledgeBase, limits: ToolLimits): AgentTool<typeof kbSearchSchema> {
	return {
		name: "kb_search",
		label: "kb",
		description: "Search offline Wikipedia and programming docs. With article, read its parts matching query.",
		parameters: kbSearchSchema,
		async execute(_toolCallId, { query, article }, signal, onUpdate) {
			const q = query.trim();
			if (article?.trim()) {
				const id = normalizeArticleId(article);
				onUpdate?.({ content: [{ type: "text", text: `Reading ${id}…` }] });
				const html = await kb.article(id, signal);
				if (html === undefined) {
					throw new Error(`No article "${id}" in the knowledge base. Use an article from kb_search results.`);
				}
				const { title, text } = articleText(html);
				const passages = selectPassages(text, q || title, limits.maxBytes);
				return { content: [{ type: "text", text: `${title} (${id}):\n\n${passages}` }] };
			}

			if (!q) throw new Error("query is required.");
			onUpdate?.({ content: [{ type: "text", text: `Searching the knowledge base for "${q}"…` }] });
			const { total, hits } = await kb.search(q, RESULTS, signal);
			if (hits.length === 0) {
				return { content: [{ type: "text", text: `Nothing in the knowledge base matches "${q}".` }] };
			}
			const formatted = hits
				.map((hit, i) => {
					const snippet =
						hit.snippet.length > SNIPPET_CHARS ? `${hit.snippet.slice(0, SNIPPET_CHARS)}…` : hit.snippet;
					return `${i + 1}. ${hit.title} (${hit.book})\n   article: ${hit.article}${snippet ? `\n   ${snippet}` : ""}`;
				})
				.join("\n\n");
			const more = total > hits.length ? ` (${total} matches; showing ${hits.length})` : "";
			return {
				content: [
					{
						type: "text",
						text: `Knowledge base results for "${q}"${more}:\n\n${formatted}\n\nRead one with kb_search, passing its article.`,
					},
				],
			};
		},
	};
}
