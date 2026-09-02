// WebSocket hub: one socket per panel, per board. Intents come in with
// author "human"; state pushes go out on every session change. Also the
// capture broker for screenshots.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { clientMessageSchema, type ServerMessage } from "../shared/protocol.js";
import type { Viewport } from "../shared/types.js";
import type { Sessions, BoardSession } from "./session.js";
import * as mutations from "./mutations.js";
import { createLayer, deleteLayer, updateLayer } from "./layers.js";
import { sessionMode, sessionReply } from "./session-mode.js";
import type { CaptureBroker } from "./screenshot.js";

export class PanelHub implements CaptureBroker {
  private byBoard = new Map<string, Set<WebSocket>>();

  constructor(
    server: Server,
    private sessions: Sessions,
    private modeDeps: { focusTerminal?: () => void; pluginRoot?: string } = {},
  ) {
    // Mode, pending, and notice are server-wide: every board's panels redraw the strip.
    sessions.onChange(() => {
      for (const s of sessions.all()) if (this.byBoard.get(s.boardId)?.size) this.push(s);
    });
    const wss = new WebSocketServer({ server, path: "/ws" });
    // ws re-emits the http server's errors (EADDRINUSE included) on the
    // WebSocketServer; without a listener that throws and kills the process
    // before index.ts can print its friendly port-conflict message.
    wss.on("error", (err) => console.error("ws server error:", err.message));
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

    const unsubscribe = session.onChange(() => {
      if (!session.closed) return this.push(session);
      // Board deleted: drop in-flight intents rather than apply them to a dead session.
      socket.removeAllListeners("message");
      socket.close(4010, "board deleted");
    });
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
      case "layers_focus":
        session.setFocus(msg.layer_id, author);
        break;
      case "layers_update":
        updateLayer(session, author, msg);
        break;
      case "layers_delete":
        deleteLayer(session, author, msg);
        break;
      case "layers_create":
        createLayer(session, author, msg);
        break;
      case "session_reply":
        sessionReply(this.sessions, session, msg);
        break;
      case "session_mode_off":
        sessionMode(this.sessions, false, this.modeDeps);
        break;
      case "highlight_set":
        session.setHighlight(msg.msg_id);
        break;
    }
  }

  push(session: BoardSession, only?: WebSocket): void {
    const message: ServerMessage = {
      type: "state",
      state: session.state({ includeInkGeometry: true }),
      history: session.historyRows(),
      session: {
        mode: this.sessions.mode,
        pending: this.sessions.pending !== null,
        pending_board: this.sessions.pending?.boardId ?? null,
        notice: this.sessions.notice,
        thread: session.thread,
        highlight: session.highlight
          ? { msg_id: session.highlight.msgId, label: session.highlight.label, nodes: session.highlight.nodes, edges: session.highlight.edges }
          : null,
      },
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
