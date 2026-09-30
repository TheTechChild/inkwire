// Canvas: grid, pan/zoom, the six tools, hit-testing, and world rendering.
// All hit-testing happens in world coordinates on the container — node divs
// are pointer-events: none. Gestures commit ONE intent, on release.
import { edgeEndpoints, resizeBox } from "../core/geometry.js";
import type { Corner } from "../core/geometry.js";
import { nextDraftId } from "../core/drafts.js";
import { nearestNodeWithin, nextNotebookId } from "../core/notebooks.js";
import { noteOwnSend } from "./notebook.js";
import { liveMembers, pathsAffected, tiers, traceT } from "../core/layers.js";
import type { PathBreak } from "../core/layers.js";
import { edgeLabel, lodFor, monoPx, quantizeZoom } from "../core/lod.js";
import type { App, Tool } from "./app.js";
import { KIND_META, clampZoom, el, focusLayer, focusedLayer } from "./app.js";
import { DRAFT_ROLES } from "../shared/types.js";
import type { Box, CanvasState, Draft, DraftRole, EdgeEl, Layer, LayoutMap, Path, PathStep, Point, Trace } from "../shared/types.js";
import { savePanelPrefs, toast } from "./panel.js";

/** Role → its hue token (handoff "Drafts" § "Design tokens"), for the JS-computed
 * colors that CSS attribute selectors can't reach (a chip count or legend item that
 * drops to neutral-500 at zero — see markCounts). Derived, not a fourth copy of the
 * map — the CSS custom properties (styles.css) are the only source. */
export const roleHue = (role: DraftRole): string => `var(--color-draft-${role})`;

/** The notebook pane's chip hover (handoff "Notebooks" § 2): a local pointer,
 * like a held trace peek — never touches the server. `ref` guards the clear:
 * a fast pointer swap between chips must not clobber a newer hover. */
let nbHover: { ref: string; label: string; nodes: string[]; edges: string[] } | null = null;
export function setNbHover(ref: string, hl: { label: string; nodes: string[]; edges: string[] }): void {
  nbHover = { ref, ...hl };
}
export function clearNbHover(ref: string): void {
  if (nbHover?.ref === ref) nbHover = null;
}
/** The ref currently hovered, if any — notebook.ts can't rely on the chip's
 * own mouseleave to clear this (see setupNotebook's window pointermove: a
 * render rebuilds the chip out from under mouseenter/mouseleave, same
 * constraint as the hold below). */
export function nbHoverRef(): string | null {
  return nbHover?.ref ?? null;
}

const HINTS: Record<Tool, string> = {
  select: "drag a node to move · drag a corner to resize · drag empty space or middle-drag to pan",
  pen: "draw freely — structure comes later",
  box: "drag to place a node",
  arrow: "click the source node",
  text: "text = write in the notebook · [[ref]] to point at an element",
  erase: "click ink, a node, or an edge to remove it",
};

const MIN_NODE_SIZE: Point = [80, 44];
const MIN_IMAGE_SIZE: Point = [24, 24];
/** Resize handle hit zone, in screen px, around each corner of the selected box. */
const HANDLE_PX = 14;
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

