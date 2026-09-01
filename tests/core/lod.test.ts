import { describe, expect, it } from "vitest";
import { EDGE_LABEL_CHARS, ZOOM_STEPS, edgeLabel, labelPx, lodFor, monoPx, quantizeZoom, wrapText } from "../../src/core/lod.js";

describe("lod", () => {
  it("quantizeZoom picks the nearest step <= z and clamps below the first", () => {
    expect(quantizeZoom(0.1)).toBe(0.35);
    expect(quantizeZoom(0.35)).toBe(0.35);
    expect(quantizeZoom(0.49)).toBe(0.35);
    expect(quantizeZoom(0.6)).toBe(0.5);
    expect(quantizeZoom(0.74)).toBe(0.5);
    expect(quantizeZoom(1.2)).toBe(1);
    expect(quantizeZoom(9)).toBe(2.4);
    for (const s of ZOOM_STEPS) expect(quantizeZoom(s)).toBe(s);
  });

  it("lodFor maps zoom to the three tiers, and agrees with the quantized zoom", () => {
    expect(lodFor(0.35)).toBe("dot");
    expect(lodFor(0.49)).toBe("dot");
    expect(lodFor(0.5)).toBe("compact");
    expect(lodFor(0.74)).toBe("compact");
    expect(lodFor(0.75)).toBe("full");
    expect(lodFor(2.4)).toBe("full");
    for (let z = 0.35; z <= 2.4; z += 0.01) expect(lodFor(z)).toBe(lodFor(quantizeZoom(z)));
  });

  it("text never falls below its screen-px floor between 0.35 and 2.4", () => {
    for (let z = 0.35; z <= 2.4; z += 0.01) {
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
