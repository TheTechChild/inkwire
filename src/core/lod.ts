// Level-of-detail tiers keyed to zoom (design_handoff_inkwire/TYPOGRAPHY_LOD.md).
// Both renderers (panel, render-svg) call these so they agree on what text
// is visible and how big it is. Node geometry never depends on the tier.

export type Lod = "full" | "compact" | "dot";
export const ZOOM_STEPS = [0.35, 0.5, 0.75, 1, 1.5, 2.4] as const;

/** Nearest step <= z (clamped to the first step). */
export function quantizeZoom(z: number): number {
  let out: number = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) if (s <= z) out = s;
  return out;
}

export function lodFor(zoom: number): Lod {
  return zoom >= 0.75 ? "full" : zoom >= 0.5 ? "compact" : "dot";
}

/** Node label world px: 16 at full, counter-scaled to a 12 screen px floor below. */
export function labelPx(zoom: number): number {
  return Math.max(16, 12 / quantizeZoom(zoom));
}

/** Canvas mono world px: `base` (kicker/ref/edge label) with a 10 screen px floor. */
export function monoPx(zoom: number, base: number): number {
  return Math.max(base, 10 / quantizeZoom(zoom));
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
