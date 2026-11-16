// The outline tier (lodFor → "outline"): far out, the nodes inside a layer
// give way to the layer's hull, and edges collapse to one hairline per pair of
// hulls. All three renderers (panel, panel capture, render-svg) and the
// minimap read this, so they agree on what the far view shows. Pure.
import { bbox, boxToBBox, unionBox } from "./geometry.ts";
import type { BBox } from "./geometry.ts";
import { liveMembers } from "./layers.ts";
import type { Box, EdgeEl, Layer, LayoutMap, NodeEl, StrokeSummary } from "../shared/types.ts";

/**
 * One outline look for all three renderers. Alphas are of the text colour;
 * dash is in hairlines (1 / zoom); title size and gap are screen px. The panel
 * CSS (styles.css, "outline") mirrors the alphas.
 */
export const OUTLINE_STYLE = {
  linkAlpha: 0.35,
  hullAlpha: 0.45,
  looseAlpha: 0.6,
  titleAlpha: 0.7,
  dash: [4, 3],
  titlePx: 10,
  titleGap: 5,
} as const;

/** The hull title: the layer letter and its title. */
export function hullTitle(layer: Layer): string {
  return `${layer.letter} · ${layer.title}`;
}

/** The box of each stroke: its geometry when the summary carries it, else its stored bbox. */
export function inkBounds(ink: Pick<StrokeSummary, "geometry" | "bbox">[]): BBox[] {
  return ink.map((s) => (s.geometry && s.geometry.length > 0 ? bbox(s.geometry) : s.bbox));
}

/** Hull margin around the member boxes, world px. */
export const HULL_PAD = 22;

export interface Hull {
  layer: Layer;
  box: Box;
  /** The live member ids that have a box. */
  members: Set<string>;
}

/** One hull per layer that has at least one placed live member, in layer order. */
export function layerHulls(layers: Layer[], nodes: NodeEl[], layout: LayoutMap): Hull[] {
  const out: Hull[] = [];
  for (const layer of layers) {
    const members = new Set([...liveMembers(layer, nodes)].filter((id) => layout[id]));
    const u = unionBox([...members].map((id) => boxToBBox(layout[id]!)));
    if (!u) continue;
    out.push({
      layer,
      box: [u.x - HULL_PAD, u.y - HULL_PAD, u.w + HULL_PAD * 2, u.h + HULL_PAD * 2],
      members,
    });
  }
  return out;
}

/** A hairline between two outline units (a hull or a loose node). Undirected. */
export interface OutlineLink {
  a: Box;
  b: Box;
  /** The edge ids that collapsed into this link. */
  edges: string[];
}

export interface OutlineView {
  hulls: Hull[];
  /** Placed nodes in no layer: they still draw, as plain boxes. */
  loose: string[];
  links: OutlineLink[];
}

/**
 * The far view. A node in more than one layer belongs to the first hull that
 * holds it. An edge inside one hull goes; the rest collapse to one link per
 * unordered pair of units.
 */
export function outlineView(layers: Layer[], nodes: NodeEl[], edges: EdgeEl[], layout: LayoutMap): OutlineView {
  const hulls = layerHulls(layers, nodes, layout);
  const unitOf = new Map<string, { key: string; box: Box }>();
  for (const h of hulls) {
    for (const id of h.members) if (!unitOf.has(id)) unitOf.set(id, { key: `L:${h.layer.id}`, box: h.box });
  }
  const loose: string[] = [];
  for (const n of nodes) {
    const box = layout[n.id];
    if (!box || unitOf.has(n.id)) continue;
    loose.push(n.id);
    unitOf.set(n.id, { key: `N:${n.id}`, box });
  }
  const byPair = new Map<string, OutlineLink>();
  for (const e of edges) {
    const a = unitOf.get(e.from);
    const b = unitOf.get(e.to);
    if (!a || !b || a.key === b.key) continue;
    const pair = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    const link = byPair.get(pair);
    if (link) link.edges.push(e.id);
    else byPair.set(pair, { a: a.box, b: b.box, edges: [e.id] });
  }
  return { hulls, loose, links: [...byPair.values()] };
}

/** Everything that draws: node and image boxes plus the ink. Null on an empty board. */
export function boardBounds(layout: LayoutMap, ink: Iterable<BBox>): BBox | null {
  return unionBox([...Object.values(layout).map(boxToBBox), ...ink]);
}
