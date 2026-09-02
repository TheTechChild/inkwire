// Right panel (inspector + four tabs), header controls, and the footer.
import { captureBoard } from "./capture.js";
import { deleteSelection } from "./canvas.js";
import type { App, Scope, Tab, Tool } from "./app.js";
import { KIND_META, el, focusLayer, focusedLayer } from "./app.js";
import { liveMembers, scopeState } from "../core/layers.js";
import { NODE_KINDS, EDGE_KINDS } from "../shared/types.js";
import { renderSession } from "./session.js";

const TOOLS: [Tool, string, string][] = [
  ["select", "select", "V"],
  ["pen", "pen", "P"],
  ["box", "node", "B"],
  ["arrow", "edge", "A"],
  ["text", "text", "T"],
  ["erase", "erase", "E"],
];

const TABS: [Tab, string][] = [
  ["layers", "LAYERS"],
  ["session", "SESSION"],
  ["history", "HISTORY"],
  ["state", "STATE"],
  ["tools", "TOOLS"],
];

const SCOPES: [Scope, string][] = [
  ["all", "ALL"],
  ["human", "YOU"],
  ["ai", "CLAUDE"],
];

const SCOPE_NOTES: Record<Scope, string> = {
  all: "⌘Z rewinds the timeline a step at a time — click any row to jump the canvas straight to that point.",
  human: "⌘Z skips your last edit in place and leaves claude's work standing. Row clicks still rewind the whole timeline.",
  ai: "⌘Z skips claude's last edit in place and keeps everything you drew. Row clicks still rewind the whole timeline.",
};

// The real tool surface (SPEC § 9). Run buttons exist only where
// the panel can genuinely act; the rest belong to Claude over MCP.
const MCP_TOOLS: [string, string, string, (app: App) => void | null][] = [
  ["session.mode", "Flip the mode flag the server holds. On: fails unless permission mode is auto; arms the Stop hook that redirects replies into session_send. Off: releases any pending session_send with mode_off.", "(on: boolean) → { mode, hook }", (app) => switchTab(app, "session")],
  ["session.send", "Deliver a reply to the Session tab, optionally pointing at elements. Blocks until the human replies (20 min timeout) and returns their message with focus, selection and revision as ids.", "(text, highlight?: { nodes, edges, label }) → { reply, ctx } | { status: mode_off | idle }", (app) => switchTab(app, "session")],
  ["boards.list", "Board ids, names, element counts, last touched.", "() → { boards }", null as never],
  ["boards.open", "Make a board current and return its state.", "(board_id) → CanvasState", null as never],
  ["boards.create", "New empty board.", "(name) → { board_id }", null as never],
  ["boards.delete", "Delete a board permanently.", "(board_id) → { deleted }", null as never],
  ["boards.import", "Load a downloaded board file from disk into a new board.", "(path) → { board_id }", null as never],
  ["canvas.get_state", "What the human is looking at right now — only the focused layer, with its seams and what it omitted.", "(include_ink_geometry?, include_layout?) → CanvasState", (app) => { app.stateView = "scoped"; switchTab(app, "state"); }],
  ["canvas.get_board", "The whole board regardless of focus, plus layers[] and focus.", "(include_layout?) → CanvasState", (app) => { app.stateView = "board"; switchTab(app, "state"); }],
  ["canvas.screenshot", "Pixels of the current viewport, for reading handwriting and layout.", "(viewport?, fit?) → image", (app) => downloadScreenshot(app)],
  ["canvas.infer_structure", "Turn freehand ink into typed nodes and edges.", "(stroke_ids?) → diff", (app) => app.send({ type: "infer" })],
  ["canvas.add_node", "Place a node on the shared board.", "(label, kind, at?, size?) → id", null as never],
  ["canvas.update_node", "Change a node's label, kind, or bindings.", "(node_id, …fields)", null as never],
  ["canvas.add_edge", "Connect two nodes with label, schema, kind, condition.", "(from, to, …fields) → id", null as never],
  ["canvas.update_edge", "Change an edge's label, schema, kind, or condition.", "(edge_id, …fields)", null as never],
  ["canvas.delete", "Remove an element; a node takes its edges with it.", "(id)", null as never],
  ["canvas.move", "Set layout for an element. Bumps layout.revision only.", "(id, at, size?)", null as never],
  ["canvas.bind_code", "Attach a file/function or endpoint to a node — validated against the project root.", "(node_id, ref | endpoint)", null as never],
  ["canvas.annotate", "Pin a comment to an element as a note node.", "(target_id, text)", null as never],
  ["canvas.set_viewport", "Pan and zoom so the human sees what you mean.", "(x, y, zoom)", null as never],
  ["canvas.export_mermaid", "Serialise the graph as text for the transcript.", "() → string", null as never],
  ["canvas.lint", "Static checks against the project root: missing refs, unbound nodes, edge shape.", "() → findings", null as never],
  ["history.get", "Read the timeline: steps, authors, conflicts. Read-only.", "(limit?) → { head, steps }", null as never],
  ["layers.list", "Every layer with its letter, title, member count — and which one the human is looking at.", "() → { focus, layers }", (app) => switchTab(app, "layers")],
  ["layers.create", "Cut a named subset out of the board. downstream: true also adds everything reachable along edges.", "(node_ids, title?, note?, downstream?) → { layer_id, letter, members }", null as never],
  ["layers.update", "Add or remove members, retitle, or rewrite the note. Elements themselves are untouched.", "(layer_id, add?, remove?, title?, note?) → { layer_id, members }", null as never],
  ["layers.focus", "Focus a layer in the human's viewport, or pass null to release. It moves someone else's screen.", "(layer_id | null) → { ok }", (app) => focusLayer(app, app.push?.state.focus ? null : (app.push?.state.layers[0]?.id ?? null))],
  ["layers.delete", "Remove a layer. A layer is a view over the board, so nothing on the board is deleted.", "(layer_id) → { ok }", null as never],
];

