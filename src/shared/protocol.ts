// WebSocket protocol between the panel and the server. Client intents use the
// same op vocabulary as the MCP tools — one mutation path (SPEC § 1).
import { z } from "zod";
import {
  boxSchema,
  edgeKindSchema,
  nodeKindSchema,
  pointSchema,
  viewportSchema,
} from "./schemas.js";

// Client → server -----------------------------------------------------------

export const clientIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_stroke"),
    points: z.array(pointSchema).min(2),
  }),
  z.object({
    type: z.literal("add_node"),
    label: z.string(),
    kind: nodeKindSchema,
    at: pointSchema,
    size: pointSchema.optional(),
  }),
  z.object({
    type: z.literal("add_edge"),
    from: z.string(),
    to: z.string(),
    kind: edgeKindSchema.default("sync"),
  }),
  z.object({
    type: z.literal("add_image"),
    src: z.string(),
    natural: z.tuple([z.int(), z.int()]),
    at: pointSchema,
    size: pointSchema,
  }),
  z.object({
    type: z.literal("update_node"),
    node_id: z.string(),
    label: z.string().optional(),
    kind: nodeKindSchema.optional(),
    ref: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
    /** Field name for the coalescing key, e.g. "label". */
    field: z.string().optional(),
  }),
  z.object({
    type: z.literal("update_edge"),
    edge_id: z.string(),
    label: z.string().nullable().optional(),
    schema: z.string().nullable().optional(),
    kind: edgeKindSchema.optional(),
    condition: z.string().nullable().optional(),
    field: z.string().optional(),
  }),
  z.object({ type: z.literal("delete"), id: z.string() }),
  z.object({
    type: z.literal("move"),
    id: z.string(),
    at: pointSchema,
    size: pointSchema.optional(),
  }),
  z.object({
    type: z.literal("history"),
    action: z.enum(["rewind", "skip", "drop", "undo", "redo"]),
    /** External step index for rewind/skip/drop (0 = base, 1..n = steps). */
    index: z.int().min(0).optional(),
    scope: z.enum(["all", "human", "ai"]).default("all"),
  }),
  z.object({ type: z.literal("set_viewport"), viewport: viewportSchema }),
  /** The header's infer_structure action; author is "human" over this transport. */
  z.object({ type: z.literal("infer"), stroke_ids: z.array(z.string()).optional() }),
  z.object({ type: z.literal("layers_focus"), layer_id: z.string().nullable() }),
  /** Rename is the one layer edit the human owns. */
  z.object({ type: z.literal("layers_update"), layer_id: z.string(), title: z.string().optional() }),
  z.object({ type: z.literal("layers_delete"), layer_id: z.string() }),
  /** "→ layer" on a highlight: the one create the human owns. */
  z.object({
    type: z.literal("layers_create"),
    node_ids: z.array(z.string()).min(1),
    title: z.string().optional(),
    note: z.string().optional(),
  }),
  // Session tab. Context travels as ids; the server builds the chips.
  z.object({
    type: z.literal("session_reply"),
    text: z.string().min(1),
    focus: z.string().nullable(),
    selection: z.string().nullable(),
    /** The scrubber's position, ids only. */
    trace: z.object({ path: z.string(), hop: z.int().min(1) }).nullable().default(null),
  }),
  z.object({ type: z.literal("session_mode_off") }),
  /** Toggle a message's highlight as the board's active one; null clears. */
  z.object({ type: z.literal("highlight_set"), msg_id: z.string().nullable() }),
  // The trace. Path ids are board-unique, so the server resolves by path_id alone.
  /** Open the scrubber pinned on a path (from 0 running unless t/running are given); null closes it. */
  z.object({
    type: z.literal("trace_set"),
    path_id: z.string().nullable(),
    t: z.number().min(0).optional(),
    running: z.boolean().optional(),
  }),
  /** A scrub: seek and pause. Only the seeking panel writes t. */
  z.object({ type: z.literal("trace_seek"), t: z.number().min(0) }),
  /** Play, pause, loop. t carries the panel's local position so the server never ticks. */
  z.object({
    type: z.literal("trace_run"),
    running: z.boolean(),
    loop: z.boolean().optional(),
    t: z.number().min(0).optional(),
  }),
]);

export type ClientIntent = z.infer<typeof clientIntentSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  ...clientIntentSchema.options,
]);

// Server → client -----------------------------------------------------------

export interface HistoryRow {
  id: string;
  index: number; // external index, 1..n (base is 0, not listed)
  label: string;
  author: "human" | "ai";
  skipped: boolean;
  conflict: boolean;
  ahead: boolean; // past the head
  at: number;
}

export const captureRequestSchema = z.object({
  type: z.literal("capture_request"),
  capture_id: z.string(),
  viewport: viewportSchema.nullable(),
  fit: z.boolean(),
});

/** The Session tab's slice of server state. Mode and pending are per
 * server; the thread and the highlight belong to the board. */
export interface SessionPush {
  mode: import("./types.js").SessionMode;
  /** A session_send is blocked on the human, and on which board. */
  pending: boolean;
  pending_board: string | null;
  /** Strip body override: a mode-on failure or the idle timeout. */
  notice: string | null;
  thread: import("./types.js").ThreadEntry[];
  highlight: ({ msg_id: string } & import("./types.js").Highlight) | null;
  /** The pinned trace, shared by every panel like focus. Peek is panel-local and never here. */
  trace: import("./types.js").Trace | null;
}

export type ServerMessage =
  | {
      type: "state";
      /** CanvasState with full ink geometry, for rendering. */
      state: import("./types.js").CanvasState;
      history: HistoryRow[];
      session: SessionPush;
    }
  | { type: "error"; text: string }
  | z.infer<typeof captureRequestSchema>;

export { boxSchema };
