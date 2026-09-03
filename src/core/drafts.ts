// Draft math: id assignment, mark counting, and gone-mark detection. Pure —
// shared by the server (drafts_*, canvas.lint, canvas.delete) and the panel
// (chip counts, DRAFTS tab, thread chip).
import type { Draft, EdgeEl, NodeEl } from "../shared/types.js";

/** First unused "D{n}" across the board. */
export function nextDraftId(drafts: Draft[]): string {
  const used = new Set(drafts.map((d) => d.id));
  for (let i = 1; i < 1000; i++) if (!used.has(`D${i}`)) return `D${i}`;
  return "D?";
}

/** Counts per role, excluding marks whose element no longer exists on the board.
 * Takes the live nodes/edges themselves — every caller already has them on hand
 * from state.graph, so this stays a one-liner at each call site. */
export function markCounts(
  draft: Draft,
  nodes: NodeEl[],
  edges: EdgeEl[],
): { removed: number; changed: number; added: number } {
  const live = new Set<string>([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
  const counts = { removed: 0, changed: 0, added: 0 };
  for (const [id, role] of Object.entries(draft.marks)) {
    if (live.has(id)) counts[role]++;
  }
  return counts;
}

/** Every mark across every draft whose element no longer exists (canvas.lint's gone-mark check). */
export function goneMarks(drafts: Draft[], nodeIds: string[], edgeIds: string[]): { draft_id: string; id: string }[] {
  const live = new Set([...nodeIds, ...edgeIds]);
  const out: { draft_id: string; id: string }[] = [];
  for (const d of drafts) for (const id of Object.keys(d.marks)) if (!live.has(id)) out.push({ draft_id: d.id, id });
  return out;
}

/** Marks among the given ids, across every draft (canvas.delete's drafts_affected — result.ids already
 * holds the deleted id plus whatever the fold pruned along with it). */
export function draftsAffectedBy(drafts: Draft[], ids: string[]): { draft_id: string; id: string }[] {
  const set = new Set(ids);
  const out: { draft_id: string; id: string }[] = [];
  for (const d of drafts) for (const id of Object.keys(d.marks)) if (set.has(id)) out.push({ draft_id: d.id, id });
  return out;
}
