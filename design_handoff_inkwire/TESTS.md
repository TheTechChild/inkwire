# Tests

The fold is where correctness lives. Most of this file is about it.

## 1. Properties that must hold

Property tests over randomly generated histories. Generate a sequence of mutations (add node, add edge, delete, move, edit, infer), then a random sequence of history operations (rewind to any index, skip any step, drop any step), and assert:

1. **No dangling edges.** After any sequence, every edge's `from` and `to` exist in the node set. This is the invariant that protects `get_state` from handing the model an unreadable graph.
2. **Counts agree with content.** The counts the server reports equal the lengths of the validated collections. The footer and the board can never disagree.
3. **Rewind is a prefix.** `fold(0..i)` equals the board state observed immediately after step *i* was committed, for every *i*, when no skips or drops intervene.
4. **Rewind is reversible.** Rewinding to *i* then forward to the tip yields the tip state exactly.
5. **Skip is order-independent among independent steps.** Skipping A then B equals skipping B then A when the two touch disjoint element ids.
6. **Drop equals skip, minus the record.** Dropping step *i* yields the same board as skipping it; only the timeline differs.
7. **Fold is deterministic.** Same history, same result, every time. No `Date.now()`, no `Math.random()`, no map iteration order dependence in the fold path.
8. **Author-scoped undo preserves the other author.** With scope `human`, no step authored `ai` changes its skipped flag, and vice versa.

## 2. Fold unit tests

Hand-written cases, small and named:

- Base only — the board equals step 0's snapshot.
- Add then delete the same node — net zero.
- Delete a node with edges — the edges go too, and the deleting step is not flagged conflict (this is intended pruning, not a conflict).
- **The regression case:** step 1 adds node A; step 2 adds node B; step 3 adds edge A→B. Drop step 2. The edge must be pruned, step 3 must be flagged `conflict`, and `get_state` must not contain the edge.
- `add` of an existing id, `set`/`del` of an absent id — each flags the owning step.
- Coalescing: two `move:n1` steps 200 ms apart produce one step; 2000 ms apart produce two.
- Editing while the head is behind the tip truncates the ahead steps, and the count of dropped steps is reported.

## 3. Inference fixtures

The heuristic is a pure function, so test it directly: stroke arrays in, ops out. Fixtures as JSON files.

- A hand-drawn closed rectangle → one node, at the bbox.
- A rectangle drawn with a deliberate 15 px gap at the corner → still closed (within the 0.3 × diagonal threshold), still one node.
- A rectangle drawn far too small (< 50 × 30) → no node, stroke left alone.
- A line between two existing nodes → one edge, correct direction.
- A line whose endpoint is 400 px from any node → no edge, stroke left alone.
- A line from a node back to itself → no edge (the endpoints resolve to the same node).
- Three strokes forming two boxes and a connector → two nodes and one edge, with `from_ink` set on all three elements.
- Determinism: the same fixture run 100 times gives byte-identical ops.

## 4. Tool contract tests

For each tool in `schema/tools.json`:

- Rejects arguments that fail the zod schema, with a message naming the field.
- `add_edge` with a nonexistent endpoint fails and mutates nothing.
- `bind_code` with a path outside the project root fails; with a nonexistent file fails; with a real file and a missing symbol succeeds with `symbol_found: false`.
- `canvas.move` bumps `layout_revision` and leaves `graph_revision` untouched. `update_node` does the opposite.
- Every mutating tool returns a `step` id that appears in `history.get`.
- `get_state` output validates against `schema/canvas-state.schema.json`. Run this assertion after every mutation in the integration tests — it catches drift for free.

## 5. Integration

- **Two writers.** Client sends a node drag over the WebSocket while a tool call adds an edge. Both land, both appear as separate history steps with correct authorship, and the pushed state matches `get_state`.
- **Client reconnect.** Kill the socket mid-session, reconnect, and the client's rendered board matches the server's state.
- **Persistence.** Mutate, wait for the debounce, kill the server, restart, `boards.open` — the board is intact and history is empty with the stored state as step 0.
- **Screenshot with a client attached** returns a PNG whose dimensions match the requested viewport.
- **Screenshot with no client attached** falls back to the server renderer and still returns a valid PNG.
- **Renderer parity.** Same board, both renderers: element count and bounding boxes match within a few px. Not a pixel diff — a structural one.

## 6. What not to test

- The prototype's DOM. It is a design reference, not the implementation.
- Exact ink coordinates through a round trip — floats will not survive a JSON round trip byte-identically, and it does not matter. Test bboxes and point counts.
- SQLite itself.
