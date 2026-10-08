// TESTS.md § 4 — tool contract tests against the real MCP server, in-process.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../src/server/mcp.js";
import { exportBoard } from "../../src/server/board-file.js";
import { markElement } from "../../src/server/drafts.js";
import { migrateNotes } from "../../src/server/notebooks.js";
import * as mutations from "../../src/server/mutations.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { Sessions } from "../../src/server/session.js";
import { Store } from "../../src/server/store.js";

const handoffSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../fixtures/contract/canvas-state.schema.json", import.meta.url),
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: false });
const validateState = ajv.compile(handoffSchema);

let client: Client;
let store: Store;
let sessions: Sessions;
let projectRoot: string;
let boardId: string;
/** The caller's cwd the server sees (the boards_list overlap filter, relative import paths). */
let cwdNow = "/";

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string; data?: string }[];
    isError?: boolean;
  };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { res, text, json: () => JSON.parse(text) };
}

async function getState() {
  const { json } = await call("canvas_get_state");
  const state = json();
  // Every state read must validate against the handoff schema — drift catcher.
  const ok = validateState(state);
  expect(validateState.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
  return state;
}

beforeAll(async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "inkwire-test-"));
  projectRoot = mkdtempSync(path.join(tmpdir(), "inkwire-root-"));
  writeFileSync(path.join(projectRoot, "auth.ts"), "export function verifyToken() {}\n");
  store = new Store(dataDir);
  sessions = new Sessions(store, { debounceMs: 50 });
  const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
  const mcp = buildMcpServer({
    sessions,
    store,
    screenshots: () => screenshots,
    cwd: () => cwdNow,
    panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  cwdNow = projectRoot;
  const created = await call("boards_create", { name: "contract board", project_root: projectRoot });
  boardId = created.json().board_id;
  expect(boardId).toBeTruthy();
});

afterAll(async () => {
  await client.close();
  store.close();
});

