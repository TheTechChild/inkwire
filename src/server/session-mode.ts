// Session mode (handoff "Session"): each Client's flag, the blocking
// session_send, the Claude Code hook endpoint, and the thread entries they
// produce. Shared by the MCP tools, the WS intents, and the HTTP hook route.
// The hook script is a dumb forwarder; every decision is made here.
import { execFile } from "node:child_process";
import type { Highlight } from "../shared/types.js";
import { playableHops } from "../core/layers.js";
import { findPath, openTrace } from "./layers.js";
import { findDraft } from "./drafts.js";
import { findNotebook } from "./notebooks.js";
import type { BoardSession, SendResult } from "./session.js";
import type { Client, Clients, ReleaseReason } from "./clients.js";

const NOTEBOOK_LINE =
  "Four pointers say where to look. A notebook is where you write about them: markdown on the board, with `[[id]]` refs that resolve live. Never put prose on the canvas — there is no note kind.";

export const MODE_ON_INSTRUCTION =
  `inkwire mode is on: deliver replies with session_send and end your turn only after it returns. Four pointers: highlight = point at a set, layer = keep a cut, path = explain an order, draft = propose a change. ${NOTEBOOK_LINE}`;
const STOP_REASON =
  `inkwire mode is on: the human is in the inkwire panel, not the terminal. Deliver this reply with session_send(text, highlight?, path?, draft?, notebook?) and end your turn only after it returns. ${NOTEBOOK_LINE}`;
const IDLE_NOTICE = "claude code timed out · say something in the terminal";
const MODE_OFF_NOTE = "user returned to the terminal; reply in the PTY";
/** Stop blocks in a row with no session_send between them before the server gives up. */
const BLOCK_CEILING = 3;
const AUTO_MODES = new Set(["auto", "bypassPermissions"]);
const LABEL_MAX = 40;

export interface ModeDeps {
  /** Bring the terminal forward after mode off. Best effort; injected for tests. Gets the TERM_PROGRAM to use. */
  focusTerminal?: (termProgram: string | undefined) => void;
  /** Where the plugin lives, for the relaunch hint. */
  pluginRoot?: string;
}

/**
 * Flip the Client's flag. On requires proof from the hook that Claude Code can
 * run unattended, and a current board that has no other Author; on a board
 * with no Author, mode on claims it.
 */
export function sessionMode(
  clients: Clients,
  client: Client,
  on: boolean,
  deps: ModeDeps = {},
): { mode: "pty" | "inkwire"; hook: string; instruction?: string } {
  if (on) {
    const h = client.hook;
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
    const boardId = client.currentBoardId;
    if (!boardId) throw new Error("no board is open — call boards_open first, then turn the mode on");
    // ADR 0002: in inkwire mode, nothing the Client does can claim another board.
    const talkingOn = clients.authoredBy(client);
    if (client.mode === "inkwire" && talkingOn !== null && talkingOn !== boardId) {
      throw new Error(`You are talking with the person on ${talkingOn}. Turn the mode off before you move to a different board.`);
    }
    // M3 adds: fail when the board's releasedFrom is this pid.
    clients.checkWrite(client, boardId);
    clients.commitClaim(client, boardId);
    if (clients.authorOf(boardId) !== client.pid) throw new Error(`board not found: ${boardId}`);
    const talking = clients.talkingOn(boardId);
    if (talking && talking !== client) throw new Error(`internal: ${clients.labelOf(talking.pid)} already talks on ${boardId}`);
    client.mode = "inkwire";
    clients.noticeByBoard.delete(boardId);
    client.blocks = 0;
    clients.notify();
    record(clients, "session_mode", "on · permission mode is auto, flag on. Stop hook armed.", { mode: "inkwire", hook: "Stop" }, boardId);
    return { mode: "inkwire", hook: "Stop", instruction: MODE_ON_INSTRUCTION };
  }
  const released = modeOff(clients, client, null, { status: "mode_off", note: MODE_OFF_NOTE }, "session_mode", (r) =>
    r ? "off · the pending session_send returned mode_off; terminal focus requested." : "off · replies go to the terminal; terminal focus requested.",
  );
  (deps.focusTerminal ?? focusTerminal)(terminalProgram(client));
  return { mode: "pty", hook: "released", ...(released ? { pending_send: { status: "mode_off" } } : {}) };
}

/**
 * Every way out of inkwire mode: flag, notice, block count, the stranded send,
 * and one call row on the board the Client authors (or the pending board). A
 * Client that authors no board writes no row (Readers never appear in the Thread).
 */
