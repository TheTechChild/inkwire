// The inkwire pane: Session, Layers, Drafts and History of the current board
// of this session's Client. The person presses its buttons, so each intent is
// authored "human", as in the browser panel. The browser stays the ink surface.
import { atom, read, update } from "claude-code";
import type { Elements, RenderInput, RenderSurface } from "claude-code";
import type {
  InkwireBoard,
  InkwireIntent,
  InkwireLayer,
  InkwirePath,
  InkwireTab,
  InkwireThreadEntry,
  InkwireTrace,
  InkwireView,
} from "./contract";
import { type Engine, sendIntent } from "./daemon";
import { deliver, discardOutbox, wake } from "./live";
import { DEFAULT_PORT } from "./state";

const linkAtom = atom({ plugin: "inkwire", key: "link" } as const, { up: false, port: DEFAULT_PORT, checked: false });
const noteAtom = atom({ plugin: "inkwire", key: "note" } as const, null);
const outboxAtom = atom({ plugin: "inkwire", key: "outbox" } as const, []);
const pathAtom = atom({ plugin: "inkwire", key: "path" } as const, null);
const rowAtom = atom({ plugin: "inkwire", key: "row" } as const, null);
const tabAtom = atom({ plugin: "inkwire", key: "tab" } as const, "session");
const viewAtom = atom({ plugin: "inkwire", key: "view" } as const, null);

type Table = Elements[RenderSurface];
type PaneInput = RenderInput<"Pane">;
type Node = ReturnType<Table["Text"]>;

/** The time of one hop of a playing path (HOP_MS in src/core/layers.ts). */
export const HOP_MS = 1100;
/** The rest at the end of a looping path (REST_MS in src/core/layers.ts). */
export const REST_MS = 700;

const TABS: { id: InkwireTab; label: string; hotkey: string }[] = [
  { id: "session", label: "Session", hotkey: "1" },
  { id: "layers", label: "Layers", hotkey: "2" },
  { id: "drafts", label: "Drafts", hotkey: "3" },
  { id: "history", label: "History", hotkey: "4" },
];

let redrawPending = false;

/**
 * Opens the path or history row `id`, or closes it when it is open. It reads
 * the value that stands now, not a value from the time of the drawing.
 */
async function toggle($: Engine, what: "path" | "row", id: string): Promise<void> {
  const flip = (current: string | null) => (current === id ? null : id);
  if (what === "path") await update($, pathAtom, flip);
  else await update($, rowAtom, flip);
}

/** The live t of a trace, as traceT in src/core/layers.ts computes it. */
export function traceT(tr: InkwireTrace, n: number, now: number): number {
  if (!tr.running) return Math.min(n, Math.max(0, tr.t));
  const x = Math.max(0, tr.t) + Math.max(0, now - tr.started_at) / HOP_MS;
  if (!tr.loop) return Math.min(n, x);
  return Math.min(n, x % (n + REST_MS / HOP_MS));
}

/** "content-collections · pid 48211", or "pid N" alone (clientLabel in src/ui/session.ts). */
export function clientLabel(c: { pid: number; label: string }): string {
  return c.label === `pid ${c.pid}` ? c.label : `${c.label} · pid ${c.pid}`;
}

/** The rows a text takes in a body this wide, about. */
function rowsOf(text: string, columns: number): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0);
}

/** Sends an intent for the board the pane shows. The result goes to the note. */
async function act($: Engine, intent: InkwireIntent): Promise<void> {
  const view = await read($, viewAtom);
  if (!view?.board) return;
  let session: string;
  try {
    session = await $.session.id();
  } catch {
    return;
  }
  const error = await sendIntent($, session, view.board.id, intent);
  await update($, noteAtom, () => error);
}

/** Asks the person to confirm. A dismissed question is a no. */
async function confirm($: Engine, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, [yes, "Cancel"])) === yes;
  } catch {
    return false;
  }
}

