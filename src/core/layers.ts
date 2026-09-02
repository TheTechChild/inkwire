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
  Path,
  PathStep,
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
      paths: layer.paths,
    },
  };
}

// ---------------------------------------------------------------------------
// Paths: an ordered walk over a layer's edges. Pure — the walk rule and the
// node→edge resolution are shared by the server (paths_*) and the panel
// (the scrubber's traceInfo).

/** First unused "P{n}" across every layer on the board. */
export function nextPathId(layers: Layer[]): string {
  const used = new Set(layers.flatMap((l) => l.paths.map((p) => p.id)));
  for (let i = 1; i < 1000; i++) if (!used.has(`P${i}`)) return `P${i}`;
  return "P?";
}

/** The node sequence a walk visits: [first.from, ...to], over the longest prefix whose edges exist. */
export function pathNodes(edges: EdgeEl[], steps: PathStep[]): string[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const s of steps) {
    const e = byId.get(s.edge);
    if (!e) break;
    if (out.length === 0) out.push(e.from);
    out.push(e.to);
  }
  return out;
}

/**
 * The walk rule. null, or the first failure naming the hop (1-based), in this
 * order: the edge exists · both ends are in the layer · the chain holds.
 */
export function validateWalk(layer: Layer, edges: EdgeEl[], steps: PathStep[]): string | null {
  const byId = new Map(edges.map((e) => [e.id, e]));
  // An existing edge's endpoints exist (fold integrity), so layer.nodes is liveMembers here.
  const members = new Set(layer.nodes);
  let prev: EdgeEl | null = null;
  for (let i = 0; i < steps.length; i++) {
    const hop = i + 1;
    const e = byId.get(steps[i]!.edge);
    if (!e) return `hop ${hop}: ${steps[i]!.edge} does not exist`;
    if (!members.has(e.from) || !members.has(e.to)) return `hop ${hop}: ${e.id} leaves layer ${layer.letter}`;
    if (prev && e.from !== prev.to) return `hop ${hop}: ${e.id} starts at ${e.from} but hop ${i} ended at ${prev.to}`;
    prev = e;
  }
  return null;
}

/**
 * nodes → steps. Each consecutive pair must be joined by exactly one edge in
 * that direction; a path never walks an edge backwards. Throws naming the hop.
 */
export function resolveNodesToSteps(
  edges: EdgeEl[],
  nodes: string[],
  captions: string[] = [],
  refs: (string | null)[] = [],
): PathStep[] {
  const steps: PathStep[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const [a, b] = [nodes[i]!, nodes[i + 1]!];
    const hop = i + 1;
    const cands = edges.filter((e) => e.from === a && e.to === b);
    if (cands.length === 0) throw new Error(`hop ${hop}: no edge ${a} → ${b}`);
    if (cands.length > 1) {
      const named = cands.map((e) => `${e.id} (${e.label ?? "no label"})`).join(" and ");
      throw new Error(`hop ${hop}: ${a} → ${b} is joined by ${named} — pass steps with the edge you mean`);
    }
    steps.push({ edge: cands[0]!.id, caption: captions[i] ?? "", ref: refs[i] ?? null });
  }
  return steps;
}

export interface PathBreak {
  path_id: string;
  hop: number; // 1-based
  reason: "edge pruned" | "node left layer";
}

/** The first broken hop of every path that no longer validates. A deleted node prunes its edges, so "edge pruned" covers it. */
export function pathsAffected(layers: Layer[], edges: EdgeEl[]): PathBreak[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const out: PathBreak[] = [];
  for (const layer of layers) {
    const members = new Set(layer.nodes);
    for (const p of layer.paths) {
      for (let i = 0; i < p.steps.length; i++) {
        const e = byId.get(p.steps[i]!.edge);
        if (!e) {
          out.push({ path_id: p.id, hop: i + 1, reason: "edge pruned" });
          break;
        }
        if (!members.has(e.from) || !members.has(e.to)) {
          out.push({ path_id: p.id, hop: i + 1, reason: "node left layer" });
          break;
        }
      }
    }
  }
  return out;
}

/** Hops that still play: the whole path, or everything before the first broken hop. */
export function playableHops(layer: Layer, edges: EdgeEl[], path: Path): number {
  const b = pathsAffected([{ ...layer, paths: [path] }], edges)[0];
  return b ? b.hop - 1 : path.steps.length;
}

// Hop timing. The server stamps t and started_at; every panel derives the
// live position from them so viewers stay in step without streaming t.
export const HOP_MS = 1100;
export const REST_MS = 700;

/** Live position 0…n from a trace's base t, its start stamp, and the caller's clock. */
export function traceT(
  tr: { t: number; running: boolean; loop: boolean; started_at: number },
  n: number,
  now: number,
): number {
  if (!tr.running) return Math.min(n, Math.max(0, tr.t));
  const x = Math.max(0, tr.t) + Math.max(0, now - tr.started_at) / HOP_MS;
  if (!tr.loop) return Math.min(n, x);
  // Loop: rest REST_MS at the end, then from 0.
  return Math.min(n, x % (n + REST_MS / HOP_MS));
}
