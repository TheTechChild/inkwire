// The one mutation API (SPEC § 1). MCP handlers pass author "ai"; WebSocket
// intent handlers pass author "human". Errors name the offending id — never
// a silent no-op (SPEC § 9 conventions).
import { inferStructure } from "../core/infer.js";
import type {
  Author,
  Box,
  Collections,
  EdgeEl,
  EdgeKind,
  ImageEl,
  MutationResult,
  NodeEl,
  NodeKind,
  Point,
  StrokeEl,
} from "../shared/types.js";
import { RENDER } from "../shared/tokens.js";
import type { BoardSession } from "./session.js";

function requireNode(c: Collections, id: string): NodeEl {
  const n = c.nodes.find((n) => n.id === id);
  if (!n) throw new Error(`node not found: ${id}`);
  return n;
}

function requireEdge(c: Collections, id: string): EdgeEl {
  const e = c.edges.find((e) => e.id === id);
  if (!e) throw new Error(`edge not found: ${id}`);
  return e;
}

/** A clear spot for a node when the caller gave no position. */
function pickSpot(c: Collections, size: Point): Point {
  const boxes = Object.values(c.layout);
  let x = 80;
  let y = 80;
  for (let i = 0; i < 200; i++) {
    const overlaps = boxes.some(
      ([bx, by, bw, bh]) => x < bx + bw + 16 && x + size[0] + 16 > bx && y < by + bh + 16 && y + size[1] + 16 > by,
    );
    if (!overlaps) return [x, y];
    x += 48;
    y += 32;
  }
  return [x, y];
}

export function addNode(
  s: BoardSession,
  author: Author,
  args: {
    label: string;
    kind: NodeKind;
    at?: Point;
    size?: Point;
    ref?: string;
    endpoint?: string;
    from_ink?: string[];
  },
): MutationResult {
  const id = s.newId("n");
  const size = args.size ?? [...RENDER.nodeDefaultSize] as Point;
  return s.mutate({
    label: `add_node · ${args.label}`,
    author,
    key: null,
    ids: [id],
    apply: (c) => {
      const at = args.at ?? pickSpot(c, size);
      const node: NodeEl = {
        id,
        label: args.label,
        kind: args.kind,
        ref: args.ref ?? null,
        endpoint: args.endpoint ?? null,
        from_ink: args.from_ink ?? null,
        author,
      };
      return {
        ...c,
        nodes: [...c.nodes, node],
        layout: { ...c.layout, [id]: [at[0], at[1], size[0], size[1]] },
      };
    },
  });
}

export function updateNode(
  s: BoardSession,
  author: Author,
  args: {
    node_id: string;
    label?: string;
    kind?: NodeKind;
    ref?: string | null;
    endpoint?: string | null;
    /** For coalescing runs of keystrokes in one field. */
    field?: string;
  },
): MutationResult {
  requireNode(s.collections(), args.node_id);
  return s.mutate({
    label: `update_node · ${args.node_id}`,
    author,
    key: args.field ? `edit:${args.node_id}:${args.field}` : null,
    ids: [args.node_id],
    apply: (c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.id === args.node_id
          ? {
              ...n,
              ...(args.label !== undefined ? { label: args.label } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.ref !== undefined ? { ref: args.ref } : {}),
              ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
            }
          : n,
      ),
    }),
  });
}

export function addEdge(
  s: BoardSession,
  author: Author,
  args: {
    from: string;
    to: string;
    label?: string;
    schema?: string;
    kind?: EdgeKind;
    condition?: string;
    from_ink?: string[];
  },
): MutationResult {
  const c = s.collections();
  requireNode(c, args.from);
  requireNode(c, args.to);
  const id = s.newId("e");
  return s.mutate({
    label: `add_edge · ${args.from} → ${args.to}`,
    author,
    key: null,
    ids: [id],
    apply: (cur) => ({
      ...cur,
      edges: [
        ...cur.edges,
        {
          id,
          from: args.from,
          to: args.to,
          label: args.label ?? null,
          schema: args.schema ?? null,
          kind: args.kind ?? "sync",
          condition: args.condition ?? null,
          from_ink: args.from_ink ?? null,
          author,
        },
      ],
    }),
  });
}

export function updateEdge(
  s: BoardSession,
  author: Author,
  args: {
    edge_id: string;
    label?: string | null;
    schema?: string | null;
    kind?: EdgeKind;
    condition?: string | null;
    field?: string;
  },
): MutationResult {
  requireEdge(s.collections(), args.edge_id);
  return s.mutate({
    label: `update_edge · ${args.edge_id}`,
    author,
    key: args.field ? `edit:${args.edge_id}:${args.field}` : null,
    ids: [args.edge_id],
    apply: (c) => ({
      ...c,
      edges: c.edges.map((e) =>
        e.id === args.edge_id
          ? {
              ...e,
              ...(args.label !== undefined ? { label: args.label } : {}),
              ...(args.schema !== undefined ? { schema: args.schema } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.condition !== undefined ? { condition: args.condition } : {}),
            }
          : e,
      ),
    }),
  });
}

export function deleteElement(s: BoardSession, author: Author, id: string): MutationResult {
  const c = s.collections();
  const exists =
    c.nodes.some((n) => n.id === id) ||
    c.edges.some((e) => e.id === id) ||
    c.strokes.some((k) => k.id === id) ||
    c.images.some((i) => i.id === id);
  if (!exists) throw new Error(`element not found: ${id}`);
  return s.mutate({
    label: `delete · ${id}`,
    author,
    key: null,
    ids: [id],
    apply: (cur) => ({
      nodes: cur.nodes.filter((n) => n.id !== id),
      edges: cur.edges.filter((e) => e.id !== id),
      strokes: cur.strokes.filter((k) => k.id !== id),
      images: cur.images.filter((i) => i.id !== id),
      layout: Object.fromEntries(Object.entries(cur.layout).filter(([k]) => k !== id)),
    }),
  });
}

