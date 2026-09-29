import { Type } from "typebox";
import type { AgentTool } from "../agent/types.ts";
import { articleText, selectPassages } from "../rag/article.ts";
import { type KnowledgeBase, normalizeArticleId } from "../rag/kiwix.ts";
import type { ToolLimits } from "./options.ts";

const baseSchema = Type.Object({
	query: Type.String(),
	article: Type.Optional(Type.String({ description: "One from the results, to read" })),
});

const shelfSchema = Type.Object({
	query: Type.String(),
	article: Type.Optional(Type.String({ description: "One from the results, to read" })),
	shelf: Type.Optional(Type.String()),
});

type KbSearchSchema = typeof baseSchema | typeof shelfSchema;

const RESULTS = 5;
const SNIPPET_CHARS = 200;

/**
 * Search the offline archives, or read the parts of one article that match the query. One tool for both keeps the
 * prompt small, and reading here rather than through web_fetch works in every mode and returns clean text.
 *
 * With a `shelves.yml`, the tool takes a shelf, and the shelf names go in the parameter's description (about ten
 * tokens per shelf). A search without one is routed by the query's keywords, since small models skip optional
 * arguments.
 */
export function createKbSearchTool(kb: KnowledgeBase, limits: ToolLimits): AgentTool<KbSearchSchema> {
	const shelves = kb.shelves ?? [];
	const shelfNames = shelves.map((shelf) => shelf.name).join(", ");
	const parameters: KbSearchSchema =
		shelves.length === 0
			? baseSchema
			: Type.Object({
					...shelfSchema.properties,
					shelf: Type.Optional(Type.String({ description: `Limit search to one of: ${shelfNames}` })),
				});
	return {
		name: "kb_search",
		label: "kb",
		description: "Search offline Wikipedia and programming docs. With article, read its parts matching query.",
		parameters,
		async execute(_toolCallId, args, signal, onUpdate) {
			const { query, article } = args;
			const shelf = "shelf" in args ? args.shelf : undefined;
			const q = query.trim();
			if (article?.trim()) {
				let id = normalizeArticleId(article);
				onUpdate?.({ content: [{ type: "text", text: `Reading ${id}…` }] });
				let html = await kb.article(id, signal);
				// Small models often pass the title from the results instead of the article id beneath it.
				if (html === undefined && kb.resolveArticle) {
					const resolved = await kb.resolveArticle(id, q, signal, shelf?.trim() || undefined);
					if (resolved && resolved !== id) {
						html = await kb.article(resolved, signal);
						if (html !== undefined) id = resolved;
					}
				}
				if (html === undefined) {
					throw new Error(
						`No article "${id}" in the knowledge base. Pass the article line from kb_search results, such as <archive>/<path>.`,
					);
				}
				const { title, text } = articleText(html);
				const passages = selectPassages(text, q || title, limits.maxBytes);
				return { content: [{ type: "text", text: `${title} (${id}):\n\n${passages}` }] };
			}

			if (!q) throw new Error("query is required.");
			onUpdate?.({ content: [{ type: "text", text: `Searching the knowledge base for "${q}"…` }] });
			const results = await kb.search(q, RESULTS, signal, shelf?.trim() || undefined);
			const { total, hits } = results;
			const empty = results.emptyShelf ? `Nothing on shelf ${results.emptyShelf}; searched every shelf. ` : "";
			if (hits.length === 0) {
				return { content: [{ type: "text", text: `${empty}Nothing in the knowledge base matches "${q}".` }] };
			}
			const formatted = hits
				.map((hit, i) => {
					const snippet =
						hit.snippet.length > SNIPPET_CHARS ? `${hit.snippet.slice(0, SNIPPET_CHARS)}…` : hit.snippet;
					return `${i + 1}. ${hit.title} (${hit.book})\n   article: ${hit.article}${snippet ? `\n   ${snippet}` : ""}`;
				})
				.join("\n\n");
			const more = total > hits.length ? ` (${total} matches; showing ${hits.length})` : "";
			const from = results.shelf ? ` on shelf ${results.shelf}` : "";
			// A search that went to every archive names the shelves, so the next one can narrow.
			const narrow = !results.shelf && shelves.length > 0 ? ` Narrow a search with shelf: ${shelfNames}.` : "";
			return {
				content: [
					{
						type: "text",
						text: `${empty}Knowledge base results for "${q}"${from}${more}:\n\n${formatted}\n\nRead one with kb_search, passing its article.${narrow}`,
					},
				],
			};
		},
	};
}
