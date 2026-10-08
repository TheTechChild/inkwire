# inkwire shared daemon — implementation plan

Date: 2026-10-08

Sources of truth. Do not change these decisions in this plan.

- [ADR 0001 — One shared daemon owns all boards](../../docs/adr/0001-one-shared-daemon-owns-all-boards.md)
- [ADR 0002 — One AI author per board](../../docs/adr/0002-one-ai-author-per-board.md)
- [ADR 0003 — Each board owns its project root](../../docs/adr/0003-each-board-owns-its-project-root.md)
- [CONTEXT.md — glossary](../../CONTEXT.md) (Board, Project root, Panel, Claude Code session, Client, Author, Reader, Thread, Session mode)

## Goal

Today each Claude Code session starts its own inkwire server, and a second session fails with EADDRINUSE. After this plan, one long-lived daemon owns the database, every open board, and the panel port. Each Claude Code session reaches it through a thin stdio relay over a WebSocket link. The daemon keeps one Client record for each Claude Code process (keyed by pid). Each board has at most one AI Author, and other Clients can only read it. Each board stores its own project root, and every code-ref operation resolves against that root. The person alone releases authorship and restarts the daemon. A final health suite starts a real daemon and two or more relays and runs every tool, so one command tells if the MCP server works.

## Rules for every milestone

- Each milestone leaves `yarn test`, `yarn typecheck`, `yarn map-anchors` and `yarn build` green. Each milestone can ship alone.
- Use yarn only. Do not use npm or npx.
- `src/core` stays pure. Every board-content mutation goes through `BoardSession.mutate`.
- Each PR fixes the MAP.md anchors of the files it changes. Each PR that adds a task surface adds its MAP.md entry in the same PR. The Stop hook catches moved anchors only. It does not catch a missing entry.
- Tests use random ports and temp data dirs. Tests never touch the dev daemon (4692) or the user daemon (4691).
- Write all docs, tool descriptions and error text in ASD-STE100.

## Decisions taken in this plan

The ADRs and the user decisions leave some points open. The mapper areas also disagree on some names. This plan uses these choices. The genuine gaps are in "Open questions".

1. **Client id is the Claude Code pid.** The panel intent and the push use `pid` as the id. There is no other client id.
2. **Panel release intent** is `{ type: "board_release", pid }`. The server releases only when the current Author's pid equals `pid`. A mismatch rejects and re-syncs (a race guard).
3. **Restart has one shutdown function** (`restart()`: persist every board, close every link, exit 0). Two callers use it: the panel WS intent `{ type: "daemon_restart", build_id }` (accepted only when `build_id` equals the stale build that the panel showed), and `POST /api/daemon/restart` (used by `yarn daemon:restart`). There is no MCP tool for restart.
4. **`boards_release` is an MCP tool.** ADR 0002 names it as a release path.
5. **`INKWIRE_PROJECT_ROOT` is removed.** ADR 0003 makes the root a board field. If a launch config sets it, it has no effect.
6. **The daemon gets a new entry file, `src/server/daemon.ts`.** `src/server/index.ts` stays the stdio entry until the cut-over (M7). So M4 adds the daemon and relay without a change to what the plugin runs. M7 points `plugin.json` at the relay and removes the stdio entry.
7. **Stale build.** A daemon is stale when a relay's `build.id` differs from the daemon's id and the relay's `built_at` is later. Hello sends both fields.
8. **Author label in the panel** is the basename of the Client's cwd, then `pid N` (for example `content-collections · pid 48211`).
9. **Link framing.** The link sends one JSON-RPC message in each WebSocket text frame. This meets the intent of "newline-delimited" in ADR 0001: each message has a clear boundary. The hello has no project root, because ADR 0003 makes the root a board field. The hello cwd is used only for the `boards_list` overlap filter, for relative import paths and for the Author label (Decision 8).
10. **The daemon reads its build id one time, at boot.** `daemon.ts` calls `readBuildInfo()` once and keeps the value. `/healthz` and the stale comparison (Decision 7) use only that kept value. A `yarn build` after boot does not change the id that the daemon reports.
11. **One Client can have many links.** Two relays in one Claude Code process (for example two installed inkwire plugins) send the same pid. Both links map to one Client. The daemon counts links for each pid. It removes the Client only when the last link for that pid closes.
12. **Trust boundary.** The authorship and restart rules are enforced on the MCP surface. The browser routes (`/ws`, `/mcp` upgrades and every state-changing HTTP route) check `Host` and, when present, `Origin` (M4.11), so a web page in the person's browser cannot reach them. A local process that runs as the person is trusted: the skills and CLAUDE.md tell agents not to call these paths.

## Milestone order

| # | Milestone | Depends on |
|---|-----------|------------|
| M1 | Project root and store migration | — |
| M2 | Clients module and per-client state, behind the stdio server | — |
| M3 | Authorship enforcement | M1, M2 |
| M4 | Link, relay, daemon, lifecycle and build id (not yet used by the plugin) | M2, M3 (the `daemon.test.ts` claim cases need the M3 wrapper) |
| M5 | Panel UI and WS protocol | M3, M4 |
| M6 | Docs, MAP entries and skills | M1–M5 |
| M7 | Cut-over and the post-migration step | M1–M6 |
| M8 | MCP health suite | M7 |

M1 and M2 do not touch the same code paths much. Two people can do them at the same time. Merge M1 first, because M2 rewrites the `mcp.ts` deps that M1 also changes.

---

## M1 — Project root and store migration (ADR 0003)

**Goal.** Each board stores a required `project_root`. Every ref operation resolves against the board's own root. `boards_list` filters by overlap with the caller's cwd. `boards_create`, `boards_clone`, `boards_update` and `boards_import` set or check the root. The stale `boards_open` description is fixed. The server is still the stdio server, so the caller's cwd is `process.cwd()` for now.

### Steps

**M1.1 Store column, BoardMeta and BoardListing.**
- `src/server/store.ts:41` CREATE TABLE boards: add `project_root TEXT NOT NULL DEFAULT ''`.
- `src/server/store.ts:55-70` migration blocks: add a fourth block `try { ALTER TABLE boards ADD COLUMN project_root TEXT NOT NULL DEFAULT '' } catch { /* column already exists */ }`. Copy the existing style exactly.
- `src/server/store.ts:20` `BoardListing`: add `project_root: string`.
- `src/server/store.ts:73` `list`: select `project_root`.
- `src/server/store.ts:91` `load`: set `meta.project_root = (row.project_root as string | undefined) ?? ''`.
- `src/server/store.ts:124` `create`: add a `projectRoot` parameter.
- `src/server/store.ts:142` `save`: write the column on insert and on `ON CONFLICT`.
- `src/shared/types.ts:149` `BoardMeta`: add `project_root: string` (`''` means unset).
- `src/server/session.ts:502` `Sessions.create(name, projectRoot, content?)`: the root is a required argument.
- `src/server/board-file.ts:132` `importBoard`: pass the root through (M1.5 sets it).
- `''` means unset. Only a migrated row can hold it.

**M1.2 Root checks and ref operations against the board root.**
- New `src/server/project-root.ts`:
  - `checkRootArg(p)`: reject `''`, a relative path, a missing path and a file. Use one message: `project_root must be an existing absolute directory: <p>`. Return `path.resolve(p)`.
  - `boardRoot(session)`: if the root is `''`, throw `board <id> has no project root — set one with boards_update(board_id, project_root)`. If the directory does not exist and the board has a `main_root` that exists, do not throw: M1.8 changes `boardRoot` to return `{ root, fallback }`, and reads use the fallback. If the directory does not exist and there is no `main_root` that exists, throw `project root <p> of board <id> no longer exists — set a new one with boards_update(board_id, project_root)`.
- `src/server/bindcode.ts:25` `resolveRef`: throw when `projectRoot === ''`. This is a backstop: `path.resolve('', ref)` resolves against the daemon cwd without an error.
- `src/server/mcp.ts:29` `McpDeps.projectRoot`: remove. Add `cwd: () => string` (default `process.cwd()`; M4 gives the hello cwd).
- `src/server/mcp.ts:306-319` `canvas.bind_code`: with a ref, use `validateRef(boardRoot(session), ...)`. The result `project_root` comes from the board. Endpoint-only binds still work on an unset-root board.
- `src/server/mcp.ts:369-375` `canvas.lint`: use `lintBoard(boardRoot(session), ...)`.
- `src/server/mcp.ts:453-455` `refWarnings` and `stamp`: build them inside the `paths.create` and `paths.update` handlers from `boardRoot(session)`. Call `boardRoot` only when a step has a ref or `verify` is given. Refless paths still write.
- `src/server/mcp.ts:492` `paths.get` `refStatus` and `src/server/mcp.ts:508` `paths.play` `lintPath`: on an unset root, or on a missing root with no `main_root` that exists, return `ref_status: null` and a warning that names `boards_update`. On a missing root with a `main_root` that exists, resolve against `main_root` and add the M1.8 fallback warning. The board stays readable (ADR 0003).
- Tool descriptions: remove the `${deps.projectRoot}` text. Say "resolved against the board's project_root".
- `src/server/mcp.ts:165` `boards.create`: require `project_root`. Check it with `checkRootArg`.
- `src/server/mcp.ts:147` `boards.open` description. New text: "Return the state of a board. If you are not the author of a board, the board also becomes your current board. If you are the author of a board, your current board does not change (it is always the board you author). Opening never claims or releases authorship. If the board is already open in the daemon, its in-memory history and revision counters stay. A board that is not open yet starts at step 0. The result names the panel URL." Fix `src/ui/panel.ts:48` (the `MCP_TOOLS` row) to match. M1 deviation (review, 2026-10-08): M1 has no Author, so M1 ships only the sentences that are true now: "Return the state of a board and make it your current board. If the board is already open, its in-memory history and revision counters stay. A board that is not open yet starts at step 0. The result names the panel URL." M3 restores the author sentences in both places.
- `src/server/config.ts:10,17`: remove `Config.projectRoot` and `INKWIRE_PROJECT_ROOT`. `src/server/index.ts:43,50`: remove the log text and the McpDeps argument.
- `src/shared/schemas.ts:193` `toolArgs['boards.create']`: add `project_root: z.string().min(1)`.
- `src/shared/schemas.ts:151` `canvasStateSchema.board`: add `project_root: z.string()`. `src/server/session.ts:351` `BoardSession.state()`: fill it.
- `tests/fixtures/contract/canvas-state.schema.json:10-18`: hand-edit. Add `project_root` (string, required).
- Run `yarn gen:schemas`.

**M1.3 `boards_list` overlap filter.**
- `src/server/project-root.ts`: add `rootOverlaps(root, cwd)` and `listBoards(listing, cwd, all)`. Overlap is true when `path.relative` in either direction is `''` or does not start with `..` and is not absolute. `/a/foo` must not match `/a/foobar`.
- An entry with root `''` or a missing directory gets `root: "unset"` and always shows (ADR 0003). An entry with a missing directory also shows its `main_root` (M1.8). When that `main_root` exists, reads on that board fall back to it.
- `src/shared/schemas.ts:191` `toolArgs['boards.list']`: add `all: z.boolean().optional()`.
- `src/server/mcp.ts:142` `boards.list`: use `listBoards(store.list(), deps.cwd(), args.all)`. Description: "Boards for this checkout (the root equals, contains, or is inside your cwd), plus boards with root: unset. all: true lists every board."
- `src/server/http.ts:69` `GET /api/boards`: return every board with `project_root` and the unset mark. The panel has no cwd, so it does not filter.

