// ADR 0002 (M3): one AI Author per board. Two MCP servers over one Sessions +
// Clients (pids 101 and 202): the write gate, claims, release and the Thread.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWN_RULE_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../../src/server/mcp.js";
import { exportBoard } from "../../src/server/board-file.js";
import { sessionMode, sessionReply } from "../../src/server/session-mode.js";
import { Harness } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = new Harness();
  await h.connect(101);
  await h.connect(202);
});

afterEach(async () => {
  for (const c of h.clients.all()) if (c.mode === "inkwire") sessionMode(h.clients, c, false, { focusTerminal: () => {} });
  await h.close();
});

/** A board with no Author (made the way the panel makes one). */
const unclaimed = (name = "unclaimed") => h.sessions.create(name, h.root).boardId;

interface Seed {
  n1: string;
  n2: string;
  n3: string;
  e1: string;
  layer: string;
  path: string;
  draft: string;
  notebook: string;
}

/** 101 creates and seeds a board: nodes, an edge, a layer with a path, a draft and a notebook. */
async function seeded(name: string): Promise<{ board: string; ids: Seed }> {
  const board = await h.newBoard(101, name);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await h.call(101, tool, { board_id: board, ...args });
    if (r.res.isError) throw new Error(`${tool}: ${r.text}`);
    return r.json();
  };
  const n1 = (await call("canvas_add_node", { label: "n1", kind: "entry", at: [0, 0] })).ids[0];
  const n2 = (await call("canvas_add_node", { label: "n2", kind: "service", at: [200, 0] })).ids[0];
  const n3 = (await call("canvas_add_node", { label: "n3", kind: "store", at: [400, 0] })).ids[0];
  const e1 = (await call("canvas_add_edge", { from: n1, to: n2 })).ids[0];
  const layer = (await call("layers_create", { node_ids: [n1, n2], title: "l" })).layer_id;
  const path = (await call("paths_create", { layer_id: layer, title: "p", nodes: [n1, n2] })).path_id;
  const draft = (await call("drafts_create", { title: "d", marks: [{ id: n1, role: "changed" }] })).draft_id;
  const notebook = (await call("notebooks_create", { title: "nb", body: "x" })).notebook_id;
  return { board, ids: { n1, n2, n3, e1, layer, path, draft, notebook } };
}

/** Valid arguments for every write tool on a seeded board. */
const WRITE_ARGS: Record<(typeof WRITE_TOOLS)[number], (s: Seed) => Record<string, unknown>> = {
  canvas_infer_structure: () => ({}),
  canvas_add_node: () => ({ label: "z", kind: "service" }),
  canvas_update_node: (s) => ({ node_id: s.n1, label: "n1b" }),
  canvas_add_edge: (s) => ({ from: s.n2, to: s.n3 }),
  canvas_update_edge: (s) => ({ edge_id: s.e1, label: "calls" }),
  canvas_delete: (s) => ({ id: s.n3 }),
  canvas_move: (s) => ({ id: s.n1, at: [5, 5] }),
  canvas_bind_code: (s) => ({ node_id: s.n1, ref: "auth.ts:verifyToken" }),
  canvas_annotate: (s) => ({ target_id: s.n1, text: "a missing case" }),
  canvas_set_viewport: () => ({ x: 10, y: 20, zoom: 1.5 }),
  layers_create: (s) => ({ node_ids: [s.n3], title: "l2" }),
  layers_update: (s) => ({ layer_id: s.layer, title: "l3" }),
  layers_focus: (s) => ({ layer_id: s.layer }),
  layers_delete: (s) => ({ layer_id: s.layer }),
  paths_create: (s) => ({ layer_id: s.layer, title: "p2", nodes: [s.n1, s.n2] }),
  paths_update: (s) => ({ path_id: s.path, title: "p3" }),
  paths_delete: (s) => ({ path_id: s.path }),
  paths_play: (s) => ({ path_id: s.path }),
  drafts_create: (s) => ({ title: "d2", marks: [{ id: s.n2, role: "removed" }] }),
  drafts_update: (s) => ({ draft_id: s.draft, title: "d3" }),
  drafts_delete: (s) => ({ draft_id: s.draft }),
  drafts_activate: (s) => ({ draft_id: s.draft }),
  notebooks_create: () => ({ title: "nb2", body: "y" }),
  notebooks_update: (s) => ({ notebook_id: s.notebook, append: "more" }),
  notebooks_delete: (s) => ({ notebook_id: s.notebook }),
  notebooks_open: (s) => ({ notebook_id: s.notebook }),
  boards_update: () => ({ name: "renamed" }),
  boards_delete: () => ({}),
};

