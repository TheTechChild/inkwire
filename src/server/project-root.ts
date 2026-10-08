// Each board owns its project root (ADR 0003). Every code-ref operation on a
// board resolves against that root, never against the server's cwd. This
// module checks a root argument, finds the root a board's refs use (with the
// main-checkout fallback when a worktree is gone), and filters boards_list.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { BoardMeta } from "../shared/types.js";
import type { BoardListing } from "./store.js";

const isDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A root argument: an existing absolute directory. Returns it resolved; throws one rule message otherwise. */
export function checkRootArg(p: string | undefined): string {
  if (typeof p !== "string" || p === "" || !path.isAbsolute(p) || !isDir(p)) {
    throw new Error(`project_root must be an existing absolute directory: ${p ?? ""}`);
  }
  return path.resolve(p);
}

/**
 * The main checkout for a root inside a linked git worktree, at the same
 * relative position as the root inside its worktree. '' outside a linked
 * worktree, and '' on any git failure (never an error).
 */
export function mainRootOf(root: string): string {
  try {
    const git = (arg: string) =>
      execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", arg], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
    const commonDir = git("--git-common-dir");
    const top = git("--show-toplevel");
    if (path.basename(commonDir) !== ".git") return "";
    const main = path.dirname(commonDir);
    if (main === top) return ""; // the main checkout itself, not a linked worktree
    const rel = path.relative(top, realpathSync(root));
    return rel ? path.join(main, rel) : main;
  } catch {
    return "";
  }
}

/** The warning (and, for writes, the error) when a board's refs resolve against its main checkout. */
export const fallbackWarning = (mainRoot: string): string =>
  `resolved against main checkout ${mainRoot}; set the root with boards_update to make this permanent`;

type RootHolder = { boardId: string; meta: Pick<BoardMeta, "project_root" | "main_root"> };

/**
 * The root a board's refs resolve against. The project root when it exists;
 * else the main checkout with fallback: true; else an error that names
 * boards_update.
 */
export function boardRoot(board: RootHolder): { root: string; fallback: boolean } {
  const { project_root: root, main_root: main } = board.meta;
  if (root === "") {
    throw new Error(`board ${board.boardId} has no project root — set one with boards_update(board_id, project_root)`);
  }
  if (isDir(root)) return { root, fallback: false };
  if (main !== "" && isDir(main)) return { root: main, fallback: true };
  throw new Error(
    `project root ${root} of board ${board.boardId} no longer exists — set a new one with boards_update(board_id, project_root)`,
  );
}

/** The root for a ref write or lint: the fallback is refused with its warning text. */
export function writeRoot(board: RootHolder): string {
  const { root, fallback } = boardRoot(board);
  if (fallback) throw new Error(fallbackWarning(root));
  return root;
}

/** The root for a ref read: null with the error text when there is none, the fallback with its warning. */
export function readRoot(board: RootHolder): { root: string | null; warnings: string[] } {
  try {
    const { root, fallback } = boardRoot(board);
    return { root, warnings: fallback ? [fallbackWarning(root)] : [] };
  } catch (err) {
    return { root: null, warnings: [err instanceof Error ? err.message : String(err)] };
  }
}

/** True when root equals cwd, contains it, or lies inside it. /a/foo does not overlap /a/foobar. */
export function rootOverlaps(root: string, cwd: string): boolean {
  const inside = (rel: string) => rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const a = path.resolve(root);
  const b = path.resolve(cwd);
  return inside(path.relative(a, b)) || inside(path.relative(b, a));
}

export type BoardListEntry = BoardListing & { root?: "unset" };

/**
 * boards_list: boards whose root overlaps cwd, plus every board whose root is
 * unset or no longer exists (marked root: "unset"). all: true keeps every board.
 */
export function listBoards(listing: BoardListing[], cwd: string, all = false): BoardListEntry[] {
  return listing.flatMap((b) => {
    const unset = b.project_root === "" || !isDir(b.project_root);
    if (!all && !unset && !rootOverlaps(b.project_root, cwd)) return [];
    return [unset ? { ...b, root: "unset" as const } : b];
  });
}
