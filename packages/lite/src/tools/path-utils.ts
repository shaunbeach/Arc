import { resolve } from "node:path";
import { expandHome } from "../config/paths.ts";

/** Resolve a model-supplied path against the working directory. Accepts `~/` and a leading `@`, a common way to cite files. */
export function resolveToolPath(path: string, cwd: string): string {
	let cleaned = path.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	return resolve(cwd, expandHome(cleaned));
}
