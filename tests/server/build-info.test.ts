// The build id is the hash of the plugin source (build-info.ts): Node runs the
// source, so there is no build step and no build file. The build registry
// (<dataDir>/builds.json) orders the builds by first_seen, and a relay starts
// the daemon of the newest build that is still on disk (autostart.ts).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRY_FILE,
  currentBuild,
  daemonEntryOf,
  isNewerBuild,
  liveBuilds,
  readBuildInfo,
  readRegistry,
  registerBuild,
} from "../../plugin/src/server/build-info.ts";
import { pickDaemonRoot } from "../../plugin/src/link/autostart.ts";
import { tempDir } from "../integration/daemon-helpers.ts";

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

describe("the build registry", () => {
  it("registers a build with its root and first_seen; first_seen stays, the root moves to the last folder", () => {
    const dataDir = tempDir("registry");
    const a = pluginRoot("registry-a");
    const b = pluginRoot("registry-b");
    const t1 = new Date("2026-10-01T00:00:00.000Z");
    const t2 = new Date("2026-10-02T00:00:00.000Z");
    expect(registerBuild(dataDir, "aaaa", a, t1)).toEqual({ root: a, first_seen: t1.toISOString() });
    // The same build from another folder (a docs-only commit): first_seen stays, the root is the new folder.
    expect(registerBuild(dataDir, "aaaa", b, t2)).toEqual({ root: b, first_seen: t1.toISOString() });
    expect(readRegistry(dataDir)).toEqual({ aaaa: { root: b, first_seen: t1.toISOString() } });
    expect(JSON.parse(readFileSync(path.join(dataDir, REGISTRY_FILE), "utf8"))).toEqual(readRegistry(dataDir));
  });

  it("removes other entries whose daemon entry is gone, and keeps the one it registers", () => {
    const dataDir = tempDir("registry-prune");
    const a = pluginRoot("registry-prune-a");
    const gone = pluginRoot("registry-prune-gone");
    registerBuild(dataDir, "gone", gone, new Date("2026-10-01T00:00:00.000Z"));
    registerBuild(dataDir, "aaaa", a, new Date("2026-10-02T00:00:00.000Z"));
    renameSync(gone, `${gone}-removed`);
    registerBuild(dataDir, "bbbb", path.join(tempDir("registry-prune-nowhere"), "plugin"), new Date("2026-10-03T00:00:00.000Z"));
    expect(Object.keys(readRegistry(dataDir)).sort()).toEqual(["aaaa", "bbbb"]);
  });

  it("is empty when the file is missing or bad, and skips bad entries", () => {
    const dataDir = tempDir("registry-bad");
    expect(readRegistry(dataDir)).toEqual({});
    writeFileSync(path.join(dataDir, REGISTRY_FILE), "{not json");
    expect(readRegistry(dataDir)).toEqual({});
    writeFileSync(
      path.join(dataDir, REGISTRY_FILE),
      JSON.stringify({ ok: { root: "/r", first_seen: "2026-10-01T00:00:00.000Z" }, bad: { root: 1 }, worse: { root: "/r", first_seen: "x" } }),
    );
    expect(readRegistry(dataDir)).toEqual({ ok: { root: "/r", first_seen: "2026-10-01T00:00:00.000Z" } });
  });

  it("currentBuild hashes the source, registers its plugin root and gives first_seen as built_at", () => {
    const dataDir = tempDir("registry-current");
    const root = pluginRoot("registry-current-root");
    const first = currentBuild(dataDir, srcOf(root));
    expect(first.id).toBe(readBuildInfo(srcOf(root)).id);
    expect(first.built_at).not.toBeNull();
    expect(readRegistry(dataDir)[first.id]).toEqual({ root, first_seen: first.built_at });
    // A second start of the same build gives the same first_seen.
    expect(currentBuild(dataDir, srcOf(root))).toEqual(first);
  });

  it("does not register an unbuilt source", () => {
    const dataDir = tempDir("registry-unbuilt");
    expect(currentBuild(dataDir, path.join(tempDir("registry-unbuilt-src"), "src"))).toEqual({ id: "unbuilt", built_at: null });
    expect(existsSync(path.join(dataDir, REGISTRY_FILE))).toBe(false);
  });
});

describe("the order of the builds (Decision 7)", () => {
  const registry = {
    old: { root: "/old", first_seen: "2026-10-01T00:00:00.000Z" },
    new: { root: "/new", first_seen: "2026-10-05T00:00:00.000Z" },
  };

  it("compares first_seen from the registry, not the built_at of the hello", () => {
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
});

describe("the daemon that a relay starts (autostart)", () => {
  it("a stale old relay starts the daemon of the newer registered build", () => {
    const dataDir = tempDir("autostart-pick");
    const oldRoot = pluginRoot("autostart-old");
    const newRoot = pluginRoot("autostart-new");
    registerBuild(dataDir, "old", oldRoot, new Date("2026-10-01T00:00:00.000Z"));
    registerBuild(dataDir, "new", newRoot, new Date("2026-10-05T00:00:00.000Z"));
    // The old relay registers again at its start: its first_seen stays older.
    registerBuild(dataDir, "old", oldRoot, new Date("2026-10-09T00:00:00.000Z"));
    expect(pickDaemonRoot(dataDir, oldRoot)).toBe(newRoot);
  });

  it("starts the next newest build when the newest folder is gone, and its own build when none is left", () => {
    const dataDir = tempDir("autostart-gone");
    const oldRoot = pluginRoot("autostart-gone-old");
    const newRoot = pluginRoot("autostart-gone-new");
    const own = pluginRoot("autostart-gone-own");
    registerBuild(dataDir, "old", oldRoot, new Date("2026-10-01T00:00:00.000Z"));
    registerBuild(dataDir, "new", newRoot, new Date("2026-10-05T00:00:00.000Z"));
    renameSync(newRoot, `${newRoot}-removed`);
    expect(pickDaemonRoot(dataDir, own)).toBe(oldRoot);
    renameSync(oldRoot, `${oldRoot}-removed`);
    expect(pickDaemonRoot(dataDir, own)).toBe(own);
    expect(pickDaemonRoot(tempDir("autostart-empty"), own)).toBe(own);
  });
});
