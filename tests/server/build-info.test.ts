// The build id is the hash of the plugin source (build-info.ts): Node runs the
// source, so there is no build step and no build file. The build registry
// (<dataDir>/builds.json) orders the builds (an installed build first, then the
// later last_seen), and a relay starts the daemon of the newest build that is
// still on disk (autostart.ts).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PIDS_KEPT,
  REGISTRY_FILE,
  currentBuild,
  daemonEntryOf,
  isNewerBuild,
  liveBuilds,
  readBuildInfo,
  readRegistry,
  registerBuild,
} from "../../plugin/src/server/build-info.ts";
import { daemonRoots, pickDaemonRoot } from "../../plugin/src/link/autostart.ts";
import { root, tempDir } from "../integration/daemon-helpers.ts";

/** A plugin root with a small source: <root>/src/server/daemon.ts and <root>/src/ui/main.ts. */
function pluginRoot(name = "build-info"): string {
  const root = path.join(tempDir(name), "plugin");
  const src = path.join(root, "src");
  for (const sub of ["server", "ui"]) mkdirSync(path.join(src, sub), { recursive: true });
  writeFileSync(path.join(src, "server", "daemon.ts"), 'console.error("daemon");\n');
  writeFileSync(path.join(src, "ui", "main.ts"), "export {};\n");
  return root;
}

const srcOf = (root: string) => path.join(root, "src");

