// Shared UI state + helpers. The server owns board state; this object holds
// only the view over it (selection, tool, viewport, in-flight gesture).
import type { ClientIntent, HistoryRow, ServerMessage, SessionPush } from "../shared/protocol.js";
import type { Corner } from "../core/geometry.js";
import type { Box, CanvasState, Layer, NodeKind, Point } from "../shared/types.js";

export type Tool = "select" | "pen" | "box" | "arrow" | "text" | "erase";
export type Tab = "layers" | "drafts" | "session" | "history" | "state" | "tools";
export type Scope = "all" | "human" | "ai";

export interface Selection {
  type: "node" | "edge" | "image";
  id: string;
}

export type Drag =
  | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { type: "pen"; points: Point[] }
  | { type: "box"; start: Point; cur: Point }
  | { type: "node"; id: string; dx: number; dy: number; at: Point; moved: boolean }
  | { type: "resize"; id: string; corner: Corner; origin: Box; box: Box };

export interface StatePush {
  state: CanvasState;
  history: HistoryRow[];
  session: SessionPush;
}

export interface App {
  boardId: string;
  push: StatePush | null;
  tool: Tool;
  tab: Tab;
  scope: Scope;
  theme: "light" | "dark";
  sel: Selection | null;
  pendingFrom: string | null;
  space: boolean;
  view: { x: number; y: number; zoom: number };
  drag: Drag | null;
  /** Side panel: shown or collapsed, and its width in px. Persisted locally. */
  panel: { open: boolean; width: number };
  /** Notebook pane: shown or collapsed, its width in px, and read/edit mode.
   * Persisted locally, inside the same inkwire.panel blob as `panel`. */
  notebook: { open: boolean; width: number; edit: boolean };
  /** Transient: the T tool (or a fresh notebooks_create) wants the caret at the
   * end of the body textarea on the next render that finds one. Never persisted. */
  nbCaretToEnd: boolean;
  /** Show the rim tier (neighbours of a focused layer). Persisted with the panel prefs. */
  rim: boolean;
  /** Dim everything outside an active highlight (handoff highlightOutside: dim | none). Persisted. */
  dim: boolean;
  /** Session tab, panel-local: the composer draft, chips dropped for this draft, open call rows. */
  draft: string;
  dropped: { focus?: true; sel?: true; trace?: true; draft?: true; notebook?: true };
  open: Record<string, boolean>;
  /** Which payload the STATE tab shows while a layer is focused. */
  stateView: "scoped" | "board";
  /** This panel's unacknowledged seek/pause over the server trace; dropped when the push echoes it. */
  traceOverride: { t: number; running: boolean } | null;
  /** The right-click menu (handoff "Drafts" § 4 / "Notebooks" § Migration): panel-local,
   * canvas-only. Optional so main.ts (outside this package) need not seed it — canvas.ts
   * treats absent the same as null. "empty" is the empty-space menu (import notes). */
  menu?: { x: number; y: number; type: "node" | "edge"; id: string } | { x: number; y: number; type: "empty" } | null;
  /** The scrubber's path picker: panel-local, open only while the scrubber is pinned. */
  pathMenu?: boolean;
  connected: boolean;
  send: (intent: ClientIntent) => void;
  render: () => void;
  flash: () => void;
}

export const KIND_META: Record<NodeKind, { label: string; color: string }> = {
  entry: { label: "ENTRY", color: "var(--color-accent-800)" },
  service: { label: "SERVICE", color: "var(--color-accent-700)" },
  store: { label: "STORE", color: "var(--color-neutral-600)" },
  transform: { label: "TRANSFORM", color: "var(--color-accent-600)" },
  // ponytail: legacy + unknown-kind fallback (canvas.ts's `KIND_META[n.kind] ?? KIND_META.note`)
  // — "note" is no longer offered, but a node loaded from before notebooks can still carry it.
  note: { label: "NOTE", color: "var(--color-neutral-500)" },
  state: { label: "STATE", color: "var(--color-accent-2, var(--color-accent-600))" },
  lifeline: { label: "LIFELINE", color: "var(--color-neutral-700)" },
};

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function isServerMessage(raw: unknown): raw is ServerMessage {
  return typeof raw === "object" && raw !== null && "type" in raw;
}

export function clampZoom(z: number): number {
  return Math.min(2.4, Math.max(0.35, z));
}

/** The layer the server says is focused, or null. Focus is shared across panels. */
export function focusedLayer(app: App): Layer | null {
  const s = app.push?.state;
  return s?.layers.find((l) => l.id === s.focus) ?? null;
}

/** Focus a layer through the server; the focused id again (or null) releases. */
export function focusLayer(app: App, id: string | null): void {
  const cur = app.push?.state.focus ?? null;
  app.send({ type: "layers_focus", layer_id: id !== null && id === cur ? null : id });
  app.sel = null;
  app.render();
}
