// The state contract of the inkwire mod, and the wire shapes of the daemon
// that the mod reads (ADR 0004, "HTTP contract").
//
// These types are copies. The sources are src/shared/protocol.ts and
// src/server/http.ts (ModViewBody). The mod cannot import them at run time,
// because protocol.ts imports zod and a hooks module imports only its own
// files and "claude-code". When the daemon's view shape changes, change these too.
//
// This file has no import and no reference: plugin.json names it as the
// plugin's "types", so it must stand alone.

export type InkwireMode = "pty" | "inkwire";

/** AuthorPush in src/shared/protocol.ts. */
export interface InkwireAuthorPush {
  pid: number;
  label: string;
  mode: InkwireMode;
  /** A blocked send, or mod delivery's awaited reply: the Author waits on the person. */
  pending: boolean;
  /** Mod delivery: waits for a reply with no blocked send. Absent from an older daemon. */
  awaiting?: boolean;
  notice: string | null;
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

/** The current board of the Client: only what the status line shows. */
export interface InkwireBoard {
  id: string;
  name: string;
  author: InkwireAuthorPush | null;
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
 * person sends a refused reply again (/inkwire send).
 */
export interface InkwireOutboxItem extends InkwireReply {
  sentAt?: number;
  turn?: number;
  drop?: string;
}

/**
 * Can the mod reach the daemon? `old` is true when the daemon answered but
 * has no mod routes (it is from before ADR 0004). `checked` is true after the
 * first poll.
 */
export interface InkwireLink {
  up: boolean;
  old: boolean;
  checked: boolean;
}

declare module "claude-code" {
  interface PluginState {
    inkwire: {
      /** The last view from the daemon; null before the first one. */
      view: InkwireView | null;
      link: InkwireLink;
      /** Replies taken from the inbox that Claude Code did not accept yet. */
      outbox: InkwireOutboxItem[];
      /** The count of main turns that ended in this session. */
      turns: number;
      /** The session id that the mod saw first (the launch id), for the view's alias. */
      launch: string | null;
      /** True after the daemon answered a view: it has the mod's routes, so the mod sends hook events. */
      routes: boolean;
      /** The token of the live view loop. A loop with another token stops. */
      loop: string;
      /** The session id that the mod knew last (prev_session_id on clear and resume). */
      session: string | null;
      /** The permission mode of the last settings hook event. */
      permission: string | null;
    };
  }
}
