import { describe, expect, it } from "vitest";
import { exportMermaid } from "../../src/core/mermaid.js";
import { makeEdge, makeNode } from "../helpers.js";

describe("mermaid export", () => {
  it("serializes nodes and edges with kinds and labels", () => {
    const nodes = [
      { ...makeNode("n1"), label: "api gateway", kind: "entry" as const },
      { ...makeNode("n2"), label: "orders db", kind: "store" as const },
    ];
    const edges = [
      { ...makeEdge("e1", "n1", "n2"), label: "read", condition: "cache miss", kind: "async" as const },
    ];
    const out = exportMermaid(nodes, edges);
    expect(out).toContain("flowchart TD");
    expect(out).toContain('n1(["api gateway"])');
    expect(out).toContain('n2[("orders db")]');
    expect(out).toContain('n1 -.->|"read · if cache miss"| n2');
  });

  it("sanitizes ids and quotes in labels", () => {
    const nodes = [{ ...makeNode("a-b.c"), label: 'say "hi"' }];
    const out = exportMermaid(nodes, []);
    expect(out).toContain('a_b_c["say #quot;hi#quot;"]');
  });
});
