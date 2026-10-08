# inkwire

A shared drawing canvas where a person and one or more Claude Code sessions work on the same boards.

## Language

**Board**:
One canvas: its elements, layers, drafts, notebooks, and thread.

**Project root**:
The checkout a **Board** is a drawing of; every code ref on the **Board** is relative to it. Set when the **Board** is created; one per git worktree is normal.
_Avoid_: workspace, repo root, cwd

**Panel**:
The browser view of one board, through which the person edits it.

**Claude Code session**:
One running Claude Code process. It keeps its identity across `/clear` and `/resume`, even though Claude Code gives it a new session id each time.
_Avoid_: session (alone), conversation

**Client**:
The daemon's record of one connected Claude Code session: its current board and its session mode.
_Avoid_: connection, session

**Author**:
The one **Client** allowed to write a **Board** alongside the person. A step's `author: "ai"` always means this **Client**.
_Avoid_: writer, owner, editor

**Current board**:
The **Board** a **Client**'s tools act on when no board is named. For an **Author** it is always the **Board** it authors.
_Avoid_: active board, open board

**Thread**:
The running record on a **Board** of the person's and the **Author**'s messages and the **Author**'s tool calls. **Readers** never appear in it.
_Avoid_: chat, log

**Reader**:
Any **Client** that has a **Board** open but is not its **Author**.

**Session mode**:
Whether a Claude Code session talks to the person in the panel (`inkwire`) or in the terminal (`pty`). Each client has its own.

## Relationships

- A **Client** stands for exactly one **Claude Code session**
- Many **Clients** may have the same **Board** open at once
- A **Board** has at most one **Author**: the one **Client** that, with the person, writes it — in either **Session mode**. Only the **Author** may turn on `inkwire` **Session mode** for that **Board**, so it is the only **Client** the person's panel replies reach.
- A **Client** is the **Author** of at most one **Board** at a time.
- Any number of other **Clients** may read a **Board**; none of them may write it.
- (Letting the person address one of several talking **Clients** is a possible later change; sending a reply to all of them is rejected, because two sessions would race on the same request.)

## Flagged ambiguities

- "session" meant three things: a **Claude Code session**, the per-board in-memory state (`BoardSession` in code), and **Session mode**. Resolved: say **Claude Code session** or **Client** for the first; the code name `BoardSession` is not a domain term.
- "session id" is not an identity: `/clear` and `/resume` change it inside one **Claude Code session**.
