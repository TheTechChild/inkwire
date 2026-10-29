// The server render must never take the daemon down. resvg 2.6.2 panics on an
// SVG marker whose edge ends far outside the image (a 380-node board at fit
// zoom), and a Rust panic aborts the process. So the renderer draws arrowheads
// as plain paths, and the daemon rasterizes in a child process.
import { describe, expect, it } from "vitest";
import { arrowHead, renderBoardSvg } from "../../plugin/src/server/render-svg.ts";
import { rasterizeIsolated } from "../../plugin/src/server/rasterize.ts";
import type { Collections } from "../../plugin/src/shared/types.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// The SVG that crashed the daemon: an edge with an arrow marker that ends far off the image.
const PANIC_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs>` +
  `<marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
  `<path d="M 0 1 L 9 5 L 0 9" stroke="#000"/></marker></defs>` +
  `<path d="M 10 10 L 5000 5000" stroke="#000" marker-end="url(#m)"/></svg>`;

function wideBoard(): Collections {
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    id: `n${i}`,
    kind: "service",
    label: `node ${i}`,
    author: "ai",
  }));
  const layout = Object.fromEntries(nodes.map((n, i) => [n.id, [(i % 10) * 2400, Math.floor(i / 10) * 1500, 180, 60]]));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: "n0", to: n.id, author: "ai" }));
  return { nodes, edges, strokes: [], images: [], layout } as unknown as Collections;
}

describe("server render isolation", () => {
  it("rejects with the panic line when resvg panics, and the caller lives on", async () => {
    await expect(rasterizeIsolated(PANIC_SVG)).rejects.toThrow(/server render failed.*panicked/);
    const png = await rasterizeIsolated(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`);
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it("renders a board far wider than the image at fit and at a fixed zoom", async () => {
    const c = wideBoard();
    for (const opts of [{ fit: true }, { fit: false }]) {
      const svg = renderBoardSvg({ collections: c, viewport: { x: 0, y: 0, zoom: 0.35 }, ...opts });
      expect(svg).not.toContain("marker");
      const png = await rasterizeIsolated(svg);
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
  });

  it("draws no arrowhead on a zero-length edge", () => {
    expect(arrowHead([5, 5], [5, 5])).toBeNull();
    expect(arrowHead([0, 0], [100, 0])).toBe("M 91.2 3.9 L 100 0 L 91.2 -3.9");
  });
});
