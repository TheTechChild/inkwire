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

export interface LogRow {
  author: "human" | "ai" | "server";
  text: string;
  at: number;
}

export type ServerMessage =
  | {
      type: "state";
      /** CanvasState with full ink geometry, for rendering. */
      state: import("./types.js").CanvasState;
      history: HistoryRow[];
      log: LogRow[];
    }
  | { type: "error"; text: string }
  | z.infer<typeof captureRequestSchema>;

export { boxSchema };
