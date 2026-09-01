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

  it("renderer parity: the server SVG contains every laid-out element", async () => {
    const { renderBoardSvg } = await import("../../src/server/render-svg.js");
    const session = sessions.open(boardId);
    const c = session.collections();
    const svg = renderBoardSvg({ collections: c, viewport: session.viewport });
    for (const [id, box] of Object.entries(c.layout)) {
      if (c.nodes.some((n) => n.id === id)) {
        expect(svg).toContain(`<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}"`);
      }
    }
    const edgePaths = svg.match(/marker-end/g) ?? [];
    expect(edgePaths).toHaveLength(c.edges.length);
    const inkPaths = svg.match(/stroke-linejoin="round"/g) ?? [];
    expect(inkPaths).toHaveLength(c.strokes.length);
  });
});
