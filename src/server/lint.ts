// canvas.lint — static checks, no model. Catches board rot after refactors
// (refs to files that moved) and shape mistakes (error edges with no
// condition). Semantic auditing is the calling agent's job: get_state gives
// it every claim already.
import { pathsAffected } from "../core/layers.js";
import { goneMarks } from "../core/drafts.js";
import { goneRefs } from "../core/notebooks.js";
import { refStatus, validateRef } from "./bindcode.js";
import type { Draft, EdgeEl, Layer, NodeEl, Notebook, Path } from "../shared/types.js";

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
    | "path_ref_changed"
    | "path_ref_unverified"
    | "path_hop_unbound"
    | "draft_mark_gone"
    | "notebook_ref_gone"
    | "note_node";
  level: "error" | "warn";
  message: string;
}

/** Every finding for one path: broken hops, then each step's ref and binding. Shared by canvas.lint and paths.play.
 * A null root (the board has none) skips the ref checks; the caller says why. */
export function lintPath(projectRoot: string | null, layer: Layer, path: Path, nodes: NodeEl[], edges: EdgeEl[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const b of pathsAffected([{ ...layer, paths: [path] }], edges)) {
    const message =
      b.reason === "edge pruned"
        ? `path ${b.path_id} hop ${b.hop} references a pruned edge`
        : `path ${b.path_id} hop ${b.hop}: ${path.steps[b.hop - 1]!.edge} leaves layer ${layer.letter}`;
    out.push({ target_id: path.id, check: "path_broken", level: "warn", message });
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const bound = (id: string | undefined) => {
    const n = id ? nodeById.get(id) : undefined;
    return !!(n?.ref || n?.endpoint);
  };
  path.steps.forEach((s, i) => {
    const hop = `path ${path.id} hop ${i + 1}`;
    const warn = (check: LintFinding["check"], message: string) => out.push({ target_id: path.id, check, level: "warn", message });
    const r = projectRoot === null ? null : refStatus(projectRoot, s);
    const at = r?.line ? ` (line ${r.line})` : "";
    if (r?.status === "ref_missing") {
      out.push({ target_id: path.id, check: "path_ref_missing", level: "error", message: `${hop}: ref points at a missing file` });
    } else if (r?.status === "symbol_missing") warn("path_symbol_missing", `${hop}: symbol gone`);
    else if (r?.status === "changed") warn("path_ref_changed", `${hop}: ${s.ref}${at} changed since the hop was verified`);
    else if (r?.status === "unverified") warn("path_ref_unverified", `${hop}: ${s.ref}${at} was never verified`);
    else if (!s.ref) {
      const e = edgeById.get(s.edge);
      if (e && !bound(e.from) && !bound(e.to)) warn("path_hop_unbound", `${hop}: no ref on the hop or on either node`);
    }
  });
  return out;
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
  for (const l of layers) for (const p of l.paths) out.push(...lintPath(projectRoot, l, p, nodes, edges));
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
