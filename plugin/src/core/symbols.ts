// Resolve a `symbol` to a line range in a source text. Pure and dependency-free:
// a VS Code extension imports this same file.

/** 1-based, inclusive. */
export interface SymbolRange {
  line: number;
  end: number;
}

const DECL_KEYWORDS =
  "function|class|const|let|var|interface|type|enum|def|fn|fun|func|struct|trait|impl|module|namespace|object";
const MODS =
  "(?:(?:export|default|declare|async|static|public|private|protected|internal|readonly|abstract|override|final|open|sealed|data|inline|suspend|unsafe|extern|get|set|pub(?:\\([^)]*\\))?)\\s+|\\*\\s*)*";
const MODIFIERS = new RegExp(`^${MODS}`);

const indentOf = (l: string): number => l.length - l.trimStart().length;
const depthOf = (l: string): number => (l.match(/[([{]/g)?.length ?? 0) - (l.match(/[)\]}]/g)?.length ?? 0);

export function findSymbol(text: string, symbol: string): SymbolRange | null {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`);
  const declared = new RegExp(`^${MODS}(?:${DECL_KEYWORDS})(?:\\s+|\\s*\\*\\s*)(?:\\([^)]*\\)\\s*)?${esc}(?![\\w$])`);
  const called = new RegExp(`(?<![\\w$])${esc}(?:<.*>)?\\(`);
  const lines = text.split("\n");

  const isComment = (t: string) => /^(?:\/\/|\/\*|\*(?:\s|\/|$)|#(?:\s|!))/.test(t);
  const isImport = (t: string) => /^(?:import|from|use|using|#include)(?![\w$(])|^require\b|^export\s*[{*]/.test(t);
  // An overload signature, declare function, abstract method or call statement: never the body.
  const bodiless = (t: string) => t.endsWith(";") && called.test(t);
  const isHead = (t: string) => {
    const rest = t.slice(MODIFIERS.exec(t)![0].length);
    if (!rest.startsWith(symbol)) return false;
    const after = rest.slice(symbol.length);
    return !/^[\w$]/.test(after) && ((/^[(<]/.test(after) && !bodiless(t)) || /^\s*(?::|=(?![=>]))/.test(after));
  };
  // Tiers: keyword declaration, head form (method, field, property), a mention in code, any mention. First line wins in a tier.
  const tiers = [
    (_l: string, t: string) => !isComment(t) && !bodiless(t) && declared.test(t),
    (_l: string, t: string) => !isComment(t) && isHead(t),
    (_l: string, t: string) => !isComment(t) && !isImport(t),
    () => true,
  ];
  let at = -1;
  for (const tier of tiers) {
    at = lines.findIndex((l) => word.test(l) && tier(l, l.trim()));
    if (at >= 0) break;
  }
  if (at < 0) return null;

  // ponytail: indentation + bracket depth, no parser — a bracket inside a string, regex or comment skews the depth and the block runs long, never shorter than indentation alone; tree-sitter if it matters
  const d = indentOf(lines[at]!);
  let depth = depthOf(lines[at]!);
  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (depth > 0 || indentOf(l) > d || (indentOf(l) === d && /^[)}\]{]/.test(l.trim()))) {
      end = i;
      depth += depthOf(l);
    } else break;
  }
  return { line: at + 1, end: end + 1 };
}

/** The lines of a range (or the whole text when range is null), trimmed, blank lines dropped, joined by "\n". The server hashes this. */
export function blockText(text: string, range: SymbolRange | null): string {
  const lines = text.split("\n");
  return (range ? lines.slice(range.line - 1, range.end) : lines)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
