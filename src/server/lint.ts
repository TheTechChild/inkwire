// canvas.lint — static checks, no model. Catches board rot after refactors
// (refs to files that moved) and shape mistakes (error edges with no
// condition). Semantic auditing is the calling agent's job: get_state gives
// it every claim already.
import { pathsAffected } from "../core/layers.js";
import { goneMarks } from "../core/drafts.js";
import { goneRefs } from "../core/notebooks.js";
import { validateRef } from "./bindcode.js";
import type { Draft, EdgeEl, Layer, NodeEl, Notebook } from "../shared/types.js";

export interface LintFinding {
  target_id: string;
  check:
    | "ref_missing"
    | "symbol_missing"
    | "unbound"
    | "error_no_condition"
    | "condition_no_branch"
    | "path_broken"
    | "path_ref_missing"
    | "path_symbol_missing"
    | "draft_mark_gone"
    | "notebook_ref_gone"
    | "note_node";
  level: "error" | "warn";
  message: string;
}

export function lintBoard(
  projectRoot: string,
  nodes: NodeEl[],
  edges: EdgeEl[],
  layers: Layer[] = [],
  drafts: Draft[] = [],
  notebooks: Notebook[] = [],
): LintFinding[] {
  const out: LintFinding[] = [];
  for (const n of nodes) {
    if (n.kind === "note") {
      out.push({
        target_id: n.id,
        check: "note_node",
        level: "error",
        message: `${n.id} is a note node — notes are not board elements; run the notes migration`,
      });
    }
    if (n.ref) {
      try {
        const r = validateRef(projectRoot, n.ref);
        if (r.symbol_found === false) {
          out.push({ target_id: n.id, check: "symbol_missing", level: "warn", message: `symbol not found in ${n.ref}` });
        }
      } catch (err) {
        out.push({ target_id: n.id, check: "ref_missing", level: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } else if (!n.endpoint && n.kind !== "note") {
      out.push({ target_id: n.id, check: "unbound", level: "warn", message: `${n.kind} "${n.label}" has no ref or endpoint` });
    }
  }
  const outDegree = new Map<string, number>();
  for (const e of edges) outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
  for (const e of edges) {
    if (e.kind === "error" && !e.condition) {
      out.push({ target_id: e.id, check: "error_no_condition", level: "warn", message: "error edge has no condition" });
    }
    if (e.condition && (outDegree.get(e.from) ?? 0) < 2) {
      out.push({ target_id: e.id, check: "condition_no_branch", level: "warn", message: `condition "${e.condition}" but ${e.from} has no other outgoing edge` });
    }
  }
  for (const b of pathsAffected(layers, edges)) {
    const layer = layers.find((l) => l.paths.some((p) => p.id === b.path_id))!;
    const edge = layer.paths.find((p) => p.id === b.path_id)!.steps[b.hop - 1]!.edge;
    const message =
      b.reason === "edge pruned"
        ? `path ${b.path_id} hop ${b.hop} references a pruned edge`
        : `path ${b.path_id} hop ${b.hop}: ${edge} leaves layer ${layer.letter}`;
    out.push({ target_id: b.path_id, check: "path_broken", level: "warn", message });
  }
  for (const l of layers) {
    for (const p of l.paths) {
      p.steps.forEach((s, i) => {
        if (!s.ref) return;
        try {
          if (validateRef(projectRoot, s.ref).symbol_found === false) {
            out.push({ target_id: p.id, check: "path_symbol_missing", level: "warn", message: `path ${p.id} hop ${i + 1}: symbol gone` });
          }
        } catch {
          out.push({ target_id: p.id, check: "path_ref_missing", level: "error", message: `path ${p.id} hop ${i + 1}: ref points at a missing file` });
        }
      });
    }
  }
  for (const g of goneMarks(drafts, nodes.map((n) => n.id), edges.map((e) => e.id))) {
    out.push({
      target_id: g.id,
      check: "draft_mark_gone",
      level: "warn",
      message: `draft ${g.draft_id} marks ${g.id}, which no longer exists`,
    });
  }
  for (const g of goneRefs(notebooks, nodes.map((n) => n.id), edges.map((e) => e.id), layers, drafts)) {
    out.push({
      target_id: g.id,
      check: "notebook_ref_gone",
      level: "warn",
      message: `notebook ${g.notebook_id} references ${g.id}, which no longer exists`,
    });
  }
  return out;
}
