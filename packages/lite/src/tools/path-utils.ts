import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "../config/paths.ts";

/** Resolve a model-supplied path against the working directory. Accepts `~/` and a leading `@`, a common way to cite files. */
export function resolveToolPath(path: string, cwd: string): string {
	let cleaned = path.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	return resolve(cwd, expandHome(cleaned));
}

/** Spaces that look like a plain space. macOS puts U+202F before AM/PM in screenshot names. */
const LOOKALIKE_SPACES = /[       　]/g;

function plainSpaces(name: string): string {
	return name.replace(LOOKALIKE_SPACES, " ");
}

/**
 * The forms a pasted path may take besides the literal one. Dropping a file into a terminal pastes it quoted
 * (`'/a b.png'`), shell-escaped (`/a\ b.png`), or as a `file://` URL; a model passes that on as it is.
 */
function cleanedForms(path: string): string[] {
	const forms = [path];
	let cleaned = path.trim();
	if (cleaned.length > 1 && (cleaned[0] === "'" || cleaned[0] === '"') && cleaned.endsWith(cleaned[0])) {
		cleaned = cleaned.slice(1, -1);
	}
	if (cleaned.startsWith("file://")) {
		try {
			cleaned = fileURLToPath(cleaned);
		} catch {}
	}
	cleaned = cleaned.replace(/\\([ \t()'"&;!$#*?[\]{}<>|~`\\])/g, "$1");
	if (cleaned !== path) forms.push(cleaned);
	return forms;
}

/**
 * The file a model-supplied path most likely means, when it exists: the path as given; else its unquoted,
 * unescaped, or `file://` form; else a file in the same directory whose name matches once look-alike spaces count
 * as plain ones. Undefined when none exists, so callers never act on a guess for a missing file.
 */
export function findExistingPath(path: string, cwd: string): string | undefined {
	const candidates = cleanedForms(path).map((form) => resolveToolPath(form, cwd));
	const exact = candidates.find((candidate) => existsSync(candidate));
	if (exact) return exact;
	for (const candidate of candidates) {
		const dir = dirname(candidate);
		const wanted = plainSpaces(basename(candidate));
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		const match = entries.find((entry) => plainSpaces(entry) === wanted);
		if (match) return join(dir, match);
	}
	return undefined;
}

/** `findExistingPath`, or the path as given when nothing matches. */
export function resolveExistingToolPath(path: string, cwd: string): string {
	return findExistingPath(path, cwd) ?? resolveToolPath(path, cwd);
}

/**
 * Names in the path's directory that look like the one asked for, closest first, so a model that garbled a name
 * (dropped "AM", say) can correct itself. Empty when the directory does not exist or nothing is close.
 */
export function similarNames(path: string, cwd: string, limit = 3): string[] {
	const candidate = resolveToolPath(cleanedForms(path).at(-1) ?? path, cwd);
	const wanted = plainSpaces(basename(candidate)).toLowerCase();
	let entries: string[];
	try {
		entries = readdirSync(dirname(candidate));
	} catch {
		return [];
	}
	const sharedPrefix = (name: string) => {
		const plain = plainSpaces(name).toLowerCase();
		let n = 0;
		while (n < plain.length && n < wanted.length && plain[n] === wanted[n]) n++;
		return n;
	};
	const minimum = Math.max(4, Math.floor(wanted.length / 2));
	return entries
		.map((name) => ({ name, shared: sharedPrefix(name) }))
		.filter((entry) => entry.shared >= minimum)
		.sort((a, b) => b.shared - a.shared)
		.slice(0, limit)
		.map((entry) => entry.name);
}

/** ` Similar files there: "a", "b".` for a not-found error, or nothing. */
export function similarNamesHint(path: string, cwd: string): string {
	const names = similarNames(path, cwd);
	return names.length > 0 ? ` Similar files there: ${names.map((name) => `"${name}"`).join(", ")}.` : "";
}
