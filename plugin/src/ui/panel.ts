// Right panel (inspector + the tab strip and its panes), header controls, and the footer.
import { captureBoard } from "./capture.ts";
import { abortHold, beginHold, deleteSelection, holdFired, renderWalk, startPeek, togglePlay, traceInfo } from "./canvas.ts";
import type { App, Scope, Tab, Tool } from "./app.ts";
import { KIND_META, el, focusLayer, focusedLayer, notebookOpen } from "./app.ts";
import { liveMembers, scopeState } from "../core/layers.ts";
import { markCounts } from "../core/drafts.ts";
import { NODE_KINDS, EDGE_KINDS, DRAFT_ROLES } from "../shared/types.ts";
import type { DraftRole, NodeKind } from "../shared/types.ts";
import { clientLabel, renderSession, stripView } from "./session.ts";
import type { DaemonPush } from "../shared/protocol.ts";
import { importNeedsRoot } from "../shared/import-root.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";

const TOOLS: [Tool, string, string, IconName][] = [
  ["select", "select", "V", "select"],
  ["pen", "pen", "P", "pen"],
  ["box", "node", "B", "node"],
  ["arrow", "edge", "A", "edge"],
  ["text", "text", "T", "text"],
  ["erase", "erase", "E", "erase"],
];

const TABS: [Tab, string][] = [
  ["layers", "LAYERS"],
  ["drafts", "DRAFTS"],
  ["session", "SESSION"],
  ["history", "HISTORY"],
  ["state", "STATE"],
  ["tools", "TOOLS"],
  ["notebook", "NOTEBOOK"],
];
const TAB_IDS = TABS.map(([id]) => id);

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
  ["session.mode", "Set your session mode. The flag is per Claude Code session. On: fails unless a hook event was seen, the permission mode is auto or bypassPermissions, and CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS is 0 (the last two are not needed while the inkwire mod runs in Claude Code); fails when no board is open, fails when another Claude Code session is the author of your current board or the person released you from it, and fails in inkwire mode for a board other than the one you talk on; on a board with no author, it makes you the author. On arms the Stop hook that sends replies to session_send. Off: releases your pending session_send with mode_off.", "(on: boolean) → { mode, hook }", (app) => switchTab(app, "session")],
  ["session.send", "Deliver a reply to the Session tab, optionally pointing at elements, at a path (or a hop on it), at a draft, or at a notebook. Blocks until the human replies (20 min timeout) and returns their message with focus, selection, scrubber position, active draft and revision as ids. While the inkwire mod runs in Claude Code, it returns delivered at once: end your turn, and the reply comes as your next prompt with an `inkwire ctx:` line.", "(text, highlight?: { nodes, edges, label }, path?: { layer_id, path_id, hop? }, draft?: string, notebook?: string) → { reply, ctx } | { status: mode_off | idle | delivered }", (app) => switchTab(app, "session")],
  ["boards.list", "Boards whose project root overlaps the caller's cwd, plus boards with root: unset. all: true lists every board.", "(all?) → { boards }", null as never],
  ["boards.open", "Return the state of a board. If you are not the author of a board, the board also becomes your current board. If you are the author of a board, your current board does not change (it is always the board you author). Opening never claims or releases authorship. If the board is already open, its in-memory history and revision counters stay. A board that is not open yet starts at step 0. The result names the panel URL.", "(board_id) → CanvasState", null as never],
  ["boards.create", "New empty board; the caller becomes its author and stops being the author of its earlier board. Fails in inkwire mode. project_root is the checkout that every code ref on the board resolves against.", "(name, project_root) → { board_id, name_check | warning }", null as never],
  ["boards.clone", "Copy a board into a new board at step 0; the caller becomes its author and stops being the author of its earlier board. Any session can clone a board it can read. Fails in inkwire mode. The root is the source's root unless you give one.", "(board_id, name?, project_root?) → { board_id, name_check | warning }", null as never],
  ["boards.delete", "Delete a board permanently. Only the author can delete a board, or any session while the board has no author. Deleting does not make the caller the author.", "(board_id) → { deleted }", null as never],
  ["boards.update", "Rename a board or set its project root. Only the author can do this; on a board with no author, it makes the caller the author. Not a history step.", "(board_id, name?, project_root?) → { board_id, name, project_root }", null as never],
  ["boards.import", "Load a downloaded board file from disk into a new board; the caller becomes its author and stops being the author of its earlier board. Fails in inkwire mode. The root is project_root, else the file's root when it exists here.", "(path, project_root?) → { board_id, name_check | warning }", null as never],
  ["boards.release", "Stop being the author of a board: the given board, else the board the caller authors. Fails when the caller is not its author. In inkwire mode, the mode goes off.", "(board_id?) → { released }", null as never],
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
  ["canvas.bind_code", "Attach a file/function or endpoint to a node — validated against the board's project root.", "(node_id, ref | endpoint)", null as never],
  ["canvas.annotate", "Write a comment about an element — a missing case, an unhandled error path. It lands in the board's notes notebook as a paragraph refbacked to the element, not on the canvas.", "(target_id, text) → { notebook_id, target_id }", null as never],
  ["canvas.set_viewport", "Pan and zoom so the human sees what you mean.", "(x, y, zoom)", null as never],
  ["canvas.export_mermaid", "Serialise the graph as text for the transcript.", "() → string", null as never],
  ["canvas.lint", "Static checks against the board's project root: missing refs, unbound nodes, edge shape.", "() → findings", null as never],
  ["history.get", "Read the timeline: steps, authors, conflicts. Read-only.", "(limit?) → { head, steps }", null as never],
  ["layers.list", "Every layer with its letter, title, member count — and which one the human is looking at.", "() → { focus, layers }", (app) => switchTab(app, "layers")],
  ["layers.create", "Cut a named subset out of the board. downstream: true also adds everything reachable along edges.", "(node_ids, title?, note?, downstream?) → { layer_id, letter, members }", null as never],
  ["layers.update", "Add or remove members, retitle, or rewrite the note. Elements themselves are untouched.", "(layer_id, add?, remove?, title?, note?) → { layer_id, members, paths_affected }", null as never],
  ["layers.focus", "Focus a layer in the human's viewport, or pass null to release. It moves someone else's screen.", "(layer_id | null) → { ok }", (app) => focusLayer(app, app.push?.state.focus ? null : (app.push?.state.layers[0]?.id ?? null))],
  ["layers.delete", "Remove a layer. A layer is a view over the board, so nothing on the board is deleted.", "(layer_id) → { ok }", null as never],
  ["paths.create", "Write an ordered walk on a layer: one hop per edge, each hop's to is the next hop's from, every edge inside the layer. Pass nodes and the server resolves the edges, naming both when a pair is joined twice. A caption per hop is what the human reads while it plays; a ref per hop is its citation. Fails naming the first hop that breaks the chain.", "(layer_id, title, steps? | nodes? + captions? + refs?, extend_layer?) → { path_id, hops, nodes, layer_extended }", null as never],
  ["paths.update", "Retitle, or replace the steps whole. Steps are set as a list, never patched by index.", "(path_id, title?, steps?, verify?) → { path_id, hops }", null as never],
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
  ["notebooks.create", "Write a notebook on this board: markdown, with [[id]] refs to nodes, edges, layers, paths and drafts. Refs resolve when the human reads it — write the id, not the label.", "(title, body?) → { notebook_id }", (app) => app.send({ type: "notebooks_create" })],
  ["notebooks.update", "Retitle, replace the body, or append to it. Append is last write wins; a human mid-edit is warned, not blocked.", "(notebook_id, title?, body?, append?) → { notebook_id, updated }", null as never],
  ["notebooks.delete", "Remove a notebook. The board is untouched.", "(notebook_id) → { ok }", null as never],
  ["notebooks.get", "One notebook with every [[id]] ref resolved to its label — and named as gone when the element no longer exists.", "(notebook_id) → { notebook_id, title, body }", null as never],
  ["notebooks.open", "Show a notebook in the human's pane, or pass null to close it. Shared by every panel; it changes what someone else is reading.", "(notebook_id | null) → { ok }", (app) => app.send({ type: "notebooks_open", notebook_id: app.push?.state.active_notebook ? null : (app.push?.state.notebooks[0]?.id ?? null) })],
];