/** The reply to Claude Code, with the context the browser composer sends: ids only. */
export async function sendReply($: Engine, text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const view = await read($, viewAtom);
  const board = view?.board;
  if (!board) return;
  const state = board.state;
  const trace = board.session.trace;
  let hop: { path: string; hop: number } | null = null;
  if (trace) {
    const n = findPath(board, trace.path_id)?.path.steps.length ?? 0;
    const now = await $.clock.now();
    hop = { path: trace.path_id, hop: Math.max(1, Math.ceil(traceT(trace, n, now))) };
  }
  await act($, {
    type: "session_reply",
    text: body,
    focus: state.focus,
    selection: null,
    trace: hop,
    draft: state.active_draft,
    notebook: state.active_notebook,
  });
}

function findPath(board: InkwireBoard, pathId: string): { layer: InkwireLayer; path: InkwirePath } | null {
  for (const layer of board.state.layers) {
    const path = layer.paths.find((p) => p.id === pathId);
    if (path) return { layer, path };
  }
  return null;
}

/** Draws the pane for the surface `e` names, with the elements that surface has. */
export async function renderPane($: Engine, e: PaneInput): Promise<Node> {
  const T = $.ui.resolve(e) as Table;
  const { Box, Text, Button } = T;
  const view = await read($, viewAtom);
  const link = await read($, linkAtom);
  const tab = await read($, tabAtom);
  const note = await read($, noteAtom);
  const outbox = await read($, outboxAtom);
  // A refused reply waits for the person. A queued one is in Claude Code's queue, and a discard cannot take it back.
  const refused = outbox.filter((x) => x.drop !== undefined).length;
  const queued = outbox.length - refused;
  const columns = Math.max(20, e.props.bodyColumns);
  const rows = Math.max(8, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24);

  let body: Node;
  if (!link.checked) {
    body = <Text dimColor>Connecting to the inkwire daemon…</Text>;
  } else if (!link.up) {
    body = (
      <Box flexDirection="column">
        <Text>The inkwire daemon does not answer on 127.0.0.1:{String(link.port)}.</Text>
        <Text dimColor>The inkwire MCP server starts it when Claude Code connects. Run /mcp to see the server. The mod tries again by itself.</Text>
        <Button key="retry" label="Try now" onPress={() => wake($)} />
      </Box>
    );
  } else if (!view?.client) {
    body = (
      <Box flexDirection="column">
        <Text>No inkwire Client has this session.</Text>
        <Text dimColor>The relay is not connected yet, or it sent another session id (an older Claude Code, or a session from before /clear). Run /mcp to reconnect the inkwire server.</Text>
      </Box>
    );
  } else if (!view.board) {
    body = (
      <Box flexDirection="column">
        <Text>No current board.</Text>
        <Text dimColor>Ask Claude to open or make a board (boards_open, boards_create). The pane shows it here, and the browser panel shows the ink.</Text>
      </Box>
    );
  } else {
    const board = view.board;
    const content =
      tab === "layers"
        ? await layersTab($, T, board, rows - 4)
        : tab === "drafts"
          ? draftsTab($, T, board)
          : tab === "history"
            ? historyTab($, T, board, await read($, rowAtom), rows - 5)
            : await sessionTab($, T, view, board, columns, rows);
    body = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {TABS.map((t) => (
            <Button
              key={`tab:${t.id}`}
              label={t.label}
              hotkey={t.hotkey}
              variant={t.id === tab ? "primary" : "secondary"}
              onPress={() => void update($, tabAtom, () => t.id)}
            />
          ))}
        </Box>
        {content}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {body}
      {queued > 0 && (
        <Text dimColor>
          {queued === 1 ? "1 reply is" : `${queued} replies are`} queued: Claude Code reads it when the turn ends.
        </Text>
      )}
      {refused > 0 && (
        <Box flexDirection="row" gap={1}>
          <Text color="yellow">
            {refused === 1 ? "1 reply waits" : `${refused} replies wait`} to go to Claude Code.
          </Text>
          <Button key="outbox-send" label="Send now" onPress={() => void deliver($, true)} />
          <Button key="outbox-discard" label="Discard" onPress={() => void discardOutbox($)} />
        </Box>
      )}
      {note && (
        <Box flexDirection="row" gap={1}>
          <Text color="red">{note}</Text>
          <Button key="note-dismiss" label="OK" onPress={() => void update($, noteAtom, () => null)} />
        </Box>
      )}
    </Box>
  );
}

