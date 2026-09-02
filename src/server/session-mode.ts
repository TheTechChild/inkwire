// Session mode (handoff "Session"): the server-held flag, the blocking
// session_send, the Claude Code hook endpoint, and the thread entries they
// produce. Shared by the MCP tools, the WS intents, and the HTTP hook route.
// The hook script is a dumb forwarder; every decision is made here.
import { execFile } from "node:child_process";
import type { Highlight } from "../shared/types.js";
import type { BoardSession, SendResult, Sessions } from "./session.js";

export const MODE_ON_INSTRUCTION =
  "inkwire mode is on: deliver replies with session_send and end your turn only after it returns.";
const STOP_REASON =
  "inkwire mode is on: the human is in the inkwire panel, not the terminal. Deliver this reply with session_send(text, highlight?) and end your turn only after it returns.";
const IDLE_NOTICE = "claude code timed out · say something in the terminal";
const MODE_OFF_NOTE = "user returned to the terminal; reply in the PTY";
/** Stop blocks in a row with no session_send between them before the server gives up. */
const BLOCK_CEILING = 3;
const AUTO_MODES = new Set(["auto", "bypassPermissions"]);
const LABEL_MAX = 40;

export interface ModeDeps {
  /** Bring the terminal forward after mode off. Best effort; injected for tests. */
  focusTerminal?: () => void;
  /** Where the plugin lives, for the relaunch hint. */
  pluginRoot?: string;
}

/** Flip the flag. On requires proof from the hook that Claude Code can run unattended. */
export function sessionMode(
  sessions: Sessions,
  on: boolean,
  deps: ModeDeps = {},
): { mode: "pty" | "inkwire"; hook: string; instruction?: string } {
  if (on) {
    const h = sessions.hook;
    const root = deps.pluginRoot ?? "<inkwire repo>";
    if (!h) {
      throw new Error(
        `no hook event has reached the server, so the Stop hook is not installed. Relaunch with the inkwire plugin: claude --plugin-dir ${root} --permission-mode auto`,
      );
    }
    if (!AUTO_MODES.has(h.permissionMode)) {
      throw new Error(
        `permission mode is ${h.permissionMode}; the human cannot approve prompts from the panel. Relaunch with: claude --permission-mode auto (or bypassPermissions)`,
      );
    }
    if (h.autoBackground !== "0") {
      throw new Error(
        `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS is ${h.autoBackground}; Claude Code would move session_send to a background task after 2 minutes. Relaunch with: CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 claude --permission-mode auto`,
      );
    }
    sessions.mode = "inkwire";
    sessions.notice = null;
    sessions.blocks = 0;
    sessions.boundSession = h.sessionId;
    sessions.notify();
    record(sessions, "session_mode", "on · permission mode is auto, flag on. Stop hook armed.", { mode: "inkwire", hook: "Stop" });
    return { mode: "inkwire", hook: "Stop", instruction: MODE_ON_INSTRUCTION };
  }
  const released = modeOff(sessions, null, { status: "mode_off", note: MODE_OFF_NOTE }, "session_mode", (r) =>
    r ? "off · the pending session_send returned mode_off; terminal focus requested." : "off · replies go to the terminal; terminal focus requested.",
  );
  (deps.focusTerminal ?? focusTerminal)();
  return { mode: "pty", hook: "released", ...(released ? { pending_send: { status: "mode_off" } } : {}) };
}

/** Every way out of inkwire mode: flag, notice, block count, the stranded
 * send, and one call row on the board the exchange was on. */
function modeOff(
  sessions: Sessions,
  notice: string | null,
  result: SendResult,
  rowName: string,
  rowText: (released: boolean) => string,
): boolean {
  const boardId = sessions.pending?.boardId ?? sessions.currentBoardId;
  sessions.mode = "pty";
  sessions.notice = notice;
  sessions.blocks = 0;
  sessions.boundSession = null;
  const released = sessions.resolvePending(result);
  sessions.notify();
  record(sessions, rowName, rowText(released), { mode: "pty", pending_send: released ? { status: result.status } : null }, boardId);
  return released;
}

export interface SendArgs {
  text: string;
  highlight?: Highlight;
}

/** Append the agent's message, light the highlight, then block until the
 * human replies, the mode flips off, or the timeout fires. */
export function sessionSend(
  sessions: Sessions,
  session: BoardSession,
  args: SendArgs,
  signal?: AbortSignal,
): Promise<SendResult & { warnings?: string[] }> {
  if (sessions.mode !== "inkwire") {
    return Promise.resolve({ status: "mode_off", note: MODE_OFF_NOTE });
  }
  if (sessions.pending) throw new Error("a session_send is already pending; one turn at a time");

  const warnings: string[] = [];
  let highlight: Highlight | undefined;
  if (args.highlight) {
    const c = session.collections();
    const nodeIds = new Set(c.nodes.map((n) => n.id));
    const edgeIds = new Set(c.edges.map((e) => e.id));
    const keep = (ids: string[], have: Set<string>, what: string) =>
      [...new Set(ids)].filter((id) => {
        if (have.has(id)) return true;
        warnings.push(`unknown ${what} dropped from highlight: ${id}`);
        return false;
      });
    highlight = {
      label: args.highlight.label.slice(0, LABEL_MAX),
      nodes: keep(args.highlight.nodes, nodeIds, "node"),
      edges: keep(args.highlight.edges, edgeIds, "edge"),
    };
  }

  const msg = session.addThread({ type: "claude", text: args.text, ...(highlight ? { highlight } : {}) });
  if (highlight) session.setHighlight(msg.id);
  sessions.blocks = 0;

  return new Promise<SendResult & { warnings?: string[] }>((resolve) => {
    const timer = setTimeout(() => {
      // Idle: nobody answered. Back to the terminal so the Stop hook lets the turn end.
      modeOff(sessions, IDLE_NOTICE, { status: "idle" }, "session_send", () => "timed out waiting for a reply · mode pty");
    }, sessions.sendTimeoutMs);
    timer.unref?.();
    sessions.pending = {
      boardId: session.boardId,
      resolve: (r) => resolve(warnings.length ? { ...r, warnings } : r),
      timer,
    };
    signal?.addEventListener(
      "abort",
      () => {
        // Cancelled from the terminal: the human is there, so the mode follows.
        if (sessions.pending?.timer !== timer) return;
        modeOff(sessions, "session_send cancelled from the terminal · mode pty", { status: "idle" }, "session_send", () => "cancelled from the terminal · mode pty");
      },
      { once: true },
    );
    sessions.notify();
  });
}

