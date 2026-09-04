// Notebook math: the markdown subset, task toggling, id assignment, and the
// 80px nearest-node tie break.
import { describe, expect, it } from "vitest";
import {
  nearestNodeWithin,
  nextNotebookId,
  parseNotebook,
  resolveNotebookRefs,
  toggleTaskLine,
} from "../../src/core/notebooks.js";
import type { Draft, EdgeEl, Layer, LayoutMap, NodeEl, Notebook } from "../../src/shared/types.js";

function notebook(id: string, over: Partial<Notebook> = {}): Notebook {
  return { id, title: "t", body: "", author: "ai", updated: 0, ...over };
}

describe("nextNotebookId", () => {
  it("starts at N1 and fills a gap", () => {
    expect(nextNotebookId([])).toBe("N1");
    expect(nextNotebookId([notebook("N1"), notebook("N3")])).toBe("N2");
  });
});

describe("parseNotebook", () => {
  it("parses every block type", () => {
    const body = ["## heading", "a paragraph", "- a bullet", "- [ ] an open task", "- [x] a done task"].join("\n");
    const blocks = parseNotebook(body);
    expect(blocks.map((b) => b.type)).toEqual(["h", "para", "bullet", "task", "task"]);
    expect(blocks[3]!.done).toBe(false);
    expect(blocks[4]!.done).toBe(true);
  });

  it("skips blank lines and tracks the original line number", () => {
    const blocks = parseNotebook("first\n\nthird");
    expect(blocks.map((b) => b.line)).toEqual([0, 2]);
  });

  it("splits a ref out of the middle of a line", () => {
    const blocks = parseNotebook("before [[n7]] after");
    expect(blocks[0]!.parts).toEqual([
      { kind: "text", text: "before " },
      { kind: "ref", id: "n7" },
      { kind: "text", text: " after" },
    ]);
  });

  it("anything else is a paragraph", () => {
    expect(parseNotebook("### not a heading")[0]!.type).toBe("para");
  });
});

describe("toggleTaskLine", () => {
  it("touches exactly one line, leaving the rest of the body untouched", () => {
    const body = "keep\n- [ ] toggle me\nkeep too";
    const out = toggleTaskLine(body, 1);
    expect(out).toBe("keep\n- [x] toggle me\nkeep too");
    expect(toggleTaskLine(out, 1)).toBe(body);
  });

  it("a non-task line, or a missing line, is a no-op", () => {
    const body = "plain\n- [ ] task";
    expect(toggleTaskLine(body, 0)).toBe(body);
    expect(toggleTaskLine(body, 9)).toBe(body);
  });
});

describe("nearestNodeWithin", () => {
  const layout: LayoutMap = {
    n1: [0, 0, 20, 20], // center (10, 10)
    n2: [100, 100, 20, 20],
  };

  it("finds the nearest node within radius", () => {
    expect(nearestNodeWithin(layout, [12, 12], 80)).toBe("n1");
  });

  it("returns null when nothing is within radius", () => {
    expect(nearestNodeWithin(layout, [500, 500], 80)).toBeNull();
  });

  it("breaks an exact tie by the smaller id", () => {
    // n9 centers at (10, 10), n2 at (30, 10) — both 10px from the point, same size.
    const tied: LayoutMap = {
      n9: [0, 0, 20, 20],
      n2: [20, 0, 20, 20],
    };
    expect(nearestNodeWithin(tied, [20, 10], 80)).toBe("n2");
  });
});

describe("resolveNotebookRefs", () => {
  const node: NodeEl = { id: "n1", label: "worker", kind: "service", ref: null, endpoint: null, from_ink: null, author: "ai" };
  const edge: EdgeEl = { id: "e1", from: "n1", to: "n1", label: "calls", schema: null, kind: "sync", condition: null, from_ink: null, author: "ai" };
  const edgeNoLabel: EdgeEl = { ...edge, id: "e2", label: null };
  const layer: Layer = { id: "L1", letter: "A", title: "core", note: "", nodes: ["n1"], author: "ai", paths: [{ id: "P1", title: "walk", steps: [{ edge: "e1", caption: "", ref: null }], author: "ai" }] };
  const draft: Draft = { id: "D1", title: "proposal", note: "", marks: {}, author: "ai" };

  it("resolves a node, an edge (falling back to \"edge\" when unlabeled), a layer, a path, and a draft", () => {
    const body = "[[n1]] via [[e1]] and [[e2]], on [[L1]] [[P1]], see [[D1]].";
    expect(resolveNotebookRefs(body, [node], [edge, edgeNoLabel], [layer], [draft])).toBe(
      "n1 (worker) via e1 (calls) and e2 (edge), on L1 (core) P1 (walk), see D1 (proposal).",
    );
  });

  it("names an unresolvable ref gone, without touching the rest of the body", () => {
    expect(resolveNotebookRefs("[[n_ghost]] and [[n1]]", [node], [], [], [])).toBe("n_ghost (gone) and n1 (worker)");
  });
});
