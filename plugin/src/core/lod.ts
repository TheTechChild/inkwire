// Level-of-detail tiers keyed to zoom (design_handoff_inkwire/TYPOGRAPHY_LOD.md).
// Both renderers (panel, render-svg) call these so they agree on what text
// is visible and how big it is. Node geometry never depends on the tier.
import type { BBox } from "./geometry.ts";
import { ZOOM_MAX, ZOOM_MIN } from "../shared/types.ts";
import type { Viewport } from "../shared/types.ts";

export { ZOOM_MAX, ZOOM_MIN };

/** Edge labels clip to one line of this many characters (full text on selection). */
export const EDGE_LABEL_CHARS = 40;

export type Lod = "full" | "compact" | "dot" | "outline";
export const ZOOM_STEPS = [0.35, 0.5, 0.75, 1, 1.5, 2.4] as const;

/** Fit never zooms in past this: a board of one small node must not fill the screen. */
export const FIT_MAX = 2.4;
/** Fit margin, screen px. */
export const FIT_PAD = 48;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Nearest step <= z. Below the first step it halves the first step until it is
 * <= z, so a counter-scaled floor (calc(N / --zoom)) never drops under N
 * screen px at any zoom. Above the last step it is the last step.
 */
export function quantizeZoom(z: number): number {
  let out: number = ZOOM_STEPS[0];
  if (z < out) {
    while (out > z && out > ZOOM_MIN / 2) out /= 2;
    return out;
  }
  for (const s of ZOOM_STEPS) if (s <= z) out = s;
  return out;
}

/** Below the first step the nodes inside a layer give way to the layer's outline (core/outline.ts). */
export function lodFor(zoom: number): Lod {
  return zoom >= 0.75 ? "full" : zoom >= 0.5 ? "compact" : zoom >= ZOOM_STEPS[0] ? "dot" : "outline";
}

/**
 * The viewport that shows all of `bounds` in a `width` × `height` view with
 * `pad` px of margin, centred. Never zooms in past FIT_MAX. No bounds (an
 * empty board) → the home view.
 */
export function fitView(bounds: BBox | null, width: number, height: number, pad = FIT_PAD): Viewport {
  if (!bounds) return { x: 0, y: 0, zoom: 1 };
  const zoom = clampZoom(
    Math.min(FIT_MAX, (width - pad * 2) / (bounds.w || 1), (height - pad * 2) / (bounds.h || 1)),
  );
  return {
    x: (width - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.h * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/** Node label world px: 16 at full, counter-scaled to a 12 screen px floor below. */
export function labelPx(zoom: number): number {
  return Math.max(16, 12 / quantizeZoom(zoom));
}

/** Canvas mono world px: `base` (kicker/ref/edge label) with a 10 screen px floor. */
export function monoPx(zoom: number, base: number): number {
  return Math.max(base, 10 / quantizeZoom(zoom));
}

/** Edge label text: label, (condition), ⟨schema⟩ — clipped unless `full`. */
export function edgeLabel(
  e: { label?: string | null; condition?: string | null; schema?: string | null },
  full = false,
): string {
  const text = [e.label, e.condition ? `(${e.condition})` : null, e.schema ? `⟨${e.schema}⟩` : null]
    .filter(Boolean)
    .join(" ");
  return full ? text : (wrapText(text, EDGE_LABEL_CHARS, 1)[0] ?? "");
}

/**
 * Greedy word wrap by character count, clamped to `maxLines` with a trailing
 * ellipsis when truncated. Used by the SVG path, where resvg cannot wrap.
 * ponytail: char-count wrap; swap for measured widths if fonts get wider.
 */
export function wrapText(text: string, maxChars: number, maxLines = Infinity): string[] {
  const cols = Math.max(1, Math.floor(maxChars));
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= cols) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else if (word.length <= cols) {
      lines.push(word);
    } else {
      for (let i = 0; i < word.length; i += cols) lines.push(word.slice(i, i + cols));
    }
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    const rest = lines.slice(maxLines - 1).join(" ");
    kept.push(`${rest.slice(0, cols - 1).trimEnd()}…`);
    return kept;
  }
  return lines;
}