async function sessionTab($: Engine, T: Table, view: InkwireView, board: InkwireBoard, columns: number, rows: number): Promise<Node> {
  const { Box, Text, Button } = T;
  const s = board.session;
  const author = s.author;
  const inkwire = author?.mode === "inkwire";
  const kicker = !author
    ? "NO AUTHOR"
    : inkwire
      ? `INKWIRE MODE · ${author.pending ? "WAITING ON YOU" : "CLAUDE CODE IS WORKING"}`
      : "PTY MODE";
  const explain =
    author?.notice ??
    (!author
      ? s.released_from
        ? "The next AI write from another session claims this board."
        : "The next AI write claims this board."
      : inkwire
        ? author.pending
          ? "Claude Code waits on your reply."
          : "The turn is open. Calls show below as they land."
        : "Replies go to the terminal.");
  const who: string[] = [];
  if (author) who.push(`${clientLabel(author)} · ${author.mode}${view.client && author.pid === view.client.pid ? " · this session" : ""}`);
  if (s.readers > 0) who.push(`${s.readers} ${s.readers === 1 ? "reader" : "readers"}`);
  if (s.released_from) who.push(`released ${clientLabel(s.released_from)}`);

  const stale = board.daemon.stale;
  const actions: Node[] = [];
  if (inkwire) {
    actions.push(<Button key="mode-off" label="Mode off" onPress={() => void act($, { type: "session_mode_off" })} />);
  }
  if (author) {
    const a = author;
    actions.push(
      <Button
        key="release"
        label="Release"
        onPress={async () => {
          const extra = a.awaiting
            ? " It waits for your reply. The release turns inkwire mode off, so a reply that it did not read yet is lost."
            : a.pending
              ? " Its pending session_send returns mode_off."
              : "";
          const yes = await confirm(
            $,
            `Release ${clientLabel(a)}? It stops being the author of this board. It can still read the board.${extra}`,
            "Release",
          );
          // The daemon releases only when this pid is still the Author.
          if (yes) await act($, { type: "board_release", pid: a.pid });
        }}
      />,
    );
  }
  if (s.released_from) {
    const r = s.released_from;
    actions.push(<Button key="allow" label={`Allow pid ${r.pid}`} onPress={() => void act($, { type: "board_allow", pid: r.pid })} />);
  }
  if (stale && board.daemon.build_id !== null) {
    const st = stale;
    actions.push(
      <Button
        key="restart"
        label="Restart daemon"
        onPress={async () => {
          const yes = await confirm(
            $,
            `Restart the inkwire daemon on build ${st.newer_build_id}? It drops undo history and pending session_send on ${st.boards.length} open boards and reconnects ${st.clients.length} Claude Code sessions.`,
            "Restart",
          );
          if (yes) await act($, { type: "daemon_restart", build_id: st.newer_build_id });
        }}
      />,
    );
  }

  // The composer: open only while the Author waits on the person.
  const hasInput = "Input" in T;
  let composer: Node;
  if (!author?.pending) {
    composer = <Text dimColor>The reply box opens while Claude Code waits on you.</Text>;
  } else if (!hasInput) {
    composer = <Text dimColor>This surface has no text field. Reply in the browser panel or the terminal.</Text>;
  } else {
    const { Input } = T as Elements["terminal"];
    const ctx: string[] = [];
    if (board.state.focus) ctx.push(`focus ${board.state.layers.find((l) => l.id === board.state.focus)?.letter ?? board.state.focus}`);
    if (s.trace) ctx.push(`trace ${s.trace.path_id}`);
    if (board.state.active_draft) ctx.push(`draft ${board.state.active_draft}`);
    if (board.state.active_notebook) ctx.push(`notebook ${board.state.active_notebook}`);
    composer = (
      <Box flexDirection="column">
        {ctx.length > 0 && <Text dimColor>with {ctx.join(" · ")} · rev {String(board.state.graph.revision)}</Text>}
        <Input key="reply" placeholder="Reply to Claude Code" submitLabel="send" value="" onSubmit={(value) => void sendReply($, value)} />
      </Box>
    );
  }

  const fixed = 5 + (who.length > 0 ? 1 : 0) + (stale ? 1 : 0) + 3;
  const thread = threadView(T, s.thread, columns, Math.max(3, rows - fixed));

  return (
    <Box flexDirection="column">
      <Text bold color={inkwire ? "green" : undefined}>
        {kicker}
      </Text>
      <Text dimColor>{explain}</Text>
      {who.length > 0 && <Text dimColor>{who.join(" · ")}</Text>}
      {stale && (
        <Text color="yellow">
          A newer build ({stale.newer_build_id}) waits. Restart the daemon to load it.
        </Text>
      )}
      {actions.length > 0 && (
        <Box flexDirection="row" gap={1}>
          {actions}
        </Box>
      )}
      <Box flexDirection="column">{thread.length > 0 ? thread : <Text dimColor>The thread is empty.</Text>}</Box>
      {composer}
    </Box>
  );
}