export function setupCanvas(app: App): void {
  const host = el("canvas");
  let viewportTimer: number | null = null;

  const sendViewport = () => {
    if (viewportTimer !== null) window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(() => {
      viewportTimer = null;
      app.send({
        type: "set_viewport",
        viewport: { x: app.view.x, y: app.view.y, zoom: clampZoom(app.view.zoom) },
      });
    }, 300);
  };

  const toWorld = (e: PointerEvent): Point => {
    const r = host.getBoundingClientRect();
    return [(e.clientX - r.left - app.view.x) / app.view.zoom, (e.clientY - r.top - app.view.y) / app.view.zoom];
  };

  host.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (app.drag?.type === "pan") return; // a wheel tick mid-pan must not zoom
      const r = host.getBoundingClientRect();
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const z = clampZoom(app.view.zoom * f);
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      app.view = {
        zoom: z,
        x: cx - (cx - app.view.x) * (z / app.view.zoom),
        y: cy - (cy - app.view.y) * (z / app.view.zoom),
      };
      sendViewport();
      app.render();
    },
    { passive: false },
  );

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const meta = e.metaKey || e.ctrlKey;
    if (meta && k === "z") {
      e.preventDefault();
      app.send({ type: "history", action: e.shiftKey ? "redo" : "undo", scope: app.scope });
      return;
    }
    if (meta && k === "y") {
      e.preventDefault();
      app.send({ type: "history", action: "redo", scope: app.scope });
      return;
    }
    // ⌘E flips the notebook between read and edit — handled above the input guard
    // below so it fires even while the caret is inside the notebook's own textarea.
    if (meta && k === "e") {
      e.preventDefault();
      app.notebook.edit = !app.notebook.edit;
      app.notebook.open = true;
      savePanelPrefs(app);
      app.render();
      return;
    }
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const map: Record<string, Tool> = { v: "select", p: "pen", b: "box", a: "arrow", t: "text", e: "erase" };
    const tool = map[k];
    if (tool) {
      app.tool = tool;
      app.pendingFrom = null;
      app.render();
    }
    if (k === " ") {
      e.preventDefault();
      app.space = true;
      app.render();
    }
    if (e.key === "Delete" || e.key === "Backspace") deleteSelection(app);
    // Digits focus the nth layer (letters are taken by the tool shortcuts).
    if (!meta && /^[1-9]$/.test(e.key)) {
      const layer = app.push?.state.layers[Number(e.key) - 1];
      if (layer) focusLayer(app, layer.id);
    }
    // n is free — not in the tool map above.
    if (!meta && k === "n") {
      app.notebook.open = !app.notebook.open;
      savePanelPrefs(app);
      app.render();
    }
    if (e.key === "Escape") {
      app.sel = null;
      app.pendingFrom = null;
      app.menu = null;
      if (app.push?.state.focus) focusLayer(app, null);
      if (app.push?.session.highlight) app.send({ type: "highlight_set", msg_id: null });
      if (app.push?.session.trace) app.send({ type: "trace_set", path_id: null });
      if (app.push?.state.active_draft) app.send({ type: "drafts_activate", draft_id: null });
      endPeek(app);
      app.render();
    }
    // The trace: ↵ pins a held peek; ← → step the pinned scrubber a hop.
    const info = traceInfo(app);
    if (!info) return;
    if (info.peek && e.key === "Enter") {
      e.preventDefault();
      app.send({ type: "trace_set", path_id: info.path.id, t: info.t, running: true });
      peek = null;
      toast("scrubber pinned · loop off · esc closes");
      app.render();
    } else if (!info.peek && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      seek(app, Math.round(info.t) + (e.key === "ArrowRight" ? 1 : -1), true);
    }
  });
  // Path-row hold and track scrub both release on window: rows are rebuilt on
  // every render, so nothing may live on the row element.
  window.addEventListener("pointermove", (e) => {
    if (scrub) seek(app, trackT(app, e.clientY), false);
  });
  const release = () => {
    if (scrub) {
      scrub = false;
      flushSeek(app);
    }
    const h = hold;
    if (!h) return;
    window.clearTimeout(h.timer);
    if (h.fired) {
      endPeek(app);
      // The chip's click follows this pointerup synchronously: keep the fired hold in sight for it.
      setTimeout(() => {
        if (hold === h) hold = null;
      }, 0);
    } else {
      hold = null;
    }
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  // The right-click menu (handoff "Drafts" § 4) closes on any pointerdown that
  // isn't on it — the menu's own pointerdown handler (renderMenu) stops
  // propagation, so this only ever sees the "elsewhere" case.
  window.addEventListener("pointerdown", () => {
    if (app.menu) {
      app.menu = null;
      app.render();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      app.space = false;
      app.render();
    }
  });

  host.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return; // right-click opens the mark menu (contextmenu) — never the active tool
    host.focus();
    host.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    if (e.button === 1 || app.space) {
      e.preventDefault(); // no compat mousedown → no browser middle-click autoscroll
      app.drag = { type: "pan", sx: e.clientX, sy: e.clientY, ox: app.view.x, oy: app.view.y };
      return;
    }
    switch (app.tool) {
      case "pen":
        app.sel = null;
        app.drag = { type: "pen", points: [p] };
        break;
      case "box":
        app.drag = { type: "box", start: p, cur: p };
        break;
      case "text": {
        // Prose no longer lives on the canvas: a click appends an empty paragraph
        // to the open notebook, prefixed [[nX]] within 80px of a node, and opens
        // the pane in edit mode with the caret there (nbCaretToEnd, applied once
        // renderNotebook finds a live textarea for it — the server may not have
        // echoed a fresh notebooks_create back yet).
        const state = app.push?.state;
        if (state) {
          const nodeLayout: LayoutMap = {};
          for (const n of state.graph.nodes) {
            const box = state.layout.boxes[n.id];
            if (box) nodeLayout[n.id] = box;
          }
          const near = nearestNodeWithin(nodeLayout, p, 80);
          const prefix = near ? `[[${near}]] ` : "";
          const active = state.notebooks.find((nb) => nb.id === state.active_notebook);
          if (active) {
            const body = active.body && !active.body.endsWith("\n") ? `${active.body}\n${prefix}` : active.body + prefix;
            // Tell notebook.ts what we just sent (noteOwnSend) before the render
            // below: without it, that render's caret guard would park the caret
            // in a textarea still showing the stale (pre-append) body, and the
            // real echo would then never be allowed to land — the ref is lost.
            noteOwnSend(active.id, body);
            app.send({ type: "notebooks_update", notebook_id: active.id, body });
          } else {
            app.send({ type: "notebooks_create", body: prefix });
          }
          app.notebook.open = true;
          app.notebook.edit = true;
          app.nbCaretToEnd = true;
          savePanelPrefs(app);
        }
        app.tool = "select";
        break;
      }
      case "arrow": {
        const n = hitNode(app, p);
        if (!n) return;
        if (!app.pendingFrom) {
          app.pendingFrom = n;
        } else if (app.pendingFrom !== n) {
          app.send({ type: "add_edge", from: app.pendingFrom, to: n, kind: "sync" });
          app.pendingFrom = null;
          app.tool = "select";
        } else {
          app.pendingFrom = null;
        }
        break;
      }
      case "erase": {
        const target = hitNode(app, p) ?? hitStroke(app, p) ?? hitEdge(app, p);
        if (target) app.send({ type: "delete", id: target });
        break;
      }
      case "select": {
        const handle = hitResizeHandle(app, p);
        if (handle) {
          const box = boxOf(app, handle.id)!;
          app.drag = { type: "resize", id: handle.id, corner: handle.corner, origin: box, box };
          break;
        }
        const n = hitNode(app, p);
        if (n) {
          const box = boxOf(app, n)!;
          app.sel = { type: app.push?.state.images.some((i) => i.id === n) ? "image" : "node", id: n };
          app.drag = { type: "node", id: n, dx: p[0] - box[0], dy: p[1] - box[1], at: [box[0], box[1]], moved: false };
          break;
        }
        const edge = hitEdge(app, p);
        if (edge) {
          app.sel = { type: "edge", id: edge };
          break;
        }
        const stroke = hitStroke(app, p);
        if (stroke) break; // ink is not selectable; erase removes it
        app.sel = null;
        app.drag = { type: "pan", sx: e.clientX, sy: e.clientY, ox: app.view.x, oy: app.view.y };
        break;
      }
    }
    app.render();
  });

  host.addEventListener("pointermove", (e) => {
    const d = app.drag;
    if (!d) {
      if (app.tool === "select" && !app.space) {
        const h = hitResizeHandle(app, toWorld(e));
        host.style.cursor = !h ? "default" : h.corner === "tl" || h.corner === "br" ? "nwse-resize" : "nesw-resize";
      }
      return;
    }
    if (d.type === "pan") {
      app.view = { ...app.view, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) };
      sendViewport();
      app.render();
      return;
    }
    const p = toWorld(e);
    if (d.type === "pen") {
      const last = d.points[d.points.length - 1]!;
      if (Math.hypot(last[0] - p[0], last[1] - p[1]) >= 3) {
        d.points.push(p);
        app.render();
      }
    } else if (d.type === "node") {
      d.at = [p[0] - d.dx, p[1] - d.dy];
      d.moved = true;
      app.render();
    } else if (d.type === "box") {
      d.cur = p;
      app.render();
    } else if (d.type === "resize") {
      const min = app.push?.state.images.some((i) => i.id === d.id) ? MIN_IMAGE_SIZE : MIN_NODE_SIZE;
      d.box = resizeBox(d.origin, d.corner, p, min);
      app.render();
    }
  });

  host.addEventListener("pointerup", () => {
    const d = app.drag;
    app.drag = null;
    if (!d) return;
    if (d.type === "pen" && d.points.length >= 2) {
      app.send({ type: "add_stroke", points: d.points });
    } else if (d.type === "node" && d.moved) {
      app.send({ type: "move", id: d.id, at: d.at });
    } else if (d.type === "resize") {
      const [x, y, w, h] = d.box;
      if (d.box.some((v, i) => v !== d.origin[i])) app.send({ type: "move", id: d.id, at: [x, y], size: [w, h] });
    } else if (d.type === "box") {
      const x = Math.min(d.start[0], d.cur[0]);
      const y = Math.min(d.start[1], d.cur[1]);
      const w = Math.abs(d.cur[0] - d.start[0]);
      const h = Math.abs(d.cur[1] - d.start[1]);
      if (w > 40 && h > 30) {
        app.send({ type: "add_node", label: "untitled", kind: "service", at: [x, y], size: [w, Math.max(66, h)] });
        app.tool = "select";
      }
    }
    app.render();
  });

  host.addEventListener("pointercancel", () => {
    if (app.drag?.type !== "pan") return;
    app.drag = null;
    app.render();
  });

  // Right-click menu (handoff "Drafts" § 4): hit node then edge, same zones as
  // select (rim/out tiers are inert already, via hitNode/hitEdge's tiersOf).
  // An image hit shadows whatever's under it, same as a normal select click —
  // images cannot be marked, so that reads as nothing hit.
  host.addEventListener("contextmenu", (e) => {
    const state = app.push?.state;
    if (!state) return;
    const p = toWorld(e);
    const hit = hitNode(app, p);
    const isNode = hit !== null && state.graph.nodes.some((n) => n.id === hit);
    const edge = hit === null ? hitEdge(app, p) : null;
    const id = isNode ? hit : edge;
    e.preventDefault();
    // Empty space (handoff "Notebooks" § Migration): "import notes to notebook".
    app.menu = id ? { x: e.clientX, y: e.clientY, type: isNode ? "node" : "edge", id } : { x: e.clientX, y: e.clientY, type: "empty" };
    app.render();
  });
}