function modeOff(
  clients: Clients,
  client: Client,
  notice: string | null,
  result: SendResult,
  rowName: string,
  rowText: (released: boolean) => string,
): boolean {
  const boardId = client.pending?.boardId ?? clients.authoredBy(client);
  client.mode = "pty";
  client.blocks = 0;
  if (boardId) {
    if (notice) clients.noticeByBoard.set(boardId, notice);
    else clients.noticeByBoard.delete(boardId);
  }
  const released = clients.resolvePending(client, result);
  clients.notify();
  if (boardId) record(clients, rowName, rowText(released), { mode: "pty", pending_send: released ? { status: result.status } : null }, boardId);
  return released;
}

/** The Client stops being the Author of boardId: a talking Client leaves inkwire mode first. */
export function releaseAuthorship(clients: Clients, client: Client, boardId: string, reason: ReleaseReason): void {
  if (clients.talkingOn(boardId) !== client) return;
  modeOff(clients, client, null, { status: "mode_off", note: MODE_OFF_NOTE }, "session_mode", (r) =>
    `off · authorship released (${reason})${r ? "; the pending session_send returned mode_off" : ""}`,
  );
}

export interface SendArgs {
  text: string;
  highlight?: Highlight;
  path?: { layer_id: string; path_id: string; hop?: number };
  draft?: string;
  notebook?: string;
}

/** Append the agent's message, light the highlight, then block until the
 * human replies, the mode flips off, or the timeout fires. */
export function sessionSend(
  clients: Clients,
  client: Client,
  session: BoardSession,
  args: SendArgs,
  signal?: AbortSignal,
): Promise<SendResult & { warnings?: string[] }> {
  if (client.mode !== "inkwire") {
    return Promise.resolve({ status: "mode_off", note: MODE_OFF_NOTE });
  }
  // Only the board this Client authors and talks on. Checked before any row, highlight, trace, draft or notebook.
  if (clients.talkingOn(session.boardId) !== client) {
    const own = clients.authoredBy(client);
    throw new Error(`session_send must go to the board you talk on${own ? ` (${own})` : ""}, not ${session.boardId}`);
  }
  if (client.pending) throw new Error("a session_send is already pending; one turn at a time");

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

  // Path ids are board-unique; layer_id rides along for the chip.
  let path: { layer_id: string; path_id: string } | undefined;
  if (args.path) {
    try {
      path = { layer_id: findPath(session, args.path.path_id).layer.id, path_id: args.path.path_id };
    } catch {
      warnings.push(`unknown path dropped: ${args.path.path_id}`);
    }
  }

  // The draft exists, or it is dropped into warnings; the message lands without the chip either way.
  let draft: string | undefined;
  if (args.draft) {
    try {
      draft = findDraft(session, args.draft).id;
    } catch {
      warnings.push(`unknown draft dropped: ${args.draft}`);
    }
  }

  // Same shape as draft: unknown id drops into warnings, the message lands without the chip.
  let notebook: string | undefined;
  if (args.notebook) {
    try {
      notebook = findNotebook(session, args.notebook).id;
    } catch {
      warnings.push(`unknown notebook dropped: ${args.notebook}`);
    }
  }

  const msg = session.addThread({
    type: "claude",
    text: args.text,
    ...(highlight ? { highlight } : {}),
    ...(path ? { path } : {}),
    ...(draft ? { draft } : {}),
    ...(notebook ? { notebook } : {}),
  });
  if (highlight) session.setHighlight(msg.id);
  // Last, so the trace wins over the highlight: a trace is the stronger pointer.
  if (path) openTrace(session, path.path_id, { t: args.path!.hop, running: args.path!.hop === undefined });
  if (draft) session.setActiveDraft(draft, "ai");
  if (notebook) session.setActiveNotebook(notebook, "ai");
  client.blocks = 0;

  return new Promise<SendResult & { warnings?: string[] }>((resolve) => {
    const timer = setTimeout(() => {
      // Idle: nobody answered. Back to the terminal so the Stop hook lets the turn end.
      modeOff(clients, client, IDLE_NOTICE, { status: "idle" }, "session_send", () => "timed out waiting for a reply · mode pty");
    }, clients.sessions.sendTimeoutMs);
    timer.unref?.();
    client.pending = {
      boardId: session.boardId,
      resolve: (r) => resolve(warnings.length ? { ...r, warnings } : r),
      timer,
    };
    signal?.addEventListener(
      "abort",
      () => {
        // Cancelled from the terminal: the human is there, so the mode follows.
        if (client.pending?.timer !== timer) return;
        modeOff(clients, client, "session_send cancelled from the terminal · mode pty", { status: "idle" }, "session_send", () => "cancelled from the terminal · mode pty");
      },
      { once: true },
    );
    clients.notify();
  });
}

/** The human's reply from the composer: chips from ids, then release the send
 * of the Client that talks on this board. No other Client gets it. */
