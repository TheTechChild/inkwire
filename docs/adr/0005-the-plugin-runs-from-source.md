---
status: accepted
---

# The plugin runs from source

## Context

Before this change, the repo root was the plugin root, and the plugin ran compiled JavaScript from `dist/` (`dist/link/relay.js`, `dist/server/daemon.js`, `dist/ui/`). `dist/` was not in git. So the only install that worked was a local directory: clone the repo, run `yarn install` and `yarn build`, then add the checkout as a marketplace. Each update needed `git pull` and `yarn build` again, by hand. A marketplace install from GitHub copied a tree with no `dist/`, so the MCP server did not start.

Node 26 runs TypeScript directly (type stripping). Claude Code installs a plugin's npm dependencies from the `package.json` and `package-lock.json` in the plugin root (`npm ci`, exact registry versions, no install scripts). When the plugin and the marketplace entry have no `version`, Claude Code uses the commit SHA of the marketplace repo as the version.

## Decision

The plugin runs the TypeScript source. It has no build step and no build output. We copy the pattern of the `discover-mcp-servers` marketplace.

- The plugin root is `plugin/`. It holds `.claude-plugin/plugin.json`, `hooks/`, `skills/`, `assets/fonts/`, `src/`, `package.json` and `package-lock.json`. The marketplace (`.claude-plugin/marketplace.json`, source `./plugin`), the tests, the scripts, the schemas and the docs stay at the repo root. Claude Code copies only `plugin/`.
- `plugin.json` runs `sh ${CLAUDE_PLUGIN_ROOT}/src/link/relay.sh`. Claude Code starts the MCP server in the cwd of the session, so the `node` on PATH can come from the `.nvmrc` of that project, and an older Node cannot run the source. `relay.sh` runs `relay.ts` with the `node` on PATH when it is Node 26 or later, else with `mise x node@26 -- node` when mise is installed, else it stops with a message on stderr. Each step uses `exec`, so the relay's parent pid stays the Claude Code pid (the hello pid). `relay.ts` imports `node-version.ts` first, which stops an older Node (for example from a project `.mcp.json`) with a clear message. The relay starts the daemon as `<root>/src/server/daemon.ts` with `process.execPath`.
- The source uses only syntax that Node can strip: relative imports with `.ts`, `import type` for types, and no `enum`, `namespace` or constructor parameter properties (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`).
- The daemon bundles the panel (`src/ui/main.ts`) with esbuild in memory at boot (`createUiBundle`). esbuild is a runtime dependency.
- No `version` field in `plugin.json` or in the marketplace entry. Each merge to `main` is an update.
- The root `dependencies` are the runtime deps. `yarn lock-plugin` writes `plugin/package.json` (the same deps, pinned to the exact versions that `yarn.lock` resolves) and `plugin/package-lock.json` (npm lockfile v3, registry only, with integrity). npm makes the lockfile from a yarn v1 lockfile that the script writes from `yarn.lock`, so each package, also a transitive one, has the version that `yarn.lock` resolves. `yarn check-plugin` checks each lock entry against `yarn.lock`. So the tests run the same packages that users get. `plugin/package.json` is not a Yarn workspace.
- `yarn check-plugin` and `yarn check-install` run in CI, on each pull request and on each push to `main`. The first checks the files above. The second copies the files of `plugin/` that git tracks (it stops when `plugin/` has a file that git does not track), installs the copy with `npm ci --ignore-scripts`, as Claude Code does, and runs the command of `plugin.json` one time.

## Considered options

- **A release branch with a committed `dist/`.** CI builds on each merge and pushes the output to a `release` branch, and the marketplace points at that branch. Rejected: it adds a release job, a second branch to keep in step and a build that can differ from the tested source. It also needs a version script or a SHA map to show which source a release holds.
- **Put inkwire in the `discover-mcp-servers` monorepo** as one more package of that plugin. Rejected: inkwire is a personal tool with its own daemon, panel and release pace. It would add a canvas server and a browser panel to every user of that plugin, and couple two unrelated release flows. We copy its pattern and not its repo.
- **Keep the local-directory install** (clone, `yarn build`, `--plugin-dir` or a local marketplace). Rejected: each update needs manual steps, and auto-update cannot work.

## Consequences

- The version of the plugin is the commit SHA. With auto-update on, Claude Code gets each merge to `main`. `/reload-plugins` loads it in an open session.
- Claude Code installs each update into a new cache folder and removes an old folder later. So the daemon cannot use the folder of the relay that started it. Each relay and each daemon records its build in the build registry (`<dataDir>/builds.json`: build id → plugin root, `first_seen`, `last_seen` and the Claude Code pids of its relays). A relay that must start a daemon starts the newest recorded build whose folder is still on disk. When that daemon exits with an error before it answers, the relay starts the next build in the order, and at the end its own. A running daemon does not restart by itself: the panel shows a stale-build notice, and one **Restart** in the panel (or the idle stop after the last session closes) starts the newest build. This changes the build paragraph of [ADR 0001](0001-one-shared-daemon-owns-all-boards.md).
- "Newer" (Decision 7) has two steps. First, a build in the Claude Code plugin cache is newer than a build from a checkout, so a `--plugin-dir` run or `yarn start` on the default data dir does not take over the daemon of the installed plugin. Then the build with the later `last_seen` is newer. `last_seen` changes when a relay of a new Claude Code process registers the build. New sessions run the version that the person installed now, so a downgrade or a pin to an older commit takes effect, also while the newer folder is on disk. A relay that starts again in the same Claude Code process and a daemon at boot do not change `last_seen`. One folder holds one build at a time: a registration removes the other ids of its root. A lock file (`builds.json.lock`) keeps two registrations from losing an entry, and a bad `builds.json` moves to `builds.json.bad` and is not written over.
- The daemon keeps the panel files in memory after the first bundle, and copies the fonts to `<dataDir>/fonts/`. So a daemon continues to serve the panel and to render screenshots after Claude Code removes its folder. A library that loads a module lazily after boot can still fail when its folder is gone.
- The build id is a hash of the source in `plugin/src/`, `plugin/package.json`, `plugin/package-lock.json` and `plugin/assets/fonts/`, not of a build file. So a release that changes only a dependency is a new build, and the panel shows the stale notice.
- A runtime import of a package that is only in `devDependencies` passes every test in the repo but fails for users. `yarn check-plugin` finds a lockfile that does not agree, but not a missing dep. The rule is in `CLAUDE.md`, and `yarn check-install` runs the installed copy.
- A native runtime dep must ship prebuilt binaries, because Claude Code runs no install scripts. `better-sqlite3`, `@resvg/resvg-js` and `esbuild` do.
- The plugin needs a Node 26 on PATH or mise. In a project whose `.nvmrc` names an older Node, it needs mise.
- There is no `yarn build`, no `dist/` and no `tsconfig.build.json`. `yarn health` and the tests run the source.
