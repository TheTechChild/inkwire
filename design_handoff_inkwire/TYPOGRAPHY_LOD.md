# Typography & level-of-detail spec (zoomed-out legibility)

Status: proposed, 2026-09-01. Complements `SPEC.md`; where they conflict on
text rendering below zoom 0.75, this file wins.

## Problem

Canvas text scales 1:1 with the world layer (`transform: scale(zoom)`,
`src/ui/canvas.ts`). `clampZoom` floors at 0.35, which is where "fit whole
board" lands on a 27" 1440p display (~109 ppi, DPR 1). At that zoom:

| Text            | World px | Face / weight             | Screen px at 0.35 |
|-----------------|----------|---------------------------|-------------------|
| node label      | 16       | Barlow Condensed 600      | 5.6               |
| kicker          | 9.5      | IBM Plex Mono 400         | 3.3               |
| ref line        | 10       | IBM Plex Mono 400         | 3.5               |
| edge label      | 11       | IBM Plex Mono 400 (SVG)   | 3.9               |

Nothing is legible below ~10 screen px on this display, so a font swap alone
cannot fix it. Two changes, in priority order:

1. Level-of-detail (LOD) tiers keyed to zoom, with node geometry fixed.
2. A typeface with open apertures / large x-height, and a slightly heavier
   weight at small effective sizes.

Also fix, in the same pass: note bodies render as one unwrapped line and
overflow the node (visible in screenshots at fit-to-board).

## 1. LOD tiers

Add a pure function in `src/core/` (no I/O):

```ts
export type Lod = "full" | "compact" | "dot";
export const ZOOM_STEPS = [0.35, 0.5, 0.75, 1, 1.5, 2.4] as const;
export function quantizeZoom(z: number): number; // nearest step <= z
export function lodFor(zoom: number): Lod;
//   zoom >= 0.75 -> "full"
//   0.5 <= zoom < 0.75 -> "compact"
//   zoom < 0.5 -> "dot"
```

Both renderers call it: the panel from the viewport zoom, `render-svg.ts`
from the viewport it is given. Contract-test that they agree.

Screen-pixel floors (1440p, DPR 1; may be relaxed on HiDPI later):

- node label: never below 12 screen px, weight 600
- mono text: never below 10 screen px, weight 500
- anything that would fall below its floor is hidden by tier, never shrunk

What each tier renders inside the existing node box (box size never changes):

| Tier    | Label                                            | Kicker                    | Ref line | Edge labels                     |
|---------|--------------------------------------------------|---------------------------|----------|---------------------------------|
| full    | 16 world px, as today                            | full (`SERVICE · claude`) | shown    | shown                           |
| compact | `max(16px, 12px / zoom)` world, 1 line, ellipsis | kind only (no `· claude`) | hidden   | shown                           |
| dot     | `max(16px, 12px / zoom)` world, 1 line, ellipsis | hidden                    | hidden   | hidden; show on hover/selection |

Panel implementation:

- Quantize zoom before deriving tier or CSS vars so nothing recomputes every
  frame during pan/zoom (tldraw's `getEfficientZoomLevel` pattern).
- Set `style="--zoom: <quantized>"` and `data-lod="<tier>"` on `#world`.
  All tier behavior is CSS on those two attributes; no per-node JS.
- Hide by tier, not by computed pixel size, to avoid the Cytoscape
  `min-zoomed-font-size` failure mode where labels vanish in a narrow band
  of intermediate zooms.
- Edge labels are SVG `<text>`; apply the same `--zoom`/`data-lod` rules
  (font-size via `calc`, visibility via tier).

Server SVG (`src/server/render-svg.ts`):

- Call `lodFor(vp.zoom)` and emit the same subset of elements at the same
  sizes. `screenshot`/`fitViewport` output must match the panel at the same
  viewport.

## 2. Typeface and weight

Rationale: at small sizes, legibility depends on open apertures (c, e, s, a
don't close into blobs), ample counters, large x-height, uniform stroke, and
distinct I/l/1 and 0/O. Condensed faces give all of that up first, so
Barlow Condensed is the wrong face for labels that are ever seen small.

Decision (pick one; default is A):

- **A. IBM Plex Sans** for node labels (SemiBold 600). Pairs with the
  existing IBM Plex Mono; large x-height, open counters, seriffed I and
  tailed l. Static weights only (no variable axis) — load 500 and 600.
- **B. Atkinson Hyperlegible Next** for node labels (600). Purpose-built for
  small/blurry rendering; variable font on Google Fonts.
- **C. Barlow Semi Condensed 600** if keeping the current look matters more
  than legibility. Smallest change, weakest result.

Mono stays IBM Plex Mono; raise canvas mono from 400 to 500 and keep the
existing letter-spacing on the kicker (tracking helps at small sizes). Do not
use 700 anywhere on the canvas; counters fill in below ~12 screen px.

Where to change:

- `src/shared/tokens.ts` `RENDER.fontHeading` (resvg reads this)
- `src/ui/styles.css` `--font-heading`, the `@import` weights, `.node-label`,
  `.node-kicker`/ref rules, and the edge-label inline style in `canvas.ts`
- `assets/fonts/`: add the `.ttf`/`.otf` files for the chosen face so the
  resvg fallback (`rasterize.ts` already loads this dir) matches the panel
  instead of falling back to system sans-serif. Keep `tokens.ts` and
  `styles.css` in step per `CLAUDE.md`.

## 3. Note wrapping

Note nodes must wrap body text within the node width (`white-space: normal`,
`overflow-wrap: anywhere`, clamp lines by tier: full = unclamped, compact =
3 lines, dot = 1 line). `render-svg.ts` needs a simple word-wrap for the SVG
path since resvg does not wrap `<text>`.

## Acceptance

- At zoom 0.35 on a 1440p display, every visible label is >= 12 screen px
  and every visible mono string >= 10 screen px.
- Zooming continuously from 0.35 to 2.4 never causes a label to disappear
  and reappear.
- `canvas_screenshot` at fit-to-board shows the same elements as the panel
  at the same viewport (structural parity test extended to LOD).
- Node boxes and edge geometry are byte-identical across tiers.
