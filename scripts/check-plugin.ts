// Checks the marketplace, the plugin manifest and the plugin's npm package.
//
// Usage: node scripts/check-plugin.ts   (yarn check-plugin)
//
// The plugin root is plugin/. It has no "version" (in plugin.json or in the
// marketplace entry): Claude Code then uses the commit SHA, so each merge to
// main is an update. Node runs the TypeScript source in plugin/src, so
// plugin/ holds no build output and no node_modules. plugin/package.json
// and plugin/package-lock.json give the runtime deps that Claude Code
// installs; "yarn lock-plugin" writes them.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXACT_VERSION,
  type Lockfile,
  type PackageJson,
  PLUGIN_NAME,
  PLUGIN_SOURCE,
  REGISTRY,
  pluginPackageJson,
  readJson,
  runtimeDependencies,
  yarnVersionsByName,
} from "./plugin-package.ts";

interface Marketplace {
  plugins?: { name?: string; source?: unknown; version?: unknown }[];
}

interface Manifest {
  name?: string;
  version?: unknown;
  types?: string;
  hooks?: unknown;
}

const PLUGIN_ROOT_REF = /\$\{CLAUDE_PLUGIN_ROOT\}"?\/([^"\s]+)/g;
const LOCK_HINT = 'Run "yarn lock-plugin".';

function sameRecord(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every((k) => a[k] === b[k]);
}

/** Every string in a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Every plugin file that a "${CLAUDE_PLUGIN_ROOT}/..." string names. */
function pluginRootRefs(value: unknown): string[] {
  return strings(value).flatMap((s) => [...s.matchAll(PLUGIN_ROOT_REF)].map((m) => m[1]!));
}

function checkMarketplace(root: string, fail: (m: string) => void): void {
  const file = path.join(root, ".claude-plugin", "marketplace.json");
  if (!existsSync(file)) return fail(".claude-plugin/marketplace.json: missing.");
  const plugins = readJson<Marketplace>(file).plugins ?? [];
  if (plugins.length !== 1 || plugins[0]?.name !== PLUGIN_NAME || plugins[0]?.source !== PLUGIN_SOURCE) {
    fail(`.claude-plugin/marketplace.json: list one plugin, "${PLUGIN_NAME}", with the source "${PLUGIN_SOURCE}".`);
  }
  for (const entry of plugins) {
    if (entry.version !== undefined) {
      fail(`.claude-plugin/marketplace.json: remove the version of ${entry.name}. Git sets it (the commit SHA).`);
    }
  }
}

/** `rel` is relative to `dir`; `shown` is how a message names `dir`. */
function checkFile(dir: string, shown: string, rel: string, from: string, fail: (m: string) => void, exec = false): void {
  const file = path.join(dir, rel);
  const name = path.posix.join(shown, rel);
  if (!existsSync(file)) return fail(`${from}: names ${name}, which does not exist.`);
  if (exec && (statSync(file).mode & 0o111) === 0) fail(`${from}: ${name} is not executable.`);
}

function checkManifest(pluginDir: string, fail: (m: string) => void): void {
  const file = path.join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(file)) return fail("plugin/.claude-plugin/plugin.json: missing.");
  const manifest = readJson<Manifest>(file);
  const from = "plugin/.claude-plugin/plugin.json";
  if (manifest.name !== PLUGIN_NAME) fail(`${from}: the name must be "${PLUGIN_NAME}".`);
  if (manifest.version !== undefined) fail(`${from}: remove the version. Git sets it (the commit SHA).`);
  if (typeof manifest.types === "string") checkFile(pluginDir, "plugin", manifest.types, from, fail);
  for (const ref of pluginRootRefs(manifest)) checkFile(pluginDir, "plugin", ref, from, fail);

  // The hooks file: the default hooks/hooks.json, or the paths in "hooks".
  const hookFiles = strings(manifest.hooks).filter((s) => s.endsWith(".json"));
  if (hookFiles.length === 0) hookFiles.push("./hooks/hooks.json");
  for (const rel of hookFiles) {
    const hooksPath = path.join(pluginDir, rel);
    const hooksFrom = path.posix.join("plugin", rel);
    if (!existsSync(hooksPath)) {
      if (strings(manifest.hooks).length > 0) fail(`${from}: names ${hooksFrom}, which does not exist.`);
      continue;
    }
    const hooks = readJson<{ modules?: unknown; hooks?: unknown }>(hooksPath);
    // A mod module path is relative to the hooks file.
    const hooksDir = path.posix.dirname(hooksFrom);
    for (const mod of strings(hooks.modules)) checkFile(path.dirname(hooksPath), hooksDir, mod, hooksFrom, fail);
    for (const ref of pluginRootRefs(hooks.hooks)) checkFile(pluginDir, "plugin", ref, hooksFrom, fail, true);
  }
}

