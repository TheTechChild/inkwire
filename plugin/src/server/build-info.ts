// The build of this plugin copy (ADR 0001, as ADR 0005 changes it). Node runs
// the TypeScript source directly, so there is no build step and no build file:
// the build is the source. The id is a hash of every file under plugin/src/
// server, core, shared, link and ui, plus the npm package of the plugin
// (package.json, package-lock.json) and the fonts. So a release that changes
// only a dependency is a new build too. The hash does not include the folder
// path: Claude Code installs each update into a new cache folder, and the same
// source in two folders is one build.
//
// The order of the builds comes from the build registry,
// <INKWIRE_DATA_DIR>/builds.json: build id → { root, first_seen, last_seen,
// pids }. Each relay registers its build at its start, and each daemon at boot.
// "Newer" (Decision 7, as ADR 0005 changes it) means:
//   1. A build in the Claude Code plugin cache is newer than a build from a
//      checkout (a --plugin-dir run or yarn start on the same data dir).
//   2. Then the later last_seen: the last time that a relay of a new Claude
//      Code process registered the build. New sessions run the version that
//      the person installed now, also after a downgrade or a pin to an older
//      commit. A relay that starts again in the same Claude Code process (the
//      same pid) does not change last_seen, and a daemon never changes it.
// One folder holds one build at a time: a registration removes the other ids
// of its root. The daemon reads its build one time, at boot (Decision 10); the
// relay reads it one time, at its start. No store or session import: the
// relay uses this file.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** The first 16 hex of the hash of the source of the server and panel, or "unbuilt". */
  id: string;
  /**
   * The last_seen of the build in the build registry (ISO time); null when the
   * build is not registered. The hello keeps the name built_at, so that an old
   * daemon still reads the hello of a new relay.
   */
  built_at: string | null;
}

/** One build in the build registry. */
export interface BuildEntry {
  /** The plugin root of the build (the folder that holds src/). The last relay or daemon to register it sets it. */
  root: string;
  /** ISO time the data dir saw this build for the first time. It does not change. Only for people to read. */
  first_seen: string;
  /** ISO time a relay of a new Claude Code process registered this build for the last time. It sets the order. */
  last_seen: string;
  /** The Claude Code pids whose relays registered this build, the last one at the end (at most PIDS_KEPT). */
  pids: number[];
}

/** The build registry: build id → entry. */
export type BuildRegistry = Record<string, BuildEntry>;

/** The source folders that make the build id. */
export const BUILD_DIRS = ["server", "core", "shared", "link", "ui"];

/** The files and folders of the plugin root (not of src/) that make the build id too. */
export const BUILD_ROOT_PARTS = ["package.json", "package-lock.json", path.join("assets", "fonts")];

/** The file of the build registry in the data dir. */
export const REGISTRY_FILE = "builds.json";

/** The number of Claude Code pids that an entry keeps. */
export const PIDS_KEPT = 16;

/** How long a registration waits for the lock, and the age of a lock that a dead process left. */
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 5000;

/** plugin/src/, the parent of this file's folder. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The daemon entry of a plugin root. */
export const daemonEntryOf = (root: string) => path.join(root, "src", "server", "daemon.ts");

