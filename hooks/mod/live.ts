// The live view: one long-poll loop on GET /api/mod/view per session, the
// inbox of replies, the status line, and the /inkwire command.
import { atom, read, update } from "claude-code";
import type { InkwireOutboxItem, InkwireView } from "./contract";
import { type Engine, fetchView, OLD_DAEMON, port, takeReplies } from "./daemon";

const launchAtom = atom({ plugin: "inkwire", key: "launch" } as const, null);
const linkAtom = atom({ plugin: "inkwire", key: "link" } as const, { up: false, old: false, checked: false });
const loopAtom = atom({ plugin: "inkwire", key: "loop" } as const, "");
const outboxAtom = atom({ plugin: "inkwire", key: "outbox" } as const, []);
const turnsAtom = atom({ plugin: "inkwire", key: "turns" } as const, 0);
const viewAtom = atom({ plugin: "inkwire", key: "view" } as const, null);

/** After an error, wait this long, times 2 for each error after it, to MAX_BACKOFF_MS. */
const BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;
/** The shortest time between two polls, so a fast daemon cannot make a tight loop. */
const MIN_GAP_MS = 100;
/**
 * A submitted reply starts its turn at the latest when the session is idle
 * after the turn that runs now. When this many main turns ended after the
 * submit and Claude Code did not take the reply, the submit is lost (for
 * example, a reload dropped it).
 */
const LOST_AFTER_TURNS = 2;

// Module values. A reload of the module starts them again; the loop token in
// $.state stops the loop of the old module. The outbox marks in $.state (not
// these values) stop a second submit of a reply after a reload.
let token = "";
let generation = 0;
let lastStatus: string | undefined;

/**
 * Starts the loop for this module. A loop of an older module sees a new token
 * and stops, so there is never more than one loop.
 */
export async function startLoop($: Engine): Promise<void> {
  const mine = crypto.randomUUID();
  token = mine;
  await update($, loopAtom, () => mine);
  wake($);
}

/**
 * Starts a new poll now. The poll that waits now stops when it returns,
 * because its generation is old.
 */
export function wake($: Engine): void {
  if (!token) return;
  generation += 1;
  void poll($, token, generation, 0);
}

async function isCurrent($: Engine, mine: string, gen: number): Promise<boolean> {
  if (gen !== generation || mine !== token) return false;
  try {
    return (await read($, loopAtom)) === mine;
  } catch {
    return false;
  }
}

function later($: Engine, ms: number, mine: string, gen: number, errors: number): void {
  try {
    $.clock.after(ms, () => void poll($, mine, gen, errors));
  } catch {
    // The clock refused the timer (the module unloads): the loop ends.
  }
}

function backoff(errors: number): number {
  return Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** Math.min(errors, 4));
}

/**
 * One poll. Every path schedules the next poll unless the loop is not
 * current: an error in any step waits with backoff and tries again, so the
 * loop never stops by accident. The daemon counts the mod live only while
 * these polls come, so a loop that stops falls back to the blocking model.
 */
async function poll($: Engine, mine: string, gen: number, errors: number): Promise<void> {
  if (!(await isCurrent($, mine, gen))) return;
  let next = MIN_GAP_MS;
  let nextErrors = 0;
  try {
    const session = await $.session.id();
    const since = (await read($, viewAtom))?.key ?? "";
    const view = await fetchView($, session, since, await launchId($));
    if (!(await isCurrent($, mine, gen))) return;
    if (view === null || view === OLD_DAEMON) {
      await setLink($, false, view === OLD_DAEMON);
      await refreshStatus($);
      next = backoff(errors);
      nextErrors = errors + 1;
    } else {
      await setLink($, true, false);
      if (view.key !== since) await update($, viewAtom, () => view);
      await afterView($, view);
    }
  } catch {
    next = backoff(errors);
    nextErrors = errors + 1;
  }
  later($, next, mine, gen, nextErrors);
}

async function launchId($: Engine): Promise<string | null> {
  try {
    return await read($, launchAtom);
  } catch {
    return null;
  }
}

async function setLink($: Engine, up: boolean, old: boolean): Promise<void> {
  const link = await read($, linkAtom);
  if (link.up !== up || link.old !== old || !link.checked) await update($, linkAtom, () => ({ up, old, checked: true }));
}

