// Right panel (inspector + four tabs), header controls, and the footer.
import { captureBoard } from "./capture.js";
import { deleteSelection, togglePlay, traceInfo } from "./canvas.js";
import type { App, Scope, Tab, Tool } from "./app.js";
import { KIND_META, el, focusLayer, focusedLayer } from "./app.js";
import { liveMembers, scopeState } from "../core/layers.js";
import { markCounts } from "../core/drafts.js";
import { NODE_KINDS, EDGE_KINDS, DRAFT_ROLES } from "../shared/types.js";
import type { DraftRole, NodeKind } from "../shared/types.js";
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
  ["drafts", "DRAFTS"],
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
  ["session.send", "Deliver a reply to the Session tab, optionally pointing at elements, at a path (or a hop on it), or at a draft. Blocks until the human replies (20 min timeout) and returns their message with focus, selection, scrubber position, active draft and revision as ids.", "(text, highlight?: { nodes, edges, label }, path?: { layer_id, path_id, hop? }, draft?: string) → { reply, ctx } | { status: mode_off | idle }", (app) => switchTab(app, "session")],
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
  ["layers.update", "Add or remove members, retitle, or rewrite the note. Elements themselves are untouched.", "(layer_id, add?, remove?, title?, note?) → { layer_id, members, paths_affected }", null as never],
  ["layers.focus", "Focus a layer in the human's viewport, or pass null to release. It moves someone else's screen.", "(layer_id | null) → { ok }", (app) => focusLayer(app, app.push?.state.focus ? null : (app.push?.state.layers[0]?.id ?? null))],
  ["layers.delete", "Remove a layer. A layer is a view over the board, so nothing on the board is deleted.", "(layer_id) → { ok }", null as never],
  ["paths.create", "Write an ordered walk on a layer: one hop per edge, each hop's to is the next hop's from, every edge inside the layer. Pass nodes and the server resolves the edges, naming both when a pair is joined twice. A caption per hop is what the human reads while it plays; a ref per hop is its citation. Fails naming the first hop that breaks the chain.", "(layer_id, title, steps? | nodes? + captions? + refs?, extend_layer?) → { path_id, hops, nodes, layer_extended }", null as never],
  ["paths.update", "Retitle, or replace the steps whole. Steps are set as a list, never patched by index.", "(path_id, title?, steps?) → { path_id, hops }", null as never],
  ["paths.delete", "Remove a path. The layer and the board are untouched.", "(path_id) → { ok }", null as never],
  ["paths.get", "One path with its hops resolved: node labels, refs, edge labels, captions. Small — use it to answer about a hop instead of reading the board.", "(path_id) → { path_id, layer_id, title, hops }", null as never],
  ["paths.play", "Open the scrubber on a path in the human's panel: play it once, or pause at a hop. Moves someone else's screen — use when the reply is about the order.", "(path_id, hop?) → { ok }", (app) => {
    const first = app.push?.state.layers.flatMap((l) => l.paths)[0];
    if (first) app.send({ type: "trace_set", path_id: first.id });
    else toast("no path on this board — ask claude for paths_create");
  }],
  ["drafts.create", "Propose a change: a title, a note saying what and why, and marks — element ids with one of removed, changed, added. A draft changes nothing on the board; it says what would. Marks are explicit: mark the edges you mean, the server infers none.", "(title?, note?, marks?: [{ id, role }]) → { draft_id, marks }", (app) => app.send({ type: "drafts_create" })],
  ["drafts.update", "Retitle, rewrite the note, mark or unmark elements. Marking again replaces the role.", "(draft_id, title?, note?, mark?: [{ id, role }], unmark?: string[]) → { draft_id, marks }", null as never],
  ["drafts.delete", "Remove a draft. The board is untouched.", "(draft_id) → { ok }", null as never],
  ["drafts.get", "One draft with its marks resolved to labels. Small — use it to answer about a mark instead of reading the board.", "(draft_id) → { draft_id, title, note, marks: [{ id, role, label, kind | edge: { from, to } }] }", null as never],
  ["drafts.activate", "Show a draft on the human's canvas, or pass null to clear. Shared by every panel; it changes what someone else is looking at.", "(draft_id | null) → { ok }", (app) => app.send({ type: "drafts_activate", draft_id: app.push?.state.active_draft ? null : (app.push?.state.drafts[0]?.id ?? null) })],
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
  if (app.tab === "drafts") renderDrafts(app);
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
  const type = document.createElement("span");
  type.className = "type";
  type.textContent = sel.type.toUpperCase();
  // The id is the copy button — click it to put the id on the clipboard for Claude.
  const idBtn = document.createElement("button");
  idBtn.className = "id";
  idBtn.textContent = sel.id;
  idBtn.title = "copy id for claude";
  idBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(sel.id);
    idBtn.textContent = "Copied";
    setTimeout(() => (idBtn.textContent = sel.id), 2000);
  });
  const del = document.createElement("button");
  del.className = "btn btn-ghost del";
  del.textContent = "DELETE";
  del.addEventListener("click", () => deleteSelection(app));
  head.append(type, del, idBtn);
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

  /** A kind picker: the same labelled row as a field, with a native select. A
   * segmented row here read as tabs — it looked like #tabs one panel down. */
  const picker = <T extends string>(labelText: string, kinds: readonly T[], value: T, onCommit: (v: T) => void) => {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("select");
    input.className = "input mono";
    for (const kind of kinds) {
      const opt = document.createElement("option");
      opt.value = kind;
      opt.textContent = KIND_META[kind as NodeKind]?.label ?? kind.toUpperCase();
      input.appendChild(opt);
    }
    input.value = value;
    input.addEventListener("change", () => onCommit(input.value as T));
    label.append(span, input);
    box.appendChild(label);
  };

  if (node) {
    field("label", node.label, false, "", (v) =>
      app.send({ type: "update_node", node_id: node.id, label: v, field: "label" }),
    );
    picker("kind", NODE_KINDS, node.kind, (kind) =>
      app.send({ type: "update_node", node_id: node.id, kind }),
    );
    field("code ref — file/function", node.ref ?? "", true, "svc/orders/handler.ts:serve", (v) =>
      app.send({ type: "update_node", node_id: node.id, ref: v || null, field: "ref" }),
    );
    // ponytail: the endpoint row shows only when the node has one — an empty row
    // read as data. Set it from Claude (canvas_update_node) or clear it here.
    if (node.endpoint) {
      field("endpoint", node.endpoint, true, "", (v) =>
        app.send({ type: "update_node", node_id: node.id, endpoint: v || null, field: "endpoint" }),
      );
    }
  }

  if (edge) {
    field("label", edge.label ?? "", false, "miss", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, label: v || null, field: "label" }),
    );
    picker("kind", EDGE_KINDS, edge.kind, (kind) =>
      app.send({ type: "update_edge", edge_id: edge.id, kind }),
    );
    field("condition — branch predicate", edge.condition ?? "", true, "cache miss", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, condition: v || null, field: "condition" }),
    );
    field("payload schema", edge.schema ?? "", true, "OrderDTO", (v) =>
      app.send({ type: "update_edge", edge_id: edge.id, schema: v || null, field: "schema" }),
    );
  }

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

    const paths = document.createElement("div");
    paths.className = "paths";
    if (layer.paths.length) {
      const kicker = document.createElement("span");
      kicker.className = "kicker";
      kicker.textContent = "PATHS · one hop per edge, in order";
      paths.appendChild(kicker);
      const tr = traceInfo(app);
      for (const p of layer.paths) {
        const playing = tr?.path.id === p.id;
        const row = document.createElement("div");
        row.className = playing ? "path-row on" : "path-row";
        row.innerHTML = `<button class="play" title="play — opens the scrubber"></button><span class="id"></span><span class="title"></span><span class="hops"></span>`;
        (row.children[0] as HTMLElement).textContent = playing && tr.running ? "❚❚" : "▸";
        (row.children[1] as HTMLElement).textContent = p.id;
        (row.children[2] as HTMLElement).textContent = p.title;
        (row.children[3] as HTMLElement).textContent = `${p.steps.length} hops`;
        row.children[0]!.addEventListener("click", () => (playing ? togglePlay(app) : app.send({ type: "trace_set", path_id: p.id })));
        paths.appendChild(row);
      }
    }

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

    card.append(meta, title, body, paths, actions);
    pane.appendChild(card);
  }
}

