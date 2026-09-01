// TESTS.md § 1 — property tests over randomly generated histories.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Sim } from "../helpers.js";
import { dropStep, rewindTo, toggleSkip, undo } from "../../src/core/history.js";
import { fold } from "../../src/core/fold.js";
import { historySummary } from "../../src/core/state.js";
import { stableStringify } from "../../src/core/util.js";
import type { History, Step } from "../../src/shared/types.js";

// -- generators -------------------------------------------------------------

type Mutation =
  | { t: "addNode" }
  | { t: "addEdge"; a: number; b: number }
  | { t: "delete"; i: number }
  | { t: "move"; i: number; dx: number }
  | { t: "edit"; i: number }
  | { t: "addStroke" };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.constant<Mutation>({ t: "addNode" }),
  fc
    .record({ a: fc.nat(20), b: fc.nat(20) })
    .map(({ a, b }): Mutation => ({ t: "addEdge", a, b })),
  fc.nat(20).map((i): Mutation => ({ t: "delete", i })),
  fc
    .record({ i: fc.nat(20), dx: fc.integer({ min: 1, max: 300 }) })
    .map(({ i, dx }): Mutation => ({ t: "move", i, dx })),
  fc.nat(20).map((i): Mutation => ({ t: "edit", i })),
  fc.constant<Mutation>({ t: "addStroke" }),
);

type HistoryOp =
  | { t: "rewind"; i: number }
  | { t: "skip"; i: number }
  | { t: "drop"; i: number };

const historyOpArb: fc.Arbitrary<HistoryOp> = fc.oneof(
  fc.nat(30).map((i): HistoryOp => ({ t: "rewind", i })),
  fc.nat(30).map((i): HistoryOp => ({ t: "skip", i })),
  fc.nat(30).map((i): HistoryOp => ({ t: "drop", i })),
);

function buildSim(mutations: Mutation[]): Sim {
  const sim = new Sim();
  const authors = ["human", "ai"] as const;
  let a = 0;
  for (const m of mutations) {
    const author = authors[a++ % 2]!;
    const c = sim.collections();
    switch (m.t) {
      case "addNode":
        sim.addNode(author);
        break;
      case "addEdge": {
        if (c.nodes.length < 2) break;
        const from = c.nodes[m.a % c.nodes.length]!.id;
        const to = c.nodes[m.b % c.nodes.length]!.id;
        if (from !== to) sim.addEdge(from, to, author);
        break;
      }
      case "delete": {
        const all = [...c.nodes, ...c.edges, ...c.strokes];
        if (all.length === 0) break;
        sim.delete(all[m.i % all.length]!.id, author);
        break;
      }
      case "move": {
        if (c.nodes.length === 0) break;
        const id = c.nodes[m.i % c.nodes.length]!.id;
        sim.move(id, [m.dx, m.dx, 176, 74], author);
        break;
      }
      case "edit": {
        if (c.nodes.length === 0) break;
        const id = c.nodes[m.i % c.nodes.length]!.id;
        sim.editLabel(id, `label-${m.i}`, author);
        break;
      }
      case "addStroke":
        sim.addStroke(author);
        break;
    }
  }
  return sim;
}

function applyHistoryOps(h: History, ops: HistoryOp[]): History {
  let cur = h;
  for (const op of ops) {
    if (cur.steps.length === 0) break;
    const idx = op.i % (cur.steps.length + 1);
    if (op.t === "rewind") cur = rewindTo(cur, idx);
    else if (op.t === "skip") cur = toggleSkip(cur, idx);
    else cur = dropStep(cur, idx);
  }
  return cur;
}

const scenarioArb = fc.record({
  mutations: fc.array(mutationArb, { minLength: 1, maxLength: 25 }),
  ops: fc.array(historyOpArb, { maxLength: 15 }),
});

// -- properties -------------------------------------------------------------

