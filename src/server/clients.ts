// Clients: the daemon's record of each connected Claude Code session (CONTEXT.md
// "Client"), keyed by the Claude Code pid (ADR 0001). Each Client holds its own
// current board, session mode, hook report, pending session_send and Stop block
// count. Clients also holds the Author of each board (ADR 0002), the pid the
// person released from each board, the panel notice of each board, and the
// one-time notices of each Client (M3.5). No direct I/O here: Clients reaches
// boards only through Sessions (which can load a board from the store and push
// Thread rows to panels), and the clock comes from Sessions.now.
import type { SessionMode } from "../shared/types.js";
import type { SendResult, Sessions } from "./session.js";
import { releaseAuthorship } from "./session-mode.js";
import type { BuildInfo } from "./build-info.js";

/** What the Claude Code hook last told us. Proof the plugin is installed. */
export interface HookReport {
  permissionMode: string;
  /** CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS as the hook saw it; "unset" when absent. */
  autoBackground: string;
  sessionId: string | null;
  at: number;
}

/** The build a relay runs (`dist/build.json`, M4). */
export type { BuildInfo } from "./build-info.js";

export interface PendingSend {
  boardId: string;
  resolve: (r: SendResult) => void;
  timer: NodeJS.Timeout;
}

export interface Client {
  /** The Claude Code pid: the one id of a Client. Stable across /clear and /resume. */
  readonly pid: number;
  /** CLAUDE_CODE_SESSION_ID. Changes on /clear and /resume (rekey). */
  sessionId: string | null;
  cwd: string;
  build: BuildInfo | null;
  /** The terminal app the Claude Code session runs in (TERM_PROGRAM), for focusTerminal. */
  termProgram: string | null;
  /** The basename of cwd, for the Author label. */
  label: string;
  currentBoardId: string | null;
  mode: SessionMode;
  hook: HookReport | null;
  /** The blocked session_send, if any. */
  pending: PendingSend | null;
  /** Consecutive Stop blocks with no session_send in between: the loop ceiling. */
  blocks: number;
}

export interface ClientInit {
  sessionId?: string | null;
  cwd?: string;
  build?: BuildInfo | null;
  termProgram?: string | null;
}

export type ReleaseReason = "client" | "person" | "disconnect" | "switch" | "deleted";

/** A record that only a hook made is removed when no hello comes for its pid in this time. */
export const HOOK_ONLY_TTL_MS = 60_000;

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

export class Clients {
  private byPid = new Map<number, Client>();
  /** The open links of each pid (Decision 11). A pid with no entry has had no hello. */
  private links = new Map<number, Set<string>>();
  /** When a hook made a record with no link. Cleared by the first attach. */
  private hookOnlySince = new Map<number, number>();
  /** boardId → the pid of its Author. */
  readonly authors = new Map<string, number>();
  /** boardId → the panel strip notice: a mode-on failure, the idle timeout, a board delete. */
  readonly noticeByBoard = new Map<string, string>();
  /**
   * boardId → the pid of the Author that the person released (ADR 0002). That
   * pid cannot write the board until another Client claims it, the pid
   * disconnects, or the person allows it again (allowAgain).
   */
  readonly releasedFrom = new Map<string, number>();
  /** pid → the notices for the next tool result of that Client (M3.5). Each is shown once. */
  private notices = new Map<number, string[]>();
  private listeners = new Set<() => void>();

  constructor(
    readonly sessions: Sessions,
    private hookOnlyTtlMs = HOOK_ONLY_TTL_MS,
  ) {
    sessions.onDelete((boardId) => this.boardDeleted(boardId));
  }

  now(): number {
    return this.sessions.now();
  }