function renderDrafts(app: App): void {
  const pane = el("pane-drafts");
  const state = app.push?.state;
  // Never rebuild under the user's caret (the title input or the note textarea) —
  // unless its card's draft is already gone, in which case it's wired to a dead
  // id and must be rebuilt anyway.
  const focused = document.activeElement;
  if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && pane.contains(focused)) {
    const cardId = focused.closest<HTMLElement>(".draft-card")?.dataset.id;
    if (cardId !== undefined && state?.drafts.some((d) => d.id === cardId)) return;
  }
  pane.replaceChildren();
  if (!state) return;

  const note = document.createElement("div");
  note.className = "pane-note";
  note.innerHTML = "DRAFTS · a proposed change and what it touches<br>marks are explicit — a draft changes nothing on the board";
  pane.appendChild(note);

  const newDraft = document.createElement("button");
  newDraft.className = "btn btn-secondary";
  newDraft.style.width = "100%";
  newDraft.textContent = "new draft";
  newDraft.addEventListener("click", () => app.send({ type: "drafts_create" }));
  pane.appendChild(newDraft);

  for (const draft of state.drafts) {
    const on = draft.id === state.active_draft;
    const counts = markCounts(draft, state.graph.nodes, state.graph.edges);
    const total = counts.removed + counts.changed + counts.added;
    const card = document.createElement("div");
    card.className = on ? "card draft-card on" : "card draft-card";
    card.dataset.id = draft.id;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span class="id"></span><span></span><span class="by"></span>`;
    (meta.children[0] as HTMLElement).textContent = draft.id;
    (meta.children[1] as HTMLElement).textContent = `${total} mark${total === 1 ? "" : "s"}`;
    (meta.children[2] as HTMLElement).textContent = draft.author;

    const title = document.createElement("input");
    title.className = "input";
    title.maxLength = 24;
    title.value = draft.title;
    title.addEventListener("change", () => app.send({ type: "drafts_update", draft_id: draft.id, title: title.value }));

    const noteField = document.createElement("textarea");
    noteField.className = "input";
    noteField.rows = 3;
    noteField.placeholder = "what the change is and why";
    noteField.value = draft.note;
    noteField.addEventListener("change", () => app.send({ type: "drafts_update", draft_id: draft.id, note: noteField.value }));

    const marks = document.createElement("div");
    marks.className = "marks";
    for (const role of DRAFT_ROLES) {
      const entries = (Object.entries(draft.marks) as [string, DraftRole][]).filter(([, r]) => r === role);
      if (entries.length === 0) continue;
      const kicker = document.createElement("span");
      kicker.className = "kicker";
      kicker.dataset.role = role;
      kicker.textContent = `${role.toUpperCase()} · ${counts[role]}`;
      marks.appendChild(kicker);
      for (const [id] of entries) {
        const node = state.graph.nodes.find((n) => n.id === id);
        const edge = node ? undefined : state.graph.edges.find((e) => e.id === id);
        const gone = !node && !edge;
        const row = document.createElement("div");
        row.className = "mark-row";
        if (gone) row.style.opacity = "0.5";
        row.innerHTML = `<span class="id"></span><span class="label"></span><button class="unmark" title="clear mark">✕</button>`;
        (row.children[0] as HTMLElement).textContent = id;
        (row.children[1] as HTMLElement).textContent = gone ? "gone" : (node?.label ?? edge?.label ?? "edge");
        row.children[2]!.addEventListener("click", () => app.send({ type: "drafts_mark", draft_id: draft.id, id, role: null }));
        marks.appendChild(row);
      }
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const activate = document.createElement("button");
    activate.className = "btn btn-secondary";
    activate.textContent = on ? "deactivate" : "activate";
    activate.addEventListener("click", () => app.send({ type: "drafts_activate", draft_id: on ? null : draft.id }));
    const del = document.createElement("button");
    del.className = "btn btn-ghost";
    del.textContent = "delete";
    del.addEventListener("click", () => app.send({ type: "drafts_delete", draft_id: draft.id }));
    actions.append(activate, del);

    card.append(meta, title, noteField, marks, actions);
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