/** Mark or unmark one element via the right-click menu (a null active draft
 * creates one first — the server handles that; toast only guesses its id). */
function markVia(app: App, id: string, role: DraftRole | null): void {
  const state = app.push!.state;
  if (state.active_draft === null) toast(`drafts_create · ${nextDraftId(state.drafts)} · mark it, then name it in DRAFTS`);
  app.send({ type: "drafts_mark", draft_id: state.active_draft, id, role });
  app.menu = null;
  app.render();
}

/** Key for what the menu currently shows — rebuild
 * the DOM only when this changes, so a press that straddles a server push doesn't
 * lose its click or replay the pulsein animation. */
let lastMenuKey = "";

/** The right-click menu: header, three role rows (✓ on the current mark), an
 * optional clear-mark row, and a footer naming where the mark will land. */
function renderMenu(app: App): void {
  const m = app.menu;
  const state = app.push?.state;
  if (!m || !state) {
    document.querySelector(".ctx-menu")?.remove();
    lastMenuKey = "";
    return;
  }
  if (m.type === "empty") {
    renderEmptyMenu(app, m, state);
    return;
  }
  const activeDraft: Draft | null = state.drafts.find((d) => d.id === state.active_draft) ?? null;
  const current = activeDraft?.marks[m.id] ?? "";
  const key = `${m.x}|${m.y}|${m.type}|${m.id}|${activeDraft?.id ?? ""}|${activeDraft?.title ?? ""}|${current}`;
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  document.querySelector(".ctx-menu")?.remove();
  const host = el("canvas");
  const r = host.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${m.x - r.left}px`;
  menu.style.top = `${m.y - r.top}px`;
  // Same trick as the layer bar (Gotcha 1): keep this pointerdown off the canvas.
  menu.addEventListener("pointerdown", (e) => e.stopPropagation());

  const label =
    m.type === "node"
      ? (state.graph.nodes.find((n) => n.id === m.id)?.label ?? m.id)
      : (state.graph.edges.find((e) => e.id === m.id)?.label ?? m.id);
  const header = document.createElement("div");
  header.className = "header";
  header.innerHTML = `<span class="kind"></span><span class="label"></span>`;
  (header.children[0] as HTMLElement).textContent = `${m.type.toUpperCase()} · ${m.id}`;
  (header.children[1] as HTMLElement).textContent = label;
  menu.appendChild(header);

  for (const role of DRAFT_ROLES) {
    const row = document.createElement("div");
    row.className = "role-row";
    row.dataset.role = role;
    row.innerHTML = `<i class="line-sample" data-draft="${role}"></i><span class="name"></span><span class="check"></span>`;
    (row.children[1] as HTMLElement).textContent = role;
    (row.children[2] as HTMLElement).textContent = current === role ? "✓" : "";
    row.addEventListener("click", () => markVia(app, m.id, role));
    menu.appendChild(row);
  }
  if (current) {
    const clear = document.createElement("div");
    clear.className = "clear-row";
    clear.textContent = "clear mark";
    clear.addEventListener("click", () => markVia(app, m.id, null));
    menu.appendChild(clear);
  }

  const footer = document.createElement("div");
  footer.className = "footer";
  footer.textContent = activeDraft
    ? `marks land on ${activeDraft.id} · ${activeDraft.title}`
    : `no active draft — marking creates ${nextDraftId(state.drafts)}`;
  menu.appendChild(footer);

  host.appendChild(menu);
}

/** The empty-space menu (handoff "Notebooks" § Migration): one row, "import
 * notes to notebook" — disabled when the board has no note nodes. */
function renderEmptyMenu(app: App, m: { x: number; y: number; type: "empty" }, state: CanvasState): void {
  const notes = state.graph.nodes.filter((n) => n.kind === "note").length;
  const key = `empty|${m.x}|${m.y}|${notes}`;
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  document.querySelector(".ctx-menu")?.remove();
  const host = el("canvas");
  const r = host.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${m.x - r.left}px`;
  menu.style.top = `${m.y - r.top}px`;
  menu.addEventListener("pointerdown", (e) => e.stopPropagation());

  const row = document.createElement("div");
  row.className = notes > 0 ? "clear-row" : "clear-row disabled";
  row.textContent = "import notes to notebook";
  row.title =
    notes > 0
      ? "notes_migrate — one history step; ⌘Z brings the notes back, but not the notebook text"
      : "no note nodes on this board";
  if (notes > 0) {
    row.addEventListener("click", () => {
      const target = state.notebooks.find((nb) => nb.title === "notes")?.id ?? nextNotebookId(state.notebooks);
      app.send({ type: "notes_migrate" });
      toast(`${notes} notes → ${target} notes · ⌘Z brings the notes back, not the notebook text`);
      app.menu = null;
      app.render();
    });
  }
  menu.appendChild(row);
  host.appendChild(menu);
}

