// BoardSession: the in-memory heart of the server. Owns the history, the
// cached fold, and the two revision counters. Every mutation — MCP tool or
// WebSocket intent — goes through mutate(); there is no other write path.
import { randomBytes } from "node:crypto";
import { fold } from "../core/fold.js";
import {
  append,
  dropStep,
  redo,
  rewindTo,
  toggleSkip,
  undo,
  type UndoScope,
} from "../core/history.js";
import { buildCanvasState } from "../core/state.js";
import { stableStringify } from "../core/util.js";
import type {
  Author,
  BoardMeta,
  CanvasState,
  Collections,
  FoldResult,
  History,
  Layer,
  MutationResult,
  Viewport,
} from "../shared/types.js";
import type { HistoryRow } from "../shared/protocol.js";
import type { Store, StoredBoard } from "./store.js";

export interface SessionDeps {
  store: Store;
  now?: () => number;
  newId?: (prefix: string) => string;
  /** Persistence debounce in ms (SPEC § 7). */
  debounceMs?: number;
}

export interface LogEntry {
  author: Author | "server";
  text: string;
  at: number;
}

export interface MutationSpec {
  label: string;
  author: Author;
  key: string | null;
  apply: (c: Collections) => Collections;
  /** Ids the caller knows it touched; pruned ids are appended by mutate(). */
  ids: string[];
}

export type SessionListener = (session: BoardSession) => void;

export class BoardSession {
  readonly boardId: string;
  meta: BoardMeta;
  viewport: Viewport;
  layers: Layer[];
  /** Focused layer id, one per board, shared by every panel like the viewport. Not persisted. */
  focus: string | null = null;
  history: History;
  private foldCache: FoldResult;
  graphRevision = 0;
  layoutRevision = 0;
  private graphFingerprint: string;
  private layoutFingerprint: string;
  readonly log: LogEntry[] = [];
  private listeners = new Set<SessionListener>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Set by Sessions.delete: no further persistence, so a late flush cannot resurrect the row. */
  closed = false;
  private deps: Required<Pick<SessionDeps, "now" | "newId" | "debounceMs">> & { store: Store };

  constructor(board: StoredBoard, deps: SessionDeps) {
    this.boardId = board.meta.id;
    this.meta = board.meta;
    this.viewport = board.viewport;
    this.layers = board.layers;
    this.history = { base: board.collections, steps: [], head: 0 };
    this.foldCache = fold(this.history);
    this.graphFingerprint = this.fingerprintGraph();
    this.layoutFingerprint = this.fingerprintLayout();
    this.deps = {
      store: deps.store,
      now: deps.now ?? Date.now,
      newId: deps.newId ?? ((prefix) => `${prefix}_${randomBytes(3).toString("hex")}`),
      debounceMs: deps.debounceMs ?? 500,
    };
  }

  newId(prefix: string): string {
    return this.deps.newId(prefix);
  }

  now(): number {
    return this.deps.now();
  }

  get foldResult(): FoldResult {
    return this.foldCache;
  }

  collections(): Collections {
    return this.foldCache.collections;
  }

  private fingerprintGraph(): string {
    const c = this.foldCache.collections;
    return stableStringify({ nodes: c.nodes, edges: c.edges });
  }

  private fingerprintLayout(): string {
    return stableStringify(this.foldCache.collections.layout);
  }

  /** Refold, bump revisions on content change, persist, notify. */
  private refold(): void {
    this.foldCache = fold(this.history);
    const g = this.fingerprintGraph();
    const l = this.fingerprintLayout();
    if (g !== this.graphFingerprint) {
      this.graphRevision++;
      this.graphFingerprint = g;
    }
    if (l !== this.layoutFingerprint) {
      this.layoutRevision++;
      this.layoutFingerprint = l;
    }
    this.schedulePersist();
    this.notify();
  }

  mutate(spec: MutationSpec): MutationResult & { truncated: number } {
    const before = this.foldCache.collections;
    const after = spec.apply(before);
    const result = append(this.history, {
      id: this.newId("s"),
      label: spec.label,
      author: spec.author,
      key: spec.key,
      before,
      after,
      at: this.deps.now(),
    });
    this.history = result.history;
    if (result.truncated > 0) {
      this.addLog("server", `edit behind head discarded ${result.truncated} step(s) ahead`);
    }
    if (result.recorded) this.addLog(spec.author, spec.label);
    const beforeEdgeIds = new Set(before.edges.map((e) => e.id));
    this.refold();
    // Report edges the fold pruned as part of this mutation (canvas.delete).
    const afterEdgeIds = new Set(this.foldCache.collections.edges.map((e) => e.id));
    const pruned = [...beforeEdgeIds].filter((id) => !afterEdgeIds.has(id));
    const ids = [...new Set([...spec.ids, ...pruned])];
    return {
      ok: true,
      ids,
      graph_revision: this.graphRevision,
      layout_revision: this.layoutRevision,
      step: result.stepId,
      truncated: result.truncated,
    };
  }

