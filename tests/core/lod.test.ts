import { describe, expect, it } from "vitest";
import {
  EDGE_LABEL_CHARS,
  FIT_MAX,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  clampZoom,
  edgeLabel,
  fitView,
  labelPx,
  lodFor,
  monoPx,
  quantizeZoom,
  wrapText,
} from "../../plugin/src/core/lod.ts";

/** Zooms across the whole camera range, log-spaced. */
const RANGE = Array.from({ length: 400 }, (_, i) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (i / 399));

describe("lod", () => {
  it("quantizeZoom picks the nearest step <= z, and halves the first step below it", () => {
    expect(quantizeZoom(0.2)).toBe(0.175);
    expect(quantizeZoom(0.1)).toBe(0.0875);
    expect(quantizeZoom(0.0875)).toBe(0.0875);
    for (const z of RANGE) {
      expect(quantizeZoom(z)).toBeLessThanOrEqual(z);
      if (z < ZOOM_STEPS[0]) expect(quantizeZoom(z)).toBeGreaterThan(z / 2 - 1e-12);
    }
    expect(quantizeZoom(0.35)).toBe(0.35);
    expect(quantizeZoom(0.49)).toBe(0.35);
    expect(quantizeZoom(0.6)).toBe(0.5);
    expect(quantizeZoom(0.74)).toBe(0.5);
    expect(quantizeZoom(1.2)).toBe(1);
    expect(quantizeZoom(9)).toBe(2.4);
    for (const s of ZOOM_STEPS) expect(quantizeZoom(s)).toBe(s);
  });

  it("lodFor maps zoom to the four tiers, and agrees with the quantized zoom", () => {
    expect(lodFor(ZOOM_MIN)).toBe("outline");
    expect(lodFor(0.349)).toBe("outline");
    expect(lodFor(0.35)).toBe("dot");
    expect(lodFor(0.49)).toBe("dot");
    expect(lodFor(0.5)).toBe("compact");
    expect(lodFor(0.74)).toBe("compact");
    expect(lodFor(0.75)).toBe("full");
    expect(lodFor(2.4)).toBe("full");
    expect(lodFor(ZOOM_MAX)).toBe("full");
    for (const z of RANGE) expect(lodFor(z)).toBe(lodFor(quantizeZoom(z)));
  });

  it("clampZoom keeps the camera in its range", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(clampZoom(0.2)).toBe(0.2);
  });

  it("fitView centres the bounds with a margin, never past FIT_MAX, and far out for a large board", () => {
    expect(fitView(null, 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
    // A small board: capped at FIT_MAX, centred.
    const small = fitView({ x: 100, y: 100, w: 50, h: 20 }, 800, 600);
    expect(small.zoom).toBe(FIT_MAX);
    expect(small.x + (100 + 25) * small.zoom).toBeCloseTo(400);
    expect(small.y + (100 + 10) * small.zoom).toBeCloseTo(300);
    // A large board: the whole thing shows, below the old 0.35 floor.
    const big = fitView({ x: -5000, y: 0, w: 20000, h: 4000 }, 800, 600, 48);
    expect(big.zoom).toBeCloseTo((800 - 96) / 20000);
    expect(lodFor(big.zoom)).toBe("outline");
    expect(big.x + -5000 * big.zoom).toBeCloseTo(48);
  });

  it("text never falls below its screen-px floor at any zoom", () => {
    for (const z of RANGE) {
      expect(labelPx(z) * z).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(monoPx(z, 9.5) * z).toBeGreaterThanOrEqual(10 - 1e-9);
    }
    expect(labelPx(1)).toBe(16);
    expect(labelPx(0.75)).toBe(16);
    expect(monoPx(1, 11)).toBe(11);
  });

  it("wrapText wraps on words, splits long words, and clamps with an ellipsis", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("one two three four", 9, 1)).toEqual(["one two…"]);
    expect(wrapText("api gateway", 8, 1)).toEqual(["api gat…"]);
    expect(wrapText("one two three four five six", 9, 2)).toEqual(["one two", "three fo…"]);
    expect(wrapText("", 10)).toEqual([]);
  });

  it("edgeLabel composes label, condition, schema and clips to one line unless full", () => {
    expect(edgeLabel({ label: "read", condition: "cache miss", schema: "Order" })).toBe("read (cache miss) ⟨Order⟩");
    expect(edgeLabel({})).toBe("");
    const long = { label: "UNAUTHORIZED / NOT_FOUND", condition: "draft without admin, or configId miss at three sites" };
    const clipped = edgeLabel(long);
    expect(clipped.length).toBeLessThanOrEqual(EDGE_LABEL_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(edgeLabel(long, true)).toContain("three sites");
  });
});
