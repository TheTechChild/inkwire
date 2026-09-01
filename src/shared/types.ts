// Element and history types shared by server, core, and UI.
// Field names match schema/canvas-state.schema.json exactly — these objects
// go over the wire as-is.

export type Author = "human" | "ai";

export const NODE_KINDS = [
  "entry",
  "service",
  "store",
  "transform",
  "note",
  "state",
  "lifeline",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ["sync", "async", "error"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface NodeEl {
  id: string;
  label: string;
  kind: NodeKind;
  ref: string | null;
  endpoint: string | null;
  from_ink: string[] | null;
  author: Author;
}

export interface EdgeEl {
  id: string;
  from: string;
  to: string;
  label: string | null;
  schema: string | null;
  kind: EdgeKind;
  condition: string | null;
  from_ink: string[] | null;
  author: Author;
}

export type Point = [number, number];

export interface StrokeEl {
  id: string;
  points: Point[];
  author: Author;
}

export interface ImageEl {
  id: string;
  src: string;
  natural: [number, number];
  author: Author;
}

/** [x, y, w, h] in canvas px. */
export type Box = [number, number, number, number];

/** id → box, covering nodes and images. Strokes carry their own geometry. */
export type LayoutMap = Record<string, Box>;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The four element collections plus layout — the whole board content. */
export interface Collections {
  nodes: NodeEl[];
  edges: EdgeEl[];
  strokes: StrokeEl[];
  images: ImageEl[];
  layout: LayoutMap;
}

export interface BoardMeta {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// History

export type CollOp<T extends { id: string }> =
  | { op: "add"; item: T }
  | { op: "set"; item: T } // whole-item replacement
  | { op: "del"; id: string };

export type LayoutOp = { op: "set"; id: string; box: Box } | { op: "del"; id: string };

export interface StepOps {
  nodes: CollOp<NodeEl>[];
  edges: CollOp<EdgeEl>[];
  strokes: CollOp<StrokeEl>[];
  images: CollOp<ImageEl>[];
  layout: LayoutOp[];
}

export interface Step {
  id: string;
  label: string;
  author: Author;
  /** Coalescing key, e.g. "move:n3" or "edit:n3:label". */
  key: string | null;
  ops: StepOps;
  skipped: boolean;
  /** Snapshot before this step applied — coalescing re-diffs against it. */
  before: Collections;
  at: number; // epoch ms
}

/**
 * Timeline. steps[i] is external step i+1; step 0 is the base snapshot.
 * head counts applied steps: 0 = base only, steps.length = tip.
 */
export interface History {
  base: Collections;
  steps: Step[];
  head: number;
}

export interface FoldResult {
  collections: Collections;
  /** Step ids flagged conflict: an op missed, or the step orphaned an edge. */
  conflicts: Set<string>;
  /** Dangling edges removed by the integrity pass across the whole fold. */
  edgesPruned: number;
}

// ---------------------------------------------------------------------------
// canvas.get_state wire shapes (see schema/canvas-state.schema.json)

export interface StrokeSummary {
  id: string;
  points?: number;
  geometry?: Point[];
  bbox: { x: number; y: number; w: number; h: number };
  author?: Author;
}

export interface HistorySummary {
  steps: number;
  head: number;
  applied: number;
  skipped: number;
  ahead: number;
  conflicts: number;
  edges_pruned: number;
  by_human: number;
  by_ai: number;
}

export interface CanvasState {
  board: { id: string; name: string };
  graph: { revision: number; nodes: NodeEl[]; edges: EdgeEl[] };
  layout: { revision: number; units: "canvas px"; boxes: LayoutMap };
  ink: StrokeSummary[];
  images: ImageEl[];
  history: HistorySummary;
  viewport: Viewport;
}

export interface MutationResult {
  ok: true;
  ids: string[];
  graph_revision: number;
  layout_revision: number;
  step: string;
}

export function emptyCollections(): Collections {
  return { nodes: [], edges: [], strokes: [], images: [], layout: {} };
}