  /** Mode, pending, notice or authorship changed: every panel redraws its strip. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
    this.sessions.notify();
  }

  /**
   * The record for pid; the hello or the first hook creates it. A later caller
   * fills only the fields that are still missing.
   */
  ensure(pid: number, init: ClientInit = {}): Client {
    this.sweep();
    let c = this.byPid.get(pid);
    if (!c) {
      const cwd = init.cwd ?? "";
      c = {
        pid,
        sessionId: init.sessionId ?? null,
        cwd,
        build: init.build ?? null,
        termProgram: init.termProgram ?? null,
        label: cwd ? basename(cwd) : `pid ${pid}`,
        currentBoardId: null,
        mode: "pty",
        hook: null,
        pending: null,
        blocks: 0,
      };
      this.byPid.set(pid, c);
      if (!this.links.has(pid)) this.hookOnlySince.set(pid, this.now());
      return c;
    }
    if (c.sessionId === null && init.sessionId) c.sessionId = init.sessionId;
    if (c.cwd === "" && init.cwd) {
      c.cwd = init.cwd;
      c.label = basename(init.cwd);
    }
    if (c.build === null && init.build) c.build = init.build;
    if (c.termProgram === null && init.termProgram) c.termProgram = init.termProgram;
    return c;
  }

  /** A link (a relay, or the stdio server) for pid opened. It cancels the hook-only TTL. */
  attach(pid: number, linkId: string): void {
    let set = this.links.get(pid);
    if (!set) {
      set = new Set();
      this.links.set(pid, set);
    }
    set.add(linkId);
    this.hookOnlySince.delete(pid);
  }

  /**
   * A link closed. The Client goes only when this was its last link. A link
   * that the record does not hold (a late close of an old link) does nothing.
   */
  detach(pid: number, linkId: string): Client | null {
    const set = this.links.get(pid);
    if (!set || !set.delete(linkId)) return null;
    if (set.size > 0) return null;
    this.links.delete(pid);
    return this.remove(pid);
  }

  get(pid: number): Client | undefined {
    this.sweep();
    return this.byPid.get(pid);
  }

  bySessionId(id: string | undefined | null): Client | undefined {
    if (!id) return undefined;
    this.sweep();
    for (const c of this.byPid.values()) if (c.sessionId === id) return c;
    return undefined;
  }

  all(): Client[] {
    this.sweep();
    return [...this.byPid.values()];
  }

  /** /clear and /resume give a new session id; the pid, and so the Client, stays. */
  rekey(pid: number, newSessionId: string): void {
    const c = this.byPid.get(pid);
    if (c) c.sessionId = newSessionId;
  }

  /**
   * Remove the Client: release its authorship (reason disconnect) and return
   * it, so the caller can resolve its pending send. Only detach (last link)
   * and the hook-only TTL call this.
   */
  remove(pid: number): Client | null {
    const c = this.byPid.get(pid);
    if (!c) return null;
    for (const [boardId, author] of [...this.authors]) if (author === pid) this.release(boardId, "disconnect");
    for (const [boardId, released] of [...this.releasedFrom]) if (released === pid) this.releasedFrom.delete(boardId);
    this.notices.delete(pid);
    this.byPid.delete(pid);
    this.links.delete(pid);
    this.hookOnlySince.delete(pid);
    this.notify();
    return c;
  }

  /** Remove the hook-only records whose TTL is over. */
  sweep(): void {
    const now = this.now();
    for (const [pid, since] of [...this.hookOnlySince]) {
      if (now - since < this.hookOnlyTtlMs) continue;
      this.hookOnlySince.delete(pid);
      this.remove(pid);
    }
  }

  /**
   * A board was deleted. Release it (reason deleted), clear the current board
   * of every Client on it, and resolve each pending send on it with idle.
   */
  boardDeleted(boardId: string): void {
    for (const c of this.byPid.values()) {
      if (c.pending?.boardId === boardId || (c.mode === "inkwire" && this.authors.get(boardId) === c.pid)) {
        // The send can never be answered: hand the conversation back to the terminal.
        c.mode = "pty";
        c.blocks = 0;
        this.resolvePending(c, { status: "idle" });
        this.noticeByBoard.set(boardId, "board deleted · mode pty");
      }
      if (c.currentBoardId === boardId) {
        c.currentBoardId = null;
        this.addNotice(c, `Board ${boardId} was deleted. You have no current board.`);
      }
    }
    this.release(boardId, "deleted");
    this.releasedFrom.delete(boardId);
    this.notify();
    // The panels have been told. The board is gone, so its notice has no later reader.
    this.noticeByBoard.delete(boardId);
  }

