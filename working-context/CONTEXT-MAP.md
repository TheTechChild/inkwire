# Available context map

Map sources without making all of them active. Update this file when source authority, freshness, location, exclusions, or retrieval triggers change.

| Source | Location | Authority | Freshness | Load when | State |
| --- | --- | --- | --- | --- | --- |
| Repo agent instructions | `CLAUDE.md` | Canonical for agent rules, commands, and load-bearing rules (stable instructions) | Last commit 2026-10-22 (`4642bbf`). **Stale locally:** `origin/main` `d7f6be4` renames `mod:*` scripts to `plugin:*` | Always. Claude Code loads it | Active (auto-loaded) |
| Clayton's user instructions | User-level `CLAUDE.md` | Canonical for writing style (ASD-STE100), mise, and commit rules (stable instructions) | Loaded by Claude Code in each session | Always | Active (auto-loaded) |
| Project settings | `.claude/settings.json` | Canonical for the session-mode env, the `auto` mode, and the MAP anchor Stop hook | Last commit 2026-09-30 (`e5e2ffd`) | A hook or a session-mode check fails | On demand |
| Code map | `MAP.md` | Canonical for where each task surface starts | Last commit 2026-10-22 (`4642bbf`). The Stop hook and CI check the anchors. **Stale locally** (same `plugin:*` rename) | Before you read or change code on a surface | On demand |
| Domain glossary | `CONTEXT.md` | Canonical for domain terms (Board, Client, Author, Reader, Thread, Session mode) | Last commit 2026-10-08 (`2a52091`) | You name a domain concept in code, docs, or tool text | On demand |
| ADRs 0001 to 0005 | `docs/adr/` | Canonical for architecture decisions (all `accepted`) | Last commit 2026-10-22 (`4642bbf`) | A change touches the daemon, the link, authorship, the project root, the mod, or plugin delivery | On demand |
| User README | `README.md` | Supporting. It describes install, updates, and use | Last commit 2026-10-22 (`cb8bde3`) | The install test, or a change to install or use | Active for the proposed outcome |
| Plugin README | `plugin/README.md` | Supporting. Users see it in the plugin | Last commit 2026-10-22 (`cb8bde3`) | The install test, or a change to the plugin | Active for the proposed outcome |
| Plugin manifest and marketplace | `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/package.json`, `plugin/package-lock.json` | Canonical for what Claude Code installs | Checked by `yarn check-plugin` in CI | The install test, or a runtime dependency change | On demand |
| Scripts and commands | `package.json` `scripts`, `scripts/` | Canonical for commands | Last commit 2026-10-22. **Stale locally** (`mod:*` names) | You run or change a check | On demand |
| CI | `.github/workflows/ci.yaml` | Canonical for the merge checks | Last commit 2026-10-22 (`4642bbf`) | A CI job fails, or you add a check | On demand |
| Tool versions | `mise.toml`, `.nvmrc`, `package.json` `packageManager` and `engines` | Canonical (repo `CLAUDE.md` lists all files to change together) | Last commit 2026-10-09 (`3a83c18`) | You change a tool version | On demand |
| Contract fixtures | `tests/fixtures/contract/` | Canonical for the `get_state` JSON Schema (design-authored, hand-edited) | Last commit 2026-10-08 | The contract changes | On demand |
| Plugin skills | `plugin/skills/use-inkwire`, `plugin/skills/back-to-claude-code`, `plugin/skills/trace-path` | Canonical for skill behavior that users get | Last commit 2026-10-22 | You change a skill, or the install test checks the commands | On demand |
| Ship skill | `.claude/skills/ship/SKILL.md` | Supporting. Dev-only workflow to open a PR | Last commit 2026-09-01. It does not name conventional commits | You land work as a PR | On demand |
| Design handoff | `design_handoff_inkwire/` (local only, gitignored) | **Conflicting.** `CLAUDE.md` calls it the behavior authority (`SPEC.md` wins). The local folder has only the notebooks handoff (`README.md`, `PLAN.md`, `Shared Canvas - Notebooks.dc.html`) | Files dated 2026-09-03 | A behavior question that the code, the tests, and the ADRs do not answer | On demand (partial) |
| Shared daemon plan | `.claude/plans/2026-10-08-shared-daemon.md` | History. M1 to M8 shipped (PR #22) | Last commit 2026-10-08. **Stale:** its rule "`yarn build` green" predates ADR 0005 | You need the reason for a daemon, link, or authorship detail that the ADRs do not give | On demand |
| GitHub PRs and issues | `gh pr list`, `gh issue list` on `TheTechChild/inkwire` | Canonical for merged work and open work | Checked 2026-10-28: no open PRs, no open issues | You need the reason for a change, or you check for open work | On demand |
| Live boards | inkwire MCP tools (`boards_list`) | Canonical for board data | Not checked | You check `b_8946f6`, or a task uses a board | On demand. Writes need approval |

## Source precedence

1. Clayton's direct instruction wins.
2. Clayton's user-level `CLAUDE.md` wins for writing style, tool management (mise), and commit rules. Example: the ship skill says "imperative subject", and Clayton's rule adds conventional commits. Use conventional commits.
3. Accepted ADRs and the repo `CLAUDE.md` win over plans, READMEs, and the design handoff.
4. The code and the tests win over `MAP.md` prose when they disagree. Fix the map.
5. `origin/main` wins over a stale local copy of the same file.
6. **Ask Clayton:** the design handoff against the code, because `SPEC.md` is not available to check.

## Retrieval triggers

- A required definition, fact, or acceptance test is missing.
- Two active sources conflict.
- The decision has high cost, risk, or impact.
- Verification fails or the source appears stale.
- The user explicitly asks for a source or broader review.
- The task crosses an approval or access boundary.

## Deliberate exclusions

| Source or category | Why excluded now | Condition for reconsidering |
| --- | --- | --- |
| `.claude/settings.local.json` | Personal local settings. It can contain private permissions | A permission problem that `.claude/settings.json` does not explain |
| `node_modules/`, `yarn.lock` | Generated or too large. No signal for the outcome | A dependency change, or `yarn check-plugin` fails |
| `schema/*.generated.json` | Generated from the zod contract. Do not edit it | Never edit. Regenerate with `yarn gen:schemas` |
| `~/.inkwire` and `~/.inkwire-dev` data and `daemon.log` | Live user data. Approval boundary | Clayton approves a check of the live or dev daemon |
| Far-zoom part of `Shared Canvas - Notebooks.dc.html` | Out of scope and not approved | Clayton approves far zoom |
| Branch `docs/readme-clone-steps` (PR #29) | Closed without a merge. It adds `yarn build` steps that ADR 0005 removed | Never, unless Clayton opens it again |
| Local branches `chore/plugin-install`, `feat/ref-accuracy`, `feat/session`; remote `feat/boards-delete` | Already in `main` | Clayton asks for branch cleanup |

## Known gaps

- `SPEC.md`, `TESTS.md`, and `design/Shared Canvas.dc.html` are not in the local `design_handoff_inkwire/`. Location unknown.
- The `teardown-worktree` skill is in another repo (`~/angel-studios/angel-claude-skills/skills/teardown-worktree`, per the shared daemon plan). Not checked. Its board re-root step is not verified.
- The status of board `b_8946f6` after the ADR 0003 migration is not verified.
- No record shows a real GitHub marketplace install on a clean setup after ADR 0005.
- Local `main` does not have `d7f6be4` (PR #30). The local files above are stale until a pull.
