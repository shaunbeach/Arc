import { htmlToMarkdown } from "../tools/web-fetch.ts";
import { unescapeHtml } from "../tools/web-search.ts";

/** Words that never name a topic, left out when matching a query against titles and sections. */
const STOP_WORDS = new Set(
	"a an and are as at be by can do does for from how in is it of on or the to was what when where which who why with".split(
		" ",
	),
);

/** The words of `text` that could name a topic, lowercased. */
export function topicWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word && !STOP_WORDS.has(word));
}

/** Sections that list sources and links rather than say anything. */
const BACK_MATTER =
	/^(references|notes|citations|footnotes|sources|bibliography|further reading|external links|see also|other websites|related pages|notes and references)$/i;

/**
 * Remove each element whose opening tag matches `open`, with everything inside it. Counts nested elements of the
 * same tag, which a single regex cannot: a Wikipedia sidebar is a table holding tables.
 */
function removeElements(html: string, tag: string, open: RegExp): string {
	const any = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
	let out = "";
	let from = 0;
	for (;;) {
		open.lastIndex = from;
		const start = open.exec(html);
		if (!start) break;
		any.lastIndex = start.index + start[0].length;
		let depth = 1;
		let end = html.length;
		for (let match = any.exec(html); match; match = any.exec(html)) {
			depth += match[1] ? -1 : 1;
			if (depth === 0) {
				end = match.index + match[0].length;
				break;
			}
		}
		out += html.slice(from, start.index);
		from = end;
	}
	return out + html.slice(from);
}

/** A formula as its TeX source, which reads far better than MathML flattened to one symbol per line. */
function mathText(alttext: string): string {
	const tex = unescapeHtml(alttext)
		.replace(/^\{\\displaystyle\s*/, "")
		.replace(/\}$/, "")
		.trim();
	return tex ? ` $${tex}$ ` : "";
}

/**
 * An archive page as plain text: formulas as TeX, and without links, citation marks, sidebars, info boxes,
 * navigation boxes, and trailing reference lists.
 */
export function articleText(html: string): { title: string; text: string } {
	const title = unescapeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
	let body = html
		.replace(/<math\b[^>]*?alttext="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi, (_, alttext: string) => mathText(alttext))
		.replace(/<sup\b[^>]*class="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "")
		.replace(/<a\b[^>]*>|<\/a>/gi, "");
	body = removeElements(
		body,
		"table",
		/<table\b[^>]*class="[^"]*\b(?:sidebar|infobox|navbox|vertical-navbox)\b[^"]*"[^>]*>/gi,
	);
	body = removeElements(body, "div", /<div\b[^>]*class="[^"]*\b(?:navbox|reflist|hatnote|metadata)\b[^"]*"[^>]*>/gi);

	const lines: string[] = [];
	let inCode = false;
	let blank = false;
	for (const raw of htmlToMarkdown(body, Number.MAX_SAFE_INTEGER).split("\n")) {
		if (raw.trimStart().startsWith("```")) inCode = !inCode;
		// Page source indentation survives the conversion; only code keeps its own.
		const line = inCode ? raw : raw.trim().replace(/[ \t]{2,}/g, " ");
		if (!line && blank) continue;
		lines.push(line);
		blank = !line;
	}
	return { title, text: lines.join("\n").trim() };
}

interface Section {
	heading: string;
	level: number;
	body: string;
}

function splitSections(text: string): Section[] {
	const sections: Section[] = [{ heading: "", level: 0, body: "" }];
	let inCode = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("```")) inCode = !inCode;
		const heading = inCode ? undefined : /^(#{1,4}) (.+)$/.exec(line);
		if (heading) sections.push({ heading: heading[2].trim(), level: heading[1].length, body: "" });
		else sections[sections.length - 1].body += `${line}\n`;
	}
	// Reference lists, "See also", and the like, with their subsections.
	const kept: Section[] = [];
	let skipBelow = 0;
	for (const section of sections) {
		if (skipBelow && section.level > skipBelow) continue;
		skipBelow = 0;
		if (section.level > 0 && BACK_MATTER.test(section.heading)) {
			skipBelow = section.level;
			continue;
		}
		section.body = section.body.trim();
		kept.push(section);
	}
	return kept;
}

function hits(text: string, terms: readonly string[]): number {
	const lower = text.toLowerCase();
	let count = 0;
	for (const term of terms) {
		for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) count++;
	}
	return count;
}