  /** Release c's blocked send with a result; false when nothing is pending. */
  resolvePending(c: Client, result: SendResult): boolean {
    const p = c.pending;
    if (!p) return false;
    clearTimeout(p.timer);
    c.pending = null;
    p.resolve(result);
    this.notify();
    return true;
  }

  authorOf(boardId: string): number | null {
    return this.authors.get(boardId) ?? null;
  }

  /** The board that c authors, if any. */
  authoredBy(c: Client): string | null {
    for (const [boardId, pid] of this.authors) if (pid === c.pid) return boardId;
    return null;
  }

  /** Clients whose current board is boardId, less the Author. */
  readerCount(boardId: string): number {
    const author = this.authorOf(boardId);
    let n = 0;
    for (const c of this.byPid.values()) if (c.currentBoardId === boardId && c.pid !== author) n++;
    return n;
  }

  /** The Author of boardId when its mode is inkwire, else null. Panel replies reach only it. */
  talkingOn(boardId: string): Client | null {
    const pid = this.authors.get(boardId);
    const c = pid === undefined ? undefined : this.byPid.get(pid);
    return c && c.mode === "inkwire" ? c : null;
  }

  /** "content-collections · pid 48211" (Decision 8). */
  labelOf(pid: number): string {
    const c = this.byPid.get(pid);
    return c?.cwd ? `${c.label} · pid ${pid}` : `pid ${pid}`;
  }

  /**
   * Throw when another Client is the Author of boardId, or when the person
   * released c from boardId and has not allowed it again.
   */
  checkWrite(c: Client, boardId: string): void {
    const author = this.authorOf(boardId);
    if (author === null && this.releasedFrom.get(boardId) === c.pid) {
      throw new Error(
        `you are no longer the author of ${boardId}; the person released it. Ask the person to allow you again in the panel`,
      );
    }
    if (author === null || author === c.pid) return;
    throw new Error(
      `board ${boardId} has another author: ${this.labelOf(author)}. You can read this board but not write it. Ask the person to release it in the panel`,
    );
  }

  /**
   * Throw when c talks with the person (inkwire mode) on one board and the
   * call would claim another board (boardId null: a new board). ADR 0002: the
   * conversation never ends without a decision.
   */
  checkSwitch(c: Client, boardId: string | null): void {
    if (c.mode !== "inkwire") return;
    const own = this.authoredBy(c);
    if (own === null || own === boardId) return;
    throw new Error(`You are talking with the person on ${own}. Turn the mode off before you move to a different board.`);
  }

  /**
   * c claims boardId and the board becomes c's current board. One board per
   * Client: the claim releases the board c authored before (reason switch),
   * and both Threads and c's next result tell of it (switch and claim notices). It does nothing when the
   * board is no longer open or stored. It checks the Author again, and throws
   * with no change when another pid claimed the board after checkWrite.
   */
  commitClaim(c: Client, boardId: string): void {
    if (!this.sessions.exists(boardId)) return;
    this.checkSwitch(c, boardId);
    this.checkWrite(c, boardId);
    if (this.authorOf(boardId) === c.pid) {
      c.currentBoardId = boardId;
      return;
    }
    const earlier = this.authoredBy(c);
    if (earlier !== null) this.release(earlier, "switch");
    this.authors.set(boardId, c.pid);
    this.releasedFrom.delete(boardId);
    c.currentBoardId = boardId;
    if (earlier !== null) {
      this.addNotice(
        c,
        `Current board is now ${boardId} "${this.nameOf(boardId)}". All later edits with no board_id go to it. You released ${earlier}.`,
      );
      // The person sees the move on both boards (M5 renders the rows).
      this.threadRow(earlier, `claude moved to ${boardId}`);
      this.threadRow(boardId, "claude is now the author");
    }
    // A switch is also a claim (M3.5 lists both events), so it gives both notices.
    this.addNotice(c, `You are now the author of ${boardId}.`);
    this.notify();
  }

