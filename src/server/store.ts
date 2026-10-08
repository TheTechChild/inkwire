// SQLite persistence (SPEC § 7): one file, many boards, JSON columns,
// whole-board reads and writes. History is never stored. Bitmaps live in a
// sibling images/ directory, named by content hash.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BoardMeta, Collections, Draft, Layer, Notebook, Viewport } from "../shared/types.js";
import { emptyCollections } from "../shared/types.js";

export interface StoredBoard {
  meta: BoardMeta;
  collections: Collections;
  viewport: Viewport;
  layers: Layer[];
  drafts: Draft[];
  notebooks: Notebook[];
}

export interface BoardListing {
  id: string;
  name: string;
  nodes: number;
  edges: number;
  ink: number;
  updated_at: number;
  /** '' means unset (a migrated row). */
  project_root: string;
  /** The main checkout when project_root is in a linked git worktree; '' means none. */
  main_root: string;
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export class Store {
  private db: Database.Database;
  readonly imagesDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.imagesDir = path.join(dataDir, "images");
    mkdirSync(this.imagesDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "inkwire.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS boards (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      graph       TEXT NOT NULL,
      layout      TEXT NOT NULL,
      ink         TEXT NOT NULL,
      images      TEXT NOT NULL,
      viewport    TEXT NOT NULL,
      layers      TEXT NOT NULL DEFAULT '[]',
      drafts      TEXT NOT NULL DEFAULT '[]',
      notebooks   TEXT NOT NULL DEFAULT '[]',
      project_root TEXT NOT NULL DEFAULT '',
      main_root   TEXT NOT NULL DEFAULT ''
    )`);
    // Migration for rows created before layers/drafts/notebooks existed; "duplicate column" is the steady state.
    try {
      this.db.exec("ALTER TABLE boards ADD COLUMN layers TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE boards ADD COLUMN drafts TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE boards ADD COLUMN notebooks TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* column already exists */
    }
    // ADR 0003: '' means unset; only a migrated row holds it.
    try {
      this.db.exec("ALTER TABLE boards ADD COLUMN project_root TEXT NOT NULL DEFAULT ''");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE boards ADD COLUMN main_root TEXT NOT NULL DEFAULT ''");
    } catch {
      /* column already exists */
    }
  }

  list(): BoardListing[] {
    const rows = this.db
      .prepare("SELECT id, name, updated_at, graph, ink, project_root, main_root FROM boards ORDER BY updated_at DESC")
      .all() as { id: string; name: string; updated_at: number; graph: string; ink: string; project_root: string; main_root: string }[];
    return rows.map((r) => {
      const graph = JSON.parse(r.graph) as { nodes: unknown[]; edges: unknown[] };
      const ink = JSON.parse(r.ink) as unknown[];
      return {
        id: r.id,
        name: r.name,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        ink: ink.length,
        updated_at: r.updated_at,
        project_root: r.project_root,
        main_root: r.main_root,
      };
    });
  }

  load(id: string): StoredBoard | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as
      | Record<string, string | number>
      | undefined;
    if (!row) return null;
    const graph = JSON.parse(row.graph as string) as Pick<Collections, "nodes" | "edges">;
    const layout = JSON.parse(row.layout as string) as { boxes: Collections["layout"] };
    return {
      meta: {
        id: row.id as string,
        name: row.name as string,
        created_at: row.created_at as number,
        updated_at: row.updated_at as number,
        project_root: (row.project_root as string | undefined) ?? "",
        main_root: (row.main_root as string | undefined) ?? "",
      },
      collections: {
        nodes: graph.nodes,
        edges: graph.edges,
        strokes: JSON.parse(row.ink as string),
        images: JSON.parse(row.images as string),
        layout: layout.boxes,
      },
      viewport: JSON.parse(row.viewport as string),
      // Rows written before paths existed have no paths field.
      layers: (JSON.parse((row.layers as string | undefined) ?? "[]") as (Omit<Layer, "paths"> & { paths?: Layer["paths"] })[]).map(
        (l) => ({ paths: [], ...l }),
      ),
      // Rows written before drafts existed have no drafts column.
      drafts: JSON.parse((row.drafts as string | undefined) ?? "[]") as Draft[],
      // Rows written before notebooks existed have no notebooks column.
      notebooks: JSON.parse((row.notebooks as string | undefined) ?? "[]") as Notebook[],
    };
  }

  create(
    id: string,
    name: string,
    roots: { project_root: string; main_root?: string },
    now: number,
    content?: { collections: Collections; viewport: Viewport; layers?: Layer[]; drafts?: Draft[]; notebooks?: Notebook[] },
  ): StoredBoard {
    const board: StoredBoard = {
      meta: { id, name, created_at: now, updated_at: now, project_root: roots.project_root, main_root: roots.main_root ?? "" },
      collections: content?.collections ?? emptyCollections(),
      viewport: content?.viewport ?? DEFAULT_VIEWPORT,
      layers: content?.layers ?? [],
      drafts: content?.drafts ?? [],
      notebooks: content?.notebooks ?? [],
    };
    this.save(board, now);
    return board;
  }

  save(board: StoredBoard, now: number): void {
    this.db
      .prepare(
        `INSERT INTO boards (id, name, created_at, updated_at, graph, layout, ink, images, viewport, layers, drafts, notebooks, project_root, main_root)
         VALUES (@id, @name, @created_at, @updated_at, @graph, @layout, @ink, @images, @viewport, @layers, @drafts, @notebooks, @project_root, @main_root)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, updated_at = @updated_at, graph = @graph, layout = @layout,
           ink = @ink, images = @images, viewport = @viewport, layers = @layers, drafts = @drafts, notebooks = @notebooks,
           project_root = @project_root, main_root = @main_root`,
      )
      .run({
        id: board.meta.id,
        name: board.meta.name,
        created_at: board.meta.created_at,
        updated_at: now,
        graph: JSON.stringify({ nodes: board.collections.nodes, edges: board.collections.edges }),
        layout: JSON.stringify({ boxes: board.collections.layout }),
        ink: JSON.stringify(board.collections.strokes),
        images: JSON.stringify(board.collections.images),
        viewport: JSON.stringify(board.viewport),
        layers: JSON.stringify(board.layers),
        drafts: JSON.stringify(board.drafts),
        notebooks: JSON.stringify(board.notebooks),
        project_root: board.meta.project_root,
        main_root: board.meta.main_root,
      });
  }

  /** Remove a board row; false when no such board. Bitmaps stay (content-addressed, may be shared). */
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM boards WHERE id = ?").run(id).changes > 0;
  }

  /** Store a bitmap by content hash; returns the server-relative URL. */
  saveImage(data: Buffer, ext: "png" | "jpg"): string {
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    const file = `${hash}.${ext}`;
    writeFileSync(path.join(this.imagesDir, file), data);
    return `/images/${file}`;
  }

  close(): void {
    this.db.close();
  }
}
