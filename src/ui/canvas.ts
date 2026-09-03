// Canvas: grid, pan/zoom, the six tools, hit-testing, and world rendering.
// All hit-testing happens in world coordinates on the container — node divs
// are pointer-events: none. Gestures commit ONE intent, on release.
import { edgeEndpoints, resizeBox } from "../core/geometry.js";
import type { Corner } from "../core/geometry.js";
import { liveMembers, pathsAffected, tiers, traceT } from "../core/layers.js";
import type { PathBreak } from "../core/layers.js";
import { edgeLabel, labelPx, lodFor, monoPx, quantizeZoom, wrapText } from "../core/lod.js";
import type { App, Drag, Tool } from "./app.js";
import { KIND_META, clampZoom, el, focusLayer, focusedLayer } from "./app.js";
import type { Box, EdgeEl, Layer, Path, PathStep, Point, Trace } from "../shared/types.js";
import { toast } from "./panel.js";

const HINTS: Record<Tool, string> = {
  select: "drag a node to move · drag a corner to resize · drag empty space or middle-drag to pan",
  pen: "draw freely — structure comes later",
  box: "drag to place a node",
  arrow: "click the source node",
  text: "click to drop a note",
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
    if (e.key === "Escape") {
      app.sel = null;
      app.pendingFrom = null;
      if (app.push?.state.focus) focusLayer(app, null);
      if (app.push?.session.highlight) app.send({ type: "highlight_set", msg_id: null });
      if (app.push?.session.trace) app.send({ type: "trace_set", path_id: null });
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
  // Chip hold and track scrub both release on window: chips are rebuilt on
  // every render, so nothing may live on the chip element.
  window.addEventListener("pointermove", (e) => {
    if (scrub) seek(app, trackT(app, e.clientX), false);
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
  // Gotcha 1: the canvas captures the pointer on pointerdown, which would
  // retarget the gesture away from any button inside it. Stop it at the bar.
  el("layerbar").addEventListener("pointerdown", (e) => e.stopPropagation());
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      app.space = false;
      app.render();
    }
  });

  host.addEventListener("pointerdown", (e) => {
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
      case "text":
        app.send({ type: "add_node", label: "note", kind: "note", at: p, size: [190, 56] });
        app.tool = "select";
        break;
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
  el("hint").textContent =
    info && !info.peek
      ? `scrubbing ${info.path.id} · ← → step a hop · esc closes`
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
  renderLayerBar(app);
  if (!state) return;

  // Layer tiers: every element resolves to in / rim / out; CSS carries the look.
  const t = tiersOf(app);
  if (info) world.dataset.trace = "on";
  else delete world.dataset.trace;
  // Highlight: the agent's pointer. Members lift to full strength whatever
  // their tier; everything else dims (never blurs) when the dim pref is on.
  // A trace is the stronger pointer: the highlight reads as null while one plays.
  const hl = info ? null : (app.push?.session.highlight ?? null);
  const hlNodes = new Set(hl?.nodes ?? []);
  const hlEdges = new Set(hl?.edges ?? []);
  world.dataset.hl = hl ? (app.dim ? "dim" : "on") : "";
  const hlOf = (member: boolean) => (hl ? (member ? "in" : "out") : "");

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
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", lit ? "var(--color-accent-600)" : ai ? "var(--color-accent)" : selected ? "var(--color-text)" : "var(--color-accent-700)");
    path.setAttribute("stroke-width", lit ? "2.6" : selected ? "2" : "1.3");
    if (ai || e.kind === "async") path.setAttribute("stroke-dasharray", "6 4");
    path.setAttribute("marker-end", ai ? "url(#arwai)" : "url(#arw)");
    g.appendChild(path);

    const labelText = info ? (info.pathEdges.has(e.id) ? edgeLabel(e, selected) : "") : tier === "in" || lit ? edgeLabel(e, selected) : "";
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
    const div = document.createElement("div");
    div.className = "node-box blueprint";
    div.dataset.id = n.id;
    div.dataset.kind = n.kind;
    div.dataset.tier = t.node(n.id);
    div.dataset.hl = hlOf(lit);
    // Walk nodes leave border and shadow to CSS: inline would beat [data-trace].
    Object.assign(div.style, {
      left: `${box[0]}px`,
      top: `${box[1]}px`,
      width: `${box[2]}px`,
      height: `${box[3]}px`,
      border: walk && !selected && !pending
        ? ""
        : lit
        ? "2px solid var(--color-accent-600)"
        : selected || pending
          ? "1.5px solid var(--color-accent)"
          : ai
            ? "1.5px dashed var(--color-accent-500)"
            : "1px solid var(--color-divider)",
      boxShadow: walk && !selected
        ? ""
        : lit
          ? "0 0 0 4px color-mix(in srgb, var(--color-accent) 28%, transparent), var(--shadow-md)"
          : selected
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
    kicker.innerHTML = `<span></span><span></span>`;
    (kicker.children[0] as HTMLElement).textContent = meta.label;
    (kicker.children[1] as HTMLElement).textContent = ai ? "· claude" : "";
    const label = document.createElement("div");
    label.className = "node-label";
    label.textContent = n.kind === "note" ? wrapNote(n.label, box, qz) : n.label;
    const ref = document.createElement("div");
    ref.className = "node-ref";
    ref.textContent = n.endpoint || n.ref || "unbound";
    div.append(kicker, label, ref);
    if (selected) div.appendChild(resizeHandle());
    nodes.appendChild(div);
  }
  renderTrace(app);
  ensureLoop(app);
}

/**
 * Gotcha 2: -webkit-line-clamp never engages in this engine, so note labels
 * wrap and clamp in JS (core/lod.ts wrapText) — 3 lines at compact, 1 at dot,
 * as many as the box holds at full. The label is white-space: pre-line.
 */
function wrapNote(label: string, box: Box, qz: number): string {
  const px = labelPx(qz);
  const lod = lodFor(qz);
  // ponytail: 0.55em glyph estimate and 1.1 line-height mirror styles.css; measure if fonts change.
  const maxLines = lod === "compact" ? 3 : lod === "dot" ? 1 : Math.max(1, Math.floor((box[3] - 16) / (px * 1.1)));
  return wrapText(label, Math.floor((box[2] - 22) / (px * 0.55)), maxLines).join("\n");
}

/** Chip bar + focus strip + highlight strip over the canvas. All three live on the server. */
function renderLayerBar(app: App): void {
  const bar = el("layerbar");
  bar.replaceChildren();
  const state = app.push?.state;
  if (!state) return;
  if (state.layers.length > 0) renderLayerChips(app, bar);
  const info = traceInfo(app);
  if (info) renderScrubber(app, bar, info);
  else lastScrubberPath = "";
  const focused = focusedLayer(app);
  if (focused) {
    const strip = document.createElement("div");
    strip.className = "focus-strip";
    strip.innerHTML = `<span class="meta"></span><span class="note"></span>`;
    (strip.children[0] as HTMLElement).textContent = `${focused.letter} · ${liveMembers(focused, state.graph.nodes).size}`;
    (strip.children[1] as HTMLElement).textContent = focused.note;
    bar.appendChild(strip);
  }
  const hl = app.push?.session.highlight;
  if (!hl || info) return;
  const strip = document.createElement("div");
  strip.className = "hl-strip";
  strip.innerHTML = `<span class="diamond">◆</span><span class="kicker">HIGHLIGHT</span><span class="label"></span><span class="count"></span>`;
  (strip.children[2] as HTMLElement).textContent = hl.label;
  (strip.children[3] as HTMLElement).textContent = `${hl.nodes.length} nodes · ${hl.edges.length} edges`;
  const clear = document.createElement("button");
  clear.textContent = "clear · esc";
  clear.title = "clear highlight — esc";
  clear.addEventListener("click", () => app.send({ type: "highlight_set", msg_id: null }));
  strip.appendChild(clear);
  bar.appendChild(strip);
}

function renderLayerChips(app: App, bar: HTMLElement): void {
  const state = app.push!.state;
  const focused = focusedLayer(app);
  const row = document.createElement("div");
  row.className = "layer-chips";
  const lead = document.createElement("span");
  lead.className = "lead";
  lead.textContent = "LAYERS";
  row.appendChild(lead);
  const playing = traceInfo(app)?.layer.id ?? null;
  for (const layer of state.layers) {
    const first = layer.paths[0];
    const chip = document.createElement("button");
    chip.className = "layer-chip" + (layer.id === state.focus ? " on" : "") + (layer.id === playing ? " playing" : "");
    chip.title = layer.note + (first ? `\n\nclick = focus · hold = peek ${first.id} · ${first.title} · ▸ = open the scrubber` : "");
    chip.innerHTML = `<span class="letter"></span><span class="title"></span><span class="count"></span>`;
    (chip.children[0] as HTMLElement).textContent = layer.letter;
    (chip.children[1] as HTMLElement).textContent = layer.title;
    (chip.children[2] as HTMLElement).textContent = String(liveMembers(layer, state.graph.nodes).size);
    chip.addEventListener("click", () => {
      if (hold?.fired) return; // a hold that peeked is not a click
      focusLayer(app, layer.id);
    });
    if (first) {
      // Hold 230 ms → peek the first path; the window pointerup ends it.
      chip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (hold) window.clearTimeout(hold.timer);
        const h = { timer: 0, fired: false };
        h.timer = window.setTimeout(() => {
          h.fired = true;
          peek = { layer_id: layer.id, path_id: first.id, at: Date.now() };
          app.render();
        }, 230);
        hold = h;
      });
      chip.addEventListener("pointerleave", () => {
        if (hold && !hold.fired) {
          window.clearTimeout(hold.timer); // an aborted press must not peek later
          hold = null;
        } else if (hold?.fired) endPeek(app);
      });
      const seg = document.createElement("span");
      seg.className = "paths";
      seg.textContent = `▸ ${layer.paths.length}`;
      seg.title = `open the scrubber on ${first.id} — stays open, no loop`;
      seg.addEventListener("pointerdown", (e) => e.stopPropagation());
      seg.addEventListener("click", (e) => {
        e.stopPropagation();
        app.send({ type: "trace_set", path_id: first.id });
      });
      chip.appendChild(seg);
    }
    row.appendChild(chip);
  }
  if (focused) {
    const release = document.createElement("button");
    release.className = "layer-release";
    release.textContent = "show all · esc";
    release.addEventListener("click", () => focusLayer(app, null));
    row.appendChild(release);
  }
  bar.appendChild(row);
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
let lastScrubberPath = "";

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

function endPeek(app: App): void {
  if (!peek) return;
  peek = null;
  app.render();
}

/** Play / pause the pinned trace from its live position; at the end, play again from 0. */
export function togglePlay(app: App): void {
  const info = traceInfo(app);
  if (!info || info.peek) return;
  if (info.running) app.send({ type: "trace_run", running: false, t: info.t });
  else app.send({ type: "trace_run", running: true, t: info.t >= info.nGood ? 0 : info.t });
}

/** The track position under clientX, in hops. */
function trackT(app: App, clientX: number): number {
  const track = document.querySelector<HTMLElement>(".scrubber .track");
  const info = track && traceInfo(app);
  if (!track || !info) return 0;
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * info.n; // seek clamps to nGood
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

/** Patch the walk's data-trace states, the gold front, and the scrubber from the live t. */
function renderTrace(app: App): void {
  const info = traceInfo(app);
  const group = el("tracegroup");
  group.replaceChildren();
  if (!info) return;
  const state = app.push!.state;
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
      path.setAttribute("stroke-width", String(Math.max(3, 2.5 / app.view.zoom))); // same floor as the CSS done stroke
      path.setAttribute("stroke-dasharray", `${(L * info.frac).toFixed(1)} ${(L + 20).toFixed(1)}`);
      const head = document.createElementNS(SVG_NS, "rect");
      const hs = Math.max(9, 7.5 / app.view.zoom); // the head square keeps a screen floor too
      head.setAttribute("x", (p1[0] + (p2[0] - p1[0]) * info.frac - hs / 2).toFixed(1));
      head.setAttribute("y", (p1[1] + (p2[1] - p1[1]) * info.frac - hs / 2).toFixed(1));
      head.setAttribute("width", String(hs));
      head.setAttribute("height", String(hs));
      head.setAttribute("fill", "var(--color-signal)");
      head.setAttribute("stroke", "var(--color-bg)");
      head.setAttribute("stroke-width", "1.5");
      group.append(path, head);
    }
  }

  // The scrubber.
  const sc = document.querySelector<HTMLElement>(".scrubber");
  if (!sc) return;
  const q = <T extends HTMLElement>(sel: string) => sc.querySelector<T>(sel)!;
  const atEnd = info.t >= info.nGood;
  q(".play").textContent = info.running ? "❚❚" : atEnd ? "↺" : "▸";
  q(".play").title = info.running ? "pause" : atEnd ? "play again" : "play";
  const pct = `${((info.t / info.n) * 100).toFixed(2)}%`;
  q(".prog").style.width = pct;
  q(".head").style.left = pct;
  const k = Math.floor(info.t);
  const last = info.nodeIds.length - 1; // the last playable node: below n on a broken path
  const curNode = Math.min(last, k);
  for (const tick of sc.querySelectorAll<HTMLElement>(".tick")) {
    const j = Number(tick.dataset.j);
    tick.dataset.on = j <= k ? "reached" : "";
    tick.classList.toggle("cur", j === curNode);
  }
  // Label widths follow the live track width (the aside can resize it without a rebuild).
  // Below ~90px a slot cannot carry a label: only the current hop, and the first, last and current nodes.
  const track = q(".track");
  const slot = 100 / info.n;
  const dense = track.clientWidth / info.n < 90;
  track.toggleAttribute("data-dense", dense);
  const widePct = Math.min(40, 400 / info.n);
  const wide = `${widePct.toFixed(1)}%`;
  const near = widePct / 2 / slot + 2; // slots the centred current label reaches past its own, plus an end label's two
  // A wide label centred near an end of the track pins to that end instead of overhanging it.
  const pin = (el: HTMLElement, centrePct: number, widthPct: number) => {
    const half = widthPct / 2;
    const at = centrePct - half < 0 ? "start" : centrePct + half > 100 ? "end" : "mid";
    el.style.left = at === "start" ? "0%" : at === "end" ? "100%" : `${centrePct.toFixed(2)}%`;
    el.style.transform = `translateX(${at === "start" ? "0" : at === "end" ? "-100%" : "-50%"})`;
  };
  for (const label of sc.querySelectorAll<HTMLElement>(".tick-label")) {
    const j = Number(label.dataset.j);
    const cur = j === curNode;
    const end = j === 0 || j === info.n;
    label.dataset.on = cur ? "cur" : j <= k ? "reached" : "";
    label.hidden = dense && !(cur || (j === 0 && curNode > near) || (j === last && last - curNode > near));
    const w = end ? slot * (dense ? 2 : 0.46) : cur && dense ? widePct : slot * 0.92;
    label.style.maxWidth = cur && !dense && !end ? `calc(${w.toFixed(1)}% + 8px)` : `${w.toFixed(1)}%`; // + its padding
    if (!end) pin(label, j * slot, w);
  }
  for (const hop of sc.querySelectorAll<HTMLElement>(".hop")) {
    const j = Number(hop.dataset.j);
    hop.classList.toggle("lit", !hop.classList.contains("broken") && (j < k || (j === info.i && info.frac >= 0.5)));
    hop.hidden = dense && j !== info.i;
    const w = dense ? widePct : slot * 0.88;
    hop.style.maxWidth = `${w.toFixed(1)}%`;
    pin(hop, (j + 0.5) * slot, w);
  }
  const st = info.path.steps[info.i]!;
  const edge = state.graph.edges.find((e) => e.id === st.edge);
  const clip = (s: string) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
  const label = (id: string) => clip(state.graph.nodes.find((n) => n.id === id)?.label ?? id);
  q(".cap .kicker").textContent = `HOP ${info.i + 1}/${info.n} · ${st.edge}` + (edge ? ` · ${label(edge.from)} → ${label(edge.to)}` : "");
  q(".cap .text").textContent =
    info.broken && info.i === info.broken.hop - 1
      ? `hop ${info.broken.hop} is broken — ${st.edge} ${info.broken.reason === "edge pruned" ? "no longer exists" : "leaves the layer"}`
      : st.caption || "no caption on this hop";
  // The composer's step chip reads the same clock, so what the human sees is what send() puts in the reply.
  const chip = document.querySelector<HTMLElement>('#ctxrow [data-key="trace"] span');
  if (chip && !info.peek) chip.textContent = `${info.path.id} · hop ${Math.max(1, Math.ceil(info.t))}/${info.n}`;
}

/** The timeline across the top of the canvas: three rows, built once per render and patched by renderTrace. */
function renderScrubber(app: App, bar: HTMLElement, info: TraceInfo): void {
  const state = app.push!.state;
  const { tr } = info;
  const pinned = !info.peek;
  const sc = document.createElement("div");
  sc.className = "scrubber" + (info.path.id !== lastScrubberPath ? " mount" : "") + (pinned ? " pinned" : "");
  lastScrubberPath = info.path.id;
  sc.addEventListener("pointerdown", (e) => e.stopPropagation());

  const row = document.createElement("div");
  row.className = "row1";
  row.innerHTML = `<button class="play"></button><span class="kicker">PATH</span><span class="ref"></span><span class="title"></span><span class="count"></span><span class="note"></span>`;
  row.querySelector(".play")!.addEventListener("click", () => togglePlay(app));
  (row.children[2] as HTMLElement).textContent = `${info.layer.letter} · ${info.path.id}`;
  (row.children[3] as HTMLElement).textContent = info.path.title;
  (row.children[4] as HTMLElement).textContent = `${info.n} hops · ${info.nodeIds.length} nodes`;
  (row.children[5] as HTMLElement).textContent = pinned ? "drag to scrub · ← → step" : "peeking · ↵ keeps it open · release to stop";
  if (pinned) {
    const loop = document.createElement("button");
    loop.className = tr.loop ? "loop on" : "loop";
    loop.textContent = "↻ loop";
    loop.title = "loop playback";
    loop.addEventListener("click", () => {
      const live = traceInfo(app); // t at click time, not at build time
      if (live) app.send({ type: "trace_run", running: live.tr.running, loop: !live.tr.loop, t: live.t });
    });
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "close · esc";
    close.title = "close the scrubber — esc";
    close.addEventListener("click", () => app.send({ type: "trace_set", path_id: null }));
    row.append(loop, close);
  }

  const track = document.createElement("div");
  track.className = "track";
  info.path.steps.forEach((st, j) => {
    const edge = state.graph.edges.find((e) => e.id === st.edge);
    const hop = document.createElement("span");
    hop.className = "hop" + (info.broken && j === info.broken.hop - 1 ? " broken" : "");
    hop.dataset.j = String(j);
    hop.textContent = edge?.label || st.edge;
    hop.title = `${st.edge} · ${edge?.label ?? ""}`;
    track.appendChild(hop);
  });
  const base = document.createElement("div");
  base.className = "base";
  const prog = document.createElement("div");
  prog.className = "prog";
  track.append(base, prog);
  info.nodeIds.forEach((id, j) => {
    const node = state.graph.nodes.find((n) => n.id === id);
    const left = `${((j / info.n) * 100).toFixed(2)}%`;
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.dataset.j = String(j);
    tick.style.left = left;
    const label = document.createElement("span");
    label.className = "tick-label";
    label.dataset.j = String(j);
    label.style.left = left; // the ends stay edge-aligned; renderTrace positions and sizes the rest
    label.style.transform = `translateX(${j === 0 ? "0" : j === info.n ? "-100%" : "-50%"})`;
    label.textContent = node?.label ?? id;
    label.title = `${id} · ${node?.label ?? ""}`;
    track.append(tick, label);
  });
  const head = document.createElement("div");
  head.className = "head";
  track.appendChild(head);
  if (pinned) {
    track.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      scrub = true;
      seek(app, trackT(app, e.clientX), false);
    });
  }

  const cap = document.createElement("div");
  cap.className = "cap";
  cap.innerHTML = `<span class="kicker"></span><span class="text"></span>`;

  sc.append(row, track, cap);
  bar.appendChild(sc);
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
