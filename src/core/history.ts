// Timeline operations (SPEC § 4). All pure: they take a History and return a
// new one. Time always comes in as an argument; nothing here reads a clock.
import { diffCollections, isEmptyOps } from "./diff.js";
import type { Author, Collections, History, Step } from "../shared/types.js";

export const COALESCE_WINDOW_MS = 1600;

export interface AppendInput {
  id: string;
  label: string;
  author: Author;
  key: string | null;
  before: Collections;
  after: Collections;
  at: number;
}

export interface AppendResult {
  history: History;
  /** Steps discarded because the head was behind the tip (SPEC § 4.3). */
  truncated: number;
  /** The id of the step that now carries this mutation (tip). */
  stepId: string;
  /** False when the mutation changed nothing and no step was recorded. */
  recorded: boolean;
}

/**
 * Append one mutation as a step. Editing while the head is behind the tip
 * truncates the steps ahead. A step whose key matches the tip's key within
 * COALESCE_WINDOW_MS replaces the tip, re-diffed against the tip's original
 * `before` snapshot — so a skipped coalesced step reverts the whole gesture.
 */
export function append(history: History, input: AppendInput): AppendResult {
  const truncated = history.steps.length - history.head;
  let steps = truncated > 0 ? history.steps.slice(0, history.head) : history.steps;

  const tip = steps[steps.length - 1];
  const coalesce =
    tip !== undefined &&
    input.key !== null &&
    tip.key === input.key &&
    !tip.skipped &&
    input.at - tip.at < COALESCE_WINDOW_MS;

  if (coalesce) {
    const ops = diffCollections(tip.before, input.after);
    const replaced: Step = { ...tip, ops, label: input.label, at: input.at };
    steps = [...steps.slice(0, -1), replaced];
    return {
      history: { ...history, steps, head: steps.length },
      truncated,
      stepId: tip.id,
      recorded: true,
    };
  }

  const ops = diffCollections(input.before, input.after);
  if (isEmptyOps(ops)) {
    return {
      history: { ...history, steps, head: steps.length },
      truncated,
      stepId: tip?.id ?? "base",
      recorded: false,
    };
  }

  const step: Step = {
    id: input.id,
    label: input.label,
    author: input.author,
    key: input.key,
    ops,
    skipped: false,
    before: input.before,
    at: input.at,
  };
  steps = [...steps, step];
  return {
    history: { ...history, steps, head: steps.length },
    truncated,
    stepId: step.id,
    recorded: true,
  };
}

/** Rewind (or replay forward) to external step index i, 0 = base. */
export function rewindTo(history: History, index: number): History {
  const head = Math.max(0, Math.min(index, history.steps.length));
  return { ...history, head };
}

/** Toggle one step's skipped flag. Refuses the base and steps past the head. */
export function toggleSkip(history: History, index: number): History {
  if (index < 1 || index > history.head) return history;
  const steps = history.steps.map((s, i) =>
    i === index - 1 ? { ...s, skipped: !s.skipped } : s,
  );
  return { ...history, steps };
}

/** Remove a step from the record entirely. The base (index 0) cannot go. */
export function dropStep(history: History, index: number): History {
  if (index < 1 || index > history.steps.length) return history;
  const steps = history.steps.filter((_, i) => i !== index - 1);
  const head = index <= history.head ? history.head - 1 : history.head;
  return { ...history, steps, head };
}

export type UndoScope = "all" | Author;

/**
 * Author-scoped undo (SPEC § 4.5). Scope "all" moves the head; a scoped undo
 * skips the newest unskipped step by that author at or before the head,
 * leaving the other author's work standing.
 */
export function undo(history: History, scope: UndoScope): History {
  if (scope === "all") {
    return { ...history, head: Math.max(0, history.head - 1) };
  }
  for (let i = history.head - 1; i >= 0; i--) {
    const s = history.steps[i]!;
    if (!s.skipped && s.author === scope) return toggleSkip(history, i + 1);
  }
  return history;
}

/** Scope "all": head forward. Scoped: restore the earliest skipped step. */
export function redo(history: History, scope: UndoScope): History {
  if (scope === "all") {
    return { ...history, head: Math.min(history.steps.length, history.head + 1) };
  }
  for (let i = 0; i < history.head; i++) {
    const s = history.steps[i]!;
    if (s.skipped && s.author === scope) return toggleSkip(history, i + 1);
  }
  return history;
}