const PANEL_KEY = "inkwire.panel";
const PANEL_DEFAULT_WIDTH = 372;
const clampPanelWidth = (w: number): number => Math.min(720, Math.max(260, Math.round(w)));
// The tab order of each board, keyed by board id: each board needs other tabs first.
const TAB_ORDER_KEY = "inkwire.tabs";

/** Side-panel prefs (plus the rim setting and the notebook's read/edit mode)
 * from localStorage; defaults when absent or unreadable. All live in this same blob. */
export function loadPanelPrefs(): App["panel"] & { rim: boolean; dim: boolean; notebook: App["notebook"] } {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { open?: unknown; width?: unknown; rim?: unknown; dim?: unknown; notebook?: { edit?: unknown } };
      return {
        open: p.open !== false,
        width: clampPanelWidth(Number(p.width) || PANEL_DEFAULT_WIDTH),
        rim: p.rim !== false,
        dim: p.dim !== false,
        notebook: { edit: p.notebook?.edit === true },
      };
    }
  } catch {
    // storage unavailable — fall through to defaults
  }
  return { open: true, width: PANEL_DEFAULT_WIDTH, rim: true, dim: true, notebook: { edit: false } };
}

export function savePanelPrefs(app: App): void {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ ...app.panel, rim: app.rim, dim: app.dim, notebook: app.notebook }));
  } catch {
    // storage unavailable — prefs live for this page only
  }
}

