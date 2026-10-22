// Writes plugin/package.json and plugin/package-lock.json again, then runs
// the plugin check.
//
// Usage: node scripts/lock-plugin.ts   (yarn lock-plugin)
//
// Run it after a change to the root "dependencies" or to yarn.lock. The
// package.json gets the root runtime deps at the exact versions that
// yarn.lock resolves. npm writes the lockfile (v3) in a temp folder outside
// the Yarn project, so that npm does not see the root node_modules. The temp
// folder has a yarn v1 lockfile made from yarn.lock (yarnV1Lockfile) and no
// old package-lock.json: npm then resolves each package, also a transitive
// one, to the version that yarn.lock resolves.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlugin } from "./check-plugin.ts";
import { REGISTRY, pluginPackageJson, runtimeDependencies, yarnV1Lockfile } from "./plugin-package.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = path.join(ROOT, "plugin");

function writeLockfile(dir: string): void {
  const work = mkdtempSync(path.join(tmpdir(), "inkwire-plugin-lock-"));
  try {
    copyFileSync(path.join(dir, "package.json"), path.join(work, "package.json"));
    writeFileSync(path.join(work, "yarn.lock"), yarnV1Lockfile(readFileSync(path.join(ROOT, "yarn.lock"), "utf8")));
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${REGISTRY}`],
      { cwd: work, stdio: ["ignore", "ignore", "inherit"] },
    );
    copyFileSync(path.join(work, "package-lock.json"), path.join(dir, "package-lock.json"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const errors: string[] = [];
const deps = runtimeDependencies(ROOT, errors);
if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
writeFileSync(path.join(PLUGIN_DIR, "package.json"), `${JSON.stringify(pluginPackageJson(ROOT, deps), null, 2)}\n`);
writeLockfile(PLUGIN_DIR);
console.error("plugin: wrote package.json and package-lock.json.");

const problems = checkPlugin(ROOT);
for (const p of problems) console.error(p);
process.exit(problems.length > 0 ? 1 : 0);
