// Session tab (handoff "Session"): mode strip, the thread with folded call
// rows, and the composer. Mode, pending, thread and highlight come from the
// server push; only the draft, dropped chips and open rows live here.
import { nextLetter } from "../core/layers.js";
import type { ThreadEntry } from "../shared/types.js";
import type { App } from "./app.js";
import { el, focusedLayer } from "./app.js";
import { fmtTime, toast } from "./panel.js";

type Agent = "off" | "waiting" | "working";

/** Derived, never stored: off in pty; waiting while a send is blocked on
 * this board; working otherwise (a send on another board counts as working here). */
export function agentState(app: App): Agent {
  const s = app.push?.session;
  if (!s || s.mode !== "inkwire") return "off";
  return s.pending && s.pending_board === app.boardId ? "waiting" : "working";
}

export function setupSession(app: App): void {
  const draft = el<HTMLTextAreaElement>("draft");
  draft.addEventListener("input", () => {
    app.draft = draft.value;
    el<HTMLButtonElement>("btn-send").disabled = !canSend(app);
  });
  draft.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(app);
    }
  });
  el("btn-send").addEventListener("click", () => send(app));
}

function canSend(app: App): boolean {
  return agentState(app) === "waiting" && app.draft.trim().length > 0;
}

function send(app: App): void {
  if (!canSend(app)) return;
  const chips = ctxChips(app);
  app.send({
    type: "session_reply",
    text: app.draft.trim(),
    focus: chips.find((c) => c.key === "focus")?.id ?? null,
    selection: chips.find((c) => c.key === "sel")?.id ?? null,
    trace: null,
  });
  app.draft = "";
  app.dropped = {};
  el<HTMLTextAreaElement>("draft").value = "";
  app.render();
}

interface Chip {
  key: "focus" | "sel" | "rev";
  id: string | null;
  label: string;
  title: string;
}

/** What the next message sends with: ids only, minus what the human dropped for this draft. */
function ctxChips(app: App): Chip[] {
  const state = app.push?.state;
  const out: Chip[] = [];
  if (!state) return out;
  const layer = focusedLayer(app);
  if (layer && !app.dropped.focus) {
    out.push({ key: "focus", id: layer.id, label: `${layer.letter} · ${layer.title}`, title: `focused layer ${layer.id} — sent as an id, not its contents` });
  }
  const sel = app.sel;
  if (sel && !app.dropped.sel) {
    const node = sel.type === "node" ? state.graph.nodes.find((n) => n.id === sel.id) : undefined;
    const edge = sel.type === "edge" ? state.graph.edges.find((e) => e.id === sel.id) : undefined;
    if (node) out.push({ key: "sel", id: node.id, label: `${node.id} · ${node.label.slice(0, 22)}`, title: "selected node — sent as an id" });
    if (edge) out.push({ key: "sel", id: edge.id, label: `${edge.id} · ${(edge.label || "edge").slice(0, 22)}`, title: "selected edge — sent as an id" });
  }
  out.push({ key: "rev", id: null, label: `rev ${state.graph.revision}`, title: "graph.revision the message is written against" });
  return out;
}

let threadKey = "";
const mounted = new Set<string>();

