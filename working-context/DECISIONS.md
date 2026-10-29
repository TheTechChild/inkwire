# Decision history

Preserve decisions that explain the project without leaving every old choice active. Add an entry only when a decision changed the work, a prior decision was replaced, or a future operator would otherwise repeat the same debate.

The accepted architecture decisions are in `docs/adr/` (ADR 0001 to ADR 0005). This file does not copy them. It records the decisions that replaced older choices, so that an agent does not use the old choice again.

## Decision entry template

### YYYY-MM-DD — [Short decision name]

**Status:** [Active, superseded, reversed, or under review]

**Decision:** [What was decided in plain language.]

**Replaces:** [Previous decision or “None.”]

**Reason and evidence:** [Why this decision was made and which source supports it.]

**Affected unfinished work:** [What must change because of this decision.]

**Revisit when:** [Specific new evidence, date, failure, or condition.]

**Rollback path:** [How to reverse the decision safely, or “Not applicable.”]

**Recorded by:** [Person or agent, with verification status.]

## Entries

### 2026-10-22 — The plugin runs from source, with no build

**Status:** Active

**Decision:** The plugin root is `plugin/`. Node 26 runs the TypeScript source. There is no build step and no `dist/`. Each merge to `main` is an update.

**Replaces:** The plugin ran compiled JavaScript from `dist/`, and the user ran `yarn install` and `yarn build` after each `git pull`.

**Reason and evidence:** A marketplace install from GitHub had no `dist/`, so the MCP server did not start. Source: ADR 0005, PR #26. PR #29 (README `yarn build` steps) was closed without a merge on 2026-10-26, and commit `af7c528` ignores the root `dist/` folder.

**Affected unfinished work:** Docs or plans that say `yarn build` are stale. Example: the rules of `.claude/plans/2026-10-08-shared-daemon.md`.

**Revisit when:** Node drops type stripping, or Claude Code changes how it installs plugin dependencies.

**Rollback path:** See ADR 0005.

**Recorded by:** agent, from ADR 0005 and git history. Not confirmed by Clayton.

### 2026-10-08 — One shared daemon in place of one server per session

**Status:** Active

**Decision:** One long-lived daemon owns all boards. Each Claude Code session reaches it through a stdio relay.

**Replaces:** Each Claude Code session started its own inkwire server. A second session failed with `EADDRINUSE`.

**Reason and evidence:** Board state and history are in the memory of one process. Two processes on one board overwrite each other. Source: ADR 0001, PR #22.

**Affected unfinished work:** None known.

**Revisit when:** See ADR 0001.

**Rollback path:** Not applicable.

**Recorded by:** agent, from ADR 0001 and git history. Not confirmed by Clayton.

### 2026-10-08 — `INKWIRE_PROJECT_ROOT` removed

**Status:** Active

**Decision:** Each board stores its own `project_root`. There is no project-root env.

**Replaces:** The server took one project root from its cwd or from `INKWIRE_PROJECT_ROOT`.

**Reason and evidence:** One shared daemon serves many projects. Source: ADR 0003, shared daemon plan decision 5.

**Affected unfinished work:** The post-migration step for board `b_8946f6` (ADR 0003). **Status unverified.**

**Revisit when:** See ADR 0003.

**Rollback path:** Not applicable.

**Recorded by:** agent, from ADR 0003 and the shared daemon plan. Not confirmed by Clayton.

### 2026-09-30 — No panel draws over the graph

**Status:** Active

**Decision:** Chips, strips, and the scrubber are not on the canvas. The highlight strip is in the aside. The scrubber is the expanded `.path-row` in the Layers tab.

**Replaces:** The top-of-canvas scrubber overlay in the design handoff.

**Reason and evidence:** Product decision. Source: repo `CLAUDE.md`, PR #19.

**Affected unfinished work:** A design file that shows the overlay is superseded on this point.

**Revisit when:** Clayton asks for an overlay again.

**Rollback path:** Not applicable.

**Recorded by:** agent, from the repo `CLAUDE.md` and PR #19. Not confirmed by Clayton.