/** The human's reply from the composer: chips from ids, then release the send. */
export function sessionReply(
  sessions: Sessions,
  session: BoardSession,
  args: { text: string; focus: string | null; selection: string | null },
): void {
  if (sessions.mode !== "inkwire") throw new Error("pty mode: replies go to the terminal");
  if (!sessions.pending) throw new Error("no session_send is pending; claude code is still working");
  if (sessions.pending.boardId !== session.boardId) {
    throw new Error(`the pending session_send is on board ${sessions.pending.boardId}, not this one`);
  }
  const c = session.collections();
  const ctx: { label: string; title: string }[] = [];
  const layer = args.focus ? session.layers.find((l) => l.id === args.focus) : undefined;
  if (layer) ctx.push({ label: `${layer.letter} · ${layer.title}`, title: `focused layer ${layer.id} — sent as an id, not its contents` });
  let selected: string | null = null;
  if (args.selection) {
    const node = c.nodes.find((n) => n.id === args.selection);
    const edge = c.edges.find((e) => e.id === args.selection);
    if (node) ctx.push({ label: `${node.id} · ${node.label.slice(0, 22)}`, title: "selected node — sent as an id" });
    else if (edge) ctx.push({ label: `${edge.id} · ${(edge.label || "edge").slice(0, 22)}`, title: "selected edge — sent as an id" });
    if (node || edge) selected = args.selection;
  }
  ctx.push({ label: `rev ${session.graphRevision}`, title: "graph.revision the message was written against" });
  session.addThread({ type: "you", text: args.text, ctx });
  sessions.resolvePending({
    status: "reply",
    reply: args.text,
    ctx: {
      focus: layer ? layer.id : null,
      selection: selected,
      revision: session.graphRevision,
    },
  });
}

export interface HookInput {
  hook_event_name?: string;
  permission_mode?: string;
  session_id?: string;
  source?: string;
  stop_hook_active?: boolean;
}

/** One endpoint for every Claude Code hook event. Returns what the shell
 * forwarder should do: block the stop with a reason, add context, or nothing. */
export function hookEvent(
  sessions: Sessions,
  input: HookInput,
  autoBackground: string,
): { block?: string; context?: string } {
  // While the mode is on, only the Claude Code session that turned it on is
  // ours; another session's hooks (a second launch on this machine) pass through.
  if (sessions.mode === "inkwire" && sessions.boundSession && input.session_id !== sessions.boundSession) return {};
  sessions.hook = {
    permissionMode: input.permission_mode ?? "unknown",
    autoBackground,
    sessionId: input.session_id ?? null,
    at: sessions.now(),
  };
  switch (input.hook_event_name) {
    case "Stop": {
      if (sessions.mode !== "inkwire") return {};
      sessions.blocks++;
      if (sessions.blocks > BLOCK_CEILING) {
        modeOff(sessions, "claude code kept replying to the terminal · mode pty", { status: "idle" }, "session_mode", () => `off · ${BLOCK_CEILING} stops in a row without a session_send`);
        return {};
      }
      return { block: STOP_REASON };
    }
    case "SessionStart":
      return sessions.mode === "inkwire" && input.source === "compact" ? { context: MODE_ON_INSTRUCTION } : {};
    default:
      return {};
  }
}

/** A call entry on the given board, else the current one, if there is one. */
function record(sessions: Sessions, name: string, text: string, json: unknown, boardId: string | null = sessions.currentBoardId): void {
  if (!boardId) return;
  try {
    sessions.open(boardId).addThread({ type: "call", name, text, json: JSON.stringify(json) });
  } catch {
    // board deleted under us — nothing to record on
  }
}

// ponytail: TERM_PROGRAM → app name covers the common macOS terminals; extend the table if yours is missing.
const TERMINAL_APPS: Record<string, string> = {
  "iTerm.app": "iTerm",
  Apple_Terminal: "Terminal",
  vscode: "Visual Studio Code",
  ghostty: "Ghostty",
  WarpTerminal: "Warp",
  WezTerm: "WezTerm",
  Hyper: "Hyper",
  kitty: "kitty",
  Alacritty: "Alacritty",
};

/** Best effort: bring the terminal Claude Code runs in to the front. No-op off macOS. */
export function focusTerminal(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;
  const app = TERMINAL_APPS[env.TERM_PROGRAM ?? ""];
  if (!app) return;
  execFile("osascript", ["-e", `tell application "${app}" to activate`], () => {});
}