export function renderSession(app: App): void {
  const s = app.push?.session;
  const agent = agentState(app);
  const inkwire = s?.mode === "inkwire";

  // Strip.
  const strip = el("modestrip");
  strip.className = inkwire ? "mode-strip on" : "mode-strip";
  strip.replaceChildren();
  const dot = document.createElement("span");
  dot.className = agent === "working" ? "dot blink" : "dot";
  const col = document.createElement("div");
  col.className = "col";
  const kicker = document.createElement("span");
  kicker.className = "kicker";
  kicker.textContent = inkwire ? `INKWIRE MODE · ${agent === "working" ? "CLAUDE CODE IS WORKING" : "WAITING ON YOU"}` : "PTY MODE";
  const body = document.createElement("span");
  body.className = "body";
  body.textContent =
    s?.notice ??
    (inkwire
      ? agent === "working"
        ? "Turn open · calls fold in below as they land"
        : "session_send is blocked on your reply · pty muted"
      : "Replies go to the terminal until you resume here");
  body.title = body.textContent;
  col.append(kicker, body);
  strip.append(dot, col);
  if (inkwire) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost mode-btn";
    btn.textContent = "/back-to-claude-code";
    btn.title = "flag off · pending session_send returns mode_off · terminal is focused";
    btn.addEventListener("click", () => app.send({ type: "session_mode_off" }));
    strip.appendChild(btn);
  }

  // Thread: rebuild only when something in it changed, then scroll to the end.
  const thread = el("thread");
  const entries = s?.thread ?? [];
  const key = `${entries.length}:${entries.at(-1)?.id ?? ""}:${s?.highlight?.msg_id ?? ""}:${agent}:${JSON.stringify(app.open)}`;
  if (key !== threadKey) {
    threadKey = key;
    thread.replaceChildren();
    for (const group of fold(entries)) thread.appendChild(group.length === 1 && group[0]!.type !== "call" ? messageCard(app, group[0]!) : callRow(app, group));
    if (agent === "working") {
      const w = document.createElement("div");
      w.className = "working";
      w.innerHTML = `<span class="dot blink"></span><span>claude code is working · session_send pending</span>`;
      thread.appendChild(w);
    }
    if (entries.length === 0) {
      const note = document.createElement("div");
      note.className = "pane-note";
      note.textContent = inkwire ? "SESSION — claude code's replies land here" : "SESSION — type /use-inkwire in the terminal to talk here";
      thread.appendChild(note);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  // Composer.
  const composer = el("composer");
  composer.classList.toggle("off", !inkwire);
  const row = el("ctxrow");
  row.replaceChildren();
  const lead = document.createElement("span");
  lead.className = "lead";
  lead.textContent = "SENDS WITH";
  row.appendChild(lead);
  const chips = inkwire ? ctxChips(app) : [];
  for (const c of chips) {
    const chip = document.createElement("span");
    chip.className = "ctx-chip";
    chip.title = c.title;
    const label = document.createElement("span");
    label.textContent = c.label;
    chip.appendChild(label);
    if (c.key !== "rev") {
      const x = document.createElement("button");
      x.textContent = "✕";
      x.title = "don't send this";
      x.addEventListener("click", () => {
        app.dropped[c.key as "focus" | "sel"] = true;
        app.render();
      });
      chip.appendChild(x);
    }
    row.appendChild(chip);
  }
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = !inkwire ? "" : chips.length > 1 ? "ids only" : "select or focus to attach";
  const keys = document.createElement("span");
  keys.className = "note keys";
  keys.textContent = "↵ send · ⇧↵ newline";
  row.append(note, keys);

  const draft = el<HTMLTextAreaElement>("draft");
  draft.disabled = agent !== "waiting";
  draft.placeholder = !inkwire ? "in pty mode — replies go to the terminal" : agent === "working" ? "claude code is still working…" : "reply to claude code…";
  el<HTMLButtonElement>("btn-send").disabled = !canSend(app);
}

/** Runs of calls fold into one group; every message is a group of one. */
function fold(entries: ThreadEntry[]): ThreadEntry[][] {
  const groups: ThreadEntry[][] = [];
  for (const e of entries) {
    const last = groups.at(-1);
    if (e.type === "call" && last && last[0]!.type === "call") last.push(e);
    else groups.push([e]);
  }
  return groups;
}

function card(id: string, cls: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = cls;
  // pulsein on first mount only: a rebuild must not replay every card's entrance.
  if (!mounted.has(id)) {
    mounted.add(id);
    div.classList.add("mount");
  }
  return div;
}

function messageCard(app: App, m: ThreadEntry): HTMLElement {
  const you = m.type === "you";
  const div = card(m.id, you ? "card msg you" : "card msg claude");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.innerHTML = `<span></span><span class="time"></span>`;
  (kicker.children[0] as HTMLElement).textContent = you ? "YOU" : "CLAUDE CODE";
  (kicker.children[1] as HTMLElement).textContent = fmtTime(m.at);
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = m.text;
  div.append(kicker, body);

  if (m.type === "you" && m.ctx.length) {
    const row = document.createElement("div");
    row.className = "ctx";
    for (const c of m.ctx) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = c.label;
      chip.title = c.title;
      row.appendChild(chip);
    }
    div.appendChild(row);
  }

  if (m.type === "claude" && m.highlight) {
    const hl = m.highlight;
    const active = app.push?.session.highlight?.msg_id === m.id;
    const row = document.createElement("div");
    row.className = "hl-row";
    const chip = document.createElement("button");
    chip.className = active ? "hl-chip on" : "hl-chip";
    chip.title = "show these elements on the canvas — esc clears";
    chip.innerHTML = `<span class="diamond">◆</span><span class="label"></span><span class="count"></span>`;
    (chip.children[1] as HTMLElement).textContent = hl.label;
    (chip.children[2] as HTMLElement).textContent = `${hl.nodes.length} nodes · ${hl.edges.length} edges`;
    chip.addEventListener("click", () => {
      app.sel = null;
      app.send({ type: "highlight_set", msg_id: m.id });
    });
    row.appendChild(chip);
    // Layers hold nodes only: an edge-only highlight has nothing to keep.
    if (hl.nodes.length > 0) {
      const toLayer = document.createElement("button");
      toLayer.className = "btn btn-ghost to-layer";
      toLayer.textContent = "→ layer";
      toLayer.title = "keep this highlight as a layer";
      toLayer.addEventListener("click", () => {
        const letter = nextLetter(app.push?.state.layers ?? []);
        app.send({ type: "layers_create", node_ids: hl.nodes, title: hl.label, note: `Kept from a highlight in the session at ${fmtTime(m.at)}.` });
        toast(`layers_create · ${letter} from highlight`);
      });
      row.appendChild(toLayer);
    }
    div.appendChild(row);
  }
  return div;
}