/** Layer tiers for hit-testing and render alike: blurred (rim/out) elements are inert. */
function tiersOf(app: App) {
  const state = app.push?.state;
  if (!state) return tiers({ nodes: [], edges: [], strokes: [], images: [], layout: {} }, null, app.rim);
  // A playing path takes over the tiers: the walk is "in", the rest of its
  // layer is the rim, everything else blurs — and hit-testing follows.
  const info = traceInfo(app);
  if (info) {
    const members = liveMembers(info.layer, state.graph.nodes);
    return {
      node: (id: string) => (info.onPath.has(id) ? "in" : members.has(id) ? "rim" : "out"),
      edge: (e: EdgeEl) => (info.pathEdges.has(e.id) ? "in" : members.has(e.from) || members.has(e.to) ? "rim" : "out"),
    };
  }
  return tiers(
    { nodes: state.graph.nodes, edges: state.graph.edges, strokes: [], images: state.images, layout: state.layout.boxes },
    focusedLayer(app),
    app.rim,
  );
}

function boxOf(app: App, id: string): Box | undefined {
  const box = app.push?.state.layout.boxes[id];
  if (!box) return undefined;
  const d = app.drag;
  if (d && d.type === "node" && d.id === id) return [d.at[0], d.at[1], box[2], box[3]];
  if (d && d.type === "resize" && d.id === id) return d.box;
  return box;
}

/** The selected node's or image's corner resize handle under `p`, if any. */
function hitResizeHandle(app: App, p: Point): { id: string; corner: Corner } | null {
  const sel = app.sel;
  if (!sel || sel.type === "edge") return null;
  const box = boxOf(app, sel.id);
  if (!box) return null;
  const hs = HANDLE_PX / app.view.zoom;
  // Zone reaches hs into the box and hs/2 outside it, per axis.
  const near = (v: number, edge: number, outward: 1 | -1) =>
    outward === 1 ? v >= edge - hs && v <= edge + hs / 2 : v >= edge - hs / 2 && v <= edge + hs;
  for (const corner of CORNERS) {
    const onX = corner[1] === "l" ? near(p[0], box[0], -1) : near(p[0], box[0] + box[2], 1);
    const onY = corner[0] === "t" ? near(p[1], box[1], -1) : near(p[1], box[1] + box[3], 1);
    if (onX && onY) return { id: sel.id, corner };
  }
  return null;
}

function hitNode(app: App, p: Point): string | null {
  const state = app.push?.state;
  if (!state) return null;
  const t = tiersOf(app);
  const ids = [...state.graph.nodes.map((n) => n.id), ...state.images.map((i) => i.id)].filter((id) => t.node(id) === "in");
  for (let i = ids.length - 1; i >= 0; i--) {
    const box = state.layout.boxes[ids[i]!];
    if (box && p[0] >= box[0] && p[0] <= box[0] + box[2] && p[1] >= box[1] && p[1] <= box[1] + box[3]) {
      return ids[i]!;
    }
  }
  return null;
}

function hitStroke(app: App, p: Point): string | null {
  const t = tiersOf(app);
  for (const s of app.push?.state.ink ?? []) {
    if (t.node(s.id) !== "in") continue;
    if (s.geometry?.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 12)) return s.id;
  }
  return null;
}

