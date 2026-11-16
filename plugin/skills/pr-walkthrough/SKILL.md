---
name: pr-walkthrough
description: Explain a GitHub pull request on the inkwire board — "walk me through PR 123", "explain this pull request", "make a board for PR #123", or a GitHub PR URL. Reads the PR, writes the changed code as nodes, a draft, paths and review notes, and shows it in the panel.
allowed-tools: mcp__plugin_inkwire_inkwire__boards_list mcp__plugin_inkwire_inkwire__boards_create mcp__plugin_inkwire_inkwire__boards_update mcp__plugin_inkwire_inkwire__canvas_add_node mcp__plugin_inkwire_inkwire__canvas_add_edge mcp__plugin_inkwire_inkwire__canvas_bind_code mcp__plugin_inkwire_inkwire__canvas_update_node mcp__plugin_inkwire_inkwire__canvas_delete mcp__plugin_inkwire_inkwire__canvas_lint mcp__plugin_inkwire_inkwire__layers_create mcp__plugin_inkwire_inkwire__paths_create mcp__plugin_inkwire_inkwire__paths_update mcp__plugin_inkwire_inkwire__paths_play mcp__plugin_inkwire_inkwire__drafts_create mcp__plugin_inkwire_inkwire__drafts_update mcp__plugin_inkwire_inkwire__drafts_activate mcp__plugin_inkwire_inkwire__notebooks_create mcp__plugin_inkwire_inkwire__notebooks_update mcp__plugin_inkwire_inkwire__session_send Read Grep Glob Bash(gh pr view:*) Bash(gh pr diff:*) Bash(git -C * cat-file *) Bash(git -C * fetch origin *) Bash(git -C * worktree add --detach *) Bash(git -C * worktree list*)
---

The human wants to understand a pull request. Answer with a **board**: the changed code as nodes, one draft, a path for each new flow, and two notebooks.

This skill only reads the PR. It writes to the inkwire board and to one git worktree. For the rules on paths and captions, follow the `trace-path` skill (`../trace-path/SKILL.md`).

Placeholders: `<owner/repo>` is the GitHub repository. `<n>` is the PR number. `<sha>` is `headRefOid`. `<clone>` is the absolute path of the local clone.

Only one Claude Code session at a time is the author of a board. If a write fails because another session is the author, stop and tell the human. Do not clone the board. Do not write to a different board.

## Steps

1. **Read the PR.** Run `gh pr view <n> --repo <owner/repo> --json title,body,state,headRefOid,baseRefName,files,additions,deletions`. Then run `gh pr diff <n> --repo <owner/repo>`. Do not read the diff of generated files or migration snapshot JSON. If the PR is closed or merged, continue, and say so in the Summary notebook.

2. **Get the PR head.** Find `<clone>`. If you do not know it, ask the human. Run `git -C <clone> cat-file -t <sha>`. If the commit is missing, run `git -C <clone> fetch origin <sha>`. Then run `git -C <clone> worktree add --detach <clone>/worktrees/pr-<n> <sha>`. If that worktree exists at `<sha>`, reuse it. Use `git -C <clone> worktree list` to check.

3. **Make the board.** Call `boards_list` with `all: true`. If a board named "PR #<n>: <title>" exists, ask the human before you write to it. Otherwise call `boards_create` with that name and `project_root` set to `<clone>/worktrees/pr-<n>`. Read the code under that root, not under the main checkout.

4. **Choose the nodes.** Use one node for each changed module. A function gets its own node when code outside its file calls it or it holds the main change. Use a `kind` from: `entry`, `service`, `store`, `transform`, `state`, `lifeline`.
   - Skip generated files, lockfiles, migration snapshot JSON, and docs.
   - Put the test files of one app into one node. Put "tests" in its label. Use kind `entry`.
   - Keep about 15 nodes.
   - Pass `at` on every `canvas_add_node`: x = 80 + 240 × col, y = 80 + 120 × row.
   - Put columns in call order, left to right: entry, service, transform, then store or state.
   - Put the tests node or nodes in the last row.
   - Bind each node with `ref` on `canvas_add_node`, or with `canvas_bind_code`. A ref is `path/to/file.ts:symbol` or `path/to/file.ts#symbol`. `Class.method` is allowed. Without a symbol, the ref binds the whole file.
   - Leave a removed-code node unbound.
   - Add an edge (`canvas_add_edge`, kind `sync`, `async` or `error`) only for a call that you verified with Read and Grep. An HTTP call between services is an edge. Use `sync` when the caller waits for the response.

5. **Write one draft.** Call `drafts_create` with title "PR #<n>" and `marks`: a list of `{ id, role }`. Use role `added`, `changed` or `removed`. Mark every changed node and edge. Leave context nodes unmarked. Name them in the draft `note`.

6. **Write the paths.** A flow is a path when a caller outside the changed file reaches new or changed code through it. Write 1 to 3 paths. Follow `trace-path`.
   - Call `layers_create` for each flow, with the nodes it touches.
   - Call `paths_create` with `nodes`, `captions` and `refs`.
   - Give every hop a non-null `ref`.
   - Each hop needs an edge between its two nodes. A flow with no verified edge cannot be a path.
   - A path can need an unchanged caller. Add it as a context node.

7. **Write the review.** Call `notebooks_create` with title "Review". List only findings that you verified. Skip style points that a linter finds. Write one line for each finding: `- [[nodeId]] path/to/file.ts:LINE severity: finding`. LINE is the line at `<sha>`. Severity is `bug`, `risk`, `nit` or `question`. For a removed-code node, use the base line and write "base" in the line.

8. **Write the summary.** Call `notebooks_create` with title "Summary". Write one sentence on what the PR does. Write 3 to 6 one-line bullets, each with a `[[id]]` chip. Name the first path to play. A notebook body allows `## ` headings, `- ` bullets and `[[id]]` chips.

9. **Check the board.** Run `canvas_lint` before you show the board. A removed-code node stays `unbound` by design. Fix every other finding. Use `canvas_bind_code`, `canvas_update_node`, `canvas_delete`, `paths_update`, `drafts_update` or `notebooks_update`. Run `canvas_lint` again until only those `unbound` findings stay. If an error names `boards_update`, ask the human for the root.

10. **Show it.** Call `session_send` once, with `text`, `draft` and `path: { layer_id, path_id }` for the first path. Do not call it twice. In `pty` mode it returns `mode_off`. Then call `drafts_activate` and `paths_play` once each. Give the panel URL and a 3-line terminal summary.

11. **Tell the human about the worktree.** Put this in the `session_send` text or the terminal summary: the worktree stays. Give the remove command: `git -C <clone> worktree remove worktrees/pr-<n>`.

## Don't

- Don't change the PR in any way: no comment, review, approval, push or `gh pr checkout`.
- Don't switch the branch of the main checkout.
- Don't call the inkwire HTTP API, the panel WebSocket, `/api/hook` or `yarn daemon:restart`. Only the human uses them. Use only the MCP tools.
