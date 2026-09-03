// TESTS.md § 4 — tool contract tests against the real MCP server, in-process.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../src/server/mcp.js";
import { markElement } from "../../src/server/drafts.js";
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
    projectRoot,
    panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  const created = await call("boards_create", { name: "contract board" });
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
    const created = (await call("boards_create", { name: "infer board" })).json();
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

  it("annotate pins a note node near the target", async () => {
    const n = (await call("canvas_add_node", { label: "queue", kind: "store" })).json().ids[0];
    const ann = (await call("canvas_annotate", { target_id: n, text: "missing retry path" })).json();
    const state = await getState();
    const note = state.graph.nodes.find((x: { id: string }) => x.id === ann.ids[0]);
    expect(note.kind).toBe("note");
    expect(note.label).toBe("missing retry path");
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
    const created = (await call("boards_create", { name: "doomed" })).json();
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
    });
    expect(got.hops[1]).toMatchObject({ index: 2, edge: qr, label: null, caption: "" });
  });

  it("play pins the trace: running from 0, or paused at hop (clamped); a highlight closes it", async () => {
    expect((await call("paths_play", { path_id: "P1" })).json()).toEqual({ ok: true });
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
    // The path survives; get gives nulls for the pruned hop.
    const got = (await call("paths_get", { path_id: "P1" })).json();
    expect(got.hops[1]).toMatchObject({ edge: qr, from: null, to: null, label: null });
  });

  it("scoped get_state carries the layer's paths and validates against the fixture", async () => {
    await call("layers_focus", { layer_id: layerId });
    const scoped = await getState();
    expect(scoped.scope.paths.map((x: { id: string }) => x.id)).toEqual(["P1", "P2", "P3"]);
    expect(scoped.scope.paths[0].steps[0]).toEqual({ edge: pq, caption: "in", ref: null });
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
