// Client self-capture (SPEC § 6 primary path): render the board to a PNG
// with the same geometry (core/geometry) and tokens (shared/tokens) the
// server-side SVG fallback uses, so the two renderers stay in step.
import { bbox, edgeEndpoints } from "../core/geometry.js";
import { labelPx, lodFor, monoPx, wrapText } from "../core/lod.js";
import { DARK, LIGHT, RENDER } from "../shared/tokens.js";
import type { App } from "./app.js";
import type { Point, Viewport } from "../shared/types.js";

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
    const label = [e.label, e.condition ? `(${e.condition})` : null, e.schema ? `⟨${e.schema}⟩` : null]
      .filter(Boolean)
      .join(" ");
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
    const lines = n.kind === "note" || lod !== "full" ? wrapText(n.label, cols, maxLines) : [n.label];
    lines.forEach((line, i) => ctx.fillText(line, x + 10, y + 40 + i * labelSize * 1.1));
    const refLine = n.ref ?? n.endpoint;
    if (refLine && lod === "full") {
      ctx.globalAlpha = 0.7;
      ctx.font = mono(10);
      ctx.fillText(refLine, x + 10, y + 58);
      ctx.globalAlpha = 1;
    }
  }

  // Ink on top.
  ctx.strokeStyle = t.text;
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

  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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

function fitViewport(
  state: NonNullable<App["push"]>["state"],
  width: number,
  height: number,
): Viewport {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const box of Object.values(state.layout.boxes)) extend(box[0], box[1], box[2], box[3]);
  for (const s of state.ink) {
    if (s.geometry && s.geometry.length > 0) {
      const b = bbox(s.geometry);
      extend(b.x, b.y, b.w, b.h);
    } else {
      extend(s.bbox.x, s.bbox.y, s.bbox.w, s.bbox.h);
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, zoom: 1 };
  const pad = 40;
  const zoom = Math.min(
    2.4,
    Math.max(0.35, Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1))),
  );
  return { x: pad - minX * zoom, y: pad - minY * zoom, zoom };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
