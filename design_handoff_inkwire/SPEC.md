# Inkwire — technical specification

Version 1. Written 2026-09-01. Authority for implementation; where this document and the prototype disagree, this document wins.

---

## 1. Shape of the system

Three processes on one laptop.

```
Claude (Desktop / Code)          the browser panel                  the server
  │                                    │                                 │
  │  MCP tool calls over stdio         │  WebSocket (board events)       │
  └───────────────────────────────────►├────────────────────────────────►│
                                       │                                 ├── SQLite (boards)
                                       │  ◄── state pushes ──────────────┤
                                       │                                 └── in-memory history
```

**The server owns state.** Every mutation — a human dragging a node, Claude calling `add_node` — goes through the same internal mutation API. The browser never holds authoritative state; it renders what the server pushes and sends intents back. This is the single most important structural rule: two writers with local state will diverge, and `get_state` will start lying.

Bind to `127.0.0.1` only. No auth, no TLS, no CORS handling beyond allowing the local origin.

### Transport

- **MCP:** stdio, standard for a local server.
- **UI:** the server serves the panel over HTTP on a fixed local port and holds a WebSocket per connected client. The MCP-UI resource points at that URL with a board id.
- **Client intents:** the human's edits arrive as messages on the same socket — same op vocabulary as the MCP tools, so there is exactly one mutation path.

---

## 2. Data model

A board holds four element collections. All ids are opaque strings, unique within a board and stable for its lifetime.

### Node

```ts
{
  id: string,
  label: string,
  kind: "entry" | "service" | "store" | "transform" | "note",
  ref: string | null,        // "svc/auth.ts:verifyToken" — validated on write
  endpoint: string | null,   // "GET /v2/orders/:id"
  from_ink: string[] | null, // provenance: stroke ids this node was inferred from
  author: "human" | "ai"
}
```

Geometry lives in `layout`, not on the node. See § 3.

### Edge

```ts
{
  id: string,
  from: string,              // node id
  to: string,                // node id
  label: string | null,      // "miss"
  schema: string | null,     // "OrderId" — the payload type crossing this edge
  kind: "sync" | "async" | "error",
  condition: string | null,  // "cache miss" — the branch predicate
  from_ink: string[] | null,
  author: "human" | "ai"
}
```

`from` and `to` must reference existing nodes. Enforced by the fold (§ 4.4), not by trust.

### Stroke (freehand ink, not yet structured)

```ts
{
  id: string,
  points: [number, number][], // canvas px, in draw order
  author: "human" | "ai"      // in practice always human
}
```

### Image

```ts
{
  id: string,
  src: string,               // server-relative URL of the stored bitmap
  natural: [number, number], // intrinsic px
  author: "human" | "ai"
}
```

Images exist so a screenshot can be dropped on the board and annotated with ink. They are ordinary elements: they sit in layout, can be moved and deleted, and participate in history. Store the bitmap on disk beside the SQLite file and reference it by URL; do not put blobs in the database.

### Layout

A separate map, `id → [x, y, w, h]` in canvas px, covering nodes and images. Strokes carry their own geometry and are not in the layout map.

---

## 3. `canvas.get_state` — the wire format

Meaning and placement are separate fields. This matters more than it looks:

```json
{
  "board": { "id": "b_7f2", "name": "orders read path" },
  "graph": {
    "revision": 12,
    "nodes": [ ... ],
    "edges": [ ... ]
  },
  "layout": {
    "revision": 30,
    "units": "canvas px",
    "boxes": { "n1": [120, 200, 176, 74] }
  },
  "ink": [ { "id": "s1", "points": 47, "bbox": { "x": 620, "y": 400, "w": 190, "h": 78 } } ],
  "images": [ ... ],
  "history": { "steps": 6, "head": 6, "applied": 6, "skipped": 0, "conflicts": 0 },
  "viewport": { "x": 40, "y": 20, "zoom": 1 }
}
```

