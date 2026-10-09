// WebSocket hub: one socket per panel, per board. Intents come in with
// author "human"; state pushes go out on every session change. Also the
// capture broker for screenshots.
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { clientMessageSchema, type DaemonPush, type ServerMessage, type SessionPush } from "../shared/protocol.js";
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
import type { BuildInfo } from "./build-info.js";

export interface HubDeps extends ModeDeps {
  /** The daemon's boot build (Decision 10). In-process tests can leave it out. */
  build?: BuildInfo;
  /** The person-only restart (Decision 3, `createRestart`). Only the daemon sets it. */
  restart?: () => void | Promise<void>;
}

/** The board fields of the push that Clients own: what the strip fan-out compares. */
type StripFields = Pick<SessionPush, "author" | "readers" | "released_from">;

export class PanelHub implements CaptureBroker {
  private byBoard = new Map<string, Set<WebSocket>>();
  private wss: WebSocketServer;
  /** boardId → the strip fields that every panel of the board got last. */
  private sentStrip = new Map<string, string>();
  /** The daemon field that every panel got last. */
  private sentDaemon = "";

  constructor(
    private sessions: Sessions,
    private clients: Clients,
    private deps: HubDeps = {},
  ) {
    // A Clients change (a hello, a close, a claim, a release, a mode, a pending send, a notice):
    // push a board only when its Author, reader count or released pid changed. When only
    // daemon.stale changed, every panel gets the light daemon message, not the full state.
    // A hello or a close on board X does not push the state of board Y.
    sessions.onChange(() => this.fanOut());
    // A board opened, was created or was deleted: while a newer build waits, the
    // Restart confirm of every panel must list the open boards.
    sessions.onBoards(() => {
      if (this.clients.staleBuild) this.fanOut();
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
      if (set.size === 0) this.sentStrip.delete(boardId);
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
        // Turns off the mode of this board's Author only; a no-op with no Author or an Author in pty.
        const talker = this.clients.talkingOn(session.boardId);
        if (talker) sessionMode(this.clients, talker, false, this.deps);
        break;
      }
      case "board_release": {
        // Race guard: the Author can change between the push and the click.
        const author = this.clients.authorOf(session.boardId);
        if (author !== msg.pid) {
          throw new Error(`pid ${msg.pid} is not the author of ${session.boardId}. The panel shows the current author`);
        }
        // A talking Author leaves inkwire mode; its pending session_send returns mode_off. No history step.
        this.clients.release(session.boardId, "person");
        break;
      }
      case "board_allow":
        if (!this.clients.allowAgain(session.boardId, msg.pid)) {
          throw new Error(`pid ${msg.pid} is not released from ${session.boardId}`);
        }
        break;
      case "daemon_restart": {
        // Accept only the build that the person saw and confirmed.
        const stale = this.clients.staleBuild;
        const restart = this.deps.restart;
        if (!stale || stale.id !== msg.build_id || !restart) {
          throw new Error(`no restart: the daemon does not report a newer build ${msg.build_id}`);
        }
        void Promise.resolve()
          .then(restart)
          .catch((err) => console.error("restart failed:", err instanceof Error ? err.message : err));
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

  /** The board fields that Clients own: the Author, the reader count and the released pid. */
  private strip(boardId: string): StripFields {
    const pid = this.clients.authorOf(boardId);
    const c = pid === null ? undefined : this.clients.peek(pid);
    const released = this.clients.releasedFrom.get(boardId);
    const r = released === undefined ? undefined : this.clients.peek(released);
    return {
      author:
        pid === null
          ? null
          : {
              pid,
              label: c?.label ?? `pid ${pid}`,
              mode: c?.mode ?? "pty",
              pending: c?.pending?.boardId === boardId,
              notice: this.clients.noticeByBoard.get(boardId) ?? null,
            },
      readers: this.clients.readerCount(boardId),
      released_from: released === undefined ? null : { pid: released, label: r?.label ?? `pid ${released}` },
    };
  }

  /** The same for every board: the boot build, and what a restart affects while a newer build waits. */
  private daemon(): DaemonPush {
    const stale = this.clients.staleBuild;
    return {
      build_id: this.deps.build?.id ?? null,
      stale: stale
        ? {
            newer_build_id: stale.id,
            built_at: stale.built_at,
            boards: this.sessions
              .all()
              .filter((s) => !s.closed)
              .map((s) => ({ id: s.boardId, name: s.meta.name })),
            // Only Clients with an open link: a restart does not close a hook-only record.
            clients: this.clients.peekLinked().map((c) => ({ label: c.label, pid: c.pid })),
          }
        : null,
    };
  }

  /**
   * Push the full state of the boards whose strip fields changed. When the daemon
   * field changed, send it alone to every other panel: a hello while a newer build
   * waits changes daemon.stale.clients, and must not push every board's ink.
   */
  private fanOut(): void {
    const daemon = this.daemon();
    const daemonKey = JSON.stringify(daemon);
    const daemonChanged = daemonKey !== this.sentDaemon;
    this.sentDaemon = daemonKey;
    for (const s of this.sessions.all()) {
      const set = this.byBoard.get(s.boardId);
      if (s.closed || !set?.size) continue;
      if (JSON.stringify(this.strip(s.boardId)) !== this.sentStrip.get(s.boardId)) this.push(s);
      else if (daemonChanged) for (const socket of set) this.send(socket, { type: "daemon", daemon });
    }
  }

  push(session: BoardSession, only?: WebSocket): void {
    const strip = this.strip(session.boardId);
    const daemon = this.daemon();
    const message: ServerMessage = {
      type: "state",
      state: session.state({ includeInkGeometry: true }),
      history: session.historyRows(),
      session: {
        ...strip,
        thread: session.thread,
        highlight: session.highlight
          ? { msg_id: session.highlight.msgId, label: session.highlight.label, nodes: session.highlight.nodes, edges: session.highlight.edges }
          : null,
        trace: session.trace,
      },
      daemon,
    };
    // Only a push to every panel of the board counts as sent: a push to one new socket leaves the others behind.
    if (!only || this.byBoard.get(session.boardId)?.size === 1) this.sentStrip.set(session.boardId, JSON.stringify(strip));
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
