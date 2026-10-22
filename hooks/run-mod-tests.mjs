#!/usr/bin/env node
// Runs the tests of the inkwire mod (hooks/mod/*.test.tsx) with
// `claude plugin test`. That command runs every *.test.ts and *.test.tsx in
// the plugin folder, and the plugin folder is the repo root, so it would also
// run the vitest files in tests/. This script copies only the manifest and
// hooks/ to a temp folder and runs the command there. `yarn mod:test` runs it.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "inkwire-mod-"));
let status = 1;
try {
  cpSync(join(root, ".claude-plugin", "plugin.json"), join(dir, ".claude-plugin", "plugin.json"));
  cpSync(join(root, "hooks"), join(dir, "hooks"), { recursive: true });
  const run = spawnSync("claude", ["plugin", "test", dir], { stdio: "inherit" });
  if (run.error) console.error(`mod:test: cannot run claude: ${run.error.message}`);
  status = run.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
