// Ink inference (SPEC § 5): a deterministic geometric heuristic. Pure —
// strokes in, created elements out. No database, no history, no side
// effects. Structure it creates flows through the ordinary mutation path.
import { bbox, dist, isClosed, nearestNode, type PlacedNode } from "./geometry.js";
import type {
  Author,
  Box,
  EdgeEl,
  NodeEl,
  StrokeEl,
} from "../shared/types.js";

export interface InferInput {
  /** Strokes to consider (already filtered to the requested subset). */
  strokes: readonly StrokeEl[];
  /** Existing nodes with their layout boxes, for edge snapping. */
  existing: readonly PlacedNode[];
  /** Author recorded on created elements (the transport decides). */
  author: Author;
  /** Injected id generator, for determinism in tests. */
  nextId: (prefix: "n" | "e") => string;
}

export interface InferOutcome {
  nodes: { node: NodeEl; box: Box }[];
  edges: EdgeEl[];
  consumedStrokeIds: string[];
}

const MIN_NODE_W = 50;
const MIN_NODE_H = 30;
const NODE_MIN_RENDER_H = 66;
const MIN_EDGE_DIAG = 50;
const SNAP_DIST = 150;

export function inferStructure(input: InferInput): InferOutcome {
  const nodes: { node: NodeEl; box: Box }[] = [];
  const edges: EdgeEl[] = [];
  const consumed: string[] = [];
  const edgeCandidates: StrokeEl[] = [];

  for (const s of input.strokes) {
    if (s.points.length < 2) continue;
    const b = bbox(s.points);
    const diag = Math.hypot(b.w, b.h);
    if (isClosed(s.points) && b.w > MIN_NODE_W && b.h > MIN_NODE_H) {
      const node: NodeEl = {
        id: input.nextId("n"),
        label: "untitled",
        kind: "service",
        ref: null,
        endpoint: null,
        from_ink: [s.id],
        author: input.author,
      };
      nodes.push({ node, box: [b.x, b.y, b.w, Math.max(NODE_MIN_RENDER_H, b.h)] });
      consumed.push(s.id);
    } else if (diag > MIN_EDGE_DIAG) {
      edgeCandidates.push(s);
    }
    // Anything else — tiny closed doodles, dots — is left alone.
  }

  // Edge endpoints may snap to nodes inferred in this same pass.
  const placed: PlacedNode[] = [
    ...input.existing,
    ...nodes.map((n) => ({ id: n.node.id, box: n.box })),
  ];

  for (const s of edgeCandidates) {
    const first = s.points[0]!;
    const last = s.points[s.points.length - 1]!;
    const a = nearestNode(first, placed, SNAP_DIST);
    const b = nearestNode(last, placed, SNAP_DIST);
    if (a && b && a.id !== b.id) {
      edges.push({
        id: input.nextId("e"),
        from: a.id,
        to: b.id,
        label: null,
        schema: null,
        kind: "sync",
        condition: null,
        from_ink: [s.id],
        author: input.author,
      });
      consumed.push(s.id);
    }
  }

  return { nodes, edges, consumedStrokeIds: consumed };
}

export { dist };