const PANEL_KEY = "inkwire.panel";
const PANEL_DEFAULT_WIDTH = 372;
const clampPanelWidth = (w: number): number => Math.min(720, Math.max(260, Math.round(w)));

/** Side-panel prefs (plus the rim setting) from localStorage; defaults when absent or unreadable. */
export function loadPanelPrefs(): App["panel"] & { rim: boolean; dim: boolean } {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { open?: unknown; width?: unknown; rim?: unknown; dim?: unknown };
      return { open: p.open !== false, width: clampPanelWidth(Number(p.width) || PANEL_DEFAULT_WIDTH), rim: p.rim !== false, dim: p.dim !== false };
    }
  } catch {
    // storage unavailable — fall through to defaults
  }
  return { open: true, width: PANEL_DEFAULT_WIDTH, rim: true, dim: true };
}

function savePanelPrefs(app: App): void {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ ...app.panel, rim: app.rim, dim: app.dim }));
  } catch {
    // storage unavailable — prefs live for this page only
  }
}

export function applyPanel(app: App): void {
  el("app").classList.toggle("panel-closed", !app.panel.open);
  el("body").style.setProperty("--panel-w", `${app.panel.width}px`);
  const btn = el("btn-panel");
  btn.textContent = app.panel.open ? "panel ▸" : "◂ panel";
  btn.title = app.panel.open ? "hide the side panel" : "show the side panel";
}

