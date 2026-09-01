// Server-side board renderer (SPEC § 6 fallback). Boxes, polylines, text,
// images — deliberately the same small visual vocabulary as the panel,
// reading the same token values (shared/tokens.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { bbox, edgeEndpoints } from "../core/geometry.js";
import type { Collections, Viewport } from "../shared/types.js";
import { DARK, RENDER, type ThemeTokens } from "../shared/tokens.js";

export interface RenderOptions {
  collections: Collections;
  viewport: Viewport;
  width?: number;
  height?: number;
  fit?: boolean;
  theme?: ThemeTokens;
  /** Directory holding stored bitmaps, to inline as data URIs. */
  imagesDir?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderBoardSvg(opts: RenderOptions): string {
  const t = opts.theme ?? DARK;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const c = opts.collections;

  let vp = opts.viewport;
  if (opts.fit) vp = fitViewport(c, width, height);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${RENDER.fontBody}, sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${t.bg}"/>`);
  parts.push(
    `<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="${t.accent700}" stroke-width="1.4"/></marker>` +
      `<marker id="arwai" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="${t.accent}" stroke-width="1.4"/></marker></defs>`,
  );
  parts.push(`<g transform="translate(${vp.x} ${vp.y}) scale(${vp.zoom})">`);

  // Images under everything else.
  for (const img of c.images) {
    const box = c.layout[img.id];
    if (!box) continue;
    const href = opts.imagesDir ? inlineImage(opts.imagesDir, img.src) : null;
    if (href) {
      parts.push(
        `<image x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" href="${href}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else {
      parts.push(
        `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" fill="none" stroke="${t.divider}"/>`,
      );
    }
  }

  // Edges, clipped to node borders.
  for (const e of c.edges) {
    const fromBox = c.layout[e.from];
    const toBox = c.layout[e.to];
    if (!fromBox || !toBox) continue;
    const ai = e.author === "ai";
    const stroke = ai ? t.accent : t.accent700;
    const { p1, p2, mid } = edgeEndpoints(fromBox, toBox, RENDER.edgeGap);
    const dash = e.kind === "async" || ai ? ` stroke-dasharray="6 4"` : "";
    parts.push(
      `<path d="M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]}" fill="none" stroke="${stroke}" stroke-width="1.4"${dash} marker-end="url(#${ai ? "arwai" : "arw"})"/>`,
    );
    const labelText = [e.label, e.condition ? `(${e.condition})` : null, e.schema ? `⟨${e.schema}⟩` : null]
      .filter(Boolean)
      .join(" ");
    if (labelText) {
      const w = Math.max(20, labelText.length * 7);
      parts.push(
        `<rect x="${mid[0] - w / 2}" y="${mid[1] - 20}" width="${w}" height="16" fill="${t.bg}"/>` +
          `<text x="${mid[0]}" y="${mid[1] - 8}" text-anchor="middle" font-family="${RENDER.fontMono}, monospace" font-size="11" fill="${t.text}">${esc(labelText)}</text>`,
      );
    }
  }

  // Nodes: blueprint boxes with a kind kicker and label.
  for (const n of c.nodes) {
    const box = c.layout[n.id];
    if (!box) continue;
    const [x, y, w, h] = box;
    const ai = n.author === "ai";
    const border = ai ? t.accent : t.text;
    const dash = ai ? ` stroke-dasharray="5 3"` : "";
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${t.bg}" stroke="${border}" stroke-width="1"${dash}/>`);
    parts.push(
      `<text x="${x + 10}" y="${y + 18}" font-family="${RENDER.fontMono}, monospace" font-size="10" fill="${t.accent}">${esc(n.kind.toUpperCase())}${ai ? " · claude" : ""}</text>`,
    );
    parts.push(
      `<text x="${x + 10}" y="${y + 40}" font-family="${RENDER.fontHeading}, sans-serif" font-size="16" font-weight="600" fill="${t.text}">${esc(n.label)}</text>`,
    );
    const refLine = n.ref ?? n.endpoint;
    if (refLine) {
      parts.push(
        `<text x="${x + 10}" y="${y + 58}" font-family="${RENDER.fontMono}, monospace" font-size="10" fill="${t.text}" opacity="0.7">${esc(refLine)}</text>`,
      );
    }
  }

  // Ink on top.
  for (const s of c.strokes) {
    const d = s.points.map(([px, py], i) => `${i === 0 ? "M" : "L"} ${px} ${py}`).join(" ");
    parts.push(
      `<path d="${d}" fill="none" stroke="${t.text}" stroke-width="${RENDER.inkWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  parts.push("</g></svg>");
  return parts.join("\n");
}

export function fitViewport(c: Collections, width: number, height: number): Viewport {
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
  for (const box of Object.values(c.layout)) extend(...box);
  for (const s of c.strokes) {
    const b = bbox(s.points);
    extend(b.x, b.y, b.w, b.h);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, zoom: 1 };
  const pad = 40;
  const zoom = Math.min(
    2.4,
    Math.max(0.35, Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1))),
  );
  return { x: pad - minX * zoom, y: pad - minY * zoom, zoom };
}

function inlineImage(imagesDir: string, src: string): string | null {
  if (!src.startsWith("/images/")) return null;
  const file = path.join(imagesDir, path.basename(src));
  try {
    const data = readFileSync(file);
    const mime = file.endsWith(".jpg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}
