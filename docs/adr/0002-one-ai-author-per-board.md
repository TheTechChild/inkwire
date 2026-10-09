---
status: accepted
---

# One AI author per board

With a shared daemon, many Claude Code sessions can reach the same board. We allow exactly one of them — the board's **Author** — to write it, together with the person; every other session, and every subagent of another session, can only read. The rule holds in both session modes: a session drawing from the terminal (`pty`) is an author just as much as one talking through the panel (`inkwire`), because skills like `/trace-path` write layers, paths, and drafts from the terminal, and `inkwire` mode is unavailable to any session that is not running unattended.

Because only one AI writes a board, a step's `author: "ai"` always identifies that one session, so the `"human" | "ai"` contract stays as it is.

## Claiming and losing authorship

- **Claim on first write**, not on open: reads never claim. `boards_create` and `boards_import` make the creator the author. `session_mode(on)` also claims a board with no author.
- **One board per client.** An author that writes a second, unclaimed board releases the first and claims the second; if the second has an author, the write fails and the first stays claimed.
- **Release** on relay disconnect, on that switch, or by `boards_release`.
- **Only the person takes authorship away**, with a Release control in the panel. A released author in `inkwire` mode gets its pending `session_send` back as `mode_off`, and every write it makes on that board fails saying it is no longer the author, until another client claims the board, it disconnects, or the person allows it again from the panel. Letting one failed write be enough was rejected: the agent's retry would re-claim the board and undo the person's Release.
- **The person and the author move together.** A claim makes the claimed board the client's current board. While a client is in `inkwire` mode on a board, nothing it does can claim another board; it must turn the mode off first, so the conversation never ends without a decision. Outside that mode a switch is allowed, and both the agent (a one-time notice in the next tool result, on top of a board context line in every result) and the person (a Thread row on both boards) are told.
- **Delete is a write.** Only the author, or any client while the board has no author, may delete it; the person can always delete from the panel.
- **No agent can force a claim.** A refused write names the current author and tells the agent to ask the person to release the board in the panel. We rejected idle-timeout release (it would take a board from a session in a long trace) and an agent-side force flag (one session could seize another's board without the person deciding).

## Considered Options

- **Many AI writers, tagged per client** (add a client label to steps; coalesce only within a client). Rejected: the person wants one AI and one human building a board together, not a crowd; tagging treats the symptom.
- **Only `inkwire` mode grants write.** Rejected: it would leave terminal sessions and terminal-run skills read-only.
- **No author while no session is in `inkwire` mode.** Rejected: brings back two sessions' edits coalescing into one step whenever the mode is off.

## Consequences

- Subagents of the author session share its relay, so they can write too; the daemon cannot tell them from the author. That is accepted: the author session answers for its own subagents.
