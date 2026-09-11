import { diffLines } from "diff";

/** A global character class built from code points, which keeps invisible and look-alike characters out of the source. */
function characterClass(...codePoints: number[]): RegExp {
	return new RegExp(`[${String.fromCodePoint(...codePoints)}]`, "g");
}

/** Left, right, low-9, and high-reversed-9 single quotes. */
const SINGLE_QUOTES = characterClass(0x2018, 0x2019, 0x201a, 0x201b);
/** Left, right, low-9, and high-reversed-9 double quotes. */
const DOUBLE_QUOTES = characterClass(0x201c, 0x201d, 0x201e, 0x201f);
/** Hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar, minus sign. */
const DASHES = characterClass(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
/** No-break space, en space through hair space, narrow no-break space, medium math space, ideographic space. */
const SPECIAL_SPACES = characterClass(
	0x00a0,
	0x2002,
	0x2003,
	0x2004,
	0x2005,
	0x2006,
	0x2007,
	0x2008,
	0x2009,
	0x200a,
	0x202f,
	0x205f,
	0x3000,
);

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIndex = content.indexOf("\r\n");
	const lfIndex = content.indexOf("\n");
	return crlfIndex !== -1 && crlfIndex < lfIndex ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Loosen text for matching: strip trailing whitespace per line, and map typographic quotes, dashes, and special
 * spaces to their ASCII forms. Models routinely get exactly these wrong when copying code.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(SINGLE_QUOTES, "'")
		.replace(DOUBLE_QUOTES, '"')
		.replace(DASHES, "-")
		.replace(SPECIAL_SPACES, " ");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface Replacement {
	/** Offset in the normalized content. */
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/**
 * Apply a replacement found in `baseContent` (a normalized view of `originalContent` with the same line count) to
 * the original. The lines the match touches are rewritten from the normalized view; every other line keeps its
 * original bytes.
 */
function applyPreservingUnchangedLines(originalContent: string, baseContent: string, replacement: Replacement): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = splitLinesWithEndings(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot apply the edit: normalizing the file changed its line count.");
	}

	const matchEnd = replacement.matchIndex + replacement.matchLength;
	let lineStart = 0;
	let firstLine = -1;
	let groupStart = 0;
	for (let i = 0; i < baseLines.length; i++) {
		const lineEnd = lineStart + baseLines[i].length;
		if (firstLine === -1 && replacement.matchIndex < lineEnd) {
			firstLine = i;
			groupStart = lineStart;
		}
		if (firstLine !== -1 && matchEnd <= lineEnd) {
			const group = baseContent.slice(groupStart, lineEnd);
			const local = replacement.matchIndex - groupStart;
			const rewritten = group.slice(0, local) + replacement.newText + group.slice(local + replacement.matchLength);
			return originalLines.slice(0, firstLine).join("") + rewritten + originalLines.slice(i + 1).join("");
		}
		lineStart = lineEnd;
	}
	throw new Error("Cannot apply the edit: the match lies outside the file.");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Replace the single occurrence of `oldText` in LF-normalized `content`. Exact matching comes first; failing that,
 * matching uses `normalizeForFuzzyMatch`, and only the lines the match touches take the normalized form.
 */
export function applyEdit(content: string, oldText: string, newText: string, path: string): string {
	const target = normalizeToLF(oldText);
	const replacement = normalizeToLF(newText);
	if (target.length === 0) throw new Error("oldText is empty.");
	const duplicate = (count: number) =>
		new Error(`oldText occurs ${count} times in ${path}. Include more surrounding lines so it matches exactly once.`);

	let updated: string;
	const exactCount = countOccurrences(content, target);
	if (exactCount === 1) {
		const index = content.indexOf(target);
		updated = content.slice(0, index) + replacement + content.slice(index + target.length);
	} else if (exactCount > 1) {
		throw duplicate(exactCount);
	} else {
		const fuzzyContent = normalizeForFuzzyMatch(content);
		const fuzzyTarget = normalizeForFuzzyMatch(target);
		const fuzzyCount = fuzzyTarget ? countOccurrences(fuzzyContent, fuzzyTarget) : 0;
		if (fuzzyCount === 0) {
			throw new Error(
				`Could not find oldText in ${path}. It must match the file exactly, including whitespace and indentation; read the file again and copy the text.`,
			);
		}
		if (fuzzyCount > 1) throw duplicate(fuzzyCount);
		updated = applyPreservingUnchangedLines(content, fuzzyContent, {
			matchIndex: fuzzyContent.indexOf(fuzzyTarget),
			matchLength: fuzzyTarget.length,
			newText: replacement,
		});
	}
	if (updated === content) throw new Error(`newText is identical to oldText; ${path} is unchanged.`);
	return updated;
}

/**
 * Line-numbered diff for display: changed lines with up to `contextLines` of context around each change.
 * Also returns the first changed line number in the new content.
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = diffLines(oldContent, newContent);
	const output: string[] = [];
	const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const numbered = (prefix: string, lineNumber: number, line: string) =>
		`${prefix}${String(lineNumber).padStart(width, " ")} ${line}`;

	let oldLine = 1;
	let newLine = 1;
	let firstChangedLine: number | undefined;
	const context = (line: string) => {
		output.push(numbered(" ", oldLine, line));
		oldLine++;
		newLine++;
	};
	const skip = (count: number, marker: boolean) => {
		if (count <= 0) return;
		if (marker) output.push(` ${"".padStart(width, " ")} ...`);
		oldLine += count;
		newLine += count;
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const lines = part.value.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLine;
			for (const line of lines) {
				if (part.added) output.push(numbered("+", newLine++, line));
				else output.push(numbered("-", oldLine++, line));
			}
			continue;
		}

		// diffLines never emits two unchanged parts in a row, so neighbors of an unchanged part are changes.
		const afterChange = i > 0;
		const beforeChange = i < parts.length - 1;
		if (afterChange && beforeChange) {
			if (lines.length <= contextLines * 2) {
				lines.forEach(context);
			} else {
				lines.slice(0, contextLines).forEach(context);
				skip(lines.length - contextLines * 2, true);
				lines.slice(lines.length - contextLines).forEach(context);
			}
		} else if (afterChange) {
			lines.slice(0, contextLines).forEach(context);
			skip(lines.length - contextLines, true);
		} else if (beforeChange) {
			skip(lines.length - contextLines, true);
			lines.slice(Math.max(0, lines.length - contextLines)).forEach(context);
		} else {
			skip(lines.length, false);
		}
	}
	return { diff: output.join("\n"), firstChangedLine };
}
