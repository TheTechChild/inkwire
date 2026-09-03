// Layer edits shared by MCP (author "ai") and WS (author "human"). None of
// these touch history or revisions — a layer is a view over the board.
import {
  downstream,
  liveMembers,
  nextLetter,
  nextPathId,
  pathNodes,
  pathsAffected,
  playableHops,
  resolveNodesToSteps,
  validateWalk,
  type PathBreak,
} from "../core/layers.js";
import type { Author, Layer, Path, PathStep } from "../shared/types.js";
import type { BoardSession } from "./session.js";

/** Shared with drafts.ts — one 24-char title clamp for every board-view title. */
export const clampTitle = (title: string | undefined): string => (title ?? "").slice(0, 24) || "untitled";

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
    paths: [],
  };
  session.updateLayers(author, `layer ${layer.letter} · ${layer.title}`, (ls) => [...ls, layer]);
  return { layer_id: layer.id, letter: layer.letter, members: nodes.length };
}

export function updateLayer(
  session: BoardSession,
  author: Author,
  args: { layer_id: string; add?: string[]; remove?: string[]; title?: string; note?: string },
): { layer_id: string; members: number; paths_affected: PathBreak[] } {
  const layer = findLayer(session, args.layer_id);
  assertNodes(session, args.add ?? []);
  const remove = new Set(args.remove ?? []);
  const next: Layer = {
    ...layer,
    nodes: [...new Set([...layer.nodes, ...(args.add ?? [])])].filter((id) => !remove.has(id)),
    ...(args.title !== undefined ? { title: clampTitle(args.title) } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
  const edges = session.collections().edges;
  const before = new Set(pathsAffected([layer], edges).map((b) => `${b.path_id}:${b.hop}`));
  session.updateLayers(author, `layer ${layer.letter} · update`, (ls) =>
    ls.map((l) => (l.id === layer.id ? next : l)),
  );
  // Only the paths this remove broke — ones already broken are the lint's job.
  const paths_affected = pathsAffected([next], edges).filter((b) => !before.has(`${b.path_id}:${b.hop}`));
  return { layer_id: layer.id, members: memberCount(session, next), paths_affected };
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

// ---------------------------------------------------------------------------
// Paths: ordered walks on a layer. Claude's only (v1); same write path as layers.

export function findPath(session: BoardSession, id: string): { layer: Layer; path: Path } {
  for (const layer of session.layers) {
    const path = layer.paths.find((p) => p.id === id);
    if (path) return { layer, path };
  }
  throw new Error(`path not found: ${id}`);
}

const normalizeSteps = (steps: { edge: string; caption?: string; ref?: string | null }[]): PathStep[] =>
  steps.map((s) => ({ edge: s.edge, caption: s.caption ?? "", ref: s.ref ?? null }));

export function createPath(
  session: BoardSession,
  author: Author,
  args: {
    layer_id: string;
    title: string;
    steps?: { edge: string; caption?: string; ref?: string | null }[];
    nodes?: string[];
    captions?: string[];
    refs?: (string | null)[];
    extend_layer?: boolean;
  },
): { path_id: string; hops: number; nodes: string[]; layer_extended: string[] } {
  const layer = findLayer(session, args.layer_id);
  const edges = session.collections().edges;
  if (!args.steps && !args.nodes) throw new Error("pass steps or nodes");
  const steps = args.steps ? normalizeSteps(args.steps) : resolveNodesToSteps(edges, args.nodes!, args.captions, args.refs);
  // extend_layer: add missing endpoints (same shape as layers_update.add) before the walk rule runs.
  const members = new Set(layer.nodes);
  const layer_extended: string[] = [];
  if (args.extend_layer) {
    const byId = new Map(edges.map((e) => [e.id, e]));
    for (const s of steps) {
      const e = byId.get(s.edge);
      if (!e) continue;
      for (const id of [e.from, e.to]) {
        if (members.has(id)) continue;
        members.add(id);
        layer_extended.push(id);
      }
    }
  }
  const virtual: Layer = { ...layer, nodes: [...members] };
  const err = validateWalk(virtual, edges, steps);
  if (err) throw new Error(err);
  const path: Path = { id: nextPathId(session.layers), title: clampTitle(args.title), steps, author };
  const next: Layer = { ...virtual, paths: [...layer.paths, path] };
  session.updateLayers(author, `path ${path.id} · ${path.title}`, (ls) => ls.map((l) => (l.id === layer.id ? next : l)));
  return { path_id: path.id, hops: steps.length, nodes: pathNodes(edges, steps), layer_extended };
}

export function updatePath(
  session: BoardSession,
  author: Author,
  args: { path_id: string; title?: string; steps?: { edge: string; caption?: string; ref?: string | null }[] },
): { path_id: string; hops: number } {
  const { layer, path } = findPath(session, args.path_id);
  const steps = args.steps ? normalizeSteps(args.steps) : path.steps;
  if (args.steps) {
    const err = validateWalk(layer, session.collections().edges, steps);
    if (err) throw new Error(err);
  }
  const next: Path = { ...path, steps, ...(args.title !== undefined ? { title: clampTitle(args.title) } : {}) };
  session.updateLayers(author, `path ${path.id} · update`, (ls) =>
    ls.map((l) => (l.id === layer.id ? { ...l, paths: l.paths.map((p) => (p.id === path.id ? next : p)) } : l)),
  );
  return { path_id: path.id, hops: steps.length };
}

export function deletePath(session: BoardSession, author: Author, args: { path_id: string }): { ok: true } {
  const { layer, path } = findPath(session, args.path_id);
  session.updateLayers(author, `path ${path.id} · delete`, (ls) =>
    ls.map((l) => (l.id === layer.id ? { ...l, paths: l.paths.filter((p) => p.id !== path.id) } : l)),
  );
  return { ok: true };
}

type HopEnd = { id: string; label: string; ref: string | null; endpoint: string | null } | null;

/** One path with its hops resolved. A pruned edge gives nulls for that hop. */
export function getPath(session: BoardSession, args: { path_id: string }) {
  const { layer, path } = findPath(session, args.path_id);
  const c = session.collections();
  const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(c.edges.map((e) => [e.id, e]));
  const end = (id: string | undefined): HopEnd => {
    const n = id ? nodeById.get(id) : undefined;
    return n ? { id: n.id, label: n.label, ref: n.ref, endpoint: n.endpoint } : null;
  };
  return {
    path_id: path.id,
    layer_id: layer.id,
    title: path.title,
    hops: path.steps.map((s, i) => {
      const e = edgeById.get(s.edge);
      return {
        index: i + 1,
        edge: s.edge,
        from: end(e?.from),
        to: end(e?.to),
        label: e?.label ?? null,
        condition: e?.condition ?? null,
        caption: s.caption,
        ref: s.ref,
      };
    }),
  };
}

/** Pin the board trace on a path: from 0 running, or paused at t when given. */
export function openTrace(session: BoardSession, pathId: string, opts: { t?: number; running?: boolean } = {}): void {
  const { layer, path } = findPath(session, pathId);
  const n = playableHops(layer, session.collections().edges, path); // what the panels can show
  session.setTrace({
    layer_id: layer.id,
    path_id: path.id,
    running: opts.running ?? opts.t === undefined,
    loop: false,
    t: Math.min(opts.t ?? 0, n),
    started_at: session.now(),
  });
}
