# Handoff: Inkwire — shared drawing canvas over MCP

## Overview

Inkwire is a local MCP server plus a canvas UI, so a human can *draw* a system — a request path, a state machine, a service topology — and Claude can read it as structured data, edit it, and discuss it. The human draws freehand first; structure is inferred afterward. Both parties write to the same board.

Target surface: an MCP-UI panel inside Claude (Desktop and Claude Code). The server runs on the user's laptop and is never deployed.

## About the design files

`design/Shared Canvas.dc.html` in this bundle is a **design reference created in HTML** — a working prototype of the intended look and behavior, not production code to copy. It runs its own canvas, history fold, and a simulated MCP tool surface so the interactions can be judged. The task is to build the real thing in whatever stack suits the project (see Stack, below) and recreate the UI in that environment, using this file as the visual and behavioral specification.

The prototype's inference heuristic, edge-clipping geometry, and history fold are worth reading closely as reference implementations — they are small, pure, and correct. The rest of its JS exists to make a single-file prototype work and should not be ported.

## Fidelity

**High-fidelity** for the UI: final colors, type, spacing, and interaction behavior, built on the Industry design system (tokens in `design/_ds/`). Recreate it faithfully.

**Specification, not prototype,** for the server: `SPEC.md` is the authority. The prototype fakes the server entirely.

## Read these in order

1. `SPEC.md` — architecture, data model, history semantics, tool surface, storage.
2. `schema/canvas-state.schema.json` — the wire format of `canvas.get_state`.
3. `schema/tools.json` — every MCP tool, with argument and return shapes.
4. `TESTS.md` — what to test, and the properties that must hold.
5. `design/Shared Canvas.dc.html` — open in a browser; the UI spec.

## Decisions already made

These were settled with the product owner. Do not re-litigate them without asking.

| Decision | Choice |
| --- | --- |
| State ownership | The server owns state. The UI is a view over it. |
| Deployment | Local only, bound to `127.0.0.1`. No auth, no TLS. |
| Storage | SQLite, many boards, addressable by id. |
| History persistence | Board state persists; **history does not**. Undo is per server session. |
| Node kinds | Fixed enum: `entry`, `service`, `store`, `transform`, `note`. |
| Edge model | `label` + `schema` + `kind` (sync/async/error) + `condition`. |
| Author identity | Two values: `human`, `ai`. |
| Images | A first-class canvas element, so screenshots can be annotated. |
| `bind_code` | Validates the ref against the filesystem on write. |
| Ink inference | Deterministic geometric heuristic, server-side, v1. |
| Screenshots | The connected client captures itself; server-side SVG render as fallback. |

## Stack

Not prescribed, but the path of least resistance:

- TypeScript throughout, `@modelcontextprotocol/sdk` for the server.
- `zod` for tool schemas — they are the contract, and MCP wants JSON Schema out of them anyway.
- `better-sqlite3` (synchronous, local, no pool).
- Any small front-end for the canvas; the prototype is plain DOM + SVG and needs no framework. Pointer events, an SVG layer for ink and edges, absolutely-positioned divs for nodes.
- `resvg`/`sharp` only if you implement the server-side screenshot fallback.

## Screens

One screen. See `SPEC.md` § UI for the full breakdown — header (tool palette, theme switch, undo/redo, actions), canvas, right panel (Session, History, State, Tools), status footer.

## Design tokens

From the Industry design system, in `design/_ds/industry-*/styles.css`. Take colors, type, and spacing from its CSS variables rather than hard-coding. Dark theme is the default; it is a token-level override (`[data-theme="dark"]` inverts the neutral and accent ramps), not a second stylesheet.

Type: Barlow Condensed for headings, Barlow for body, IBM Plex Mono for all identifiers, code refs, and JSON.

## Open questions

Listed in `SPEC.md` § Open questions. The first one — node kinds versus sequence diagrams — needs a decision before you build the node model.
