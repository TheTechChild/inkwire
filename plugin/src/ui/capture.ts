// Client self-capture (SPEC § 6 primary path): render the board to a PNG
// with the same geometry (core/geometry) and tokens (shared/tokens) the
// server-side SVG fallback uses, so the two renderers stay in step.
import { edgeEndpoints } from "../core/geometry.ts";
import { edgeLabel, fitView, labelPx, lodFor, monoPx, wrapText } from "../core/lod.ts";
import { boardBounds, hullTitle, inkBounds, OUTLINE_STYLE, outlineView } from "../core/outline.ts";
import { DARK, LIGHT, RENDER } from "../shared/tokens.ts";
import type { App } from "./app.ts";
import type { Point, Viewport } from "../shared/types.ts";

export async function captureBoard(
  app: App,
  viewport: Viewport | null,
  fit: boolean,
): Promise<Blob | null> {
  const push = app.push;
  if (!push) return null;
  const state = push.state;
  const t = app.theme === "light" ? LIGHT : DARK;

  const host = document.getElementById("canvas")!;
  const width = Math.max(320, host.clientWidth);
  const height = Math.max(240, host.clientHeight);

  let vp: Viewport = viewport ?? app.view;
  if (fit) vp = fitViewport(state, width, height);

  const canvas = document.createElement("canvas");
  const scale = window.devicePixelRatio > 1 ? 2 : 1;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);

  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(vp.x, vp.y);
  ctx.scale(vp.zoom, vp.zoom);
  // Same tier and text sizes as the panel and render-svg (core/lod.ts).
  const lod = lodFor(vp.zoom);
  const labelSize = labelPx(vp.zoom);
  const mono = (base: number) => `${RENDER.fontMonoWeight} ${monoPx(vp.zoom, base)}px "${RENDER.fontMono}", monospace`;

  // Images first (already loaded in the DOM, so cached).
  for (const img of state.images) {
    const box = state.layout.boxes[img.id];
    if (!box) continue;
    try {
      const bitmap = await loadImage(img.src);
      ctx.drawImage(bitmap, box[0], box[1], box[2], box[3]);
    } catch {
      ctx.strokeStyle = t.divider;
      ctx.strokeRect(box[0], box[1], box[2], box[3]);
    }
  }

  if (lod === "outline") {
    drawOutline(ctx, state, vp.zoom, t.text, t.bg);
    drawInk(ctx, state, t.text);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  // Edges.
  for (const e of state.graph.edges) {
    const fromBox = state.layout.boxes[e.from];
    const toBox = state.layout.boxes[e.to];
    if (!fromBox || !toBox) continue;
    const ai = e.author === "ai";
    const { p1, p2, mid } = edgeEndpoints(fromBox, toBox, RENDER.edgeGap);
    ctx.strokeStyle = ai ? t.accent : t.accent700;
    ctx.lineWidth = 1.4;
    ctx.setLineDash(ai || e.kind === "async" ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();
    drawArrowHead(ctx, p1, p2);
    ctx.setLineDash([]);
    const label = edgeLabel(e);
    if (label && lod !== "dot") {
      ctx.font = mono(11);
      const size = monoPx(vp.zoom, 11);
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = t.bg;
      ctx.fillRect(mid[0] - w / 2, mid[1] - 8 - size * 0.9, w, size * 1.4);
      ctx.fillStyle = t.text;
      ctx.textAlign = "center";
      ctx.fillText(label, mid[0], mid[1] - 8);
      ctx.textAlign = "left";
    }
  }

  // Nodes.
  for (const n of state.graph.nodes) {
    const box = state.layout.boxes[n.id];
    if (!box) continue;
    const [x, y, w, h] = box;
    const ai = n.author === "ai";
    ctx.fillStyle = t.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = ai ? t.accent : t.text;
    ctx.lineWidth = 1;
    ctx.setLineDash(ai ? [5, 3] : []);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (lod !== "dot") {
      ctx.fillStyle = t.accent;
      ctx.font = mono(10);
      ctx.fillText(`${n.kind.toUpperCase()}${ai && lod === "full" ? " · claude" : ""}`, x + 10, y + 18);
    }
    ctx.fillStyle = t.text;
    ctx.font = `${RENDER.fontHeadingWeight} ${labelSize}px "${RENDER.fontHeading}", sans-serif`;
    const cols = (w - 20) / (labelSize * 0.55);
    const maxLines = n.kind === "note" ? { full: Infinity, compact: 3, dot: 1 }[lod] : lod === "full" ? Infinity : 1;
    const lines = lod !== "full" ? wrapText(n.label, cols, maxLines) : [n.label];
    lines.forEach((line, i) => ctx.fillText(line, x + 10, y + 40 + i * labelSize * 1.1));
    const refLine = n.ref ?? n.endpoint;
    if (refLine && lod === "full") {
      ctx.globalAlpha = OUTLINE_STYLE.titleAlpha;
      ctx.font = mono(10);
      ctx.fillText(refLine, x + 10, y + 58);
      ctx.globalAlpha = 1;
    }
  }

  drawInk(ctx, state, t.text);
  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

type State = NonNullable<App["push"]>["state"];

/** Ink on top. */
function drawInk(ctx: CanvasRenderingContext2D, state: State, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = RENDER.inkWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of state.ink) {
    const pts = s.geometry;
    if (!pts || pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
    ctx.stroke();
  }
}

/** The outline tier, as render-svg draws it (core/outline.ts): hairlines, loose boxes, hulls with titles. */
function drawOutline(ctx: CanvasRenderingContext2D, state: State, zoom: number, fg: string, bg: string): void {
  const view = outlineView(state.layers, state.graph.nodes, state.graph.edges, state.layout.boxes);
  const hair = 1 / zoom;
  ctx.strokeStyle = fg;
  ctx.lineWidth = hair;
  ctx.globalAlpha = OUTLINE_STYLE.linkAlpha;
  for (const l of view.links) {
    const { p1, p2 } = edgeEndpoints(l.a, l.b, 0);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const id of view.loose) {
    const [x, y, w, h] = state.layout.boxes[id]!;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = OUTLINE_STYLE.looseAlpha;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
  ctx.font = `${RENDER.fontMonoWeight} ${OUTLINE_STYLE.titlePx / zoom}px "${RENDER.fontMono}", monospace`;
  for (const h of view.hulls) {
    const [x, y, w, hh] = h.box;
    ctx.globalAlpha = OUTLINE_STYLE.hullAlpha;
    ctx.setLineDash(OUTLINE_STYLE.dash.map((d) => d * hair));
    ctx.strokeRect(x, y, w, hh);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = fg;
    ctx.fillText(hullTitle(h.layer), x, y - OUTLINE_STYLE.titleGap / zoom);
    ctx.globalAlpha = 1;
  }
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const size = 7;
  ctx.beginPath();
  ctx.moveTo(to[0] - size * Math.cos(angle - 0.45), to[1] - size * Math.sin(angle - 0.45));
  ctx.lineTo(to[0], to[1]);
  ctx.lineTo(to[0] - size * Math.cos(angle + 0.45), to[1] - size * Math.sin(angle + 0.45));
  ctx.stroke();
}

function fitViewport(state: State, width: number, height: number): Viewport {
  return fitView(boardBounds(state.layout.boxes, inkBounds(state.ink)), width, height);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