export function setupPanel(app: App): void {
  // Side panel: collapse toggle in the header, drag-to-resize on its left edge.
  applyPanel(app);
  el("btn-panel").addEventListener("click", () => {
    app.panel.open = !app.panel.open;
    savePanelPrefs(app);
    applyPanel(app);
  });
  const resizer = el("aside-resizer");
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = app.panel.width;
    const move = (ev: PointerEvent) => {
      app.panel.width = clampPanelWidth(startW + (startX - ev.clientX));
      applyPanel(app);
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      savePanelPrefs(app);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });

  // Header: tool palette.
  const toolSeg = el("toolseg");
  for (const [id, label, key] of TOOLS) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.title = `${label} (${key})`;
    opt.innerHTML = `<input type="radio" name="tool" value="${id}"><span>${label}</span><span class="keycap">${key}</span>`;
    opt.querySelector("input")!.addEventListener("change", () => {
      app.tool = id;
      app.pendingFrom = null;
      app.render();
    });
    toolSeg.appendChild(opt);
  }

  // Theme.
  for (const input of el("themeseg").querySelectorAll("input")) {
    input.addEventListener("change", () => {
      app.theme = input.value as "light" | "dark";
      document.documentElement.dataset.theme = app.theme;
      app.render();
    });
  }

  // Undo / redo — they act through history intents, scoped. The buttons are
  // labels around a radio input, so one click reaches the label twice (once
  // from the pointer, once re-dispatched from the input); act on the first only.
  const onLabelClick = (id: string, fn: () => void) =>
    el(id).addEventListener("click", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      fn();
    });
  onLabelClick("btn-undo", () => app.send({ type: "history", action: "undo", scope: app.scope }));
  onLabelClick("btn-redo", () => app.send({ type: "history", action: "redo", scope: app.scope }));

  el("btn-screenshot").addEventListener("click", () => void downloadScreenshot(app));

  // Board file export (a download the server names) and import (a new board).
  el("btn-export").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/boards/${encodeURIComponent(app.boardId)}/export`;
    a.download = ""; // filename comes from Content-Disposition
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  const importFile = el<HTMLInputElement>("import-file");
  el("btn-import").addEventListener("click", () => {
    importFile.value = "";
    importFile.click();
  });
  importFile.addEventListener("change", () => void importBoardFile(importFile.files?.[0]));
  el("btn-infer").addEventListener("click", () => app.send({ type: "infer" }));
  el("btn-resetview").addEventListener("click", () => {
    app.view = { x: 40, y: 20, zoom: 1 };
    app.send({ type: "set_viewport", viewport: app.view });
    app.render();
  });

  // Tabs.
  const tabs = el("tabs");
  for (const [id, label] of TABS) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.innerHTML = `<input type="radio" name="tab" value="${id}"${id === app.tab ? " checked" : ""}><span>${label}</span>`;
    opt.querySelector("input")!.addEventListener("change", () => switchTab(app, id));
    tabs.appendChild(opt);
  }

  // STATE tab: which payload to show while a layer is focused.
  const stateSeg = el("stateseg");
  for (const view of ["scoped", "board"] as const) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.style.cssText = "flex:1;justify-content:center;padding:6px 4px;font-family:var(--font-mono);font-size:10.5px";
    opt.innerHTML = `<input type="radio" name="stateview"><span>${view}</span>`;
    opt.querySelector("input")!.addEventListener("change", () => {
      app.stateView = view;
      app.render();
    });
    stateSeg.appendChild(opt);
  }

  renderToolsPane(app);
}

async function importBoardFile(file: File | undefined): Promise<void> {
  if (!file) return;
  try {
    const res = await fetch("/api/boards/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await file.text(),
    });
    const body = (await res.json()) as { board_id?: string; name?: string; error?: string };
    if (!res.ok || !body.board_id) throw new Error(body.error ?? `server returned ${res.status}`);
    toast(`imported "${body.name}" — opening it`);
    location.href = `/?board=${encodeURIComponent(body.board_id)}`;
  } catch (err) {
    toast(`import failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

let toastTimer: number | null = null;
export function toast(text: string, isError = false): void {
  const t = el("toast");
  t.textContent = text;
  t.classList.toggle("error", isError);
  t.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.hidden = true;
  }, 6000);
}