/** True when a plugin root is a Claude Code install (~/.claude/plugins/cache/...), not a checkout. */
export function isInstalledRoot(root: string): boolean {
  return /[\\/]plugins[\\/]cache[\\/]/.test(root);
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

/**
 * The build id of a source folder: the first 16 hex of a sha256 over each
 * relative path and its content, in sorted path order. The files are the
 * BUILD_DIRS of the source and the BUILD_ROOT_PARTS of its plugin root (the
 * parent of the source). An unchanged plugin keeps its id, in any folder.
 * built_at is null: only the registry gives it.
 */
export function readBuildInfo(srcDir: string = SRC_DIR): BuildInfo {
  try {
    const root = path.dirname(path.resolve(srcDir));
    const src: string[] = [];
    for (const sub of BUILD_DIRS) {
      const dir = path.join(srcDir, sub);
      if (existsSync(dir)) walk(dir, src);
    }
    if (src.length === 0) return { id: "unbuilt", built_at: null };
    const files = [...src];
    for (const part of BUILD_ROOT_PARTS) {
      const full = path.join(root, part);
      if (!existsSync(full)) continue;
      if (statSync(full).isDirectory()) walk(full, files);
      else files.push(full);
    }
    const rel = files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
    const hash = createHash("sha256");
    for (const p of rel) {
      hash.update(p);
      hash.update("\0");
      hash.update(readFileSync(path.join(root, p)));
      hash.update("\0");
    }
    return { id: hash.digest("hex").slice(0, 16), built_at: null };
  } catch {
    return { id: "unbuilt", built_at: null };
  }
}

const validTime = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t));

/** The entries of a parsed registry file. A bad entry is skipped. An entry from before last_seen uses first_seen. */
function parseRegistry(raw: unknown): BuildRegistry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: BuildRegistry = {};
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    const entry = e as Partial<BuildEntry> | null;
    if (!entry || typeof entry.root !== "string" || !validTime(entry.first_seen)) continue;
    const pids = Array.isArray(entry.pids) ? entry.pids.filter((p): p is number => Number.isInteger(p)) : [];
    out[id] = {
      root: entry.root,
      first_seen: entry.first_seen,
      last_seen: validTime(entry.last_seen) ? entry.last_seen : entry.first_seen,
      pids,
    };
  }
  return out;
}

/** The build registry of a data dir. A missing or bad file is an empty registry. */
export function readRegistry(dataDir: string): BuildRegistry {
  try {
    return parseRegistry(JSON.parse(readFileSync(path.join(dataDir, REGISTRY_FILE), "utf8"))) ?? {};
  } catch {
    return {};
  }
}

/**
 * The registry for a write. A file that is there but bad is not written over:
 * it moves to builds.json.bad (for a person to read), and the registry starts
 * empty. The order then comes from the next registrations: the next new
 * session registers the installed build with the latest last_seen.
 */