/** Everything a reader could change on a board: content, views (highlight and trace too), meta, log, Thread. */
function snapshot(board: string): string {
  const s = h.sessions.open(board);
  return JSON.stringify({
    state: s.state({ includeLayout: true, includeInkGeometry: true }),
    viewport: s.viewport,
    meta: s.meta,
    thread: s.thread,
    highlight: s.highlight,
    trace: s.trace,
    log: s.log.map((l) => l.text),
    closed: s.closed,
    stored: h.store.load(board) !== null,
  });
}

describe("the write gate", () => {
  it("WRITE_TOOLS ∪ READ_TOOLS ∪ own-rule tools is every listed tool, with no tool in two sets", async () => {
    const all = [...WRITE_TOOLS, ...READ_TOOLS, ...OWN_RULE_TOOLS];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(await h.listTools(101)));
    expect(WRITE_TOOLS).toHaveLength(28);
  });

  for (const tool of WRITE_TOOLS) {
    it(`${tool}: reader 202 fails naming the Author and the board does not change; Author 101 succeeds`, async () => {
      const { board, ids } = await seeded(`gate ${tool}`);
      const args = { board_id: board, ...WRITE_ARGS[tool](ids) };
      const before = snapshot(board);
      const refused = await h.call(202, tool, args);
      expect(refused.res.isError).toBe(true);
      expect(refused.text).toContain("pid 101");
      expect(refused.text).toContain("release it in the panel");
      expect(snapshot(board)).toBe(before);
      expect(h.clients.authorOf(board)).toBe(101);
      expect(h.clients.get(202)!.currentBoardId).toBeNull();

      const ok = await h.call(101, tool, args);
      expect(ok.res.isError, ok.text).toBeFalsy();
    });
  }
});

