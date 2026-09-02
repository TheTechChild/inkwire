// Fold result → CanvasState projection (SPEC § 3). Ink returns point counts
// and bboxes by default; full polylines only on request.
import { bbox } from "./geometry.js";
import type {
  CanvasState,
  Collections,
  FoldResult,
  History,
  HistorySummary,
  Layer,
  StrokeSummary,
  Viewport,
} from "../shared/types.js";

export interface StateInput {
  board: { id: string; name: string };
  foldResult: FoldResult;
  history: History;
  graphRevision: number;
  layoutRevision: number;
  viewport: Viewport;
  layers: Layer[];
  focus: string | null;
  includeInkGeometry?: boolean;
  includeLayout?: boolean;
}

export function historySummary(history: History, foldResult: FoldResult): HistorySummary {
  const { steps, head } = history;
  let applied = 0;
  let skipped = 0;
  let byHuman = 0;
  let byAi = 0;
  steps.forEach((s, i) => {
    if (s.author === "human") byHuman++;
    else byAi++;
    if (i < head) {
      if (s.skipped) skipped++;
      else applied++;
    }
  });
  return {
    steps: steps.length,
    head,
    applied,
    skipped,
    ahead: steps.length - head,
    conflicts: foldResult.conflicts.size,
    edges_pruned: foldResult.edgesPruned,
    by_human: byHuman,
    by_ai: byAi,
  };
}

export function strokeSummaries(
  collections: Collections,
  includeGeometry: boolean,
): StrokeSummary[] {
  return collections.strokes.map((s) => {
    const b = bbox(s.points);
    const summary: StrokeSummary = {
      id: s.id,
      bbox: { x: b.x, y: b.y, w: b.w, h: b.h },
      author: s.author,
    };
    if (includeGeometry) summary.geometry = s.points;
    else summary.points = s.points.length;
    return summary;
  });
}

export function buildCanvasState(input: StateInput): CanvasState {
  const c = input.foldResult.collections;
  return {
    board: input.board,
    graph: { revision: input.graphRevision, nodes: c.nodes, edges: c.edges },
    layout: {
      revision: input.layoutRevision,
      units: "canvas px",
      boxes: input.includeLayout === false ? {} : c.layout,
    },
    ink: strokeSummaries(c, input.includeInkGeometry === true),
    images: c.images,
    history: historySummary(input.history, input.foldResult),
    viewport: input.viewport,
    layers: input.layers,
    focus: input.focus,
  };
}