async function setStatus($: Engine, text: string | undefined): Promise<void> {
  if (text === lastStatus) return;
  lastStatus = text;
  try {
    $.ui.status(text);
  } catch {
    // no status line on this host
  }
}

/**
 * The status line text. `view` is null when the daemon did not answer, and
 * OLD_DAEMON when the daemon answered but has no mod routes.
 * `outbox` is the mod's outbox: a reply that waits there tells more than the mode.
 */
export function statusText(view: InkwireView | typeof OLD_DAEMON | null, outbox: readonly InkwireOutboxItem[]): string {
  if (view === OLD_DAEMON) return "inkwire · daemon is older than the mod · restart it in the panel";
  if (!view) return "inkwire · daemon not reachable";
  const { client, board } = view;
  if (!client) return "inkwire · not linked";
  if (!board) return "inkwire · no board";
  let state: string;
  if (outbox.some((x) => x.drop !== undefined)) state = "reply refused · /inkwire send";
  else if (outbox.length > 0) state = "reply queued";
  else if (client.mode !== "inkwire") state = "pty";
  else if (client.awaiting || (board.author?.pid === client.pid && board.author.pending)) state = "waiting on you";
  else state = "claude is working";
  return `inkwire · ${board.name} · ${state}`;
}

/** Sets the status line from the state of the mod. Nothing before the first view. */
async function refreshStatus($: Engine): Promise<void> {
  try {
    const link = await read($, linkAtom);
    if (!link.checked) return;
    const view = link.up ? await read($, viewAtom) : link.old ? OLD_DAEMON : null;
    await setStatus($, statusText(view, await read($, outboxAtom)));
  } catch {
    // state is not available: the next view tries again
  }
}

/** What the mod does with each new view: status, inbox. */
export async function afterView($: Engine, view: InkwireView): Promise<void> {
  await refreshStatus($);
  // Mode off cleared the inbox of the daemon (ADR 0004): the replies that the
  // mod took go too. A submit that Claude Code queued already cannot come back.
  if (view.client && view.client.mode !== "inkwire") {
    if ((await read($, outboxAtom)).length > 0) {
      await update($, outboxAtom, () => []);
      await refreshStatus($);
    }
    return;
  }
  if (view.client && view.client.inbox > 0) {
    let session = "";
    try {
      session = await $.session.id();
    } catch {
      return;
    }
    const replies = await takeReplies($, session);
    if (replies.length > 0) {
      await update($, outboxAtom, (list) => [
        ...list,
        ...replies.filter((r) => !list.some((x) => x.id === r.id)).map((r) => ({ id: r.id, prompt: r.prompt })),
      ]);
      await refreshStatus($);
    }
  }
  await deliver($);
}

/**
 * Submits replies from the outbox as the person's next prompt: only the
 * replies that were never submitted. A refused reply goes again only after
 * /inkwire send makes it new again. Each reply is marked in $.state before
 * the submit, so a reload of the module never submits it a second time. A
 * reply leaves the outbox when Claude Code takes it (the submit resolves, or
 * UserPromptSubmit shows its text). Do not call it from a command.run hook:
 * the host refuses that submit.
 */
export async function deliver($: Engine): Promise<void> {
  let turns = 0;
  let now = 0;
  try {
    turns = await read($, turnsAtom);
    now = await $.clock.now();
  } catch {
    return;
  }
  const claimed: InkwireOutboxItem[] = [];
  try {
    await update($, outboxAtom, (list) => {
      claimed.length = 0;
      return list.map((item) => {
        if (item.sentAt !== undefined) return item;
        const marked: InkwireOutboxItem = { id: item.id, prompt: item.prompt, sentAt: now, turn: turns };
        claimed.push(marked);
        return marked;
      });
    });
  } catch {
    return;
  }
  for (const reply of claimed) {
    let submitted: ReturnType<Engine["prompt"]["submit"]>;
    try {
      submitted = $.prompt.submit({ text: reply.prompt, asUser: true });
    } catch {
      await markDrop($, reply.id, "the submit failed");
      continue;
    }
    void submitted.then(
      async (result) => {
        if (result.drop !== undefined) {
          await markDrop($, reply.id, result.drop);
          return;
        }
        await accepted($, reply.prompt);
      },
      async () => {
        await markDrop($, reply.id, "the submit failed");
      },
    );
  }
}

