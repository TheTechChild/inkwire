// Notebook edits shared by MCP (author "ai") and WS (author "human"). None of
// these touch history or revisions — a notebook is not the board. The one
// exception is migrateNotes: it deletes note nodes, so it writes one step.
import { nearestNodeWithin, nextNotebookId } from "../core/notebooks.js";
import { pathsAffected, type PathBreak } from "../core/layers.js";
import { clampTitle } from "./layers.js";
import type { Author, LayoutMap, Notebook, Point } from "../shared/types.js";
import type { BoardSession } from "./session.js";

export function findNotebook(session: BoardSession, id: string): Notebook {
  const notebook = session.notebooks.find((n) => n.id === id);
  if (!notebook) throw new Error(`notebook not found: ${id}`);
  return notebook;
}

export function createNotebook(
  session: BoardSession,
  author: Author,
  args: { title?: string; body?: string },
): { notebook_id: string } {
  const notebook: Notebook = {
    id: nextNotebookId(session.notebooks),
    title: clampTitle(args.title, 40),
    body: args.body ?? "",
    author,
    updated: session.now(),
  };
  session.updateNotebooks(author, `notebook ${notebook.id} · ${notebook.title}`, (ns) => [...ns, notebook]);
  return { notebook_id: notebook.id };
}

export function updateNotebook(
  session: BoardSession,
  author: Author,
  args: { notebook_id: string; title?: string; body?: string; append?: string },
): { notebook_id: string; updated: number } {
  const notebook = findNotebook(session, args.notebook_id);
  let body = args.body !== undefined ? args.body : notebook.body;
  if (args.append !== undefined) {
    body = body && !body.endsWith("\n") ? `${body}\n${args.append}` : body + args.append;
  }
  const updated = session.now();
  const next: Notebook = {
    ...notebook,
    body,
    updated,
    ...(args.title !== undefined ? { title: clampTitle(args.title, 40) } : {}),
  };
  session.updateNotebooks(author, `notebook ${notebook.id} · update`, (ns) =>
    ns.map((n) => (n.id === notebook.id ? next : n)),
  );
  return { notebook_id: notebook.id, updated };
}

export function deleteNotebook(session: BoardSession, author: Author, args: { notebook_id: string }): { ok: true } {
  const notebook = findNotebook(session, args.notebook_id);
  session.updateNotebooks(author, `notebook ${notebook.id} · delete`, (ns) => ns.filter((n) => n.id !== notebook.id));
  return { ok: true };
}

export function getNotebook(session: BoardSession, args: { notebook_id: string }): { notebook_id: string; title: string; body: string } {
  const notebook = findNotebook(session, args.notebook_id);
  return { notebook_id: notebook.id, title: notebook.title, body: notebook.body };
}

/** Append one line to a notebook's body — the T tool and notes_migrate's
 * per-note paragraph (both Phase 3/4 work). A thin wrapper over
 * updateNotebook's append so there is exactly one place body-append happens. */
export function appendToNotebook(
  session: BoardSession,
  author: Author,
  notebook_id: string,
  line: string,
): { notebook_id: string; updated: number } {
  return updateNotebook(session, author, { notebook_id, append: line });
}

const NOTES_TITLE = "notes";

/** "N1 notes" — created on first use, reused after: canvas_annotate's target
 * and notes_migrate's per-note paragraphs both land here. */
export function findOrCreateNotesNotebook(session: BoardSession, author: Author): Notebook {
  const existing = session.notebooks.find((n) => n.title === NOTES_TITLE);
  if (existing) return existing;
  const { notebook_id } = createNotebook(session, author, { title: NOTES_TITLE });
  return findNotebook(session, notebook_id);
}

export interface MigrateResult {
  notebook_id: string | null;
  migrated: number;
  layers_affected: string[];
  paths_affected: PathBreak[];
  drafts_affected: { draft_id: string; id: string }[];
  edges_dropped: string[];
}

/**
 * "import notes to notebook" (handoff § Migration): one paragraph per note
 * node, in reading order, prefixed [[nX]] when within 80px of a non-note
 * node; a label starting "- " or "[ ]" becomes a task line; the note nodes
 * are then deleted as ONE history step (their edges go with them, via the
 * fold's own dangling-edge pruning — same as any other node delete). Layer
 * members, path hops and draft marks naming a note are reported; layer
 * members and draft marks are additionally dropped (paths only ever report,
 * same as canvas.delete — a path's hops aren't rewritten out from under it).
 * Idempotent: with no note nodes, nothing is touched, not even the notebook.
 * The delete is the one undoable step (⌘Z restores the note nodes); the
 * appended paragraphs are not history and stay put — a rerun (e.g. right
 * after that undo) skips any line already present instead of duplicating it.
 */
