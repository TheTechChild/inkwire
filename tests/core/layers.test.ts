// Layer math: letters, downstream BFS, tiers, and the scoped read.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Sim, makeEdge, makeNode } from "../helpers.js";
import { buildCanvasState } from "../../src/core/state.js";
import {
  HOP_MS,
  REST_MS,
  downstream,
  liveMembers,
  nextLetter,
  nextPathId,
  pathNodes,
  pathsAffected,
  resolveNodesToSteps,
  scopeState,
  tiers,
  traceT,
  validateWalk,
} from "../../src/core/layers.js";
import type { CanvasState, Collections, Layer, Path } from "../../src/shared/types.js";

function layer(nodes: string[], over: Partial<Layer> = {}): Layer {
  return { id: "L_1", letter: "A", title: "t", note: "why", nodes, author: "ai", paths: [], ...over };
}

// a -> b -> c, d isolated. Layer = {a, b}.
// e1 a->b internal; e2 b->c boundary (far c); e3 d->c outside.
function fixture(): Collections {
  return {
    nodes: ["a", "b", "c", "d"].map((id) => makeNode(id)),
    edges: [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "c"), makeEdge("e3", "d", "c")],
    strokes: [{ id: "k1", points: [[0, 0], [1, 1]], author: "human" }],
    images: [],
    layout: { a: [0, 0, 1, 1], b: [0, 0, 1, 1], c: [0, 0, 1, 1], d: [0, 0, 1, 1] },
  };
}

function whole(c: Collections, layers: Layer[], focus: string | null): CanvasState {
  const sim = new Sim(c);
  return buildCanvasState({
    board: { id: "b", name: "b" },
    foldResult: sim.fold(),
    history: sim.history,
    graphRevision: 7,
    layoutRevision: 3,
    viewport: { x: 1, y: 2, zoom: 1 },
    layers,
    focus,
  });
}

describe("nextLetter", () => {
  it("starts at A and skips used letters", () => {
    expect(nextLetter([])).toBe("A");
    expect(nextLetter([layer([], { letter: "A" }), layer([], { letter: "C" })])).toBe("B");
  });
  it("returns ? once all 26 are taken", () => {
    const all = Array.from({ length: 26 }, (_, i) =>
      layer([], { letter: String.fromCharCode(65 + i) }),
    );
    expect(nextLetter(all)).toBe("?");
  });
});

describe("downstream", () => {
  it("follows from → to, includes roots, survives cycles", () => {
    const edges = [
      makeEdge("e1", "a", "b"),
      makeEdge("e2", "b", "c"),
      makeEdge("e3", "c", "a"),
      makeEdge("e4", "x", "a"),
    ];
    expect(downstream(edges, ["a"])).toEqual(["a", "b", "c"]);
    expect(downstream(edges, ["c", "x"])).toEqual(["c", "x", "a", "b"]);
  });
});

describe("liveMembers", () => {
  it("drops ids missing from the fold", () => {
    expect([...liveMembers(layer(["a", "zzz", "b"]), fixture().nodes)]).toEqual(["a", "b"]);
  });
});

describe("tiers", () => {
  const c = fixture();
  const e = Object.fromEntries(c.edges.map((x) => [x.id, x]));

  it("everything is in when nothing is focused", () => {
    const t = tiers(c, null, true);
    expect(t.node("d")).toBe("in");
    expect(t.edge(e.e3!)).toBe("in");
  });

  it("member / adjacent / far nodes and internal / boundary / outside edges", () => {
    const t = tiers(c, layer(["a", "b"]), true);
    expect(t.node("a")).toBe("in");
    expect(t.node("c")).toBe("rim");
    expect(t.node("d")).toBe("out");
    expect(t.node("k1")).toBe("out");
    expect(t.edge(e.e1!)).toBe("in");
    expect(t.edge(e.e2!)).toBe("rim");
    expect(t.edge(e.e3!)).toBe("out");
  });

  it("rim=false collapses rim to out", () => {
    const t = tiers(c, layer(["a", "b"]), false);
    expect(t.node("c")).toBe("out");
    expect(t.edge(e.e2!)).toBe("out");
    expect(t.node("a")).toBe("in");
  });
});