export function switchTab(app: App, tab: Tab): void {
  app.tab = tab;
  for (const input of el("tabs").querySelectorAll("input")) {
    input.checked = input.value === tab;
  }
  app.render();
}

async function downloadScreenshot(app: App): Promise<void> {
  app.flash();
  const blob = await captureBoard(app, null, false);
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `inkwire-${app.boardId}.png`;
  a.click();
  URL.revokeObjectURL(a.href);
}

let inspectorKey = "";

export function renderPanel(app: App): void {
  const push = app.push;

  // Header state.
  for (const input of el("toolseg").querySelectorAll("input")) {
    input.checked = input.value === app.tool;
  }
  const canUndo = (push?.state.history.head ?? 0) > 0;
  const canRedo = (push?.state.history.ahead ?? 0) > 0 || (push?.state.history.skipped ?? 0) > 0;
  el("btn-undo").style.color = canUndo ? "var(--color-text)" : "var(--color-neutral-400)";
  el("btn-redo").style.color = canRedo ? "var(--color-text)" : "var(--color-neutral-400)";

  renderInspector(app);

  for (const [id] of TABS) {
    el(`pane-${id}`).hidden = app.tab !== id;
  }
  if (app.tab === "layers") renderLayers(app);
  if (app.tab === "session") renderSession(app);
  if (app.tab === "history") renderHistory(app);
  if (app.tab === "state") renderState(app);

  renderFooter(app);
}