export function moveElement(
  s: BoardSession,
  author: Author,
  args: { id: string; at: Point; size?: Point },
): MutationResult {
  const c = s.collections();
  const box = c.layout[args.id];
  const isElement = c.nodes.some((n) => n.id === args.id) || c.images.some((i) => i.id === args.id);
  if (!isElement) throw new Error(`element not found or not movable: ${args.id}`);
  const size: Point = args.size ?? (box ? [box[2], box[3]] : [...RENDER.nodeDefaultSize] as Point);
  return s.mutate({
    label: `move · ${args.id}`,
    author,
    key: `move:${args.id}`,
    ids: [args.id],
    apply: (cur) => ({
      ...cur,
      layout: { ...cur.layout, [args.id]: [args.at[0], args.at[1], size[0], size[1]] as Box },
    }),
  });
}

export function addStroke(
  s: BoardSession,
  author: Author,
  points: Point[],
): MutationResult {
  const id = s.newId("k");
  return s.mutate({
    label: `stroke · ${points.length} pts`,
    author,
    key: null,
    ids: [id],
    apply: (c) => ({
      ...c,
      strokes: [...c.strokes, { id, points, author } satisfies StrokeEl],
    }),
  });
}

export function addImage(
  s: BoardSession,
  author: Author,
  args: { src: string; natural: [number, number]; at: Point; size: Point },
): MutationResult {
  const id = s.newId("img");
  return s.mutate({
    label: `add_image · ${id}`,
    author,
    key: null,
    ids: [id],
    apply: (c) => ({
      ...c,
      images: [...c.images, { id, src: args.src, natural: args.natural, author } satisfies ImageEl],
      layout: {
        ...c.layout,
        [id]: [args.at[0], args.at[1], args.size[0], args.size[1]] as Box,
      },
    }),
  });
}

export function annotate(
  s: BoardSession,
  author: Author,
  args: { target_id: string; text: string },
): MutationResult {
  const c = s.collections();
  const targetBox =
    c.layout[args.target_id] ??
    (c.edges.some((e) => e.id === args.target_id) ? edgeBox(c, args.target_id) : undefined);
  if (
    !c.nodes.some((n) => n.id === args.target_id) &&
    !c.edges.some((e) => e.id === args.target_id) &&
    !c.images.some((i) => i.id === args.target_id)
  ) {
    throw new Error(`element not found: ${args.target_id}`);
  }
  const id = s.newId("n");
  const at: Point = targetBox ? [targetBox[0] + targetBox[2] + 24, targetBox[1]] : [80, 80];
  return s.mutate({
    label: `annotate · ${args.target_id}`,
    author,
    key: null,
    ids: [id],
    apply: (cur) => ({
      ...cur,
      nodes: [
        ...cur.nodes,
        {
          id,
          label: args.text,
          kind: "note",
          ref: null,
          endpoint: `re: ${args.target_id}`,
          from_ink: null,
          author,
        } satisfies NodeEl,
      ],
      layout: { ...cur.layout, [id]: [at[0], at[1], 200, 90] },
    }),
  });
}

function edgeBox(c: Collections, edgeId: string): Box | undefined {
  const e = c.edges.find((e) => e.id === edgeId);
  if (!e) return undefined;
  const a = c.layout[e.from];
  const b = c.layout[e.to];
  if (!a || !b) return undefined;
  const mx = (a[0] + a[2] / 2 + b[0] + b[2] / 2) / 2;
  const my = (a[1] + a[3] / 2 + b[1] + b[3] / 2) / 2;
  return [mx, my, 0, 0];
}

export interface InferResult extends MutationResult {
  nodes_added: number;
  edges_added: number;
  strokes_consumed: number;
}

export function inferFromInk(
  s: BoardSession,
  author: Author,
  strokeIds?: string[],
): InferResult {
  const c = s.collections();
  const strokes = strokeIds
    ? c.strokes.filter((k) => strokeIds.includes(k.id))
    : c.strokes;
  if (strokeIds) {
    for (const id of strokeIds) {
      if (!c.strokes.some((k) => k.id === id)) throw new Error(`stroke not found: ${id}`);
    }
  }
  const existing = c.nodes
    .map((n) => ({ id: n.id, box: c.layout[n.id] }))
    .filter((n): n is { id: string; box: Box } => n.box !== undefined);
  const out = inferStructure({
    strokes,
    existing,
    author,
    nextId: (p) => s.newId(p),
  });
  const result = s.mutate({
    label: `infer_structure · ${out.consumedStrokeIds.length} ink → ${out.nodes.length}n/${out.edges.length}e`,
    author,
    key: null,
    ids: [...out.nodes.map((n) => n.node.id), ...out.edges.map((e) => e.id)],
    apply: (cur) => {
      const consumed = new Set(out.consumedStrokeIds);
      const layout = { ...cur.layout };
      for (const n of out.nodes) layout[n.node.id] = n.box;
      return {
        ...cur,
        nodes: [...cur.nodes, ...out.nodes.map((n) => n.node)],
        edges: [...cur.edges, ...out.edges],
        strokes: cur.strokes.filter((k) => !consumed.has(k.id)),
        layout,
      };
    },
  });
  return {
    ...result,
    nodes_added: out.nodes.length,
    edges_added: out.edges.length,
    strokes_consumed: out.consumedStrokeIds.length,
  };
}