function checkPackage(root: string, pluginDir: string, fail: (m: string) => void): void {
  const file = path.join(pluginDir, "package.json");
  if (!existsSync(file)) return fail(`plugin/package.json: missing. ${LOCK_HINT}`);
  const pkg = readJson<PackageJson>(file);
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!EXACT_VERSION.test(version)) fail(`plugin/package.json: ${name} must be an exact version, not "${version}".`);
  }
  if (pkg.devDependencies !== undefined) fail("plugin/package.json: remove devDependencies. Claude Code would install them.");
  if (pkg.scripts !== undefined) fail("plugin/package.json: remove scripts.");
  if (pkg.overrides !== undefined) fail("plugin/package.json: remove overrides. Claude Code skips the install when they are set.");

  const errors: string[] = [];
  const deps = runtimeDependencies(root, errors);
  errors.forEach(fail);
  if (errors.length > 0) return;
  if (!sameRecord(pkg.dependencies, deps)) {
    fail(`plugin/package.json: the dependencies are not the root runtime deps at the yarn.lock versions. ${LOCK_HINT}`);
  } else if (JSON.stringify(pkg) !== JSON.stringify(pluginPackageJson(root, deps))) {
    fail(`plugin/package.json: it is not the file that "yarn lock-plugin" writes. ${LOCK_HINT}`);
  }

  const lockPath = path.join(pluginDir, "package-lock.json");
  if (!existsSync(lockPath)) return fail(`plugin/package-lock.json: missing. ${LOCK_HINT}`);
  const lock = readJson<Lockfile>(lockPath);
  if (lock.lockfileVersion !== 3) fail("plugin/package-lock.json: lockfileVersion must be 3.");
  const packages = lock.packages ?? {};
  if (!sameRecord(packages[""]?.dependencies, pkg.dependencies)) {
    fail(`plugin/package-lock.json: the dependencies do not match plugin/package.json. ${LOCK_HINT}`);
  }
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    const locked = packages[`node_modules/${name}`]?.version;
    if (locked !== version) {
      fail(`plugin/package-lock.json: ${name} is ${locked ?? "missing"}, but plugin/package.json has ${version}. ${LOCK_HINT}`);
    }
  }
  // Each package, also a transitive one, at a version that yarn.lock resolves for its name:
  // the tests run on Yarn's tree, and users get npm's tree.
  const yarnVersions = yarnVersionsByName(readFileSync(path.join(root, "yarn.lock"), "utf8"));
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") continue;
    if (entry.link || !entry.resolved?.startsWith(REGISTRY) || !entry.integrity) {
      fail(`plugin/package-lock.json: ${key} must be an npm registry package with an integrity hash.`);
    }
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const versions = yarnVersions.get(name);
    if (entry.version === undefined || !versions?.has(entry.version)) {
      const have = versions ? [...versions].join(", ") : "none";
      fail(`plugin/package-lock.json: ${key} is ${entry.version ?? "missing"}, but yarn.lock resolves ${name} to ${have}. ${LOCK_HINT}`);
    }
  }
}

/** Checks the plugin in the repo at `root`. Returns one message for each problem. */
export function checkPlugin(root: string): string[] {
  const errors: string[] = [];
  const fail = (m: string): void => {
    errors.push(m);
  };
  const pluginDir = path.join(root, "plugin");

  const rootPkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (rootPkg.workspaces !== undefined) {
    fail('package.json: remove "workspaces". plugin/package.json must not be a Yarn workspace.');
  }
  checkMarketplace(root, fail);
  checkManifest(pluginDir, fail);
  checkPackage(root, pluginDir, fail);
  for (const dir of ["node_modules", "dist"]) {
    if (existsSync(path.join(pluginDir, dir))) {
      fail(`plugin/${dir}: remove it. The plugin runs from source, and Claude Code installs its node_modules.`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = checkPlugin(fileURLToPath(new URL("..", import.meta.url)));
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  console.error("plugin: OK (marketplace, manifest, hooks, package.json, package-lock.json).");
}
