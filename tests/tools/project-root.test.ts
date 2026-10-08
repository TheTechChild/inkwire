// project-root.ts: the root argument rule, the board's root (with the main
// checkout fallback), the overlap filter and the main checkout from git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boardRoot, checkRootArg, listBoards, mainRootOf, rootOverlaps } from "../../src/server/project-root.js";
import type { BoardListing } from "../../src/server/store.js";

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const RULE = "project_root must be an existing absolute directory";

describe("checkRootArg", () => {
  it("accepts an existing absolute directory and returns it resolved", () => {
    const dir = tmp("inkwire-pr-");
    expect(checkRootArg(dir)).toBe(dir);
    expect(checkRootArg(`${dir}/./`)).toBe(dir);
  });

  it("rejects '', a relative path, a missing path and a file with one message", () => {
    const dir = tmp("inkwire-pr-");
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "x");
    for (const bad of ["", "relative/dir", path.join(dir, "missing"), file]) {
      expect(() => checkRootArg(bad)).toThrow(`${RULE}: ${bad}`);
    }
  });
});

describe("boardRoot", () => {
  const board = (project_root: string, main_root = "") => ({ boardId: "b_x", meta: { project_root, main_root } });

  it("an existing root is used as is", () => {
    const dir = tmp("inkwire-pr-");
    expect(boardRoot(board(dir))).toEqual({ root: dir, fallback: false });
  });

  it("an unset root fails and names boards_update", () => {
    expect(() => boardRoot(board(""))).toThrow("board b_x has no project root — set one with boards_update(board_id, project_root)");
  });

  it("a gone root with no main checkout fails and names boards_update", () => {
    expect(() => boardRoot(board("/no/such/dir"))).toThrow(
      "project root /no/such/dir of board b_x no longer exists — set a new one with boards_update(board_id, project_root)",
    );
    expect(() => boardRoot(board("/no/such/dir", "/no/such/main"))).toThrow(/no longer exists/);
  });

  it("a gone root with a main checkout that exists falls back to it", () => {
    const main = tmp("inkwire-pr-main-");
    expect(boardRoot(board("/no/such/dir", main))).toEqual({ root: main, fallback: true });
  });
});

describe("rootOverlaps", () => {
  it("equal, cwd a parent, cwd a child overlap", () => {
    expect(rootOverlaps("/a/foo", "/a/foo")).toBe(true);
    expect(rootOverlaps("/a/foo", "/a")).toBe(true);
    expect(rootOverlaps("/a/foo", "/a/foo/src")).toBe(true);
  });

  it("a sibling and a shared string prefix do not overlap", () => {
    expect(rootOverlaps("/a/foo", "/a/bar")).toBe(false);
    expect(rootOverlaps("/a/foo", "/a/foobar")).toBe(false);
    expect(rootOverlaps("/a/foobar", "/a/foo")).toBe(false);
  });

  it("trailing separators do not matter", () => {
    expect(rootOverlaps("/a/foo/", "/a/foo")).toBe(true);
    expect(rootOverlaps("/a/foo", "/a/")).toBe(true);
    expect(rootOverlaps("/a/foo/", "/a/foobar/")).toBe(false);
  });
});

describe("listBoards", () => {
  const entry = (id: string, project_root: string): BoardListing => ({
    id,
    name: id,
    nodes: 0,
    edges: 0,
    ink: 0,
    updated_at: 0,
    project_root,
    main_root: "",
  });

  it("filters by overlap; unset and gone roots always show, marked unset", () => {
    const parent = tmp("inkwire-pr-list-");
    const a = path.join(parent, "a");
    const b = path.join(parent, "b");
    mkdirSync(a);
    mkdirSync(b);
    const listing = [entry("A", a), entry("B", b), entry("U", ""), entry("G", path.join(parent, "gone"))];
    const ids = (cwd: string, all = false) => listBoards(listing, cwd, all).map((x) => x.id);
    expect(ids(a)).toEqual(["A", "U", "G"]);
    expect(ids(parent)).toEqual(["A", "B", "U", "G"]);
    expect(ids("/elsewhere", true)).toEqual(["A", "B", "U", "G"]);
    const marks = Object.fromEntries(listBoards(listing, parent).map((x) => [x.id, x.root]));
    expect(marks).toEqual({ A: undefined, B: undefined, U: "unset", G: "unset" });
  });
});

describe("mainRootOf", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

  it("a root inside a linked worktree maps to the same place in the main checkout", () => {
    const main = realpathSync(tmp("inkwire-pr-git-"));
    git(main, "init", "-q");
    mkdirSync(path.join(main, "pkg"));
    writeFileSync(path.join(main, "pkg", "x.ts"), "x");
    git(main, "add", ".");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const wt = path.join(realpathSync(tmp("inkwire-pr-wt-")), "wt");
    git(main, "worktree", "add", "-q", wt);
    expect(mainRootOf(wt)).toBe(main);
    expect(mainRootOf(path.join(wt, "pkg"))).toBe(path.join(main, "pkg"));
    // The main checkout itself is not a linked worktree.
    expect(mainRootOf(main)).toBe("");
    rmSync(wt, { recursive: true, force: true });
  });

  it("a root outside git gives ''", () => {
    expect(mainRootOf(tmp("inkwire-pr-nogit-"))).toBe("");
  });

  it("a git failure (git not on PATH) gives '' and no error", () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(mainRootOf(tmp("inkwire-pr-nopath-"))).toBe("");
    } finally {
      process.env.PATH = saved;
    }
  });
});