**M1.4 `boards_update(board_id, name?, project_root?)`.**
- `src/shared/schemas.ts:195` `toolArgs`: add `boards.update`.
- `src/server/session.ts`: add `BoardSession.updateMeta(patch)`, modeled on `setViewport` (`:227`). It sets name or root, schedules persist, adds a log line, and notifies. It is not a history step, so it is not undoable.
- `src/server/mcp.ts`: register `boards.update` after `boards.delete`. Reject a call with no field. Check `project_root` with `checkRootArg`.
- `src/ui/panel.ts:47` `MCP_TOOLS`: add a row.
- M3 adds the Author gate. Until then, write the handler so that it resolves the board through one helper (`writable()` in M3) and not through `sessions.resolve` directly.

**M1.5 Board file v5 and import root.**
- `src/shared/board-file.ts:19` `BOARD_FILE_VERSION`: 4 to 5. `:21` `boardFileSchema`: add `project_root: z.string().optional()`. `:23-24`: keep versions 1–4 importable. Update the doc comment ("4: before project_root").
- `src/server/board-file.ts:20` `exportBoard`: write `project_root` when it is set. Omit it when unset.
- `src/server/board-file.ts:57` `importBoard(…, { projectRoot? })`: use this order. (1) The explicit argument, checked with `checkRootArg`. A bad explicit root fails. It never falls through. (2) Else the file's root, only when it is an existing absolute directory on this machine. (3) Else throw `ImportError`: "the file names project root <p>, which does not exist here — pass project_root", or "the file has no project root — pass project_root".
- `src/shared/schemas.ts:194` `toolArgs['boards.import']`: add `project_root: z.string().optional()`.
- `src/server/mcp.ts:172-175` `boards.import`: a relative `path` resolves against `deps.cwd()`.
- `src/server/http.ts:103-130` `POST /api/boards/import`: read `?project_root=`. Return 400 with the `ImportError` text.
- `src/ui/panel.ts:274` `importBoardFile`: on that 400, ask the person for an absolute path, then retry with `?project_root=`.

**M1.6 `boards_clone(board_id, name?, project_root?)`.**
- `src/shared/schemas.ts:195` `toolArgs`: add `boards.clone`.
- `src/server/session.ts:502` `Sessions.clone(sourceId, name, projectRoot)`: read the source through `open(sourceId)`, so unsaved edits are included. Copy with `structuredClone`: the folded collections, viewport, layers (with paths and `ref_hash`), drafts and notebooks. Do not copy history, thread, focus, `active_draft`, `active_notebook`, trace, highlight or authorship. Call `create(name ?? \`${source name} copy\`, root, content)`, then `persistNow()`. The clone starts at step 0.
- Name: the argument, else `<source name> · <basename of new root>`, else `<source name> copy` when the root is the source's root. Then pass the name through `uniqueName` (M1.6b). This applies to a given name and to the default name.
- The root is the argument, else the source root. Both must pass `checkRootArg`. So a clone of an unset-root source needs an explicit `project_root`. The error names that argument.
- `src/server/mcp.ts`: register `boards.clone` after `boards.create`. The clone becomes the caller's current board. (M3 makes the caller its Author.)
- `src/ui/panel.ts:47`: add a row.

**M1.6b One name rule for every new board.** `boards_create`, `boards_import` and `boards_clone` share one helper, `uniqueName(name)` in `src/server/session.ts` beside `Sessions.create`. It compares exact names across all boards (every root). If a board with that exact name exists, it appends ` (2)`, ` (3)`, … — the lowest counter that is free. Each of the three tools returns `name_check: "OK"` when the name did not change, else `warning: "a board named <name> exists; this board is named <name> (N)"`. M1.2 (`boards_create`), M1.5 (`boards_import`) and M1.6 (`boards_clone`) call it. Tests: the M1 naming cases for all three tools.

**M1.7 Skills for the project root.** The skills must agree with the new behaviour in the same PR, because each milestone can ship alone.
- `skills/use-inkwire/SKILL.md`: step 1 — `boards_list` shows boards whose root overlaps this cwd, plus unset boards. Use `all: true` when the board that the person names is not there. If no board fits, `boards_create` needs a name and a `project_root`. Ask the person for the root. Do not assume the cwd.
- `skills/trace-path/SKILL.md`: step 2 — node refs are relative to the board's `project_root` (from `boards_list` or `canvas_get_board`), not to the cwd of this session. If `bind_code` or lint fails with an unset or missing root, name `boards_update` and ask the person for the root. Add `boards_update` to `allowed-tools`.


**M1.8 Main checkout and read fallback (Open question 6).**
- `src/server/store.ts`: add `main_root TEXT NOT NULL DEFAULT ''` in the same migration style as `project_root`. `''` means "none".
- On `boards_create`, `boards_clone`, `boards_import` and `boards_update(project_root)`, set `main_root` from git: run `git -C <root> rev-parse --path-format=absolute --git-common-dir`. If the root is inside a linked worktree, `main_root` is the parent of that common dir (the main checkout), mapped to the same relative position as the root inside its worktree. Otherwise `main_root` is `''`. A git failure gives `''`, never an error.
- `boardRoot(board)` returns `{ root, fallback }`. If `project_root` exists, use it. Else, if `main_root` exists, use it with `fallback: true`. Else fail with the unset/missing-root error.
- With `fallback: true`, reads (`paths_get`, `paths_play`, `canvas_get_board` ref statuses) resolve against `main_root` and add the warning "resolved against main checkout <main_root>; set the root with boards_update to make this permanent". Ref writes (`bind_code` with a ref, `paths_create`/`paths_update` stamps, `verify`) and `canvas_lint` fail with that text.
- `boards_list` shows `main_root`. A fallback board keeps the ADR 0003 mark `root: unset`, because its root no longer exists. The `main_root` field tells the agent that reads fall back.

### Tests

- New `tests/integration/store.test.ts`: (a) build a temp DB with the old CREATE TABLE, insert a row, open `new Store(dir)`. `load()` and `list()` give `project_root === ''`. (b) Open the store a second time with no error. (c) `create` then `load` and `list` round-trip the root. (d) `save` with a changed root overwrites on conflict.
- New `tests/tools/project-root.test.ts`: `checkRootArg` and `boardRoot` cases. `rootOverlaps`: equal, cwd is a parent, cwd is a child, sibling, shared string prefix (`/a/foo` vs `/a/foobar`), trailing separators.
- `tests/tools/contract.test.ts`: every `boards_create` call (lines 74, 210, 302) passes `project_root`. `beforeAll` (line 66) removes the `projectRoot` dep and creates the board with the temp root, so the bind_code, lint and stamp tests (177-199, 607-640) do not change. Add:
  - `boards_create` with no root, `''`, a relative path, a file and a missing dir: each gives `isError` with the rule text.
  - `state.board.project_root` equals the root. The fixture validates it.
  - A board with root `''` (store row written directly): `canvas_bind_code` with a ref, `canvas_lint`, `paths_create` with a ref and `paths_update` with `verify` fail and name `boards_update`. `canvas_add_node`, endpoint-only `bind_code` and refless `paths_create` succeed. `paths_get` returns `ref_status: null` with a warning.
  - A board whose root (a temp dir outside git, so `main_root` is `''`) was removed with `rmSync` fails the same way.
  - Two boards with different roots resolve one relative ref to two different files.
  - `boards_clone` naming: default `<name> · <root basename>`; same root gives `<name> copy`; a second clone with the same name gives ` (2)`, a third ` (3)`; after ` (2)` is deleted, the next clone takes ` (2)` again. `name_check: "OK"` when unchanged, else a warning that names the new name.
  - `boards_create` and `boards_import` naming (M1.6b): a name that exists gives ` (2)`, then ` (3)`; after ` (2)` is deleted, the next board takes ` (2)` again; `name_check: "OK"` when unchanged, else a warning that names the new name. A name that exists only under another root also gets the counter.
  - `boards_list`: boards in roots A and B and one unset row. From cwd A: A and unset. From the common parent: all of them. `all: true`: all of them. A board with a removed root outside git (`main_root` `''`) shows `root: "unset"`.
  - `main_root` (M1.8): a root inside a linked worktree gives the `main_root` of the main checkout at the same relative position. A root outside git gives `''`. A git failure (for example `git` not on `PATH`) gives `''` and no error. After the worktree is removed, `paths_get`, `paths_play` and `canvas_get_board` resolve against `main_root` and give the warning "resolved against main checkout <main_root>; …". `boards_list` shows that board as `root: "unset"` with its `main_root`. `canvas_bind_code` with a ref, `paths_create` and `paths_update` with a ref stamp, `verify` and `canvas_lint` fail with that text. `boards_update(project_root)` sets `main_root` again.
  - `boards_update`: rename shows in state and in `boards_list`. A root update makes an unset board pass `canvas_lint`. Bad roots, no fields and an unknown id fail.
  - `boards_clone`: content, layers with `ref_hash`, drafts and notebooks are copied. `history_get` head is 0. The default root is the source root, and an explicit root wins. Edits made less than 500 ms before the clone are in it. A change to the clone does not change the source. An unset-root source with no `project_root` fails and names it.
  - `boards_import`: `project_root` sets the root. A relative path resolves against the cwd.
  - `boards_open`: call it, add a node, call it again. `history.steps` and `graph.revision` do not reset. The description does not contain "resets".
- `tests/integration/server.test.ts:203-345`: the v1–v4 import fixtures pass `?project_root=<tmp>`. Add: v5 export has `project_root`; an unset board exports without it; a v5 file with an existing root imports; a missing file root gives 400; the explicit root wins; a bad explicit root gives 400 even when the file root exists; a v4 file with no argument gives 400. `GET /api/boards` entries have `project_root`.
- `tests/tools/session.test.ts:43,52,348` and `tests/tools/stdio-smoke.test.ts:24,49`: pass `project_root`. Remove `INKWIRE_PROJECT_ROOT`.
- `tests/core/schema-parity.test.ts` stays green after `yarn gen:schemas`.

### Done when

- All tests above pass. `yarn typecheck`, `yarn map-anchors`, `yarn build` pass.
- MAP.md: the Persistence anchors (`MAP.md:496-499`), the board-file anchors (`MAP.md:478-486`), the Code binding text (`MAP.md:449-470`), the env line (`MAP.md:37`) and the `boards.open` text (`MAP.md:75`) are current. A new "Project root" entry names `project-root.ts`, the migration, and the five board tools.
- CLAUDE.md: the env line drops `INKWIRE_PROJECT_ROOT`. The rule "`boards.open` resets both" becomes "revisions reset only when the daemon loads the board for the first time".

### Risks

