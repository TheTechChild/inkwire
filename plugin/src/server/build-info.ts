// The build of this plugin copy (ADR 0001). Node runs the TypeScript source
// directly, so there is no build step and no build file: the build is the
// source. The id is a hash of every file under plugin/src/ server, core,
// shared, link and ui. The hash does not include the folder path: Claude Code
// installs each update into a new cache folder, and the same source in two
// folders is one build.
//
// The order of the builds comes from the build registry,
// <INKWIRE_DATA_DIR>/builds.json: build id → { root, first_seen }. Each relay
// and each daemon registers its build at its start. first_seen is the time the
// data dir saw the build for the first time, and it does not change after
// that. "Newer" means a later first_seen (Decision 7). The daemon reads its
// build one time, at boot (Decision 10); the relay reads it one time, at its
// start. No store or session import: the relay uses this file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** The first 16 hex of the hash of the source of the server and panel, or "unbuilt". */
  id: string;
  /**
   * The first_seen of the build in the build registry (ISO time); null when the
   * build is not registered. The hello keeps the name built_at, so that an old
   * daemon still reads the hello of a new relay.
   */
  built_at: string | null;
}

/** One build in the build registry. */
export interface BuildEntry {
  /** The plugin root of the build (the folder that holds src/). The last relay or daemon to register it sets it. */
  root: string;
  /** ISO time the data dir saw this build for the first time. It does not change. */
  first_seen: string;
}

/** The build registry: build id → entry. */
export type BuildRegistry = Record<string, BuildEntry>;

/** The source folders that make the build id. */
export const BUILD_DIRS = ["server", "core", "shared", "link", "ui"];

/** The file of the build registry in the data dir. */
export const REGISTRY_FILE = "builds.json";

/** plugin/src/, the parent of this file's folder. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The daemon entry of a plugin root. */
export const daemonEntryOf = (root: string) => path.join(root, "src", "server", "daemon.ts");

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

/**
 * The build id of a source folder: the first 16 hex of a sha256 over each
 * relative path and its content, in sorted path order. An unchanged source
 * keeps its id, in any folder. built_at is null: only the registry gives it.
 */
export function readBuildInfo(srcDir: string = SRC_DIR): BuildInfo {
  try {
    const files: string[] = [];
    for (const sub of BUILD_DIRS) {
      const dir = path.join(srcDir, sub);
      if (existsSync(dir)) walk(dir, files);
    }
    if (files.length === 0) return { id: "unbuilt", built_at: null };
    const rel = files.map((f) => path.relative(srcDir, f).split(path.sep).join("/")).sort();
    const hash = createHash("sha256");
    for (const p of rel) {
      hash.update(p);
      hash.update("\0");
      hash.update(readFileSync(path.join(srcDir, p)));
      hash.update("\0");
    }
    return { id: hash.digest("hex").slice(0, 16), built_at: null };
  } catch {
    return { id: "unbuilt", built_at: null };
  }
}

/** The build registry of a data dir. A missing or bad file is an empty registry. */
export function readRegistry(dataDir: string): BuildRegistry {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(dataDir, REGISTRY_FILE), "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: BuildRegistry = {};
    for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
      const entry = e as Partial<BuildEntry> | null;
      if (entry && typeof entry.root === "string" && typeof entry.first_seen === "string" && !Number.isNaN(Date.parse(entry.first_seen))) {
        out[id] = { root: entry.root, first_seen: entry.first_seen };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Register a build in the data dir's registry and give its entry. A known
 * build keeps its first_seen and gets the new root (the old folder can be
 * gone). Other entries whose daemon entry is gone are removed. The write is a
 * rename, so a reader never sees half a file. Two relays that register at the
 * same time can lose one entry; that relay's next start registers it again.
 * Never throws: when the file cannot be written, the entry is still given.
 */
export function registerBuild(dataDir: string, id: string, root: string, now: Date = new Date()): BuildEntry {
  const registry = readRegistry(dataDir);
  const entry: BuildEntry = { root, first_seen: registry[id]?.first_seen ?? now.toISOString() };
  const next: BuildRegistry = {};
  for (const [other, e] of Object.entries(registry)) {
    if (other !== id && existsSync(daemonEntryOf(e.root))) next[other] = e;
  }
  next[id] = entry;
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, REGISTRY_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (err) {
    console.error(`inkwire: cannot write the build registry: ${err instanceof Error ? err.message : String(err)}`);
  }
  return entry;
}

/**
 * The build of a source folder, registered in the data dir: the id from the
 * hash, built_at from the registry's first_seen. An unbuilt source is not
 * registered.
 */
export function currentBuild(dataDir: string, srcDir: string = SRC_DIR): BuildInfo {
  const { id } = readBuildInfo(srcDir);
  if (id === "unbuilt") return { id, built_at: null };
  return { id, built_at: registerBuild(dataDir, id, path.dirname(path.resolve(srcDir))).first_seen };
}

/**
 * The registered builds, newest first_seen first, whose daemon entry is still
 * on disk. Claude Code removes an old cache folder 14 days after an update.
 */
export function liveBuilds(registry: BuildRegistry, exists: (file: string) => boolean = existsSync): { id: string; entry: BuildEntry }[] {
  return Object.entries(registry)
    .map(([id, entry]) => ({ id, entry }))
    .filter((b) => exists(daemonEntryOf(b.entry.root)))
    .sort((a, b) => Date.parse(b.entry.first_seen) - Date.parse(a.entry.first_seen));
}

/**
 * Decision 7: a daemon is stale when the relay's build id differs and the
 * relay's build is newer. The first_seen of each build comes from the
 * registry; a build that is not in it uses its own built_at (an old relay, or
 * a test). A build with no time is older than any build.
 */
export function isNewerBuild(relay: BuildInfo, daemon: BuildInfo, registry: BuildRegistry = {}): boolean {
  if (relay.id === daemon.id) return false;
  const relayAt = registry[relay.id]?.first_seen ?? relay.built_at;
  const daemonAt = registry[daemon.id]?.first_seen ?? daemon.built_at;
  if (relayAt === null) return false;
  if (daemonAt === null) return true;
  return Date.parse(relayAt) > Date.parse(daemonAt);
}
