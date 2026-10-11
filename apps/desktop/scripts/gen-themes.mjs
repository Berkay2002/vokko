// Regenerates src/styles/themes.generated.css and src/styles/THEMES.md from src/styles/themes/palettes.ts.
//   npm run themes
// The generator is TypeScript shared with the tests, so this runs the theme test file in "update" mode (vitest compiles the .ts);
// the same file, run without UPDATE_THEMES, fails when the committed output is stale.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// npm hoists dependencies to the workspace root; fall back to a local install.
const vitest = [join(root, "node_modules", "vitest", "vitest.mjs"), join(root, "..", "..", "node_modules", "vitest", "vitest.mjs")].find(existsSync);
if (!vitest) throw new Error("vitest is not installed: run npm ci");
const result = spawnSync(process.execPath, [vitest, "run", "src/styles/themes/themes.test.ts", "-t", "generated files are current"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, UPDATE_THEMES: "1" },
});
process.exit(result.status ?? 1);
