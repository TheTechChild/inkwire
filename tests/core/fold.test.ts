// TESTS.md § 2 — hand-written fold cases.
import { describe, expect, it } from "vitest";
import { Sim, makeNode } from "../helpers.ts";
import { dropStep, toggleSkip } from "../../plugin/src/core/history.ts";
import { fold } from "../../plugin/src/core/fold.ts";
import { emptyCollections } from "../../plugin/src/shared/types.ts";
import { stableStringify } from "../../plugin/src/core/util.ts";

describe("fold", () => {
  it("base only — the board equals step 0's snapshot", () => {
    const base = { ...emptyCollections(), nodes: [makeNode("a")] };
    const sim = new Sim(base);
    expect(sim.collections().nodes).toEqual(base.nodes);
  });

  it("add then delete the same node — net zero", () => {
    const sim = new Sim();
    const id = sim.addNode();
    sim.delete(id);
    const c = sim.collections();
    expect(c.nodes).toHaveLength(0);
    expect(Object.keys(c.layout)).toHaveLength(0);
    expect(sim.fold().conflicts.size).toBe(0);
  });

  it("delete a node with edges — edges go too, and it is NOT a conflict", () => {
    const sim = new Sim();
    const a = sim.addNode();
    const b = sim.addNode();
    sim.addEdge(a, b);
    sim.delete(a);
    const r = sim.fold();
    expect(r.collections.edges).toHaveLength(0);
    expect(r.collections.nodes.map((n) => n.id)).toEqual([b]);
    expect(r.conflicts.size).toBe(0);
    expect(r.edgesPruned).toBe(1);
  });

  it("regression: drop the add-B step — edge pruned, step 3 flagged conflict", () => {
    const sim = new Sim();
    const a = sim.addNode(); // step 1
    const b = sim.addNode(); // step 2
    sim.addEdge(a, b); // step 3
    const edgeStepId = sim.history.steps[2]!.id;

    sim.history = dropStep(sim.history, 2);
    const r = sim.fold();
    expect(r.collections.edges).toHaveLength(0);
    expect(r.collections.nodes.map((n) => n.id)).toEqual([a]);
    expect(r.conflicts.has(edgeStepId)).toBe(true);
    expect(r.edgesPruned).toBe(1);
  });

  it("add of an existing id / set / del of an absent id flag the owning step", () => {
    const sim = new Sim();
    const a = sim.addNode(); // step 1
    sim.addNode(); // step 2 (b)
    // Manufacture a bad step directly: re-add node a, delete a missing edge.
    const badStep = {
      id: "bad1",
      label: "bad",
      author: "human" as const,
      key: null,
      ops: {
        nodes: [{ op: "add" as const, item: makeNode(a) }],
        edges: [{ op: "del" as const, id: "missing-edge" }],
        strokes: [],
        images: [],
        layout: [],
      },
      skipped: false,
      before: emptyCollections(),
      at: 99,
    };
    sim.history = {
      ...sim.history,
      steps: [...sim.history.steps, badStep],
      head: sim.history.steps.length + 1,
    };
    const r = fold(sim.history);
    expect(r.conflicts.has("bad1")).toBe(true);
    // The duplicate add did not corrupt the board.
    expect(r.collections.nodes.filter((n) => n.id === a)).toHaveLength(1);
  });

  it("skip behaves like drop for the board, keeping the record", () => {
    const sim = new Sim();
    const a = sim.addNode();
    const b = sim.addNode();
    sim.addEdge(a, b);

    const skipped = fold(toggleSkip(sim.history, 2));
    const dropped = fold(dropStep(sim.history, 2));
    expect(stableStringify(skipped.collections)).toBe(stableStringify(dropped.collections));
    expect(toggleSkip(sim.history, 2).steps).toHaveLength(3);
    expect(dropStep(sim.history, 2).steps).toHaveLength(2);
  });

  it("skip refuses the base and steps past the head", () => {
    const sim = new Sim();
    sim.addNode();
    expect(toggleSkip(sim.history, 0)).toBe(sim.history);
    expect(toggleSkip(sim.history, 5)).toBe(sim.history);
  });
});