describe("readBuildInfo", () => {
  it("gives the same id for the same source, and no built_at (only the registry gives it)", () => {
    const src = srcOf(pluginRoot());
    const a = readBuildInfo(src);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(a.built_at).toBeNull();
    expect(readBuildInfo(src)).toEqual(a);
  });

  it("gives the same id for the same source in another folder (a new cache folder per update)", () => {
    const root = pluginRoot();
    const copy = path.join(tempDir("build-info-copy"), "sha-b");
    cpSync(root, copy, { recursive: true });
    expect(readBuildInfo(srcOf(copy)).id).toBe(readBuildInfo(srcOf(root)).id);
  });

  it("gives another id when a file changes", () => {
    const src = srcOf(pluginRoot());
    const a = readBuildInfo(src);
    writeFileSync(path.join(src, "server", "daemon.ts"), 'console.error("daemoN");\n');
    expect(readBuildInfo(src).id).not.toBe(a.id);
  });

  it("ignores a folder that is not part of the build", () => {
    const src = srcOf(pluginRoot());
    const a = readBuildInfo(src);
    mkdirSync(path.join(src, "notes"));
    writeFileSync(path.join(src, "notes", "x.txt"), "not part of the build\n");
    expect(readBuildInfo(src).id).toBe(a.id);
  });

  it("is unbuilt when there is no source", () => {
    expect(readBuildInfo(path.join(tempDir("build-info-none"), "src"))).toEqual({ id: "unbuilt", built_at: null });
  });

  it("reads this plugin's source by default", () => {
    expect(readBuildInfo().id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the build id covers the npm package and the fonts of the plugin", () => {
  it("gives another id when only package-lock.json, package.json or a font changes (a release with only a dependency change)", () => {
    const root = pluginRoot("build-info-deps");
    writeFileSync(path.join(root, "package.json"), '{"dependencies":{"ws":"8.0.0"}}\n');
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/ws":{"version":"8.0.0"}}}\n');
    mkdirSync(path.join(root, "assets", "fonts"), { recursive: true });
    writeFileSync(path.join(root, "assets", "fonts", "a.ttf"), "font-1");
    const ids = [readBuildInfo(srcOf(root)).id];
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/ws":{"version":"8.0.1"}}}\n');
    ids.push(readBuildInfo(srcOf(root)).id);
    writeFileSync(path.join(root, "package.json"), '{"dependencies":{"ws":"8.0.1"}}\n');
    ids.push(readBuildInfo(srcOf(root)).id);
    writeFileSync(path.join(root, "assets", "fonts", "a.ttf"), "font-2");
    ids.push(readBuildInfo(srcOf(root)).id);
    expect(new Set(ids).size).toBe(4);
  });
});

/** A registry entry for the order tests. */
const entry = (root: string, last_seen: string, first_seen = last_seen) => ({ root, first_seen, last_seen, pids: [] });
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** A cache folder of a Claude Code install, as the plugin cache names it. */
const cacheRoot = (sha: string) => path.join(tempDir(`cache-${sha}`), ".claude", "plugins", "cache", "inkwire", "inkwire", sha);
function installedRoot(sha: string): string {
  const root = cacheRoot(sha);
  mkdirSync(path.join(root, "src", "server"), { recursive: true });
  writeFileSync(path.join(root, "src", "server", "daemon.ts"), `// ${sha}\n`);
  return root;
}

describe("the build registry", () => {
  it("registers a build with its root, first_seen and last_seen; first_seen stays, the root moves to the last folder", () => {
    const dataDir = tempDir("registry");
    const a = pluginRoot("registry-a");
    const b = pluginRoot("registry-b");
    const t1 = at("2026-10-01");
    const t2 = at("2026-10-02");
    expect(registerBuild(dataDir, "aaaa", a, { now: t1, pid: 11 })).toEqual({ root: a, first_seen: t1.toISOString(), last_seen: t1.toISOString(), pids: [11] });
    // The same build from another folder (a docs-only commit) in a new session: the root is the new folder.
    expect(registerBuild(dataDir, "aaaa", b, { now: t2, pid: 12 })).toEqual({ root: b, first_seen: t1.toISOString(), last_seen: t2.toISOString(), pids: [11, 12] });
    expect(readRegistry(dataDir)).toEqual({ aaaa: { root: b, first_seen: t1.toISOString(), last_seen: t2.toISOString(), pids: [11, 12] } });
    expect(JSON.parse(readFileSync(path.join(dataDir, REGISTRY_FILE), "utf8"))).toEqual(readRegistry(dataDir));
  });

  it("a relay that starts again in the same Claude Code process, and a daemon, do not change last_seen", () => {
    const dataDir = tempDir("registry-touch");
    const a = pluginRoot("registry-touch-a");
    registerBuild(dataDir, "aaaa", a, { now: at("2026-10-01"), pid: 11 });
    expect(registerBuild(dataDir, "aaaa", a, { now: at("2026-10-05"), pid: 11 }).last_seen).toBe(at("2026-10-01").toISOString());
    expect(registerBuild(dataDir, "aaaa", a, { now: at("2026-10-06"), touch: false }).last_seen).toBe(at("2026-10-01").toISOString());
    // A daemon that registers a build that is not there yet gives it `now`.
    const b = pluginRoot("registry-touch-b");
    expect(registerBuild(dataDir, "bbbb", b, { now: at("2026-10-07"), touch: false })).toEqual(entry(b, at("2026-10-07").toISOString()));
    // A new pid moves last_seen.
    expect(registerBuild(dataDir, "aaaa", a, { now: at("2026-10-08"), pid: 12 }).last_seen).toBe(at("2026-10-08").toISOString());
  });

  it("keeps the last PIDS_KEPT pids", () => {
    const dataDir = tempDir("registry-pids");
    const a = pluginRoot("registry-pids-a");
    for (let pid = 1; pid <= PIDS_KEPT + 3; pid++) registerBuild(dataDir, "aaaa", a, { pid });
    expect(readRegistry(dataDir).aaaa!.pids).toEqual(Array.from({ length: PIDS_KEPT }, (_, i) => i + 4));
  });

  it("removes other entries whose daemon entry is gone, and keeps the one it registers", () => {
    const dataDir = tempDir("registry-prune");
    const a = pluginRoot("registry-prune-a");
    const gone = pluginRoot("registry-prune-gone");
    registerBuild(dataDir, "gone", gone, { now: at("2026-10-01") });
    registerBuild(dataDir, "aaaa", a, { now: at("2026-10-02") });
    renameSync(gone, `${gone}-removed`);
    registerBuild(dataDir, "bbbb", path.join(tempDir("registry-prune-nowhere"), "plugin"), { now: at("2026-10-03") });
    expect(Object.keys(readRegistry(dataDir)).sort()).toEqual(["aaaa", "bbbb"]);
  });

  it("one folder holds one build: a new id of a root removes the old id of that root", () => {
    // A checkout that changes (git checkout, an edit, a revert): the old id must not point at the folder.
    const dataDir = tempDir("registry-one-root");
    const c = pluginRoot("registry-one-root-c");
    const n = pluginRoot("registry-one-root-n");
    registerBuild(dataDir, "nnnn", n, { now: at("2026-10-03") });
    registerBuild(dataDir, "cccc", c, { now: at("2026-10-04") });
    registerBuild(dataDir, "aaaa", `${c}${path.sep}`, { now: at("2026-10-05"), touch: false });
    expect(Object.keys(readRegistry(dataDir)).sort()).toEqual(["aaaa", "nnnn"]);
  });

  it("is empty when the file is missing or bad, skips bad entries, and reads an entry with no last_seen", () => {
    const dataDir = tempDir("registry-bad");
    expect(readRegistry(dataDir)).toEqual({});
    writeFileSync(path.join(dataDir, REGISTRY_FILE), "{not json");
    expect(readRegistry(dataDir)).toEqual({});
    writeFileSync(
      path.join(dataDir, REGISTRY_FILE),
      JSON.stringify({ ok: { root: "/r", first_seen: "2026-10-01T00:00:00.000Z" }, bad: { root: 1 }, worse: { root: "/r", first_seen: "x" } }),
    );
    expect(readRegistry(dataDir)).toEqual({ ok: entry("/r", "2026-10-01T00:00:00.000Z") });
  });

  it("does not write over a bad file: it moves to builds.json.bad, and a new registry starts", () => {
    const dataDir = tempDir("registry-bad-write");
    const file = path.join(dataDir, REGISTRY_FILE);
    writeFileSync(file, '{"aaaa": {"root": "/a", "first_seen": "2026-10-0');
    const a = pluginRoot("registry-bad-write-a");
    registerBuild(dataDir, "nnnn", a, { now: at("2026-10-05"), pid: 7 });
    expect(readFileSync(`${file}.bad`, "utf8")).toBe('{"aaaa": {"root": "/a", "first_seen": "2026-10-0');
    expect(Object.keys(readRegistry(dataDir))).toEqual(["nnnn"]);
    // An old session's relay that starts again after this, in its old Claude Code
    // process, cannot pass the new build: a new process moves last_seen, and the
    // installed build of each new session comes first again.
    const o = pluginRoot("registry-bad-write-o");
    registerBuild(dataDir, "oooo", o, { now: at("2026-10-06"), pid: 3 });
    registerBuild(dataDir, "nnnn", a, { now: at("2026-10-07"), pid: 8 });
    expect(liveBuilds(readRegistry(dataDir)).map((b) => b.id)).toEqual(["nnnn", "oooo"]);
  });

  it("two processes that register at the same time lose no entry (the lock file)", async () => {
    const dataDir = tempDir("registry-race");
    const n = 8;
    const roots = Array.from({ length: n }, (_, i) => pluginRoot(`registry-race-${i}`));
    const module = pathToFileURL(path.join(root, "plugin", "src", "server", "build-info.ts")).href;
    const script = `const { registerBuild } = await import(${JSON.stringify(module)});
const [dataDir, id, root] = process.argv.slice(1);
for (let i = 0; i < 20; i++) registerBuild(dataDir, id + "-" + i, root + "-" + i);
registerBuild(dataDir, id, root);`;
    await Promise.all(
      roots.map(
        (r, i) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir, `id${i}`, r], { stdio: ["ignore", "ignore", "pipe"] });
            let err = "";
            child.stderr.on("data", (c) => (err += String(c)));
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
          }),
      ),
    );
    expect(Object.keys(readRegistry(dataDir)).sort()).toEqual(roots.map((_, i) => `id${i}`).sort());
    expect(existsSync(path.join(dataDir, `${REGISTRY_FILE}.lock`))).toBe(false);
  }, 30_000);

  it("removes a lock that a process that stopped left", () => {
    const dataDir = tempDir("registry-stale-lock");
    const lock = path.join(dataDir, `${REGISTRY_FILE}.lock`);
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const a = pluginRoot("registry-stale-lock-a");
    registerBuild(dataDir, "aaaa", a);
    expect(Object.keys(readRegistry(dataDir))).toEqual(["aaaa"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("currentBuild hashes the source, registers its plugin root and gives last_seen as built_at", () => {
    const dataDir = tempDir("registry-current");
    const root = pluginRoot("registry-current-root");
    const first = currentBuild(dataDir, srcOf(root), { pid: 21 });
    expect(first.id).toBe(readBuildInfo(srcOf(root)).id);
    expect(first.built_at).not.toBeNull();
    expect(readRegistry(dataDir)[first.id]).toEqual({ root, first_seen: first.built_at, last_seen: first.built_at, pids: [21] });
    // A second start of the same build in the same process gives the same time.
    expect(currentBuild(dataDir, srcOf(root), { pid: 21 })).toEqual(first);
  });

  it("does not register an unbuilt source", () => {
    const dataDir = tempDir("registry-unbuilt");
    expect(currentBuild(dataDir, path.join(tempDir("registry-unbuilt-src"), "src"))).toEqual({ id: "unbuilt", built_at: null });
    expect(existsSync(path.join(dataDir, REGISTRY_FILE))).toBe(false);
  });
});

describe("the order of the builds (Decision 7)", () => {
  const registry = {
    old: entry("/old", "2026-10-01T00:00:00.000Z"),
    new: entry("/new", "2026-10-05T00:00:00.000Z"),
  };

  it("compares last_seen from the registry, not the built_at of the hello", () => {
    // The hellos say the reverse; the registry wins.
    const oldHello = { id: "old", built_at: "2026-10-09T00:00:00.000Z" };
    const newHello = { id: "new", built_at: "2026-09-01T00:00:00.000Z" };
    expect(isNewerBuild(newHello, oldHello, registry)).toBe(true);
    expect(isNewerBuild(oldHello, newHello, registry)).toBe(false);
  });

  it("is never newer for the same id", () => {
    expect(isNewerBuild({ id: "new", built_at: null }, { id: "new", built_at: null }, registry)).toBe(false);
  });

  it("uses built_at for a build that is not registered, and a build with no time is the oldest", () => {
    expect(isNewerBuild({ id: "x", built_at: "2026-10-08T00:00:00.000Z" }, { id: "old", built_at: null }, registry)).toBe(true);
    expect(isNewerBuild({ id: "x", built_at: "2026-09-08T00:00:00.000Z" }, { id: "old", built_at: null }, registry)).toBe(false);
    expect(isNewerBuild({ id: "x", built_at: null }, { id: "y", built_at: "2026-09-08T00:00:00.000Z" })).toBe(false);
    expect(isNewerBuild({ id: "x", built_at: "2026-09-08T00:00:00.000Z" }, { id: "y", built_at: null })).toBe(true);
  });

  it("liveBuilds gives the newest first and skips a build whose daemon entry is gone", () => {
    const exists = (f: string) => f !== daemonEntryOf("/new");
    expect(liveBuilds(registry).map((b) => b.id)).toEqual([]);
    expect(liveBuilds(registry, () => true).map((b) => b.id)).toEqual(["new", "old"]);
    expect(liveBuilds(registry, exists).map((b) => b.id)).toEqual(["old"]);
  });

  it("an installed build comes before a checkout build, also an older one", () => {
    const installed = cacheRoot("sha1");
    const mixed = {
      inst: entry(installed, "2026-10-01T00:00:00.000Z"),
      wip: entry("/Users/x/projects/inkwire/plugin", "2026-10-09T00:00:00.000Z"),
    };
    expect(liveBuilds(mixed, () => true).map((b) => b.id)).toEqual(["inst", "wip"]);
    expect(isNewerBuild({ id: "wip", built_at: null }, { id: "inst", built_at: null }, mixed)).toBe(false);
    expect(isNewerBuild({ id: "inst", built_at: null }, { id: "wip", built_at: null }, mixed)).toBe(true);
  });
});

describe("the daemon that a relay starts (autostart)", () => {
  it("a stale old relay starts the daemon of the newer registered build", () => {
    const dataDir = tempDir("autostart-pick");
    const oldRoot = pluginRoot("autostart-old");
    const newRoot = pluginRoot("autostart-new");
    registerBuild(dataDir, "old", oldRoot, { now: at("2026-10-01"), pid: 1 });
    registerBuild(dataDir, "new", newRoot, { now: at("2026-10-05"), pid: 2 });
    // The old relay starts again in its old Claude Code process: its last_seen stays older.
    registerBuild(dataDir, "old", oldRoot, { now: at("2026-10-09"), pid: 1 });
    expect(pickDaemonRoot(dataDir, oldRoot)).toBe(newRoot);
  });

  it("a downgrade takes effect: a new session of the older build makes it the newest, also while the newer folder is on disk", () => {
    const dataDir = tempDir("autostart-downgrade");
    const a = installedRoot("shaA");
    const b = installedRoot("shaB");
    registerBuild(dataDir, "aaaa", a, { now: at("2026-10-01"), pid: 1 });
    registerBuild(dataDir, "bbbb", b, { now: at("2026-10-02"), pid: 2 });
    expect(pickDaemonRoot(dataDir, a)).toBe(b);
    // The person pins A again; the next session runs A.
    const relayA = { id: "aaaa", built_at: registerBuild(dataDir, "aaaa", a, { now: at("2026-10-03"), pid: 3 }).last_seen };
    expect(pickDaemonRoot(dataDir, a)).toBe(a);
    expect(isNewerBuild(relayA, { id: "bbbb", built_at: null }, readRegistry(dataDir))).toBe(true);
    expect(daemonRoots(dataDir, a)).toEqual([a, b]);
  });

  it("a checkout run on the same data dir does not take over the autostart of the installed build", () => {
    const dataDir = tempDir("autostart-checkout");
    const installed = installedRoot("shaN");
    const checkout = pluginRoot("autostart-checkout-wip");
    registerBuild(dataDir, "nnnn", installed, { now: at("2026-10-01"), pid: 1 });
    registerBuild(dataDir, "wip0", checkout, { now: at("2026-10-05"), pid: 2 });
    expect(pickDaemonRoot(dataDir, installed)).toBe(installed);
    expect(daemonRoots(dataDir, installed)).toEqual([installed, checkout]);
    // With no installed build on the data dir (the dev data dir), the checkout runs.
    renameSync(installed, `${installed}-removed`);
    expect(pickDaemonRoot(dataDir, checkout)).toBe(checkout);
  });

  it("starts the next newest build when the newest folder is gone, and its own build when none is left", () => {
    const dataDir = tempDir("autostart-gone");
    const oldRoot = pluginRoot("autostart-gone-old");
    const newRoot = pluginRoot("autostart-gone-new");
    const own = pluginRoot("autostart-gone-own");
    registerBuild(dataDir, "old", oldRoot, { now: at("2026-10-01") });
    registerBuild(dataDir, "new", newRoot, { now: at("2026-10-05") });
    renameSync(newRoot, `${newRoot}-removed`);
    expect(pickDaemonRoot(dataDir, own)).toBe(oldRoot);
    expect(daemonRoots(dataDir, own)).toEqual([oldRoot, own]);
    renameSync(oldRoot, `${oldRoot}-removed`);
    expect(pickDaemonRoot(dataDir, own)).toBe(own);
    expect(pickDaemonRoot(tempDir("autostart-empty"), own)).toBe(own);
  });
});