export function migrateNotes(session: BoardSession, author: Author): MigrateResult {
  const c = session.collections();
  const notes = c.nodes.filter((n) => n.kind === "note");
  if (notes.length === 0) {
    const existing = session.notebooks.find((n) => n.title === NOTES_TITLE);
    return { notebook_id: existing?.id ?? null, migrated: 0, layers_affected: [], paths_affected: [], drafts_affected: [], edges_dropped: [] };
  }
  const noteIds = new Set(notes.map((n) => n.id));

  // Reading order: top-to-bottom, then left-to-right.
  const ordered = [...notes].sort((a, b) => {
    const ba = c.layout[a.id];
    const bb = c.layout[b.id];
    const ay = ba?.[1] ?? 0;
    const by = bb?.[1] ?? 0;
    return ay !== by ? ay - by : (ba?.[0] ?? 0) - (bb?.[0] ?? 0);
  });
  const nonNoteLayout: LayoutMap = Object.fromEntries(
    c.nodes.filter((n) => !noteIds.has(n.id) && c.layout[n.id]).map((n) => [n.id, c.layout[n.id]!]),
  );
  const lines = ordered.map((note) => {
    const box = c.layout[note.id];
    const at: Point = box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : [0, 0];
    const ref = nearestNodeWithin(nonNoteLayout, at, 80);
    const label = note.label;
    const isTask = label.startsWith("- ") || label.startsWith("[ ]");
    const rest = label.startsWith("- ") ? label.slice(2) : label.startsWith("[ ]") ? label.slice(3).trimStart() : label;
    const content = ref ? `[[${ref}]] ${rest}` : rest;
    return isTask ? `- [ ] ${content}` : content;
  });

  const notebook = findOrCreateNotesNotebook(session, author);

  // The node delete goes first: notebooks carry no history (CLAUDE.md), so if
  // this throws, nothing below has written a single paragraph — a retry (or
  // ⌘Z restoring the note nodes, which does NOT restore the notebook, and a
  // rerun after that) starts clean instead of half-committed.
  const before = new Set(pathsAffected(session.layers, c.edges).map((b) => `${b.path_id}:${b.hop}`));
  const result = session.mutate({
    label: `notes → ${notebook.id} ${notebook.title}`,
    author,
    key: null,
    ids: [...noteIds],
    apply: (cur) => ({
      ...cur,
      nodes: cur.nodes.filter((n) => !noteIds.has(n.id)),
      layout: Object.fromEntries(Object.entries(cur.layout).filter(([id]) => !noteIds.has(id))),
    }),
  });
  // ⌘Z brings the note nodes back but can't touch the notebook body — a
  // rerun would otherwise recompute the identical lines and duplicate them.
  // Skip any line already present rather than tracking note ids across runs.
  const existingLines = new Set(notebook.body.split("\n"));
  const newLines = lines.filter((l) => !existingLines.has(l));
  if (newLines.length > 0) appendToNotebook(session, author, notebook.id, newLines.join("\n"));

  const edges_dropped = result.ids.filter((id) => !noteIds.has(id));
  const paths_affected = pathsAffected(session.layers, session.collections().edges).filter(
    (b) => !before.has(`${b.path_id}:${b.hop}`),
  );

  const layers_affected: string[] = [];
  if (session.layers.some((l) => l.nodes.some((id) => noteIds.has(id)))) {
    session.updateLayers(author, `notes → ${notebook.id} · layers pruned`, (layers) =>
      layers.map((l) => {
        const nodes = l.nodes.filter((id) => !noteIds.has(id));
        if (nodes.length !== l.nodes.length) layers_affected.push(l.id);
        return nodes.length !== l.nodes.length ? { ...l, nodes } : l;
      }),
    );
  }

  const drafts_affected: { draft_id: string; id: string }[] = [];
  if (session.drafts.some((d) => Object.keys(d.marks).some((id) => noteIds.has(id)))) {
    session.updateDrafts(author, `notes → ${notebook.id} · drafts pruned`, (drafts) =>
      drafts.map((d) => {
        const marks = { ...d.marks };
        let changed = false;
        for (const id of Object.keys(marks)) {
          if (noteIds.has(id)) {
            drafts_affected.push({ draft_id: d.id, id });
            delete marks[id];
            changed = true;
          }
        }
        return changed ? { ...d, marks } : d;
      }),
    );
  }

  return { notebook_id: notebook.id, migrated: notes.length, layers_affected, paths_affected, drafts_affected, edges_dropped };
}
