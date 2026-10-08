// canvas.bind_code validation (SPEC § 8): resolve the ref against the
// project root, fail on a missing file, warn on a missing symbol.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { blockText, findSymbol, type SymbolRange } from "../core/symbols.js";

export interface BindResult {
  resolved_path: string;
  symbol_found: boolean | null; // null when no symbol was given
  line: number | null; // null when no symbol was given or it was not found
  end: number | null;
}

/** Split `path/to/file.ts:symbol` or `path/to/file.ts#symbol` into its parts. */
export function splitRef(ref: string): { file: string; symbol: string | null } {
  // A `:` or `#` after the last path separator separates file from symbol.
  const sep = Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("\\"));
  const cut = Math.max(ref.lastIndexOf(":"), ref.lastIndexOf("#"));
  if (cut > sep && cut > 0) return { file: ref.slice(0, cut), symbol: ref.slice(cut + 1) || null };
  return { file: ref, symbol: null };
}

/** Resolve a ref against the project root: the file path, its symbol, and the text when `read` is set. Throws on an escape or a missing file. */
function resolveRef(projectRoot: string, ref: string, read: boolean) {
  // Backstop: path.resolve('', ref) resolves against the server's cwd with no error.
  if (projectRoot === "") throw new Error("the board has no project root — set one with boards_update(board_id, project_root)");
  const { file: filePart, symbol } = splitRef(ref);
  const resolved = path.resolve(projectRoot, filePart);
  const rootResolved = path.resolve(projectRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`ref escapes the project root: ${resolved}`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`file not found: ${resolved}`);
  }
  return { resolved, symbol, text: read ? readFileSync(resolved, "utf8") : "" };
}

export function validateRef(projectRoot: string, ref: string): BindResult {
  const { symbol } = splitRef(ref);
  const { resolved, text } = resolveRef(projectRoot, ref, symbol !== null);
  const range = symbol ? findSymbol(text, symbol) : null;
  return {
    resolved_path: resolved,
    symbol_found: symbol ? range !== null : null,
    line: range?.line ?? null,
    end: range?.end ?? null,
  };
}

const hashOf = (text: string, range: SymbolRange | null) =>
  createHash("sha256").update(blockText(text, range)).digest("hex").slice(0, 12);

/** The stamp for a ref: first 12 hex chars of sha256 of the symbol block (the whole file with no symbol); null when the symbol is not found. */
export function stampRef(projectRoot: string, ref: string): string | null {
  const { symbol, text } = resolveRef(projectRoot, ref, true);
  const range = symbol ? findSymbol(text, symbol) : null;
  return symbol && !range ? null : hashOf(text, range);
}

export type RefStatus = "ok" | "ref_missing" | "symbol_missing" | "changed" | "unverified";

/** One step's ref against the code on disk; null when the step has no ref. */
export function refStatus(
  projectRoot: string,
  step: { ref: string | null; ref_hash?: string | null },
): { status: RefStatus; line: number | null; end: number | null } | null {
  if (!step.ref) return null;
  let found: { symbol: string | null; range: SymbolRange | null; text: string };
  try {
    const { symbol, text } = resolveRef(projectRoot, step.ref, true);
    found = { symbol, text, range: symbol ? findSymbol(text, symbol) : null };
  } catch {
    return { status: "ref_missing", line: null, end: null };
  }
  const { symbol, range, text } = found;
  const status: RefStatus =
    symbol && !range ? "symbol_missing" : !step.ref_hash ? "unverified" : step.ref_hash !== hashOf(text, range) ? "changed" : "ok";
  return { status, line: range?.line ?? null, end: range?.end ?? null };
}