describe("claims", () => {
  it("the first write claims an unclaimed board and makes it current", async () => {
    const u = unclaimed();
    expect(h.clients.authorOf(u)).toBeNull();
    await h.call(101, "canvas_add_node", { board_id: u, label: "x", kind: "service" });
    expect(h.clients.authorOf(u)).toBe(101);
    expect(h.clients.get(101)!.currentBoardId).toBe(u);
  });

  it("a write to unclaimed B by the Author of A moves authorship to B", async () => {
    const a = await h.newBoard(101, "A");
    const b = unclaimed("B");
    const r = await h.call(101, "canvas_add_node", { board_id: b, label: "x", kind: "service" });
    expect(r.res.isError).toBeFalsy();
    expect(h.clients.authorOf(b)).toBe(101);
    expect(h.clients.authorOf(a)).toBeNull();
  });

  it("a write to B that another Client authors fails, and A stays claimed", async () => {
    const a = await h.newBoard(101, "A");
    const b = await h.newBoard(202, "B");
    const r = await h.call(101, "canvas_add_node", { board_id: b, label: "x", kind: "service" });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("pid 202");
    expect(h.clients.authorOf(a)).toBe(101);
    expect(h.clients.authorOf(b)).toBe(202);
    expect(h.clients.get(101)!.currentBoardId).toBe(a);
  });

  it("a failed canvas_add_edge on unclaimed B does not claim B or release A", async () => {
    const a = await h.newBoard(101, "A");
    const b = unclaimed("B");
    const r = await h.call(101, "canvas_add_edge", { board_id: b, from: "ghost", to: "ghost2" });
    expect(r.res.isError).toBe(true);
    expect(h.clients.authorOf(b)).toBeNull();
    expect(h.clients.authorOf(a)).toBe(101);
    expect(h.clients.get(101)!.currentBoardId).toBe(a);
  });

  it("a write with board_id B while the current board is A: the call row is on B, and B is current", async () => {
    const a = await h.newBoard(101, "A");
    const b = unclaimed("B");
    const rowsOnA = h.callRows(a).length;
    await h.call(101, "canvas_add_node", { board_id: b, label: "on b", kind: "service" });
    expect(h.callRows(b).at(-1)).toMatchObject({ name: "canvas_add_node" });
    expect(h.callRows(b).at(-1)!.text).toMatch(/add_node/);
    expect(h.callRows(a).some((r) => r.name === "canvas_add_node")).toBe(false);
    // A gets only the switch row.
    expect(h.callRows(a).slice(rowsOnA)).toEqual([{ name: "author", text: `claude moved to ${b}` }]);
    expect(h.clients.get(101)!.currentBoardId).toBe(b);
  });

  it("two Clients write one unclaimed board in parallel: exactly one becomes the Author", async () => {
    const u = unclaimed();
    const [r1, r2] = await Promise.all([
      h.call(101, "canvas_add_node", { board_id: u, label: "from 101", kind: "service" }),
      h.call(202, "canvas_add_node", { board_id: u, label: "from 202", kind: "service" }),
    ]);
    const ok = [r1, r2].filter((r) => !r.res.isError);
    const failed = [r1, r2].filter((r) => r.res.isError);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const author = h.clients.authorOf(u);
    expect(author === 101 || author === 202).toBe(true);
    expect(failed[0]!.text).toContain(`pid ${author}`);
    expect(h.sessions.open(u).collections().nodes).toHaveLength(1);
  });

  it("boards_create, boards_import and boards_clone make the caller the Author; a reader of a board can clone it", async () => {
    const x = await h.newBoard(101, "X");
    expect(h.clients.authorOf(x)).toBe(101);

    const file = path.join(h.root, "x.inkwire.json");
    writeFileSync(file, JSON.stringify(exportBoard(h.sessions.open(x), h.store, Date.now())));
    const imported = (await h.call(101, "boards_import", { path: file })).json().board_id;
    expect(h.clients.authorOf(imported)).toBe(101);
    expect(h.clients.authorOf(x)).toBeNull();

    await h.call(202, "boards_open", { board_id: imported });
    const clone = await h.call(202, "boards_clone", { board_id: imported });
    expect(clone.res.isError, clone.text).toBeFalsy();
    const cloned = clone.json().board_id;
    expect(h.clients.authorOf(cloned)).toBe(202);
    expect(h.clients.authorOf(imported)).toBe(101);
    expect(h.clients.get(202)!.currentBoardId).toBe(cloned);
  });

  it("boards_update by a reader fails and names the Author", async () => {
    const x = await h.newBoard(101, "X");
    const r = await h.call(202, "boards_update", { board_id: x, name: "taken" });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("pid 101");
    expect(h.sessions.open(x).meta.name).toBe("X");
  });
});

describe("boards_delete", () => {
  it("a reader fails; any Client succeeds on a board with no Author", async () => {
    const x = await h.newBoard(101, "X");
    const r = await h.call(202, "boards_delete", { board_id: x });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("pid 101");
    expect(h.store.load(x)).not.toBeNull();

    const u = unclaimed();
    expect((await h.call(202, "boards_delete", { board_id: u })).json()).toEqual({ deleted: true, board_id: u });
    expect(h.clients.authorOf(u)).toBeNull();
    expect(h.store.load(u)).toBeNull();
  });

  it("the Author of A deletes unclaimed B: A stays claimed and its pending session_send is not released", async () => {
    const c101 = h.clients.get(101)!;
    const a = await h.newBoard(101, "A");
    const b = unclaimed("B");
    h.arm(101);
    await h.call(101, "session_mode", { on: true });
    const pending = h.call(101, "session_send", { text: "waiting" });
    await new Promise((r) => setTimeout(r, 10));
    expect(c101.pending?.boardId).toBe(a);

    const del = await h.call(101, "boards_delete", { board_id: b });
    expect(del.res.isError, del.text).toBeFalsy();
    expect(h.clients.authorOf(a)).toBe(101);
    expect(h.clients.authorOf(b)).toBeNull();
    expect(c101.pending?.boardId).toBe(a);
    expect(c101.mode).toBe("inkwire");

    sessionReply(h.clients, h.sessions.open(a), { text: "done", focus: null, selection: null });
    expect((await pending).json()).toMatchObject({ status: "reply", reply: "done" });
  });
});

