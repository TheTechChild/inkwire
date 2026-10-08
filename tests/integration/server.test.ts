// TESTS.md § 5 — integration against a real HTTP+WS server on an ephemeral
// port, with `ws` as the fake browser panel.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../../src/server/http.js";
import { PanelHub } from "../../src/server/ws.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { Sessions } from "../../src/server/session.js";
import { Clients } from "../../src/server/clients.js";
import { Store } from "../../src/server/store.js";
import * as mutations from "../../src/server/mutations.js";
import type { ServerMessage } from "../../src/shared/protocol.js";

let dataDir: string;
let rootDir: string;
let store: Store;
let sessions: Sessions;
let clients: Clients;
let hub: PanelHub;
let screenshots: Screenshots;
let port: number;
let boardId: string;
const http = { server: null as ReturnType<typeof createHttpServer> | null };

function connect(board: string): Promise<PanelClient> {
  return PanelClient.connect(`ws://127.0.0.1:${port}/ws?board=${board}`);
}

class PanelClient {
  messages: ServerMessage[] = [];
  /** Messages received but not yet handed to a next() caller. The first
   * push can arrive in the same I/O batch as 'open', before any waiter. */
  private unread: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];

  private constructor(public socket: WebSocket) {
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(msg);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.unread.push(msg);
    });
  }

  static connect(url: string): Promise<PanelClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new PanelClient(socket);
      socket.on("open", () => resolve(client));
      socket.on("error", reject);
    });
  }

  next(timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.unread.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  async nextState(timeoutMs = 3000): Promise<Extract<ServerMessage, { type: "state" }>> {
    for (;;) {
      const m = await this.next(timeoutMs);
      if (m.type === "state") return m;
    }
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.on("close", () => resolve());
      this.socket.close();
    });
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "inkwire-int-"));
  rootDir = mkdtempSync(path.join(tmpdir(), "inkwire-int-root-"));
  store = new Store(dataDir);
  sessions = new Sessions(store, { debounceMs: 60 });
  clients = new Clients(sessions);
  http.server = createHttpServer({ store, sessions, clients, screenshots: () => screenshots });
  hub = new PanelHub(http.server, sessions, clients, { focusTerminal: () => {} });
  screenshots = new Screenshots(hub, store.imagesDir);
  await new Promise<void>((r) => http.server!.listen(0, "127.0.0.1", () => r()));
  port = (http.server!.address() as AddressInfo).port;
  const session = sessions.create("integration board", rootDir);
  boardId = session.boardId;
});

afterAll(async () => {
  await new Promise<void>((r) => http.server!.close(() => r()));
  sessions.persistAll(); // flush pending debounce timers before the db goes away
  store.close();
});

