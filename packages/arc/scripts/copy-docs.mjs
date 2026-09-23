#!/usr/bin/env node
// npm packs README and LICENSE only from the package directory, but they live at the repository root.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["README.md", "LICENSE"]) {
	copyFileSync(join(packageDir, "..", "..", name), join(packageDir, name));
}
