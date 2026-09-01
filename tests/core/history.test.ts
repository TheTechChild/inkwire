// Coalescing, truncation, rewind, scoped undo (TESTS.md § 2 + SPEC § 4.5/4.6).
import { describe, expect, it } from "vitest";
import { Sim } from "../helpers.js";
import { redo, rewindTo, toggleSkip, undo } from "../../src/core/history.js";
import { fold } from "../../src/core/fold.js";
import { stableStringify } from "../../src/core/util.js";

describe("coalescing", () => {
  it("two move:n1 steps 200 ms apart produce one step", () => {
    const sim = new Sim();
    const id = sim.addNode();
    sim.move(id, [10, 10, 176, 74]);
    const count = sim.history.steps.length;
    sim.move(id, [20, 20, 176, 74], "human", 200);
    expect(sim.history.steps).toHaveLength(count);
    expect(sim.collections().layout[id]).toEqual([20, 20, 176, 74]);
  });

  it("two move:n1 steps 2000 ms apart produce two steps", () => {
    const sim = new Sim();
    const id = sim.addNode();
    sim.move(id, [10, 10, 176, 74]);
    const count = sim.history.steps.length;
    sim.move(id, [20, 20, 176, 74], "human", 2000);
    expect(sim.history.steps).toHaveLength(count + 1);
  });

  it("skipping a coalesced step reverts the whole gesture", () => {
    const sim = new Sim();
    const id = sim.addNode(); // at [0,0]
    sim.move(id, [10, 10, 176, 74]);
    sim.move(id, [50, 50, 176, 74], "human", 100);
    sim.move(id, [90, 90, 176, 74], "human", 100);
    // The three moves coalesced into one step; skip it → original position.
    const skipped = toggleSkip(sim.history, sim.history.steps.length);
    expect(fold(skipped).collections.layout[id]).toEqual([0, 0, 176, 74]);
  });
});

describe("truncation", () => {
  it("editing while the head is behind the tip truncates and reports the count", () => {
    const sim = new Sim();
    sim.addNode();
    sim.addNode();
    sim.addNode();
    sim.history = rewindTo(sim.history, 1);
    const result = sim.mutate("new branch", "human", null, (c) => ({
      ...c,
      strokes: [...c.strokes, { id: "k9", points: [[0, 0], [5, 5]] as [number, number][], author: "human" as const }],
    }));
    expect(result.truncated).toBe(2);
    expect(sim.history.steps).toHaveLength(2);
    expect(sim.history.head).toBe(2);
  });
});

describe("rewind", () => {
  it("is a prefix and is reversible", () => {
    const sim = new Sim();
    const snapshots: string[] = [stableStringify(sim.collections())];
    const a = sim.addNode();
    snapshots.push(stableStringify(sim.collections()));
    const b = sim.addNode();
    snapshots.push(stableStringify(sim.collections()));
    sim.addEdge(a, b);
    snapshots.push(stableStringify(sim.collections()));
    const tip = stableStringify(sim.collections());

    for (let i = 0; i <= 3; i++) {
      const rewound = rewindTo(sim.history, i);
      expect(stableStringify(fold(rewound).collections)).toBe(snapshots[i]);
    }
    const back = rewindTo(rewindTo(sim.history, 1), 3);
    expect(stableStringify(fold(back).collections)).toBe(tip);
  });
});

describe("author-scoped undo", () => {
  it("scope human skips only human steps; ai work stands", () => {
    const sim = new Sim();
    sim.addNode("human");
    const aiNode = sim.addNode("ai");
    sim.addNode("human");

    sim.history = undo(sim.history, "human");
    const steps = sim.history.steps;
    expect(steps[2]!.skipped).toBe(true); // newest human step
    expect(steps.filter((s) => s.author === "ai").every((s) => !s.skipped)).toBe(true);
    expect(sim.collections().nodes.some((n) => n.id === aiNode)).toBe(true);

    sim.history = redo(sim.history, "human");
    expect(sim.history.steps.every((s) => !s.skipped)).toBe(true);
  });

  it("scope all moves the head", () => {
    const sim = new Sim();
    sim.addNode();
    sim.addNode();
    sim.history = undo(sim.history, "all");
    expect(sim.history.head).toBe(1);
    sim.history = redo(sim.history, "all");
    expect(sim.history.head).toBe(2);
  });
});
