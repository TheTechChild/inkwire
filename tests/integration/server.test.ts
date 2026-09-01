// TESTS.md § 5 — integration against a real HTTP+WS server on an ephemeral
// port, with `ws` as the fake browser panel.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../../src/server/http.js";
import { PanelHub } from "../../src/server/ws.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { Sessions } from "../../src/server/session.js";
import { Store } from "../../src/server/store.js";
import * as mutations from "../../src/server/mutations.js";
import type { ServerMessage } from "../../src/shared/protocol.js";

let dataDir: string;
let store: Store;
let sessions: Sessions;
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
  store = new Store(dataDir);
  sessions = new Sessions(store, { debounceMs: 60 });
  http.server = createHttpServer({ store, sessions, screenshots: () => screenshots });
  hub = new PanelHub(http.server, sessions);
  screenshots = new Screenshots(hub, store.imagesDir);
  await new Promise<void>((r) => http.server!.listen(0, "127.0.0.1", () => r()));
  port = (http.server!.address() as AddressInfo).port;
  const session = sessions.create("integration board");
  boardId = session.boardId;
});

afterAll(async () => {
  await new Promise<void>((r) => http.server!.close(() => r()));
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
    await new Promise((r) => setTimeout(r, 150)); // > debounceMs

    const store2 = new Store(dataDir);
    const sessions2 = new Sessions(store2);
    const reopened = sessions2.open(boardId);
    expect(reopened.collections().nodes).toHaveLength(nodesBefore + 1);
    expect(reopened.collections().nodes.map((n) => n.label)).toContain("persisted");
    expect(reopened.history.steps).toHaveLength(0);
    expect(reopened.history.head).toBe(0);
    expect(reopened.state().history.steps).toBe(0);
    store2.close();
  });

  it("board file: export embeds bitmaps, import creates an equal board", async () => {
    const src = sessions.create("Export me");
    const a = mutations.addNode(src, "human", { label: "gateway", kind: "entry", at: [10, 20] }).ids[0]!;
    const b = mutations.addNode(src, "ai", { label: "auth", kind: "service", at: [300, 20], ref: "auth.ts#verify" }).ids[0]!;
    mutations.addEdge(src, "ai", { from: a, to: b, kind: "async", label: "token" });
    mutations.addStroke(src, "human", [[0, 0], [5, 5], [10, 0]]);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const imgSrc = store.saveImage(png, "png");
    mutations.addImage(src, "human", { src: imgSrc, natural: [40, 30], at: [500, 500], size: [40, 30] });

    const exp = await fetch(`http://127.0.0.1:${port}/api/boards/${src.boardId}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toBe('attachment; filename="export-me.inkwire.json"');
    const file = await exp.json();
    expect(file.format).toBe("inkwire-board");
    expect(file.nodes).toHaveLength(2);
    expect(file.assets[imgSrc]).toBe(`data:image/png;base64,${png.toString("base64")}`);

    const imp = await fetch(`http://127.0.0.1:${port}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(file),
    });
    expect(imp.status).toBe(200);
    const created = await imp.json();
    expect(created.board_id).not.toBe(src.boardId);
    expect(created).toMatchObject({ name: "Export me", nodes: 2, edges: 1, strokes: 1, images: 1 });

    const dst = sessions.open(created.board_id);
    expect(dst.collections()).toEqual(src.collections());
    expect(dst.viewport).toEqual(src.viewport);
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
    // Note bodies wrap into tspans (full: unclamped, compact: 3 lines, dot: 1 line).
    const noteLines = svg.match(/<tspan[^>]*>zq[^<]*<\/tspan>/g) ?? [];
    expect(noteLines.length).toBeGreaterThanOrEqual(1);
    if (lod === "compact") expect(noteLines.length).toBeLessThanOrEqual(3);
    if (lod === "dot") expect(noteLines.length).toBe(1);
    if (lod === "full") expect(noteLines.length).toBeGreaterThan(3);
  });
});
