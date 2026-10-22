---
status: accepted
---

# A Claude Code mod beside the browser panel

Claude Code mods (plugins of JS/TS function hooks, Claude Code ≥ 2.1.287) can draw a pane beside the transcript, hook the settings-hook events as `classic.<Event>`, and start a turn with `$.prompt.submit`. A mod cannot host the browser panel: no element runs HTML, DOM or script, pointer input exists only in a cell-grid `Client`, and no surface has both pointer input and vector output. So **the browser stays the ink surface**, and the inkwire plugin adds a mod that does three things:

1. **Mod delivery for session mode.** When the Client has a live mod, `session_send` does not block. It posts the message and returns `delivered` at once; the turn ends. The person's reply (from the browser composer) goes to the Client's inbox, and the mod submits it as the next user prompt.
2. **The mod forwards the hook events**, keyed by session id, in place of `hooks/forward.sh`. The shell forwarder stays as the fallback for sessions with mods off (`disableAllHooks`, `allowManagedModsOnly`, older Claude Code).
3. **A status line** (`$.ui.status`), one line: `inkwire · <board name> · <state>`. The state is `pty` (mode off), `claude is working`, `waiting on you` (the Author push is `pending`, or the Client is `awaiting`), `reply queued` (a reply in the mod's outbox that Claude Code did not take yet) or `reply refused · /inkwire send`. With no current board it is `inkwire · no board`; with no Client for the session, `inkwire · not linked`; with the daemon down, `inkwire · daemon not reachable`; with a daemon from before this ADR (a 404 on `/api/mod/view`), `inkwire · daemon is older than the mod · restart it in the panel`. The mod sets it on each view and on each change of its outbox. The `/inkwire` command answers with text and starts no turn: `/inkwire` gives the status line text and the browser panel URL, `/inkwire send` submits the refused replies again, and `/inkwire discard` drops them. The browser panel stays the place to read the thread and to reply.

The mod is person-side UI. It uses only the daemon's HTTP surface, never `$.mcp.call` (that rides the agent's relay and pid and would count as the agent).

## Identity

The mods API has no pid. The mod knows `$.session.id()`, the current session id. So every mod request names the Client by **session id** (`Clients.bySessionId`). On `SessionStart` `clear` or `resume` the mod also sends the id it knew before (`prev_session_id`), and the daemon rekeys the Client found by that old id.

The relay's hello sends `CLAUDE_CODE_SESSION_ID` from the relay's environment. That is the **launch** id, and `/clear` does not change it. So a Client that a hello makes after `/clear` (a relay reconnect, a daemon restart) holds the launch id, not the current id. Two repairs:

- A `forward.sh` event with a pid sets the Client's session id to the event's: the pid is the true key.
- The mod keeps the first id it saw (the launch id) and sends it as `alias` on the view. When no Client has the current id, the daemon finds the Client by the alias and rekeys it to the current id.

A session id that two Clients hold (a session resumed while it is still open in another terminal) names no Client. Then the mod of each gets `client: null`, and both fall back to `forward.sh` and the blocking model.

A Client has a **live mod** while the mod's view loop polled the daemon for it in the last `MOD_TTL_MS` (45 s). Only `GET /api/mod/view` marks it (`client.mod.at`). The loop polls every ≤ 25 s, so a running loop is always live. A mod whose loop stopped is not live, so `session_send` blocks: only a running loop can take the inbox.

The mod **answers the hooks** of a Client while its loop is live or it sent a hook event in the last `MOD_TTL_MS` (`client.modHookAt`). Then a `forward.sh` event for that Client only rekeys.

## Mod delivery (decision 1)

New Client fields: `mod: { at } | null`, `modHookAt: number | null`, `awaiting: boolean`, `delivered: boolean`, `inbox: ModReply[]`.