describe("session tools", () => {
  it("session_send to another Author's board fails, and that board does not change", async () => {
    const x = await seeded("X");
    await h.newBoard(202, "Y");
    h.arm(202);
    await h.call(202, "session_mode", { on: true });
    const before = snapshot(x.board);
    const r = await h.call(202, "session_send", {
      board_id: x.board,
      text: "hi",
      highlight: { nodes: [x.ids.n1], edges: [], label: "h" },
      path: { layer_id: x.ids.layer, path_id: x.ids.path },
      draft: x.ids.draft,
      notebook: x.ids.notebook,
    });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("pid 101");
    expect(snapshot(x.board)).toBe(before);
    expect(h.clients.get(202)!.pending).toBeNull();
  });

  it("a Client in inkwire mode on its own board cannot send to a board that it only opened", async () => {
    const y = await h.newBoard(202, "Y");
    const z = (await seeded("Z")).board;
    await h.call(101, "boards_release");
    h.arm(202);
    await h.call(202, "session_mode", { on: true });
    await h.call(202, "boards_open", { board_id: z });
    expect(h.clients.get(202)!.currentBoardId).toBe(y);
    const before = snapshot(z);
    const r = await h.call(202, "session_send", { board_id: z, text: "hi" });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain(`session_send must go to the board you talk on (${y})`);
    expect(snapshot(z)).toBe(before);
    expect(h.clients.authorOf(z)).toBeNull();
  });

  it("a reader's session_mode(off) and a refused session_mode(on) add no Thread row", async () => {
    const x = await h.newBoard(101, "X");
    await h.call(202, "boards_open", { board_id: x });
    const before = h.sessions.open(x).thread.length;
    expect((await h.call(202, "session_mode", { on: false })).json().mode).toBe("pty");
    h.arm(202);
    const refused = await h.call(202, "session_mode", { on: true });
    expect(refused.res.isError).toBe(true);
    expect(refused.text).toContain("pid 101");
    expect(h.sessions.open(x).thread).toHaveLength(before);
  });
});

describe("the Thread and reads", () => {
  it("a reader's canvas_get_state adds no row to the Thread; the Author's calls still add rows", async () => {
    const x = await h.newBoard(101, "X");
    await h.call(202, "boards_open", { board_id: x });
    const before = h.sessions.open(x).thread.length;
    expect((await h.call(202, "canvas_get_state")).res.isError).toBeFalsy();
    expect(h.sessions.open(x).thread).toHaveLength(before);
    await h.call(101, "canvas_get_state");
    expect(h.callRows(x).at(-1)).toMatchObject({ name: "canvas_get_state" });
  });

  it("boards_open by 202 does not claim, and history.head does not change when it opens again", async () => {
    const x = await h.newBoard(101, "X");
    await h.call(101, "canvas_add_node", { label: "a", kind: "service" });
    await h.call(101, "boards_release");
    const head = h.sessions.open(x).history.head;
    const first = (await h.call(202, "boards_open", { board_id: x })).json();
    const again = (await h.call(202, "boards_open", { board_id: x })).json();
    expect(h.clients.authorOf(x)).toBeNull();
    expect(h.sessions.open(x).history.head).toBe(head);
    expect(again.state.history.steps).toBe(first.state.history.steps);
    expect(h.clients.get(202)!.currentBoardId).toBe(x);
  });
});

