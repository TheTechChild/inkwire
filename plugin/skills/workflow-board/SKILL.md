---
name: workflow-board
description: Draw a multi-agent workflow run as a live board on inkwire and keep the status of each step current. Use for "show the workflow on inkwire", "workflow board", "track the run on the board", and similar.
allowed-tools: mcp__plugin_inkwire_inkwire__boards_create mcp__plugin_inkwire_inkwire__canvas_add_node mcp__plugin_inkwire_inkwire__canvas_add_edge mcp__plugin_inkwire_inkwire__canvas_update_node mcp__plugin_inkwire_inkwire__notebooks_create mcp__plugin_inkwire_inkwire__notebooks_update mcp__plugin_inkwire_inkwire__notebooks_open Read
---

The person wants to watch a workflow run on a board. Draw each step as a node. Change the status of each node before and after each step. Keep a run log in a notebook.

You start each step as its own Agent call. Parallel implement tasks are several Agent calls in one message. Only the main session has the inkwire tools. Subagents can not use them. Call the tools yourself, before and after each Agent call.

## Steps

Only one Claude Code session is the author of a board. The first line of each tool result names the board and your role.

1. **Start the run.** Call `boards_create` with `name: "workflow · <short task name>"` and `project_root`: the absolute path of the repo that the workflow works on. Keep the `board_id`. Pass it on every later call. Print the `panel_url` to the person.

2. **Add one node for each step.** Call `canvas_add_node` with `label`, `kind`, `endpoint: "pending"`, `size: [200, 74]` and `at: [40 + col * 240, 40 + row * 130]`. Use `kind: "transform"` for an agent step and `"state"` for a gate. Keep the node id of each result (`ids[0]`) in a table: step to node id. Put all nodes on row 0, in these columns:

   | step | column |
   | --- | --- |
   | scout | 0 |
   | spec | 1 |
   | setup | 2 |
   | implement | 3 |
   | gate 1 | 4 |
   | review | 5 |
   | fix | 6 |
   | gate 2 | 7 |

   At the start, add only one node "implement". The task list is not known yet.

3. **Add the edges.** Call `canvas_add_edge` with `kind: "sync"` for each pair: scout to spec, spec to setup, setup to implement, implement to gate 1, gate 1 to review, review to fix, fix to gate 2.

4. **Add the run log.** Call `notebooks_create` with `title: "run log"` and no body. Keep the `notebook_id` of the result. Call `notebooks_open` on it. Do not call `canvas_set_viewport`. Tell the person to press 0 (Fit) in the panel.

5. **Before the Agent calls of a step.** Call `canvas_update_node` with `endpoint: "running"` for each node of that step. Do this before you send the Agent calls. Finish step 6 for the step before, then do this step.

6. **When an Agent call returns.** Do this for each call when it returns. Parallel calls can return at different times. Call `canvas_update_node` with `endpoint: "passed"` or `"failed"`. Then call `notebooks_update` with `append`: one line.
   - `- [[<node id>]] passed — <result path>` or `- [[<node id>]] failed — <result path>`. Do not write the step name. The chip shows it.
   - Take the path from the last line of the subagent reply: `Result file: <path>`. Do not make up a path.
   - A read-only agent (for example Explore) writes no result file. Write the line without a path.
   - Only when the reply has a result path: Read the file. If the Read fails, skip the next line and continue. If its "## Open questions" section has a bullet that is not "None", append `- open question: <first bullet text>`. Do not append it if the run log already has the same text.

7. **After spec.** When spec returns, do these in order. First do step 6 for spec. Then do this step. Only then do step 5 for setup.
   - Call `canvas_update_node` on the "implement" node with `label: "implement <first task>"`. This node stays on row 0 and keeps its edges.
   - Add one node for each other task with `label: "implement <task>"`, `kind: "transform"`, `endpoint: "pending"` and `size: [200, 74]` (column 3, rows 1, 2, ...).
   - Name each task with one short word of 8 characters or less (for example "api", "ui"), so the label fits the node at low zoom.
   - Add `sync` edges setup to each new task node, and each new task node to gate 1.
   - If the spec says that one task needs another task first, also add a `sync` edge from the first task to the second.

8. **Skip a step.** A step that does not run goes from pending to `"skipped"`. Do not set `"running"`. Append `- [[<node id>]] skipped` at the moment you know the step will not run. Example: when review returns with nothing to fix, set "fix" to `"skipped"`. A later loop still adds "fix 2". If scout finds that main already does the task, set every step after scout to `"skipped"` and end the run.

9. **Loop on a failed gate.** This applies to any failed gate (gate 1, gate 2 or a later gate). Let N be the number of fix nodes on the board plus 1. Add "fix N" (`transform`) at column 6 and "gate N+1" (`state`) at column 7, both on row N - 1, both `pending`, both with `size: [200, 74]`. The first loop is fix 2 and gate 3. Add an `error` edge from the failed gate to "fix N". Add a `sync` edge from "fix N" to "gate N+1". Then do steps 5 and 6. A plain "fix" that never ran stays as it is.

10. **End the run.** Append `## result`. Then append one line: "all gates passed", "all gates passed after <N> fix loops", "<gate> failed — run stopped", or "stopped after scout: <one-line reason>".

## Example

Start of a run:

- `boards_create(name: "workflow · add login", project_root: "/Users/me/app")`
- `canvas_add_node(board_id, label: "scout", kind: "transform", endpoint: "pending", size: [200, 74], at: [40, 40])`
- `canvas_add_node(board_id, label: "spec", kind: "transform", endpoint: "pending", size: [200, 74], at: [280, 40])`
- `canvas_add_edge(board_id, from: "n_3f9a2c", to: "n_71be04", kind: "sync")`

Run-log line after scout (plain text in the notebook):

- `- [[n_3f9a2c]] passed — ~/.claude/agent-results/<session_id>/<agent_id>.md`

## Rules

- Send one status write for each node at each status change. Do not send an unchanged status again.
- The `endpoint` holds only one word: pending, running, passed, failed or skipped. The panel colors a node by this word. Write it exactly, in lower case. Never put a file name or a path in it.
- Write the notebook in plain text. Do not use backticks or links.
- You can be the author of one board at a time. During the run, do not write to any other inkwire board. That write releases the workflow board.
- A board update must never block or fail the workflow. If an inkwire call fails, tell the person once in the terminal. Then continue the workflow.
- If another session is the author, or the person released you from the board: stop the board updates, tell the person, and let the workflow continue.

## Don't

- Don't clone the board or create a second board to continue after a write failure.
- Don't use `session_send`, layers, paths or drafts for this.
- Don't call the inkwire HTTP API, the panel WebSocket, `/api/hook` or `yarn daemon:restart`. Only the person uses them. Use only the MCP tools.