  /** The person allows the released pid to claim boardId again. False when pid was not released from it. */
  allowAgain(boardId: string, pid: number): boolean {
    if (this.releasedFrom.get(boardId) !== pid) return false;
    this.releasedFrom.delete(boardId);
    this.notify();
    return true;
  }

  /** Queue a notice for c's next tool result (M3.5). */
  addNotice(c: Client, text: string): void {
    const list = this.notices.get(c.pid) ?? [];
    list.push(text);
    this.notices.set(c.pid, list);
  }

  /** The queued notices of c, removed: each is shown once. */
  takeNotices(c: Client): string[] {
    const list = this.notices.get(c.pid) ?? [];
    this.notices.delete(c.pid);
    return list;
  }

  /**
   * The line that starts every tool result (M3.5):
   * `board <id> "<name>" · you: author|reader · mode: pty|inkwire`, or
   * `board: none · mode: pty` when c has no current board.
   */
  contextLine(c: Client): string {
    const id = c.currentBoardId;
    const name = id === null ? null : this.nameOf(id);
    if (id === null || name === null) return `board: none · mode: ${c.mode}`;
    const role = this.authorOf(id) === c.pid ? "author" : "reader";
    return `board ${id} "${name}" · you: ${role} · mode: ${c.mode}`;
  }

  private nameOf(boardId: string): string | null {
    try {
      const s = this.sessions.open(boardId);
      return s.closed ? null : s.meta.name;
    } catch {
      return null;
    }
  }

  private threadRow(boardId: string, text: string): void {
    try {
      const s = this.sessions.open(boardId);
      if (!s.closed) s.addThread({ type: "call", name: "author", text });
    } catch {
      // board deleted under us: nothing to record on
    }
  }

  /**
   * Release boardId's Author; a talking Author leaves inkwire mode. The
   * board's notice goes too (no session is its Author now), except on a
   * delete: boardDeleted sets the notice and removes it after the panels are
   * told. Returns the released Client.
   */
  release(boardId: string, reason: ReleaseReason): Client | null {
    const pid = this.authors.get(boardId);
    if (pid === undefined) return null;
    const c = this.byPid.get(pid) ?? null;
    if (c) releaseAuthorship(this, c, boardId, reason);
    this.authors.delete(boardId);
    if (reason === "person") {
      this.releasedFrom.set(boardId, pid);
      if (c) this.addNotice(c, `The person released ${boardId}. You can still read it.`);
    }
    if (reason !== "deleted") this.noticeByBoard.delete(boardId);
    this.notify();
    return c;
  }

  /**
   * After a reconnect (M4.7, Open question 11): the hello names the board of
   * the relay's last context line. It becomes c's current board when it still
   * exists. Authorship and inkwire mode are never restored: the next write
   * claims the board again when it is free. Queues the reconnect notice (M3.5).
   */
  restoreCurrentBoard(c: Client, boardId: string): void {
    const head = "The connection to the daemon was restored.";
    if (!this.sessions.exists(boardId)) {
      this.addNotice(c, `${head} Board ${boardId} no longer exists. You have no current board.`);
      return;
    }
    c.currentBoardId = boardId;
    const author = this.authorOf(boardId);
    if (author !== null && author !== c.pid) {
      this.addNotice(c, `${head} Your current board is still ${boardId}. ${boardId} now has another author (${this.labelOf(author)}). You can read it.`);
      return;
    }
    this.addNotice(c, `${head} Your current board is still ${boardId}. You are a reader until your next write claims it.`);
  }

  /** A relay with a newer build than the daemon said hello (Decision 7). M5 shows it in the panel. */
  staleBuild: BuildInfo | null = null;

  markStale(build: BuildInfo, c: Client): void {
    this.staleBuild = build;
    this.addNotice(c, STALE_NOTICE);
    this.notify();
  }
}

/** The line that the next tool result of a Client with a newer build gets (M4.9). */
export const STALE_NOTICE = "inkwire daemon runs an old build; it restarts when all sessions close, or restart it in the panel.";