describe("tool contracts", () => {
  it("rejects arguments that fail the schema, naming the field", async () => {
    const { res, text } = await call("canvas_add_node", { kind: "service" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/label/);
  });

  it("add_node returns a mutation result and the node appears in state", async () => {
    const { json } = await call("canvas_add_node", {
      label: "api gateway",
      kind: "entry",
      at: [100, 100],
    });
    const result = json();
    expect(result.ok).toBe(true);
    expect(result.ids).toHaveLength(1);
    const state = await getState();
    expect(state.graph.nodes.map((n: { label: string }) => n.label)).toContain("api gateway");
    expect(state.graph.nodes[0].author).toBe("ai");
  });

  it("add_node and update_node reject kind: note, pointing at notebooks instead", async () => {
    const add = await call("canvas_add_node", { label: "x", kind: "note" });
    expect(add.res.isError).toBe(true);
    expect(add.text).toContain("note is not a node kind — write it in a notebook (notebooks_create) and ref the node as [[n11]]");
    const n = (await call("canvas_add_node", { label: "y", kind: "service" })).json().ids[0];
    const upd = await call("canvas_update_node", { node_id: n, kind: "note" });
    expect(upd.res.isError).toBe(true);
    expect(upd.text).toContain("note is not a node kind");
  });

  it("add_edge with a nonexistent endpoint fails and mutates nothing", async () => {
    const before = await getState();
    const { res, text } = await call("canvas_add_edge", { from: "ghost", to: "ghost2" });
    expect(res.isError).toBe(true);
    expect(text).toContain("ghost");
    const after = await getState();
    expect(after.graph.revision).toBe(before.graph.revision);
    expect(after.graph.edges).toHaveLength(before.graph.edges.length);
  });

  it("move bumps layout_revision only; update_node the opposite", async () => {
    const { json: addJson } = await call("canvas_add_node", {
      label: "orders db",
      kind: "store",
      at: [400, 100],
    });
    const nodeId = addJson().ids[0];
    const s0 = await getState();

    const { json: moveJson } = await call("canvas_move", { id: nodeId, at: [500, 200] });
    const moveResult = moveJson();
    expect(moveResult.layout_revision).toBeGreaterThan(s0.layout.revision);
    expect(moveResult.graph_revision).toBe(s0.graph.revision);

    const { json: updJson } = await call("canvas_update_node", {
      node_id: nodeId,
      label: "orders database",
    });
    const updResult = updJson();
    expect(updResult.graph_revision).toBe(s0.graph.revision + 1);
    expect(updResult.layout_revision).toBe(moveResult.layout_revision);
  });

  it("every mutating tool returns a step id that appears in history_get", async () => {
    const { json } = await call("canvas_add_node", { label: "cache", kind: "store" });
    const step = json().step;
    const { json: histJson } = await call("history_get", {});
    const hist = histJson();
    expect(hist.steps.map((s: { id: string }) => s.id)).toContain(step);
    expect(hist.steps.every((s: { author: string }) => s.author === "ai")).toBe(true);
  });

  it("delete of a node reports its pruned edges too", async () => {
    const a = (await call("canvas_add_node", { label: "a", kind: "service" })).json().ids[0];
    const b = (await call("canvas_add_node", { label: "b", kind: "service" })).json().ids[0];
    const e = (await call("canvas_add_edge", { from: a, to: b })).json().ids[0];
    const del = (await call("canvas_delete", { id: a })).json();
    expect(del.ids).toContain(a);
    expect(del.ids).toContain(e);
    const state = await getState();
    expect(state.graph.edges.map((x: { id: string }) => x.id)).not.toContain(e);
  });

  it("bind_code: outside root fails; missing file fails; missing symbol warns", async () => {
    const n = (await call("canvas_add_node", { label: "auth", kind: "service" })).json().ids[0];

    const escape = await call("canvas_bind_code", { node_id: n, ref: "../outside.ts" });
    expect(escape.res.isError).toBe(true);
    expect(escape.text).toContain("escapes the project root");

    const missing = await call("canvas_bind_code", { node_id: n, ref: "nope.ts" });
    expect(missing.res.isError).toBe(true);
    expect(missing.text).toContain(path.join(projectRoot, "nope.ts"));

    const okMissingSymbol = await call("canvas_bind_code", {
      node_id: n,
      ref: "auth.ts:functionThatIsNotThere",
    });
    const okResult = okMissingSymbol.json();
    expect(okResult.ok).toBe(true);
    expect(okResult.symbol_found).toBe(false);

    const okSymbol = (await call("canvas_bind_code", { node_id: n, ref: "auth.ts:verifyToken" })).json();
    expect(okSymbol.symbol_found).toBe(true);
    expect(okSymbol.project_root).toBe(projectRoot);
    const state = await getState();
    const node = state.graph.nodes.find((x: { id: string }) => x.id === n);
    expect(node.ref).toBe("auth.ts:verifyToken");
  });

  it("bind_code: a #symbol suffix is a symbol, not part of the file path", async () => {
    const n = (await call("canvas_add_node", { label: "auth", kind: "service" })).json().ids[0];
    const hash = (await call("canvas_bind_code", { node_id: n, ref: "auth.ts#verifyToken" })).json();
    expect(hash.ok).toBe(true);
    expect(hash.resolved_path).toBe(path.join(projectRoot, "auth.ts"));
    expect(hash.symbol_found).toBe(true);
    const missing = (await call("canvas_bind_code", { node_id: n, ref: "auth.ts#nope" })).json();
    expect(missing.symbol_found).toBe(false);
    const state = await getState();
    expect(state.graph.nodes.find((x: { id: string }) => x.id === n).ref).toBe("auth.ts#nope");
  });

  it("infer_structure consumes ink and reports counts", async () => {
    // No direct stroke tool — strokes are human intents. Seed via a second
    // board opened fresh, using the session API through boards + state.
    const created = (await call("boards_create", { name: "infer board", project_root: projectRoot })).json();
    const inferBoard = created.board_id;
    // Draw via the mutation path the WS layer uses: not exposed over MCP, so
    // this test seeds strokes by calling infer with nothing and checking the
    // no-op shape instead.
    const out = (await call("canvas_infer_structure", { board_id: inferBoard })).json();
    expect(out.nodes_added).toBe(0);
    expect(out.edges_added).toBe(0);
    expect(out.strokes_consumed).toBe(0);
    // Reopen the original board as current for later tests.
    await call("boards_open", { board_id: boardId });
  });

  it("export_mermaid serializes the current graph", async () => {
    const { json } = await call("canvas_export_mermaid", {});
    expect(json().mermaid).toContain("flowchart TD");
  });

  it("annotate writes a paragraph into the notes notebook, opens it, and creates no node", async () => {
    const n = (await call("canvas_add_node", { label: "queue", kind: "store" })).json().ids[0];
    const before = await getState();
    const ann = (await call("canvas_annotate", { target_id: n, text: "missing retry path" })).json();
    expect(ann).toEqual({ notebook_id: "N1", target_id: n });
    const state = await getState();
    expect(state.graph.nodes).toHaveLength(before.graph.nodes.length); // no node added
    expect(state.graph.revision).toBe(before.graph.revision);
    expect(state.active_notebook).toBe("N1");
    const nb = state.notebooks.find((x: { id: string }) => x.id === "N1");
    expect(nb.title).toBe("notes");
    expect(nb.body).toContain(`[[${n}]] missing retry path`);
    const missing = await call("canvas_annotate", { target_id: "ghost", text: "x" });
    expect(missing.res.isError).toBe(true);
    expect(missing.text).toContain("element not found: ghost");
  });

  it("rejects an image target instead of writing a ref nothing can resolve", async () => {
    const imgId = mutations.addImage(sessions.open(boardId), "human", {
      src: "/images/annotate.png",
      natural: [10, 10],
      at: [9999, 9999],
      size: [10, 10],
    }).ids[0]!;
    const before = await getState();
    const res = await call("canvas_annotate", { target_id: imgId, text: "x" });
    expect(res.res.isError).toBe(true);
    expect(res.text).toContain(`images can't be annotated: ${imgId}`);
    const state = await getState();
    expect(state.notebooks).toEqual(before.notebooks); // nothing written
  });

  it("screenshot with no client falls back to the server renderer (valid PNG)", async () => {
    const res = (await client.callTool({ name: "canvas_screenshot", arguments: {} })) as {
      content: { type: string; data?: string; text?: string; mimeType?: string }[];
    };
    const img = res.content.find((c) => c.type === "image");
    expect(img?.mimeType).toBe("image/png");
    const buf = Buffer.from(img!.data!, "base64");
    // PNG magic.
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("source: server");
    expect(text).toContain("zoom");
  });

  it("lint flags missing refs, missing symbols, unbound nodes, and edge shape", async () => {
    const good = (await call("canvas_add_node", { label: "auth", kind: "service", ref: "auth.ts:verifyToken" })).json().ids[0];
    const gone = (await call("canvas_add_node", { label: "gone", kind: "service", ref: "moved.ts" })).json().ids[0];
    const stale = (await call("canvas_add_node", { label: "stale", kind: "store", ref: "auth.ts:removed" })).json().ids[0];
    const bare = (await call("canvas_add_node", { label: "bare", kind: "transform" })).json().ids[0];
    const err = (await call("canvas_add_edge", { from: good, to: gone, kind: "error" })).json().ids[0];
    const cond = (await call("canvas_add_edge", { from: stale, to: bare, condition: "cached" })).json().ids[0];

    const { findings } = (await call("canvas_lint")).json();
    const check = (id: string) => findings.filter((f: { target_id: string }) => f.target_id === id).map((f: { check: string }) => f.check);
    expect(check(good)).toEqual([]);
    expect(check(gone)).toEqual(["ref_missing"]);
    expect(check(stale)).toEqual(["symbol_missing"]);
    expect(check(bare)).toEqual(["unbound"]);
    expect(check(err)).toEqual(["error_no_condition"]);
    expect(check(cond)).toEqual(["condition_no_branch"]);
  });

  it("boards_list reports counts", async () => {
    // Force persistence so counts are visible in the store.
    await new Promise((r) => setTimeout(r, 120));
    const { json } = await call("boards_list");
    const board = json().boards.find((b: { id: string }) => b.id === boardId);
    expect(board).toBeTruthy();
    expect(board.nodes).toBeGreaterThan(0);
  });

  it("boards_delete removes the row, clears the current board, and a late flush cannot resurrect it", async () => {
    const created = (await call("boards_create", { name: "doomed", project_root: projectRoot })).json();
    try {
      await call("canvas_add_node", { label: "x", kind: "service", at: [0, 0] });
      const stale = sessions.open(created.board_id); // what a disconnecting socket still holds
      const del = (await call("boards_delete", { board_id: created.board_id })).json();
      expect(del).toEqual({ deleted: true, board_id: created.board_id });
      stale.persistNow(); // the disconnect flush — must not resurrect the row
      expect(store.load(created.board_id)).toBeNull();
      expect((await call("canvas_get_state")).res.isError).toBe(true); // current pointer cleared
      expect((await call("boards_delete", { board_id: created.board_id })).text).toMatch(/not found/);
    } finally {
      await call("boards_open", { board_id: boardId });
    }
  });

  it("set_viewport returns ok and moves the stored viewport", async () => {
    const { json } = await call("canvas_set_viewport", { x: 10, y: 20, zoom: 1.5 });
    expect(json().ok).toBe(true);
    const state = await getState();
    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });
});

describe("layers", () => {
  let a: string;
  let b: string;
  let c: string;
  let edgeBC: string;

  beforeAll(async () => {
    a = (await call("canvas_add_node", { label: "la", kind: "entry", at: [0, 0] })).json().ids[0];
    b = (await call("canvas_add_node", { label: "lb", kind: "service", at: [300, 0] })).json().ids[0];
    c = (await call("canvas_add_node", { label: "lc", kind: "store", at: [600, 0] })).json().ids[0];
    await call("canvas_add_edge", { from: a, to: b });
    edgeBC = (await call("canvas_add_edge", { from: b, to: c })).json().ids[0];
  });

  it("create assigns letters A then B, caps the title, and touches neither history nor revisions", async () => {
    const s0 = await getState();
    const l1 = (await call("layers_create", { node_ids: [a, b], title: "x".repeat(40), note: "why" })).json();
    expect(l1).toMatchObject({ letter: "A", members: 2 });
    const l2 = (await call("layers_create", { node_ids: [a], downstream: true })).json();
    expect(l2).toMatchObject({ letter: "B", members: 3 }); // a → b → c
    const list = (await call("layers_list")).json();
    expect(list.focus).toBeNull();
    expect(list.layers.map((l: { title: string }) => l.title)).toEqual(["x".repeat(24), "untitled"]);
    const s1 = await getState();
    expect(s1.graph.revision).toBe(s0.graph.revision);
    expect(s1.layout.revision).toBe(s0.layout.revision);
    expect(s1.history.steps).toBe(s0.history.steps);
    expect(s1.layers).toHaveLength(2);
    await call("layers_delete", { layer_id: l2.layer_id });
  });

  it("focus scopes get_state; get_board and revisions do not move; mutations stay unscoped", async () => {
    const whole = await getState();
    const layerId = whole.layers[0].id;
    expect((await call("layers_focus", { layer_id: layerId })).json()).toEqual({ ok: true });

    const scoped = await getState(); // validates against the handoff schema
    expect(scoped.focus).toBe(layerId);
    expect(scoped.scope).toMatchObject({ layer_id: layerId, letter: "A", whole_board: "canvas_get_board" });
    expect(scoped.graph.nodes.map((n: { id: string }) => n.id).sort()).toEqual([a, b].sort());
    expect(scoped.graph.edges).toHaveLength(1);
    expect(scoped.graph.boundary_edges).toEqual([
      expect.objectContaining({ id: edgeBC, out_of_scope: true, crosses_to: c }),
    ]);
    expect(scoped.graph.boundary_nodes).toEqual([{ id: c, label: "lc", kind: "store", stub: true }]);
    expect(scoped.ink).toEqual([]);
    expect(scoped.scope.omitted.nodes).toBe(whole.graph.nodes.length - 2);
    expect(scoped.scope.omitted.edges).toBe(whole.graph.edges.length - 2);
    expect(Object.keys(scoped.layout.boxes).sort()).toEqual([a, b].sort());
    expect(scoped.graph.revision).toBe(whole.graph.revision);
    expect(scoped.layout.revision).toBe(whole.layout.revision);
    expect(scoped.history.steps).toBe(whole.history.steps);

    const board = (await call("canvas_get_board")).json();
    expect(board.focus).toBe(layerId);
    expect(board.scope).toBeUndefined();
    expect(board.graph.nodes).toHaveLength(whole.graph.nodes.length);

    // Scoping is read-only: an out-of-scope id is still writable.
    const upd = (await call("canvas_update_node", { node_id: c, label: "lc2" })).json();
    expect(upd.ok).toBe(true);
    expect(upd.graph_revision).toBe(whole.graph.revision + 1);

    await call("layers_focus", { layer_id: null });
    const released = await getState();
    expect(released.focus).toBeNull();
    expect(released.scope).toBeUndefined();
    expect(released.graph.revision).toBe(whole.graph.revision + 1);
    expect(released.layout.revision).toBe(whole.layout.revision);
  });

  it("update adds and removes members and rejects unknown node ids; focus rejects unknown layers", async () => {
    const layerId = (await getState()).layers[0].id;
    expect((await call("layers_update", { layer_id: layerId, add: [c], remove: [a] })).json()).toEqual({
      layer_id: layerId,
      members: 2,
      paths_affected: [],
    });
    const bad = await call("layers_update", { layer_id: layerId, add: ["n_ghost"] });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("node not found: n_ghost");
    const badFocus = await call("layers_focus", { layer_id: "L_ghost" });
    expect(badFocus.res.isError).toBe(true);
    expect(badFocus.text).toContain("layer not found: L_ghost");
  });

  it("delete clears focus when focused and leaves the board untouched", async () => {
    const before = await getState();
    const layerId = before.layers[0].id;
    await call("layers_focus", { layer_id: layerId });
    expect((await call("layers_delete", { layer_id: layerId })).json()).toEqual({ ok: true });
    const after = await getState();
    expect(after.focus).toBeNull();
    expect(after.layers).toHaveLength(0);
    expect(after.graph.nodes).toHaveLength(before.graph.nodes.length);
    expect(after.graph.revision).toBe(before.graph.revision);
    expect(after.history.steps).toBe(before.history.steps);
  });
});

describe("paths", () => {
  let p: string;
  let q: string;
  let r: string;
  let s: string;
  let pq: string;
  let pq2: string;
  let qr: string;
  let rs: string;
  let layerId: string;
  const session = () => sessions.open(boardId);
  const listPaths = async () => (await call("layers_list")).json().layers[0].paths;

  beforeAll(async () => {
    p = (await call("canvas_add_node", { label: "pp", kind: "entry", at: [0, 0] })).json().ids[0];
    q = (await call("canvas_add_node", { label: "qq", kind: "service", at: [300, 0] })).json().ids[0];
    r = (await call("canvas_add_node", { label: "rr", kind: "store", at: [600, 0] })).json().ids[0];
    s = (await call("canvas_add_node", { label: "ss", kind: "transform", at: [900, 0] })).json().ids[0];
    pq = (await call("canvas_add_edge", { from: p, to: q, label: "call" })).json().ids[0];
    pq2 = (await call("canvas_add_edge", { from: p, to: q, label: "retry" })).json().ids[0];
    qr = (await call("canvas_add_edge", { from: q, to: r })).json().ids[0];
    rs = (await call("canvas_add_edge", { from: r, to: s })).json().ids[0];
    await call("canvas_bind_code", { node_id: p, ref: "auth.ts:verifyToken" });
    layerId = (await call("layers_create", { node_ids: [p, q, r], title: "walk" })).json().layer_id;
  });

  it("create from steps assigns P1, derives the nodes, and layers_list carries it; neither history nor revisions move", async () => {
    const s0 = await getState();
    const out = (await call("paths_create", { layer_id: layerId, title: "x".repeat(30), steps: [{ edge: pq, caption: "in" }, { edge: qr }] })).json();
    expect(out).toEqual({ path_id: "P1", hops: 2, nodes: [p, q, r], layer_extended: [] });
    expect(await listPaths()).toEqual([{ id: "P1", title: "x".repeat(24), hops: 2 }]);
    const s1 = await getState();
    expect(s1.graph.revision).toBe(s0.graph.revision);
    expect(s1.history.steps).toBe(s0.history.steps);
    expect(s1.layers[0].paths[0]).toMatchObject({ id: "P1", author: "ai", steps: [{ edge: pq, caption: "in", ref: null }, { edge: qr, caption: "", ref: null }] });
  });

  it("an edge outside the layer fails with the walk rule's message and creates nothing", async () => {
    const bad = await call("paths_create", { layer_id: layerId, title: "t", steps: [{ edge: qr }, { edge: rs }] });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain(`hop 2: ${rs} leaves layer A`);
    const ghost = await call("paths_create", { layer_id: layerId, title: "t", steps: [{ edge: "e_ghost" }] });
    expect(ghost.text).toContain("hop 1: e_ghost does not exist");
    expect(await listPaths()).toHaveLength(1);
  });

  it("extend_layer adds the missing endpoints and reports them", async () => {
    const out = (await call("paths_create", { layer_id: layerId, title: "long", steps: [{ edge: qr }, { edge: rs }], extend_layer: true })).json();
    expect(out).toEqual({ path_id: "P2", hops: 2, nodes: [q, r, s], layer_extended: [s] });
    const list = (await call("layers_list")).json().layers[0];
    expect(list.members).toBe(4);
    expect(list.paths).toHaveLength(2);
  });

  it("nodes resolve to edges; a pair joined twice names both edges", async () => {
    const twice = await call("paths_create", { layer_id: layerId, title: "t", nodes: [p, q] });
    expect(twice.res.isError).toBe(true);
    expect(twice.text).toContain(`hop 1: ${p} → ${q} is joined by ${pq} (call) and ${pq2} (retry) — pass steps with the edge you mean`);
    const none = await call("paths_create", { layer_id: layerId, title: "t", nodes: [q, p] });
    expect(none.text).toContain(`hop 1: no edge ${q} → ${p}`);
    const ok = (await call("paths_create", { layer_id: layerId, title: "t", nodes: [q, r], captions: ["reads"] })).json();
    expect(ok).toMatchObject({ path_id: "P3", hops: 1, nodes: [q, r] });
    expect((await call("paths_delete", { path_id: "P3" })).json()).toEqual({ ok: true });
    expect((await listPaths()).map((x: { id: string }) => x.id)).toEqual(["P1", "P2"]);
    expect((await call("paths_delete", { path_id: "P3" })).text).toContain("path not found: P3");
  });

  it("update retitles or replaces the steps whole; a bad chain leaves the path unchanged", async () => {
    expect((await call("paths_update", { path_id: "P1", title: "the walk" })).json()).toEqual({ path_id: "P1", hops: 2 });
    const bad = await call("paths_update", { path_id: "P1", steps: [{ edge: qr }, { edge: pq }] });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain(`hop 2: ${pq} starts at ${p} but hop 1 ended at ${r}`);
    const got = (await call("paths_get", { path_id: "P1" })).json();
    expect(got.title).toBe("the walk");
    expect(got.hops.map((h: { edge: string }) => h.edge)).toEqual([pq, qr]);
  });

  it("get resolves node labels, refs, edge labels and captions per hop", async () => {
    const got = (await call("paths_get", { path_id: "P1" })).json();
    expect(got).toMatchObject({ path_id: "P1", layer_id: layerId });
    expect(got.hops[0]).toEqual({
      index: 1,
      edge: pq,
      from: { id: p, label: "pp", ref: "auth.ts:verifyToken", endpoint: null },
      to: { id: q, label: "qq", ref: null, endpoint: null },
      label: "call",
      condition: null,
      caption: "in",
      ref: null,
      ref_hash: null,
      line: null,
      end: null,
      ref_status: null,
    });
    expect(got.hops[1]).toMatchObject({ index: 2, edge: qr, label: null, caption: "" });
  });

  it("play pins the trace: running from 0, or paused at hop (clamped); a highlight closes it", async () => {
    expect((await call("paths_play", { path_id: "P1" })).json()).toEqual({
      ok: true,
      warnings: ["path P1 hop 2: no ref on the hop or on either node"],
    });
    expect(session().trace).toMatchObject({ layer_id: layerId, path_id: "P1", running: true, loop: false, t: 0 });
    await call("paths_play", { path_id: "P1", hop: 2 });
    expect(session().trace).toMatchObject({ path_id: "P1", running: false, t: 2 });
    await call("paths_play", { path_id: "P1", hop: 9 });
    expect(session().trace?.t).toBe(2);
    expect((await call("paths_play", { path_id: "P9" })).text).toContain("path not found: P9");
    expect(session().log.at(-1)).toMatchObject({ author: "ai", text: "paths_play · P1" });
    const msg = session().addThread({ type: "claude", text: "look", highlight: { label: "h", nodes: [p], edges: [] } });
    session().setHighlight(msg.id);
    expect(session().trace).toBeNull();
    expect(session().highlight?.msgId).toBe(msg.id);
    await call("paths_play", { path_id: "P1" });
    expect(session().highlight).toBeNull();
  });

  it("a step ref to a missing file fails; a missing symbol warns on the result", async () => {
    const missing = await call("paths_create", { layer_id: layerId, title: "t", steps: [{ edge: qr, ref: "nope.ts" }] });
    expect(missing.res.isError).toBe(true);
    expect(missing.text).toContain("file not found");
    expect(await listPaths()).toHaveLength(2);
    const warned = (await call("paths_create", { layer_id: layerId, title: "cited", nodes: [q, r], refs: ["auth.ts:gone"] })).json();
    expect(warned).toMatchObject({ path_id: "P3", hops: 1, warnings: ["hop 1: symbol not found in auth.ts:gone"] });
    const fine = (await call("paths_update", { path_id: "P3", steps: [{ edge: qr, ref: "auth.ts:verifyToken" }] })).json();
    expect(fine).toEqual({ path_id: "P3", hops: 1 });
    await call("paths_update", { path_id: "P3", steps: [{ edge: qr, ref: "auth.ts:gone" }] });
  });

  it("layers_update.remove and canvas_delete report paths_affected; lint reports the broken hops and hop refs", async () => {
    const removed = (await call("layers_update", { layer_id: layerId, remove: [s] })).json();
    expect(removed.paths_affected).toEqual([{ path_id: "P2", hop: 2, reason: "node left layer" }]);
    let { findings } = (await call("canvas_lint")).json();
    expect(findings.filter((f: { target_id: string }) => f.target_id === "P2")).toEqual([
      { target_id: "P2", check: "path_broken", level: "warn", message: `path P2 hop 2: ${rs} leaves layer A` },
      { target_id: "P2", check: "path_hop_unbound", level: "warn", message: "path P2 hop 1: no ref on the hop or on either node" },
      { target_id: "P2", check: "path_hop_unbound", level: "warn", message: "path P2 hop 2: no ref on the hop or on either node" },
    ]);
    expect(findings.filter((f: { target_id: string }) => f.target_id === "P3")).toEqual([
      { target_id: "P3", check: "path_symbol_missing", level: "warn", message: "path P3 hop 1: symbol gone" },
    ]);

    const del = (await call("canvas_delete", { id: r })).json();
    expect(del.ids).toContain(qr);
    // P2 was already broken at hop 2; it now breaks at hop 1, so it is reported again (by hop, not by path).
    expect(del.paths_affected).toEqual([
      { path_id: "P1", hop: 2, reason: "edge pruned" },
      { path_id: "P2", hop: 1, reason: "edge pruned" },
      { path_id: "P3", hop: 1, reason: "edge pruned" },
    ]);
    ({ findings } = (await call("canvas_lint")).json());
    expect(findings.find((f: { target_id: string }) => f.target_id === "P1")).toEqual({
      target_id: "P1", check: "path_broken", level: "warn", message: "path P1 hop 2 references a pruned edge",
    });
    expect((await call("paths_play", { path_id: "P1" })).json().warnings).toContain("path P1 hop 2 references a pruned edge");
    // The path survives; get gives nulls for the pruned hop.
    const got = (await call("paths_get", { path_id: "P1" })).json();
    expect(got.hops[1]).toMatchObject({ edge: qr, from: null, to: null, label: null });
  });

  it("scoped get_state carries the layer's paths and validates against the fixture", async () => {
    await call("layers_focus", { layer_id: layerId });
    const scoped = await getState();
    expect(scoped.scope.paths.map((x: { id: string }) => x.id)).toEqual(["P1", "P2", "P3"]);
    expect(scoped.scope.paths[0].steps[0]).toEqual({ edge: pq, caption: "in", ref: null, ref_hash: null });
    await call("layers_focus", { layer_id: null });
  });

  it("deleting the playing path or its layer closes the trace", async () => {
    await call("paths_play", { path_id: "P3" });
    expect(session().trace?.path_id).toBe("P3");
    await call("paths_delete", { path_id: "P3" });
    expect(session().trace).toBeNull();
    await call("paths_play", { path_id: "P1" });
    expect(session().trace?.path_id).toBe("P1");
    await call("layers_delete", { layer_id: layerId });
    expect(session().trace).toBeNull();
    expect((await call("layers_list")).json().layers).toEqual([]);
  });
});

describe("ref stamps", () => {
  const file = () => path.join(projectRoot, "stamp.ts");
  const src = (body: string) => `export function work() {\n${body}\n}\nexport function other() {\n  return 1;\n}\n`;
  let a: string;
  let b: string;
  let c: string;
  let ab: string;
  let bc: string;
  let layer: string;
  const lint = async (id: string) =>
    (await call("canvas_lint")).json().findings.filter((f: { target_id: string; check: string }) => f.target_id === id && f.check !== "path_hop_unbound");

  beforeAll(async () => {
    writeFileSync(file(), src("  return 1;"));
    [a, b, c] = [
      (await call("canvas_add_node", { label: "sa", kind: "entry" })).json().ids[0],
      (await call("canvas_add_node", { label: "sb", kind: "service" })).json().ids[0],
      (await call("canvas_add_node", { label: "sc", kind: "store" })).json().ids[0],
    ];
    ab = (await call("canvas_add_edge", { from: a, to: b })).json().ids[0];
    bc = (await call("canvas_add_edge", { from: b, to: c })).json().ids[0];
    layer = (await call("layers_create", { node_ids: [a, b, c], title: "stamps" })).json().layer_id;
  });

  it("bind_code returns line and end; get no longer matches getPath", async () => {
    writeFileSync(path.join(projectRoot, "only.ts"), "export function getPath() {\n  return 1;\n}\n");
    const ok = (await call("canvas_bind_code", { node_id: a, ref: "only.ts:getPath" })).json();
    expect(ok).toMatchObject({ symbol_found: true, line: 1, end: 3 });
    const no = (await call("canvas_bind_code", { node_id: a, ref: "only.ts:get" })).json();
    expect(no).toMatchObject({ symbol_found: false, line: null, end: null });
  });

  it("create stamps the hop; a body edit flags it, a re-indent does not; update keeps and verify clears the flag", async () => {
    const out = (await call("paths_create", {
      layer_id: layer,
      title: "stamped",
      steps: [{ edge: ab, caption: "one", ref: "stamp.ts:work" }, { edge: bc, caption: "two", ref: "stamp.ts:other" }],
    })).json();
    const id = out.path_id;
    expect(await lint(id)).toEqual([]);
    const got = (await call("paths_get", { path_id: id })).json();
    expect(got.hops[0]).toMatchObject({ line: 1, end: 3, ref_status: "ok" });

    writeFileSync(file(), src("      return 1;")); // re-indent only
    expect(await lint(id)).toEqual([]);

    writeFileSync(file(), src("  return 2;")); // real edit to work; other is untouched
    const flagged = await lint(id);
    expect(flagged).toEqual([
      { target_id: id, check: "path_ref_changed", level: "warn", message: `path ${id} hop 1: stamp.ts:work (line 1) changed since the hop was verified` },
    ]);
    expect((await call("paths_get", { path_id: id })).json().hops[0].ref_status).toBe("changed");
    expect((await call("paths_play", { path_id: id })).json().warnings).toEqual([flagged[0].message]);

    // Changing hop 2 keeps hop 1's stale flag.
    await call("paths_update", { path_id: id, steps: [{ edge: ab, caption: "one", ref: "stamp.ts:work" }, { edge: bc, caption: "two!", ref: "stamp.ts:other" }] });
    expect((await lint(id)).map((f: { message: string }) => f.message)).toEqual([flagged[0].message]);

    // verify on a hop with no ref fails.
    const noRef = await call("paths_update", { path_id: id, steps: [{ edge: ab, caption: "one", ref: "stamp.ts:work" }, { edge: bc, caption: "two!" }], verify: [2] });
    expect(noRef.res.isError).toBe(true);
    expect(noRef.text).toContain("hop 2 has no ref to verify");
    const range = await call("paths_update", { path_id: id, verify: [9] });
    expect(range.text).toContain("hop 9 is out of range");

    expect((await call("paths_update", { path_id: id, verify: [1] })).json()).toEqual({ path_id: id, hops: 2 });
    expect(await lint(id)).toEqual([]);
  });

  it("a stored step with no ref_hash is never verified; a hop with no ref anywhere is unbound", async () => {
    const id = (await call("paths_create", { layer_id: layer, title: "legacy", steps: [{ edge: ab, ref: "stamp.ts:work" }, { edge: bc }] })).json().path_id;
    const s = sessions.open(boardId);
    s.updateLayers("ai", "legacy", (ls) =>
      ls.map((l) => ({ ...l, paths: l.paths.map((p) => (p.id === id ? { ...p, steps: p.steps.map(({ ref_hash: _h, ...rest }) => rest) } : p)) })),
    );
    const { findings } = (await call("canvas_lint")).json();
    const mine = findings.filter((f: { target_id: string }) => f.target_id === id).map((f: { check: string; message: string }) => [f.check, f.message]);
    expect(mine).toEqual([
      ["path_ref_unverified", `path ${id} hop 1: stamp.ts:work (line 1) was never verified`],
      ["path_hop_unbound", `path ${id} hop 2: no ref on the hop or on either node`],
    ]);
  });

  it("a hop between two endpoint-only nodes is not unbound", async () => {
    const [x, y] = [
      (await call("canvas_add_node", { label: "ex", kind: "entry" })).json().ids[0],
      (await call("canvas_add_node", { label: "ey", kind: "service" })).json().ids[0],
    ];
    await call("canvas_bind_code", { node_id: x, endpoint: "GET /x" });
    await call("canvas_bind_code", { node_id: y, endpoint: "GET /y" });
    const xy = (await call("canvas_add_edge", { from: x, to: y })).json().ids[0];
    const l = (await call("layers_create", { node_ids: [x, y], title: "endpoints" })).json().layer_id;
    const id = (await call("paths_create", { layer_id: l, title: "ep", steps: [{ edge: xy }] })).json().path_id;
    const { findings } = (await call("canvas_lint")).json();
    expect(findings.filter((f: { target_id: string }) => f.target_id === id)).toEqual([]);
  });

  it("a ref whose symbol is missing gets no stamp; the symbol appearing later reads as never verified", async () => {
    const out = (await call("paths_create", { layer_id: layer, title: "later", steps: [{ edge: ab, ref: "stamp.ts:later" }] })).json();
    const id = out.path_id;
    expect(out.warnings).toEqual(["hop 1: symbol not found in stamp.ts:later"]);
    const stored = () => sessions.open(boardId).layers.flatMap((l) => l.paths).find((p) => p.id === id)!.steps[0]!;
    expect(stored().ref_hash).toBeNull();

    const verify = await call("paths_update", { path_id: id, verify: [1] });
    expect(verify.res.isError).toBe(true);
    expect(verify.text).toContain("hop 1: symbol not found in stamp.ts:later — nothing to verify");

    writeFileSync(file(), `${src("  return 2;")}export function later() {\n  return 3;\n}\n`);
    expect((await lint(id)).map((f: { message: string }) => f.message)).toEqual([`path ${id} hop 1: stamp.ts:later (line 7) was never verified`]);
  });

  it("a ref_hash sent in a step never lands; a ref to a missing file fails and writes nothing", async () => {
    const hash = (id: string) => sessions.open(boardId).layers.flatMap((l) => l.paths).find((p) => p.id === id)!.steps[0]!.ref_hash;
    const made = await call("paths_create", { layer_id: layer, title: "forged", steps: [{ edge: ab, ref: "stamp.ts:work", ref_hash: "forged" }] });
    const id = made.json().path_id;
    expect(hash(id)).not.toBe("forged");
    const upd = await call("paths_update", { path_id: id, steps: [{ edge: ab, caption: "x", ref: "stamp.ts:work", ref_hash: "forged" }] });
    expect(upd.res.isError).not.toBe(true);
    expect(hash(id)).not.toBe("forged");

    const before = JSON.stringify(sessions.open(boardId).layers);
    const c1 = await call("paths_create", { layer_id: layer, title: "nofile", steps: [{ edge: ab, ref: "nofile.ts:x" }] });
    expect(c1.res.isError).toBe(true);
    const c2 = await call("paths_update", { path_id: id, steps: [{ edge: ab, ref: "nofile.ts:x" }] });
    expect(c2.res.isError).toBe(true);
    expect(JSON.stringify(sessions.open(boardId).layers)).toBe(before);
  });
});

describe("drafts", () => {
  let a: string;
  let b: string;
  let c: string;
  let ab: string;
  let bc: string;
  let imgId: string;

  beforeAll(async () => {
    a = (await call("canvas_add_node", { label: "da", kind: "entry", at: [0, 0] })).json().ids[0];
    b = (await call("canvas_add_node", { label: "db", kind: "service", at: [300, 0] })).json().ids[0];
    c = (await call("canvas_add_node", { label: "dc", kind: "store", at: [600, 0] })).json().ids[0];
    ab = (await call("canvas_add_edge", { from: a, to: b, label: "call" })).json().ids[0];
    bc = (await call("canvas_add_edge", { from: b, to: c })).json().ids[0];
    imgId = mutations.addImage(sessions.open(boardId), "human", {
      src: "/images/x.png",
      natural: [10, 10],
      at: [0, 0],
      size: [10, 10],
    }).ids[0]!;
  });

  it("create marks elements, assigns D1, and touches neither history nor revisions", async () => {
    const s0 = await getState();
    const out = (await call("drafts_create", {
      title: "x".repeat(30),
      note: "why",
      marks: [{ id: a, role: "removed" }, { id: ab, role: "changed" }],
    })).json();
    expect(out).toEqual({ draft_id: "D1", marks: { [a]: "removed", [ab]: "changed" } });
    const s1 = await getState();
    expect(s1.graph.revision).toBe(s0.graph.revision);
    expect(s1.layout.revision).toBe(s0.layout.revision);
    expect(s1.history.steps).toBe(s0.history.steps);
    expect(s1.drafts).toEqual([
      { id: "D1", title: "x".repeat(24), note: "why", marks: { [a]: "removed", [ab]: "changed" }, author: "ai" },
    ]);
    expect(s1.active_draft).toBeNull();
  });

  it("a bad id fails naming it; an image id fails too, and creates nothing", async () => {
    const bad = await call("drafts_create", { title: "t", marks: [{ id: "n_ghost", role: "added" }] });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("not a node or edge: n_ghost");
    const img = await call("drafts_create", { title: "t", marks: [{ id: imgId, role: "added" }] });
    expect(img.res.isError).toBe(true);
    expect(img.text).toContain(`not a node or edge: ${imgId}`);
    expect((await getState()).drafts).toHaveLength(1);
  });

  it("update retitles, rewrites the note, marks/unmarks; marking again replaces the role", async () => {
    const out = (await call("drafts_update", {
      draft_id: "D1",
      title: "renamed",
      note: "why now",
      mark: [{ id: b, role: "added" }, { id: a, role: "changed" }],
      unmark: [ab],
    })).json();
    expect(out).toEqual({ draft_id: "D1", marks: { [a]: "changed", [b]: "added" } });
    const badMark = await call("drafts_update", { draft_id: "D1", mark: [{ id: imgId, role: "added" }] });
    expect(badMark.res.isError).toBe(true);
    expect(badMark.text).toContain(`not a node or edge: ${imgId}`);
    const badDraft = await call("drafts_update", { draft_id: "D9", title: "x" });
    expect(badDraft.text).toContain("draft not found: D9");
  });

  it("get resolves node and edge marks to labels", async () => {
    await call("drafts_update", { draft_id: "D1", mark: [{ id: bc, role: "removed" }] });
    const got = (await call("drafts_get", { draft_id: "D1" })).json();
    expect(got.title).toBe("renamed");
    expect(got.note).toBe("why now");
    expect(got.marks).toEqual(expect.arrayContaining([
      { id: a, role: "changed", label: "da", kind: "entry" },
      { id: b, role: "added", label: "db", kind: "service" },
      { id: bc, role: "removed", label: null, edge: { from: b, to: c } },
    ]));
    expect((await call("drafts_get", { draft_id: "D9" })).text).toContain("draft not found: D9");
  });

  it("activate sets active_draft, shared by every read; unknown id fails; null releases", async () => {
    expect((await call("drafts_activate", { draft_id: "D1" })).json()).toEqual({ ok: true });
    expect((await getState()).active_draft).toBe("D1");
    const bad = await call("drafts_activate", { draft_id: "D9" });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("draft not found: D9");
    expect((await call("drafts_activate", { draft_id: null })).json()).toEqual({ ok: true });
    expect((await getState()).active_draft).toBeNull();
  });

  it("markElement (drafts_mark, WS-only) validates before creating: a bad id with no active draft creates and activates nothing", async () => {
    const session = sessions.open(boardId);
    const before = session.drafts.length;
    expect(() => markElement(session, "human", { draft_id: null, id: "n_ghost", role: "added" })).toThrow(
      "not a node or edge: n_ghost",
    );
    expect(session.drafts.length).toBe(before);
    expect(session.activeDraft).toBeNull();
  });

  it("deleting a marked element leaves the mark; canvas_delete reports drafts_affected; canvas_lint warns", async () => {
    const del = (await call("canvas_delete", { id: c })).json(); // prunes bc too
    expect(del.ids).toEqual(expect.arrayContaining([c, bc]));
    expect(del.drafts_affected).toEqual(expect.arrayContaining([{ draft_id: "D1", id: bc }]));
    const got = (await call("drafts_get", { draft_id: "D1" })).json();
    expect(got.marks).toContainEqual({ id: bc, role: "removed", gone: true });
    const { findings } = (await call("canvas_lint")).json();
    expect(findings).toContainEqual({
      target_id: bc,
      check: "draft_mark_gone",
      level: "warn",
      message: `draft D1 marks ${bc}, which no longer exists`,
    });
  });

  it("scoped get_state carries drafts whole and validates against the fixture", async () => {
    const layerId = (await call("layers_create", { node_ids: [a, b], title: "scope" })).json().layer_id;
    await call("layers_focus", { layer_id: layerId });
    const scoped = await getState(); // validates against the handoff schema
    expect(scoped.drafts).toHaveLength(1);
    expect(scoped.drafts[0].id).toBe("D1");
    await call("layers_focus", { layer_id: null });
    await call("layers_delete", { layer_id: layerId });
  });

  it("delete removes the draft and deactivates it when it was active", async () => {
    await call("drafts_activate", { draft_id: "D1" });
    expect((await call("drafts_delete", { draft_id: "D1" })).json()).toEqual({ ok: true });
    expect((await getState()).active_draft).toBeNull();
    expect((await getState()).drafts).toEqual([]);
    expect((await call("drafts_delete", { draft_id: "D1" })).text).toContain("draft not found: D1");
  });
});

describe("notebooks", () => {
  it("create assigns the next id, clamps the title at 40, and touches neither history nor revisions", async () => {
    const s0 = await getState();
    const out = (await call("notebooks_create", { title: "x".repeat(50), body: "hello" })).json();
    expect(out.notebook_id).toMatch(/^N\d+$/);
    const s1 = await getState();
    expect(s1.graph.revision).toBe(s0.graph.revision);
    expect(s1.layout.revision).toBe(s0.layout.revision);
    expect(s1.history.steps).toBe(s0.history.steps);
    const nb = s1.notebooks.find((n: { id: string }) => n.id === out.notebook_id);
    expect(nb).toMatchObject({ id: out.notebook_id, title: "x".repeat(40), body: "hello", author: "ai" });
  });

  it("update retitles, replaces the body, or appends; append is last write wins", async () => {
    const id = (await call("notebooks_create", { title: "notes on x" })).json().notebook_id;
    await call("notebooks_update", { notebook_id: id, body: "first line" });
    await call("notebooks_update", { notebook_id: id, append: "second line" });
    const nb1 = (await getState()).notebooks.find((n: { id: string }) => n.id === id);
    expect(nb1.body).toBe("first line\nsecond line");
    await call("notebooks_update", { notebook_id: id, title: "renamed" });
    const nb2 = (await getState()).notebooks.find((n: { id: string }) => n.id === id);
    expect(nb2.title).toBe("renamed");
    expect(nb2.body).toBe("first line\nsecond line"); // title-only update leaves the body alone
    expect((await call("notebooks_update", { notebook_id: "N999", title: "x" })).text).toContain("notebook not found: N999");
  });

  it("get resolves [[id]] refs to labels, and names a dangling ref gone", async () => {
    const n = (await call("canvas_add_node", { label: "worker", kind: "service" })).json().ids[0];
    const id = (await call("notebooks_create", { title: "refs", body: `[[${n}]] does the work. [[n_ghost]] is gone.` })).json().notebook_id;
    const got = (await call("notebooks_get", { notebook_id: id })).json();
    expect(got).toEqual({ notebook_id: id, title: "refs", body: `${n} (worker) does the work. n_ghost (gone) is gone.` });
    await call("canvas_delete", { id: n });
    const got2 = (await call("notebooks_get", { notebook_id: id })).json();
    expect(got2.body).toBe(`${n} (gone) does the work. n_ghost (gone) is gone.`);
  });

  it("open sets active_notebook, shared by every read; unknown id fails; null releases", async () => {
    const id = (await call("notebooks_create", { title: "open me" })).json().notebook_id;
    expect((await call("notebooks_open", { notebook_id: id })).json()).toEqual({ ok: true });
    expect((await getState()).active_notebook).toBe(id);
    const bad = await call("notebooks_open", { notebook_id: "N999" });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("notebook not found: N999");
    expect((await call("notebooks_open", { notebook_id: null })).json()).toEqual({ ok: true });
    expect((await getState()).active_notebook).toBeNull();
  });

  it("canvas_delete reports notebooks_affected for a live ref", async () => {
    const n = (await call("canvas_add_node", { label: "queueX", kind: "store" })).json().ids[0];
    const id = (await call("notebooks_create", { title: "ref test", body: `[[${n}]] watch this` })).json().notebook_id;
    const del = (await call("canvas_delete", { id: n })).json();
    expect(del.notebooks_affected).toContainEqual({ notebook_id: id, id: n });
  });

  it("scoped get_state carries notebooks whole, validated against the fixture", async () => {
    await call("notebooks_create", { title: "always present" });
    const a = (await call("canvas_add_node", { label: "sa", kind: "entry", at: [0, 0] })).json().ids[0];
    const layerId = (await call("layers_create", { node_ids: [a], title: "scope-nb" })).json().layer_id;
    await call("layers_focus", { layer_id: layerId });
    const whole = { notebooks: (await call("canvas_get_board")).json().notebooks };
    const scoped = await getState(); // validates against the handoff schema
    expect(scoped.notebooks).toEqual(whole.notebooks);
    await call("layers_focus", { layer_id: null });
    await call("layers_delete", { layer_id: layerId });
  });

  it("delete removes a notebook and releases it if it was open", async () => {
    const id = (await call("notebooks_create", { title: "doomed" })).json().notebook_id;
    await call("notebooks_open", { notebook_id: id });
    expect((await call("notebooks_delete", { notebook_id: id })).json()).toEqual({ ok: true });
    expect((await getState()).active_notebook).toBeNull();
    expect((await call("notebooks_delete", { notebook_id: id })).text).toContain("notebook not found");
  });
});

describe("notes_migrate (WS-only — deletes note nodes, so it goes through session.mutate as one step)", () => {
  it("one paragraph per note in reading order, [[nX]] within 80px, todo conversion, dropped edge, layer/draft cleanup, one undoable step; idempotent once notes are gone", async () => {
    const session = sessions.open(boardId);
    // Far off in a corner of the board no earlier test's nodes occupy, so the
    // 80px nearest-node search can't pick up a stray node from another test.
    const near = (await call("canvas_add_node", { label: "near", kind: "service", at: [9000, 9000], size: [40, 40] })).json().ids[0];
    // noteA sits 60px below `near` (within the 80px rule); noteB is far away and written as a dash todo.
    const noteA = mutations.addNode(session, "human", { label: "check the retry budget", kind: "note", at: [9000, 9060], size: [40, 40] }).ids[0]!;
    const noteB = mutations.addNode(session, "human", { label: "- confirm the rate limiter", kind: "note", at: [9000, 9500], size: [40, 40] }).ids[0]!;
    const noteEdge = (await call("canvas_add_edge", { from: noteA, to: near })).json().ids[0];
    const layerId = (await call("layers_create", { node_ids: [near, noteA], title: "has a note" })).json().layer_id;
    const draftId = (await call("drafts_create", { title: "d", marks: [{ id: noteB, role: "removed" }] })).json().draft_id;
    const existingNotesId = (await getState()).notebooks.find((n: { title: string }) => n.title === "notes")?.id ?? null;
    const histBefore = (await call("history_get")).json().steps.length;

    const result = migrateNotes(session, "human");

    expect(result.migrated).toBe(2);
    if (existingNotesId) expect(result.notebook_id).toBe(existingNotesId);
    expect(result.edges_dropped).toContain(noteEdge);
    expect(result.layers_affected).toContain(layerId);
    expect(result.drafts_affected).toContainEqual({ draft_id: draftId, id: noteB });

    const state = await getState();
    const nodeIds = state.graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).not.toContain(noteA);
    expect(nodeIds).not.toContain(noteB);
    expect(state.graph.edges.map((e: { id: string }) => e.id)).not.toContain(noteEdge);
    expect(state.layers.find((l: { id: string }) => l.id === layerId).nodes).toEqual([near]);
    const draft = (await call("drafts_get", { draft_id: draftId })).json();
    expect(draft.marks.some((m: { id: string }) => m.id === noteB)).toBe(false);

    const nb = state.notebooks.find((n: { id: string }) => n.id === result.notebook_id);
    const lines = nb.body.split("\n");
    expect(lines).toContain(`[[${near}]] check the retry budget`);
    expect(lines).toContain("- [ ] confirm the rate limiter");
    expect(lines.indexOf(`[[${near}]] check the retry budget`)).toBeLessThan(lines.indexOf("- [ ] confirm the rate limiter"));

    const hist = (await call("history_get")).json();
    expect(hist.steps.length).toBe(histBefore + 1);
    expect(hist.steps.at(-1).label).toBe(`notes → ${result.notebook_id} notes`);

    const again = migrateNotes(session, "human");
    expect(again).toEqual({
      notebook_id: result.notebook_id,
      migrated: 0,
      layers_affected: [],
      paths_affected: [],
      drafts_affected: [],
      edges_dropped: [],
    });
    expect((await call("history_get")).json().steps.length).toBe(histBefore + 1); // no new step
  });

  it("a rerun after ⌘Z (which restores the note node but not the notebook) does not duplicate the paragraph", async () => {
    const session = sessions.open(boardId);
    const near = (await call("canvas_add_node", { label: "near3", kind: "service", at: [9000, 30000], size: [40, 40] })).json().ids[0];
    const note = mutations.addNode(session, "human", { label: "check the timeout", kind: "note", at: [9000, 30060], size: [40, 40] }).ids[0]!;
    const line = `[[${near}]] check the timeout`;

    const first = migrateNotes(session, "human");
    expect(first.migrated).toBe(1);
    const nbId = first.notebook_id!;
    const bodyAfterFirst = (await getState()).notebooks.find((n: { id: string }) => n.id === nbId).body;
    expect(bodyAfterFirst.split("\n").filter((l: string) => l === line)).toHaveLength(1);
    expect((await getState()).graph.nodes.map((n: { id: string }) => n.id)).not.toContain(note);

    // ⌘Z (session.historyOp, WS-only — the tool contract has no undo call):
    // the delete step reverts, so the note node is back. The append is not
    // history (CLAUDE.md) and is untouched by this.
    session.historyOp("undo", undefined, "all");
    const afterUndo = await getState();
    expect(afterUndo.graph.nodes.map((n: { id: string }) => n.id)).toContain(note);
    expect(afterUndo.notebooks.find((n: { id: string }) => n.id === nbId).body).toBe(bodyAfterFirst);

    const second = migrateNotes(session, "human");
    expect(second.migrated).toBe(1); // the (restored) note node really is deleted again
    const afterSecond = await getState();
    expect(afterSecond.graph.nodes.map((n: { id: string }) => n.id)).not.toContain(note);
    const bodyAfterSecond = afterSecond.notebooks.find((n: { id: string }) => n.id === nbId).body;
    expect(bodyAfterSecond.split("\n").filter((l: string) => l === line)).toHaveLength(1); // not duplicated
  });
});

