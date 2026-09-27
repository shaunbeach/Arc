#!/usr/bin/env node
// Bundle Arc into one ESM file. One file loads faster and holds less module bookkeeping than hundreds, and it is
// the whole npm package: every library is bundled, so installing Arc downloads no dependencies.
import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(packageDir, "dist", "arc.js");
// The commit the bundle was built from, for run reports; "-dirty" when the tree had uncommitted changes.
let commit = "unknown";
try {
	const git = (...args) => execFileSync("git", args, { cwd: packageDir, encoding: "utf8" }).trim();
	commit = `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? "-dirty" : ""}`;
} catch {}

await build({
	entryPoints: [join(packageDir, "src", "cli.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// Bundled CommonJS dependencies call require(); give them one. The entry's hashbang stays on line 1.
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	define: { "process.env.ARC_COMMIT": JSON.stringify(commit) },
	minify: true,
	legalComments: "none",
	logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`${outfile} (${(statSync(outfile).size / 1024).toFixed(0)}KB)`);