- The migration runs on the live `~/.inkwire/inkwire.db` at the first start of this build. It only adds a column with a default, and the old build ignores the column, so a rollback is safe. Back up `inkwire.db` before the first start.
- From M1 to M7, ref operations on `b_8946f6` fail until someone runs the post-migration step. The person can run it at any time after M1 ships. M7 makes sure it is done.
- Old board files (v1–v4) have no root. Panel import of such a file needs the prompt-and-retry path, or panel import fails for all old files.
- `boards_update` changes name and root outside history. The person cannot undo it from the timeline.
- M1 changes `canvasStateSchema.board`. The hand-edited fixture and `yarn gen:schemas` must be in the same PR.
- The tool count in `tests/tools/session.test.ts:63` (43 today) goes up by 2 (clone, update). M3 adds 1 more (`boards_release`). Update the count in each PR.

---

## M2 — Clients module and per-client state behind the stdio server

**Goal.** Move all server-wide session state out of `Sessions` into a per-Client record. The stdio server makes exactly one Client (from `process.ppid`), so behaviour does not change for the user. The hook route finds the Client by the Claude Code pid. After M2, the code is ready for many Clients.

### Steps

**M2.1 `hooks/forward.sh` sends the Claude Code pid.**
- `hooks/forward.sh:7-10`: walk up from `$PPID` with `ps -o ppid= -p` and `ps -o comm= -p`. Stop at the nearest process whose comm basename is `claude`. Also accept a process whose `args` first word has the basename `claude` (Claude Code can run as `node`). Stop at pid 1 or after 16 levels. Add `&pid=<n>` to the hook URL. Leave it out when there is no `claude` ancestor. The script must exit 0 on every failure.
- Verified behaviour: the `claude` ancestor is the relay's `ppid`. In tests, `claude` was the direct parent of the hook.
- `hooks/hooks.json:14-19` SessionStart matcher: `compact` becomes `compact|clear|resume`.
- `src/server/http.ts:55-67` `/api/hook`: read `pid`, parse it to an integer or null, and put it in `HookInput` as `claude_pid` (`src/server/session-mode.ts:273`).

**M2.2 `src/server/clients.ts` (new, no I/O).**
- `Client`: `pid`, `sessionId` (mutable), `cwd`, `build`, `termProgram: string | null` (from the hello, Open question 3), `label` (cwd basename), `currentBoardId`, `mode: SessionMode`, `hook: HookReport | null`, `pending: { boardId, resolve, timer } | null`, `blocks`.
- `Clients`: `byPid` map, `authors: Map<boardId, pid>`, `noticeByBoard`.
  - `ensure(pid, init?)`: the hello or the first hook creates the record. A later caller fills missing fields.
  - A record that only a hook made has no link. If no hello comes for that pid within `HOOK_ONLY_TTL_MS` (60 s, clock injected), remove it. A hello cancels the TTL. So a Claude Code process whose relay never connects leaves no record, and a later process with the same pid gets a fresh record.
  - `attach(pid, linkId)` and `detach(pid, linkId)`: count the links of each pid (Decision 11). `detach` removes the Client only when it was the last link, and only when the record still belongs to that link set. A `detach` for a link that the record does not hold does nothing. So a late close of an old link cannot delete the Client of a newer hello.
  - `get(pid)`, `bySessionId(id)`, `rekey(pid, newSessionId)`.
  - `remove(pid)`: release authorship (reason `disconnect`) and return the Client, so the caller can resolve `pending`. Only `detach` (last link) and the hook-only TTL call it.
  - `boardDeleted(boardId)`: release the board (reason `deleted`). Set `currentBoardId` to null on every Client whose current board is `boardId`. Resolve the pending send of each of them that waits on that board.
  - `authorOf(boardId)`, `readerCount(boardId)` (Clients whose current board is `boardId`, less the Author), `talkingOn(boardId)` (the Author when its mode is `inkwire`, else null).
  - `checkWrite(client, boardId)`: throw when another Client is the Author. The message names the Author label and pid and tells the agent to ask the person to release the board in the panel.
  - `commitClaim(client, boardId)`: one board per Client. A claim of B releases the Client's earlier board A (reason `switch`). It does nothing when `boardId` is no longer an open or stored board. It checks the Author again: when another pid claimed the board after `checkWrite`, it throws and changes nothing.
  - `release(boardId, reason)`, where reason is `client | person | disconnect | switch | deleted`. It returns the released Client.
  - `onChange` listener.
- Move `HookReport` from `src/server/session.ts:435` to `clients.ts` (re-export it).
- Get the clock by injection from `Sessions.now`.

**M2.3 Rewrite `src/server/session-mode.ts` for per-client state.**
- Remove from `Sessions` (`src/server/session.ts:445-490`): `currentBoardId`, `mode`, `notice`, `hook`, `boundSession`, `pending`, `blocks`, `resolvePending`. Keep `boards`, `now()`, `sendTimeoutMs`, `onChange`/`notify`. Fix the comment at `:444` ("server-wide session mode").
- All functions in `session-mode.ts` take `(clients, client, …)` in place of the 34 `sessions.` uses: `sessionMode` (`:35`), `modeOff` (`:75`), `sessionSend` (`:103`), `sessionReply` (`:203`), `hookEvent` (`:283`), `record` (`:315`).
- `sessionMode(on)`: run the hook, permission and background checks on `client.hook`. Then require `client.currentBoardId`. While the Client is in `inkwire` mode on board A, mode on for another board fails with the M3.5 text (ADR 0002). `boards_open` by a Client in `inkwire` mode does not move its current board and adds a second text block that says so (the `inkwire` part of the M3.5 "Open does not move an Author" rule; M3.5 adds the `pty` part). If the board has another Author, fail with the M2.2 message. If the board's `releasedFrom` is this pid, fail with the "ask the person to allow you again" message (M3). If the board has no Author, the call claims it (Open question 1, answered). Assert that at most one Client per board is in `inkwire` mode.
- `modeOff(client, …)`: resolve `client.pending`. Write the row only on the board that the Client authors (or on the pending board). A Client that authors no board writes no row. Remove `boundSession`. Routing by pid replaces it. Set `clients.noticeByBoard`.
- `sessionMode` writes its own row only when the Client is the Author of the board. A refused `session_mode(on)` and a reader's `session_mode(off)` write no row (CONTEXT.md: Readers never appear in the Thread).
- Add `releaseAuthorship(client, boardId, reason)`: run `modeOff` with `{ status: "mode_off" }` when the Client was talking. `Clients.release` calls it for every reason.
- `sessionReply(clients, session, args)`: send to `clients.talkingOn(session.boardId)`. Fail when that is null. Panel replies reach only the talking Client.
- `hookEvent(clients, input, bg)`: find the Client by `claude_pid` (`ensure` creates it), else by `session_id`, else return `{}`. Store the HookReport on that Client. On SessionStart `clear` or `resume`, rekey to the new `session_id`. On `compact`, re-inject only when that Client is in `inkwire` mode. Stop blocking uses `client.blocks`.
- `src/server/session.ts:524-540` `Sessions.delete`: call `clients.boardDeleted(boardId)` (M2.2). It releases the Author, clears `currentBoardId` on every Client that points at the board (the Author and all readers), and resolves each pending send on it with `idle`. The notice for that board is "board deleted · mode pty". After a delete, a call with no `board_id` fails with "no board is open", and `readerCount` of the deleted board is 0.
- `sessionSend(clients, client, args)`: do not resolve the board with `sessions.resolve(args.board_id)` alone (`mcp.ts:122`). In M3, resolve it through `writable()` (M3.2). In both milestones, the board must be the board that the Client authors and talks on (`talkingOn(board) === client`). Reject any other `board_id` before the handler writes a Thread row or calls `setHighlight`, `openTrace`, `setActiveDraft` or `setActiveNotebook`.
- `src/server/ws.ts:25-27` (onChange push loop), `:145-150` (`session_reply`, `session_mode_off`), `:203-213` (`push`): read mode, pending and notice from `talkingOn(boardId)` and `noticeByBoard`. Keep the old `SessionPush` fields (`src/shared/protocol.ts:173`) with these values. The panel `session_mode_off` intent turns off `talkingOn(boardId)` and is a no-op when that is null.
- `src/server/mcp.ts:25` `McpDeps`: add `clients` and `client`. `current()` (`:51`), `resolve` (`src/server/session.ts:514`) and the `currentBoardId =` writes (`mcp.ts:151,167,184`) use `client.currentBoardId`.
- `focusTerminal`: take the app name from the `termProgram` of the Client that leaves `inkwire` mode (decided 2026-10-08; only that Client can be in the mode on its board, so this is the talking Client). Fall back to `process.env.TERM_PROGRAM`.
- Interim wiring in `src/server/index.ts:17,46-55`: make one Client from `process.ppid`, `CLAUDE_CODE_SESSION_ID`, `process.cwd()` and `TERM_PROGRAM`. Pass it to `buildMcpServer`. Hooks from that pid route to it.

### Tests

- New `tests/tools/forward-hook.test.ts`: a stub HTTP server on a random port, and a symlink named `claude` to `/bin/sh` in a temp dir. Run `claude -c 'sh hooks/forward.sh; :'` with `INKWIRE_PORT`. The `; :` is necessary: with one command, `/bin/sh` on macOS execs it in place, so `claude` becomes `forward.sh` and `$PPID` is the test runner (verified). The stub gets `pid` equal to the `claude` pid. Test the `args` first-word match and the `comm` match each alone: on macOS `ps -o comm=` can give a cut path (`/private/tmp/cla`), but `exec -a` and a symlink give the same argv[0] to both fields, so the test puts a stub `ps` first on PATH that gives a cut `comm` (or a `node …` `args`) and sends every other query to `/bin/ps`. With no `claude` ancestor, no `pid` is sent and the exit code is 0. With the server down, the exit code is 0.
- New `tests/tools/clients.test.ts` (unit): a hook then a hello merge into one record; `rekey` keeps the pid; `remove` releases authorship; claim on an unclaimed board; a claim of B releases A; `checkWrite` on another Author's board throws, names the Author, and A stays claimed; `readerCount` does not count the Author; `talkingOn` is null unless the Author is in `inkwire` mode; a hook-only record with no hello is removed after the TTL, and a hello before the TTL keeps it; two links for one pid keep the Client until the second `detach`; a `detach` of an old link after a newer hello does not remove the Client; `boardDeleted(B)` clears `currentBoardId` on the Author and on every reader of B and gives `readerCount(B) === 0`; `commitClaim` on a deleted board does nothing; `commitClaim` throws when another pid claimed the board after `checkWrite`.
- `tests/tools/session.test.ts` (lines 74-347): assert `client.mode`, `client.pending`, `client.blocks` in place of `sessions.*`. `armed()` passes `claude_pid`. Add: a hook with `claude_pid=202` does not arm Client 101; SessionStart `clear` with a new id rekeys and the mode stays on; `compact` re-injects only for the talking Client; a pending send of Client A is not resolved by mode off of Client B; a board delete during a pending send returns `idle` and sets the per-board notice; a reader whose current board is deleted gets "no board is open" on its next call with no `board_id`; `session_mode(off)` from a Client that authors no board writes no Thread row; with an injected focus stub, mode off of a Client with `termProgram: "iTerm.app"` focuses `iTerm.app` even when the daemon env has another `TERM_PROGRAM`, and a Client with `termProgram: null` uses the daemon env.
- `tests/integration/server.test.ts:453`: set the Client's mode, not `sessions.mode`. Add: a panel reply reaches only the talking Client.