/** This board's tab order: the stored order, without ids that are no longer tabs,
 * then any tab it does not name (a tab added after the order was saved) in TABS order. */
export function loadTabOrder(boardId: string): Tab[] {
  let stored: unknown[] = [];
  try {
    const all = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) ?? "{}") as Record<string, unknown>;
    if (Array.isArray(all[boardId])) stored = all[boardId];
  } catch {
    // storage unavailable or unreadable — the default order
  }
  const order = stored.filter((id, i): id is Tab => TAB_IDS.includes(id as Tab) && stored.indexOf(id) === i);
  return [...order, ...TAB_IDS.filter((id) => !order.includes(id))];
}

function saveTabOrder(app: App): void {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) ?? "{}") as Record<string, unknown>;
    all[app.boardId] = app.tabs.order;
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — the order lives for this page only
  }
}

/** One drag-to-resize handle for a left-edge, pointer-captured pane (the aside):
 * drag left grows the pane. */
export function bindResizer(
  handle: HTMLElement,
  getWidth: () => number,
  setWidth: (w: number) => void,
  clamp: (w: number) => number,
  onChange: () => void,
  onDone: () => void,
): void {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = getWidth();
    const move = (ev: PointerEvent) => {
      setWidth(clamp(startW + (startX - ev.clientX)));
      onChange();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onDone();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

export function applyPanel(app: App): void {
  el("app").classList.toggle("panel-closed", !app.panel.open);
  el("body").style.setProperty("--panel-w", `${app.panel.width}px`);
}

function setPanelOpen(app: App, open: boolean): void {
  app.panel.open = open;
  savePanelPrefs(app);
  applyPanel(app);
  app.render();
}

export function setupPanel(app: App): void {
  // Side panel: the arrow at the start of the tab strip closes it; a click anywhere
  // on the closed rail opens it. Drag-to-resize on its left edge.
  applyPanel(app);
  el("aside-rail").addEventListener("click", () => setPanelOpen(app, true));
  bindResizer(
    el("aside-resizer"),
    () => app.panel.width,
    (w) => (app.panel.width = w),
    clampPanelWidth,
    () => applyPanel(app),
    () => savePanelPrefs(app),
  );

  // Header: tool palette.
  const toolSeg = el("toolseg");
  for (const [id, label, key, glyph] of TOOLS) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.title = `${label} (${key})`;
    opt.innerHTML = `<input type="radio" name="tool" value="${id}">${icon(glyph)}<span>${label}</span><span class="keycap">${key}</span>`;
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

  // The settings menu on the brand: undo / redo, infer structure, screenshot / export / import, theme.
  setupAppMenu();

  // Undo / redo — they act through history intents, scoped.
  el("btn-undo").addEventListener("click", () => {
    app.send({ type: "history", action: "undo", scope: app.scope });
    closeAppMenu();
  });
  el("btn-redo").addEventListener("click", () => {
    app.send({ type: "history", action: "redo", scope: app.scope });
    closeAppMenu();
  });

  el("btn-screenshot").addEventListener("click", () => {
    closeAppMenu(); // before the capture, so the menu is not in the flash
    void downloadScreenshot(app);
  });

  // Board file export (a download the server names) and import (a new board).
  el("btn-export").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/boards/${encodeURIComponent(app.boardId)}/export`;
    a.download = ""; // filename comes from Content-Disposition
    document.body.appendChild(a);
    a.click();
    a.remove();
    closeAppMenu();
  });
  const importFile = el<HTMLInputElement>("import-file");
  el("btn-import").addEventListener("click", () => {
    importFile.value = "";
    importFile.click();
    closeAppMenu();
  });
  importFile.addEventListener("change", () => void importBoardFile(importFile.files?.[0]));
  el("btn-infer").addEventListener("click", () => {
    app.send({ type: "infer" });
    closeAppMenu();
  });
  el("btn-resetview").addEventListener("click", () => {
    app.view = { x: 40, y: 20, zoom: 1 };
    app.send({ type: "set_viewport", viewport: app.view });
    app.render();
  });

  // Tabs.
  renderTabStrip(app);

  // STATE tab: which payload to show while a layer is focused.
  const stateSeg = el("stateseg");
  for (const view of ["scoped", "board"] as const) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.style.cssText = "flex:1;justify-content:center;padding:6px 4px;font-family:var(--font-mono);font-size: var(--text-xs)";
    opt.innerHTML = `<input type="radio" name="stateview"><span>${view}</span>`;
    opt.querySelector("input")!.addEventListener("change", () => {
      app.stateView = view;
      app.render();
    });
    stateSeg.appendChild(opt);
  }

  renderToolsPane(app);
}

function setupAppMenu(): void {
  const btn = el("btn-menu");
  const menu = el("app-menu");
  btn.addEventListener("click", () => (menu.hidden ? openAppMenu() : closeAppMenu()));
  // Close on a click outside the menu and its button, or on Escape.
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !el("btn-menu").parentElement!.contains(e.target as Node)) closeAppMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeAppMenu();
  });
}

function openAppMenu(): void {
  el("app-menu").hidden = false;
  el("btn-menu").setAttribute("aria-expanded", "true");
}

function closeAppMenu(): void {
  el("app-menu").hidden = true;
  el("btn-menu").setAttribute("aria-expanded", "false");
}

async function importBoardFile(file: File | undefined): Promise<void> {
  if (!file) return;
  try {
    const text = await file.text();
    let root: string | null = null;
    let body: { board_id?: string; name?: string; error?: string; warning?: string };
    for (;;) {
      const query = root === null ? "" : `?project_root=${encodeURIComponent(root)}`;
      const res = await fetch(`/api/boards/import${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      body = (await res.json()) as typeof body;
      if (res.ok && body.board_id) break;
      // No usable root (an old file, or a root that is not on this machine): ask the person where the checkout is, then retry.
      if (importNeedsRoot(res.status, body.error)) {
        root = window.prompt(`${body.error}\n\nType the absolute path of that checkout on this machine:`, root ?? "");
        if (root === null) return;
        continue;
      }
      throw new Error(body.error ?? `server returned ${res.status}`);
    }
    toast(body.warning ?? `imported "${body.name}" — opening it`);
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

// A press held this long, then moved, unlocks the tab order and drags the tab.
const HOLD_MS = 400;
// A pointer must move this far before a press counts as a drag.
const DRAG_PX = 4;

/** Build the tab strip in this board's order, after the edge button. The edge button is
 * built once, so its arrow-to-lock change can animate. */
function renderTabStrip(app: App): void {
  const tabs = el("tabs");
  if (!tabs.querySelector(".panel-close")) tabs.appendChild(edgeButton(app));
  for (const o of tabs.querySelectorAll(".seg-opt")) o.remove();
  const labels = new Map(TABS);
  for (const id of app.tabs.order) {
    const opt = document.createElement("label");
    opt.className = "seg-opt";
    opt.dataset.tab = id;
    opt.title = `${labels.get(id)?.toLowerCase() ?? id} — hold, then drag to move the tab`;
    opt.innerHTML = `<input type="radio" name="tab" value="${id}"${id === app.tab ? " checked" : ""}><span></span>`;
    opt.querySelector("span")!.textContent = labels.get(id) ?? id;
    opt.querySelector("input")!.addEventListener("change", () => switchTab(app, id));
    bindTabDrag(app, opt, id);
    tabs.appendChild(opt);
  }
  setReorder(app, !app.tabs.locked);
}

/** The button at the start of the tab strip. Locked, it is the arrow that closes the panel;
 * while the tabs can move, it is a green open lock, and a click locks the order. */
function edgeButton(app: App): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "panel-close";
  btn.innerHTML = `<span class="morph arrow">${icon("chevron-right")}</span><span class="morph lock">${icon("unlock")}</span>`;
  btn.addEventListener("click", () => {
    if (app.tabs.locked) setPanelOpen(app, false);
    else setReorder(app, false);
  });
  return btn;
}

/** Turn tab reordering on or off: the edge button changes between arrow and lock (CSS animates it). */
function setReorder(app: App, on: boolean): void {
  app.tabs.locked = !on;
  const tabs = el("tabs");
  tabs.classList.toggle("unlocked", on);
  const btn = tabs.querySelector<HTMLElement>(".panel-close");
  if (btn) btn.title = on ? "tabs can move — click to lock the order" : "hide the side panel";
}

/** Drag one tab with the pointer. Locked, a press must be held for HOLD_MS before it moves:
 * that unlocks the order. Unlocked, a press that moves drags at once. A press that does not
 * move stays a click and selects the tab. */
function bindTabDrag(app: App, opt: HTMLElement, id: Tab): void {
  let dragged = false; // the last press was a drag: its click must not select the tab
  opt.addEventListener("click", (e) => {
    if (!dragged) return;
    dragged = false;
    e.preventDefault();
  });
  opt.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const tabs = el("tabs");
    const startX = e.clientX;
    const startY = e.clientY;
    const startAt = e.timeStamp;
    let dragging = false;
    // The held press shows that it is ready to move.
    const holdTimer = app.tabs.locked ? window.setTimeout(() => opt.classList.add("held"), HOLD_MS) : null;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
        if (app.tabs.locked) {
          if (ev.timeStamp - startAt < HOLD_MS) return end(); // a quick move is not a drag
          setReorder(app, true);
        }
        dragging = true;
        opt.setPointerCapture(ev.pointerId);
        opt.classList.add("dragging");
      }
      opt.style.transform = `translateX(${ev.clientX - startX}px)`;
      markDrop(tabs, opt, dropIndex(tabs, opt, ev.clientX));
    };
    const up = (ev: PointerEvent) => {
      if (dragging) {
        dragged = true;
        const order = app.tabs.order.filter((t) => t !== id);
        order.splice(dropIndex(tabs, opt, ev.clientX), 0, id);
        app.tabs.order = order;
        saveTabOrder(app);
        renderTabStrip(app);
      }
      end();
    };
    const end = () => {
      if (holdTimer !== null) window.clearTimeout(holdTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      opt.classList.remove("held", "dragging");
      opt.style.transform = "";
      markDrop(tabs, opt, null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
  });
}

/** Where the dragged tab lands: the number of other tabs whose middle is left of clientX. */
function dropIndex(tabs: HTMLElement, dragged: HTMLElement, clientX: number): number {
  let i = 0;
  for (const o of tabs.querySelectorAll<HTMLElement>(".seg-opt")) {
    if (o === dragged) continue;
    const r = o.getBoundingClientRect();
    if (clientX > r.left + r.width / 2) i++;
  }
  return i;
}

/** Show the drop line before the tab at index (after the last tab when index is the count); null clears it. */
function markDrop(tabs: HTMLElement, dragged: HTMLElement, index: number | null): void {
  const others = [...tabs.querySelectorAll<HTMLElement>(".seg-opt")].filter((o) => o !== dragged);
  others.forEach((o, i) => {
    o.classList.toggle("drop-before", index === i);
    o.classList.toggle("drop-after", index === others.length && i === others.length - 1);
  });
}

// The tab the person was on before the Notebook tab, for the N key and the notebook chip.
let tabBeforeNotebook: Tab = "layers";

/** Set the tab without rendering: the caller owns the render. */
export function setTab(app: App, tab: Tab): void {
  if (tab === "notebook" && app.tab !== "notebook") tabBeforeNotebook = app.tab;
  app.tab = tab;
  for (const input of el("tabs").querySelectorAll("input")) {
    input.checked = input.value === tab;
  }
}

export function switchTab(app: App, tab: Tab): void {
  setTab(app, tab);
  app.render();
}

/** Show the notebook (open the side panel on the Notebook tab), or close it (go back to
 * the tab before it). Without a render: the caller owns the render. */
export function showNotebook(app: App, show: boolean): void {
  if (show === notebookOpen(app)) return;
  if (show) {
    if (!app.panel.open) {
      app.panel.open = true;
      savePanelPrefs(app);
      applyPanel(app);
    }
    setTab(app, "notebook");
  } else {
    setTab(app, tabBeforeNotebook);
  }
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

// The history row at the head of the timeline.
const HEAD_MARK = `${icon("diamond")}<span>head</span>`;

let inspectorKey = "";

export function renderPanel(app: App): void {
  const push = app.push;

  // Header state.
  for (const input of el("toolseg").querySelectorAll("input")) {
    input.checked = input.value === app.tool;
  }
  const canUndo = (push?.state.history.head ?? 0) > 0;
  const canRedo = (push?.state.history.ahead ?? 0) > 0 || (push?.state.history.skipped ?? 0) > 0;
  el<HTMLButtonElement>("btn-undo").disabled = !canUndo;
  el<HTMLButtonElement>("btn-redo").disabled = !canRedo;

  renderInspector(app);
  renderAsideStrip(app);

  for (const [id] of TABS) {
    el(`pane-${id}`).hidden = app.tab !== id;
  }
  if (app.tab === "layers") renderLayers(app);
  if (app.tab === "drafts") renderDrafts(app);
  if (app.tab === "session") renderSession(app);
  if (app.tab === "history") renderHistory(app);
  if (app.tab === "state") renderState(app);
  // The Notebook tab renders in notebook.ts (renderNotebook), from app.render.

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
   * segmented row here read as tabs — it looked like #tabs one panel down.
   * `legacyValue` (Consequence of decision 2): a value the picker can never
   * set but the current element might still carry (a surviving "note" node)
   * — shown as a disabled option only when it's the live value, so the
   * select reads honestly instead of silently falling back to the first
   * option. */
  const picker = <T extends string>(
    labelText: string,
    kinds: readonly T[],
    value: T,
    onCommit: (v: T) => void,
    legacyValue?: T,
  ) => {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("select");
    input.className = "input mono";
    const opt = (kind: T, disabled: boolean) => {
      const o = document.createElement("option");
      o.value = kind;
      o.textContent = KIND_META[kind as NodeKind]?.label ?? kind.toUpperCase();
      o.disabled = disabled;
      input.appendChild(o);
    };
    for (const kind of kinds) opt(kind, false);
    if (legacyValue !== undefined && value === legacyValue) opt(legacyValue, true);
    input.value = value;
    input.addEventListener("change", () => onCommit(input.value as T));
    label.append(span, input);
    box.appendChild(label);
  };

  if (node) {
    field("label", node.label, false, "", (v) =>
      app.send({ type: "update_node", node_id: node.id, label: v, field: "label" }),
    );
    picker<NodeKind>(
      "kind",
      NODE_KINDS,
      node.kind,
      // A disabled "note" option can never actually be committed — see picker's legacyValue.
      (kind) => app.send({ type: "update_node", node_id: node.id, kind: kind as (typeof NODE_KINDS)[number] }),
      "note",
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
    opt.style.cssText = "flex:1;justify-content:center;padding:6px 4px;font-family:var(--font-mono);font-size: var(--text-xs)";
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
    if (!row.conflict && row.index === head) marker.innerHTML = HEAD_MARK;
    else marker.textContent = row.conflict ? "conflict" : row.ahead ? "ahead" : row.skipped ? "skipped" : "";
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
  base.innerHTML = `<div class="meta"><span class="step">00</span><span style="color: var(--color-neutral-600)">base</span><span class="marker">${head === 0 ? HEAD_MARK : ""}</span></div><div class="row"><div class="label">board opened</div></div>`;
  pane.appendChild(base);
}

/**
 * The strips above the tabs, outside the canvas: the stale-build notice with
 * Restart, then the highlight strip (the agent's pointer, cleared here or with esc).
 */
function renderAsideStrip(app: App): void {
  const bar = el("asidestrip");
  bar.replaceChildren();
  const stale = app.push?.daemon?.stale;
  if (stale) bar.appendChild(staleStrip(app, stale));
  const hl = app.push?.session.highlight;
  if (!hl) return;
  const strip = document.createElement("div");
  strip.className = "hl-strip";
  strip.innerHTML = `<span class="diamond">${icon("diamond")}</span><span class="kicker">HIGHLIGHT</span><span class="label"></span><span class="count"></span>`;
  (strip.children[2] as HTMLElement).textContent = hl.label;
  (strip.children[3] as HTMLElement).textContent = `${hl.nodes.length} nodes · ${hl.edges.length} edges`;
  const clear = document.createElement("button");
  clear.textContent = "clear · esc";
  clear.title = "clear highlight — esc";
  clear.addEventListener("click", () => app.send({ type: "highlight_set", msg_id: null }));
  strip.appendChild(clear);
  bar.appendChild(strip);
}

/** A relay with a newer build said hello (Decision 7). Only the person restarts the daemon. */
function staleStrip(app: App, stale: NonNullable<DaemonPush["stale"]>): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "stale-strip";
  strip.innerHTML = `<span class="kicker">OLD BUILD</span><span class="text"></span>`;
  (strip.children[1] as HTMLElement).textContent = "The inkwire daemon runs an older build. The newest build starts when all sessions close.";
  const restart = document.createElement("button");
  restart.textContent = "restart";
  restart.title = `restart the daemon now on build ${stale.newer_build_id}`;
  restart.addEventListener("click", () => {
    const boards = stale.boards.map((b) => `  ${b.name} (${b.id})`);
    const sessions = stale.clients.map((c) => `  ${clientLabel(c)}`);
    const text = [
      `Restart the inkwire daemon now? It affects ${stale.boards.length} ${stale.boards.length === 1 ? "board" : "boards"} and ${stale.clients.length} Claude Code ${stale.clients.length === 1 ? "session" : "sessions"}.`,
      `Boards:\n${boards.join("\n") || "  none"}`,
      `Claude Code sessions:\n${sessions.join("\n") || "  none"}`,
      "The undo history of all these boards and every pending session_send of all these sessions are lost.",
    ].join("\n\n");
    if (!window.confirm(text)) return;
    // The server restarts only when this is still the newer build that it reports.
    app.send({ type: "daemon_restart", build_id: stale.newer_build_id });
  });
  strip.appendChild(restart);
  return strip;
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
        const pinned = playing && !tr.peek; // a peek lights the canvas only
        const row = document.createElement("div");
        row.className = pinned ? "path-row on scrubber" : playing ? "path-row on" : "path-row";
        row.innerHTML = `<button class="play" title="play — opens the scrubber"></button><span class="id"></span><span class="title"></span><span class="hops"></span>`;
        (row.children[0] as HTMLElement).innerHTML = icon(playing && tr.running ? "pause" : "play");
        (row.children[1] as HTMLElement).textContent = p.id;
        (row.children[2] as HTMLElement).textContent = p.title;
        (row.children[3] as HTMLElement).textContent = `${p.steps.length} hops`;
        // Hold ▸ to peek; the window release in setupCanvas ends it (same as notebook.ts's path chip).
        // Not on the pinned row's own button: it already plays/pauses that walk.
        if (!playing) {
          row.children[0]!.addEventListener("pointerdown", (e) => {
            if ((e as PointerEvent).button !== 0) return;
            beginHold(() => startPeek(app, layer.id, p.id));
          });
          row.children[0]!.addEventListener("pointerleave", () => abortHold(app));
        }
        row.children[0]!.addEventListener("click", () => {
          if (holdFired()) return;
          if (playing) togglePlay(app);
          else app.send({ type: "trace_set", path_id: p.id });
        });
        if (pinned) {
          const loop = document.createElement("button");
          loop.className = tr.tr.loop ? "loop on" : "loop";
          loop.innerHTML = `${icon("loop")}<span>loop</span>`;
          loop.title = "loop playback";
          loop.addEventListener("click", () => {
            const live = traceInfo(app); // t at click time, not at build time
            if (live) app.send({ type: "trace_run", running: live.tr.running, loop: !live.tr.loop, t: live.t });
          });
          const close = document.createElement("button");
          close.className = "close";
          close.textContent = "close · esc";
          close.title = "close the walk — esc";
          close.addEventListener("click", () => app.send({ type: "trace_set", path_id: null }));
          row.append(loop, close, renderWalk(app, tr));
        }
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
        row.innerHTML = `<span class="id"></span><span class="label"></span><button class="unmark" title="clear mark">${icon("close")}</button>`;
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
  conn.innerHTML = `${icon(app.connected ? "dot" : "dot-outline")}<span></span>`;
  (conn.children[1] as HTMLElement).textContent = app.connected ? `mcp connected · ${MCP_TOOLS.length} tools` : "reconnecting…";
  const mode = el("modenote");
  // The mode of this board's Author.
  const author = stripView(app).author;
  const inkwire = author?.mode === "inkwire";
  mode.textContent = !author ? "no author" : inkwire ? "mode inkwire · pty muted" : "mode pty";
  mode.style.color = inkwire ? "var(--color-accent-700)" : "var(--color-neutral-600)";
  if (push) {
    const s = push.state;
    el("counts").textContent = `${s.graph.nodes.length} nodes · ${s.graph.edges.length} edges · ${s.ink.length} ink`;
    el("histnote").textContent =
      `step ${s.history.head}/${s.history.steps}` +
      (s.history.skipped ? ` · ${s.history.skipped} skipped` : "") +
      ` · scope ${app.scope === "human" ? "you" : app.scope === "ai" ? "claude" : "all"}`;
    el("inknote").textContent = s.ink.length
      ? `${s.ink.length} strokes awaiting infer structure`
      : "all ink resolved";
  }
  el("zoom").textContent = `zoom ${Math.round(app.view.zoom * 100)}%`;
}

export function fmtTime(at: number): string {
  const t = new Date(at);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
