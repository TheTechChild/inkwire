// WebSocket hub: one socket per panel, per board. Intents come in with
// author "human"; state pushes go out on every session change. Also the
// capture broker for screenshots.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { clientMessageSchema, type ServerMessage } from "../shared/protocol.js";
import type { Viewport } from "../shared/types.js";
import type { Sessions, BoardSession } from "./session.js";
import * as mutations from "./mutations.js";
import type { CaptureBroker } from "./screenshot.js";

export class PanelHub implements CaptureBroker {
  private byBoard = new Map<string, Set<WebSocket>>();

  constructor(
    server: Server,
    private sessions: Sessions,
  ) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const boardId = url.searchParams.get("board");
      if (!boardId) {
        socket.close(4000, "board query parameter required");
        return;
      }
      let session: BoardSession;
      try {
        session = this.sessions.open(boardId);
      } catch (err) {
        socket.close(4004, String(err instanceof Error ? err.message : err));
        return;
      }
      this.attach(socket, session);
    });
  }

  clientCount(boardId: string): number {
    return this.byBoard.get(boardId)?.size ?? 0;
  }

  private attach(socket: WebSocket, session: BoardSession): void {
    const boardId = session.boardId;
    let set = this.byBoard.get(boardId);
    if (!set) {
      set = new Set();
      this.byBoard.set(boardId, set);
    }
    set.add(socket);

    const unsubscribe = session.onChange(() => this.push(session));
    socket.on("close", () => {
      set.delete(socket);
      unsubscribe();
      // Flush on client disconnect (SPEC § 7). The store may already be
      // closed during shutdown — that flush is not worth crashing over.
      try {
        session.persistNow();
      } catch (err) {
        console.error("flush on disconnect failed:", err);
      }
    });
    socket.on("message", (raw) => {
      try {
        this.handle(session, JSON.parse(String(raw)));
      } catch (err) {
        this.send(socket, {
          type: "error",
          text: err instanceof Error ? err.message : String(err),
        });
        // Re-sync the client after a rejected intent.
        this.push(session);
      }
    });
    this.push(session, socket);
  }

  private handle(session: BoardSession, raw: unknown): void {
    const msg = clientMessageSchema.parse(raw);
    const author = "human" as const;
    switch (msg.type) {
      case "add_stroke":
        mutations.addStroke(session, author, msg.points);
        break;
      case "add_node":
        mutations.addNode(session, author, msg);
        break;
      case "add_edge":
        mutations.addEdge(session, author, msg);
        break;
      case "add_image":
        mutations.addImage(session, author, msg);
        break;
      case "update_node":
        mutations.updateNode(session, author, msg);
        break;
      case "update_edge":
        mutations.updateEdge(session, author, msg);
        break;
      case "delete":
        mutations.deleteElement(session, author, msg.id);
        break;
      case "move":
        mutations.moveElement(session, author, msg);
        break;
      case "history":
        session.historyOp(msg.action, msg.index, msg.scope);
        break;
      case "set_viewport":
        session.setViewport(msg.viewport);
        break;
      case "infer":
        mutations.inferFromInk(session, author, msg.stroke_ids);
        break;
    }
  }

  push(session: BoardSession, only?: WebSocket): void {
    const message: ServerMessage = {
      type: "state",
      state: session.state({ includeInkGeometry: true }),
      history: session.historyRows(),
      log: session.log.slice(-60),
    };
    const targets = only ? [only] : [...(this.byBoard.get(session.boardId) ?? [])];
    for (const socket of targets) this.send(socket, message);
  }

  requestCapture(
    boardId: string,
    captureId: string,
    viewport: Viewport | null,
    fit: boolean,
  ): boolean {
    const set = this.byBoard.get(boardId);
    const socket = set ? [...set].find((s) => s.readyState === WebSocket.OPEN) : undefined;
    if (!socket) return false;
    this.send(socket, { type: "capture_request", capture_id: captureId, viewport, fit });
    return true;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