function hitEdge(app: App, p: Point): string | null {
  const state = app.push?.state;
  if (!state) return null;
  const t = tiersOf(app);
  for (const e of state.graph.edges) {
    if (t.edge(e) !== "in") continue;
    const a = state.layout.boxes[e.from];
    const b = state.layout.boxes[e.to];
    if (!a || !b) continue;
    const { p1, p2, mid } = edgeEndpoints(a, b);
    const tol = 12 / app.view.zoom; // screen-constant, like the resize handle
    if (segmentDistance(p, p1, p2) < tol) return e.id;
    // The label sits above the midpoint; accept clicks on it too. Its size
    // follows the same counter-scaling as .edge-label in styles.css.
    // ponytail: 0.62em mono glyph estimate stands in for measuring the text.
    const fontPx = monoPx(app.view.zoom, 11);
    const halfW = (edgeLabel(e).length * fontPx * 0.62) / 2;
    const cy = mid[1] - 8 - fontPx * 0.35;
    if (Math.abs(p[0] - mid[0]) < halfW + tol && Math.abs(p[1] - cy) < Math.max(tol, fontPx)) return e.id;
  }
  return null;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

export function deleteSelection(app: App): void {
  if (!app.sel) return;
  app.send({ type: "delete", id: app.sel.id });
  app.sel = null;
  app.render();
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function renderWorld(app: App): void {
  renderMenu(app); // always: rebuilds when open, clears the stale DOM node otherwise
  const state = app.push?.state;
  const world = el("world");
  const grid = el("grid");
  const v = app.view;

  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
  // LOD: quantized so styles do not recompute every frame; all tier rules are CSS.
  const qz = quantizeZoom(v.zoom);
  world.style.setProperty("--zoom", String(qz));
  world.dataset.lod = lodFor(qz);
  grid.style.backgroundImage = "radial-gradient(circle, var(--cv-grid) 1px, transparent 1px)";
  grid.style.backgroundSize = `${(28 * v.zoom).toFixed(1)}px ${(28 * v.zoom).toFixed(1)}px`;
  grid.style.backgroundPosition = `${v.x.toFixed(0)}px ${v.y.toFixed(0)}px`;

  el("canvas").style.cursor = app.space ? "grabbing" : app.tool === "select" ? "default" : "crosshair";
  const info = traceInfo(app);
  const focus = focusedLayer(app);
  const draft = app.push?.state.drafts.find((d) => d.id === app.push?.state.active_draft);
  el("hint").textContent =
    info && !info.peek
      ? `scrubbing ${info.path.id} · ← → step a hop · esc closes`
      : focus
        ? `focus ${focus.letter} · ${focus.title} · esc shows all`
        : draft
          ? `draft ${draft.id} · ${draft.title} · esc clears`
          : app.tool === "arrow" && app.pendingFrom
        ? "now click the target node"
        : HINTS[app.tool];

  const ink = el("inkgroup");
  const edges = el("edgegroup");
  const preview = el("previewgroup");
  const nodes = el("nodelayer");
  ink.replaceChildren();
  edges.replaceChildren();
  preview.replaceChildren();
  nodes.replaceChildren();
  if (!state) return;

  // Layer tiers: every element resolves to in / rim / out; CSS carries the look.
  const t = tiersOf(app);
  if (info) world.dataset.trace = "on";
  else delete world.dataset.trace;
  // Highlight: the agent's pointer. Members lift to full strength whatever
  // their tier; everything else dims (never blurs) when the dim pref is on.
  // A trace is the stronger pointer: the highlight reads as null while one plays.
  const hl = info ? null : (nbHover ?? app.push?.session.highlight ?? null);
  const hlNodes = new Set(hl?.nodes ?? []);
  const hlEdges = new Set(hl?.edges ?? []);
  world.dataset.hl = hl ? (app.dim ? "dim" : "on") : "";
  const hlOf = (member: boolean) => (hl ? (member ? "in" : "out") : "");
  // Drafts (handoff "Drafts" § "Stacking"): a view, like a highlight — and,
  // like a highlight, it reads as empty while a trace plays.
  const activeDraft = info ? null : (state.drafts.find((d) => d.id === state.active_draft) ?? null);
  const marks: Record<string, DraftRole> = activeDraft?.marks ?? {};

  // Ink (server strokes + the in-flight pen gesture).
  const strokes: [string, Point[]][] = state.ink.map((s) => [s.id, s.geometry ?? []]);
  if (app.drag?.type === "pen") strokes.push(["", app.drag.points]);
  for (const [id, pts] of strokes) {
    if (pts.length < 2) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.dataset.tier = t.node(id);
    path.dataset.hl = hlOf(false);
    path.setAttribute("d", "M " + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L "));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--color-text)");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    ink.appendChild(path);
  }

  // Edges, clipped to node borders, with a measured label backing rect.
  for (const e of state.graph.edges) {
    const a = boxOf(app, e.from);
    const b = boxOf(app, e.to);
    if (!a || !b) continue;
    const selected = app.sel?.type === "edge" && app.sel.id === e.id;
    const ai = e.author === "ai";
    const { p1, p2, mid } = edgeEndpoints(a, b);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", selected ? "edge selected" : "edge");
    g.dataset.id = e.id;
    const tier = t.edge(e);
    g.dataset.tier = tier;
    const lit = hlEdges.has(e.id);
    g.dataset.hl = hlOf(lit);
    // A role beats the error kind (handoff "Drafts" § "Roles"): mark it even on
    // an error edge, so the CSS role rules draw it and its label shows.
    const role = marks[e.id] as DraftRole | undefined;
    if (role) g.dataset.draft = role;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
    path.setAttribute("fill", "none");
    path.setAttribute(
      "stroke",
      // A lit (highlighted) edge beats the error kind's own color too.
      lit
        ? "var(--color-accent-600)"
        : e.kind === "error"
          ? "var(--color-error)"
          : ai
            ? "var(--color-accent)"
            : selected
              ? "var(--color-text)"
              : "var(--color-accent-700)",
    );
    path.setAttribute("stroke-width", lit ? "2.6" : selected ? "2" : "1.3");
    if (e.kind === "error") path.setAttribute("stroke-dasharray", "2 3");
    else if (ai || e.kind === "async") path.setAttribute("stroke-dasharray", "6 4");
    path.setAttribute("marker-end", e.kind === "error" ? "url(#arwerror)" : ai ? "url(#arwai)" : "url(#arw)");
    g.appendChild(path);

    const labelText = info
      ? info.pathEdges.has(e.id)
        ? edgeLabel(e, selected)
        : ""
      : tier === "in" || lit || role
        ? edgeLabel(e, selected)
        : "";
    if (labelText) {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(mid[0]));
      text.setAttribute("y", String(mid[1] - 8));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "edge-label");
      text.textContent = labelText;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("class", "edge-label-bg");
      g.appendChild(rect);
      g.appendChild(text);
      edges.appendChild(g);
      // Measure the real text so the backing rect fits.
      const tb = text.getBBox();
      rect.setAttribute("x", String(tb.x - 4));
      rect.setAttribute("y", String(tb.y - 1));
      rect.setAttribute("width", String(tb.width + 8));
      rect.setAttribute("height", String(tb.height + 2));
      rect.setAttribute("fill", "var(--color-bg)");
      continue;
    }
    edges.appendChild(g);
  }

  // Box-drag preview.
  if (app.drag?.type === "box") {
    const d = app.drag;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(Math.min(d.start[0], d.cur[0])));
    rect.setAttribute("y", String(Math.min(d.start[1], d.cur[1])));
    rect.setAttribute("width", String(Math.abs(d.cur[0] - d.start[0])));
    rect.setAttribute("height", String(Math.abs(d.cur[1] - d.start[1])));
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", "var(--color-accent)");
    rect.setAttribute("stroke-width", "1");
    rect.setAttribute("stroke-dasharray", "4 4");
    preview.appendChild(rect);
  }

  // Images below nodes.
  for (const img of state.images) {
    const box = boxOf(app, img.id);
    if (!box) continue;
    const div = document.createElement("div");
    div.className = "image-box";
    div.dataset.tier = t.node(img.id);
    div.dataset.hl = hlOf(false);
    if (app.sel?.id === img.id) {
      div.style.outline = "1.5px solid var(--color-accent)";
      div.appendChild(resizeHandle());
    }
    Object.assign(div.style, {
      left: `${box[0]}px`,
      top: `${box[1]}px`,
      width: `${box[2]}px`,
      height: `${box[3]}px`,
    });
    const image = document.createElement("img");
    image.src = img.src;
    image.alt = img.id;
    div.appendChild(image);
    nodes.appendChild(div);
  }

  // Nodes: blueprint-framed boxes with registration marks.
  for (const n of state.graph.nodes) {
    const box = boxOf(app, n.id);
    if (!box) continue;
    const selected = app.sel?.type === "node" && app.sel.id === n.id;
    const pending = app.pendingFrom === n.id;
    const ai = n.author === "ai";
    const meta = KIND_META[n.kind] ?? KIND_META.note;

    const lit = hlNodes.has(n.id);
    const walk = info?.onPath.has(n.id) ?? false;
    const role = marks[n.id] as DraftRole | undefined;
    const div = document.createElement("div");
    div.className = "node-box blueprint";
    div.dataset.id = n.id;
    div.dataset.kind = n.kind;
    div.dataset.tier = t.node(n.id);
    div.dataset.hl = hlOf(lit);
    if (role) div.dataset.draft = role;
    // Walk and marked nodes leave border to CSS: inline would beat [data-trace]
    // / [data-draft] (trace > draft > highlight > selected > ai > default). A
    // selected marked node keeps the role border and still gets shadow-md below —
    // a pending (arrow-tool endpoint) marked node keeps its role border the same
    // way, and gets the same shadow-md as its pending cue.
    Object.assign(div.style, {
      left: `${box[0]}px`,
      top: `${box[1]}px`,
      width: `${box[2]}px`,
      height: `${box[3]}px`,
      border: walk && !selected && !pending
        ? ""
        : role
        ? ""
        : lit
        ? "2px solid var(--color-accent-600)"
        : selected || pending
          ? "1.5px solid var(--color-accent)"
          : ai
            ? "1.5px dashed var(--color-accent-500)"
            : "1px solid var(--color-divider)",
      boxShadow: walk && !selected && !pending
        ? ""
        : lit
          ? "0 0 0 4px color-mix(in srgb, var(--color-accent) 28%, transparent), var(--shadow-md)"
          : selected || pending
            ? "var(--shadow-md)"
            : "none",
    });
    for (const corner of ["tl", "tr", "bl", "br"]) {
      const i = document.createElement("i");
      i.className = `corner ${corner}`;
      div.appendChild(i);
    }
    const kicker = document.createElement("div");
    kicker.className = "node-kicker";
    kicker.style.color = meta.color;
    // Third span: the marked role, "· removed" etc — colored by [data-draft] on
    // the node-box (styles.css), same span-hiding rule at compact/dot LOD as "· claude".
    kicker.innerHTML = `<span></span><span></span><span></span>`;
    (kicker.children[0] as HTMLElement).textContent = meta.label;
    (kicker.children[1] as HTMLElement).textContent = ai ? "· claude" : "";
    (kicker.children[2] as HTMLElement).textContent = role ? `· ${role}` : "";
    const label = document.createElement("div");
    label.className = "node-label";
    label.textContent = n.label;
    const ref = document.createElement("div");
    ref.className = "node-ref";
    ref.textContent = n.endpoint || n.ref || "unbound";
    div.append(kicker, label, ref);
    if (selected) div.appendChild(resizeHandle());
    nodes.appendChild(div);
  }
  ensureLoop(app);
}