export function sessionReply(
  clients: Clients,
  session: BoardSession,
  args: {
    text: string;
    focus: string | null;
    selection: string | null;
    trace?: { path: string; hop: number } | null;
    draft?: string | null;
    notebook?: string | null;
  },
): void {
  const talker = clients.talkingOn(session.boardId);
  if (!talker) throw new Error("pty mode: no Claude Code session talks on this board; replies go to the terminal");
  // talkingOn(board) is the board's Author, and sessionSend accepts only that board, so a pending send is always on this board.
  if (!talker.pending) throw new Error("no session_send is pending; claude code is still working");
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
  let trace: { path: string; hop: number } | null = null;
  if (args.trace) {
    const hit = session.layers.flatMap((l) => l.paths.map((p) => [l, p] as const)).find(([, p]) => p.id === args.trace!.path);
    const n = hit ? playableHops(hit[0], session.collections().edges, hit[1]) : 0;
    if (n) {
      trace = { path: args.trace.path, hop: Math.min(n, Math.max(1, args.trace.hop)) };
      ctx.push({ label: `${trace.path} · hop ${trace.hop}/${n}`, title: "the scrubber's position — sent as { path, hop }, ids only" });
    }
  }
  let draft: string | null = null;
  if (args.draft) {
    const d = session.drafts.find((x) => x.id === args.draft);
    if (d) {
      draft = d.id;
      ctx.push({ label: `${d.id} · ${d.title}`, title: "the active draft — sent as an id, not its marks" });
    }
  }
  let notebook: string | null = null;
  if (args.notebook) {
    const n = session.notebooks.find((x) => x.id === args.notebook);
    if (n) {
      notebook = n.id;
      ctx.push({ label: `${n.id} · ${n.title}`, title: "the open notebook — sent as an id, not its body" });
    }
  }
  ctx.push({ label: `rev ${session.graphRevision}`, title: "graph.revision the message was written against" });
  session.addThread({ type: "you", text: args.text, ctx });
  clients.resolvePending(talker, {
    status: "reply",
    reply: args.text,
    ctx: {
      focus: layer ? layer.id : null,
      selection: selected,
      trace,
      draft,
      notebook,
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
  /** The Claude Code pid that hooks/forward.sh found (the ?pid= query); null when it found none. */
  claude_pid?: number | null;
}

/**
 * One endpoint for every Claude Code hook event. The event goes to the Client
 * of its Claude Code pid (created when it is new), else to the Client with its
 * session id, else nowhere. Returns what the shell forwarder should do: block
 * the stop with a reason, add context, or nothing.
 */
export function hookEvent(
  clients: Clients,
  input: HookInput,
  autoBackground: string,
): { block?: string; context?: string } {
  const client =
    typeof input.claude_pid === "number"
      ? clients.ensure(input.claude_pid, { sessionId: input.session_id ?? null })
      : clients.bySessionId(input.session_id);
  if (!client) return {};
  client.hook = {
    permissionMode: input.permission_mode ?? "unknown",
    autoBackground,
    sessionId: input.session_id ?? null,
    at: clients.now(),
  };
  switch (input.hook_event_name) {
    case "Stop": {
      if (client.mode !== "inkwire") return {};
      client.blocks++;
      if (client.blocks > BLOCK_CEILING) {
        modeOff(clients, client, "claude code kept replying to the terminal · mode pty", { status: "idle" }, "session_mode", () => `off · ${BLOCK_CEILING} stops in a row without a session_send`);
        return {};
      }
      return { block: STOP_REASON };
    }
    case "SessionStart":
      // /clear and /resume give a new session id inside the same Claude Code process.
      if ((input.source === "clear" || input.source === "resume") && input.session_id) clients.rekey(client.pid, input.session_id);
      return client.mode === "inkwire" && input.source === "compact" ? { context: MODE_ON_INSTRUCTION } : {};
    default:
      return {};
  }
}

/** A call entry on the given board. */
function record(clients: Clients, name: string, text: string, json: unknown, boardId: string): void {
  try {
    clients.sessions.open(boardId).addThread({ type: "call", name, text, json: JSON.stringify(json) });
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

/** The TERM_PROGRAM of the Client's terminal; the daemon's own only when the Client has none. */
export function terminalProgram(client: Client | null, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return client?.termProgram ?? env.TERM_PROGRAM;
}

/** Best effort: bring the terminal Claude Code runs in to the front. No-op off macOS. */
export function focusTerminal(termProgram: string | undefined): void {
  if (process.platform !== "darwin") return;
  const app = TERMINAL_APPS[termProgram ?? ""];
  if (!app) return;
  execFile("osascript", ["-e", `tell application "${app}" to activate`], () => {});
}
