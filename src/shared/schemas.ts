// zod schemas — the contract. JSON Schema is generated from these
// (src/scripts/gen-schemas.ts) and the MCP tools register them directly.
import { z } from "zod";
import { DRAFT_ROLES, EDGE_KINDS, NODE_KINDS } from "./types.js";

export const authorSchema = z.enum(["human", "ai"]);
export const nodeKindSchema = z.enum(NODE_KINDS);
export const edgeKindSchema = z.enum(EDGE_KINDS);

export const pointSchema = z.tuple([z.number(), z.number()]);
export const boxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const nodeSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: nodeKindSchema,
  ref: z.string().nullable(),
  endpoint: z.string().nullable(),
  from_ink: z.array(z.string()).nullable().optional(),
  author: authorSchema,
});

export const edgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().nullable().optional(),
  schema: z.string().nullable().optional(),
  kind: edgeKindSchema,
  condition: z.string().nullable().optional(),
  from_ink: z.array(z.string()).nullable().optional(),
  author: authorSchema,
});

export const strokeSummarySchema = z.strictObject({
  id: z.string(),
  points: z.int().optional(),
  geometry: z.array(pointSchema).optional(),
  bbox: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  author: authorSchema.optional(),
});

export const imageSchema = z.strictObject({
  id: z.string(),
  src: z.string(),
  natural: z.tuple([z.int(), z.int()]),
  author: authorSchema,
});

export const historySummarySchema = z.strictObject({
  steps: z.int().min(0),
  head: z.int().min(0),
  applied: z.int().min(0),
  skipped: z.int().min(0),
  ahead: z.int().min(0),
  conflicts: z.int().min(0),
  edges_pruned: z.int().min(0),
  by_human: z.int().min(0),
  by_ai: z.int().min(0),
});

export const viewportSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  zoom: z.number().min(0.35).max(2.4),
});

export const pathStepSchema = z.strictObject({
  edge: z.string(),
  caption: z.string().max(160),
  ref: z.string().nullable(),
});

export const pathSchema = z.strictObject({
  id: z.string(),
  title: z.string().max(24),
  steps: z.array(pathStepSchema).min(1),
  author: authorSchema,
});

export const layerSchema = z.strictObject({
  id: z.string(),
  letter: z.string(),
  title: z.string().max(24),
  note: z.string(),
  nodes: z.array(z.string()),
  author: authorSchema,
  /** Optional on input so v1 board files import; required on output. */
  paths: z.array(pathSchema).default([]),
});

export const draftRoleSchema = z.enum(DRAFT_ROLES);

export const draftSchema = z.strictObject({
  id: z.string(),
  title: z.string().max(24),
  note: z.string(),
  marks: z.record(z.string(), draftRoleSchema),
  author: authorSchema,
});

export const boundaryEdgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().nullable(),
  kind: edgeKindSchema,
  out_of_scope: z.literal(true),
  crosses_to: z.string(),
});

export const boundaryNodeSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: nodeKindSchema,
  stub: z.literal(true),
});

export const scopeSchema = z.strictObject({
  layer_id: z.string(),
  letter: z.string(),
  title: z.string(),
  note: z.string(),
  omitted: z.strictObject({ nodes: z.int().min(0), edges: z.int().min(0) }),
  whole_board: z.literal("canvas_get_board"),
  paths: z.array(pathSchema),
});

