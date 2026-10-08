// The project_root and main_root columns (ADR 0003): an old database migrates
// to '' (unset), a second open is a no-op, and the roots round-trip.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/server/store.js";

const OLD_SCHEMA = `CREATE TABLE boards (
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
  notebooks   TEXT NOT NULL DEFAULT '[]'
)`;

function oldDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "inkwire-store-"));
  const db = new Database(path.join(dir, "inkwire.db"));
  db.exec(OLD_SCHEMA);
  db.prepare(
    `INSERT INTO boards (id, name, created_at, updated_at, graph, layout, ink, images, viewport)
     VALUES ('b_old', 'old board', 1, 2, '{"nodes":[],"edges":[]}', '{"boxes":{}}', '[]', '[]', '{"x":0,"y":0,"zoom":1}')`,
  ).run();
  db.close();
  return dir;
}

describe("store: project_root migration", () => {
  it("(a) a row from before the column loads and lists with project_root ''", () => {
    const store = new Store(oldDb());
    expect(store.load("b_old")!.meta).toMatchObject({ project_root: "", main_root: "" });
    expect(store.list().find((b) => b.id === "b_old")).toMatchObject({ project_root: "", main_root: "" });
    store.close();
  });

  it("(b) opening the migrated store a second time gives no error", () => {
    const dir = oldDb();
    new Store(dir).close();
    const again = new Store(dir);
    expect(again.load("b_old")!.meta.project_root).toBe("");
    again.close();
  });

  it("(c) create then load and list round-trip the roots", () => {
    const store = new Store(oldDb());
    store.create("b_new", "new", { project_root: "/a/root", main_root: "/a/main" }, 10);
    expect(store.load("b_new")!.meta).toMatchObject({ project_root: "/a/root", main_root: "/a/main" });
    expect(store.list().find((b) => b.id === "b_new")).toMatchObject({ project_root: "/a/root", main_root: "/a/main" });
    store.close();
  });

  it("(d) save with a changed root overwrites on conflict", () => {
    const store = new Store(oldDb());
    const board = store.create("b_new", "new", { project_root: "/a/root" }, 10);
    store.save({ ...board, meta: { ...board.meta, project_root: "/b/root", main_root: "/b/main" } }, 20);
    expect(store.load("b_new")!.meta).toMatchObject({ project_root: "/b/root", main_root: "/b/main", updated_at: 20 });
    const old = store.load("b_old")!;
    store.save({ ...old, meta: { ...old.meta, project_root: "/c/root" } }, 30);
    expect(store.load("b_old")!.meta.project_root).toBe("/c/root");
    store.close();
  });
});