/** The last thread entries that fit. Runs of call rows fold into one dim line. */
function threadView(T: Table, thread: InkwireThreadEntry[], columns: number, budget: number): Node[] {
  const { Box, Text, Markdown } = T;
  type Item = { kind: "msg"; e: Extract<InkwireThreadEntry, { type: "you" | "claude" }> } | { kind: "calls"; names: string[]; id: string } | { kind: "author"; e: InkwireThreadEntry };
  const items: Item[] = [];
  for (const entry of thread) {
    if (entry.type === "call") {
      if (entry.name === "author") {
        items.push({ kind: "author", e: entry });
        continue;
      }
      const last = items[items.length - 1];
      if (last?.kind === "calls") last.names.push(entry.name);
      else items.push({ kind: "calls", names: [entry.name], id: entry.id });
    } else {
      items.push({ kind: "msg", e: entry });
    }
  }
  const shown: Node[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    let cost: number;
    let node: Node;
    if (it.kind === "msg") {
      const who = it.e.type === "you" ? "you" : "claude";
      const chips = it.e.type === "you" && it.e.ctx.length > 0 ? ` · ${it.e.ctx.map((c) => c.label).join(" · ")}` : "";
      cost = 1 + rowsOf(it.e.text, columns);
      node = (
        <Box key={`m:${it.e.id}`} flexDirection="column">
          <Text bold color={it.e.type === "you" ? "cyan" : "magenta"}>
            {who}
            <Text dimColor>{chips}</Text>
          </Text>
          <Markdown text={it.e.text} />
        </Box>
      );
    } else if (it.kind === "author") {
      cost = 1;
      node = <Text dimColor>· {it.e.text}</Text>;
    } else {
      const uniq = [...new Set(it.names)];
      const label = `${it.names.length} ${it.names.length === 1 ? "call" : "calls"}: ${uniq.slice(0, 4).join(", ")}${uniq.length > 4 ? ", …" : ""}`;
      cost = rowsOf(label, columns);
      node = <Text dimColor>⋯ {label}</Text>;
    }
    if (used + cost > budget && shown.length > 0) break;
    used += cost;
    shown.unshift(node);
  }
  return shown;
}

async function layersTab($: Engine, T: Table, board: InkwireBoard, budget: number): Promise<Node> {
  const { Box, Text, Button } = T;
  const state = board.state;
  const selected = await read($, pathAtom);
  const focus = state.layers.find((l) => l.id === state.focus);
  const lines: Node[] = [];
  lines.push(
    <Box flexDirection="row" gap={1}>
      <Text dimColor>Focus: {focus ? `${focus.letter} · ${focus.title}` : "the whole board"}</Text>
      {focus && <Button key="unfocus" label="Show all" onPress={() => void act($, { type: "layers_focus", layer_id: null })} />}
    </Box>,
  );
  if (state.layers.length === 0) {
    lines.push(<Text dimColor>No layers yet. A layer is a named cut of the board.</Text>);
  }
  for (const layer of state.layers) {
    const focused = layer.id === state.focus;
    lines.push(
      <Button key={`layer:${layer.id}`} plain onPress={() => void act($, { type: "layers_focus", layer_id: focused ? null : layer.id })}>
        {focused ? "◉ " : "○ "}
        {layer.letter} {layer.title}
        <Text dimColor>
          {" "}
          · {String(layer.nodes.length)} nodes · {String(layer.paths.length)} paths
        </Text>
      </Button>,
    );
    for (const path of layer.paths) {
      const open = path.id === selected;
      lines.push(
        <Button key={`path:${path.id}`} plain dimColor={!open} onPress={() => void toggle($, "path", path.id)}>
          {open ? "    ▾ " : "    ▸ "}
          {path.id} {path.title}
          <Text dimColor> · {String(path.steps.length)} hops</Text>
        </Button>,
      );
      if (open) lines.push(await walkView($, T, board, layer, path, Math.max(4, budget - lines.length)));
    }
  }
  return <Box flexDirection="column">{lines}</Box>;
}