### Done when

- Tests pass. The manual Claude Code check (`/use-inkwire`, a panel reply, `/back-to-claude-code`, `/clear` while in `inkwire` mode) moves to M7, against the final build (decided 2026-10-08: the auto-mode classifier stops the agent from starting Claude Code sessions, so Clayton runs it once).
- MAP.md: the "Session mode and hooks" anchors (`session-mode.ts`, `session.ts:435`) are current. A new entry "Clients and authorship" names `src/server/clients.ts`. The write-path text (`MAP.md:69-71`) says `Sessions` holds open boards only.

### Risks

- The `compact|clear|resume` matcher makes each `/clear` and `/resume` call curl. That adds up to 5 s when the server hangs (`--max-time 5` stays).
- On macOS `ps -o comm=` can give a full path or a cut name. Match the basename, and also the first word of `args`. If no `claude` ancestor is found, the server falls back to `session_id`. On that path the SessionStart `clear`/`resume` rekey cannot work: the event carries only the new id, which matches no Client, so the hook returns `{}` before the rekey. After `/clear`, the Client keeps the old id and later Stop hooks reach no Client (the Stop hook does not block, and replies go to the terminal). `tests/tools/session.test.ts` shows this limit. The old `boundSession` code had the same limit.
- The panel strip and notice change from server-wide to per board. A panel on another board no longer sees a mode change. This is intended.
- Until M4, only one Client exists in production. The multi-client rules are tested in-process only.

---

## M3 — Authorship enforcement (ADR 0002)

**Goal.** Only the Author writes a board. The first write claims an unclaimed board. A Client authors at most one board. Readers' calls do not go into the Thread. `boards_release` releases the caller's board. Every board tool from M1 goes through the gate.

### Steps

**M3.1 Readers are not recorded.**
- `src/server/mcp.ts:52-68` `recordCall`: today it writes on `current()` (`mcp.ts:51`), not on the board that the handler wrote. Change it. `writable()` (M3.2) stores the resolved board id in a per-call slot. The wrapper reads that slot for `commitClaim` and for `recordCall`. A write records on the written board. A read records on the resolved board of the call, else on the current board. Write the row only when `clients.authorOf(board) === client.pid`. Before the first claim, write nothing for that call. (The wrapper calls `commitClaim` before the record step, so a first write is recorded on the board it claimed.)
- A successful claim sets `client.currentBoardId` to the claimed board (Open question 9). So a write with `board_id` B while the current board is A makes B current. A later `session_mode(on)` then acts on B, the authored board.

**M3.2 The write gate.**
- `src/server/mcp.ts`: add `writable(boardId?)`. It resolves the board and calls `clients.checkWrite(client, id)`. Every write handler uses it in place of `sessions.resolve`.
- `src/server/mcp.ts:73-99` `register` wrapper: call `clients.commitClaim` only after the handler returns with no error. So a failed write never claims B and never releases A.
- The claim must be atomic. Every write handler is synchronous from `writable()` to its last mutation: it does all awaited work (for example a file read for refs) before it calls `writable()`. `commitClaim` checks the Author again as a backstop (M2.2). The exhaustive authorship test checks that two Clients that write one unclaimed board in parallel give exactly one Author.
- `boards_delete` does not go through `commitClaim`. Deleting is not a claim (ADR 0002: "Delete is a write", not a claim). After a delete, `clients.boardDeleted` (M2.3) removes the board from `authors`.
- Export `WRITE_TOOLS` and `READ_TOOLS`.
  - Write (28): `canvas_infer_structure`, `canvas_add_node`, `canvas_update_node`, `canvas_add_edge`, `canvas_update_edge`, `canvas_delete`, `canvas_move`, `canvas_bind_code`, `canvas_annotate`, `canvas_set_viewport`, `layers_create`, `layers_update`, `layers_focus`, `layers_delete`, `paths_create`, `paths_update`, `paths_delete`, `paths_play`, `drafts_create`, `drafts_update`, `drafts_delete`, `drafts_activate`, `notebooks_create`, `notebooks_update`, `notebooks_delete`, `notebooks_open`, `boards_update`, `boards_delete`.
  - Read: `boards_list`, `boards_open`, `canvas_get_state`, `canvas_get_board`, `canvas_screenshot`, `canvas_export_mermaid`, `canvas_lint`, `history_get`, `layers_list`, `paths_get`, `drafts_get`, `notebooks_get`.
  - Own rules: `boards_create`, `boards_import` and `boards_clone` claim the new board for the caller (switch rules release the earlier board). Clone is a read of the source. `session_mode(on)` is gated in M2. `session_mode(off)` is open to all, but writes a Thread row only for the Author (M2.3). `session_send` resolves its board through `writable()` and must target the board that the Client authors and talks on (M2.3); any other `board_id` fails with no change to any board. `boards_release` is in M3.3. `boards_delete` is in the write list for the gate, but it never claims (see above).
- `boards_delete` (`src/server/mcp.ts:157`): allowed for the Author, or for any Client when the board has no Author.
- WS intents (`src/server/ws.ts`) and HTTP `DELETE /api/boards/:id` and `POST /api/boards/import` are the person. They never go through the gate.
- Check every write handler: it must not change the board and then throw. `paths_play` calls `openTrace` and then `lintPath`. Run `lintPath` first, or catch its error into a warning.

**M3.3 `boards_release`.**
- `src/shared/schemas.ts:190-195`: add `"boards.release": z.object({ board_id: z.string().optional() })`.
- `src/server/mcp.ts`: register it in the boards family. The caller releases the given board or the board it authors. It fails when the caller is not the Author. If the caller was talking, run mode off with `mode_off`.
- Add a `releasedFrom` pid for each board in `Clients`. `release(boardId, "person")` sets it to the old Author's pid. While it is set, every write by that pid on that board fails with "you are no longer the author of <board>; the person released it. Ask the person to allow you again in the panel". `releasedFrom` is cleared when another Client claims the board, when that pid disconnects, or when the person allows the pid again (`allowAgain(boardId, pid)`, M5). (Open question 2, answered.)
- Run `yarn gen:schemas`. Update the tool count.

**M3.4 Skills for authorship.** Same reason as M1.7.
- `skills/use-inkwire/SKILL.md`: opening a board does not make you the Author. Step 2 — if `session_mode(on)` fails because another Client is the Author, print the error as it is and stop. Do not retry. Do not clone unless the person asks.
- `skills/trace-path/SKILL.md`: before step 1 — if a write fails because another Client is the Author, stop and tell the person. Do not work around it.
- Both skills: do not call the inkwire HTTP API, the panel WebSocket, `/api/hook` or `yarn daemon:restart` (Decision 12).

**M3.5 Board context and notices (Open question 9).** The agent must always know which board it works on.
- A claim makes the claimed board the Client's current board (`currentBoardId`).
- **Context line.** The `register` wrapper in `src/server/mcp.ts` puts one line first in every tool result, reads included: `board <id> "<name>" · you: author|reader · mode: pty|inkwire`. With no current board: `board: none · mode: pty`.
- **Notice on change.** `Clients` keeps a per-Client queue of notices. The wrapper adds them to the next result once, after the context line, then clears them. Events and texts:
  - switch: "Current board is now <id> "<name>". All later edits with no board_id go to it. You released <old id>."
  - claim: "You are now the author of <id>."
  - lost (person release): "The person released <id>. You can still read it."
  - deleted: "Board <id> was deleted. You have no current board."
  - reconnect (M4): "The connection to the daemon was restored. Your current board is still <id>. You are a reader until your next write claims it." If another Client claimed the board in the gap: "… <id> now has another author (<label>). You can read it." If the board is gone: "… Board <id> no longer exists. You have no current board."
- **No switch in `inkwire` mode.** While the Client is in `inkwire` mode on board A, a write, `boards_create`, `boards_clone`, `boards_import` or `session_mode(on)` that would claim another board fails: "You are talking with the person on <A>. Turn the mode off before you move to a different board." Reads of other boards still work.
- **Open does not move an Author.** `boards_open` of board B by the Author of board A returns the state of B, but the current board stays A (CONTEXT.md: the current board of an Author is always the board it authors). Opening never releases A. The result adds the line "You are the author of <A>. Your current board is still <A>. A write to <B> moves you to <B> and releases <A>." This is the same in `pty` and `inkwire` mode. A Client that authors no board gets B as its current board. Restore the M1.2 author sentences in the `boards.open` description (`src/server/mcp.ts`) and the panel `MCP_TOOLS` row; M1 left them out because M1 has no Author.
- **The person sees it.** On a switch in `pty` mode, the old board's Thread gets a row "claude moved to <new id>", and the new board's Thread gets "claude is now the author". (M5 renders them.)
- **After compaction.** `hookEvent` `SessionStart` `compact` returns the context line for that Client, plus the mode instruction when the mode is on.
- Tests (`tests/tools/contract.test.ts` and `tests/tools/clients.test.ts`): every result starts with the context line; each event gives its notice exactly once; a write to B with `board_id` makes B current and names the release of A; in `inkwire` mode a write to B fails and A stays authored and current, and a read of B works; `boards_open` of B by the Author of A returns the state of B, the current board stays A, and A stays authored (in `pty` and in `inkwire` mode); `boards_open` of B by a Client that authors no board makes B current; the compact hook returns the context line.

### Tests

- New `tests/tools/authorship.test.ts`. Two MCP servers over one `Sessions` + `Clients` with `InMemoryTransport` (pids 101 and 202):
  - For each tool in `WRITE_TOOLS`: Author 101 succeeds. Reader 202 gets `isError` with `pid 101` and `release it in the panel`. The board does not change.
  - `WRITE_TOOLS ∪ READ_TOOLS ∪` the own-rule set equals `listTools()`. A new tool must be classified.
  - The first write claims. A write to unclaimed B by the Author of A moves authorship to B. A write to B that another Client authors fails, and A stays claimed. A failed `canvas_add_edge` (bad endpoint) on unclaimed B does not claim B or release A.
  - `boards_delete`: a reader fails; any Client succeeds on a board with no Author. The Author of A deletes unclaimed B: A stays claimed, `authorOf(B)` is null, and a pending `session_send` on A is not released.
  - `session_send` with the `board_id` of another Author's board fails, and that board does not change (no Thread row, highlight, trace, draft or notebook). A Client in `inkwire` mode on its own board cannot send to a board that it only opened.
  - A write with `board_id` B while the current board is A: the call row is on B, and `currentBoardId` is B.
  - Two Clients write one unclaimed board in parallel: exactly one becomes the Author, and the other gets the Author error.
  - A reader's `session_mode(off)` and a refused `session_mode(on)` add no Thread row.
  - `boards_create`, `boards_import` and `boards_clone` make the caller the Author of the new board. A reader of a board can clone it.
  - `boards_update` by a reader fails and names the Author.
  - A reader's `canvas_get_state` adds no row to the Thread. The Author's calls still add rows.
  - `boards_open` by 202 does not claim, and `history.head` does not change when it opens again.
  - `boards_release` frees the board, and another Client can then claim it. A reader's `boards_release` fails.
  - After `release(board, "person")`, every write by the old Author on that board fails with "no longer the author", and the board stays with no Author. After `allowAgain(board, pid)`, its next write claims the board. After another Client claims the board, `releasedFrom` is clear. After the old Author disconnects, `releasedFrom` is clear.