Two revision counters, incremented independently: a node move bumps `layout.revision` and leaves `graph.revision` alone. So Claude can cache the graph and skip re-reading it when the human has only tidied the board — and a graph diff means the meaning actually changed.

`ink` returns point *counts* and bounding boxes by default, not full polylines; full geometry is available via `include_ink_geometry`. A board with a hundred strokes should not blow the context window on coordinates the model rarely needs.

The full JSON Schema is in `schema/canvas-state.schema.json`.

---

## 4. History

The most subtle part of the system, and the part most likely to be built wrong. It is **in memory, per server session** — boards persist, timelines do not. On reopening a board, history starts fresh from the stored state as step 0.

### 4.1 Steps are diffs

Every mutation appends one step:

```ts
{
  id: string,
  label: string,             // "infer_structure · 2 ink → 1n/1e" — human-readable, shown in the UI
  author: "human" | "ai",
  key: string | null,        // coalescing key, e.g. "move:n3" or "edit:n3:label"
  ops: {
    nodes: Op[], edges: Op[], strokes: Op[], images: Op[], layout: Op[]
  },
  skipped: boolean,
  at: number                 // epoch ms
}

type Op =
  | { op: "add", item: object }
  | { op: "set", item: object }   // whole-item replacement
  | { op: "del", id: string }
```

Step 0 is the base: no ops, a full snapshot of the board as loaded.

Derive the ops by diffing the collections before and after the mutation, comparing by id and by object identity. Whole-item `set` rather than field-level patches is deliberate — it keeps the fold trivial at the cost of coarser conflict granularity, which is the right trade at this scale.

### 4.2 The board is a fold

```
board = fold(steps[0..head] where not skipped)
```

`head` is the timeline pointer. There is no separate mutable board state — the board is always derived. Cache the fold result; recompute on any history change.

### 4.3 Two distinct operations, plus a third

- **Rewind** (`head = i`): the canvas becomes the state as of step *i*. A prefix, so it can never conflict — everything after simply hasn't happened yet. Steps past the head remain listed as "ahead" and can be replayed forward.
- **Skip** (`steps[i].skipped = true`): reverts one step's effect while leaving later steps applied. This is what author-scoped undo uses, and it is where conflicts can arise.
- **Drop**: removes the step from the record entirely and refolds without it. For clearing conflicts and dead ends so what remains is a history worth reading. Step 0 cannot be dropped.

Editing while the head is behind the tip **truncates** the steps ahead. Log it visibly — the human is discarding work, possibly Claude's.

### 4.4 Integrity is enforced in the fold

After applying each step's ops, validate referential integrity: any edge whose `from` or `to` is not in the current node set is **pruned from the board**, and the step that orphaned it is flagged `conflict`.

Also flag a step when any of its ops missed: an `add` whose id already exists, a `set` or `del` whose target is absent.

This is not decoration. Without it, dropping a step that a later step depends on hands Claude a graph with an edge pointing at a node that does not exist. The invariant to hold: **`get_state` never returns a dangling edge, under any sequence of rewind, skip, and drop.** Counts reported to the UI must derive from the validated graph so the footer can never disagree with what is drawn.

### 4.5 Author-scoped undo

The undo scope is `all | human | ai`.

- Scope `all`: undo moves the head back one step, redo forward. Time travel.
- Scope `human` or `ai`: undo skips the most recent unskipped step by that author, at or before the head; redo restores the earliest skipped one. Selective revert, leaving the other author's work standing.

Rewind by clicking a history row always affects the whole timeline regardless of scope.

### 4.6 Coalescing

A step with a `key` matching the current tip's key, committed within 1600 ms, replaces it rather than appending. So a pen stroke, a node drag, and a run of keystrokes in one field each land as a single step. Continuous gestures commit **once, on release** — never per pointer-move.

### 4.7 History and the AI

