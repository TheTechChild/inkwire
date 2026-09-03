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
  paths: Path[]; // ordered walks over the layer's edges; [] for older boards
}

/** One hop of a path: an edge inside the layer, what the human reads while it plays, and its citation. */
export interface PathStep {
  edge: string; // edge id, internal to the layer
  caption: string; // "" when absent; cap 160 chars
  ref: string | null; // optional "path/to/file.ts:symbol", validated like bind_code
}

/** An ordering over a layer, never a second copy of the graph: edge ids only.
 * Nodes are derived: [steps[0].from, ...steps.map(s => s.to)]. Revisits are legal; branching is not. */
export interface Path {
  id: string; // "P1", "P2"… first unused across the board
  title: string; // cap 24, "untitled" when empty
  steps: PathStep[]; // min 1
  author: Author;
}

// ---------------------------------------------------------------------------
// Drafts (handoff "Drafts"): a proposed change and what it touches. The
// fourth pointer: highlight = point at a set, layer = keep a cut, path =
// explain an order, draft = propose a change. A view like a layer — nothing
// on the board changes when a draft is created, marked or activated.

export const DRAFT_ROLES = ["removed", "changed", "added"] as const;
export type DraftRole = (typeof DRAFT_ROLES)[number];

export interface Draft {
  id: string; // "D1", "D2"… first unused across the board
  title: string; // cap 24, "untitled" when empty
  note: string; // "" when absent; what the change is and why
  /** element id (node or edge) → role. Explicit: marking a node marks none of its edges. */
  marks: Record<string, DraftRole>;
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
  paths: Path[];
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
  /** Every draft, whole even on a scoped read: a draft is an overlay, not a cut. */
  drafts: Draft[];
  /** Active draft id, shared by every panel on the board like focus. */
  active_draft: string | null;
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

// ---------------------------------------------------------------------------
// Session (handoff "Session"): the mode flag, the thread, and highlights.
// None of this is persisted — it lives with the running server.

/** Where Claude Code's replies go: the terminal, or the Session tab. One flag per server. */
export type SessionMode = "pty" | "inkwire";

/** An agent-authored, ephemeral pointer at elements. Not a layer, not focus, not selection. */
export interface Highlight {
  label: string; // capped at 40 chars
  nodes: string[];
  edges: string[]; // explicit ids, never derived
}

/** Context the human's reply carried, rendered as a chip: "C · double admin hit", "rev 3". */
export interface CtxChip {
  label: string;
  title: string;
}

/** The path being played on a board: pinned, shared by every panel, never persisted.
 * Panels advance t locally from started_at while running; the server never ticks. */
export interface Trace {
  layer_id: string;
  path_id: string;
  running: boolean;
  loop: boolean;
  t: number; // 0 … steps.length; the base position at started_at
  started_at: number; // server clock (ms) at the last write
}

export type ThreadEntry =
  | { id: string; at: number; type: "you"; text: string; ctx: CtxChip[] }
  | { id: string; at: number; type: "claude"; text: string; highlight?: Highlight; path?: { layer_id: string; path_id: string }; draft?: string }
  | { id: string; at: number; type: "call"; name: string; text: string; json?: string };

/** A ThreadEntry before the server stamps id and time (Omit distributed over the union). */
export type ThreadInput = {
  [K in ThreadEntry["type"]]: Omit<Extract<ThreadEntry, { type: K }>, "id" | "at">;
}[ThreadEntry["type"]];