describe("scopeState", () => {
  const L = layer(["a", "b", "gone"]);
  const input = whole(fixture(), [L], L.id);
  const s = scopeState(input, L);

  it("members and internal edges only; boxes filtered", () => {
    expect(s.graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(s.graph.edges.map((x) => x.id)).toEqual(["e1"]);
    expect(Object.keys(s.layout.boxes)).toEqual(["a", "b"]);
  });

  it("boundary edges carry out_of_scope and crosses_to; stubs are exactly id/label/kind/stub", () => {
    expect(s.graph.boundary_edges).toEqual([
      { id: "e2", from: "b", to: "c", label: null, kind: "sync", out_of_scope: true, crosses_to: "c" },
    ]);
    expect(s.graph.boundary_nodes).toEqual([{ id: "c", label: "c", kind: "service", stub: true }]);
  });

  it("ink and images are empty; omitted counts add up; dead members do not count", () => {
    expect(s.ink).toEqual([]);
    expect(s.images).toEqual([]);
    expect(s.scope?.omitted).toEqual({ nodes: 2, edges: 1 });
    expect(s.scope?.whole_board).toBe("canvas_get_board");
    expect(s.scope?.layer_id).toBe(L.id);
  });

  it("carries revisions, history, viewport, layers, focus, board unchanged", () => {
    expect(s.graph.revision).toBe(input.graph.revision);
    expect(s.layout.revision).toBe(input.layout.revision);
    expect(s.history).toEqual(input.history);
    expect(s.viewport).toEqual(input.viewport);
    expect(s.layers).toBe(input.layers);
    expect(s.focus).toBe(input.focus);
    expect(s.board).toEqual(input.board);
  });
});

describe("layer properties", () => {
  const graphArb = fc
    .record({
      n: fc.integer({ min: 1, max: 12 }),
      pairs: fc.array(fc.tuple(fc.nat(11), fc.nat(11)), { maxLength: 30 }),
      members: fc.array(fc.nat(15), { maxLength: 8 }),
    })
    .map(({ n, pairs, members }) => {
      const c: Collections = {
        nodes: Array.from({ length: n }, (_, i) => makeNode(`n${i}`)),
        edges: pairs
          .filter(([a, b]) => a % n !== b % n)
          .map(([a, b], i) => makeEdge(`e${i}`, `n${a % n}`, `n${b % n}`)),
        strokes: [],
        images: [],
        layout: {},
      };
      // Member ids past n are dead on purpose — liveMembers must drop them.
      return { c, layer: layer(members.map((m) => `n${m}`)) };
    });

  it("every node and edge resolves to exactly one tier", () => {
    fc.assert(
      fc.property(graphArb, fc.boolean(), ({ c, layer }, rim) => {
        const t = tiers(c, layer, rim);
        const ok = new Set(rim ? ["in", "rim", "out"] : ["in", "out"]);
        for (const n of c.nodes) expect(ok.has(t.node(n.id))).toBe(true);
        for (const e of c.edges) expect(ok.has(t.edge(e))).toBe(true);
      }),
    );
  });

  it("scoped node and edge counts add up to the whole board", () => {
    fc.assert(
      fc.property(graphArb, ({ c, layer }) => {
        const s = scopeState(whole(c, [layer], layer.id), layer);
        expect(s.graph.nodes.length + s.scope!.omitted.nodes).toBe(c.nodes.length);
        expect(
          s.graph.edges.length + s.graph.boundary_edges!.length + s.scope!.omitted.edges,
        ).toBe(c.edges.length);
        const members = liveMembers(layer, c.nodes);
        for (const b of s.graph.boundary_nodes!) expect(members.has(b.id)).toBe(false);
      }),
    );
  });
});

// Paths: a → b → c plus a second a → b edge (e4) for the ambiguity case.
const step = (edge: string) => ({ edge, caption: "", ref: null });
const pathOf = (id: string, ...edges: string[]): Path => ({ id, title: "t", steps: edges.map(step), author: "ai" });
const walkEdges = () => [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "c"), makeEdge("e3", "d", "c")];