Expose `history.get` (read-only) so Claude can see what happened and who did it. **Do not expose rewind, skip, or drop as tools in v1** — an agent that can erase its own trail is a debugging problem, and the human is the one who needs that control.

---

## 5. Ink inference

`infer_structure` runs a deterministic geometric heuristic server-side. Keep it a **pure function**: strokes in, ops out. No database access, no history awareness, no side effects. That makes it unit-testable against fixtures and replaceable later without touching anything else.

The prototype's heuristic, which is adequate for v1:

1. For each stroke, compute the bounding box and its diagonal.
2. **Closed** if `distance(first_point, last_point) < 0.3 × diagonal`. A closed stroke with `w > 50` and `h > 30` becomes a node, positioned at its bbox.
3. Otherwise, a stroke with `diagonal > 50` is an edge candidate.
4. For each edge candidate, find the nearest node to each endpoint — nearest by distance from the node's center minus half its diagonal, within 150 px. If both resolve and differ, emit an edge.
5. Consumed strokes are deleted. Set `from_ink` on everything created.

Labels are the model's job, not the heuristic's: emit nodes labelled `"untitled"` and let Claude rename them via `update_node` after reading the screenshot. Do not attempt handwriting recognition server-side.

### Swapping to model-driven inference later

Cheap, if one boundary holds: **structure is only ever created through the mutation API.** Then the heuristic is just one caller of `add_node`/`add_edge`, and the model path needs no new plumbing — Claude reads ink geometry from `get_state`, takes a screenshot, and calls the same mutations. Keep `from_ink` populated by either path.

What makes it expensive is implementing inference *inside* the fold or history layer, so inferred elements aren't ordinary ops. Don't.

---

## 6. Screenshots

**Primary: the connected client captures itself.** The server sends a capture request over the WebSocket; the panel renders its canvas to a PNG (`canvas.toBlob`, or DOM-to-image for the HTML node layer) and POSTs it back; the server returns it as the tool result. Exact pixels the human is looking at, no extra dependencies. Requires an attached client — which, in an MCP-UI panel, is nearly always true, since Claude is displaying it.

**Fallback: server-side SVG render.** With no client attached, render the board from state — boxes, polylines, text, and images are all the visual language needs — and rasterize with `resvg` or `sharp`. Deterministic, headless, and tractable precisely because the vocabulary is small. It must visually match the client renderer closely enough that Claude isn't misled; keep the two renderers reading the same token values.

Do not spawn a headless Chromium for this in v1. It is a ~300 MB dependency and a second full renderer to keep in step.

Return images at the current viewport unless a viewport is passed. Include the board id and zoom in the tool result text so the model knows what it is looking at.

---

## 7. Storage

SQLite, one file, many boards. Persist board state only — no history (§ 4).

```sql
CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  graph       TEXT NOT NULL,   -- JSON: { nodes, edges }
  layout      TEXT NOT NULL,   -- JSON: { boxes }
  ink         TEXT NOT NULL,   -- JSON: strokes with full point arrays
  images      TEXT NOT NULL,   -- JSON: image element metadata
  viewport    TEXT NOT NULL
);
```

JSON columns rather than normalized tables: boards are small, always read and written whole, and the schema is still moving. Normalize when there is a query that needs it.

Write on a debounce (~500 ms after the last mutation) plus on client disconnect and server shutdown. Bitmaps go in a sibling `images/` directory, named by content hash.

---

## 8. Code binding

`bind_code` **validates on write.** The server can read the filesystem, so use it:

- `ref` format: `path/to/file.ts` or `path/to/file.ts:symbolName`.
- Resolve the path relative to a configured project root (a server config value, or per-board).
- If the file does not exist, fail the tool call with the resolved path in the message. Do not store an unresolvable ref.
- If a symbol is given, a plain text search for the identifier is enough for v1 — parsing every language is not this project's job. Missing symbol is a warning in the result, not a failure.
- `endpoint` is a free string; nothing to validate against.

---

