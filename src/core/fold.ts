// The board is a fold of history steps (SPEC § 4.2), with referential
// integrity enforced after every step (§ 4.4). Pure: no clocks, no
// randomness, no iteration-order dependence.
import type {
  Box,
  CollOp,
  Collections,
  FoldResult,
  History,
  LayoutOp,
  Step,
} from "../shared/types.js";

interface ApplyOutcome<T extends { id: string }> {
  list: T[];
  missed: boolean;
}

function applyCollOps<T extends { id: string }>(list: T[], ops: CollOp<T>[]): ApplyOutcome<T> {
  let missed = false;
  let out = list;
  for (const op of ops) {
    if (op.op === "add") {
      if (out.some((i) => i.id === op.item.id)) missed = true;
      else out = [...out, op.item];
    } else if (op.op === "set") {
      if (!out.some((i) => i.id === op.item.id)) missed = true;
      else out = out.map((i) => (i.id === op.item.id ? op.item : i));
    } else {
      if (!out.some((i) => i.id === op.id)) missed = true;
      else out = out.filter((i) => i.id !== op.id);
    }
  }
  return { list: out, missed };
}

function applyLayoutOps(
  layout: Record<string, Box>,
  ops: LayoutOp[],
): { layout: Record<string, Box>; missed: boolean } {
  let missed = false;
  const out = { ...layout };
  for (const op of ops) {
    if (op.op === "set") out[op.id] = op.box;
    else if (op.id in out) delete out[op.id];
    else missed = true;
  }
  return { layout: out, missed };
}

/**
 * Fold steps [1..head] (skipped steps excluded) over the base snapshot.
 *
 * Integrity pass after each step:
 * - Edges whose endpoints are gone are pruned. The step is flagged conflict
 *   only when it introduced the pruned edge itself (add/set in its own ops) —
 *   a step that deletes a node prunes that node's older edges intentionally
 *   and is NOT a conflict (TESTS § 2).
 * - Layout boxes whose element no longer exists are pruned silently.
 * - A step any of whose ops missed (add over an existing id, set/del of an
 *   absent id) is flagged conflict.
 *
 * Invariant: the returned collections never contain a dangling edge.
 */
export function fold(history: History): FoldResult {
  let cur: Collections = history.base;
  const conflicts = new Set<string>();
  let edgesPruned = 0;

  const end = Math.min(history.head, history.steps.length);
  for (let i = 0; i < end; i++) {
    const step = history.steps[i]!;
    if (step.skipped) continue;
    cur = applyStep(cur, step, conflicts, (n) => (edgesPruned += n));
  }

  // The base itself may contain danglers (defensive; stored boards should be
  // clean). Prune without flagging anything.
  const nodeAndImageIds = idSet(cur);
  const validEdges = cur.edges.filter((e) => nodeAndImageIds.nodes.has(e.from) && nodeAndImageIds.nodes.has(e.to));
  if (validEdges.length !== cur.edges.length) {
    edgesPruned += cur.edges.length - validEdges.length;
    cur = { ...cur, edges: validEdges };
  }

  return { collections: cur, conflicts, edgesPruned };
}

function idSet(c: Collections): { nodes: Set<string>; elements: Set<string> } {
  const nodes = new Set(c.nodes.map((n) => n.id));
  const elements = new Set(nodes);
  for (const img of c.images) elements.add(img.id);
  return { nodes, elements };
}

function applyStep(
  cur: Collections,
  step: Step,
  conflicts: Set<string>,
  onPruned: (n: number) => void,
): Collections {
  const nodes = applyCollOps(cur.nodes, step.ops.nodes);
  const edges = applyCollOps(cur.edges, step.ops.edges);
  const strokes = applyCollOps(cur.strokes, step.ops.strokes);
  const images = applyCollOps(cur.images, step.ops.images);
  const layout = applyLayoutOps(cur.layout, step.ops.layout);
  if (nodes.missed || edges.missed || strokes.missed || images.missed || layout.missed) {
    conflicts.add(step.id);
  }

  let next: Collections = {
    nodes: nodes.list,
    edges: edges.list,
    strokes: strokes.list,
    images: images.list,
    layout: layout.layout,
  };

  // Integrity pass.
  const ids = idSet(next);
  const introduced = new Set(
    step.ops.edges.flatMap((op) => (op.op === "add" || op.op === "set" ? [op.item.id] : [])),
  );
  const kept = next.edges.filter((e) => ids.nodes.has(e.from) && ids.nodes.has(e.to));
  if (kept.length !== next.edges.length) {
    const pruned = next.edges.filter((e) => !ids.nodes.has(e.from) || !ids.nodes.has(e.to));
    onPruned(pruned.length);
    if (pruned.some((e) => introduced.has(e.id))) conflicts.add(step.id);
    next = { ...next, edges: kept };
  }

  const keptLayout: Record<string, Box> = {};
  let layoutChanged = false;
  for (const id of Object.keys(next.layout)) {
    if (ids.elements.has(id)) keptLayout[id] = next.layout[id]!;
    else layoutChanged = true;
  }
  if (layoutChanged) next = { ...next, layout: keptLayout };

  return next;
}
