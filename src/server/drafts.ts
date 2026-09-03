// Draft edits shared by MCP (author "ai") and WS (author "human"). None of
// these touch history or revisions — a draft is a view over the board, like
// a layer. Nothing changes when a draft is created, marked or activated.
import { nextDraftId } from "../core/drafts.js";
import { clampTitle } from "./layers.js";
import type { Author, Draft, DraftRole } from "../shared/types.js";
import type { BoardSession } from "./session.js";

/** Marks are node/edge ids only — images and ink cannot be marked. */
function assertMarkable(session: BoardSession, id: string): void {
  const c = session.collections();
  const isNode = c.nodes.some((n) => n.id === id);
  const isEdge = c.edges.some((e) => e.id === id);
  if (!isNode && !isEdge) throw new Error(`not a node or edge: ${id}`);
}

export function findDraft(session: BoardSession, id: string): Draft {
  const draft = session.drafts.find((d) => d.id === id);
  if (!draft) throw new Error(`draft not found: ${id}`);
  return draft;
}

export function createDraft(
  session: BoardSession,
  author: Author,
  args: { title?: string; note?: string; marks?: { id: string; role: DraftRole }[] },
): { draft_id: string; marks: Record<string, DraftRole> } {
  for (const m of args.marks ?? []) assertMarkable(session, m.id);
  const marks: Record<string, DraftRole> = {};
  for (const m of args.marks ?? []) marks[m.id] = m.role;
  const draft: Draft = {
    id: nextDraftId(session.drafts),
    title: clampTitle(args.title),
    note: args.note ?? "",
    marks,
    author,
  };
  session.updateDrafts(author, `draft ${draft.id} · ${draft.title}`, (ds) => [...ds, draft]);
  return { draft_id: draft.id, marks: draft.marks };
}

export function updateDraft(
  session: BoardSession,
  author: Author,
  args: {
    draft_id: string;
    title?: string;
    note?: string;
    mark?: { id: string; role: DraftRole }[];
    unmark?: string[];
  },
): { draft_id: string; marks: Record<string, DraftRole> } {
  const draft = findDraft(session, args.draft_id);
  for (const m of args.mark ?? []) assertMarkable(session, m.id);
  const marks = { ...draft.marks };
  for (const m of args.mark ?? []) marks[m.id] = m.role; // marking again replaces
  for (const id of args.unmark ?? []) delete marks[id];
  const next: Draft = {
    ...draft,
    marks,
    ...(args.title !== undefined ? { title: clampTitle(args.title) } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
  session.updateDrafts(author, `draft ${draft.id} · update`, (ds) =>
    ds.map((d) => (d.id === draft.id ? next : d)),
  );
  return { draft_id: draft.id, marks: next.marks };
}

export function deleteDraft(session: BoardSession, author: Author, args: { draft_id: string }): { ok: true } {
  const draft = findDraft(session, args.draft_id);
  session.updateDrafts(author, `draft ${draft.id} · delete`, (ds) => ds.filter((d) => d.id !== draft.id));
  return { ok: true };
}

type MarkRow =
  | { id: string; role: DraftRole; label: string; kind: string }
  | { id: string; role: DraftRole; label: string | null; edge: { from: string; to: string } }
  | { id: string; role: DraftRole; gone: true };

/** One draft with its marks resolved: node/edge labels, or gone: true when the element left the board. */
export function getDraft(session: BoardSession, args: { draft_id: string }) {
  const draft = findDraft(session, args.draft_id);
  const c = session.collections();
  const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(c.edges.map((e) => [e.id, e]));
  const marks: MarkRow[] = Object.entries(draft.marks).map(([id, role]) => {
    const node = nodeById.get(id);
    if (node) return { id, role, label: node.label, kind: node.kind };
    const edge = edgeById.get(id);
    if (edge) return { id, role, label: edge.label ?? null, edge: { from: edge.from, to: edge.to } };
    return { id, role, gone: true as const };
  });
  return { draft_id: draft.id, title: draft.title, note: draft.note, marks };
}

/**
 * Mark or unmark one element (the right-click menu, the card's ✕). A null
 * draft_id creates a draft first and activates it; a null role unmarks.
 */
export function markElement(
  session: BoardSession,
  author: Author,
  args: { draft_id: string | null; id: string; role: DraftRole | null },
): { draft_id: string; marks: Record<string, DraftRole> } {
  if (args.draft_id !== null) {
    return args.role === null
      ? updateDraft(session, author, { draft_id: args.draft_id, unmark: [args.id] })
      : updateDraft(session, author, { draft_id: args.draft_id, mark: [{ id: args.id, role: args.role }] });
  }
  // No active draft: validate before creating anything — a bad id must throw
  // and leave no orphan draft active in every panel — then build the draft
  // with its first mark and activate it in one updateDrafts call, one notify
  // instead of create + activate + mark.
  assertMarkable(session, args.id);
  const draft: Draft = {
    id: nextDraftId(session.drafts),
    title: clampTitle(undefined),
    note: "",
    marks: args.role === null ? {} : { [args.id]: args.role },
    author,
  };
  session.activeDraft = draft.id;
  session.updateDrafts(author, `draft ${draft.id} · ${draft.title} · activated`, (ds) => [...ds, draft]);
  return { draft_id: draft.id, marks: draft.marks };
}
