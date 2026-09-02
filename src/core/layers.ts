// Layer math: letters, downstream BFS, tiers, and the scoped read. Pure —
// shared by the server (canvas_get_state) and the panel (render, STATE tab).
import type {
  BoundaryEdge,
  BoundaryNode,
  CanvasState,
  Collections,
  EdgeEl,
  Layer,
  NodeEl,
} from "../shared/types.js";

export type Tier = "in" | "rim" | "out";

/** First unused letter A–Z; "?" once all 26 are taken. */
export function nextLetter(layers: Layer[]): string {
  const used = new Set(layers.map((l) => l.letter));
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!used.has(c)) return c;
  }
  return "?";
}

/** Roots plus everything reachable along from → to. Cycle-safe, stable order. */
export function downstream(edges: EdgeEl[], roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  // ponytail: rescans edges per pop; index by `from` if boards pass a few hundred edges
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id && !seen.has(e.to)) queue.push(e.to);
  }
  return [...seen];
}

/** Member ids that exist in the current fold. Layers never prune themselves. */
export function liveMembers(layer: Layer, nodes: NodeEl[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  return new Set(layer.nodes.filter((id) => ids.has(id)));
}

/**
 * Tier resolvers for a focused layer. No layer → everything "in". Ids that are
 * not nodes (strokes, images) resolve to "out" because they are never members.
 */
export function tiers(
  c: Collections,
  layer: Layer | null,
  rim: boolean,
): { node: (id: string) => Tier; edge: (e: EdgeEl) => Tier } {
  if (!layer) return { node: () => "in", edge: () => "in" };
  const members = liveMembers(layer, c.nodes);
  const adjacent = new Set<string>();
  for (const e of c.edges) {
    const f = members.has(e.from);
    if (f !== members.has(e.to)) adjacent.add(f ? e.to : e.from);
  }
  const rimTier: Tier = rim ? "rim" : "out";
  return {
    node: (id) => (members.has(id) ? "in" : adjacent.has(id) ? rimTier : "out"),
    edge: (e) => {
      const n = Number(members.has(e.from)) + Number(members.has(e.to));
      return n === 2 ? "in" : n === 1 ? rimTier : "out";
    },
  };
}

/** The scoped read (handoff "The scoped read") over a whole-board state. */
export function scopeState(state: CanvasState, layer: Layer): CanvasState {
  const { nodes, edges } = state.graph;
  const members = liveMembers(layer, nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const internal: EdgeEl[] = [];
  const boundary: BoundaryEdge[] = [];
  const stubs = new Map<string, BoundaryNode>();
  for (const e of edges) {
    const f = members.has(e.from);
    const t = members.has(e.to);
    if (f && t) {
      internal.push(e);
    } else if (f || t) {
      const far = f ? e.to : e.from;
      boundary.push({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label ?? null,
        kind: e.kind,
        out_of_scope: true,
        crosses_to: far,
      });
      const n = byId.get(far)!;
      if (!stubs.has(far)) stubs.set(far, { id: n.id, label: n.label, kind: n.kind, stub: true });
    }
  }
  return {
    ...state,
    graph: {
      ...state.graph,
      nodes: nodes.filter((n) => members.has(n.id)),
      edges: internal,
      boundary_edges: boundary,
      boundary_nodes: [...stubs.values()],
    },
    layout: {
      ...state.layout,
      boxes: Object.fromEntries(
        Object.entries(state.layout.boxes).filter(([id]) => members.has(id)),
      ),
    },
    ink: [],
    images: [],
    scope: {
      layer_id: layer.id,
      letter: layer.letter,
      title: layer.title,
      note: layer.note,
      omitted: {
        nodes: nodes.length - members.size,
        edges: edges.length - internal.length - boundary.length,
      },
      whole_board: "canvas_get_board",
    },
  };
}