/** The paragraphs of `body` that mention the query most, within `room` characters, in their original order. */
function bestParagraphs(body: string, terms: readonly string[], room: number): string {
	const paragraphs = body.split(/\n{2,}/);
	const ranked = paragraphs
		.map((text, index) => ({ text, index, score: hits(text, terms) }))
		.sort((a, b) => b.score - a.score || a.index - b.index);
	const chosen: typeof ranked = [];
	let used = 0;
	for (const paragraph of ranked) {
		if (used + paragraph.text.length + 2 > room) continue;
		chosen.push(paragraph);
		used += paragraph.text.length + 2;
	}
	if (chosen.length === 0) return `${body.slice(0, Math.max(0, room - 2))}…`;
	chosen.sort((a, b) => a.index - b.index);
	let out = "";
	let last = -1;
	for (const paragraph of chosen) {
		if (out) out += paragraph.index === last + 1 ? "\n\n" : "\n\n…\n\n";
		out += paragraph.text;
		last = paragraph.index;
	}
	return out;
}

function sectionText(section: Section, body = section.body): string {
	return section.level === 0 ? body : `${"#".repeat(section.level)} ${section.heading}\n\n${body}`.trim();
}

/**
 * The parts of an article that answer `query`, within `budget` characters. A whole Wikipedia article can hold
 * 40,000 tokens, more than a small window; this keeps the opening paragraphs, then the sections that mention the
 * query most, in the article's own order, and names the sections left out so the model can ask for one.
 */
export function selectPassages(text: string, query: string, budget: number): string {
	if (text.length <= budget) return text;
	const sections = splitSections(text);
	const terms = [...new Set(topicWords(query))];
	const chosen = new Map<number, string>();
	let used = 0;

	const lead = sections[0];
	if (lead.body) {
		const leadRoom = Math.floor(budget * 0.3);
		const leadText = lead.body.length <= leadRoom ? lead.body : bestParagraphs(lead.body, [], leadRoom);
		chosen.set(0, leadText);
		used += leadText.length;
	}

	const ranked = sections
		.map((section, index) => ({
			index,
			score: hits(section.body, terms) + 5 * hits(section.heading, terms),
			length: sectionText(section).length,
		}))
		.filter((entry) => entry.index > 0);
	const anyMatch = ranked.some((entry) => entry.score > 0);
	// With no section mentioning the query, read the article from the top.
	ranked.sort((a, b) => (anyMatch ? b.score - a.score : 0) || a.index - b.index);
	for (const entry of ranked) {
		if (anyMatch && entry.score === 0) break;
		const room = budget - used;
		if (room < 400) break;
		const section = sections[entry.index];
		if (entry.length + 2 <= room) {
			chosen.set(entry.index, sectionText(section));
			used += entry.length + 2;
		} else if (entry.score > 0 || chosen.size <= 1) {
			const trimmed = sectionText(section, bestParagraphs(section.body, terms, room - section.heading.length - 10));
			chosen.set(entry.index, trimmed);
			used += trimmed.length + 2;
		}
	}

	const shown = [...chosen.keys()].sort((a, b) => a - b);
	const omitted = sections
		.map((section, index) => ({ section, index }))
		.filter(({ section, index }) => index > 0 && !chosen.has(index) && section.level <= 2)
		.map(({ section }) => section.heading);
	let out = shown.map((index) => chosen.get(index)).join("\n\n");
	if (omitted.length > 0) {
		const list = omitted.slice(0, 12).join("; ") + (omitted.length > 12 ? "; …" : "");
		out += `\n\n[Other sections: ${list}. To read one, call kb_search again with this article and its name as the query.]`;
	}
	return out;
}
