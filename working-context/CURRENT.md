# Current project state

Keep this file short enough to scan in one sitting. Replace stale state instead of appending a running diary.

## Outcome now

Clayton confirmed this outcome on 2026-10-28.

A new user can install inkwire from the `TheTechChild/inkwire` GitHub marketplace on a clean setup, with no build step. After the install, the user can create a board, open the panel, and turn on session mode. A recorded manual run against `main` at `d7f6be4` or later proves this.

A clean setup is a temporary `CLAUDE_CONFIG_DIR` and a temporary `INKWIRE_DATA_DIR` on this machine. The run must not touch the live daemon on port 4691 or `~/.inkwire`. Set `INKWIRE_PORT` to a port that is not 4691 or 4692.

Reason for this outcome: all work since 2026-10-22 is plugin delivery (ADR 0004, ADR 0005, PR #26 to PR #30). CI simulates the install (`yarn check-install`). No source shows a real install from GitHub on a clean setup after ADR 0005.

## Current state

- The working tree is clean on `main`. There are no open PRs and no open issues (checked with `gh` on 2026-10-28).
- Local `main` is at `af7c528`. `origin/main` on GitHub is at `d7f6be4` (PR #30, 2026-10-27). Local `main` is 1 commit behind. `git status` says "up to date" because no fetch ran.
- **Conflict:** the local `CLAUDE.md`, `MAP.md`, and `package.json` name `yarn mod:validate` and `yarn mod:test`. On `origin/main`, PR #30 renamed them to `yarn plugin:validate` and `yarn plugin:test`. Use the `origin/main` names after a pull.
- The shared daemon plan (M1 to M8) shipped in PR #22. ADR 0001 to ADR 0005 have the status `accepted`.
- The plugin runs the TypeScript source in `plugin/`. There is no build and no `dist/` (ADR 0005). Each merge to `main` is an update for every user.
- CI runs on each PR and each push to `main`: map anchors, lint, typecheck, `yarn test`, `yarn check-plugin`, and `yarn check-install`.
- Local branches `chore/plugin-install`, `feat/ref-accuracy`, and `feat/session` have no commits that `main` does not have. Remote branch `feat/boards-delete` is the same. Remote branch `docs/readme-clone-steps` is from PR #29, which was closed without a merge.
- **Unverified:** the ADR 0003 post-migration step for board `b_8946f6`. The ADR names the root `/Users/clayton.noyes/angel-studios`. The home folder on this machine is `/Users/clayton`.

## Active decisions

- ADR 0005: the plugin and the marketplace entry have no `version` field. The commit SHA is the version.
- ADR 0001: only the person restarts the daemon. A newer build does not restart it.
- The far-zoom pass in the notebooks design file is out of scope and is not approved (`design_handoff_inkwire/README.md`).

## Non-negotiables

**Hard constraints:** The stable rules are in the repo `CLAUDE.md` and in Clayton's user-level `CLAUDE.md`. Do not copy them here. Obey them as written. For this outcome, the most important rules in the repo `CLAUDE.md` are the port and data-dir rules (4691, 4692, `~/.inkwire`, `~/.inkwire-dev`) and the rule that agents must not run `yarn daemon:restart` or `yarn start`.

**Preferences:** Use the dev port 4692 and `~/.inkwire-dev` for agent checks when they are sufficient. Use a temporary data dir for an install test when possible.

## Open questions

1. Where are `SPEC.md`, `TESTS.md`, and `design/Shared Canvas.dc.html`? The repo `CLAUDE.md` names them as the behavior authority. The local `design_handoff_inkwire/` has only the notebooks handoff. Status: unknown. This is a known gap in `CONTEXT-MAP.md`. It does not block the outcome.
2. Did someone run `boards_update` on `b_8946f6`? Is that board on this machine? Status: unknown. It does not block the outcome.

## Next checkpoint

The agent writes a step list for the manual install run. Clayton approves it before the run starts.

## Approval boundaries

Commit only on a feature branch. Merge into main only through a PR. Never commit to main.

Get Clayton's approval before you do these actions:

- Install, update, or remove a plugin or a marketplace in Clayton's Claude Code configuration.
- Start, stop, or restart a daemon on port 4691, or read or write `~/.inkwire`.
- Fetch, pull, push, merge, delete a branch, or open a PR. A merge to `main` ships to every user (ADR 0005).
- Write to a board that another Client authors, or change the root of a board.
- Change a file in another repo, for example the `teardown-worktree` skill.

## Stop condition

Stop and ask Clayton when one of these occurs:

- A step needs the live daemon (4691), `~/.inkwire`, or a change to Clayton's Claude Code configuration.
- The install fails for a reason that the repo docs do not explain.
- Two sources disagree, and the source precedence in `CONTEXT-MAP.md` does not decide.

## Last updated

2026-10-28 by agent, initial Start. Clayton approved the defaults.
