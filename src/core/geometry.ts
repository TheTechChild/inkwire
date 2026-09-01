// Geometry helpers shared by inference and both renderers.
import type { Box, Point } from "../shared/types.js";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function bbox(points: readonly Point[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Closed if the endpoint gap is under 0.3 × the bbox diagonal. */
export function isClosed(points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  const b = bbox(points);
  const diag = Math.hypot(b.w, b.h);
  return dist(points[0]!, points[points.length - 1]!) < diag * 0.3;
}

export interface PlacedNode {
  id: string;
  box: Box;
}

/**
 * Nearest node to a point: distance from the node's center minus half its
 * diagonal, within maxDist px. Returns null when nothing is close enough.
 */
export function nearestNode(
  p: Point,
  nodes: readonly PlacedNode[],
  maxDist = 150,
): PlacedNode | null {
  let best: PlacedNode | null = null;
  let bd = maxDist;
  for (const n of nodes) {
    const [x, y, w, h] = n.box;
    const c: Point = [x + w / 2, y + h / 2];
    const d = Math.max(0, dist(c, p) - Math.hypot(w, h) / 2);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/**
 * Clip the segment between two box centers to the source box's border, with
 * `gap` px of clearance (prototype edgeGeom). Returns the point on the ray
 * from `center` toward `other` where it exits the box.
 */
export function clipToBox(box: Box, other: Point, gap = 6): Point {
  const [x, y, w, h] = box;
  const c: Point = [x + w / 2, y + h / 2];
  const dx = other[0] - c[0];
  const dy = other[1] - c[1];
  const tx = dx === 0 ? Infinity : (w / 2 + gap) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (h / 2 + gap) / Math.abs(dy);
  const t = Math.min(tx, ty);
  if (!isFinite(t)) return c;
  return [c[0] + dx * t, c[1] + dy * t];
}

/** Both endpoints of an edge between two boxes, clipped to their borders. */
export function edgeEndpoints(fromBox: Box, toBox: Box, gap = 6): { p1: Point; p2: Point; mid: Point } {
  const cf: Point = [fromBox[0] + fromBox[2] / 2, fromBox[1] + fromBox[3] / 2];
  const ct: Point = [toBox[0] + toBox[2] / 2, toBox[1] + toBox[3] / 2];
  const p1 = clipToBox(fromBox, ct, gap);
  const p2 = clipToBox(toBox, cf, gap);
  return { p1, p2, mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
}