export const canvasStateSchema = z.strictObject({
  board: z.strictObject({ id: z.string(), name: z.string() }),
  graph: z.strictObject({
    revision: z.int().min(0),
    nodes: z.array(nodeSchema),
    edges: z.array(edgeSchema),
    boundary_edges: z.array(boundaryEdgeSchema).optional(),
    boundary_nodes: z.array(boundaryNodeSchema).optional(),
  }),
  layout: z.strictObject({
    revision: z.int().min(0),
    units: z.literal("canvas px"),
    boxes: z.record(z.string(), boxSchema),
  }),
  ink: z.array(strokeSummarySchema),
  images: z.array(imageSchema),
  history: historySummarySchema,
  viewport: viewportSchema,
  layers: z.array(layerSchema),
  focus: z.string().nullable(),
  scope: scopeSchema.optional(),
  drafts: z.array(draftSchema),
  active_draft: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Tool argument schemas (SPEC § 9; schema/tools.generated.json is emitted from these). board_id is optional everywhere:
// the session-scoped current board applies when omitted.

const boardScoped = { board_id: z.string().optional() };
const markArg = z.object({ id: z.string(), role: draftRoleSchema });
const pathStepArg = z.object({
  edge: z.string(),
  caption: z.string().max(160).optional(),
  ref: z.string().nullable().optional(),
});

export const toolArgs = {
  "boards.list": z.object({}),
  "boards.open": z.object({ board_id: z.string() }),
  "boards.create": z.object({ name: z.string().min(1) }),
  "boards.import": z.object({ path: z.string().min(1) }),
  "boards.delete": z.object({ board_id: z.string() }),
  "canvas.get_state": z.object({
    ...boardScoped,
    include_ink_geometry: z.boolean().optional(),
    include_layout: z.boolean().optional(),
  }),
  "canvas.screenshot": z.object({
    ...boardScoped,
    viewport: viewportSchema.optional(),
    fit: z.boolean().optional(),
  }),
  "canvas.infer_structure": z.object({
    ...boardScoped,
    stroke_ids: z.array(z.string()).optional(),
  }),
  "canvas.add_node": z.object({
    ...boardScoped,
    label: z.string(),
    kind: nodeKindSchema,
    at: pointSchema.optional(),
    size: pointSchema.optional(),
    ref: z.string().optional(),
    endpoint: z.string().optional(),
    from_ink: z.array(z.string()).optional(),
  }),
  "canvas.update_node": z.object({
    ...boardScoped,
    node_id: z.string(),
    label: z.string().optional(),
    kind: nodeKindSchema.optional(),
    ref: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
  }),
  "canvas.add_edge": z.object({
    ...boardScoped,
    from: z.string(),
    to: z.string(),
    label: z.string().optional(),
    schema: z.string().optional(),
    kind: edgeKindSchema.default("sync"),
    condition: z.string().optional(),
    from_ink: z.array(z.string()).optional(),
  }),
  "canvas.update_edge": z.object({
    ...boardScoped,
    edge_id: z.string(),
    label: z.string().nullable().optional(),
    schema: z.string().nullable().optional(),
    kind: edgeKindSchema.optional(),
    condition: z.string().nullable().optional(),
  }),
  "canvas.delete": z.object({ ...boardScoped, id: z.string() }),
  "canvas.move": z.object({
    ...boardScoped,
    id: z.string(),
    at: pointSchema,
    size: pointSchema.optional(),
  }),
  "canvas.bind_code": z.object({
    ...boardScoped,
    node_id: z.string(),
    ref: z.string().optional(),
    endpoint: z.string().optional(),
  }),
  "canvas.annotate": z.object({
    ...boardScoped,
    target_id: z.string(),
    text: z.string().min(1),
  }),
  "canvas.set_viewport": z.object({
    ...boardScoped,
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.35).max(2.4),
  }),
  "canvas.get_board": z.object({ ...boardScoped, include_layout: z.boolean().optional() }),
  "canvas.export_mermaid": z.object({ ...boardScoped }),
  "canvas.lint": z.object({ ...boardScoped }),
  "history.get": z.object({ ...boardScoped, limit: z.int().min(1).optional() }),
  "layers.list": z.object({ ...boardScoped }),
  "layers.create": z.object({
    ...boardScoped,
    node_ids: z.array(z.string()).min(1),
    title: z.string().optional(),
    note: z.string().optional(),
    downstream: z.boolean().optional(),
  }),
  "layers.update": z.object({
    ...boardScoped,
    layer_id: z.string(),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
    title: z.string().optional(),
    note: z.string().optional(),
  }),
  "layers.focus": z.object({ ...boardScoped, layer_id: z.string().nullable() }),
  "layers.delete": z.object({ ...boardScoped, layer_id: z.string() }),
  "paths.create": z.object({
    ...boardScoped,
    layer_id: z.string(),
    title: z.string(),
    steps: z.array(pathStepArg).min(1).optional(),
    nodes: z.array(z.string()).min(2).optional(),
    captions: z.array(z.string().max(160)).optional(),
    refs: z.array(z.string().nullable()).optional(),
    extend_layer: z.boolean().optional(),
  }),
  "paths.update": z.object({
    ...boardScoped,
    path_id: z.string(),
    title: z.string().optional(),
    steps: z.array(pathStepArg).min(1).optional(),
  }),
  "paths.delete": z.object({ ...boardScoped, path_id: z.string() }),
  "paths.get": z.object({ ...boardScoped, path_id: z.string() }),
  "paths.play": z.object({ ...boardScoped, path_id: z.string(), hop: z.int().min(1).optional() }),
  "drafts.create": z.object({
    ...boardScoped,
    title: z.string(),
    note: z.string().optional(),
    marks: z.array(markArg).optional(),
  }),
  "drafts.update": z.object({
    ...boardScoped,
    draft_id: z.string(),
    title: z.string().optional(),
    note: z.string().optional(),
    mark: z.array(markArg).optional(),
    unmark: z.array(z.string()).optional(),
  }),
  "drafts.delete": z.object({ ...boardScoped, draft_id: z.string() }),
  "drafts.get": z.object({ ...boardScoped, draft_id: z.string() }),
  "drafts.activate": z.object({ ...boardScoped, draft_id: z.string().nullable() }),
  "session.mode": z.object({ on: z.boolean() }),
  "session.send": z.object({
    ...boardScoped,
    text: z.string().min(1),
    highlight: z
      .object({
        nodes: z.array(z.string()),
        edges: z.array(z.string()),
        label: z.string(),
      })
      .optional(),
    path: z
      .object({ layer_id: z.string(), path_id: z.string(), hop: z.int().min(1).optional() })
      .optional(),
    draft: z.string().optional(),
  }),
} as const;

export type ToolName = keyof typeof toolArgs;
