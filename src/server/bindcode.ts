// canvas.bind_code validation (SPEC § 8): resolve the ref against the
// project root, fail on a missing file, warn on a missing symbol.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface BindResult {
  resolved_path: string;
  symbol_found: boolean | null; // null when no symbol was given
}

export function validateRef(projectRoot: string, ref: string): BindResult {
  const colon = ref.lastIndexOf(":");
  // A colon after the last path separator separates file from symbol.
  const sep = Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("\\"));
  const hasSymbol = colon > sep && colon > 0;
  const filePart = hasSymbol ? ref.slice(0, colon) : ref;
  const symbol = hasSymbol ? ref.slice(colon + 1) : null;

  const resolved = path.resolve(projectRoot, filePart);
  const rootResolved = path.resolve(projectRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`ref escapes the project root: ${resolved}`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`file not found: ${resolved}`);
  }

  let symbolFound: boolean | null = null;
  if (symbol) {
    // Plain text search is enough for v1 (SPEC § 8).
    const text = readFileSync(resolved, "utf8");
    symbolFound = text.includes(symbol);
  }
  return { resolved_path: resolved, symbol_found: symbolFound };
}