/** One path hop by hop: the captions, the current hop, and play, back, next and stop. */
async function walkView($: Engine, T: Table, board: InkwireBoard, layer: InkwireLayer, path: InkwirePath, budget: number): Promise<Node> {
  const { Box, Text, Button } = T;
  const nodes = new Map(board.state.graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(board.state.graph.edges.map((ed) => [ed.id, ed]));
  const trace = board.session.trace;
  const pinned = trace && trace.path_id === path.id ? trace : null;
  const n = path.steps.length;
  const now = await $.clock.now();
  const t = pinned ? traceT(pinned, n, now) : 0;
  const hop = pinned ? Math.max(1, Math.ceil(t)) : 0;
  const running = !!pinned && pinned.running && (pinned.loop || t < n);
  if (running) scheduleRedraw($);

  const controls = (
    <Box flexDirection="row" gap={1}>
      <Button
        key="walk-play"
        label={running ? "Pause" : "Play"}
        variant="primary"
        onPress={() => {
          if (!pinned) return void act($, { type: "trace_set", path_id: path.id, t: 0, running: true });
          return void act($, running ? { type: "trace_run", running: false, t } : { type: "trace_run", running: true, t: t >= n ? 0 : t });
        }}
      />
      <Button
        key="walk-prev"
        label="Back"
        onPress={() =>
          void act($, pinned ? { type: "trace_seek", t: Math.max(0, Math.ceil(t) - 1) } : { type: "trace_set", path_id: path.id, t: 0, running: false })
        }
      />
      <Button
        key="walk-next"
        label="Next"
        onPress={() =>
          void act($, pinned ? { type: "trace_seek", t: Math.min(n, Math.floor(t) + 1) } : { type: "trace_set", path_id: path.id, t: 1, running: false })
        }
      />
      {pinned && <Button key="walk-stop" label="Close" onPress={() => void act($, { type: "trace_set", path_id: null })} />}
    </Box>
  );

  const hops: Node[] = [];
  path.steps.forEach((step, j) => {
    const edge = edges.get(step.edge);
    const from = edge ? (nodes.get(edge.from)?.label ?? edge.from) : "?";
    const to = edge ? (nodes.get(edge.to)?.label ?? edge.to) : "?";
    const current = pinned !== null && j === hop - 1;
    const done = pinned !== null && j < Math.floor(t) && !current;
    const mark = current ? "▶" : done ? "✓" : " ";
    const broken = !edge ? " (edge is gone)" : !layer.nodes.includes(edge.from) || !layer.nodes.includes(edge.to) ? " (leaves the layer)" : "";
    hops.push(
      <Box key={`hop:${path.id}:${j}`} flexDirection="column">
        <Text bold={current} color={broken ? "red" : current ? "yellow" : undefined}>
          {mark} {String(j + 1)}. {from} → {to}
          {edge?.label ? <Text dimColor> ({edge.label})</Text> : ""}
          {broken}
        </Text>
        <Text dimColor>{"     "}{step.caption || "no caption on this hop"}</Text>
      </Box>,
    );
  });
  // Keep the current hop in view when the walk is longer than the room.
  const room = Math.max(1, Math.floor((budget - 2) / 2));
  const first = hops.length <= room ? 0 : Math.min(Math.max(0, hop - 1 - Math.floor(room / 2)), hops.length - room);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {"      "}
        {pinned ? `hop ${hop}/${n}${running ? " · playing" : " · paused"}` : `${n} hops · not playing`}
      </Text>
      {controls}
      {hops.slice(first, first + room)}
    </Box>
  );
}

