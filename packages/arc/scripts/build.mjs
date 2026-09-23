#!/usr/bin/env node
// Bundle Arc into one ESM file. One file loads faster and holds less module bookkeeping than hundreds, and it is
// the whole npm package: every library is bundled, so installing Arc downloads no dependencies.
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(packageDir, "dist", "arc.js");

await build({
	entryPoints: [join(packageDir, "src", "cli.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// Bundled CommonJS dependencies call require(); give them one. The entry's hashbang stays on line 1.
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	minify: true,
	legalComments: "none",
	logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`${outfile} (${(statSync(outfile).size / 1024).toFixed(0)}KB)`);