// ---------------------------------------------------------------------------
// The trace (handoff "Paths"). The server holds the pinned trace; every panel
// derives t from started_at. A peek is this panel's held gesture and never
// leaves it. Playback is a rAF chain that patches only — never app.render().

let peek: { layer_id: string; path_id: string; at: number } | null = null;
let hold: { timer: number; fired: boolean } | null = null;
let scrub = false;
let seekTimer: number | null = null;
let seekT: number | null = null;
let raf = 0;
let lastK = -1;

export interface TraceInfo {
  tr: Trace;
  peek: boolean;
  layer: Layer;
  path: Path;
  /** The playable prefix: each step with its edge resolved. */
  steps: (Omit<PathStep, "edge"> & { edge: EdgeEl })[];
  nodeIds: string[];
  n: number;
  nGood: number;
  broken: PathBreak | null;
  t: number;
  i: number;
  frac: number;
  /** Advancing right now — the server's flag, minus a non-loop run that reached the end. */
  running: boolean;
  reached: Set<string>;
  current: string | undefined;
  doneEdges: Set<string>;
  active: (Omit<PathStep, "edge"> & { edge: EdgeEl }) | null;
  onPath: Set<string>;
  pathEdges: Set<string>;
}

/** A held peek wins; else the server trace with this panel's unacknowledged seek laid over it. */
function effectiveTrace(app: App): { tr: Trace; peek: boolean } | null {
  if (peek) return { tr: { layer_id: peek.layer_id, path_id: peek.path_id, running: true, loop: true, t: 0, started_at: peek.at }, peek: true };
  const tr = app.push?.session.trace;
  if (!tr) return null;
  return { tr: app.traceOverride ? { ...tr, ...app.traceOverride } : tr, peek: false };
}