describe("integration", () => {
  it("two writers: WS drag + tool-side edge both land with correct authorship", async () => {
    const session = sessions.open(boardId);
    const a = mutations.addNode(session, "ai", { label: "svc a", kind: "service", at: [0, 0] }).ids[0]!;
    const b = mutations.addNode(session, "ai", { label: "svc b", kind: "service", at: [300, 0] }).ids[0]!;

    const client = await connect(boardId);
    await client.nextState(); // initial push

    // Human drags node a over the socket…
    client.send({ type: "move", id: a, at: [40, 60] });
    // …while a tool call adds an edge.
    mutations.addEdge(session, "ai", { from: a, to: b });

    // Wait until the pushed state shows both.
    let state = await client.nextState();
    for (let i = 0; i < 5 && (state.state.graph.edges.length === 0 || state.state.layout.boxes[a]?.[0] !== 40); i++) {
      state = await client.nextState();
    }
    expect(state.state.layout.boxes[a]?.slice(0, 2)).toEqual([40, 60]);
    expect(state.state.graph.edges).toHaveLength(1);

    const rows = session.historyRows();
    const moveRow = rows.find((r) => r.label.startsWith("move"));
    const edgeRow = rows.find((r) => r.label.startsWith("add_edge"));
    expect(moveRow?.author).toBe("human");
    expect(edgeRow?.author).toBe("ai");

    // Pushed state matches get_state.
    const direct = session.state({ includeInkGeometry: true });
    expect(state.state.graph.revision).toBe(direct.graph.revision);
    expect(state.state.graph.edges).toEqual(direct.graph.edges);
    await client.close();
  });

  it("authorship (ADR 0002): a human WS add_node on a board that a Client authors still succeeds", async () => {
    const author = clients.ensure(4242, { cwd: "/work/author" });
    clients.attach(4242, "int-link");
    clients.commitClaim(author, boardId);
    expect(clients.authorOf(boardId)).toBe(4242);
    const panel = await connect(boardId);
    await panel.nextState();
    panel.send({ type: "add_node", label: "human node", kind: "service", at: [600, 600] });
    let state = await panel.nextState();
    for (let i = 0; i < 5 && !state.state.graph.nodes.some((n) => n.label === "human node"); i++) state = await panel.nextState();
    const node = state.state.graph.nodes.find((n) => n.label === "human node");
    expect(node?.author).toBe("human");
    expect(clients.authorOf(boardId)).toBe(4242);
    await panel.close();
    clients.detach(4242, "int-link");
    expect(clients.authorOf(boardId)).toBeNull();
  });

  it("client reconnect: fresh socket receives the server's current board", async () => {
    const session = sessions.open(boardId);
    const first = await connect(boardId);
    await first.nextState();
    first.socket.terminate(); // kill mid-session

    mutations.addNode(session, "human", { label: "added while away", kind: "note", at: [600, 300] });

    const second = await connect(boardId);
    const state = await second.nextState();
    expect(state.state.graph.nodes.map((n) => n.label)).toContain("added while away");
    expect(state.state.graph.nodes).toEqual(session.state().graph.nodes);
    await second.close();
  });

  it("DELETE /api/boards/:id drops the row and closes the board's sockets", async () => {
    const doomed = sessions.create("doomed", rootDir);
    const client = await connect(doomed.boardId);
    await client.nextState();
    const closed = new Promise<number>((r) => client.socket.on("close", (code) => r(code)));

    const res = await fetch(`http://127.0.0.1:${port}/api/boards/${doomed.boardId}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ deleted: true, board_id: doomed.boardId });
    expect(await closed).toBe(4010);
    expect(store.load(doomed.boardId)).toBeNull();
    expect(sessions.all().map((s) => s.boardId)).not.toContain(doomed.boardId);

    const missing = await fetch(`http://127.0.0.1:${port}/api/boards/${doomed.boardId}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  it("bad intents get an error message naming the offender, then a re-sync", async () => {
    const client = await connect(boardId);
    await client.nextState();
    client.send({ type: "delete", id: "ghost-element" });
    const err = await client.next();
    expect(err.type).toBe("error");
    expect((err as { text: string }).text).toContain("ghost-element");
    await client.close();
  });

  it("persistence: mutate → debounce → restart → board intact, history fresh", async () => {
    const session = sessions.open(boardId);
    const nodesBefore = session.collections().nodes.length;
    mutations.addNode(session, "human", { label: "persisted", kind: "service", at: [50, 500] });
    session.updateNotebooks("human", "notebook N1", () => [
      { id: "N1", title: "notes", body: "persisted note", author: "human", updated: session.now() },
    ]);
    await new Promise((r) => setTimeout(r, 150)); // > debounceMs

    const store2 = new Store(dataDir);
    const sessions2 = new Sessions(store2);
    const reopened = sessions2.open(boardId);
    expect(reopened.collections().nodes).toHaveLength(nodesBefore + 1);
    expect(reopened.collections().nodes.map((n) => n.label)).toContain("persisted");
    expect(reopened.notebooks).toEqual(session.notebooks);
    expect(reopened.history.steps).toHaveLength(0);
    expect(reopened.history.head).toBe(0);
    expect(reopened.state().history.steps).toBe(0);
    store2.close();
  });

  it("board file: path steps with no ref_hash import and export", async () => {
    const src = sessions.create("No stamps", rootDir);
    const a = mutations.addNode(src, "human", { label: "a", kind: "entry", at: [0, 0] }).ids[0]!;
    const b = mutations.addNode(src, "human", { label: "b", kind: "service", at: [300, 0] }).ids[0]!;
    const e = mutations.addEdge(src, "human", { from: a, to: b }).ids[0]!;
    src.updateLayers("ai", "layer", () => [
      { id: "L_1", letter: "A", title: "t", note: "", nodes: [a, b], author: "ai", paths: [{ id: "P1", title: "p", steps: [{ edge: e, caption: "c", ref: "x.ts:y" }], author: "ai" }] },
    ]);
    const file = await (await fetch(`http://127.0.0.1:${port}/api/boards/${src.boardId}/export`)).json();
    expect(file.layers[0].paths[0].steps[0]).not.toHaveProperty("ref_hash");
    const imp = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(file),
    });
    expect(imp.status).toBe(200);
    const id = (await imp.json()).board_id;
    expect((await (await fetch(`http://127.0.0.1:${port}/api/boards/${id}/export`)).json()).layers).toEqual(file.layers);
  });

  it("board file: export embeds bitmaps, import creates an equal board", async () => {
    const src = sessions.create("Export me", rootDir);
    const a = mutations.addNode(src, "human", { label: "gateway", kind: "entry", at: [10, 20] }).ids[0]!;
    const b = mutations.addNode(src, "ai", { label: "auth", kind: "service", at: [300, 20], ref: "auth.ts#verify" }).ids[0]!;
    const e = mutations.addEdge(src, "ai", { from: a, to: b, kind: "async", label: "token" }).ids[0]!;
    mutations.addStroke(src, "human", [[0, 0], [5, 5], [10, 0]]);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const imgSrc = store.saveImage(png, "png");
    mutations.addImage(src, "human", { src: imgSrc, natural: [40, 30], at: [500, 500], size: [40, 30] });
    src.updateLayers("ai", "layer A", () => [
      {
        id: "L_1",
        letter: "A",
        title: "auth path",
        note: "",
        nodes: [a, b],
        author: "ai",
        paths: [{ id: "P1", title: "in", steps: [{ edge: e, caption: "token", ref: null }], author: "ai" }],
      },
    ]);
    src.updateDrafts("ai", "draft D1", () => [
      { id: "D1", title: "swap the token flow", note: "why", marks: { [b]: "changed", [e]: "added" }, author: "ai" },
    ]);
    src.updateNotebooks("ai", "notebook N1", () => [
      { id: "N1", title: "notes", body: `[[${b}]] verifies the token`, author: "ai", updated: 1 },
    ]);

    const exp = await fetch(`http://127.0.0.1:${port}/api/boards/${src.boardId}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toBe('attachment; filename="export-me.inkwire.json"');
    const file = await exp.json();
    expect(file.format).toBe("inkwire-board");
    expect(file.version).toBe(5);
    expect(file.project_root).toBe(rootDir);
    expect(file.nodes).toHaveLength(2);
    expect(file.layers[0].paths).toHaveLength(1);
    expect(file.drafts).toEqual(src.drafts);
    expect(file.notebooks).toEqual(src.notebooks);
    expect(file.assets[imgSrc]).toBe(`data:image/png;base64,${png.toString("base64")}`);

    const imp = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(file),
    });
    expect(imp.status).toBe(200);
    const created = await imp.json();
    expect(created.board_id).not.toBe(src.boardId);
    // The source still exists, so the one name rule gives the import " (2)".
    expect(created).toMatchObject({ name: "Export me (2)", nodes: 2, edges: 1, strokes: 1, images: 1, project_root: rootDir });
    expect(created.warning).toBe("a board named Export me exists; this board is named Export me (2)");

    const dst = sessions.open(created.board_id);
    expect(dst.collections()).toEqual(src.collections());
    expect(dst.viewport).toEqual(src.viewport);
    expect(dst.layers).toEqual(src.layers);
    expect(dst.drafts).toEqual(src.drafts);
    expect(dst.notebooks).toEqual(src.notebooks);
    expect(dst.history.steps).toHaveLength(0);
    // Persisted: a cold load from the store sees the same content.
    expect(store.load(created.board_id)!.collections).toEqual(src.collections());

    const bad = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...file, edges: [{ id: "e1", from: "x" }] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("not an inkwire board file");

    const missing = await fetch(`http://127.0.0.1:${port}/api/boards/b_nope/export`);
    expect(missing.status).toBe(404);

    // A version 1 file predates paths: its layers import with paths: [].
    const { paths: _paths, ...v1Layer } = file.layers[0];
    const { project_root: _root, ...noRoot } = file;
    const withRoot = `http://127.0.0.1:${port}/api/boards/import?project_root=${encodeURIComponent(rootDir)}`;
    const v1 = await fetch(withRoot, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...noRoot, version: 1, layers: [v1Layer] }),
    });
    expect(v1.status).toBe(200);
    expect(sessions.open((await v1.json()).board_id).layers[0]!.paths).toEqual([]);

    // A version 2 file predates drafts: it imports with drafts: [].
    const v2 = await fetch(withRoot, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...noRoot, version: 2, drafts: undefined }),
    });
    expect(v2.status).toBe(200);
    expect(sessions.open((await v2.json()).board_id).drafts).toEqual([]);

    // A duplicated draft id is refused — lookups trust ids to be unique, like paths.
    const dupDraft = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...file, drafts: [...file.drafts, file.drafts[0]] }),
    });
    expect(dupDraft.status).toBe(400);
    expect((await dupDraft.json()).error).toContain("duplicate draft id: D1");

    // A version 3 file predates notebooks: it imports with notebooks: [].
    const v3 = await fetch(withRoot, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...noRoot, version: 3, notebooks: undefined }),
    });
    expect(v3.status).toBe(200);
    expect(sessions.open((await v3.json()).board_id).notebooks).toEqual([]);

    // A duplicated notebook id is refused, like drafts and paths.
    const dupNotebook = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...file, notebooks: [...file.notebooks, file.notebooks[0]] }),
    });
    expect(dupNotebook.status).toBe(400);
    expect((await dupNotebook.json()).error).toContain("duplicate notebook id: N1");

    // A path that does not chain, or a duplicated path id, is refused: lookups trust both.
    const walk = file.layers[0].paths[0];
    const broken = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...file, layers: [{ ...file.layers[0], paths: [{ ...walk, steps: [walk.steps[0], walk.steps[0]] }] }] }),
    });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error).toContain(`path ${walk.id} on layer A: hop 2`);
  });

  it("board file v5: the root travels with the file; import asks for one when it cannot use it", async () => {
    const importAt = (body: unknown, root?: string) =>
      fetch(`http://127.0.0.1:${port}/api/boards/import${root === undefined ? "" : `?project_root=${encodeURIComponent(root)}`}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const src = sessions.create("Rooted", rootDir);
    mutations.addNode(src, "human", { label: "a", kind: "entry", at: [0, 0] });
    const file = await (await fetch(`http://127.0.0.1:${port}/api/boards/${src.boardId}/export`)).json();
    expect(file).toMatchObject({ version: 5, project_root: rootDir });

    // An unset board (a migrated row) exports with no root.
    const unset = sessions.create("Unset", "");
    expect(unset.meta.project_root).toBe("");
    const unsetFile = await (await fetch(`http://127.0.0.1:${port}/api/boards/${unset.boardId}/export`)).json();
    expect(unsetFile).not.toHaveProperty("project_root");

    // The file's root exists here: it imports with that root.
    const ok = await importAt(file);
    expect(ok.status).toBe(200);
    expect(sessions.open((await ok.json()).board_id).meta.project_root).toBe(rootDir);

    // The file's root does not exist here: 400, naming it.
    const gone = await importAt({ ...file, project_root: "/no/such/checkout" });
    expect(gone.status).toBe(400);
    expect((await gone.json()).error).toBe("the file names project root /no/such/checkout, which does not exist here — pass project_root");

    // The explicit root wins over the file's root.
    const other = mkdtempSync(path.join(tmpdir(), "inkwire-int-other-"));
    const explicit = await importAt(file, other);
    expect(explicit.status).toBe(200);
    expect(sessions.open((await explicit.json()).board_id).meta.project_root).toBe(other);

    // A bad explicit root fails even when the file's root exists: it never falls through.
    const bad = await importAt(file, "relative/dir");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("project_root must be an existing absolute directory: relative/dir");

    // A v4 file has no root: with no argument it gives 400.
    const { project_root: _r, ...v4 } = file;
    const old = await importAt({ ...v4, version: 4 });
    expect(old.status).toBe(400);
    expect((await old.json()).error).toBe("the file has no project root — pass project_root");

    // The panel's list has every board, each with project_root, and the unset mark.
    const { boards } = await (await fetch(`http://127.0.0.1:${port}/api/boards`)).json();
    for (const b of boards) expect(b).toHaveProperty("project_root");
    expect(boards.find((b: { id: string }) => b.id === unset.boardId)).toMatchObject({ project_root: "", root: "unset" });
    expect(boards.find((b: { id: string }) => b.id === src.boardId)).not.toHaveProperty("root");
    rmSync(other, { recursive: true, force: true });
  });

  it("screenshot with a client attached returns the client's PNG", async () => {
    const client = await connect(boardId);
    await client.nextState();

    const fakePng = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("fake image payload"),
    ]);
    // The panel answers capture requests by POSTing the PNG back.
    client.socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.type === "capture_request") {
        void fetch(`http://127.0.0.1:${port}/api/capture/${msg.capture_id}`, {
          method: "POST",
          body: fakePng,
        });
      }
    });

    const session = sessions.open(boardId);
    const shot = await screenshots.capture(session, undefined, false);
    expect(shot.source).toBe("client");
    expect(shot.png.equals(fakePng)).toBe(true);
    await client.close();
  });

  it("screenshot with no client falls back to the server renderer", async () => {
    // All panel sockets are closed at this point in the suite.
    const session = sessions.open(boardId);
    const shot = await screenshots.capture(session, undefined, true);
    expect(shot.source).toBe("server");
    expect(shot.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it.each([
    { zoom: 1, lod: "full" },
    { zoom: 0.6, lod: "compact" },
    { zoom: 0.35, lod: "dot" },
  ])("renderer parity at zoom $zoom ($lod): geometry is tier-independent, text follows the tier", async ({ zoom, lod }) => {
    const { renderBoardSvg } = await import("../../src/server/render-svg.js");
    const { lodFor } = await import("../../src/core/lod.js");
    expect(lodFor(zoom)).toBe(lod);
    const session = sessions.open(boardId);
    if (!session.collections().nodes.some((n) => n.label.startsWith("zq1 "))) {
      const from = session.collections().nodes[0]!.id;
      const note = mutations.addNode(session, "ai", {
        label: Array.from({ length: 20 }, (_, i) => `zq${i + 1}`).join(" "),
        kind: "note",
        at: [0, 400],
        ref: "notes/lod.md",
      }).ids[0]!;
      mutations.addEdge(session, "ai", { from, to: note, label: "wraps", condition: "lod" });
    }
    const c = session.collections();
    const labeled = c.edges.filter((e) => e.label || e.condition || e.schema);
    expect(labeled.length).toBeGreaterThan(0);
    const refs = c.nodes.filter((n) => n.ref ?? n.endpoint);
    expect(refs.length).toBeGreaterThan(0);

    const svg = renderBoardSvg({ collections: c, viewport: { x: 0, y: 0, zoom } });
    // Geometry: byte-identical across tiers.
    for (const [id, box] of Object.entries(c.layout)) {
      if (c.nodes.some((n) => n.id === id)) {
        expect(svg).toContain(`<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}"`);
      }
    }
    expect(svg.match(/marker-end/g) ?? []).toHaveLength(c.edges.length);
    expect(svg.match(/stroke-linejoin="round"/g) ?? []).toHaveLength(c.strokes.length);
    // Text: same subset as the panel's CSS tiers.
    expect(svg.match(/text-anchor="middle"/g) ?? []).toHaveLength(lod === "dot" ? 0 : labeled.length);
    expect(svg.match(/opacity="0.7"/g) ?? []).toHaveLength(lod === "full" ? refs.length : 0);
    const kinds = c.nodes.filter((n) => n.kind === "note").length;
    expect(svg.match(/>NOTE/g) ?? []).toHaveLength(lod === "dot" ? 0 : kinds);
    expect(svg.includes("· claude")).toBe(lod === "full");
    // Every label >= 12 screen px, every mono string >= 10 screen px.
    for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) expect(Number(m[1]) * zoom).toBeGreaterThanOrEqual(10 - 1e-9);
    // Node labels wrap into tspans at compact/dot like any other kind (Notebooks
    // Phase 4: the note-specific "always wrap, taller box" behaviour is gone —
    // a surviving legacy note node draws with the same plain box as any other
    // kind, so full LOD shows its label on one unwrapped line).
    const noteLines = svg.match(/<tspan[^>]*>zq[^<]*<\/tspan>/g) ?? [];
    expect(noteLines.length).toBeGreaterThanOrEqual(1);
    if (lod === "compact") expect(noteLines.length).toBeLessThanOrEqual(3);
    if (lod === "dot" || lod === "full") expect(noteLines.length).toBe(1);
  });
});

