// Board file: the portable form of one board — every collection, the
// viewport, and the bitmaps its images reference, embedded as data URIs so
// the file stands alone. History is never included (it is in-memory only).
import { z } from "zod";
import {
  authorSchema,
  boxSchema,
  edgeSchema,
  imageSchema,
  layerSchema,
  nodeSchema,
  pointSchema,
  viewportSchema,
} from "./schemas.js";

export const BOARD_FILE_FORMAT = "inkwire-board";
export const BOARD_FILE_VERSION = 2;

export const boardFileSchema = z.object({
  format: z.literal(BOARD_FILE_FORMAT),
  /** 1: before layers carried paths. layerSchema defaults paths to [], so v1 files import unchanged. */
  version: z.literal([1, BOARD_FILE_VERSION]),
  name: z.string().min(1),
  exported_at: z.number().optional(),
  viewport: viewportSchema.optional(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  strokes: z.array(
    z.object({ id: z.string(), points: z.array(pointSchema).min(2), author: authorSchema }),
  ),
  images: z.array(imageSchema),
  layout: z.record(z.string(), boxSchema),
  /** Bitmaps for images[].src, keyed by that src, as base64 data: URIs. */
  assets: z.record(z.string(), z.string()).optional(),
  layers: z.array(layerSchema).optional(),
});

export type BoardFile = z.infer<typeof boardFileSchema>;
