# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Inkwire is a local MCP server plus a browser canvas panel. A person draws a system freehand; the server infers structure; Claude reads the board as data and edits it over MCP. The server owns all state. The panel is a view that sends intents over a WebSocket. The design handoff in `design_handoff_inkwire/` is the authority: `SPEC.md` wins over the prototype, `TESTS.md` names the invariants, and `design/Shared Canvas.dc.html` is the visual spec.

## Commands

Use **yarn** only. Do not use npm or npx.

- `yarn test` — full suite (vitest). One file: `yarn vitest run tests/core/fold.test.ts`.
- `yarn typecheck` — tsc, no emit.
- `yarn build` — compiles the server to `dist/` and bundles the panel to `dist/ui/` (esbuild).
- `yarn dev` — server (tsx watch) + panel (esbuild watch). Panel URL: `http://127.0.0.1:4691/?board=<id>`.
- `yarn gen:schemas` — regenerate `schema/*.generated.json` from the zod contract.

Env: `INKWIRE_PORT` (default 4691), `INKWIRE_DATA_DIR` (default `~/.inkwire`), `INKWIRE_PROJECT_ROOT` (root for `bind_code` refs). To use from Claude Code, the repo is a plugin and its own one-plugin marketplace (build first): `claude plugin marketplace add <repo>` then `claude plugin install inkwire@inkwire`; `claude --plugin-dir <repo>` for a one-off. The plugin pieces live at the root: `.claude-plugin/plugin.json` (manifest + the MCP server entry) and `marketplace.json`, `hooks/hooks.json` + `hooks/forward.sh`, `skills/use-inkwire`, `skills/back-to-claude-code`, `skills/trace-path` (model-invocable). The Session tab's two requirements (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, permission mode `auto`) live in `.claude/settings.json` here and in the README for other projects. `.claude/skills/ship` is a dev-only skill, not part of the plugin.

## Architecture

Three layers, enforced by `tests/core/purity.test.ts`:

- `src/shared/` — the contract. `schemas.ts` (zod) defines elements, `CanvasState`, and every tool's args; JSON Schema is generated from it. `protocol.ts` defines the WS messages. `tokens.ts` holds the canvas render colors both renderers read (resvg cannot read CSS variables) — keep it in step with `src/ui/styles.css`.
- `src/core/` — pure functions only: no I/O, no clock, no randomness (clock and id-gen are injected). `fold.ts` derives the board from history steps and enforces integrity (no dangling edges, ever). `history.ts` handles append/coalesce/rewind/skip/drop/scoped-undo. `infer.ts` is the ink heuristic. Whole-item `set` ops, not field patches.
- `src/server/` — `session.ts` is the one write path: every mutation (MCP tool or WS intent) goes through `BoardSession.mutate()`, which diffs, appends to history, refolds, bumps revisions, persists (500 ms debounce), and pushes to clients. MCP handlers pass author `"ai"`; WS handlers pass `"human"`; authorship is never a tool argument.

Load-bearing rules that are easy to break:

- **Coalescing re-diffs from the tip step's original `before` snapshot.** Never concatenate op lists — a skipped coalesced step must revert the whole gesture. Gestures commit once, on pointer release.
- **Revisions are derived, per session.** The session fingerprints the fold's graph and layout sections and bumps each counter on content change. A move must never touch `graph.revision`. `boards.open` resets both.
- **History is in-memory only.** SQLite (`store.ts`) persists board content; a reopened board starts at step 0.
- **stdout is the MCP transport.** Log to stderr only. The spawned-stdio smoke test (`tests/tools/stdio-smoke.test.ts`) guards this; in-process tests cannot.
- **MCP tool names use underscores** (`canvas_add_node`) because the tool-name charset forbids dots; the spec's dotted names appear in descriptions only.
- Node kinds are the five from the spec **plus `state` and `lifeline`** (product decision, 2026-09-01). Sequence-diagram layout is deferred.
- A draft (`drafts_*`) is a view like a layer — nothing on the board changes when it is created, marked or activated; `active_draft` is per board, shared by every panel like focus, and never persisted.
- **Session mode is per server, not per board** (`Sessions.mode`); the thread and the active highlight are per board and, like focus, shared by every panel and never persisted. `src/server/session-mode.ts` owns the flag, the blocking `session_send` (20 min timeout → `idle` and mode off), and the hook endpoint. The hook script `hooks/forward.sh` is a dumb forwarder to `POST /api/hook`; the server records `permission_mode` and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` from every event, blocks `Stop` while the mode is on (gives up after 3 in a row), and re-injects the instruction on `SessionStart` `compact`. `session_mode(on)` fails unless a hook event has been seen, the mode is `auto`/`bypassPermissions`, and backgrounding is `0`.
- Every MCP call lands in the current board's thread as a `call` row (the `register` wrapper in `mcp.ts`); `session_send` and `session_mode` write their own rows. The panel folds runs of calls. There is no `/use-inkwire` button in the panel — it is typed in the terminal.
- v1 is browser-only for the panel: Claude Code cannot render MCP Apps / embedded UI resources (verified 2026-09-01), so tool results carry the panel URL as text. Do not add MCP Apps embedding without a spike on iframe → 127.0.0.1 WebSocket access.

## Testing notes

- `tests/helpers.ts` (`Sim`) drives mutations through the same append/fold path as the server, with a fixed-step clock — use it for history tests; coalescing cases control time via `advanceMs`.
- Property tests (`tests/core/properties.test.ts`, fast-check) assert the eight TESTS.md § 1 invariants. The drop-node regression (drop the add-B step → edge pruned, adding step flagged conflict) lives in `tests/core/fold.test.ts`.
- Tool contract tests run the real `McpServer` over `InMemoryTransport`; every `get_state` read is validated against the design-authored JSON Schema in `tests/fixtures/contract/`, so contract drift fails tests. Hand-edit that file when the contract grows; `schema/*.generated.json` is emitted from zod.
- A CSS gotcha that already bit once: a path like `_ds/industry-*/` inside a CSS comment terminates the comment (`*/`) and can silently swallow following rules.
