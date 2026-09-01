// Canvas: grid, pan/zoom, the six tools, hit-testing, and world rendering.
// All hit-testing happens in world coordinates on the container — node divs
// are pointer-events: none. Gestures commit ONE intent, on release.
import { edgeEndpoints } from "../core/geometry.js";
import type { App, Drag, Tool } from "./app.js";
import { KIND_META, clampZoom, el } from "./app.js";
import type { Box, Point } from "../shared/types.js";

const HINTS: Record<Tool, string> = {
  select: "drag a node to move · drag its corner to resize · drag empty space to pan",
  pen: "draw freely — structure comes later",
  box: "drag to place a node",
  arrow: "click the source node",
  text: "click to drop a note",
  erase: "click ink, a node, or an edge to remove it",
};

const MIN_NODE_SIZE: Point = [80, 44];
const MIN_IMAGE_SIZE: Point = [24, 24];
/** Resize handle hit zone, in screen px, anchored at the selected box's bottom-right corner. */
const HANDLE_PX = 14;

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
    if (e.key === "Escape") {
      app.sel = null;
      app.pendingFrom = null;
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
    host.focus();
    host.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    if (e.button === 1 || app.space) {
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
          const box = boxOf(app, handle)!;
          app.drag = { type: "resize", id: handle, origin: box, box };
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
        host.style.cursor = hitResizeHandle(app, toWorld(e)) ? "nwse-resize" : "default";
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
      d.box = [
        d.origin[0],
        d.origin[1],
        Math.max(min[0], Math.round(p[0] - d.origin[0])),
        Math.max(min[1], Math.round(p[1] - d.origin[1])),
      ];
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
      if (w !== d.origin[2] || h !== d.origin[3]) app.send({ type: "move", id: d.id, at: [x, y], size: [w, h] });
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
}

function boxOf(app: App, id: string): Box | undefined {
  const box = app.push?.state.layout.boxes[id];
  if (!box) return undefined;
  const d = app.drag;
  if (d && d.type === "node" && d.id === id) return [d.at[0], d.at[1], box[2], box[3]];
  if (d && d.type === "resize" && d.id === id) return d.box;
  return box;
}

/** The selected node's or image's bottom-right resize handle, if `p` is on it. */
function hitResizeHandle(app: App, p: Point): string | null {
  const sel = app.sel;
  if (!sel || sel.type === "edge") return null;
  const box = boxOf(app, sel.id);
  if (!box) return null;
  const hs = HANDLE_PX / app.view.zoom;
  const right = box[0] + box[2];
  const bottom = box[1] + box[3];
  const onX = p[0] >= right - hs && p[0] <= right + hs / 2;
  const onY = p[1] >= bottom - hs && p[1] <= bottom + hs / 2;
  return onX && onY ? sel.id : null;
}

function hitNode(app: App, p: Point): string | null {
  const state = app.push?.state;
  if (!state) return null;
  const ids = [...state.graph.nodes.map((n) => n.id), ...state.images.map((i) => i.id)];
  for (let i = ids.length - 1; i >= 0; i--) {
    const box = state.layout.boxes[ids[i]!];
    if (box && p[0] >= box[0] && p[0] <= box[0] + box[2] && p[1] >= box[1] && p[1] <= box[1] + box[3]) {
      return ids[i]!;
    }
  }
  return null;
}

function hitStroke(app: App, p: Point): string | null {
  for (const s of app.push?.state.ink ?? []) {
    if (s.geometry?.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 12)) return s.id;
  }
  return null;
}

function hitEdge(app: App, p: Point): string | null {
  const state = app.push?.state;
  if (!state) return null;
  for (const e of state.graph.edges) {
    const a = state.layout.boxes[e.from];
    const b = state.layout.boxes[e.to];
    if (!a || !b) continue;
    const { p1, p2 } = edgeEndpoints(a, b);
    if (segmentDistance(p, p1, p2) < 12) return e.id;
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
  grid.style.backgroundImage = "radial-gradient(circle, var(--cv-grid) 1px, transparent 1px)";
  grid.style.backgroundSize = `${(28 * v.zoom).toFixed(1)}px ${(28 * v.zoom).toFixed(1)}px`;
  grid.style.backgroundPosition = `${v.x.toFixed(0)}px ${v.y.toFixed(0)}px`;

  el("canvas").style.cursor = app.space ? "grabbing" : app.tool === "select" ? "default" : "crosshair";
  el("hint").textContent =
    app.tool === "arrow" && app.pendingFrom ? "now click the target node" : HINTS[app.tool];

  const ink = el("inkgroup");
  const edges = el("edgegroup");
  const preview = el("previewgroup");
  const nodes = el("nodelayer");
  ink.replaceChildren();
  edges.replaceChildren();
  preview.replaceChildren();
  nodes.replaceChildren();
  if (!state) return;

  // Ink (server strokes + the in-flight pen gesture).
  const strokes: Point[][] = state.ink.map((s) => s.geometry ?? []);
  if (app.drag?.type === "pen") strokes.push(app.drag.points);
  for (const pts of strokes) {
    if (pts.length < 2) continue;
    const path = document.createElementNS(SVG_NS, "path");
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
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", ai ? "var(--color-accent)" : selected ? "var(--color-text)" : "var(--color-accent-700)");
    path.setAttribute("stroke-width", selected ? "2" : "1.3");
    if (ai || e.kind === "async") path.setAttribute("stroke-dasharray", "6 4");
    path.setAttribute("marker-end", ai ? "url(#arwai)" : "url(#arw)");
    g.appendChild(path);

    const labelText = [e.label, e.condition ? `(${e.condition})` : null, e.schema ? `⟨${e.schema}⟩` : null]
      .filter(Boolean)
      .join(" ");
    if (labelText) {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(mid[0]));
      text.setAttribute("y", String(mid[1] - 8));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("style", "font-family: var(--font-mono); font-size: 11px; fill: var(--color-accent-700)");
      text.textContent = labelText;
      const rect = document.createElementNS(SVG_NS, "rect");
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

    const div = document.createElement("div");
    div.className = "node-box blueprint";
    Object.assign(div.style, {
      left: `${box[0]}px`,
      top: `${box[1]}px`,
      width: `${box[2]}px`,
      height: `${box[3]}px`,
      border: selected || pending
        ? "1.5px solid var(--color-accent)"
        : ai
          ? "1.5px dashed var(--color-accent-500)"
          : "1px solid var(--color-divider)",
      boxShadow: selected ? "var(--shadow-md)" : "none",
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
    label.textContent = n.label;
    const ref = document.createElement("div");
    ref.className = "node-ref";
    ref.textContent = n.endpoint || n.ref || "unbound";
    div.append(kicker, label, ref);
    if (selected) div.appendChild(resizeHandle());
    nodes.appendChild(div);
  }
}

function resizeHandle(): HTMLElement {
  const h = document.createElement("i");
  h.className = "resize-handle";
  return h;
}
