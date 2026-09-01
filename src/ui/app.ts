// Shared UI state + helpers. The server owns board state; this object holds
// only the view over it (selection, tool, viewport, in-flight gesture).
import type { ClientIntent, HistoryRow, LogRow, ServerMessage } from "../shared/protocol.js";
import type { CanvasState, NodeKind, Point } from "../shared/types.js";

export type Tool = "select" | "pen" | "box" | "arrow" | "text" | "erase";
export type Tab = "session" | "history" | "state" | "tools";
export type Scope = "all" | "human" | "ai";

export interface Selection {
  type: "node" | "edge" | "image";
  id: string;
}

export type Drag =
  | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { type: "pen"; points: Point[] }
  | { type: "box"; start: Point; cur: Point }
  | { type: "node"; id: string; dx: number; dy: number; at: Point; moved: boolean };

export interface StatePush {
  state: CanvasState;
  history: HistoryRow[];
  log: LogRow[];
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