/** Everything the canvas, the scrubber and the composer derive from the trace's live t. */
export function traceInfo(app: App): TraceInfo | null {
  const state = app.push?.state;
  const eff = effectiveTrace(app);
  if (!state || !eff) return null;
  const { tr } = eff;
  const layer = state.layers.find((l) => l.id === tr.layer_id);
  const path = layer?.paths.find((p) => p.id === tr.path_id);
  if (!layer || !path) return null;
  const byId = new Map(state.graph.edges.map((e) => [e.id, e]));
  const broken = pathsAffected([layer], state.graph.edges).find((b) => b.path_id === path.id) ?? null;
  const n = path.steps.length;
  const nGood = broken ? broken.hop - 1 : n;
  const steps = path.steps.slice(0, nGood).map((st) => ({ ...st, edge: byId.get(st.edge)! }));
  const nodeIds = steps.length ? [steps[0]!.edge.from, ...steps.map((st) => st.edge.to)] : [];
  const t = traceT(tr, nGood, Date.now());
  const k = Math.floor(t);
  // The hop shown: the one in flight, the one just completed at an integral t, or the broken one at the end.
  const i = Math.min(n - 1, broken && t >= nGood ? nGood : t === k && k > 0 ? k - 1 : k);
  const frac = t >= nGood ? 1 : t - k;
  return {
    tr,
    peek: eff.peek,
    layer,
    path,
    steps,
    nodeIds,
    n,
    nGood,
    broken,
    t,
    i,
    frac,
    running: tr.running && nGood > 0 && (tr.loop || t < nGood),
    reached: new Set(nodeIds.slice(0, k + 1)),
    current: nodeIds[Math.min(nodeIds.length - 1, k)],
    doneEdges: new Set(steps.slice(0, k).map((st) => st.edge.id)),
    active: frac > 0 && frac < 1 ? (steps[i] ?? null) : null,
    onPath: new Set(nodeIds),
    pathEdges: new Set(steps.map((st) => st.edge.id)),
  };
}

export function endPeek(app: App): void {
  if (!peek) return;
  peek = null;
  app.render();
}

/** Start a held peek — from the path row's play button in the Layers tab or the notebook pane's
 * path chip (handoff "Notebooks" § 2: hold to peek, click to play). */
export function startPeek(app: App, layerId: string, pathId: string): void {
  peek = { layer_id: layerId, path_id: pathId, at: Date.now() };
  app.render();
}

/** Begin a 230ms hold-to-fire gesture, same shape as the path row's play button
 * in the Layers tab (`hold`, above). Release always happens on the window pointerup/
 * pointercancel registered once in setupCanvas — never on the chip's own
 * listeners, since firing typically re-renders and rebuilds the chip that
 * started the hold (this file's own note on the window listener below).
 * Shared with notebook.ts's path chip so it gets the same guarantee. */
export function beginHold(onFire: () => void): void {
  if (hold) window.clearTimeout(hold.timer);
  const h = { timer: 0, fired: false };
  h.timer = window.setTimeout(() => {
    h.fired = true;
    onFire();
  }, 230);
  hold = h;
}

/** The pointer left the pressed element: an unfired hold must not peek later; a fired one ends
 * its peek, and the window release clears `hold`. */
export function abortHold(app: App): void {
  if (hold && !hold.fired) {
    window.clearTimeout(hold.timer);
    hold = null;
  } else if (hold?.fired) endPeek(app);
}

/** True while a beginHold gesture has fired but its window release hasn't
 * cleared `hold` yet — the same tick a synchronous click after pointerup
 * still sees it in (see the window release's own comment), so a chip's
 * click listener can skip acting on a hold that already did. */
export function holdFired(): boolean {
  return hold?.fired ?? false;
}

/** Play / pause the pinned trace from its live position; at the end, play again from 0. */
export function togglePlay(app: App): void {
  const info = traceInfo(app);
  if (!info || info.peek) return;
  if (info.running) app.send({ type: "trace_run", running: false, t: info.t });
  else app.send({ type: "trace_run", running: true, t: info.t >= info.nGood ? 0 : info.t });
}

/** The walk position under clientY, in hops: a hop row maps linearly, the node row above it to its whole number. */
function trackT(app: App, clientY: number): number {
  const rows = [...document.querySelectorAll<HTMLElement>(".walk .whop")].map((r) => r.getBoundingClientRect());
  const info = rows.length && traceInfo(app);
  if (!info) return 0;
  if (clientY < rows[0]!.top) return 0;
  if (clientY > rows[rows.length - 1]!.bottom) return info.n;
  const j = rows.findIndex((r) => clientY <= r.bottom);
  const r = rows[j]!;
  return clientY < r.top ? j : j + (clientY - r.top) / r.height; // seek clamps to nGood
}

/** Seek and pause: patch locally at once, tell the server debounced (60 ms) or now. */
function seek(app: App, t: number, now: boolean): void {
  const info = traceInfo(app);
  if (!info || info.peek) {
    if (seekTimer !== null) window.clearTimeout(seekTimer);
    seekTimer = null;
    seekT = null;
    return;
  }
  t = Math.min(info.nGood, Math.max(0, t)); // the server clamps the same way, so its echo matches
  app.traceOverride = { t, running: false };
  seekT = t;
  renderTrace(app);
  if (seekTimer !== null) window.clearTimeout(seekTimer);
  seekTimer = null;
  if (now) flushSeek(app);
  else seekTimer = window.setTimeout(() => flushSeek(app), 60);
}

function flushSeek(app: App): void {
  if (seekTimer !== null) window.clearTimeout(seekTimer);
  seekTimer = null;
  const t = seekT;
  seekT = null;
  if (t === null || !app.push?.session.trace) return; // the trace closed under the drag
  app.send({ type: "trace_seek", t });
}

/** Keep a rAF chain alive while the trace advances; each frame patches only. */
function ensureLoop(app: App): void {
  const info = traceInfo(app);
  if (!info?.running) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    return;
  }
  if (raf) return;
  const frame = () => {
    raf = 0;
    const cur = traceInfo(app);
    renderTrace(app);
    if (cur?.running) raf = requestAnimationFrame(frame);
    else if (cur) app.render(); // reached the end: the play glyph and the LAYERS card flip once
  };
  raf = requestAnimationFrame(frame);
}

