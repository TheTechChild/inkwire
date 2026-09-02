// Export a board to a self-contained file and import one as a new board.
// Import validates against the shared board-file contract and re-stores the
// embedded bitmaps; the new board starts with the file's content as step 0.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BOARD_FILE_FORMAT,
  BOARD_FILE_VERSION,
  boardFileSchema,
  type BoardFile,
} from "../shared/board-file.js";
import { RENDER } from "../shared/tokens.js";
import type { Collections, EdgeEl, ImageEl, LayoutMap, NodeEl } from "../shared/types.js";
import type { BoardSession, Sessions } from "./session.js";
import type { Store } from "./store.js";

export class ImportError extends Error {}

export function exportBoard(session: BoardSession, store: Store, now: number): BoardFile {
  const c = session.collections();
  const assets: Record<string, string> = {};
  for (const img of c.images) {
    if (!img.src.startsWith("/images/")) continue;
    const file = path.join(store.imagesDir, path.basename(img.src));
    if (!existsSync(file)) continue;
    const mime = path.extname(file) === ".jpg" ? "image/jpeg" : "image/png";
    assets[img.src] = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
  }
  return {
    format: BOARD_FILE_FORMAT,
    version: BOARD_FILE_VERSION,
    name: session.meta.name,
    exported_at: now,
    viewport: session.viewport,
    nodes: c.nodes,
    edges: c.edges,
    strokes: c.strokes,
    images: c.images,
    layout: c.layout,
    assets,
    layers: session.layers,
  };
}

export function exportFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "board"}.inkwire.json`;
}

/** Validate a board file and create a new board holding its content. */
export function importBoard(sessions: Sessions, store: Store, raw: unknown): BoardSession {
  const parsed = boardFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    throw new ImportError(`not an inkwire board file — ${issues}`);
  }
  const file = parsed.data;

  const seen = new Set<string>();
  for (const el of [...file.nodes, ...file.edges, ...file.strokes, ...file.images]) {
    if (seen.has(el.id)) throw new ImportError(`duplicate element id: ${el.id}`);
    seen.add(el.id);
  }

  // Bitmaps: re-store each embedded asset. Sources are content-addressed, so
  // an asset that already exists on this server keeps its src.
  const srcMap = new Map<string, string>();
  for (const [src, dataUri] of Object.entries(file.assets ?? {})) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUri);
    if (!m) throw new ImportError(`asset ${src} is not a base64 png or jpeg data URI`);
    srcMap.set(src, store.saveImage(Buffer.from(m[2]!, "base64"), m[1] === "jpeg" ? "jpg" : "png"));
  }
  const images: ImageEl[] = file.images.map((img) => {
    const src = srcMap.get(img.src);
    if (!src && img.src.startsWith("/images/")) {
      throw new ImportError(`image ${img.id} references ${img.src} but the file carries no asset for it`);
    }
    return { ...img, src: src ?? img.src };
  });

  const nodes: NodeEl[] = file.nodes.map((n) => ({ ...n, from_ink: n.from_ink ?? null }));
  const edges: EdgeEl[] = file.edges.map((e) => ({
    ...e,
    label: e.label ?? null,
    schema: e.schema ?? null,
    condition: e.condition ?? null,
    from_ink: e.from_ink ?? null,
  }));
  // Layout covers exactly the nodes and images; anything unplaced gets a default box.
  const layout: LayoutMap = {};
  for (const id of [...nodes.map((n) => n.id), ...images.map((i) => i.id)]) {
    layout[id] = file.layout[id] ?? [40, 40, RENDER.nodeDefaultSize[0], RENDER.nodeDefaultSize[1]];
  }

  const collections: Collections = { nodes, edges, strokes: file.strokes, images, layout };
  return sessions.create(file.name, {
    collections,
    viewport: file.viewport ?? { x: 0, y: 0, zoom: 1 },
    layers: file.layers ?? [],
  });
}
