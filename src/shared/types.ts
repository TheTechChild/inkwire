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

/** A named subset of nodes — a view over the board, never a container. */
export interface Layer {
  id: string;
  letter: string; // "A".."Z", first unused; "?" when all 26 taken
  title: string; // max 24 chars; "untitled" when empty
  note: string; // "" when absent
  nodes: string[]; // node ids (notes are nodes). Never edges, never ink.
  author: Author;
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

export interface BoundaryEdge {
  id: string;
  from: string;
  to: string;
  label: string | null;
  kind: EdgeKind;
  out_of_scope: true;
  /** The non-member endpoint. */
  crosses_to: string;
}

export interface BoundaryNode {
  id: string;
  label: string;
  kind: NodeKind;
  stub: true;
}

export interface ScopeInfo {
  layer_id: string;
  letter: string;
  title: string;
  note: string;
  omitted: { nodes: number; edges: number };
  whole_board: "canvas_get_board";
}

export interface CanvasState {
  board: { id: string; name: string };
  graph: {
    revision: number;
    nodes: NodeEl[];
    edges: EdgeEl[];
    /** Scoped reads only: edges with exactly one member endpoint. */
    boundary_edges?: BoundaryEdge[];
    /** Scoped reads only: the far endpoints of boundary_edges, as stubs. */
    boundary_nodes?: BoundaryNode[];
  };
  layout: { revision: number; units: "canvas px"; boxes: LayoutMap };
  ink: StrokeSummary[];
  images: ImageEl[];
  history: HistorySummary;
  viewport: Viewport;
  layers: Layer[];
  /** Focused layer id, shared by every panel on the board. */
  focus: string | null;
  /** Present only when the read is scoped to a focused layer. */
  scope?: ScopeInfo;
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