/** Patch the walk's data-trace states, the gold front, and the scrubber from the live t. Runs
 * after both the world and the panel are built (main.ts `render`) because it patches both. */
export function renderTrace(app: App): void {
  const info = traceInfo(app);
  const group = el("tracegroup");
  group.replaceChildren();
  if (!info) return;
  const nodes = el("nodelayer");
  const edges = el("edgegroup");
  for (const id of info.onPath) {
    const div = nodes.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (div) div.dataset.trace = id === info.current ? "current" : info.reached.has(id) ? "reached" : "ahead";
  }
  for (const id of info.pathEdges) {
    const g = edges.querySelector<SVGGElement>(`[data-id="${id}"]`);
    if (!g) continue;
    g.dataset.trace = info.doneEdges.has(id)
      ? "done"
      : info.active?.edge.id === id
        ? info.frac >= 0.5
          ? "active-lit"
          : "active"
        : "ahead";
  }
  // The gold front: the hop in flight as a dash the length of the progress, a square head at its tip.
  if (info.active) {
    const a = boxOf(app, info.active.edge.from);
    const b = boxOf(app, info.active.edge.to);
    if (a && b) {
      const { p1, p2 } = edgeEndpoints(a, b);
      const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "var(--color-signal)");
      const z = quantizeZoom(app.view.zoom); // the CSS floors read the quantized --zoom; match it exactly
      path.setAttribute("stroke-width", String(Math.max(3, 2.5 / z)));
      path.setAttribute("stroke-dasharray", `${(L * info.frac).toFixed(1)} ${(L + 20).toFixed(1)}`);
      const head = document.createElementNS(SVG_NS, "rect");
      const hs = Math.max(9, 7.5 / z); // the head square keeps a screen floor too
      head.setAttribute("x", (p1[0] + (p2[0] - p1[0]) * info.frac - hs / 2).toFixed(1));
      head.setAttribute("y", (p1[1] + (p2[1] - p1[1]) * info.frac - hs / 2).toFixed(1));
      head.setAttribute("width", String(hs));
      head.setAttribute("height", String(hs));
      head.setAttribute("fill", "var(--color-signal)");
      head.setAttribute("stroke", "var(--color-bg)");
      head.setAttribute("stroke-width", String(Math.max(1.5, 1.25 / z))); // the ring that separates head from dash
      group.append(path, head);
    }
  }

  // The walk in the Layers tab (absent on another tab, or during a peek).
  const sc = document.querySelector<HTMLElement>(".path-row.scrubber");
  if (!sc || info.peek) return;
  const atEnd = info.t >= info.nGood;
  const play = sc.querySelector<HTMLElement>(".play")!;
  play.textContent = info.running ? "❚❚" : atEnd ? "↺" : "▸";
  play.title = info.running ? "pause" : atEnd ? "play again" : "play";
  const k = Math.floor(info.t);
  const last = info.nodeIds.length - 1; // the last playable node: below n on a broken path
  const curNode = Math.min(last, k);
  for (const node of sc.querySelectorAll<HTMLElement>(".wnode")) {
    const j = Number(node.dataset.j);
    node.dataset.on = j <= k ? "reached" : "";
    node.classList.toggle("cur", j === curNode);
  }
  for (const hop of sc.querySelectorAll<HTMLElement>(".whop")) {
    const j = Number(hop.dataset.j);
    hop.classList.toggle("lit", !hop.classList.contains("broken") && (j < k || (j === info.i && info.frac >= 0.5)));
    hop.classList.toggle("cur", j === info.i);
    hop.style.setProperty("--frac", String(j < k ? 1 : j === info.i ? info.frac : 0));
  }
  // Follow the head, but never while dragging — that would fight the pointer.
  if (k !== lastK && !scrub) sc.querySelector(".wnode.cur")?.scrollIntoView({ block: "nearest" });
  lastK = k;
  // The composer's step chip reads the same clock, so what the human sees is what send() puts in the reply.
  const chip = document.querySelector<HTMLElement>('#ctxrow [data-key="trace"] span');
  if (chip && !info.peek) chip.textContent = `${info.path.id} · hop ${Math.max(1, Math.ceil(info.t))}/${info.n}`;
}

/** The vertical walk under a pinned path row in the Layers tab: built per render, patched by renderTrace. */
export function renderWalk(app: App, info: TraceInfo): HTMLElement {
  const state = app.push!.state;
  lastK = -1; // a fresh mount scrolls its current row into view
  const nodeLabels = new Map(state.graph.nodes.map((n) => [n.id, n.label]));
  const walk = document.createElement("div");
  walk.className = "walk";
  walk.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while scrubbing
    scrub = true;
    seek(app, trackT(app, e.clientY), false);
  });
  for (let j = 0; j <= info.n; j++) {
    const id = info.nodeIds[j] ?? "";
    const label = nodeLabels.get(id) ?? (id || "—");
    const node = document.createElement("div");
    node.className = "wnode";
    node.dataset.j = String(j);
    node.innerHTML = `<i class="tick"></i><span class="label"></span>`;
    (node.children[1] as HTMLElement).textContent = label;
    node.title = `${id} · ${label}`;
    walk.appendChild(node);
    if (j === info.n) break;
    const st = info.path.steps[j]!;
    const broken = info.broken && j === info.broken.hop - 1;
    const hop = document.createElement("div");
    hop.className = "whop" + (broken ? " broken" : "");
    hop.dataset.j = String(j);
    hop.innerHTML = `<span class="edge"></span><span class="cap"></span>`;
    (hop.children[0] as HTMLElement).textContent = (info.steps[j]?.edge.label ?? "") || st.edge;
    (hop.children[1] as HTMLElement).textContent = broken
      ? `hop ${info.broken!.hop} is broken — ${st.edge} ${info.broken!.reason === "edge pruned" ? "no longer exists" : "leaves the layer"}`
      : st.caption || "no caption on this hop";
    walk.appendChild(hop);
  }
  return walk;
}

function resizeHandle(): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const corner of CORNERS) {
    const h = document.createElement("i");
    h.className = `resize-handle ${corner}`;
    f.appendChild(h);
  }
  return f;
}
