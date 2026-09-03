// Session tab (handoff "Session"): mode strip, the thread with folded call
// rows, and the composer. Mode, pending, thread and highlight come from the
// server push; only the draft, dropped chips and open rows live here.
import { nextLetter } from "../core/layers.js";
import { markCounts } from "../core/drafts.js";
import type { ThreadEntry } from "../shared/types.js";
import type { App } from "./app.js";
import { el, focusedLayer } from "./app.js";
import { traceInfo } from "./canvas.js";
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
    trace: ((c) => (c?.id ? { path: c.id, hop: c.hop! } : null))(chips.find((c) => c.key === "trace")),
    draft: chips.find((c) => c.key === "draft")?.id ?? null,
  });
  app.draft = "";
  app.dropped = {};
  el<HTMLTextAreaElement>("draft").value = "";
  app.render();
}

interface Chip {
  key: "focus" | "sel" | "trace" | "draft" | "rev";
  id: string | null;
  label: string;
  title: string;
  hop?: number;
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
  // The scrubber's position rides along as ids: the pinned trace only, never a peek.
  const tr = traceInfo(app);
  if (tr && !tr.peek && !app.dropped.trace) {
    const hop = Math.max(1, Math.ceil(tr.t));
    out.push({ key: "trace", id: tr.path.id, hop, label: `${tr.path.id} · hop ${hop}/${tr.n}`, title: "the scrubber's position — sent as { path, hop }, ids only" });
  }
  // The active draft rides along as an id, like focus — never its marks.
  const activeDraft = state.active_draft ? state.drafts.find((d) => d.id === state.active_draft) : undefined;
  if (activeDraft && !app.dropped.draft) {
    const counts = markCounts(activeDraft, state.graph.nodes, state.graph.edges);
    const total = counts.removed + counts.changed + counts.added;
    out.push({ key: "draft", id: activeDraft.id, label: `${activeDraft.id} · ${total} marks`, title: "the active draft — sent as an id" });
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
  // Cheap fingerprint of every draft's id/title/marks — a title edit or a new
  // mark must invalidate the key too, not just a draft appearing/disappearing.
  const draftsFingerprint = app.push?.state.drafts.map((d) => JSON.stringify({ id: d.id, title: d.title, marks: d.marks })).join(",") ?? "";
  const key = `${entries.length}:${entries.at(-1)?.id ?? ""}:${s?.highlight?.msg_id ?? ""}:${s?.trace?.path_id ?? ""}:${app.push?.state.layers.flatMap((l) => l.paths.map((p) => p.id)).join(",") ?? ""}:${app.push?.state.active_draft ?? ""}:${draftsFingerprint}:${agent}:${JSON.stringify(app.open)}`;
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
    chip.dataset.key = c.key;
    chip.title = c.title;
    const label = document.createElement("span");
    label.textContent = c.label;
    chip.appendChild(label);
    if (c.key !== "rev") {
      const x = document.createElement("button");
      x.textContent = "✕";
      x.title = "don't send this";
      x.addEventListener("click", () => {
        app.dropped[c.key as "focus" | "sel" | "trace" | "draft"] = true;
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

  if (m.type === "claude" && m.path) {
    const { path_id, layer_id } = m.path;
    const layer = app.push?.state.layers.find((l) => l.id === layer_id);
    const path = layer?.paths.find((p) => p.id === path_id);
    const active = app.push?.session.trace?.path_id === path_id;
    const chip = document.createElement("button");
    chip.className = active ? "path-chip on" : "path-chip";
    chip.title = path ? "play this path on the canvas — opens the scrubber" : "this path no longer exists";
    chip.disabled = !path;
    chip.innerHTML = `<span class="glyph">▸</span><span class="ref"></span><span class="label"></span><span class="count"></span>`;
    (chip.children[1] as HTMLElement).textContent = `${layer?.letter ?? "?"} · ${path_id}`;
    (chip.children[2] as HTMLElement).textContent = path?.title ?? "deleted";
    (chip.children[3] as HTMLElement).textContent = path ? `${path.steps.length} hops` : "";
    chip.addEventListener("click", () => app.send({ type: "trace_set", path_id: active ? null : path_id }));
    div.appendChild(chip);
  }

  if (m.type === "claude" && m.draft) {
    const draftId = m.draft;
    const draft = app.push?.state.drafts.find((d) => d.id === draftId);
    const active = app.push?.state.active_draft === draftId;
    const chip = document.createElement("button");
    chip.className = active ? "draft-msg-chip on" : "draft-msg-chip";
    chip.title = draft ? "show this draft on the canvas — esc clears" : "this draft no longer exists";
    chip.disabled = !draft;
    chip.innerHTML = `<span class="glyph">▣</span><span class="ref"></span><span class="title"></span><span class="counts"><span class="removed"></span><span class="changed"></span><span class="added"></span></span>`;
    (chip.children[1] as HTMLElement).textContent = draftId;
    (chip.children[2] as HTMLElement).textContent = draft?.title ?? "deleted";
    const counts = chip.children[3]!;
    if (draft) {
      const c = markCounts(draft, app.push!.state.graph.nodes, app.push!.state.graph.edges);
      (counts.children[0] as HTMLElement).textContent = String(c.removed);
      (counts.children[1] as HTMLElement).textContent = String(c.changed);
      (counts.children[2] as HTMLElement).textContent = String(c.added);
    }
    chip.addEventListener("click", () => app.send({ type: "drafts_activate", draft_id: active ? null : draftId }));
    div.appendChild(chip);
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
