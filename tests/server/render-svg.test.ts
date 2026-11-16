// The server render draws the same tiers as the panel (core/lod.ts), the
// outline tier included (core/outline.ts).
import { describe, expect, it } from "vitest";
import { fitViewport, renderBoardSvg } from "../../plugin/src/server/render-svg.ts";
import { lodFor } from "../../plugin/src/core/lod.ts";
import type { Collections, Layer } from "../../plugin/src/shared/types.ts";

function board(): { c: Collections; layers: Layer[] } {
  const nodes = ["api", "auth", "db", "loose"].map((id) => ({
    id,
    kind: "service",
    label: `label-${id}`,
    ref: null,
    endpoint: null,
    author: "human",
  }));
  const layout = {
    api: [0, 0, 180, 60],
    auth: [6000, 0, 180, 60],
    db: [0, 3000, 180, 60],
    loose: [6000, 3000, 180, 60],
  } as Collections["layout"];
  const edges = [
    { id: "e1", from: "api", to: "auth", kind: "sync", author: "human" },
    { id: "e2", from: "api", to: "db", kind: "sync", author: "human" },
  ];
  const layers = [
    { id: "L1", letter: "A", title: "edge", note: "", nodes: ["api", "auth"], author: "human", paths: [] },
  ] as Layer[];
  return { c: { nodes, edges, strokes: [], images: [], layout } as unknown as Collections, layers };
}

describe("render-svg", () => {
  it("fit frames a large board below the old 0.35 floor, in the outline tier", () => {
    const { c } = board();
    const vp = fitViewport(c, 1280, 800);
    expect(vp.zoom).toBeLessThan(0.35);
    expect(lodFor(vp.zoom)).toBe("outline");
  });

  it("the outline tier draws hull titles and no node text", () => {
    const { c, layers } = board();
    const svg = renderBoardSvg({ collections: c, layers, viewport: { x: 0, y: 0, zoom: 1 }, fit: true });
    expect(svg).toContain("A · edge");
    expect(svg).not.toContain("label-");
    // api and auth share the hull: their edge is gone. api–db becomes one hairline.
    expect(svg.match(/<path /g)).toHaveLength(1);
  });

  it("near in, the same board draws node text and no hull", () => {
    const { c, layers } = board();
    const svg = renderBoardSvg({ collections: c, layers, viewport: { x: 0, y: 0, zoom: 1 } });
    expect(svg).toContain("label-api");
    expect(svg).not.toContain("A · edge");
  });
});
