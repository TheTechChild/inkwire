// canvas.lint — static checks, no model. Catches board rot after refactors
// (refs to files that moved) and shape mistakes (error edges with no
// condition). Semantic auditing is the calling agent's job: get_state gives
// it every claim already.
import { validateRef } from "./bindcode.js";
import type { EdgeEl, NodeEl } from "../shared/types.js";

export interface LintFinding {
  target_id: string;
  check: "ref_missing" | "symbol_missing" | "unbound" | "error_no_condition" | "condition_no_branch";
  level: "error" | "warn";
  message: string;
}

export function lintBoard(projectRoot: string, nodes: NodeEl[], edges: EdgeEl[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const n of nodes) {
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
  return out;
}
