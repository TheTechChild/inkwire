---
status: proposed
---

# Each board owns its project root

A board's code refs (`bind_code`, path `ref_hash` stamps, `canvas_lint`) only mean something relative to one checkout, but the server used to take a single project root from its own cwd or `INKWIRE_PROJECT_ROOT`. Under one shared daemon that serves every project, that root is wrong for most boards, and panel-started actions have no client to borrow a root from. So the project root is a required, stored field of the board, given explicitly by the agent when it creates the board, and every ref operation on that board resolves against it — for every client and for the panel.

## Considered Options

- **Resolve against the current author's root.** Rejected: a board with no author has no root, and a change of author to another checkout breaks every ref.
- **One daemon per project** (own port and data dir). Rejected: a port to manage per project, and no boards shared across projects.

## Copying a board

`boards_clone(board_id, name?, project_root?)` copies a board inside the daemon; the root defaults to the source's, so a worktree board is one call. The clone copies content only and starts at step 0 (history is in-memory and the clone is new work); the cloning client becomes its author. The board file carries an optional `project_root`; `boards_import` takes an explicit root first, else the file's root only if that directory exists on this machine, else it fails and asks for one — a file from another machine must not land on a wrong path.

## Unset roots and migration

The `project_root` column is `NOT NULL DEFAULT ''`; `''` means unset and only a migrated row can hold it, because `boards_create`, `boards_clone`, `boards_import`, and `boards_update` reject `''` and any path that is not an existing absolute directory. `boards_update(board_id, name?, project_root?)` is author-only. A board whose root is unset, or no longer exists (a removed worktree), stays readable, drawable, and clonable; only ref operations fail, naming `boards_update` as the fix. `boards_list` marks such boards `root: unset`.

**Post-migration step:** run `boards_list` and set a root on every `root: unset` board with `boards_update`. At migration time this is one board, `b_8946f6` "Discover Config API — generateDiscoverConfig", root `/Users/clayton.noyes/angel-studios` (its 8 refs all start with `content-collections/`; verified 2026-10-08).

## When a worktree goes away

Refs are relative to the root, so a merged worktree's board stays valid under the main checkout; only the root has to move. Each board also stores its main checkout (`main_root`, from `git rev-parse --git-common-dir`; `''` outside a linked worktree). When `project_root` no longer exists, reads fall back to `main_root` and say so; ref statuses stay honest, so an abandoned branch shows as changed or missing refs rather than silently passing. Ref writes and lint refuse the fallback until the move is made permanent with `boards_update` — normally by the `teardown-worktree` skill, which re-roots the boards of a merged worktree and asks the person about an unmerged one. We rejected re-rooting automatically when the worktree vanishes: it would point an abandoned branch's board at `main` without a word.

## Listing boards

`boards_list` by default shows a board when its root is the caller's cwd, lies inside it, or contains it, plus every board whose root is unset; `all: true` shows every board. Each entry carries its `project_root`. Overlap, not equality, because sessions often start at a parent directory (`~/angel-studios`) of the repos and worktrees the boards point at.

## Consequences

- One board per git worktree is natural: the worktree's path is the board's root.
- The root is not inferred from the creating session; the agent must set it to what the person means.