function renderInspector(app: App): void {
  const box = el("inspector");
  const state = app.push?.state;
  const sel = app.sel;
  if (!sel || !state) {
    box.hidden = true;
    inspectorKey = "";
    return;
  }
  const key = `${sel.type}:${sel.id}`;
  // Never rebuild under the user's caret.
  if (key === inspectorKey && box.contains(document.activeElement)) return;

  const node = sel.type === "node" ? state.graph.nodes.find((n) => n.id === sel.id) : undefined;
  const edge = sel.type === "edge" ? state.graph.edges.find((e) => e.id === sel.id) : undefined;
  const image = sel.type === "image" ? state.images.find((i) => i.id === sel.id) : undefined;
  if (!node && !edge && !image) {
    box.hidden = true;
    inspectorKey = "";
    return;
  }
  inspectorKey = key;
  box.hidden = false;
  box.replaceChildren();

  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<span class="type"></span><span class="id"></span>`;
  (head.children[0] as HTMLElement).textContent = sel.type.toUpperCase();
  (head.children[1] as HTMLElement).textContent = sel.id;
  box.appendChild(head);

  const field = (labelText: string, value: string, mono: boolean, placeholder: string, onCommit: (v: string) => void) => {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("input");
    input.className = mono ? "input mono" : "input";
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener("change", () => onCommit(input.value));
    label.append(span, input);
    box.appendChild(label);
  };

  if (node) {
    field("label", node.label, false, "", (v) =>
      app.send({ type: "update_node", node_id: node.id, label: v, field: "label" }),
    );
    const seg = document.createElement("div");
    seg.className = "seg kind-seg";
    for (const kind of NODE_KINDS) {
      const opt = document.createElement("label");
      opt.className = "seg-opt";
      opt.innerHTML = `<input type="radio" name="kind"><span>${KIND_META[kind].label}</span>`;
      const input = opt.querySelector("input")!;
      input.checked = node.kind === kind;
      input.addEventListener("change", () => app.send({ type: "update_node", node_id: node.id, kind }));
      seg.appendChild(opt);
    }
    box.appendChild(seg);
    field("code ref — file/function", node.ref ?? "", true, "svc/orders/handler.ts:serve", (v) =>
      app.send({ type: "update_node", node_id: node.id, ref: v || null, field: "ref" }),
    );
    field("endpoint", node.endpoint ?? "", true, "GET /v2/orders/:id", (v) =>
      app.send({ type: "update_node", node_id: node.id, endpoint: v || null, field: "endpoint" }),
    );
  }

  if (edge) {
    field("label", edge.label ?? "", false, "miss", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, label: v || null, field: "label" }),
    );
    const seg = document.createElement("div");
    seg.className = "seg kind-seg";
    for (const kind of EDGE_KINDS) {
      const opt = document.createElement("label");
      opt.className = "seg-opt";
      opt.innerHTML = `<input type="radio" name="edgekind"><span>${kind.toUpperCase()}</span>`;
      const input = opt.querySelector("input")!;
      input.checked = edge.kind === kind;
      input.addEventListener("change", () => app.send({ type: "update_edge", edge_id: edge.id, kind }));
      seg.appendChild(opt);
    }
    box.appendChild(seg);
    field("condition — branch predicate", edge.condition ?? "", true, "cache miss", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, condition: v || null, field: "condition" }),
    );
    field("payload schema", edge.schema ?? "", true, "OrderDTO", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, schema: v || null, field: "schema" }),
    );
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const copy = document.createElement("button");
  copy.className = "btn btn-secondary";
  copy.style.flex = "1";
  copy.textContent = "copy id for claude";
  copy.addEventListener("click", () => {
    const name = node?.label ?? edge?.label ?? sel.id;
    void navigator.clipboard.writeText(`${sel.id} (${name})`);
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = "copy id for claude"), 1200);
  });
  const del = document.createElement("button");
  del.className = "btn btn-secondary";
  del.textContent = "delete";
  del.addEventListener("click", () => deleteSelection(app));
  actions.append(copy, del);
  box.appendChild(actions);
}

function renderHistory(app: App): void {
  const pane = el("pane-history");
  pane.replaceChildren();
  const push = app.push;
  if (!push) return;

  const scopeWrap = document.createElement("div");
  scopeWrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const scopeLabel = document.createElement("span");
  scopeLabel.className = "pane-note";
  scopeLabel.textContent = "UNDO SCOPE — what ⌘Z acts on";
  const seg = document.createElement("div");
  seg.className = "seg";
  seg.style.width = "100%";
  for (const [id, label] of SCOPES) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.style.cssText = "flex:1;justify-content:center;padding:6px 4px;font-family:var(--font-mono);font-size:10.5px";
    opt.innerHTML = `<input type="radio" name="scope"><span>${label}</span>`;
    const input = opt.querySelector("input")!;
    input.checked = app.scope === id;
    input.addEventListener("change", () => {
      app.scope = id;
      app.render();
    });
    seg.appendChild(opt);
  }
  scopeWrap.append(scopeLabel, seg);
  pane.appendChild(scopeWrap);

  const note = document.createElement("div");
  note.className = "pane-note";
  note.style.letterSpacing = "0";
  note.textContent =
    push.state.history.edges_pruned > 0
      ? `${push.state.history.edges_pruned} edge(s) dropped as dangling — the step that orphaned them is flagged conflict below.`
      : SCOPE_NOTES[app.scope];
  pane.appendChild(note);

  const rows = [...push.history].reverse();
  const head = push.state.history.head;
  for (const row of rows) {
    const card = document.createElement("div");
    const classes = ["card", "hist-card"];
    if (row.index === head) classes.push("head");
    if (row.conflict) classes.push("conflict");
    if (row.ahead) classes.push("ahead");
    if (row.skipped) classes.push("skipped");
    card.className = classes.join(" ");
    card.title = row.ahead ? "click to replay forward to this step" : "click to rewind the canvas to this step";
    card.addEventListener("click", () => app.send({ type: "history", action: "rewind", index: row.index, scope: app.scope }));

    const meta = document.createElement("div");
    meta.className = "meta";
    const step = document.createElement("span");
    step.className = "step";
    step.textContent = String(row.index).padStart(2, "0");
    const by = document.createElement("span");
    by.textContent = row.author === "ai" ? "claude" : "you";
    by.style.color = row.author === "ai" ? "var(--color-accent-700)" : "var(--color-neutral-600)";
    const marker = document.createElement("span");
    marker.className = "marker";
    marker.textContent = row.conflict ? "conflict" : row.index === head ? "◆ head" : row.ahead ? "ahead" : row.skipped ? "skipped" : "";
    meta.append(step, by, marker);

    const line = document.createElement("div");
    line.className = "row";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = row.label;
    line.appendChild(label);
    if (!row.ahead) {
      const skip = document.createElement("button");
      skip.className = "btn btn-ghost";
      skip.title = "revert just this step, keeping the record";
      skip.textContent = row.skipped ? "restore" : "skip";
      skip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        app.send({ type: "history", action: "skip", index: row.index, scope: app.scope });
      });
      line.appendChild(skip);
    }
    const drop = document.createElement("button");
    drop.className = "btn btn-ghost";
    drop.title = "delete this step from the history";
    drop.style.color = "var(--color-neutral-600)";
    drop.textContent = "drop";
    drop.addEventListener("click", (ev) => {
      ev.stopPropagation();
      app.send({ type: "history", action: "drop", index: row.index, scope: app.scope });
    });
    line.appendChild(drop);

    card.append(meta, line);
    pane.appendChild(card);
  }

  const base = document.createElement("div");
  base.className = "card hist-card" + (head === 0 ? " head" : "");
  base.title = "click to rewind to the opened board";
  base.addEventListener("click", () => app.send({ type: "history", action: "rewind", index: 0, scope: app.scope }));
  base.innerHTML = `<div class="meta"><span class="step">00</span><span style="color: var(--color-neutral-600)">base</span><span class="marker">${head === 0 ? "◆ head" : ""}</span></div><div class="row"><div class="label">board opened</div></div>`;
  pane.appendChild(base);
}

function renderLayers(app: App): void {
  const pane = el("pane-layers");
  // Never rebuild under the user's caret (the title input).
  if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text" && pane.contains(document.activeElement)) return;
  pane.replaceChildren();
  const state = app.push?.state;
  if (!state) return;

  const note = document.createElement("div");
  note.className = "pane-note";
  note.innerHTML = "LAYERS · cut by the AI, focused by you<br>a layer is a view over the board — deleting one deletes nothing";
  const rim = document.createElement("label");
  rim.className = "pane-note";
  rim.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
  rim.innerHTML = `<input type="checkbox"><span>rim · show neighbours</span>`;
  const rimInput = rim.querySelector("input")!;
  rimInput.checked = app.rim;
  rimInput.addEventListener("change", () => {
    app.rim = rimInput.checked;
    savePanelPrefs(app);
    app.render();
  });
  const dim = document.createElement("label");
  dim.className = "pane-note";
  dim.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
  dim.innerHTML = `<input type="checkbox"><span>dim · outside a highlight</span>`;
  const dimInput = dim.querySelector("input")!;
  dimInput.checked = app.dim;
  dimInput.addEventListener("change", () => {
    app.dim = dimInput.checked;
    savePanelPrefs(app);
    app.render();
  });
  pane.append(note, rim, dim);

  for (const layer of state.layers) {
    const members = liveMembers(layer, state.graph.nodes);
    const edges = state.graph.edges.filter((e) => members.has(e.from) && members.has(e.to)).length;
    const on = layer.id === state.focus;
    const card = document.createElement("div");
    card.className = on ? "card layer-card on" : "card layer-card";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span class="letter"></span><span></span><span class="by"></span>`;
    (meta.children[0] as HTMLElement).textContent = layer.letter;
    (meta.children[1] as HTMLElement).textContent = `${members.size} elements · ${edges} edges`;
    (meta.children[2] as HTMLElement).textContent = layer.author;

    const title = document.createElement("input");
    title.className = "input";
    title.maxLength = 24;
    title.value = layer.title;
    title.addEventListener("change", () => app.send({ type: "layers_update", layer_id: layer.id, title: title.value }));

    const body = document.createElement("div");
    body.className = "note";
    body.textContent = layer.note;

    const actions = document.createElement("div");
    actions.className = "actions";
    const focus = document.createElement("button");
    focus.className = "btn btn-secondary";
    focus.textContent = on ? "release" : "focus";
    focus.addEventListener("click", () => focusLayer(app, on ? null : layer.id));
    const del = document.createElement("button");
    del.className = "btn btn-ghost";
    del.textContent = "delete";
    del.addEventListener("click", () => app.send({ type: "layers_delete", layer_id: layer.id }));
    actions.append(focus, del);

    card.append(meta, title, body, actions);
    pane.appendChild(card);
  }
}