describe("release", () => {
  it("boards_release frees the board and another Client can then claim it; a reader's boards_release fails", async () => {
    const x = await h.newBoard(101, "X");
    const refused = await h.call(202, "boards_release", { board_id: x });
    expect(refused.res.isError).toBe(true);
    expect(refused.text).toContain(`you are not the author of ${x}`);
    expect((await h.call(202, "boards_release")).text).toContain("you are not the author of a board");
    expect(h.clients.authorOf(x)).toBe(101);

    expect((await h.call(101, "boards_release")).json()).toEqual({ released: x });
    expect(h.clients.authorOf(x)).toBeNull();
    expect(h.clients.get(101)!.currentBoardId).toBe(x);
    const r = await h.call(202, "canvas_add_node", { board_id: x, label: "b", kind: "service" });
    expect(r.res.isError, r.text).toBeFalsy();
    expect(h.clients.authorOf(x)).toBe(202);
  });

  it("boards_release while talking turns the mode off and returns the pending send as mode_off", async () => {
    const c101 = h.clients.get(101)!;
    const x = await h.newBoard(101, "X");
    h.arm(101);
    await h.call(101, "session_mode", { on: true });
    const pending = h.call(101, "session_send", { text: "waiting" });
    await new Promise((r) => setTimeout(r, 10));
    await h.call(101, "boards_release");
    expect((await pending).json()).toMatchObject({ status: "mode_off" });
    expect(c101.mode).toBe("pty");
    expect(h.clients.authorOf(x)).toBeNull();
  });

  it("after the person releases a board, every write by the old Author fails until allowAgain; then its next write claims", async () => {
    const { board, ids } = await seeded("released");
    h.clients.release(board, "person");
    expect(h.clients.releasedFrom.get(board)).toBe(101);
    const before = snapshot(board);
    for (const tool of WRITE_TOOLS) {
      const r = await h.call(101, tool, { board_id: board, ...WRITE_ARGS[tool](ids) });
      expect(r.res.isError, tool).toBe(true);
      expect(r.text, tool).toContain(`you are no longer the author of ${board}; the person released it. Ask the person to allow you again in the panel`);
    }
    h.arm(101);
    const on = await h.call(101, "session_mode", { on: true });
    expect(on.res.isError).toBe(true);
    expect(on.text).toContain("no longer the author");
    expect(snapshot(board)).toBe(before);
    expect(h.clients.authorOf(board)).toBeNull();

    expect(h.clients.allowAgain(board, 101)).toBe(true);
    expect(h.clients.releasedFrom.has(board)).toBe(false);
    const r = await h.call(101, "canvas_add_node", { board_id: board, label: "back", kind: "service" });
    expect(r.res.isError, r.text).toBeFalsy();
    expect(h.clients.authorOf(board)).toBe(101);
  });

  it("releasedFrom clears when another Client claims the board", async () => {
    const x = await h.newBoard(101, "X");
    h.clients.release(x, "person");
    await h.call(202, "canvas_add_node", { board_id: x, label: "mine", kind: "service" });
    expect(h.clients.authorOf(x)).toBe(202);
    expect(h.clients.releasedFrom.has(x)).toBe(false);
    await h.call(202, "boards_release");
    const r = await h.call(101, "canvas_add_node", { board_id: x, label: "again", kind: "service" });
    expect(r.res.isError, r.text).toBeFalsy();
    expect(h.clients.authorOf(x)).toBe(101);
  });

  it("releasedFrom clears when the old Author disconnects", async () => {
    const x = await h.newBoard(101, "X");
    h.clients.release(x, "person");
    expect(h.clients.releasedFrom.get(x)).toBe(101);
    h.clients.detach(101, "link-101");
    expect(h.clients.releasedFrom.has(x)).toBe(false);
  });
});

describe("refused writes and the Thread", () => {
  it("the Author of A whose write to B is refused gets no row on A or on B", async () => {
    const a = await h.newBoard(101, "A");
    const b = await h.newBoard(202, "B");
    const [onA, onB] = [h.sessions.open(a).thread.length, h.sessions.open(b).thread.length];
    const r = await h.call(101, "canvas_add_node", { board_id: b, label: "x", kind: "service" });
    expect(r.res.isError).toBe(true);
    expect(h.sessions.open(a).thread).toHaveLength(onA);
    expect(h.sessions.open(b).thread).toHaveLength(onB);
  });

  it("a refused boards_update of another Author's board, or a write to an unknown board, adds no row to the caller's own board", async () => {
    const y = await h.newBoard(202, "Y");
    const z = await h.newBoard(101, "Z");
    const onZ = h.sessions.open(z).thread.length;
    for (const args of [{ board_id: y, project_root: "/does/not/exist" }, { board_id: y }]) {
      const r = await h.call(101, "boards_update", args);
      expect(r.res.isError).toBe(true);
      expect(r.text).toContain("pid 202");
    }
    const r = await h.call(101, "canvas_add_node", { board_id: "b_0000000000", label: "x", kind: "service" });
    expect(r.res.isError).toBe(true);
    expect(h.sessions.open(z).thread).toHaveLength(onZ);
    expect(h.clients.authorOf(z)).toBe(101);
  });
});