async function markDrop($: Engine, id: string, reason: string): Promise<void> {
  try {
    await update($, outboxAtom, (list) => list.map((x) => (x.id === id ? { ...x, drop: reason } : x)));
    await refreshStatus($);
  } catch {
    // state is not available
  }
}

/** Claude Code took a prompt: the reply with that text leaves the outbox. */
export async function accepted($: Engine, prompt: string): Promise<void> {
  try {
    if (!(await read($, outboxAtom)).some((x) => x.prompt === prompt)) return;
    await update($, outboxAtom, (list) => list.filter((x) => x.prompt !== prompt));
    await refreshStatus($);
  } catch {
    // state is not available
  }
}

/**
 * A main turn ended. A reply submitted LOST_AFTER_TURNS turns ago that Claude
 * Code did not take is lost: it shows as refused, so the person can send it
 * again or discard it.
 */
export async function turnEnded($: Engine): Promise<void> {
  const turns = (await read($, turnsAtom)) + 1;
  await update($, turnsAtom, () => turns);
  const lost = (await read($, outboxAtom)).filter(
    (x) => x.sentAt !== undefined && x.drop === undefined && turns - (x.turn ?? 0) >= LOST_AFTER_TURNS,
  );
  for (const x of lost) await markDrop($, x.id, "it did not start a turn");
}

/**
 * Removes the replies that Claude Code refused, when the person does not
 * want to send them. A reply that waits in Claude Code's queue stays: a
 * discard cannot take it back.
 */
export async function discardOutbox($: Engine): Promise<void> {
  await update($, outboxAtom, (list) => list.filter((x) => x.sentAt !== undefined && x.drop === undefined));
  await refreshStatus($);
}

function replies(n: number): string {
  return n === 1 ? "1 reply" : `${n} replies`;
}

/**
 * The text of /inkwire. It starts no turn of Claude. `args` is what the
 * person typed after the name: "" (the status and the browser panel URL),
 * "send" (submit the refused replies again) or "discard" (drop them).
 */
export async function inkwireCommand($: Engine, args: string): Promise<string> {
  const word = args.trim().toLowerCase();
  const outbox = await read($, outboxAtom);
  const refused = outbox.filter((x) => x.drop !== undefined);
  if (word === "send") {
    if (refused.length === 0) return "inkwire · no refused reply to send";
    // The host refuses $.prompt.submit from a command.run hook: the submit
    // would wait on the turn that the hook holds. A timer submits after the
    // command returns. If the timer is refused, the next view submits.
    await update($, outboxAtom, (list) => list.map((x) => (x.drop === undefined ? x : { id: x.id, prompt: x.prompt })));
    await refreshStatus($);
    try {
      $.clock.after(0, () => void deliver($));
    } catch {
      wake($);
    }
    return `inkwire · sent ${replies(refused.length)} again`;
  }
  if (word === "discard") {
    if (refused.length === 0) return "inkwire · no refused reply to discard";
    await discardOutbox($);
    return `inkwire · discarded ${replies(refused.length)}`;
  }
  if (word !== "") return "Usage: /inkwire (status and panel URL), /inkwire send, /inkwire discard";

  // A view now, not the one the loop holds: the command must not show an old state.
  let session = "";
  try {
    session = await $.session.id();
  } catch {
    // no session id: the view has no Client
  }
  const view = await fetchView($, session, "", await launchId($));
  wake($);
  const lines = [statusText(view, outbox)];
  // An old daemon has no mod view, so the mod does not know the board: the URL has no board.
  if (view === OLD_DAEMON) lines.push(`Browser panel: http://127.0.0.1:${await port($)}/`);
  else if (view?.board) lines.push(`Browser panel: http://127.0.0.1:${await port($)}/?board=${view.board.id}`);
  if (refused.length > 0) {
    lines.push(`${replies(refused.length)} refused (${refused[0]!.drop}). /inkwire send submits again; /inkwire discard drops.`);
  }
  return lines.join("\n");
}
