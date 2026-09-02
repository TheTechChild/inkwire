// The zod contract must stay in lockstep with the handoff's JSON Schema.
// A sample get_state payload has to validate against BOTH.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { Sim } from "../helpers.js";
import { scopeState } from "../../src/core/layers.js";
import { buildCanvasState } from "../../src/core/state.js";
import { canvasStateSchema } from "../../src/shared/schemas.js";
import type { CanvasState, Layer } from "../../src/shared/types.js";

const handoffSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../fixtures/contract/canvas-state.schema.json", import.meta.url),
    ),
    "utf8",
  ),
);

function sampleState(layers: Layer[] = [], focus: string | null = null): CanvasState {
  const sim = new Sim();
  const a = sim.addNode("human");
  const b = sim.addNode("ai");
  sim.addEdge(a, b, "ai");
  sim.addStroke("human", [[620, 400], [810, 478]]);
  return buildCanvasState({
    board: { id: "b_test", name: "sample" },
    foldResult: sim.fold(),
    history: sim.history,
    graphRevision: 3,
    layoutRevision: 2,
    viewport: { x: 40, y: 20, zoom: 1 },
    layers,
    focus,
  });
}

function scopedSample(): CanvasState {
  const layer: Layer = { id: "L_1", letter: "A", title: "one", note: "why", nodes: ["n1"], author: "ai" };
  return scopeState(sampleState([layer], layer.id), layer);
}

describe("schema parity", () => {
  it("a built state validates against the zod contract", () => {
    const state = sampleState();
    const parsed = canvasStateSchema.safeParse(state);
    expect(parsed.error).toBeUndefined();
  });

  it("a built state validates against the handoff JSON Schema", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(handoffSchema);
    const state = sampleState();
    const ok = validate(state);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("a scoped state validates against both schemas", () => {
    const state = scopedSample();
    expect(state.scope?.omitted).toEqual({ nodes: 1, edges: 0 });
    expect(state.graph.boundary_edges).toHaveLength(1);
    expect(canvasStateSchema.safeParse(state).error).toBeUndefined();
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(handoffSchema);
    const ok = validate(state);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("full ink geometry also validates against the handoff schema", () => {
    const sim = new Sim();
    sim.addStroke("human", [[0, 0], [10, 10], [20, 5]]);
    const state = buildCanvasState({
      board: { id: "b", name: "s" },
      foldResult: sim.fold(),
      history: sim.history,
      graphRevision: 0,
      layoutRevision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      layers: [],
      focus: null,
      includeInkGeometry: true,
    });
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(handoffSchema);
    expect(validate(state)).toBe(true);
  });
});
