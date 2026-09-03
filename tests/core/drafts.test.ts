// Draft math: id assignment, mark counts excluding gone marks, and the sets
// canvas.lint / canvas.delete need to report on marks.
import { describe, expect, it } from "vitest";
import { draftsAffectedBy, goneMarks, markCounts, nextDraftId } from "../../src/core/drafts.js";
import type { Draft, EdgeEl, NodeEl } from "../../src/shared/types.js";

function draft(id: string, marks: Draft["marks"] = {}, over: Partial<Draft> = {}): Draft {
  return { id, title: "t", note: "", marks, author: "ai", ...over };
}

const node = (id: string): NodeEl => ({ id, label: id, kind: "service", ref: null, endpoint: null, from_ink: null, author: "ai" });
const edge = (id: string): EdgeEl => ({ id, from: "n1", to: "n2", label: null, schema: null, kind: "sync", condition: null, from_ink: null, author: "ai" });

describe("nextDraftId", () => {
  it("starts at D1 and skips used ids", () => {
    expect(nextDraftId([])).toBe("D1");
    expect(nextDraftId([draft("D1"), draft("D3")])).toBe("D2");
  });
});

describe("markCounts", () => {
  const nodes = [node("n1"), node("n2")];
  const edges = [edge("e1")];

  it("counts per role, node and edge marks alike", () => {
    const d = draft("D1", { n1: "removed", n2: "changed", e1: "added" });
    expect(markCounts(d, nodes, edges)).toEqual({ removed: 1, changed: 1, added: 1 });
  });

  it("excludes marks whose element no longer exists", () => {
    const d = draft("D1", { n1: "removed", n_gone: "changed" });
    expect(markCounts(d, nodes, edges)).toEqual({ removed: 1, changed: 0, added: 0 });
  });

  it("an empty draft counts nothing", () => {
    expect(markCounts(draft("D1"), nodes, edges)).toEqual({ removed: 0, changed: 0, added: 0 });
  });
});

describe("goneMarks", () => {
  it("finds marks across every draft whose element is not live", () => {
    const drafts = [
      draft("D1", { n1: "removed", n_gone: "changed" }),
      draft("D2", { e_gone: "added" }),
      draft("D3", { n1: "changed" }),
    ];
    expect(goneMarks(drafts, ["n1"], ["e1"])).toEqual([
      { draft_id: "D1", id: "n_gone" },
      { draft_id: "D2", id: "e_gone" },
    ]);
  });

  it("nothing gone → []", () => {
    expect(goneMarks([draft("D1", { n1: "removed" })], ["n1"], [])).toEqual([]);
  });
});

describe("draftsAffectedBy", () => {
  it("finds marks among the given ids, across every draft, live or gone", () => {
    const drafts = [
      draft("D1", { n1: "removed", n2: "changed" }),
      draft("D2", { n1: "added", n3: "removed" }),
    ];
    expect(draftsAffectedBy(drafts, ["n1", "e_pruned"])).toEqual([
      { draft_id: "D1", id: "n1" },
      { draft_id: "D2", id: "n1" },
    ]);
  });

  it("no overlap → []", () => {
    expect(draftsAffectedBy([draft("D1", { n1: "removed" })], ["n9"])).toEqual([]);
  });
});