describe("session over WS", () => {
  type StateMsg = Extract<ServerMessage, { type: "state" }>;
  /** Pushes fan out on every notify, so drain until one satisfies the predicate. */
  const until = async (c: PanelClient, pred: (s: StateMsg) => boolean): Promise<StateMsg> => {
    for (let i = 0; i < 60; i++) {
      const s = await c.nextState();
      if (pred(s)) return s;
    }
    throw new Error("no matching state push");
  };

  it("a composer reply resolves the blocked send, the highlight reaches every panel, → layer creates a human layer", async () => {
    const { hookEvent, sessionSend } = await import("../../src/server/session-mode.js");
    const session = sessions.open(boardId);
    const n = mutations.addNode(session, "ai", { label: "hot path", kind: "service", at: [0, 0] }).ids[0]!;
    const me = clients.ensure(101);
    clients.attach(101, "test");
    hookEvent(clients, { hook_event_name: "PreToolUse", permission_mode: "auto", claude_pid: 101 }, "0");
    clients.commitClaim(me, boardId);
    me.mode = "inkwire";

    const c1 = await connect(boardId);
    const c2 = await connect(boardId);

    const pending = sessionSend(clients, me, session, { text: "see this", highlight: { label: "here", nodes: [n], edges: [] } });
    let s = await until(c2, (m) => m.session.pending);
    expect(s.session.mode).toBe("inkwire");
    expect(s.session.highlight).toMatchObject({ label: "here", nodes: [n] });
    expect(s.session.thread.at(-1)).toMatchObject({ type: "claude", text: "see this" });

    c1.send({ type: "session_reply", text: "ok", focus: null, selection: n });
    const r = await pending;
    expect(r).toMatchObject({ status: "reply", reply: "ok", ctx: { selection: n } });
    s = await until(c2, (m) => !m.session.pending);
    expect(s.session.thread.at(-1)).toMatchObject({ type: "you", text: "ok" });

    c1.send({ type: "highlight_set", msg_id: null });
    s = await until(c1, (m) => m.session.highlight === null);

    c1.send({ type: "layers_create", node_ids: [n], title: "here", note: "Kept from a highlight." });
    s = await until(c1, (m) => m.state.layers.some((l) => l.title === "here"));
    expect(s.state.layers.find((l) => l.title === "here")).toMatchObject({ author: "human", nodes: [n] });

    c1.send({ type: "session_mode_off" });
    s = await until(c2, (m) => m.session.mode === "pty");
    expect(c1.messages.filter((m) => m.type === "error")).toEqual([]);
    await c1.close();
    await c2.close();
  });

  it("a panel reply reaches only the Client that talks on the board; /api/hook routes by ?pid=", async () => {
    const { sessionSend } = await import("../../src/server/session-mode.js");
    // The hook route: ?pid= makes or finds the Client of that Claude Code pid.
    const res = await fetch(`http://127.0.0.1:${port}/api/hook?bg=0&pid=303`, {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "PreToolUse", permission_mode: "auto", session_id: "s303" }),
    });
    expect(await res.text()).toBe("ok");
    expect(clients.get(303)?.hook).toMatchObject({ permissionMode: "auto", autoBackground: "0", sessionId: "s303" });
    // A bad or missing ?pid= becomes null: the event falls back to the Client with that session_id, and makes no new Client.
    const count = clients.all().length;
    for (const [i, q] of ["&pid=abc", "&pid=0", "&pid=-5", ""].entries()) {
      const mode = `fallback-${i}`;
      const r = await fetch(`http://127.0.0.1:${port}/api/hook?bg=0${q}`, {
        method: "POST",
        body: JSON.stringify({ hook_event_name: "PreToolUse", permission_mode: mode, session_id: "s303" }),
      });
      expect(await r.text()).toBe("ok");
      expect(clients.get(303)?.hook?.permissionMode).toBe(mode);
      expect(clients.all()).toHaveLength(count);
    }

    const x = sessions.create("talk A", rootDir);
    const y = sessions.create("talk B", rootDir);
    const [a, b] = [clients.ensure(401), clients.ensure(402)];
    clients.attach(401, "a");
    clients.attach(402, "b");
    clients.commitClaim(a, x.boardId);
    clients.commitClaim(b, y.boardId);
    a.mode = "inkwire";
    b.mode = "inkwire";
    const pa = sessionSend(clients, a, x, { text: "A asks" });
    const pb = sessionSend(clients, b, y, { text: "B asks" });

    const panel = await connect(x.boardId);
    let s = await until(panel, (m) => m.session.pending);
    expect(s.session).toMatchObject({ mode: "inkwire", pending_board: x.boardId });
    panel.send({ type: "session_reply", text: "for A", focus: null, selection: null });
    expect(await pa).toMatchObject({ status: "reply", reply: "for A" });
    expect(b.pending).not.toBeNull();
    expect(y.thread.some((m) => m.type === "you")).toBe(false);

    // The panel mode-off turns off only the Client that talks on this board.
    panel.send({ type: "session_mode_off" });
    s = await until(panel, (m) => m.session.mode === "pty");
    expect(a.mode).toBe("pty");
    expect(b.mode).toBe("inkwire");

    // A board nobody talks on rejects a reply.
    panel.send({ type: "session_reply", text: "nobody", focus: null, selection: null });
    for (;;) {
      const m = await panel.next();
      if (m.type === "error") {
        expect(m.text).toContain("no Claude Code session talks on this board");
        break;
      }
    }
    expect(b.pending).not.toBeNull();
    clients.resolvePending(b, { status: "idle" });
    expect(await pb).toEqual({ status: "idle" });
    b.mode = "pty";
    await panel.close();
  });
});
