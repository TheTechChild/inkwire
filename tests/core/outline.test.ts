import { describe, expect, it } from "vitest";
import { HULL_PAD, boardBounds, hullTitle, inkBounds, layerHulls, outlineView } from "../../plugin/src/core/outline.ts";
import type { EdgeEl, Layer, LayoutMap, NodeEl } from "../../plugin/src/shared/types.ts";

const node = (id: string): NodeEl => ({ id, label: id, kind: "service", ref: null, endpoint: null, from_ink: null, author: "human" });
const edge = (id: string, from: string, to: string): EdgeEl => ({
  id,
  from,
  to,
  label: null,
  schema: null,
  kind: "sync",
  condition: null,
  from_ink: null,
  author: "human",
});
const layer = (id: string, nodes: string[]): Layer => ({
  id,
  letter: id.slice(1),
  title: `layer ${id}`,
  note: "",
  nodes,
  author: "human",
  paths: [],
});

// a, b in L1; c in L2; d loose; ghost is a member that no longer exists.
const nodes = ["a", "b", "c", "d"].map(node);
const layout: LayoutMap = {
  a: [0, 0, 100, 50],
  b: [200, 0, 100, 50],
  c: [0, 300, 100, 50],
  d: [600, 300, 100, 50],
};

describe("outline", () => {
  it("layerHulls pads the live members' union and skips a layer with none placed", () => {
    const hulls = layerHulls([layer("L1", ["a", "b", "ghost"]), layer("L3", ["ghost"])], nodes, layout);
    expect(hulls).toHaveLength(1);
    expect(hulls[0]!.box).toEqual([-HULL_PAD, -HULL_PAD, 300 + HULL_PAD * 2, 50 + HULL_PAD * 2]);
    expect([...hulls[0]!.members]).toEqual(["a", "b"]);
  });

  it("outlineView drops edges inside a hull and collapses the rest to one link per pair", () => {
    const edges = [
      edge("e1", "a", "b"), // inside L1: gone
      edge("e2", "a", "c"), // L1 – L2
      edge("e3", "c", "b"), // L2 – L1, the same pair the other way
      edge("e4", "b", "d"), // L1 – loose d
      edge("e5", "d", "c"), // loose d – L2
    ];
    const view = outlineView([layer("L1", ["a", "b"]), layer("L2", ["c"])], nodes, edges, layout);
    expect(view.loose).toEqual(["d"]);
    expect(view.links.map((l) => l.edges)).toEqual([["e2", "e3"], ["e4"], ["e5"]]);
  });

  it("a node in two layers belongs to the first hull", () => {
    const view = outlineView(
      [layer("L1", ["a", "b"]), layer("L2", ["b", "c"])],
      nodes,
      [edge("e1", "a", "b"), edge("e2", "b", "c")],
      layout,
    );
    // a–b is inside L1; b–c joins L1 to L2.
    expect(view.links.map((l) => l.edges)).toEqual([["e2"]]);
  });

  it("with no layers every placed node is loose and edges stay one link each", () => {
    const view = outlineView([], nodes, [edge("e1", "a", "b")], layout);
    expect(view.hulls).toEqual([]);
    expect(view.loose).toEqual(["a", "b", "c", "d"]);
    expect(view.links).toHaveLength(1);
  });

  it("boardBounds covers boxes and ink, and is null on an empty board", () => {
    expect(boardBounds({}, [])).toBeNull();
    expect(boardBounds(layout, [{ x: -50, y: -50, w: 10, h: 10 }])).toEqual({ x: -50, y: -50, w: 750, h: 400 });
  });

  it("inkBounds uses the geometry when present, else the stored bbox", () => {
    const stored = { x: 1, y: 2, w: 3, h: 4 };
    expect(
      inkBounds([
        { geometry: [[0, 0], [10, 20]], bbox: stored },
        { geometry: [], bbox: stored },
        { bbox: stored },
      ]),
    ).toEqual([{ x: 0, y: 0, w: 10, h: 20 }, stored, stored]);
  });

  it("hullTitle joins the letter and the title", () => {
    expect(hullTitle({ ...layer("L1", ["a"]), letter: "B", title: "edge" })).toBe("B · edge");
  });
});