- `tests/integration/server.test.ts`: a human WS `add_node` on a claimed board still succeeds.

### Done when

- Tests pass. The manual Claude Code check is in M7.
- MAP.md "MCP tools" says that call rows are written only for the Author, and names `writable()`, `WRITE_TOOLS` and `READ_TOOLS`. The "Clients and authorship" entry has the claim and release rules.
- CLAUDE.md: "Every MCP call lands in the current board's thread" becomes "Only the Author's MCP calls go into the board's Thread. Readers' calls are not recorded." Add: "Every MCP write handler resolves the board through `writable()`. Add each new write tool to `WRITE_TOOLS`." Add: "The authorship and restart rules are enforced on the MCP surface only. Agents must not call the HTTP API, the panel WebSocket, `/api/hook` or `yarn daemon:restart`."

### Risks

- The write set includes view tools (`canvas_set_viewport`, `layers_focus`, `drafts_activate`, `notebooks_open`, `paths_play`). They change shared panel state, so a reader cannot move the person's screen. A reader skill that calls them now fails on a board with another Author.
- Most layer, draft and notebook writes use `updateLayers`, `updateDrafts` and `updateNotebooks`, not `BoardSession.mutate` (`session.ts:234-287`). So the gate must be in `mcp.ts`, with the exhaustive test. A gate in `mutate()` would miss them and would also block the person.
- `boards_release`, clone and update change the tool count, `toolArgs` and `schema/tools.generated.json`. Merge order can cause conflicts.

---

## M4 — Link, relay, daemon, lifecycle and build id (ADR 0001)

**Goal.** Add the daemon (`src/server/daemon.ts`), the link (`src/link/`), and the relay (`src/link/relay.ts`). Add the build id, idle grace, autostart, reconnect and person-only restart. Wire Clients to the link. The plugin still runs the stdio entry. M7 switches it.

### Steps

**M4.1 Build id.**
- New `scripts/write-build-id.mjs`. `package.json` `build`: `tsc -p tsconfig.build.json && node esbuild.ui.mjs && node scripts/write-build-id.mjs`. The script walks `dist/` (server, core, shared, link, ui), skips `build.json`, sorts the relative paths, hashes each path and its content with sha256, and writes `{ id: <first 16 hex>, built_at: <ISO> }` to `dist/build.json`. `built_at` is not in the hash. So a rebuild with the same output keeps the same id.
- New `src/server/build-info.ts` `readBuildInfo()`: read `new URL("../../dist/build.json", import.meta.url)` (the same trick as `uiDir` at `src/server/http.ts:14`). Return `{ id: "unbuilt", built_at: null }` when the file is missing. `daemon.ts` calls it one time at boot and keeps the value (Decision 10). The relay also calls it one time at its start.
- `src/server/http.ts:27` `HttpDeps`: add `build`, `pid` and optional `stats()`. `src/server/http.ts:47` `/healthz`: return `{ ok, name: "inkwire", pid, build, clients, boards }`. Keep `name: "inkwire"`, because `probeHealth` checks it.

**M4.2 One upgrade router. `PanelHub` moves to `noServer`.**
- Fact: `src/server/ws.ts:28` uses `new WebSocketServer({ server, path: "/ws" })`. In ws 8.21.3, that server gets every upgrade and answers 400 for any other path (`node_modules/ws/lib/websocket-server.js:128` and `:277`). So a second server for `/mcp` cannot share the http server this way.
- `src/server/ws.ts:16` `PanelHub`: use `new WebSocketServer({ noServer: true })`. Add `handleUpgrade(req, socket, head)`. Remove the `server` parameter and the error re-emit at `:29-32`.
- New `src/server/upgrade.ts` `routeUpgrades(server, { [path]: handler })`. It does not import `ws`. It reads the pathname, calls the handler, and calls `socket.destroy()` for other paths.
- `src/server/index.ts:22` and `tests/integration/server.test.ts`: use `routeUpgrades(http, { "/ws": … })`.

**M4.3 `src/link/`: hello, transport, `/mcp` endpoint, boundary test.**
- `tsconfig.build.json`: include `src/link/**/*.ts`.
- `src/link/hello.ts`: zod `helloSchema` `{ type: "hello", v: 1, pid: int, session_id: string | null, cwd: absolute string, build: { id, built_at | null }, term_program: string optional, current_board: string optional }` (ADR 0001; Open questions 3 and 11) and `LINK_VERSION`.
- `src/link/ws-transport.ts` `WsTransport implements Transport` (SDK `shared/transport.d.ts`). One JSON-RPC message per text frame. `send()` writes JSON. `close()` closes with 1000. The socket close calls `onclose`. Bad JSON calls `onerror`. Buffer messages that arrive before `start()`, because `McpServer.connect` awaits `start()`.
- `src/link/endpoint.ts` `createLinkEndpoint() → { handleUpgrade, count, onLink }`. It owns a `noServer` WebSocketServer for `/mcp`. The first frame must be the hello within 5 s, else close 4400. A bad `v` closes 4426 "link version mismatch: run yarn daemon:restart". A valid hello calls `onLink({ transport, hello, closed })`. That object is the whole contract with the daemon.
- New `tests/link/boundary.test.ts` (model it on `tests/core/purity.test.ts`): fail when a file under `src/` imports `ws` and is not under `src/link/` and is not `src/server/ws.ts`. Fail when `src/server/ws.ts` contains `/mcp`.

**M4.4 Daemon entry: bind first, one McpServer per link, no stdio.**
- Move the shared bootstrap from `src/server/index.ts:14` `main` to `src/server/bootstrap.ts`. `src/server/index.ts` stays the stdio entry until M7.
- New `src/server/daemon.ts`:
  - (a) Create a bare `http.createServer()` and listen on 127.0.0.1:port before the store opens.
  - (b) In the listen callback, open the Store and Sessions, and attach the request handler and `routeUpgrades` at once. better-sqlite3 is synchronous, so no request arrives before the handler. Split `createHttpServer` (`src/server/http.ts:33`) into `requestHandler(deps)` and the current wrapper.
  - (c) On EADDRINUSE: if `probeHealth()` sees inkwire, log "another inkwire daemon already owns port N" and exit 0 with no DB open. Else exit 1 with the "taken by another process" text.
  - (d) No `StdioServerTransport`. No `process.stdin.on("close")` (`src/server/index.ts:69`): a detached daemon has stdin set to `ignore` and would exit at once. Keep SIGINT and SIGTERM → `persistAll` and `store.close`.
  - (e) `onLink`: `clients.ensure(hello.pid, { sessionId, cwd, build, termProgram })` (and, when the hello has `current_board`, restore it as in M4.7) and `clients.attach(pid, linkId)`, then a new `buildMcpServer({ …deps, client, cwd: () => client.cwd })` and `await mcp.connect(link.transport)`. On `closed`: `mcp.close()` and `clients.detach(pid, linkId)`. When that was the last link of the pid (Decision 11), `detach` calls `remove(pid)`. That releases authorship (reason `disconnect`), resolves any pending `session_send`, notifies the panels and drops the record (no pid reuse). A hook that arrives first creates the record. The hello then fills it. A reconnect sends the hello again, and that Client starts with no authorship, no `inkwire` mode and no pending send. When the hello has `current_board` and that board exists, it becomes the current board, and the reconnect notice (M3.5) is queued (Open question 11). A close of an old link that arrives after the new hello does not remove the new Client (M2.2 `detach`).
  - (f) The daemon writes nothing to stdout.
- Move `probeHealth` (`src/server/index.ts:72`) to `src/link/probe.ts`.

**M4.5 Daemon port-conflict test.**
- New `tests/integration/daemon-port.test.ts` (the stdio test `tests/integration/port-conflict.test.ts` stays until M7):
  - (a) A second daemon on a port that an inkwire daemon owns exits 0. Its stderr has "another inkwire daemon already owns port". Its own fresh `INKWIRE_DATA_DIR` has no `inkwire.db`. This proves that the loser never runs migrations on the shared DB.
  - (b) A plain node http server holds the port. The daemon exits 1 with "taken by another process", and stderr has no "Unhandled".

**M4.6 Relay: probe, detached autostart, race, stdio–WS pipe.**
- New `src/link/autostart.ts` `ensureDaemon(config)`: probe `/healthz`. If no inkwire answers, make `dataDir`, open `${dataDir}/daemon.log` for append, and `spawn(process.execPath, [...process.execArgv, daemonEntry], { detached: true, stdio: ["ignore", log, log], env })`, then `unref()`. `daemonEntry` is `new URL("../server/daemon" + ext, import.meta.url)`, with `ext` from the relay's own file. So tests run src under tsx, and the plugin runs dist from its own dir. Poll every 100 ms for up to 10 s. A racing second daemon exits 0 (M4.4 c), and both relays use the winner. If a non-inkwire process holds the port, write the reason to stderr and exit 1. If `/healthz` answers `name: "inkwire"` with no `build` field, the port holds an old stdio inkwire server (`src/server/http.ts:47-50`). Its `/ws` server answers 400 to `/mcp`, so the link can never connect. Write "port N is held by an old inkwire server; close the old Claude Code sessions" to stderr and exit 1. Do not go into the M4.7 reconnect loop.
- New `src/link/ws-client.ts`: the client transport. It sends the hello first.
- New `src/link/relay.ts`: downstream is the SDK `StdioServerTransport`. Upstream is the link client. Hello: `{ type: "hello", v: 1, pid: process.ppid, session_id: env.CLAUDE_CODE_SESSION_ID ?? null, cwd: process.cwd(), build: readBuildInfo(), term_program: env.TERM_PROGRAM }`. The hello after a reconnect also carries `current_board` (M4.7). When stdin closes, close the socket (so the daemon releases authorship at once) and exit 0. A socket close does not stop the relay (M4.7). Log to stderr only. The relay must not import the store, `session.ts` or better-sqlite3.