function scheduleRedraw($: Engine): void {
  if (redrawPending) return;
  redrawPending = true;
  try {
    $.clock.after(HOP_MS / 2, () => {
      redrawPending = false;
      $.ui.invalidate("ui.render");
    });
  } catch {
    redrawPending = false;
  }
}

function draftsTab($: Engine, T: Table, board: InkwireBoard): Node {
  const { Box, Text, Button } = T;
  const state = board.state;
  const lines: Node[] = [];
  if (state.drafts.length === 0) lines.push(<Text dimColor>No drafts. A draft proposes a change and marks what it touches.</Text>);
  for (const d of state.drafts) {
    const active = d.id === state.active_draft;
    const roles = Object.values(d.marks);
    const count = (r: string) => roles.filter((x) => x === r).length;
    lines.push(
      <Button key={`draft:${d.id}`} plain onPress={() => void act($, { type: "drafts_activate", draft_id: active ? null : d.id })}>
        {active ? "◉ " : "○ "}
        {d.id} {d.title}
        <Text dimColor>
          {" "}
          · {String(count("added"))} added · {String(count("changed"))} changed · {String(count("removed"))} removed
        </Text>
      </Button>,
    );
    if (active && d.note) lines.push(<Text dimColor>{"    "}{d.note}</Text>);
  }
  return <Box flexDirection="column">{lines}</Box>;
}

function historyTab($: Engine, T: Table, board: InkwireBoard, selected: string | null, budget: number): Node {
  const { Box, Text, Button } = T;
  const all = [...board.history].reverse();
  const row = all.find((r) => r.id === selected) ?? null;
  const room = Math.max(3, budget - (row ? 1 : 0));
  const lines: Node[] = [];
  for (const r of all.slice(0, room)) {
    const flags = [r.author, r.skipped ? "skipped" : "", r.conflict ? "conflict" : "", r.ahead ? "ahead of head" : ""].filter(Boolean).join(" · ");
    const open = r.id === row?.id;
    lines.push(
      <Button key={`row:${r.id}`} plain dimColor={r.ahead || r.skipped} onPress={() => void toggle($, "row", r.id)}>
        {open ? "▾ " : "  "}
        {String(r.index)}. {r.label}
        <Text dimColor> · {flags}</Text>
      </Button>,
    );
    if (open) {
      lines.push(
        <Box flexDirection="row" gap={1}>
          <Text>{"    "}</Text>
          <Button key="row-rewind" label="Rewind here" onPress={() => void act($, { type: "history", action: "rewind", index: r.index, scope: "all" })} />
          <Button key="row-skip" label={r.skipped ? "Unskip" : "Skip"} onPress={() => void act($, { type: "history", action: "skip", index: r.index, scope: "all" })} />
          <Button
            key="row-drop"
            label="Drop"
            onPress={async () => {
              if (await confirm($, `Drop step ${r.index} (${r.label})? It leaves the history. Undo cannot bring it back.`, "Drop")) {
                await act($, { type: "history", action: "drop", index: r.index, scope: "all" });
                await update($, rowAtom, () => null);
              }
            }}
          />
        </Box>,
      );
    }
  }
  if (all.length > room) lines.push(<Text dimColor>{String(all.length - room)} older steps are in the browser panel.</Text>);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="undo" label="Undo" onPress={() => void act($, { type: "history", action: "undo", scope: "all" })} />
        <Button key="redo" label="Redo" onPress={() => void act($, { type: "history", action: "redo", scope: "all" })} />
        <Button key="base" label="Rewind to base" onPress={() => void act($, { type: "history", action: "rewind", index: 0, scope: "all" })} />
      </Box>
      {all.length === 0 ? <Text dimColor>No steps yet.</Text> : lines}
    </Box>
  );
}