describe("history properties", () => {
  it("1: no dangling edges after any sequence", () => {
    fc.assert(
      fc.property(scenarioArb, ({ mutations, ops }) => {
        const sim = buildSim(mutations);
        const h = applyHistoryOps(sim.history, ops);
        const { collections } = fold(h);
        const ids = new Set(collections.nodes.map((n) => n.id));
        for (const e of collections.edges) {
          expect(ids.has(e.from)).toBe(true);
          expect(ids.has(e.to)).toBe(true);
        }
        // Layout never references a missing element.
        const elIds = new Set([...ids, ...collections.images.map((i) => i.id)]);
        for (const id of Object.keys(collections.layout)) {
          expect(elIds.has(id)).toBe(true);
        }
      }),
    );
  });

  it("2: reported counts equal the validated collections", () => {
    fc.assert(
      fc.property(scenarioArb, ({ mutations, ops }) => {
        const sim = buildSim(mutations);
        const h = applyHistoryOps(sim.history, ops);
        const r = fold(h);
        const s = historySummary(h, r);
        expect(s.steps).toBe(h.steps.length);
        expect(s.ahead).toBe(h.steps.length - h.head);
        expect(s.applied + s.skipped).toBe(h.head);
        expect(s.by_human + s.by_ai).toBe(h.steps.length);
        expect(s.conflicts).toBe(r.conflicts.size);
      }),
    );
  });

  it("3: rewind is a prefix — fold(0..i) equals the state observed after step i", () => {
    fc.assert(
      fc.property(fc.array(mutationArb, { minLength: 1, maxLength: 20 }), (mutations) => {
        const sim = new Sim();
        const observed: string[] = [stableStringify(sim.collections())];
        const before = buildSimIncremental(sim, mutations, observed);
        void before;
        for (let i = 0; i < observed.length; i++) {
          expect(stableStringify(fold(rewindTo(sim.history, i)).collections)).toBe(observed[i]);
        }
      }),
    );
  });

  it("4: rewind is reversible", () => {
    fc.assert(
      fc.property(
        fc.array(mutationArb, { minLength: 1, maxLength: 20 }),
        fc.nat(30),
        (mutations, i) => {
          const sim = buildSim(mutations);
          const tip = stableStringify(fold(sim.history).collections);
          const idx = i % (sim.history.steps.length + 1);
          const back = rewindTo(rewindTo(sim.history, idx), sim.history.steps.length);
          expect(stableStringify(fold(back).collections)).toBe(tip);
        },
      ),
    );
  });

  it("5: skip is order-independent among steps touching disjoint ids", () => {
    fc.assert(
      fc.property(scenarioArb, ({ mutations }) => {
        const sim = buildSim(mutations);
        const steps = sim.history.steps;
        // Find a disjoint pair.
        for (let i = 0; i < steps.length; i++) {
          for (let j = i + 1; j < steps.length; j++) {
            if (disjoint(steps[i]!, steps[j]!)) {
              const ab = fold(toggleSkip(toggleSkip(sim.history, i + 1), j + 1));
              const ba = fold(toggleSkip(toggleSkip(sim.history, j + 1), i + 1));
              expect(stableStringify(ab.collections)).toBe(stableStringify(ba.collections));
              return;
            }
          }
        }
      }),
    );
  });

  it("6: drop equals skip, minus the record", () => {
    fc.assert(
      fc.property(scenarioArb, ({ mutations }, ) => {
        const sim = buildSim(mutations);
        if (sim.history.steps.length === 0) return;
        for (let i = 1; i <= sim.history.steps.length; i++) {
          const skipped = fold(toggleSkip(sim.history, i));
          const dropped = fold(dropStep(sim.history, i));
          expect(stableStringify(skipped.collections)).toBe(
            stableStringify(dropped.collections),
          );
        }
      }),
    );
  });

  it("7: fold is deterministic", () => {
    fc.assert(
      fc.property(scenarioArb, ({ mutations, ops }) => {
        const sim = buildSim(mutations);
        const h = applyHistoryOps(sim.history, ops);
        expect(stableStringify(fold(h).collections)).toBe(
          stableStringify(fold(h).collections),
        );
      }),
    );
  });

  it("8: author-scoped undo never touches the other author's flags", () => {
    fc.assert(
      fc.property(scenarioArb, fc.constantFrom("human", "ai"), ({ mutations }, scope) => {
        const sim = buildSim(mutations);
        const beforeFlags = sim.history.steps.map((s) => ({ a: s.author, sk: s.skipped }));
        const after = undo(sim.history, scope as "human" | "ai");
        after.steps.forEach((s, i) => {
          if (s.author !== scope) {
            expect(s.skipped).toBe(beforeFlags[i]!.sk);
          }
        });
      }),
    );
  });
});

function disjoint(a: Step, b: Step): boolean {
  const ids = (s: Step) => {
    const out = new Set<string>();
    for (const list of [s.ops.nodes, s.ops.edges, s.ops.strokes, s.ops.images] as const) {
      for (const op of list) out.add(op.op === "del" ? op.id : op.item.id);
    }
    for (const op of s.ops.layout) out.add(op.id);
    // An edge op also depends on its endpoints.
    for (const op of s.ops.edges) {
      if (op.op !== "del") {
        out.add(op.item.from);
        out.add(op.item.to);
      }
    }
    return out;
  };
  const A = ids(a);
  for (const id of ids(b)) if (A.has(id)) return false;
  return true;
}

function buildSimIncremental(sim: Sim, mutations: Mutation[], observed: string[]): void {
  const authors = ["human", "ai"] as const;
  let a = 0;
  for (const m of mutations) {
    const author = authors[a++ % 2]!;
    const stepsBefore = sim.history.steps.length;
    const c = sim.collections();
    switch (m.t) {
      case "addNode":
        sim.addNode(author);
        break;
      case "addEdge": {
        if (c.nodes.length < 2) break;
        const from = c.nodes[m.a % c.nodes.length]!.id;
        const to = c.nodes[m.b % c.nodes.length]!.id;
        if (from !== to) sim.addEdge(from, to, author);
        break;
      }
      case "delete": {
        const all = [...c.nodes, ...c.edges, ...c.strokes];
        if (all.length === 0) break;
        sim.delete(all[m.i % all.length]!.id, author);
        break;
      }
      case "move": {
        if (c.nodes.length === 0) break;
        sim.move(c.nodes[m.i % c.nodes.length]!.id, [m.dx, m.dx, 176, 74], author);
        break;
      }
      case "edit": {
        if (c.nodes.length === 0) break;
        sim.editLabel(c.nodes[m.i % c.nodes.length]!.id, `label-${m.i}`, author);
        break;
      }
      case "addStroke":
        sim.addStroke(author);
        break;
    }
    if (sim.history.steps.length > stepsBefore) {
      observed.push(stableStringify(sim.collections()));
    }
  }
}