## 9. Tool surface

Full signatures in `schema/tools.json`. Summary:

| Tool | Purpose |
| --- | --- |
| `boards.list` | Board ids, names, element counts, last touched. |
| `boards.open` | Make a board current for this session; returns its state. |
| `boards.create` | New empty board. |
| `canvas.get_state` | The graph, layout, ink, and history summary (§ 3). |
| `canvas.screenshot` | PNG of the viewport (§ 6). |
| `canvas.infer_structure` | Run the heuristic over unresolved ink (§ 5). |
| `canvas.add_node` / `update_node` | Create and edit nodes, including labels and kinds. |
| `canvas.add_edge` / `update_edge` | Create and edit edges, including kind and condition. |
| `canvas.delete` | Remove an element by id. Deleting a node prunes its edges. |
| `canvas.move` | Set layout for an element. Bumps `layout.revision` only. |
| `canvas.bind_code` | Attach and validate a code ref or endpoint (§ 8). |
| `canvas.annotate` | Pin a comment to an element. |
| `canvas.set_viewport` | Pan and zoom, so the AI can direct the human's attention. |
| `canvas.export_mermaid` | Serialize the graph as text for the transcript. |
| `history.get` | Read the timeline: steps, authors, labels, conflicts. |

Every mutating tool returns the ids it touched and the new `graph.revision` / `layout.revision`, so the model can tell whether it needs to re-read.

---

## 10. UI

One screen. `design/Shared Canvas.dc.html` is the specification; open it. Structure:

- **Header** — brand and `mcp://canvas` status; a segmented tool palette (select V, pen P, node B, edge A, text T, erase E); sun/moon theme switch; undo/redo; `canvas.screenshot` and `infer_structure` actions. Every segmented group is `flex-shrink: 0` and the header wraps — the design system's segmented control has `overflow: hidden` and will silently clip its own options if compressed.
- **Canvas** — dotted grid that scales with zoom; scroll to zoom about the cursor, space-drag or middle-drag to pan; ink in an SVG layer; nodes as blueprint-framed boxes with registration marks, `pointer-events: none` so the canvas does all hit-testing; edges clipped to node borders with arrow markers; edge labels on a background-filled rect so the line doesn't run through the text. AI-authored elements get a dashed accent border and a `· claude` mark.
- **Right panel** — an inspector for the selection (label, kind, code ref, endpoint; edge kind, condition, schema), then four tabs: Session (the conversation and tool log), History (undo scope selector, then step rows with skip and drop controls), State (the literal `get_state` payload), Tools (the tool surface, each with a run button).
- **Footer** — connection status, element counts, zoom, history position, unresolved ink count.

Minimum hit target on interactive controls: 32 px on desktop.

---

## 11. Open questions

**1. Node kinds versus sequence diagrams and state machines.** V1 is meant to support both, but the node enum (`entry`, `service`, `store`, `transform`, `note`) has no vocabulary for a state or a lifeline, and sequence diagrams need an ordered time axis that the free-positioning layout model does not express. Three ways out, in ascending cost: add `state` and `lifeline` to the enum and accept that sequence diagrams are drawn by convention rather than enforced; add a per-board `mode` that changes the enum and the layout rules; or ship request-flow and architecture diagrams in v1 and defer the other two. **Recommendation: add the two kinds now, defer real sequence-diagram layout.** Decide before building the node model.

**2. Branching after a rewind.** Editing from behind the head currently drops the steps ahead. Branching instead would preserve them, but needs a tree rather than a list. Deferred; noted so the history structure isn't over-committed to a flat array.

**3. Conflict resolution on skip.** A skipped step whose target was later deleted currently prunes and flags. The alternative — refusing the skip and naming the dependency — is friendlier but needs dependency tracking between steps. Deferred.

**4. Multiple clients.** One board open in two panels is unspecified. The server-owns-state design makes it work by construction, but selection and viewport are per-client and would need separating from board state.
