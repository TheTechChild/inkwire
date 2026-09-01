// Collections before/after → per-collection op lists (SPEC § 4.1).
// `set` is emitted on reference inequality: mutations must replace changed
// items, never mutate them in place — structural sharing IS the change
// detection, exactly as in the prototype.
import type { Box, CollOp, Collections, LayoutOp, StepOps } from "../shared/types.js";

function diffColl<T extends { id: string }>(before: T[], after: T[]): CollOp<T>[] {
  const ops: CollOp<T>[] = [];
  const prev = new Map(before.map((i) => [i.id, i]));
  const next = new Map(after.map((i) => [i.id, i]));
  for (const item of after) {
    const p = prev.get(item.id);
    if (!p) ops.push({ op: "add", item });
    else if (p !== item) ops.push({ op: "set", item });
  }
  for (const item of before) {
    if (!next.has(item.id)) ops.push({ op: "del", id: item.id });
  }
  return ops;
}

function sameBox(a: Box, b: Box): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function diffLayout(before: Record<string, Box>, after: Record<string, Box>): LayoutOp[] {
  const ops: LayoutOp[] = [];
  for (const id of Object.keys(after)) {
    const b = before[id];
    const a = after[id]!;
    if (!b || !sameBox(b, a)) ops.push({ op: "set", id, box: a });
  }
  for (const id of Object.keys(before)) {
    if (!(id in after)) ops.push({ op: "del", id });
  }
  return ops;
}

export function diffCollections(before: Collections, after: Collections): StepOps {
  return {
    nodes: diffColl(before.nodes, after.nodes),
    edges: diffColl(before.edges, after.edges),
    strokes: diffColl(before.strokes, after.strokes),
    images: diffColl(before.images, after.images),
    layout: diffLayout(before.layout, after.layout),
  };
}

export function isEmptyOps(ops: StepOps): boolean {
  return (
    ops.nodes.length === 0 &&
    ops.edges.length === 0 &&
    ops.strokes.length === 0 &&
    ops.images.length === 0 &&
    ops.layout.length === 0
  );
}