function callRow(app: App, calls: ThreadEntry[]): HTMLElement {
  const groupId = calls[0]!.id;
  const open = !!app.open[groupId];
  const wrap = document.createElement("div");
  wrap.className = "call-group";
  const btn = document.createElement("button");
  btn.className = "call-row";
  btn.title = open ? "collapse" : "expand to see each call";
  const names = [...new Set(calls.map((c) => (c.type === "call" ? c.name : "")))].join(" · ");
  btn.innerHTML = `<span class="caret"></span><span class="count"></span><span class="names"></span>`;
  (btn.children[0] as HTMLElement).textContent = open ? "▾" : "▸";
  (btn.children[1] as HTMLElement).textContent = `# ${calls.length} tools called`;
  (btn.children[2] as HTMLElement).textContent = names;
  btn.addEventListener("click", () => {
    app.open[groupId] = !open;
    app.render();
  });
  wrap.appendChild(btn);
  if (open) {
    const list = document.createElement("div");
    list.className = "call-list";
    for (const c of calls) {
      if (c.type !== "call") continue;
      const div = card(c.id, "card call-card");
      const kicker = document.createElement("div");
      kicker.className = "kicker";
      kicker.innerHTML = `<span></span><span class="time"></span>`;
      (kicker.children[0] as HTMLElement).textContent = c.name;
      (kicker.children[1] as HTMLElement).textContent = fmtTime(c.at);
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = c.text;
      div.append(kicker, text);
      if (c.json) {
        const pre = document.createElement("pre");
        pre.textContent = c.json;
        div.appendChild(pre);
      }
      list.appendChild(div);
    }
    wrap.appendChild(list);
  }
  return wrap;
}