- `session_send` with a live mod and no pending send: same checks, Thread row, highlight, trace, draft and notebook as today; then `awaiting = true`, `delivered = true`, and it returns `{ status: "delivered", note }` at once. No timer, no pending send. Without a live mod it blocks as today.
- `session_send` without a live mod, in a session that does not meet the blocking model's two requirements (permission mode `auto`/`bypassPermissions`, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`), does not block. It turns the mode off and returns `mode_off` with a note. (The mode can go on with a live mod and no such check, and the mod can stop later.)
- `Stop` while the mode is on: `awaiting` or `delivered`, with a live mod → allow (the turn ends; the reply comes as a new prompt). `delivered` covers a reply that came before the Stop: it is in the inbox or the mod's outbox. `awaiting` or `delivered` with no live mod → clear both, then the blocking model's rule. Else → block with the same reason and ceiling as today.
- `session_reply` (from the browser): a pending send → resolve it as today. Else `awaiting` → add the `you` row, put `{ id, prompt }` in the inbox, `awaiting = false`. Else fail ("claude code is still working"). With `awaiting` but no live mod, fail and tell the person to type in the terminal.
- The inbox item's `prompt` is built by the daemon: the reply text, then one line `inkwire ctx: {focus, selection, trace, draft, notebook, revision, board}` (JSON, ids only), then `Answer with session_send.`
- `UserPromptSubmit` (the person typed in the terminal, or the mod submitted a reply) clears `awaiting` and `delivered`. `hooks/hooks.json` also sends it to `forward.sh`, so a terminal prompt clears them when the mod is gone.
- Mode off (any way) clears `awaiting`, `delivered` and the inbox. The mod clears its outbox when the view shows the mode is not `inkwire`.
- `session_mode(on)` with a live mod does not need permission mode `auto` or `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`: nothing blocks, and the person sees permission prompts in the terminal of the session. It still needs a hook event (the mod's count) and a board. A repeated `on` (the Client is already in `inkwire` mode) keeps `awaiting`, `delivered` and the inbox.
- The mod submits each taken reply once. It marks the reply in `$.state` before `$.prompt.submit`, so a reload of the module does not submit it again. A reply leaves the outbox when the submit resolves or when `UserPromptSubmit` shows its text. A refused reply (a hook or Esc dropped it), or one that did not start a turn within two main turns, waits for the person: `/inkwire send` or `/inkwire discard`. The host refuses `$.prompt.submit` from a `command.run` hook, so `/inkwire send` marks the reply new again and a timer submits it after the command returns. A discard does not remove a queued reply: a discard cannot take back a queued prompt.
- The push's `author.pending` is true while the Author's send is pending **or** it is awaiting on that board, so the browser composer opens in both models.

## HTTP contract (the mod's only surface)

All routes take the Claude Code session id. No `Origin` is sent, so `checkBrowserRequest` passes on `Host`. Only the view marks `client.mod.at`; a mod hook event marks `client.modHookAt`.

The mod sends hook events only after a view answered `200`, and it keeps that fact in `$.state`. A daemon from before this decision answers the view with `404` and reads a `?via=mod` event as one from `forward.sh`. With it, the mod sends no hook events, and `forward.sh` alone sends each event once. (A newer build never restarts the daemon, so a new plugin with an old daemon is a normal state.)

- `POST /api/hook?via=mod&bg=<CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS or unset>` — body: the classic event's stdin JSON (`hook_event_name`, `session_id`, `permission_mode`, `source`, …) plus `prev_session_id?`. Reply: the same text verdict as for `forward.sh` (`ok` | `block\n<reason>` | `context\n<text>`). Events: `Stop`, `SessionStart` (all sources), `PreToolUse` on the `session_mode` tool, `UserPromptSubmit`. A request **without** `via=mod` (from `forward.sh`) for a Client whose hooks the mod answers only rekeys and returns `ok`: the mod already answered.
- `GET /api/mod/view?session=<id>&alias=<launch id>&since=<key>&wait=<ms, ≤ 25000>` — long poll. Returns `200 { key, client, board }` at once when the key differs from `since`, else when anything changes, else after `wait` (same key). `client` is `{ pid, label, mode, awaiting, inbox: <count>, current_board }` or null (no one Client has that session id or alias). `board` is null with no current board, else `{ id, name, author }`: `author` is the browser push's `session.author` (`AuthorPush` or null). Only these fields are in the key, so an edit of the board does not wake the poll. `400 { error }` for a missing session or a bad wait.
- `POST /api/mod/take` — body `{ session }`. Returns `200 { replies: [{ id, prompt }] }` and empties the inbox. `400 { error }` for a bad body, `404 { error }` when no Client has that session id.

## Considered options

- **Host the panel in a mod pane.** Not possible: no DOM, no script, no WebSocket in a hooks module.
- **A pane beside the transcript** with the Session thread and composer, the Author strip (Release, Allow, mode off), the stale-build Restart, Layers with focus and the path walk, Drafts and History, and a `POST /api/mod/intent` route for its intents (author `human`). It was built and tested, then removed: it repeats the Claude Code transcript and the browser panel, and so it gives little value. The status line and `/inkwire` replace it.
- **Ink in a `Client`** (cell resolution) or **a headless browser blitted into an `Image`** (kitty/Ghostty/iTerm2 only; a Client over an Image is undocumented). Deferred to a spike.
- **Make `session_send` non-blocking for everyone.** Rejected: sessions with mods off have no way to deliver the reply.
- **Remove `forward.sh`.** Rejected: an organization's `allowManagedModsOnly` stops a mod but not the plugin's settings hooks.

## Consequences

- Two delivery models exist; the Client's mod liveness picks one at `session_send` time.
- The daemon gains a second person-side client (the mod) beside the browser. Agents still must not call the HTTP API; the `/api/mod/*` routes are for the mod.
- A reply that reaches the inbox while the mod is gone waits there until the mod returns or the mode turns off.
- `forward.sh` runs on each `UserPromptSubmit` too (a `ps` walk per prompt).
- A mod whose loop stopped but whose hooks still run answers the hooks for 45 s after its last hook event. After a longer quiet time, one event can reach the daemon from both the mod and `forward.sh`.
- The person reads the thread and replies in the browser panel. In the terminal, the status line shows the state, and `/inkwire` gives the panel URL.