**M4.7 Relay reconnect.**
- New `src/link/relay-core.ts` `RelayCore`. It takes a downstream Transport and an upstream factory, so tests can use `InMemoryTransport`.
- Cache the first `initialize` request and `notifications/initialized`. Track the ids of forwarded requests that have no response.
- On an upstream close that the relay did not cause:
  - (a) Answer each in-flight request with JSON-RPC error -32000: "inkwire daemon connection lost; board authorship and any pending session_send were released. Your current board is kept. Retry the call." (Open question 11, answered.)
  - (b) Run `ensureDaemon` again with backoff (250 ms, doubling to 5 s). After about 60 s, give the error to new requests at once, but keep trying.
  - (c) On connect, send the hello, then the cached `initialize` with the id `"inkwire-relay-reinit-<n>"` (a string, so it cannot match Claude Code's numeric ids). Drop the response with that id. Then send `notifications/initialized`.
  - (d) Queue requests from the gap, in order, until the replayed `initialize` answers. Then send them. The queue holds at most 100. Requests past that get the error at once.
  - (e) After a reconnect to a daemon with a different build, send `notifications/tools/list_changed` downstream.
- **Current board across a reconnect (Open question 11).** `RelayCore` reads only the first line of each tool result. If it matches `^board (b_[0-9a-f]+) `, it keeps that id; `board: none` clears it. On reconnect the hello carries optional `current_board`. The daemon sets it as the Client's current board if the board exists, never restores authorship or `inkwire` mode, and queues the reconnect notice (M3.5). Tests in `relay-core.test.ts`: the relay keeps the last id and sends it in the second hello; `board: none` clears it; the daemon restores the current board but not authorship; the three notice texts.

**M4.8 Idle grace.**
- `src/server/config.ts:13` `loadConfig`: add `idleGraceMs` from `INKWIRE_IDLE_GRACE_MS`. Default 30000. `off` turns it off.
- New `src/server/idle.ts` `IdleTimer` (clock injected). Arm it at boot with a first grace of `max(idleGraceMs, 10000)` (the autostart poll limit in M4.6), so an autostarted daemon under tsx does not exit before the first relay connects. Arm it with `idleGraceMs` when the link count goes to 0. Disarm it when a link is accepted. When it fires: `persistAll()`, `store.close()`, `http.close()`, exit 0. Open panels do not keep the daemon alive.

**M4.9 Person-only restart and stale detection.**
- `src/server/restart.ts` `restart()`: `persistAll`, close every link (relays reconnect through M4.7 and autostart the current build from their own plugin dir), exit 0.
- `src/server/http.ts` `handle`: new route `POST /api/daemon/restart`. It answers 202 with `{ boards, clients }`, then calls `restart()`. This route is for `yarn daemon:restart` only. It is not an MCP tool, and agents must not call it (Decision 12). CLAUDE.md and the skills (M3.4) say so. M4.11 applies the Origin and Host check to this route.
- New `scripts/daemon-restart.mjs` and `package.json` `daemon:restart`. It reads `INKWIRE_PORT`, prints the board and client counts from `/healthz`, posts the restart, waits for that pid to stop, then calls `ensureDaemon` from `dist/link/autostart.js` (it needs a build). So the panel comes back even with no session.
- Stale detection: on each hello, if the relay build is newer by Decision 7, store it as `staleBuild` and fire `onChange`. M5 shows it. Also add one line to the next tool result for that Client: "inkwire daemon runs an old build; it restarts when all sessions close, or restart it in the panel."

**M4.10 Dev daemon.**
- `package.json` `dev`: `INKWIRE_PORT=4692 INKWIRE_DATA_DIR=$HOME/.inkwire-dev INKWIRE_IDLE_GRACE_MS=off node esbuild.ui.mjs --watch & INKWIRE_PORT=4692 INKWIRE_DATA_DIR=$HOME/.inkwire-dev INKWIRE_IDLE_GRACE_MS=off tsx watch src/server/daemon.ts`. The yarn shell expands `$HOME`, not `~`.
- `yarn dev:claude` comes in M7, because it needs `plugin.json` to run the relay.


**M4.11 Origin and Host check (Open question 10).**
- New `src/server/origin.ts` `checkBrowserRequest(req, port)`: the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (this stops DNS rebinding). If an `Origin` header is present, it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. A request with no `Origin` passes (the hook's `curl` and `yarn daemon:restart` send none).
- Apply it to every `/ws` upgrade (`src/server/ws.ts`, `WebSocketServer` `verifyClient`), to the `/mcp` link upgrade, and to every state-changing HTTP route in `src/server/http.ts` (`POST`, `PUT`, `DELETE`, including `/api/hook` and `/api/daemon/restart`). A failure returns 403 and logs one stderr line.
- Tests (`tests/integration/origin.test.ts`): a `/ws` upgrade with `Origin: https://evil.example` is refused; with the panel origin it is accepted; a `POST /api/daemon/restart` with a foreign `Origin` gets 403 and the daemon keeps running; `Host: evil.example:4691` gets 403; the hook `curl` with no `Origin` still works.

### Tests

- `scripts/write-build-id.test.mjs` (`node --test`): two runs on one tree give the same id and a different `built_at`. A changed byte gives a different id. vitest does not run `.mjs` files under `scripts/`, so add `package.json` `build-id:test`: `node --test scripts/write-build-id.test.mjs` (the same pattern as `map-anchors:test`).
- `tests/integration/server.test.ts`: `/healthz` has `name`, `pid`, `build.id`, `clients`, `boards`. Rewrite `build.json` after the server starts: `/healthz` still reports the boot id. An upgrade to `/nope` is destroyed. The current panel tests pass.
- `tests/link/boundary.test.ts`.
- New `tests/link/endpoint.test.ts`: a real http server on port 0 with `routeUpgrades`. A test client sends a hello. An SDK Client runs `initialize` and `tools/list` to a trivial McpServer. No hello gives 4400. A wrong `v` gives 4426. A message in the same tick as the hello is not lost. A client close fires `closed` and lowers `count()`.
- New `tests/integration/daemon.test.ts`: spawn `node --import tsx src/server/daemon.ts` with a random port and a temp dir. Two link clients with different pids both list tools. `boards_create` on one shows in `boards_list` (with `all: true`) on the other. Closing one leaves the other working. Two relays: A writes and claims, then A closes; the board has no Author, and B can claim it. A hook that arrives before the hello for the same pid gives one Client. Two links with one pid give one Client; closing one link keeps the Client and its authorship, and closing the second removes it. A close during a pending `session_send` resolves it and leaves no timer. Restart: with a link open, POST restart; the link closes, the old pid exits, and boards saved before the restart are present after a new daemon starts on the same dir.
- `tests/integration/daemon-port.test.ts` (M4.5).
- New `tests/link/relay-spawn.test.ts`: start the relay with SDK `StdioClientTransport` (`node --import tsx src/link/relay.ts`), a random port, a temp dir and `INKWIRE_IDLE_GRACE_MS=300`. With no daemon first: `initialize`, `listTools` and `boards_create` work, and `daemon.log` exists. After `client.close()`, `/healthz` stops within about 2 s. Race: two relays start in parallel on a fresh port; both list tools, `/healthz` shows `clients: 2`, and the pid does not change across polls. Reconnect: SIGKILL the daemon; the next `listTools` succeeds through a new pid, and `client.onerror` never gets "unknown message ID". Restart: a relay survives a restart with no error to the client. A port held by a non-inkwire server makes the relay exit 1 with the reason. A stub `/healthz` that answers `{ ok: true, name: "inkwire" }` (no `build`) makes the relay exit 1 at once with the "old inkwire server" text, with no reconnect. After a reconnect, a `canvas_get_state` with no `board_id` returns the same board as before, the first result has the reconnect notice (M3.5), and the next write claims the board again when it is free (Open question 11).
- New `tests/link/relay-core.test.ts` (in-process): the second `initialize` response never goes downstream; an in-flight request gets -32000 after an upstream close; a request in the gap is answered after the reconnect with its id kept; the queue limit gives errors; a closed downstream closes upstream and stops the reconnect.
- New `tests/server/idle.test.ts` (fake clock): at boot it does not fire before `max(grace, 10 s)`; arms at 0, disarms on connect, arms again on the last close, fires once, and `off` never fires.

### Done when

- Tests pass, and `yarn build-id:test` passes. `yarn build` writes `dist/build.json`, `dist/link/relay.js` and `dist/server/daemon.js`.
- Manual: `yarn dev`, then `curl 127.0.0.1:4692/healthz` answers. The plugin still runs the stdio entry, and one Claude Code session works as before.
- MAP.md: a new entry "The link (relay and daemon)" (`src/link/` Transport, hello and closed; the relay reconnect; the boundary test). A new entry "Daemon lifetime and builds" (autostart, `/healthz`, `dist/build.json`, `INKWIRE_IDLE_GRACE_MS`, stale detection, restart route, `yarn daemon:restart`). The Server bootstrap entry names `daemon.ts`, `bootstrap.ts`, `upgrade.ts` and the new routes. The env line adds `INKWIRE_IDLE_GRACE_MS`.

### Risks

- The `/ws` server with the `server` option aborts `/mcp` upgrades with 400. M4.2 must land before M4.3.
- The daemon must not keep the stdin close handler. A detached daemon would exit at once.
- If the daemon opens the store before it binds the port, a loser of the autostart race runs migrations against the shared DB at the same time as the winner. Bind first. M4.5 (a) proves it.
- A reconnect drops in-flight calls, including a 20-minute `session_send`. The relay must answer them with an error, or Claude Code waits for its own tool timeout.
- After a restart to a new build, Claude Code keeps its first tool list. It sees new tools only if it honors `notifications/tools/list_changed`. This is not verified.
- `daemon.log` has no rotation.
- Idle grace counts relays only. A person with only the panel open loses the daemon 30 s after the last session closes. The panel then shows that it is disconnected.
- The daemon env `TERM_PROGRAM` belongs to the session that started the daemon. M2.3 makes `focusTerminal` use the `termProgram` of the talking Client, so this env value is only a fallback for a relay that sends no `term_program`.

---

## M5 — Panel UI and WS protocol

**Goal.** The panel shows the current Author (label and pid), a Release control, the reader count, and the stale-build notice with Restart. All panel state that was server-wide becomes per board.

### Steps

**M5.1 Add board fields to the push (additive).**
- `src/shared/protocol.ts:171-184` `SessionPush`: add `author: { pid, label, mode, pending: boolean, notice: string | null } | null`, `readers: number` (a count only) and `released_from: { pid, label } | null` (the board's `releasedFrom`, Open question 2). Fix the comment at `:171-172`.
- `src/shared/protocol.ts:186-195` `state` message: add `daemon: { build_id, stale: { newer_build_id, built_at, boards: { id, name }[], clients: { label, pid }[] } | null }`.
- `src/server/ws.ts:203-222` `push`: fill the new fields from `Clients` and the stale record. Keep the old `mode`, `pending`, `pending_board`, `notice`, derived from the Author.
- `src/server/ws.ts:24-27` fan-out: push a board when its Author, reader count, or Author mode, pending or notice changes. Push every board when `daemon.stale` changes. Do not push every board on every hello. Fix the comment at `:24`.

**M5.2 Release and Restart intents.**
- `src/shared/protocol.ts:100` (beside `session_mode_off`): add `{ type: "board_release", pid }`, `{ type: "board_allow", pid }` and `{ type: "daemon_restart", build_id }`.
- `src/server/ws.ts:96` `handle`:
  - `board_release`: call `clients.release(boardId, "person")` only when the Author pid equals `pid`. Else throw, so the reject path (`ws.ts:84-91`) sends `error` and re-syncs. A release in `inkwire` mode returns the pending `session_send` as `mode_off`. No history step is written.
  - `board_allow`: call `clients.allowAgain(boardId, pid)` only when the board's `released_from` pid equals `pid`. Else throw, so the reject path sends `error` and re-syncs (Open question 2).
  - `daemon_restart`: act only when `daemon.stale.newer_build_id` equals `build_id`. Then call the injected `restart()`. Add `restart?: () => void | Promise<void>` to the `PanelHub` deps (`ws.ts:19-23`).
  - `session_mode_off` (`ws.ts:148-150`): turn off the mode of the socket board's Author only. It is a no-op with no Author or an Author in `pty`.

**M5.3 Panel strip.**
- `src/ui/session.ts:16-20` `agentState`: read `push.session.author`. Off when there is no Author or the mode is `pty`. Waiting when `pending`. Else working.
- `src/ui/session.ts:117-152` `renderSession`: show `label · pid N` and the mode. With no Author: "NO AUTHOR · the next AI write claims this board". Show `N readers` when readers > 0.
- After a person release, show **Allow pid N** while `released_from` is set. On click, send `{ type: "board_allow", pid }`; the server calls `clients.allowAgain(boardId, pid)` only when `released_from` equals `pid`, else rejects and re-syncs. The push carries `released_from: { pid, label } | null`.
- Add a Release button when an Author exists. On click, `window.confirm` names the label and pid. When `pending`, it also says that the `session_send` returns `mode_off`. Then send `board_release`.
- `src/ui/session.ts:37-39` `canSend`: the reply box shows only when the Author mode is `inkwire`.
- `src/ui/panel.ts:599` `renderAsideStrip`: add the stale-build notice above the highlight strip, outside the canvas. Text: "The inkwire daemon runs an old build. It restarts when all sessions close." A Restart button confirms with the list of open boards and Clients (`label · pid`). The confirm says that undo history and every pending `session_send` on all of them are lost. Then send `daemon_restart` with `newer_build_id`.
- `src/ui/panel.ts:~891-898` `renderFooter` modenote reads the Author mode.
- `src/ui/index.html:140,166` and `src/ui/styles.css:497-508`: markup and style for the new controls. Nothing draws over the graph.
- Treat `author`, `readers` and `daemon` as optional. A new panel bundle can load from an older running daemon.

**M5.4 Remove the old push fields.**
- `src/shared/protocol.ts:173-179`: delete `mode`, `pending`, `pending_board`, `notice`. `src/server/ws.ts:208-212`: stop filling them. Fix all reads in `src/ui/`. Rewrite the `SessionPush` comment: the Thread, highlight and trace belong to the board; the Author and readers belong to the board's Clients; nothing is server-wide.

**M5.5 Tool list and board picker.**
- `src/ui/panel.ts:45-51` `MCP_TOOLS`: `session.mode` says the flag is per Client and only the Author can turn it on. `boards.list (all?)`. `boards.create (name, project_root)`. `boards.delete` is Author-only (or no Author). Add `boards.clone`, `boards.update`, `boards.release`. `boards.import (path, project_root?)`.
- `src/server/http.ts` `GET /api/boards`: add `author: { label, pid } | null` to each entry, from `Clients`. (M1.3 adds only `project_root` and the unset mark.)
- `src/ui/main.ts:65-97` `showBoardPicker`: show each board's `project_root` (or `root: unset`) and the Author label. Treat `author` as optional (an older daemon does not send it).

### Tests

- `tests/integration/server.test.ts`, `describe("session over WS")` (line 437):
  - With no Author, the push has `author: null` and `readers: 0`.
  - After Client A writes, the push shows A's pid and label.
  - Client B opens the board: `readers` is 1, and the Thread has no row for B.
  - A hello or a close on board X does not push to a panel on board Y.
  - When the daemon learns a newer build, every panel gets `daemon.stale` with the boards and Clients.
  - `board_release` with the current pid clears the Author. The pending `session_send` returns `mode_off`. The old Author's next write fails with "no longer the author".
  - `board_release` with a wrong pid gets `error` and a re-sync. The Author does not change.
  - After `board_release`, the push has `released_from` set. `board_allow` with that pid clears it, and the old Author's next write claims the board. `board_allow` with a wrong pid gets `error` and a re-sync.
  - `GET /api/boards` entries have `author: null` with no Author, and `{ label, pid }` after a write.
  - `daemon_restart` with the matching build id calls the fake `restart` once. A wrong id or no stale build gets `error`, and `restart` is not called.
  - `session_mode_off` from a panel on board X does not change the mode of the Author of board Y.
  - After M5.4, assertions that read `s.session.mode` and `s.session.pending` (about lines 460-466) read `s.session.author.mode` and `author.pending`.

### Done when

- Tests pass. Manual on the dev daemon, with two test relays (or two `claude` sessions after M7): the Author label and pid, reader count 1, the Release confirm text, and a Restart confirm that names both boards and both Clients.
- MAP.md "WebSocket protocol" (`MAP.md:195-221`) lists `board_release`, `board_allow`, `daemon_restart` and the new push fields (`author`, `readers`, `released_from`, `daemon`), with current anchors.

### Risks

- If the protocol change and the field removal ship in one PR, `yarn typecheck` breaks in `src/ui`. Ship M5.1, then M5.3, then M5.4.
- A Restart drops undo history and every pending `session_send` on every board for every session. The confirm must list them. The server accepts only the build id that the person confirmed.
- Release race: the Author can change between the push and the click. The pid guard rejects and re-syncs.
- A push sends the full state with ink geometry. Push only the boards that changed.
- The anchors in `ws.ts`, `protocol.ts`, `mcp.ts`, `session.ts` and `panel.ts` move in each PR. Fix them in the same PR.

---

## M6 — Docs, MAP entries and skills

**Goal.** The docs and skills describe the behaviour of M1–M5. User-facing daemon text (README quick start, `yarn dev:claude`) comes in M7, because it is not true until the cut-over.

### Steps

- MAP.md: check every entry that M1–M5 made false. `MAP.md:20-45` bootstrap prose (two entries; the port race is now two daemons). `MAP.md:47-80` write path. `MAP.md:153-193` MCP tools. `MAP.md:311-345` session mode (per Client; one `inkwire` Client per board, the Author; matcher `compact|clear|resume`; `forward.sh` sends the `claude` pid). `MAP.md:449-470` code binding. `MAP.md:490-502` persistence (one data dir per daemon; the dev daemon uses `~/.inkwire-dev`).
- CLAUDE.md:
  - `:11` surface list: add link, Clients and authorship, project root.
  - `:47` becomes: "Session mode is per Client. At most one Client per board is in `inkwire` mode, and it is the Author. Panel replies reach only it. The hook endpoint finds the Client by the `claude` pid that `forward.sh` sends. SessionStart `clear` and `resume` rekey the session id."
  - Add rules: one daemon owns all boards, and only the person restarts it; one AI Author per board, claim on first write, delete is a write, readers are read-only, no agent can force a claim; each board owns its `project_root`, and ref operations resolve against it; nothing outside `src/link/` imports the socket library for MCP; tests use random ports and temp dirs.
  - Keep `:34` (`author "ai"` still means one Client).
- `skills/use-inkwire/SKILL.md` and `skills/trace-path/SKILL.md`: M1.7 and M3.4 made the root and Author edits. Here, read each skill again against M1–M5 and ADRs 0001–0003, and fix what is still false.
- `skills/back-to-claude-code/SKILL.md`: it turns off the mode of this session only.
- **`teardown-worktree` skill** (separate repo: `~/angel-studios/angel-claude-skills/skills/teardown-worktree`, its own PR). Add a step before the worktree is removed: call `boards_list` with `all: true`. For each board whose `project_root` is the worktree being removed, or is inside it: if the branch is merged, call `boards_update(project_root: <main_root>)`; if it is not merged, ask the person whether to re-root, keep, or delete the board. The skill must be the board's Author to do this, so a refused write is reported to the person and not forced.

### Tests

- `yarn map-anchors` and `yarn map-anchors:test`. `yarn test`. Manual read of each skill against ADRs 0001–0003.

### Done when

- No doc says "session mode is per server", "`boards.open` resets", or names `INKWIRE_PROJECT_ROOT`. `grep -rn "INKWIRE_PROJECT_ROOT\|per server" MAP.md CLAUDE.md skills/` gives nothing.

### Risks

- Skill text changes the agent's behaviour in other repos. Check `/use-inkwire` and `/trace-path` by hand in M7.

---

## M7 — Cut-over and the post-migration step

**Goal.** The plugin runs the relay. The stdio server entry goes away. Many Claude Code sessions share one daemon. The person sets the root of every unset board. The ADRs are accepted.

### Steps

**M7.1 Point the plugin at the relay.**
- `.claude-plugin/plugin.json` `mcpServers.inkwire.args`: `["${CLAUDE_PLUGIN_ROOT}/dist/link/relay.js"]`.
- `package.json` `bin`: `dist/link/relay.js`. `start`: `tsx src/server/daemon.ts`.
- Delete the stdio path in `src/server/index.ts` (or the whole file, if `bootstrap.ts` and `daemon.ts` hold all of it).
- `tests/tools/stdio-smoke.test.ts:15-34`: spawn `src/link/relay.ts` with `INKWIRE_IDLE_GRACE_MS=300` and a temp dir. In `afterAll`, wait for the daemon pid from `/healthz` to stop. Keep the tool count, `boards_create` and the clean `get_state` checks.
- `tests/integration/port-conflict.test.ts`: delete the file. It has one case today, the stdio-server case (`:22`), and `daemon-port.test.ts` covers the daemon. Do not leave the file with no test: vitest includes `tests/**/*.test.ts` and fails a file that has no suite. M8 creates the file again.
- CLAUDE.md architecture rule "stdout is the MCP transport" becomes: "stdout is the MCP transport of the relay. Log to stderr only. The daemon's stdout and stderr go to `daemon.log`. The spawned smoke test covers relay plus daemon."

**M7.2 `yarn dev:claude`.**
- `package.json` `dev:claude`: `INKWIRE_PORT=4692 INKWIRE_DATA_DIR=$HOME/.inkwire-dev claude --plugin-dir .`. The relay and `hooks/forward.sh` inherit the env, so they reach the dev daemon. If `yarn dev` is not running, the relay autostarts a dist daemon on 4692 with the dev dir.
- CLAUDE.md Commands (`:22`): `yarn dev` runs the dev daemon (4692, `~/.inkwire-dev`) and the panel watch, panel URL `http://127.0.0.1:4692/?board=<id>`. Add `yarn dev:claude` and `yarn daemon:restart`. Say that the relay always runs from dist (`plugin.json`), so a relay change needs `yarn build`. Env: `INKWIRE_PORT`, `INKWIRE_DATA_DIR`, `INKWIRE_IDLE_GRACE_MS` (default 30000, `off` turns it off).

**M7.3 README.**
- Quick start: one daemon starts with the first Claude Code session and stops 30 s after the last one closes. All sessions share it and port 4691. `boards_create` needs a `project_root`.
- New "Many sessions" section: one AI Author per board, readers are read-only, Release in the panel, `boards_clone` for a worktree.
- New "After a rebuild" section: the panel shows a stale-build notice. Restart in the panel or with `yarn daemon:restart`. A restart drops undo history and pending `session_send` on every board.
- Restart: after a reconnect or a restart, each session keeps its current board but not its authorship or `inkwire` mode. The next write claims the board again if it is free.
- Session tab: the mode is per session, and only the Author can turn it on. Replace "a server restart returns to the terminal".
- Development (`README.md:~55-61`): `yarn dev`, `yarn dev:claude`, random test ports. Env list without `INKWIRE_PROJECT_ROOT`.
- Upgrade notes: copy the post-migration step verbatim (see the Post-migration section).

**M7.4 Ship and run the post-migration step.**
1. Back up `~/.inkwire/inkwire.db`.
2. Run `yarn build`. Install the plugin update.
3. Close all Claude Code sessions that use the old stdio server. Start one new session.
4. Run the **post-migration step** (verbatim from ADR 0003): **Post-migration step:** run `boards_list` and set a root on every `root: unset` board with `boards_update`. At migration time this is one board, `b_8946f6` "Discover Config API — generateDiscoverConfig", root `/Users/clayton.noyes/angel-studios` (its 8 refs all start with `content-collections/`; verified 2026-10-08).
5. The call is `boards_update(board_id: "b_8946f6", project_root: "/Users/clayton.noyes/angel-studios")` (Open question 4).
6. Check: `canvas_lint` on `b_8946f6` fails and names `boards_update` before step 5, and passes after it. `boards_list` (with `all: true`) shows no `root: unset` board.

**M7.5 Accept the ADRs.**
- `docs/adr/0001…:2`, `0002…:2`, `0003…:2`: `status: proposed` becomes `status: accepted`. No other edit.

### Tests

- `tests/tools/stdio-smoke.test.ts` (rewritten). Full `yarn test`.
- Manual (Clayton), one session: `/use-inkwire`, a panel reply, `/back-to-claude-code`, and `/clear` while in `inkwire` mode (moved here from M2 and M3).
- Manual: two Claude Code sessions in different repos both list tools and create boards. The second session no longer fails with EADDRINUSE. Session A writes a board. Session B opens it, reads it, and a write from B fails and names A. The panel shows A as Author and 1 reader. Release in the panel lets B claim the board. `/clear` in A keeps its Client (same pid). Close both sessions: the daemon exits after 30 s.
- Manual: `yarn dev`, then `yarn dev:claude`. `/healthz` on 4692 answers. Boards go to `~/.inkwire-dev/inkwire.db`, not `~/.inkwire`.
- Manual: rebuild with a change, start a new session, see the stale notice, Restart in the panel. Both sessions keep their current board and keep working; each one's next write claims its board again.

### Done when

- The plugin runs the relay. All tests pass. The manual checks pass. No `root: unset` board is left. The ADRs say `accepted`.

### Risks

- A session that still runs the old stdio server holds port 4691. The new relay then sees a non-daemon inkwire (old `/healthz` with no `build`) M4.6 makes the relay stop with "port N is held by an old inkwire server; close the old Claude Code sessions" and exit 1, with no reconnect loop. Close all old sessions before the first new one.
- If the marketplace copy of inkwire is also installed, `yarn dev:claude` loads two inkwire plugins. Both relays and both hook sets reach the dev daemon, because they inherit `INKWIRE_PORT`. Both relays send one pid, so they share one Client (Decision 11). The Client stays until both links close.
- The relay runs from dist, but the dev daemon runs from src under tsx. A stale dist relay or a `dist/build.json` that does not match can show a false stale notice in dev.
- The rollback is to install the earlier plugin build. The DB column stays and the old build ignores it. Authorship and Clients are in memory only, so nothing else needs a rollback.

---

## M8 — MCP health suite

**Goal.** One command (`yarn health`) tells if the MCP server works. It starts a real daemon and two or more relays on a random port with a temp dir, and it runs every tool through the full link. The port-conflict test becomes a test that two sessions share one daemon.

### Steps

- `package.json`: add a `health` script (the full command is below). (The build makes `dist/build.json` and lets one case spawn the dist relay as the plugin does.) `yarn test` also runs `tests/health`, because vitest includes `tests/**/*.test.ts`. `yarn test` does not build. So the dist-relay case skips (with a skip reason) when `dist/build.json` is missing or is older than the newest file under `src/`. `yarn health` builds first, so the case always runs there.
- New `tests/health/harness.ts`: `startRelays(n, { port, dataDir, graceMs })` spawns n relays with `StdioClientTransport`. Each relay gets a fake parent pid: spawn it through a small `sh -c` wrapper so that each relay has its own `ppid`. Return the SDK clients, the daemon pid from `/healthz`, and a `panel(boardId)` WS helper. `stop()` closes the relays and waits for the daemon to exit.
- New `tests/health/tools.test.ts`: a table with one case for every tool name. The test fails when `listTools()` returns a tool that has no case, so a new tool must get a health case. Each case runs through relay A (Author) on a board with a temp `project_root` that holds a small source file. Cases check the result shape, and validate `canvas_get_state` against the contract fixture. Write tools also run through relay B (reader) and must fail with the Author message. `session_mode` and `session_send` use a hook POST with the relay pid and a panel reply.
- New `tests/health/lifecycle.test.ts`: autostart from no daemon; the race of three relays gives one daemon pid and `clients: 3`; a relay close releases authorship and the panel push shows `author: null`; `/clear` (a SessionStart `clear` hook with a new session id) keeps the Client and its authorship; SIGKILL of the daemon and reconnect with no "unknown message ID"; stale build (a relay with a later `built_at` and another id) makes the panel get `daemon.stale`; panel `daemon_restart` and `POST /api/daemon/restart` both restart, and saved boards come back; idle grace ends the daemon after the last relay.
- Keep the unit tests where they are. `yarn health` runs them with the health cases: `health` is `yarn build && vitest run tests/health tests/link tests/server/idle.test.ts tests/tools/clients.test.ts tests/tools/project-root.test.ts tests/tools/forward-hook.test.ts tests/tools/authorship.test.ts tests/integration/port-conflict.test.ts tests/integration/daemon.test.ts`.
- Rewrite `tests/integration/port-conflict.test.ts` as "two sessions share one daemon": two relays start on one port. The second relay does not fail. Both list tools. A board that A creates shows in B's `boards_list`. `/healthz` shows `clients: 2` and one pid. A non-inkwire port holder still makes the relay exit 1 with the reason (keep that case here). Keep the 20 s timeout and the `waitFor` helper.
- Add a short "Health check" line to CLAUDE.md Commands and to README Development: run `yarn health` after a change to the link, the daemon, the gate or any tool.

### Tests

- The suite itself. It must pass three times in a row (`yarn health` x3) with no flake, and finish in less than 60 s.

### Done when

- `yarn health` passes. `yarn test` passes on a fresh checkout with no `dist/`. A tool with no health case fails the suite. `port-conflict.test.ts` checks shared use. MAP.md names `tests/health/` in the Server bootstrap and link entries.

### Risks

- Spawned processes make the suite slow and can flake on a busy machine. Use `waitFor` with clear timeouts. Always kill the daemon in `afterAll` by the pid from `/healthz`.
- A fake parent pid through `sh -c` must stay alive while the relay runs, or `process.ppid` changes to 1. Keep the wrapper process in the foreground (`sh -c 'node … ; :'`).

---

## Post-migration

Copied verbatim from ADR 0003. M7.4 runs it.

**Post-migration step:** run `boards_list` and set a root on every `root: unset` board with `boards_update`. At migration time this is one board, `b_8946f6` "Discover Config API — generateDiscoverConfig", root `/Users/clayton.noyes/angel-studios` (its 8 refs all start with `content-collections/`; verified 2026-10-08).

The person can run it at any time after M1 ships. M7 is the last check.

---

## Open questions

Each question has the default that this plan uses. Change the plan if the answer is different.

1. **Does `session_mode(on)` on a board with no Author claim it?** ANSWERED 2026-10-08: yes. Mode on counts as a claim. On a board with no Author it claims the board. It fails when another Client is the Author, or when the board's `releasedFrom` is this pid.
2. **After the person releases a board, what can the old Author do?** ANSWERED 2026-10-08: strict, plus the person can allow it again. The released Client cannot claim that board while the board's `releasedFrom` is its pid. `releasedFrom` is cleared when another Client claims the board, when the released Client disconnects, or when the person clicks **Allow pid N** in the panel. See M3 and M5.
3. **Can the hello carry an optional `term_program`?** ANSWERED 2026-10-08: yes. The relay sends its `TERM_PROGRAM`. The Client stores it. `focusTerminal` uses the value of the Client that leaves `inkwire` mode (the talking Client). ADR 0001 lists the field.
4. **Is the root of `b_8946f6` `/Users/clayton.noyes/angel-studios/content-collections`?** ANSWERED 2026-10-08: no. The root is `/Users/clayton.noyes/angel-studios`, because all 8 refs start with `content-collections/` and all 8 files exist there. The refs do not change.
5. **Panel import of a file whose root does not exist on this machine.** ANSWERED 2026-10-08: the panel asks for the root. It names the root in the file and asks where that checkout is on this machine, then retries with `?project_root=`. The server validates it as for an agent (an absolute directory that exists).
6. **`paths_get` and `paths_play` on an unset-root board.** ANSWERED 2026-10-08: the daemon stores each board's main checkout (`main_root`) from git. When the root is gone, reads fall back to `main_root` with a warning; ref writes and lint fail until `boards_update` makes the move permanent. The `teardown-worktree` skill re-roots the boards of a merged worktree and asks for an unmerged one. See M1.8 and M6.
7. **Default name of a clone.** ANSWERED 2026-10-08: `<source name> · <basename of new root>`, or `<source name> copy` for the same root. A name that already exists gets the lowest free ` (N)` counter. The result says `name_check: "OK"` or gives a warning with the new name. See M1.6.
8. **Does the dev daemon use `INKWIRE_IDLE_GRACE_MS=off`?** ANSWERED 2026-10-08: yes. `yarn dev` sets `INKWIRE_IDLE_GRACE_MS=off`. The M4 lifetime tests and the M8 health suite test the idle stop with a short grace.
9. **Does a claim make the claimed board the Client's current board?** ANSWERED 2026-10-08: yes, a claim makes the board current. Also: a context line in every result, a one-time notice on each change, no switch while in `inkwire` mode, Thread rows on both boards, and the context line after compaction. See M3.5.
10. **Do the person-only HTTP and WS paths need a guard?** ANSWERED 2026-10-08: add an `Origin` and `Host` check on all browser routes and both upgrades (M4.11). Local processes stay trusted. The skills and CLAUDE.md tell agents not to call these paths. No token.
11. **What does a Client keep after a reconnect or a restart?** ANSWERED 2026-10-08: the relay keeps the board id from the context line of each result and sends it as `current_board` in the hello after a reconnect. The daemon restores the current board only, not authorship or `inkwire` mode. See M4.7 and M3.5.
