// The plugin's npm package: plugin/package.json and plugin/package-lock.json.
//
// Claude Code copies plugin/ into its cache and installs the npm dependencies
// from plugin/package.json and plugin/package-lock.json. It installs only
// exact registry versions and runs no install scripts. plugin/package.json is
// not a Yarn workspace: the root package.json has no "workspaces", so Yarn
// ignores it. scripts/lock-plugin.ts writes both files from the root
// "dependencies" (the runtime deps) at the versions that yarn.lock resolves.
// scripts/check-plugin.ts checks them.
import { readFileSync } from "node:fs";
import path from "node:path";

export const PLUGIN_SOURCE = "./plugin";
export const PLUGIN_NAME = "inkwire";
export const REGISTRY = "https://registry.npmjs.org/";
export const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export interface PackageJson {
  name?: string;
  private?: boolean;
  description?: string;
  type?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
  overrides?: unknown;
}

export interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * The versions that yarn.lock resolves, by descriptor ("zod@npm:^4.1.0").
 * A yarn.lock entry key lists one or more descriptors; the "version:" line
 * below it is the resolved version.
 */
export function yarnResolutions(lockText: string): Map<string, string> {
  const out = new Map<string, string>();
  let keys: string[] = [];
  for (const line of lockText.split("\n")) {
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#") && line.endsWith(":")) {
      keys = line
        .slice(0, -1)
        .split(", ")
        .map((k) => k.replace(/^"|"$/g, ""));
      continue;
    }
    const version = /^ {2}version: "?([^"\s]+)"?$/.exec(line)?.[1];
    if (version !== undefined) for (const key of keys) out.set(key, version);
  }
  return out;
}

/**
 * The runtime deps of the root package.json at the exact versions that
 * yarn.lock resolves, sorted by name. Each problem goes to `errors`.
 */
export function runtimeDependencies(root: string, errors: string[]): Record<string, string> {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  const resolved = yarnResolutions(readFileSync(path.join(root, "yarn.lock"), "utf8"));
  const deps: Record<string, string> = {};
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    const range = pkg.dependencies![name]!;
    const version = resolved.get(`${name}@npm:${range}`) ?? (EXACT_VERSION.test(range) ? range : undefined);
    if (version === undefined) {
      errors.push(`yarn.lock: no resolution for ${name}@${range}. Run "yarn install".`);
      continue;
    }
    deps[name] = version;
  }
  return deps;
}

/** The node major version in .nvmrc ("26.11.1" gives "26"). */
export function nodeMajor(root: string): string {
  const major = /^v?(\d+)/.exec(readFileSync(path.join(root, ".nvmrc"), "utf8").trim())?.[1];
  if (major === undefined) throw new Error(".nvmrc: no node version");
  return major;
}

/** The plugin/package.json that Claude Code installs from. */
export function pluginPackageJson(root: string, dependencies: Record<string, string>): PackageJson {
  return {
    name: PLUGIN_NAME,
    private: true,
    description:
      'The runtime dependencies of the inkwire plugin. Do not edit: "yarn lock-plugin" writes this file from the root package.json and yarn.lock.',
    type: "module",
    engines: { node: `>=${nodeMajor(root)}` },
    dependencies,
  };
}