  historyOp(
    action: "rewind" | "skip" | "drop" | "undo" | "redo",
    index: number | undefined,
    scope: UndoScope,
  ): void {
    switch (action) {
      case "rewind":
        this.history = rewindTo(this.history, index ?? this.history.head);
        break;
      case "skip":
        this.history = toggleSkip(this.history, index ?? 0);
        break;
      case "drop":
        this.history = dropStep(this.history, index ?? 0);
        break;
      case "undo":
        this.history = undo(this.history, scope);
        break;
      case "redo":
        this.history = redo(this.history, scope);
        break;
    }
    this.refold();
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.schedulePersist();
    this.notify();
  }

  /** Layers are a view, not history: no step, no revision bump. Persist and notify only. */
  updateLayers(author: Author, label: string, fn: (layers: Layer[]) => Layer[]): void {
    this.layers = fn(this.layers);
    if (this.focus && !this.layers.some((l) => l.id === this.focus)) this.focus = null;
    this.addLog(author, label);
    this.schedulePersist();
    this.notify();
  }

  setFocus(layerId: string | null, author: Author): void {
    const layer = layerId === null ? null : this.layers.find((l) => l.id === layerId);
    if (layer === undefined) throw new Error(`layer not found: ${layerId}`);
    this.focus = layerId;
    this.addLog(author, layer ? `focus · ${layer.letter} ${layer.title}` : "release focus");
    this.notify();
  }

  focusedLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.focus) ?? null;
  }

  /** Stop persisting and tell listeners; the hub closes the board's sockets. */
  close(): void {
    this.closed = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.notify();
  }

  addLog(author: Author | "server", text: string): void {
    this.log.push({ author, text, at: this.deps.now() });
    if (this.log.length > 200) this.log.shift();
  }

  state(opts: { includeInkGeometry?: boolean; includeLayout?: boolean } = {}): CanvasState {
    return buildCanvasState({
      board: { id: this.meta.id, name: this.meta.name },
      foldResult: this.foldCache,
      history: this.history,
      graphRevision: this.graphRevision,
      layoutRevision: this.layoutRevision,
      viewport: this.viewport,
      layers: this.layers,
      focus: this.focus,
      ...opts,
    });
  }

  historyRows(limit?: number): HistoryRow[] {
    const rows = this.history.steps.map((s, i) => ({
      id: s.id,
      index: i + 1,
      label: s.label,
      author: s.author,
      skipped: s.skipped,
      conflict: this.foldCache.conflicts.has(s.id),
      ahead: i + 1 > this.history.head,
      at: s.at,
    }));
    return limit !== undefined ? rows.slice(-limit) : rows;
  }

  onChange(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this);
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), this.deps.debounceMs);
    this.persistTimer.unref?.();
  }

  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.closed) return;
    const now = this.deps.now();
    this.meta = { ...this.meta, updated_at: now };
    this.deps.store.save(
      {
        meta: this.meta,
        collections: this.foldCache.collections,
        viewport: this.viewport,
        layers: this.layers,
      },
      now,
    );
  }
}

/** All open sessions plus the MCP-side "current board" pointer. */
export class Sessions {
  private sessions = new Map<string, BoardSession>();
  currentBoardId: string | null = null;

  constructor(private store: Store, private deps: Omit<SessionDeps, "store"> = {}) {}

  open(boardId: string): BoardSession {
    const existing = this.sessions.get(boardId);
    if (existing) return existing;
    const stored = this.store.load(boardId);
    if (!stored) throw new Error(`board not found: ${boardId}`);
    const session = new BoardSession(stored, { store: this.store, ...this.deps });
    this.sessions.set(boardId, session);
    return session;
  }

  /** New board; with `content`, it starts with that content as step 0 (import). */
  create(
    name: string,
    content?: { collections: Collections; viewport: Viewport; layers?: Layer[] },
  ): BoardSession {
    const now = this.deps.now?.() ?? Date.now();
    const id = `b_${randomBytes(3).toString("hex")}`;
    const stored = this.store.create(id, name, now, content);
    const session = new BoardSession(stored, { store: this.store, ...this.deps });
    this.sessions.set(id, session);
    return session;
  }

  /** Resolve a canvas.* tool's board: explicit id, else the current board. */
  resolve(boardId: string | undefined): BoardSession {
    const id = boardId ?? this.currentBoardId;
    if (!id) {
      throw new Error("no board is open — call boards.open or pass board_id");
    }
    return this.open(id);
  }

  /** Delete a board; false when no such row. The row goes first so a store
   * failure leaves the session untouched rather than half-evicted. */
  delete(boardId: string): boolean {
    if (!this.store.delete(boardId)) return false;
    this.sessions.get(boardId)?.close();
    this.sessions.delete(boardId);
    if (this.currentBoardId === boardId) this.currentBoardId = null;
    return true;
  }

  all(): BoardSession[] {
    return [...this.sessions.values()];
  }

  persistAll(): void {
    for (const s of this.sessions.values()) s.persistNow();
  }
}
