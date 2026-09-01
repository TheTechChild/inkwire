// Graph → Mermaid flowchart text, for quoting the board in a transcript.
import type { EdgeEl, NodeEl, NodeKind } from "../shared/types.js";

const SHAPES: Record<NodeKind, [string, string]> = {
  entry: ["([", "])"],
  service: ["[", "]"],
  store: ["[(", ")]"],
  transform: ["{{", "}}"],
  note: [">", "]"],
  state: ["(", ")"],
  lifeline: ["[", "]"],
};

function mid(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "#quot;")}"`;
}

export function exportMermaid(nodes: readonly NodeEl[], edges: readonly EdgeEl[]): string {
  const lines = ["flowchart TD"];
  for (const n of nodes) {
    const [open, close] = SHAPES[n.kind];
    lines.push(`  ${mid(n.id)}${open}${quote(n.label || n.id)}${close}`);
  }
  for (const e of edges) {
    const parts: string[] = [];
    if (e.label) parts.push(e.label);
    if (e.condition) parts.push(`if ${e.condition}`);
    if (e.schema) parts.push(`⟨${e.schema}⟩`);
    if (e.kind === "error") parts.unshift("⚠");
    const label = parts.length > 0 ? `|${quote(parts.join(" · "))}|` : "";
    const arrow = e.kind === "async" ? "-.->" : "-->";
    lines.push(`  ${mid(e.from)} ${arrow}${label} ${mid(e.to)}`);
  }
  return lines.join("\n");
}
