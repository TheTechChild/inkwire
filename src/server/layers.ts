// Layer edits shared by MCP (author "ai") and WS (author "human"). None of
// these touch history or revisions — a layer is a view over the board.
import { downstream, liveMembers, nextLetter } from "../core/layers.js";
import type { Author, Layer } from "../shared/types.js";
import type { BoardSession } from "./session.js";

const clampTitle = (title: string | undefined): string => (title ?? "").slice(0, 24) || "untitled";

function assertNodes(session: BoardSession, ids: string[]): void {
  const have = new Set(session.collections().nodes.map((n) => n.id));
  for (const id of ids) if (!have.has(id)) throw new Error(`node not found: ${id}`);
}

export function findLayer(session: BoardSession, id: string): Layer {
  const layer = session.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`layer not found: ${id}`);
  return layer;
}

export function memberCount(session: BoardSession, layer: Layer): number {
  return liveMembers(layer, session.collections().nodes).size;
}

export function createLayer(
  session: BoardSession,
  author: Author,
  args: { node_ids: string[]; title?: string; note?: string; downstream?: boolean },
): { layer_id: string; letter: string; members: number } {
  assertNodes(session, args.node_ids);
  const nodes = args.downstream
    ? downstream(session.collections().edges, args.node_ids)
    : [...new Set(args.node_ids)];
  const layer: Layer = {
    id: session.newId("L"),
    letter: nextLetter(session.layers),
    title: clampTitle(args.title),
    note: args.note ?? "",
    nodes,
    author,
  };
  session.updateLayers(author, `layer ${layer.letter} · ${layer.title}`, (ls) => [...ls, layer]);
  return { layer_id: layer.id, letter: layer.letter, members: nodes.length };
}

export function updateLayer(
  session: BoardSession,
  author: Author,
  args: { layer_id: string; add?: string[]; remove?: string[]; title?: string; note?: string },
): { layer_id: string; members: number } {
  const layer = findLayer(session, args.layer_id);
  assertNodes(session, args.add ?? []);
  const remove = new Set(args.remove ?? []);
  const next: Layer = {
    ...layer,
    nodes: [...new Set([...layer.nodes, ...(args.add ?? [])])].filter((id) => !remove.has(id)),
    ...(args.title !== undefined ? { title: clampTitle(args.title) } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
  session.updateLayers(author, `layer ${layer.letter} · update`, (ls) =>
    ls.map((l) => (l.id === layer.id ? next : l)),
  );
  return { layer_id: layer.id, members: memberCount(session, next) };
}

export function deleteLayer(
  session: BoardSession,
  author: Author,
  args: { layer_id: string },
): { ok: true } {
  const layer = findLayer(session, args.layer_id);
  session.updateLayers(author, `layer ${layer.letter} · delete`, (ls) =>
    ls.filter((l) => l.id !== layer.id),
  );
  return { ok: true };
}