function readRegistryForWrite(dataDir: string): BuildRegistry {
  const file = path.join(dataDir, REGISTRY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: BuildRegistry | null = null;
  try {
    parsed = parseRegistry(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (parsed !== null) return parsed;
  try {
    renameSync(file, `${file}.bad`);
    console.error(`inkwire: the build registry ${file} is bad; it moved to ${file}.bad, and a new registry starts`);
  } catch (err) {
    console.error(`inkwire: the build registry ${file} is bad: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {};
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn while this process holds <dataDir>/builds.json.lock (made with the
 * wx flag), so two processes do not lose an entry. A lock older than
 * LOCK_STALE_MS is from a process that stopped: it is removed. After
 * LOCK_WAIT_MS, or when the lock cannot be made, fn runs with no lock.
 */
function withRegistryLock<T>(dataDir: string, fn: () => T): T {
  const lock = path.join(dataDir, `${REGISTRY_FILE}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        console.error(`inkwire: the build registry lock ${lock} stays; the registration continues with no lock`);
        break;
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

export interface RegisterOptions {
  /** The time of this registration. Default now. */
  now?: Date;
  /** The Claude Code pid of a relay (its ppid). A relay of a pid that the entry has already does not change last_seen. */
  pid?: number;
  /**
   * False for a daemon at boot and for a relay that registers again before an
   * autostart: last_seen does not change, and a new entry gets `now`. Default true.
   */
  touch?: boolean;
}

/**
 * Register a build in the data dir's registry and give its entry. A known
 * build keeps its first_seen and gets the new root (the old folder can be
 * gone). last_seen changes to `now` when `touch` is on and the pid is new for
 * this build. Other entries are removed when their daemon entry is gone or
 * when they have the same root (one folder holds one build at a time). The
 * read and the write occur under a lock file, and the write is a rename, so a
 * reader never sees half a file. Never throws: when the file cannot be
 * written, the entry is still given.
 */
export function registerBuild(dataDir: string, id: string, root: string, opts: RegisterOptions = {}): BuildEntry {
  const at = (opts.now ?? new Date()).toISOString();
  const touch = opts.touch ?? true;
  const ownRoot = path.resolve(root);
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // The write below fails and logs.
  }
  return withRegistryLock(dataDir, () => {
    const registry = readRegistryForWrite(dataDir);
    const prev = registry[id];
    const newPid = opts.pid === undefined || !(prev?.pids ?? []).includes(opts.pid);
    const pids = opts.pid === undefined ? (prev?.pids ?? []) : [...(prev?.pids ?? []).filter((p) => p !== opts.pid), opts.pid].slice(-PIDS_KEPT);
    const entry: BuildEntry = {
      root,
      first_seen: prev?.first_seen ?? at,
      last_seen: prev === undefined || (touch && newPid) ? at : prev.last_seen,
      pids,
    };
    const next: BuildRegistry = {};
    for (const [other, e] of Object.entries(registry)) {
      if (other !== id && path.resolve(e.root) !== ownRoot && existsSync(daemonEntryOf(e.root))) next[other] = e;
    }
    next[id] = entry;
    try {
      const file = path.join(dataDir, REGISTRY_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
      renameSync(tmp, file);
    } catch (err) {
      console.error(`inkwire: cannot write the build registry: ${err instanceof Error ? err.message : String(err)}`);
    }
    return entry;
  });
}

/**
 * The build of a source folder, registered in the data dir: the id from the
 * hash, built_at from the registry's last_seen. An unbuilt source is not
 * registered.
 */
export function currentBuild(dataDir: string, srcDir: string = SRC_DIR, opts: Omit<RegisterOptions, "now"> = {}): BuildInfo {
  const { id } = readBuildInfo(srcDir);
  if (id === "unbuilt") return { id, built_at: null };
  return { id, built_at: registerBuild(dataDir, id, path.dirname(path.resolve(srcDir)), opts).last_seen };
}

/** The order key of a build: an installed build first, then the later time. */
interface Rank {
  installed: boolean;
  at: number;
}

const rankOf = (entry: BuildEntry): Rank => ({ installed: isInstalledRoot(entry.root), at: Date.parse(entry.last_seen) });

/** Positive when a is newer than b. */
function compareRank(a: Rank, b: Rank): number {
  if (a.installed !== b.installed) return a.installed ? 1 : -1;
  return a.at - b.at;
}

/**
 * The registered builds, newest first, whose daemon entry is still on disk.
 * Claude Code removes an old cache folder 14 days after an update.
 */
export function liveBuilds(registry: BuildRegistry, exists: (file: string) => boolean = existsSync): { id: string; entry: BuildEntry }[] {
  return Object.entries(registry)
    .map(([id, entry]) => ({ id, entry }))
    .filter((b) => exists(daemonEntryOf(b.entry.root)))
    .sort((a, b) => compareRank(rankOf(b.entry), rankOf(a.entry)));
}

/**
 * Decision 7: a daemon is stale when the relay's build id differs and the
 * relay's build is newer. The rank of each build comes from the registry; a
 * build that is not in it is a checkout build at its own built_at (an old
 * relay, or a test). A build with no time is older than any build.
 */
export function isNewerBuild(relay: BuildInfo, daemon: BuildInfo, registry: BuildRegistry = {}): boolean {
  if (relay.id === daemon.id) return false;
  const rank = (b: BuildInfo): Rank | null => {
    const entry = registry[b.id];
    if (entry) return rankOf(entry);
    return b.built_at === null ? null : { installed: false, at: Date.parse(b.built_at) };
  };
  const relayRank = rank(relay);
  const daemonRank = rank(daemon);
  if (relayRank === null) return false;
  if (daemonRank === null) return true;
  return compareRank(relayRank, daemonRank) > 0;
}
