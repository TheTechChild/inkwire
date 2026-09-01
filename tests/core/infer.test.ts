// TESTS.md § 3 — inference fixtures. The heuristic is pure; test it directly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inferStructure, type InferInput } from "../../src/core/infer.js";
import { stableStringify } from "../../src/core/util.js";
import type { Box, Point } from "../../src/shared/types.js";

interface Fixture {
  name: string;
  strokes: { id: string; points: Point[] }[];
  existing: { id: string; box: Box }[];
  expect: {
    nodes: number;
    edges: number;
    consumed: number;
    nodeBox?: Box;
    direction?: { from: string; to: string };
    provenance?: boolean;
  };
}

const fixtures: Fixture[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/ink/fixtures.json", import.meta.url)), "utf8"),
);

function run(f: Fixture) {
  let counter = 0;
  const input: InferInput = {
    strokes: f.strokes.map((s) => ({ ...s, author: "human" as const })),
    existing: f.existing,
    author: "ai",
    nextId: (p) => `${p}_new${++counter}`,
  };
  return inferStructure(input);
}

describe("ink inference", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const out = run(f);
      expect(out.nodes).toHaveLength(f.expect.nodes);
      expect(out.edges).toHaveLength(f.expect.edges);
      expect(out.consumedStrokeIds).toHaveLength(f.expect.consumed);
      if (f.expect.nodeBox) {
        expect(out.nodes[0]!.box).toEqual(f.expect.nodeBox);
        expect(out.nodes[0]!.node.label).toBe("untitled");
      }
      if (f.expect.direction) {
        expect(out.edges[0]!.from).toBe(f.expect.direction.from);
        expect(out.edges[0]!.to).toBe(f.expect.direction.to);
      }
      if (f.expect.provenance) {
        for (const n of out.nodes) expect(n.node.from_ink).toHaveLength(1);
        for (const e of out.edges) expect(e.from_ink).toHaveLength(1);
      }
    });
  }

  it("is deterministic: 100 runs give byte-identical output", () => {
    const f = fixtures[fixtures.length - 1]!;
    const first = stableStringify(run(f));
    for (let i = 0; i < 99; i++) {
      expect(stableStringify(run(f))).toBe(first);
    }
  });
});
