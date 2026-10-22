// scripts/check-plugin.ts: each rule on a temp copy of the files it reads.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlugin } from "../../scripts/check-plugin.ts";
import { yarnResolutions } from "../../scripts/plugin-package.ts";
import { root } from "../integration/daemon-helpers.ts";

// The files the check reads, relative to the repo root.
const FILES = [
  "package.json",
  "yarn.lock",
  ".nvmrc",
  ".claude-plugin/marketplace.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/package.json",
  "plugin/package-lock.json",
  "plugin/hooks/hooks.json",
  "plugin/hooks/forward.sh",
  "plugin/hooks/mod/register.tsx",
  "plugin/hooks/mod/contract.d.ts",
  "plugin/src/link/relay.ts",
];

let dir: string;

function edit<T>(rel: string, change: (json: T) => void): void {
  const file = path.join(dir, rel);
  const json = JSON.parse(readFileSync(file, "utf8")) as T;
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "inkwire-check-plugin-"));
  for (const rel of FILES) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    cpSync(path.join(root, rel), path.join(dir, rel));
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Pkg = { dependencies: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] };
type Lock = { lockfileVersion: number; packages: Record<string, Record<string, unknown>> };

describe("check-plugin", () => {
  it("passes on the repo and on the copy", () => {
    expect(checkPlugin(root)).toEqual([]);
    expect(checkPlugin(dir)).toEqual([]);
  });

  it("fails on a version in plugin.json", () => {
    edit<Record<string, unknown>>("plugin/.claude-plugin/plugin.json", (m) => (m.version = "1.0.0"));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/plugin\.json: remove the version/)]);
  });

  it("fails on a version in the marketplace entry", () => {
    edit<{ plugins: Record<string, unknown>[] }>(".claude-plugin/marketplace.json", (m) => (m.plugins[0]!.version = "1.0.0"));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/marketplace\.json: remove the version of inkwire/)]);
  });

  it("fails when the marketplace source is not ./plugin", () => {
    edit<{ plugins: Record<string, unknown>[] }>(".claude-plugin/marketplace.json", (m) => (m.plugins[0]!.source = "./"));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/with the source "\.\/plugin"/)]);
  });

  it("fails when a runtime dep of the root is not in plugin/package.json", () => {
    edit<Pkg>("package.json", (p) => (p.dependencies["left-pad"] = "1.3.0"));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/plugin\/package\.json: the dependencies are not the root runtime deps/)]);
  });

  it("fails when plugin/package.json has another version than yarn.lock", () => {
    edit<Pkg>("plugin/package.json", (p) => (p.dependencies.ws = "8.18.0"));
    const errors = checkPlugin(dir);
    expect(errors).toContainEqual(expect.stringMatching(/the dependencies are not the root runtime deps/));
    expect(errors).toContainEqual(expect.stringMatching(/package-lock\.json: the dependencies do not match/));
  });

  it("fails on a range in plugin/package.json", () => {
    edit<Pkg>("plugin/package.json", (p) => (p.dependencies.zod = "^4.1.0"));
    expect(checkPlugin(dir)).toContainEqual(expect.stringMatching(/zod must be an exact version, not "\^4\.1\.0"/));
  });

  it("fails on devDependencies in plugin/package.json", () => {
    edit<Pkg>("plugin/package.json", (p) => (p.devDependencies = { vitest: "3.0.0" }));
    expect(checkPlugin(dir)).toContainEqual(expect.stringMatching(/remove devDependencies/));
  });

  it("fails on a lockfile that is not v3", () => {
    edit<Lock>("plugin/package-lock.json", (l) => (l.lockfileVersion = 2));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/lockfileVersion must be 3/)]);
  });

  it("fails on a lockfile whose dependencies do not match", () => {
    edit<Lock>("plugin/package-lock.json", (l) => {
      (l.packages[""]!.dependencies as Record<string, string>).ws = "8.18.0";
      l.packages["node_modules/ws"]!.version = "8.18.0";
    });
    const errors = checkPlugin(dir);
    expect(errors).toContainEqual(expect.stringMatching(/the dependencies do not match plugin\/package\.json/));
    expect(errors).toContainEqual(expect.stringMatching(/ws is 8\.18\.0, but plugin\/package\.json has 8\.21\.3/));
  });

  it("fails on a lock entry with no integrity or not from the registry", () => {
    edit<Lock>("plugin/package-lock.json", (l) => {
      delete l.packages["node_modules/zod"]!.integrity;
      l.packages["node_modules/ws"]!.resolved = "git+https://example.com/ws.git";
    });
    const errors = checkPlugin(dir);
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual(expect.stringMatching(/node_modules\/zod must be an npm registry package/));
    expect(errors).toContainEqual(expect.stringMatching(/node_modules\/ws must be an npm registry package/));
  });

  it("fails when a file the manifest names is missing", () => {
    rmSync(path.join(dir, "plugin/src/link/relay.ts"));
    rmSync(path.join(dir, "plugin/hooks/mod/contract.d.ts"));
    const errors = checkPlugin(dir);
    expect(errors).toContainEqual(expect.stringMatching(/plugin\.json: names plugin\/src\/link\/relay\.ts, which does not exist/));
    expect(errors).toContainEqual(expect.stringMatching(/plugin\.json: names plugin\/hooks\/mod\/contract\.d\.ts/));
  });

  it("fails when a file hooks.json names is missing or the hook script is not executable", () => {
    rmSync(path.join(dir, "plugin/hooks/mod/register.tsx"));
    chmodSync(path.join(dir, "plugin/hooks/forward.sh"), 0o644);
    const errors = checkPlugin(dir);
    expect(errors).toContainEqual("plugin/hooks/hooks.json: names plugin/hooks/mod/register.tsx, which does not exist.");
    expect(errors).toContainEqual("plugin/hooks/hooks.json: plugin/hooks/forward.sh is not executable.");
  });

  it("fails when plugin/ holds node_modules or dist", () => {
    mkdirSync(path.join(dir, "plugin/node_modules"));
    mkdirSync(path.join(dir, "plugin/dist"));
    const errors = checkPlugin(dir);
    expect(errors).toContainEqual(expect.stringMatching(/^plugin\/node_modules: remove it/));
    expect(errors).toContainEqual(expect.stringMatching(/^plugin\/dist: remove it/));
  });

  it("fails when the root package.json has workspaces", () => {
    edit<Pkg>("package.json", (p) => (p.workspaces = ["plugin"]));
    expect(checkPlugin(dir)).toEqual([expect.stringMatching(/remove "workspaces"/)]);
  });

  it("reads each descriptor of a yarn.lock entry", () => {
    const lock = '"zod@npm:^3.25 || ^4.0, zod@npm:^4.1.0":\n  version: 4.5.4\n  resolution: "zod@npm:4.5.4"\n';
    const map = yarnResolutions(lock);
    expect(map.get("zod@npm:^4.1.0")).toBe("4.5.4");
    expect(map.get("zod@npm:^3.25 || ^4.0")).toBe("4.5.4");
  });
});
