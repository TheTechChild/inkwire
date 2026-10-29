# Working Context Starter Kit

Keep the full project library. Give the AI the smallest current set that can support the next outcome, with a clear path to retrieve more.

This kit uses four layers:

1. **Stable instructions** — durable behavior rules in the instruction system your AI tool already uses. Do not duplicate them here.
2. **Current state** — the small set of facts and constraints that change the next move. Keep these in `CURRENT.md`.
3. **Available context** — sources the AI can retrieve, including authority, freshness, and the condition for loading each one. Map these in `CONTEXT-MAP.md`.
4. **History** — decisions that still explain the project but should no longer steer the active job. Preserve these in `DECISIONS.md` and the wider project library.

## The three moves

### Start

Put this folder beside your project. Give the AI one bounded outcome and only the sources it is authorized to inspect. Ask it to propose the first working set, then review the draft before it writes.

### Shape

After a consequential checkpoint, replace stale state in `CURRENT.md`. Move superseded decisions that still matter into `DECISIONS.md`. Update the map only when a source, authority level, freshness note, exclusion, or retrieval trigger changes.

### Pack

Before a focused job, read `CURRENT.md` and `CONTEXT-MAP.md`. Load the smallest source set that can support the task and its acceptance test. Declare what was included, what remained available, and what condition would trigger more retrieval.

## Working rules

- Current state is not a diary. A person should be able to scan the whole file quickly.
- Available does not mean active. Preserve pointers to useful sources without loading everything.
- Minimum context is not the goal. Minimum sufficient context is.
- Authority, freshness, relevance, and exposure cost are separate judgments.
- Label uncertainty. Do not repair missing context with a confident guess.
- Preserve hard constraints exactly. Do not turn preferences into permanent rules.
- Ask before crossing any approval, privacy, access, publishing, or spending boundary.

## Test the set

Run one representative task with bare, focused, and full context. Compare accepted result, missed facts, time, tool calls or tokens when available, unnecessary exposure, and the human effort needed to choose context.

If the full run catches something important, improve the map or retrieval trigger. Do not dump the full library into `CURRENT.md`. If focused performs as well or better, remove one more item and test again.
