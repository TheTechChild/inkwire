// Notebook math: id assignment, the markdown subset, ref extraction, task
// toggling, gone-ref detection, and the [[nX]] auto-ref distance rule. Pure
// — shared by the server (notebooks_*, canvas.lint, canvas.delete, the T
// tool, notes_migrate) and the panel (rendering the pane).
import { nearestNode } from "./geometry.js";
import type { Draft, EdgeEl, Layer, LayoutMap, NodeEl, Notebook, Point } from "../shared/types.js";

/** First unused "N{n}" across the board. */
export function nextNotebookId(notebooks: Notebook[]): string {
  const used = new Set(notebooks.map((n) => n.id));
  for (let i = 1; i < 1000; i++) if (!used.has(`N${i}`)) return `N${i}`;
  return "N?";
}

// ---------------------------------------------------------------------------
// The markdown subset: "## " headings, paragraphs, "- " bullets,
// "- [ ]" / "- [x]" tasks, [[id]] refs inline. Blank lines separate blocks;
// anything else is a paragraph. Ported from the reference implementation
// (design_handoff_inkwire/Shared Canvas - Notebooks.dc.html:789-816).

// The reference implementation's id pattern (letters then digits, e.g. "n11",
// "L2") only fits the view ids (layers/paths/drafts/notebooks: "L2", "P1",
// "D1", "N4"). Real node/edge ids come from BoardSession.newId as
// "<prefix>_<hex>" (e.g. "n_1a2b3c") — a mixed letter/digit tail, joined by
// an underscore — so the ref pattern has to accept any word character after
// the leading letter, not just digits.
const REF_RE = /\[\[([A-Za-z]\w*)\]\]/;
const REF_RE_G = /\[\[([A-Za-z]\w*)\]\]/g;
const TASK_RE = /^- \[( |x)\] (.*)$/;

export type NbInline = { kind: "text"; text: string } | { kind: "ref"; id: string };

export interface NbBlock {
  key: string; // "b" + line index, stable across re-renders of the same body
  line: number; // 0-based index into body.split("\n") — what toggleTaskLine takes
  type: "h" | "para" | "bullet" | "task";
  done?: boolean; // task only
  parts: NbInline[];
}

/** Splits a line's text into plain-text runs and [[id]] refs, in order. */
export function nbInlines(text: string): NbInline[] {
  const out: NbInline[] = [];
  let rest = text;
  while (rest) {
    const m = rest.match(REF_RE);
    if (!m || m.index === undefined) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", text: rest.slice(0, m.index) });
    out.push({ kind: "ref", id: m[1]! });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Parses a notebook body into blocks. Blank lines are skipped, not preserved. */
export function parseNotebook(body: string): NbBlock[] {
  const blocks: NbBlock[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const key = `b${i}`;
    if (line.slice(0, 3) === "## ") {
      blocks.push({ key, line: i, type: "h", parts: nbInlines(line.slice(3)) });
      continue;
    }
    const task = line.match(TASK_RE);
    if (task) {
      blocks.push({ key, line: i, type: "task", done: task[1] === "x", parts: nbInlines(task[2]!) });
      continue;
    }
    if (line.slice(0, 2) === "- ") {
      blocks.push({ key, line: i, type: "bullet", parts: nbInlines(line.slice(2)) });
      continue;
    }
    blocks.push({ key, line: i, type: "para", parts: nbInlines(line) });
  }
  return blocks;
}

/** Every [[id]] ref in a body, deduped, in first-seen order. */
export function refsIn(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(REF_RE_G)) seen.add(m[1]!);
  return [...seen];
}

/** Rewrites exactly one line, toggling "- [ ]" ↔ "- [x]" — the pane's
 * checkbox writes back into the markdown, the only store. A line that isn't
 * a task line, or doesn't exist, is returned unchanged. */
export function toggleTaskLine(body: string, lineNo: number): string {
  const lines = body.split("\n");
  const line = lines[lineNo];
  if (line === undefined) return body;
  if (line.includes("- [x]")) lines[lineNo] = line.replace("- [x]", "- [ ]");
  else if (line.includes("- [ ]")) lines[lineNo] = line.replace("- [ ]", "- [x]");
  else return body;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gone-ref / affected-ref sets — mirrors of goneMarks / draftsAffectedBy
// (src/core/drafts.ts). A ref can name a node, an edge, a layer, a path
// (nested under a layer's .paths), or a draft.

/** Every [[ref]] across every notebook that no longer resolves to anything
 * live (canvas.lint's dangling-ref check). */
export function goneRefs(
  notebooks: Notebook[],
  nodeIds: string[],
  edgeIds: string[],
  layers: Layer[],
  drafts: Draft[],
): { notebook_id: string; id: string }[] {
  const live = new Set<string>([
    ...nodeIds,
    ...edgeIds,
    ...layers.map((l) => l.id),
    ...layers.flatMap((l) => l.paths.map((p) => p.id)),
    ...drafts.map((d) => d.id),
  ]);
  const out: { notebook_id: string; id: string }[] = [];
  for (const nb of notebooks) for (const ref of refsIn(nb.body)) if (!live.has(ref)) out.push({ notebook_id: nb.id, id: ref });
  return out;
}

/** Refs among the given ids, across every notebook, live or gone
 * (canvas.delete's notebooks_affected). */
export function notebooksAffectedBy(notebooks: Notebook[], ids: string[]): { notebook_id: string; id: string }[] {
  const set = new Set(ids);
  const out: { notebook_id: string; id: string }[] = [];
  for (const nb of notebooks) for (const ref of refsIn(nb.body)) if (set.has(ref)) out.push({ notebook_id: nb.id, id: ref });
  return out;
}

/** notebooks_get: every [[id]] ref rewritten to "id (label)", or "id (gone)"
 * when it resolves to nothing. Ported from the reference implementation's
 * resolveRef (design_handoff_inkwire/Shared Canvas - Notebooks.dc.html:1273-1279, 1800). */
export function resolveNotebookRefs(
  body: string,
  nodes: NodeEl[],
  edges: EdgeEl[],
  layers: Layer[],
  drafts: Draft[],
): string {
  return body.replace(REF_RE_G, (_m, id: string) => {
    let label: string | null;
    if (id[0] === "L") label = layers.find((l) => l.id === id)?.title ?? null;
    else if (id[0] === "P") label = layers.flatMap((l) => l.paths).find((p) => p.id === id)?.title ?? null;
    else if (id[0] === "D") label = drafts.find((d) => d.id === id)?.title ?? null;
    else if (id[0] === "e") {
      const e = edges.find((e) => e.id === id);
      label = e ? e.label || "edge" : null;
    } else {
      label = nodes.find((n) => n.id === id)?.label ?? null;
    }
    return `${id} (${label ?? "gone"})`;
  });
}

// ---------------------------------------------------------------------------
// The 80px auto-ref rule, shared by the T tool and notes_migrate.

/** Nearest node to a point, within radius px — null when nothing is close
 * enough. Ties broken by the smaller id: candidates are sorted by id before
 * the scan, and nearestNode's strict less-than keeps the first (smallest)
 * id on an exact tie. `layout` should already be narrowed to node ids —
 * this doesn't know images from nodes, only boxes. */
export function nearestNodeWithin(layout: LayoutMap, at: Point, radius: number): string | null {
  const placed = Object.keys(layout)
    .sort()
    .map((id) => ({ id, box: layout[id]! }));
  return nearestNode(at, placed, radius)?.id ?? null;
}
