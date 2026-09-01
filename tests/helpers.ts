// A tiny in-memory board that drives mutations through the same
// append/fold path the server uses. Deterministic: injected clock + id
// counter.
import { append, type AppendResult } from "../src/core/history.js";
import { fold } from "../src/core/fold.js";
import type {
  Author,
  Box,
  Collections,
  EdgeEl,
  FoldResult,
  History,
  NodeEl,
  StrokeEl,
} from "../src/shared/types.js";
import { emptyCollections } from "../src/shared/types.js";

export class Sim {
  history: History;
  now = 0;
  private idc = 0;
  lastAppend: AppendResult | null = null;

  constructor(base: Collections = emptyCollections()) {
    this.history = { base, steps: [], head: 0 };
  }

  nextId(prefix: string): string {
    return `${prefix}${++this.idc}`;
  }

  tick(ms = 2000): void {
    this.now += ms;
  }

  fold(): FoldResult {
    return fold(this.history);
  }

  collections(): Collections {
    return this.fold().collections;
  }

  mutate(
    label: string,
    author: Author,
    key: string | null,
    fn: (c: Collections) => Collections,
    advanceMs = 2000,
  ): AppendResult {
    this.now += advanceMs;
    const before = this.collections();
    const after = fn(before);
    const result = append(this.history, {
      id: this.nextId("s"),
      label,
      author,
      key,
      before,
      after,
      at: this.now,
    });
    this.history = result.history;
    this.lastAppend = result;
    return result;
  }

  addNode(author: Author = "human", at: Box = [0, 0, 176, 74]): string {
    const id = this.nextId("n");
    this.mutate(`add ${id}`, author, null, (c) => ({
      ...c,
      nodes: [...c.nodes, makeNode(id, author)],
      layout: { ...c.layout, [id]: at },
    }));
    return id;
  }

  addEdge(from: string, to: string, author: Author = "human"): string {
    const id = this.nextId("e");
    this.mutate(`edge ${from}->${to}`, author, null, (c) => ({
      ...c,
      edges: [...c.edges, makeEdge(id, from, to, author)],
    }));
    return id;
  }

  addStroke(author: Author = "human", points: [number, number][] = [[0, 0], [50, 50]]): string {
    const id = this.nextId("k");
    this.mutate(`stroke ${id}`, author, null, (c) => ({
      ...c,
      strokes: [...c.strokes, { id, points, author } satisfies StrokeEl],
    }));
    return id;
  }

  delete(id: string, author: Author = "human"): void {
    this.mutate(`delete ${id}`, author, null, (c) => ({
      ...c,
      nodes: c.nodes.filter((n) => n.id !== id),
      edges: c.edges.filter((e) => e.id !== id),
      strokes: c.strokes.filter((s) => s.id !== id),
      images: c.images.filter((i) => i.id !== id),
      layout: Object.fromEntries(Object.entries(c.layout).filter(([k]) => k !== id)),
    }));
  }

  move(id: string, box: Box, author: Author = "human", advanceMs = 2000): void {
    this.mutate(`move ${id}`, author, `move:${id}`, (c) => ({
      ...c,
      layout: { ...c.layout, [id]: box },
    }), advanceMs);
  }

  editLabel(id: string, label: string, author: Author = "human", advanceMs = 2000): void {
    this.mutate(`edit ${id}`, author, `edit:${id}:label`, (c) => ({
      ...c,
      nodes: c.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
    }), advanceMs);
  }
}

export function makeNode(id: string, author: Author = "human"): NodeEl {
  return { id, label: id, kind: "service", ref: null, endpoint: null, from_ink: null, author };
}

export function makeEdge(id: string, from: string, to: string, author: Author = "human"): EdgeEl {
  return { id, from, to, label: null, schema: null, kind: "sync", condition: null, from_ink: null, author };
}