describe("validateWalk", () => {
  const L = layer(["a", "b", "c"]);
  it("null for a chained walk inside the layer; revisits are legal", () => {
    expect(validateWalk(L, walkEdges(), [step("e1"), step("e2")])).toBeNull();
    const back = [...walkEdges(), makeEdge("e5", "b", "a")];
    expect(validateWalk(L, back, [step("e1"), step("e5"), step("e1")])).toBeNull();
  });
  it("names the first failing hop: missing edge, then leaves layer, then broken chain", () => {
    expect(validateWalk(L, walkEdges(), [step("e1"), step("e19")])).toBe("hop 2: e19 does not exist");
    expect(validateWalk(L, walkEdges(), [step("e1"), step("e2"), step("e3")])).toBe("hop 3: e3 leaves layer A");
    expect(validateWalk(L, walkEdges(), [step("e2"), step("e1")])).toBe("hop 2: e1 starts at a but hop 1 ended at c");
  });
});

describe("resolveNodesToSteps", () => {
  it("one edge per pair, captions and refs aligned to hops", () => {
    expect(resolveNodesToSteps(walkEdges(), ["a", "b", "c"], ["first"], [null, "x.ts:y"])).toEqual([
      { edge: "e1", caption: "first", ref: null },
      { edge: "e2", caption: "", ref: "x.ts:y" },
    ]);
  });
  it("fails on a missing edge — direction matters", () => {
    expect(() => resolveNodesToSteps(walkEdges(), ["b", "a"])).toThrow("hop 1: no edge b → a");
  });
  it("names both edges when a pair is joined twice", () => {
    const twice = [...walkEdges(), { ...makeEdge("e4", "a", "b"), label: "miss" }];
    expect(() => resolveNodesToSteps(twice, ["a", "b"])).toThrow(
      "hop 1: a → b is joined by e1 (no label) and e4 (miss) — pass steps with the edge you mean",
    );
  });
});

describe("pathsAffected", () => {
  it("first broken hop only, both reasons; empty while intact", () => {
    const L = layer(["a", "b", "c"], { paths: [pathOf("P1", "e1", "e2"), pathOf("P2", "e2")] });
    expect(pathsAffected([L], walkEdges())).toEqual([]);
    expect(pathsAffected([L], walkEdges().filter((e) => e.id !== "e1"))).toEqual([
      { path_id: "P1", hop: 1, reason: "edge pruned" },
    ]);
    const left = layer(["a", "b"], { paths: [pathOf("P1", "e1", "e2", "e2")] });
    expect(pathsAffected([left], walkEdges())).toEqual([{ path_id: "P1", hop: 2, reason: "node left layer" }]);
  });
});

describe("nextPathId", () => {
  it("is the first unused P{n} across every layer", () => {
    expect(nextPathId([])).toBe("P1");
    const ls = [layer([], { paths: [pathOf("P1", "e1")] }), layer([], { id: "L_2", paths: [pathOf("P3", "e1")] })];
    expect(nextPathId(ls)).toBe("P2");
  });
});

describe("pathNodes", () => {
  it("derives [from, ...to] and stops at a missing edge", () => {
    expect(pathNodes(walkEdges(), [step("e1"), step("e2")])).toEqual(["a", "b", "c"]);
    expect(pathNodes(walkEdges(), [step("e1"), step("e9"), step("e2")])).toEqual(["a", "b"]);
    expect(pathNodes(walkEdges(), [step("e9")])).toEqual([]);
  });
});

describe("traceT", () => {
  const tr = (over: Partial<Parameters<typeof traceT>[0]>) => ({ t: 0, running: true, loop: false, started_at: 1000, ...over });
  it("paused holds t, clamped to n", () => {
    expect(traceT(tr({ running: false, t: 1.5 }), 3, 99999)).toBe(1.5);
    expect(traceT(tr({ running: false, t: 7 }), 3, 99999)).toBe(3);
  });
  it("running advances one hop per HOP_MS from started_at and clamps at the end", () => {
    expect(traceT(tr({}), 3, 1000 + HOP_MS)).toBe(1);
    expect(traceT(tr({ t: 1 }), 3, 1000 + HOP_MS / 2)).toBe(1.5);
    expect(traceT(tr({}), 3, 1000 + 10 * HOP_MS)).toBe(3);
  });
  it("loop rests REST_MS at the end, then wraps to 0", () => {
    const period = 3 * HOP_MS + REST_MS;
    expect(traceT(tr({ loop: true }), 3, 1000 + 3 * HOP_MS + REST_MS / 2)).toBe(3); // in the rest window
    expect(traceT(tr({ loop: true }), 3, 1000 + period + HOP_MS)).toBeCloseTo(1, 6);
  });
});