describe("project root (ADR 0003)", () => {
  const RULE = "project_root must be an existing absolute directory";
  const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
  const ids = (list: { id: string }[]) => list.map((b) => b.id);
  /** A store row with root '' — only a migrated row holds it. */
  const unsetBoard = (name: string) => {
    const id = `b_u${Math.random().toString(16).slice(2, 7)}`;
    store.create(id, name, { project_root: "" }, Date.now());
    return id;
  };
  /** Nodes a→b, a layer over them, and the edge id. */
  const seed = async (board_id: string) => {
    const a = (await call("canvas_add_node", { board_id, label: "a", kind: "entry" })).json().ids[0];
    const b = (await call("canvas_add_node", { board_id, label: "b", kind: "service" })).json().ids[0];
    const e = (await call("canvas_add_edge", { board_id, from: a, to: b })).json().ids[0];
    const layer = (await call("layers_create", { board_id, node_ids: [a, b], title: "l" })).json().layer_id;
    return { a, b, e, layer };
  };

  afterAll(async () => {
    cwdNow = projectRoot;
    await call("boards_open", { board_id: boardId });
    sessions.persistAll(); // flush pending debounce timers before the store closes
  });

  it("boards_create rejects no root, '', a relative path, a file and a missing dir", async () => {
    const file = path.join(projectRoot, "auth.ts");
    for (const args of [{}, { project_root: "" }, { project_root: "rel/dir" }, { project_root: file }, { project_root: path.join(projectRoot, "missing") }]) {
      const out = await call("boards_create", { name: "bad root", ...args });
      expect(out.res.isError).toBe(true);
      expect(out.text).toContain(RULE);
    }
    await call("boards_open", { board_id: boardId });
  });

  it("state.board.project_root is the board's root", async () => {
    const state = await getState();
    expect(state.board.project_root).toBe(projectRoot);
  });

  it("an unset root: ref operations fail and name boards_update; everything else works", async () => {
    const id = unsetBoard("unset board");
    await call("boards_open", { board_id: id });
    const { a, e, layer } = await seed(id);
    const fails = async (name: string, args: Record<string, unknown>) => {
      const out = await call(name, args);
      expect(out.res.isError, name).toBe(true);
      expect(out.text).toContain(`board ${id} has no project root — set one with boards_update(board_id, project_root)`);
    };
    await fails("canvas_bind_code", { node_id: a, ref: "auth.ts:verifyToken" });
    await fails("canvas_lint", {});
    await fails("paths_create", { layer_id: layer, title: "p", steps: [{ edge: e, ref: "auth.ts" }] });
    expect((await call("canvas_bind_code", { node_id: a, endpoint: "GET /a" })).json().ok).toBe(true);
    const refless = (await call("paths_create", { layer_id: layer, title: "p", steps: [{ edge: e, caption: "c" }] })).json();
    expect(refless.path_id).toBeTruthy();
    await fails("paths_update", { path_id: refless.path_id, verify: [1] });
    const got = (await call("paths_get", { path_id: refless.path_id })).json();
    expect(got.hops[0].ref_status).toBeNull();
    expect(got.warnings).toEqual([`board ${id} has no project root — set one with boards_update(board_id, project_root)`]);
    expect((await call("paths_play", { path_id: refless.path_id })).json().warnings[0]).toContain("boards_update");
  });

  it("a removed root outside git (main_root '') fails the same way and lists as unset", async () => {
    const root = tmp("inkwire-gone-");
    writeFileSync(path.join(root, "auth.ts"), "export function verifyToken() {}\n");
    const id = (await call("boards_create", { name: "gone root", project_root: root })).json().board_id;
    expect(store.load(id)!.meta.main_root).toBe("");
    const { a, e, layer } = await seed(id);
    const pathId = (await call("paths_create", { layer_id: layer, title: "p", steps: [{ edge: e, ref: "auth.ts:verifyToken" }] })).json().path_id;
    rmSync(root, { recursive: true, force: true });
    const gone = `project root ${root} of board ${id} no longer exists — set a new one with boards_update(board_id, project_root)`;
    for (const [name, args] of [
      ["canvas_bind_code", { node_id: a, ref: "auth.ts" }],
      ["canvas_lint", {}],
      ["paths_create", { layer_id: layer, title: "q", steps: [{ edge: e, ref: "auth.ts" }] }],
      ["paths_update", { path_id: pathId, verify: [1] }],
    ] as const) {
      const out = await call(name, args);
      expect(out.res.isError, name).toBe(true);
      expect(out.text).toContain(gone);
    }
    const got = (await call("paths_get", { path_id: pathId })).json();
    expect(got.hops[0].ref_status).toBeNull();
    expect(got.warnings).toEqual([gone]);
    const listed = (await call("boards_list", { all: true })).json().boards.find((b: { id: string }) => b.id === id);
    expect(listed).toMatchObject({ project_root: root, main_root: "", root: "unset" });
  });

  it("two boards with different roots resolve one relative ref to two files", async () => {
    const [r1, r2] = [tmp("inkwire-r1-"), tmp("inkwire-r2-")];
    for (const r of [r1, r2]) writeFileSync(path.join(r, "same.ts"), "export function same() {}\n");
    const resolved: string[] = [];
    for (const r of [r1, r2]) {
      const id = (await call("boards_create", { name: `two roots ${path.basename(r)}`, project_root: r })).json().board_id;
      const n = (await call("canvas_add_node", { board_id: id, label: "s", kind: "service" })).json().ids[0];
      const out = (await call("canvas_bind_code", { board_id: id, node_id: n, ref: "same.ts:same" })).json();
      expect(out.project_root).toBe(r);
      resolved.push(out.resolved_path);
    }
    expect(resolved).toEqual([path.join(r1, "same.ts"), path.join(r2, "same.ts")]);
  });

  it("boards_create naming: a name that exists gets the lowest free (N), under any root", async () => {
    const other = tmp("inkwire-name-");
    const create = async (project_root = projectRoot) => (await call("boards_create", { name: "dup create", project_root })).json();
    const first = await create();
    expect(first).toMatchObject({ name: "dup create", name_check: "OK" });
    expect(first).not.toHaveProperty("warning");
    const second = await create(other); // another root still collides
    expect(second.name).toBe("dup create (2)");
    expect(second.warning).toBe("a board named dup create exists; this board is named dup create (2)");
    expect(second).not.toHaveProperty("name_check");
    expect((await create()).name).toBe("dup create (3)");
    await call("boards_delete", { board_id: second.board_id });
    expect((await create()).name).toBe("dup create (2)");
  });

  it("boards_import naming, root and a path relative to the cwd", async () => {
    const src = sessions.create("dup import", projectRoot);
    const dir = tmp("inkwire-import-");
    writeFileSync(path.join(dir, "b.inkwire.json"), JSON.stringify(exportBoard(src, store, Date.now())));
    const other = tmp("inkwire-import-root-");
    cwdNow = dir;
    const imp = async (args: Record<string, unknown> = {}) => (await call("boards_import", { path: "b.inkwire.json", ...args })).json();
    const first = await imp({ project_root: other });
    expect(first).toMatchObject({ name: "dup import (2)", project_root: other });
    expect(first.warning).toBe("a board named dup import exists; this board is named dup import (2)");
    expect(store.load(first.board_id)!.meta.project_root).toBe(other);
    const second = await imp(); // the file's root exists here
    expect(second).toMatchObject({ name: "dup import (3)", project_root: projectRoot });
    await call("boards_delete", { board_id: first.board_id });
    expect((await imp()).name).toBe("dup import (2)");
    sessions.delete(src.boardId);
    expect(await imp()).toMatchObject({ name: "dup import", name_check: "OK" });
    cwdNow = projectRoot;
  });

  it("boards_clone naming: default · basename, copy for the same root, then the lowest free (N)", async () => {
    const src = (await call("boards_create", { name: "clone name", project_root: projectRoot })).json().board_id;
    const elsewhere = path.join(tmp("inkwire-clone-"), "wt-feature");
    mkdirSync(elsewhere);
    const clone = async (args: Record<string, unknown> = {}) => (await call("boards_clone", { board_id: src, ...args })).json();
    expect(await clone({ project_root: elsewhere })).toMatchObject({ name: "clone name · wt-feature", name_check: "OK", project_root: elsewhere });
    expect(await clone()).toMatchObject({ name: "clone name copy", name_check: "OK", project_root: projectRoot });
    const two = await clone();
    expect(two.name).toBe("clone name copy (2)");
    expect(two.warning).toBe("a board named clone name copy exists; this board is named clone name copy (2)");
    expect((await clone()).name).toBe("clone name copy (3)");
    await call("boards_delete", { board_id: two.board_id });
    expect((await clone()).name).toBe("clone name copy (2)");
    expect(await clone({ name: "clone given" })).toMatchObject({ name: "clone given", name_check: "OK" });
    expect((await clone({ name: "clone given" })).name).toBe("clone given (2)");
  });

  it("boards_clone copies content, layers with ref_hash, drafts and notebooks, at step 0", async () => {
    const src = (await call("boards_create", { name: "clone content", project_root: projectRoot })).json().board_id;
    const { a, e, layer } = await seed(src);
    await call("paths_create", { layer_id: layer, title: "p", steps: [{ edge: e, ref: "auth.ts:verifyToken" }] });
    await call("drafts_create", { title: "d", note: "n", marks: [{ id: a, role: "changed" }] });
    await call("notebooks_create", { title: "nb", body: `[[${a}]] hi` });
    // An edit just before the clone (inside the persist debounce) is in it.
    await call("canvas_add_node", { label: "late edit", kind: "service" });
    const out = (await call("boards_clone", { board_id: src })).json();
    expect(out.board_id).not.toBe(src);
    // The clone is current.
    expect((await call("canvas_get_board")).json().board.id).toBe(out.board_id);
    const [s0, s1] = [sessions.open(src), sessions.open(out.board_id)];
    expect(s1.collections()).toEqual(s0.collections());
    expect(s1.collections().nodes.map((n) => n.label)).toContain("late edit");
    expect(s1.layers).toEqual(s0.layers);
    expect(s1.layers[0]!.paths[0]!.steps[0]!.ref_hash).toBeTruthy();
    expect(s1.drafts).toEqual(s0.drafts);
    expect(s1.notebooks).toEqual(s0.notebooks);
    expect((await call("history_get")).json().head).toBe(0);
    expect(store.load(out.board_id)!.collections).toEqual(s0.collections()); // persisted now
    // A change to the clone does not change the source.
    await call("canvas_add_node", { label: "only in clone", kind: "service" });
    expect(s0.collections().nodes.map((n) => n.label)).not.toContain("only in clone");
    expect(s1.layers).not.toBe(s0.layers);
    // An explicit root wins.
    const other = tmp("inkwire-clone-root-");
    expect((await call("boards_clone", { board_id: src, project_root: other })).json().project_root).toBe(other);
    // An unset-root source needs project_root, and the error names it.
    const unset = unsetBoard("clone unset");
    const fail = await call("boards_clone", { board_id: unset });
    expect(fail.res.isError).toBe(true);
    expect(fail.text).toContain(`${RULE}: `);
    expect(fail.text).toContain("project_root");
    expect((await call("boards_clone", { board_id: unset, project_root: other })).json().project_root).toBe(other);
  });

  it("boards_list: overlap with the cwd, plus unset boards; all: true lists every board", async () => {
    const parent = realpathSync(tmp("inkwire-list-"));
    const [ra, rb] = [path.join(parent, "a"), path.join(parent, "b")];
    mkdirSync(ra);
    mkdirSync(rb);
    const A = (await call("boards_create", { name: "list A", project_root: ra })).json().board_id;
    const B = (await call("boards_create", { name: "list B", project_root: rb })).json().board_id;
    const U = unsetBoard("list U");
    const mine = new Set([A, B, U]);
    const list = async (cwd: string, all?: boolean) => {
      cwdNow = cwd;
      const boards = (await call("boards_list", all === undefined ? {} : { all })).json().boards;
      return ids(boards).filter((id) => mine.has(id)).sort();
    };
    expect(await list(ra)).toEqual([A, U].sort());
    expect(await list(path.join(ra, "src"))).toEqual([A, U].sort());
    expect(await list(parent)).toEqual([A, B, U].sort());
    expect(await list("/somewhere/else", true)).toEqual([A, B, U].sort());
    const entry = (await call("boards_list", { all: true })).json().boards.find((b: { id: string }) => b.id === A);
    expect(entry).toMatchObject({ project_root: ra, main_root: "" });
    expect(entry).not.toHaveProperty("root");
    cwdNow = projectRoot;
  });

  it("main_root: a gone worktree falls back to the main checkout for reads; writes and lint refuse", async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const main = realpathSync(tmp("inkwire-main-"));
    git(main, "init", "-q");
    writeFileSync(path.join(main, "a.ts"), "export function a() {\n  return 1;\n}\n");
    git(main, "add", ".");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const wtParent = realpathSync(tmp("inkwire-wt-"));
    const wt = path.join(wtParent, "feature");
    git(main, "worktree", "add", "-q", wt);
    const id = (await call("boards_create", { name: "worktree board", project_root: wt })).json().board_id;
    expect(store.load(id)!.meta).toMatchObject({ project_root: wt, main_root: main });
    const { a, e, layer } = await seed(id);
    const pathId = (await call("paths_create", { layer_id: layer, title: "p", steps: [{ edge: e, caption: "c", ref: "a.ts:a" }] })).json().path_id;

    git(main, "worktree", "remove", "--force", wt);
    const warning = `resolved against main checkout ${main}; set the root with boards_update to make this permanent`;
    const got = (await call("paths_get", { path_id: pathId })).json();
    expect(got.hops[0].ref_status).toBe("ok");
    expect(got.warnings).toEqual([warning]);
    expect((await call("paths_play", { path_id: pathId })).json().warnings).toEqual([warning]);
    const board = await call("canvas_get_board");
    expect(board.json().board.project_root).toBe(wt);
    expect(board.res.content[1]?.text).toBe(`warning: ${warning}`);
    const listed = (await call("boards_list", { all: true })).json().boards.find((b: { id: string }) => b.id === id);
    expect(listed).toMatchObject({ project_root: wt, main_root: main, root: "unset" });
    for (const [name, args] of [
      ["canvas_bind_code", { node_id: a, ref: "a.ts:a" }],
      ["paths_create", { layer_id: layer, title: "q", steps: [{ edge: e, ref: "a.ts:a" }] }],
      ["paths_update", { path_id: pathId, steps: [{ edge: e, caption: "changed", ref: "a.ts:a" }] }],
      ["paths_update", { path_id: pathId, verify: [1] }],
      ["canvas_lint", {}],
    ] as const) {
      const out = await call(name, args);
      expect(out.res.isError, name).toBe(true);
      expect(out.text).toContain(warning);
    }

    // boards_update(project_root) sets main_root again.
    const wt2 = path.join(wtParent, "feature2");
    git(main, "worktree", "add", "-q", wt2);
    const upd = (await call("boards_update", { board_id: id, project_root: wt2 })).json();
    expect(upd).toMatchObject({ project_root: wt2, main_root: main });
    expect((await call("canvas_lint")).res.isError).toBeFalsy();
    const root2 = (await call("boards_update", { board_id: id, project_root: main })).json();
    expect(root2.main_root).toBe("");
  });

  it("boards_update: rename and re-root; bad roots, no fields and an unknown id fail", async () => {
    const id = unsetBoard("update me");
    await call("boards_open", { board_id: id });
    expect((await call("canvas_lint")).res.isError).toBe(true);
    const renamed = (await call("boards_update", { board_id: id, name: "updated name" })).json();
    expect(renamed.name).toBe("updated name");
    expect((await getState()).board.name).toBe("updated name");
    const listed = (await call("boards_list", { all: true })).json().boards.find((b: { id: string }) => b.id === id);
    expect(listed.name).toBe("updated name");
    await call("boards_update", { board_id: id, project_root: projectRoot });
    expect((await getState()).board.project_root).toBe(projectRoot);
    expect((await call("canvas_lint")).res.isError).toBeFalsy();
    for (const bad of ["", "rel", path.join(projectRoot, "auth.ts"), path.join(projectRoot, "nope")]) {
      const out = await call("boards_update", { board_id: id, project_root: bad });
      expect(out.res.isError).toBe(true);
      expect(out.text).toContain(RULE);
    }
    const none = await call("boards_update", { board_id: id });
    expect(none.res.isError).toBe(true);
    expect(none.text).toContain("give name or project_root");
    const unknown = await call("boards_update", { board_id: "b_nope", name: "x" });
    expect(unknown.res.isError).toBe(true);
    expect(unknown.text).toContain("board not found: b_nope");
  });

  it("boards_open keeps the in-memory history and revisions; its description does not say resets", async () => {
    await call("boards_open", { board_id: boardId });
    await call("canvas_add_node", { label: "open twice", kind: "service" });
    const before = (await call("boards_open", { board_id: boardId })).json().state;
    const after = (await call("boards_open", { board_id: boardId })).json().state;
    expect(before.history.steps).toBeGreaterThan(0);
    expect(after.history.steps).toBe(before.history.steps);
    expect(after.graph.revision).toBe(before.graph.revision);
    const tool = (await client.listTools()).tools.find((t) => t.name === "boards_open")!;
    expect(tool.description).not.toContain("resets");
  });
});
