// WebSocket hub: one socket per panel, per board. Intents come in with
// author "human"; state pushes go out on every session change. Also the
// capture broker for screenshots.
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { clientMessageSchema, type ServerMessage } from "../shared/protocol.js";
import type { Viewport } from "../shared/types.js";
import type { Sessions, BoardSession } from "./session.js";
import type { Clients } from "./clients.js";
import * as mutations from "./mutations.js";
import { createLayer, deleteLayer, openTrace, updateLayer } from "./layers.js";
import { createDraft, deleteDraft, markElement, updateDraft } from "./drafts.js";
import { createNotebook, deleteNotebook, migrateNotes, updateNotebook } from "./notebooks.js";
import { sessionMode, sessionReply, type ModeDeps } from "./session-mode.js";
import type { CaptureBroker } from "./screenshot.js";
import { checkBrowserRequest, logRefused } from "./origin.js";

export class PanelHub implements CaptureBroker {
  private byBoard = new Map<string, Set<WebSocket>>();
  private wss: WebSocketServer;

  constructor(
    private sessions: Sessions,
    private clients: Clients,
    private modeDeps: ModeDeps = {},
  ) {
    // Mode, pending, notice and authorship changes: every board's panels redraw the strip.
    sessions.onChange(() => {
      for (const s of sessions.all()) if (this.byBoard.get(s.boardId)?.size) this.push(s);
    });
    // noServer: routeUpgrades (upgrade.ts) gives this hub the /ws upgrades only (M4.2).
    // verifyClient: the Origin and Host check (M4.11).
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (info, cb) => {
        const reason = checkBrowserRequest(info.req);
        if (reason === null) return cb(true);
        logRefused("/ws", info.req, reason);
        cb(false, 403, "Forbidden");
      },
    });
    this.wss = wss;
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

  /** routeUpgrades calls this for each /ws upgrade. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
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
        sessionReply(this.clients, session, msg);
        break;
      case "session_mode_off": {
        // Turns off the Client that talks on this board; a no-op when none does.
        const talker = this.clients.talkingOn(session.boardId);
        if (talker) sessionMode(this.clients, talker, false, this.modeDeps);
        break;
      }
      case "highlight_set":
        session.setHighlight(msg.msg_id);
        break;
      case "trace_set":
        if (msg.path_id) openTrace(session, msg.path_id, { t: msg.t, running: msg.running });
        else session.setTrace(null);
        break;
      case "trace_seek":
        session.updateTrace({ t: msg.t, running: false });
        break;
      case "trace_run":
        session.updateTrace({ running: msg.running, loop: msg.loop, t: msg.t });
        break;
      case "drafts_activate":
        session.setActiveDraft(msg.draft_id, author);
        break;
      case "drafts_mark":
        markElement(session, author, msg);
        break;
      case "drafts_create": {
        // The WS create auto-activates the new draft (README § 5 "new draft"); the MCP tool does not.
        const created = createDraft(session, author, msg);
        session.setActiveDraft(created.draft_id, author);
        break;
      }
      case "drafts_update":
        updateDraft(session, author, msg);
        break;
      case "drafts_delete":
        deleteDraft(session, author, msg);
        break;
      case "notebooks_open":
        session.setActiveNotebook(msg.notebook_id, author);
        break;
      case "notebooks_create": {
        // The WS create opens the new notebook, the way drafts_create auto-activates.
        const created = createNotebook(session, author, msg);
        session.setActiveNotebook(created.notebook_id, author);
        break;
      }
      case "notebooks_update":
        updateNotebook(session, author, msg);
        break;
      case "notebooks_delete":
        deleteNotebook(session, author, msg);
        break;
      case "notes_migrate":
        migrateNotes(session, author);
        break;
    }
  }

  push(session: BoardSession, only?: WebSocket): void {
    // Per board: the mode and the pending send of the Client that talks on it, and the board's notice.
    const talker = this.clients.talkingOn(session.boardId);
    const message: ServerMessage = {
      type: "state",
      state: session.state({ includeInkGeometry: true }),
      history: session.historyRows(),
      session: {
        mode: talker ? talker.mode : "pty",
        pending: talker?.pending != null,
        pending_board: talker?.pending?.boardId ?? null,
        notice: this.clients.noticeByBoard.get(session.boardId) ?? null,
        thread: session.thread,
        highlight: session.highlight
          ? { msg_id: session.highlight.msgId, label: session.highlight.label, nodes: session.highlight.nodes, edges: session.highlight.edges }
          : null,
        trace: session.trace,
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
