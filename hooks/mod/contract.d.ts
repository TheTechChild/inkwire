// The state contract of the inkwire mod, and the wire shapes of the daemon
// that the mod reads (ADR 0004, "HTTP contract").
//
// These types are copies. The sources are src/shared/types.ts and
// src/shared/protocol.ts. The mod cannot import them at run time, because
// protocol.ts imports zod and a hooks module imports only its own files and
// "claude-code". When the daemon's push shapes change, change these too.
//
// This file has no import and no reference: plugin.json names it as the
// plugin's "types", so it must stand alone.

export type InkwireMode = "pty" | "inkwire";
export type InkwireAuthor = "human" | "ai";

export interface InkwireNode {
  id: string;
  label: string;
  kind: string;
}

export interface InkwireEdge {
  id: string;
  from: string;
  to: string;
  label: string | null;
  kind: string;
}

export interface InkwirePathStep {
  edge: string;
  caption: string;
  ref: string | null;
}

export interface InkwirePath {
  id: string;
  title: string;
  steps: InkwirePathStep[];
  author: InkwireAuthor;
}

export interface InkwireLayer {
  id: string;
  letter: string;
  title: string;
  note: string;
  nodes: string[];
  author: InkwireAuthor;
  paths: InkwirePath[];
}

export interface InkwireDraft {
  id: string;
  title: string;
  note: string;
  marks: Record<string, "removed" | "changed" | "added">;
  author: InkwireAuthor;
}

export interface InkwireNotebook {
  id: string;
  title: string;
}

/** CanvasState without ink geometry: only the fields the mod reads. */
export interface InkwireCanvas {
  board: { id: string; name: string; project_root: string };
  graph: { revision: number; nodes: InkwireNode[]; edges: InkwireEdge[] };
  layers: InkwireLayer[];
  focus: string | null;
  drafts: InkwireDraft[];
  active_draft: string | null;
  notebooks: InkwireNotebook[];
  active_notebook: string | null;
}

/** HistoryRow in src/shared/protocol.ts. */
export interface InkwireHistoryRow {
  id: string;
  index: number;
  label: string;
  author: InkwireAuthor;
  skipped: boolean;
  conflict: boolean;
  ahead: boolean;
  at: number;
}

/** Trace in src/shared/types.ts. t counts the hops that are done. */
export interface InkwireTrace {
  layer_id: string;
  path_id: string;
  running: boolean;
  loop: boolean;
  t: number;
  started_at: number;
}

export interface InkwireChip {
  label: string;
  title: string;
}

/** ThreadEntry in src/shared/types.ts. */
export type InkwireThreadEntry =
  | { id: string; at: number; type: "you"; text: string; ctx: InkwireChip[] }
  | { id: string; at: number; type: "claude"; text: string; draft?: string; notebook?: string }
  | { id: string; at: number; type: "call"; name: string; text: string; json?: string };

/** AuthorPush in src/shared/protocol.ts. */
export interface InkwireAuthorPush {
  pid: number;
  label: string;
  mode: InkwireMode;
  pending: boolean;
  /** Mod delivery: waits for a reply with no blocked send. Absent from an older daemon. */
  awaiting?: boolean;
  notice: string | null;
}

/** SessionPush in src/shared/protocol.ts. */
export interface InkwireSession {
  author: InkwireAuthorPush | null;
  readers: number;
  released_from: { pid: number; label: string } | null;
  thread: InkwireThreadEntry[];
  highlight: { msg_id: string } | null;
  trace: InkwireTrace | null;
}

/** DaemonPush in src/shared/protocol.ts. */
export interface InkwireDaemon {
  build_id: string | null;
  stale: {
    newer_build_id: string;
    built_at: string | null;
    boards: { id: string; name: string }[];
    clients: { label: string; pid: number }[];
  } | null;
}

/** The Client that has this Claude Code session id (ADR 0004). */
export interface InkwireClient {
  pid: number;
  label: string;
  mode: InkwireMode;
  awaiting: boolean;
  /** How many replies wait in the inbox. POST /api/mod/take gets them. */
  inbox: number;
  current_board: string | null;
}

/** The current board of the Client, with the fields of the browser push. */
export interface InkwireBoard {
  id: string;
  name: string;
  state: InkwireCanvas;
  history: InkwireHistoryRow[];
  session: InkwireSession;
  daemon: InkwireDaemon;
}

/** What GET /api/mod/view returns. */
export interface InkwireView {
  key: string;
  client: InkwireClient | null;
  board: InkwireBoard | null;
}

/** One reply from POST /api/mod/take: the daemon builds the prompt text. */
export interface InkwireReply {
  id: string;
  prompt: string;
}

/**
 * A reply in the mod's outbox. `sentAt` and `turn` (the count of main turns
 * then) are set when the mod submits it, before the submit: a reload never
 * submits it again. `drop` is the reason Claude Code refused it; only the
 * person sends a refused reply again.
 */
export interface InkwireOutboxItem extends InkwireReply {
  sentAt?: number;
  turn?: number;
  drop?: string;
}

/** Can the mod reach the daemon? `port` is the port it tried. */
export interface InkwireLink {
  up: boolean;
  port: number;
  checked: boolean;
}

export type InkwireTab = "session" | "layers" | "drafts" | "history";

/** The intents of clientIntentSchema (src/shared/protocol.ts) that the pane sends. */
export type InkwireIntent =
  | {
      type: "session_reply";
      text: string;
      focus: string | null;
      selection: string | null;
      trace: { path: string; hop: number } | null;
      draft: string | null;
      notebook: string | null;
    }
  | { type: "session_mode_off" }
  | { type: "board_release"; pid: number }
  | { type: "board_allow"; pid: number }
  | { type: "daemon_restart"; build_id: string }
  | { type: "layers_focus"; layer_id: string | null }
  | { type: "trace_set"; path_id: string | null; t?: number; running?: boolean }
  | { type: "trace_seek"; t: number }
  | { type: "trace_run"; running: boolean; loop?: boolean; t?: number }
  | { type: "drafts_activate"; draft_id: string | null }
  | {
      type: "history";
      action: "rewind" | "skip" | "drop" | "undo" | "redo";
      index?: number;
      scope: "all" | "human" | "ai";
    };

declare module "claude-code" {
  interface PluginState {
    inkwire: {
      /** The last view from the daemon; null before the first one. */
      view: InkwireView | null;
      link: InkwireLink;
      tab: InkwireTab;
      /** The path that the Layers tab shows hop by hop. */
      path: string | null;
      /** The history row that the History tab shows actions for. */
      row: string | null;
      /** Replies taken from the inbox that Claude Code did not accept yet. */
      outbox: InkwireOutboxItem[];
      /** The count of main turns that ended in this session. */
      turns: number;
      /** The session id that the mod saw first (the launch id), for the view's alias. */
      launch: string | null;
      /** True after the daemon answered a view: it has the mod's routes, so the mod sends hook events. */
      routes: boolean;
      /** The last error or result of an action, shown at the end of the pane. */
      note: string | null;
      /** The token of the live view loop. A loop with another token stops. */
      loop: string;
      /** The session id that the mod knew last (prev_session_id on clear and resume). */
      session: string | null;
      /** The permission mode of the last settings hook event. */
      permission: string | null;
      /** True after the mod opened the pane by itself once. */
      opened: boolean;
    };
  }
}