function renderState(app: App): void {
  const push = app.push;
  if (!push) return;
  // Scoped = what canvas.get_state returns while a layer is focused; board = canvas.get_board.
  const focused = focusedLayer(app);
  const scoped = focused !== null && app.stateView === "scoped";
  el("stateseg").style.display = focused ? "" : "none";
  for (const input of el("stateseg").querySelectorAll("input")) {
    input.checked = (input.nextElementSibling?.textContent ?? "") === app.stateView;
  }
  el("statenote").innerHTML = scoped
    ? `RESPONSE · canvas.get_state — scoped to ${focused.letter}<br>members, internal edges, and the seams; scope.omitted says what it left out`
    : `RESPONSE · ${focused ? "canvas.get_board — the whole board regardless of focus" : "canvas.get_state — no layer focused"}<br>graph and layout revision independently — moving a box does not change the graph`;
  const state = scoped ? scopeState(push.state, focused) : push.state;
  // Show the default get_state shape: point counts, not polylines.
  const display = {
    ...state,
    ink: state.ink.map(({ geometry, ...rest }) => ({
      ...rest,
      points: geometry?.length ?? rest.points ?? 0,
    })),
  };
  el("statejson").textContent = JSON.stringify(display, null, 1);
}

function renderToolsPane(app: App): void {
  const pane = el("pane-tools");
  pane.replaceChildren();
  for (const [name, desc, args, run] of MCP_TOOLS) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<span class="name"></span><span class="desc"></span><span class="args"></span>`;
    (info.children[0] as HTMLElement).textContent = name;
    (info.children[1] as HTMLElement).textContent = desc;
    (info.children[2] as HTMLElement).textContent = args;
    row.appendChild(info);
    if (run) {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.textContent = "run";
      btn.addEventListener("click", () => run(app));
      row.appendChild(btn);
    }
    pane.appendChild(row);
  }
}

function renderFooter(app: App): void {
  const push = app.push;
  const conn = el("conn");
  conn.className = app.connected ? "conn" : "conn off";
  conn.textContent = app.connected ? `● mcp connected · ${MCP_TOOLS.length} tools` : "○ reconnecting…";
  const mode = el("modenote");
  const inkwire = push?.session.mode === "inkwire";
  mode.textContent = inkwire ? "mode inkwire · pty muted" : "mode pty";
  mode.style.color = inkwire ? "var(--color-accent-700)" : "var(--color-neutral-600)";
  if (push) {
    const s = push.state;
    el("counts").textContent = `${s.graph.nodes.length} nodes · ${s.graph.edges.length} edges · ${s.ink.length} ink`;
    el("histnote").textContent =
      `step ${s.history.head}/${s.history.steps}` +
      (s.history.skipped ? ` · ${s.history.skipped} skipped` : "") +
      ` · scope ${app.scope === "human" ? "you" : app.scope === "ai" ? "claude" : "all"}`;
    el("inknote").textContent = s.ink.length
      ? `${s.ink.length} strokes awaiting infer_structure`
      : "all ink resolved";
  }
  el("zoom").textContent = `zoom ${Math.round(app.view.zoom * 100)}%`;
}

export function fmtTime(at: number): string {
  const t = new Date(at);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
