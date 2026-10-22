// The inkwire mod (ADR 0004). It does three things beside the browser panel:
//   1. It takes the replies of the person from the inbox of the Client and
//      submits each one as the next prompt (mod delivery for session mode).
//   2. It sends the settings hook events to the daemon, keyed by session id,
//      in place of hooks/forward.sh. forward.sh stays as the fallback when
//      mods are off or the daemon is older than ADR 0004 (the mod then sends
//      no hook events); while the mod answers the hooks, the daemon makes it a no-op.
//   3. It draws the inkwire pane (/inkwire).
// It uses only the HTTP surface of the daemon. It writes nothing to stdout.
import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";
import { type Engine, type Verdict, postHook } from "./daemon";
import { accepted, deliver, noteSurface, startLoop, turnEnded, wake } from "./live";
import { renderPane } from "./pane";
import { PANE } from "./state";

const launchAtom = atom({ plugin: "inkwire", key: "launch" } as const, null);
const permissionAtom = atom({ plugin: "inkwire", key: "permission" } as const, null);
const sessionAtom = atom({ plugin: "inkwire", key: "session" } as const, null);

/** The session_mode tool, by its plugin name and by its name in a .mcp.json. */
const SESSION_MODE_TOOLS = ["mcp__plugin_inkwire_inkwire__session_mode", "mcp__inkwire__session_mode"] as const;

/** Adds the verdict of the daemon to the result of the settings hooks. */
export function merge<R extends { block?: string; additionalContext?: readonly string[] }>(result: R, verdict: Verdict): R {
  if (verdict.block) return { ...result, block: result.block ? `${result.block}\n${verdict.block}` : verdict.block };
  if (verdict.context) return { ...result, additionalContext: [...(result.additionalContext ?? []), verdict.context] };
  return result;
}

/** Keeps the permission mode of the last event: PreToolUse in a mod has none. */
async function rememberPermission($: Engine, mode: string | undefined): Promise<void> {
  if (!mode) return;
  try {
    if ((await read($, permissionAtom)) !== mode) await update($, permissionAtom, () => mode);
  } catch {
    // state is not available: the next event tries again
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "inkwire",
        description: "Open the inkwire pane: the Session thread, layers and paths, drafts and history of your board",
      });
    } catch {
      // the command is a convenience: the pane also opens by itself
    }
    try {
      // A reload keeps the id the mod knew; only the first load reads it.
      if ((await read($, sessionAtom)) === null) {
        const id = await $.session.id();
        await update($, sessionAtom, () => id);
        // The relay's hello sends the launch id, and /clear does not change it.
        if ((await read($, launchAtom)) === null) await update($, launchAtom, () => id);
      }
      await startLoop($);
    } catch {
      // no live view in this host (no state or no clock)
    }
    return next(e);
  });

  on("command.run", { command: "inkwire" }, async ($, e) => {
    noteSurface(e.presentation.isFullscreen);
    try {
      const opened = await $.ui.open({ id: PANE, title: "inkwire", focus: true });
      wake($);
      return { text: opened.isPlaced ? "inkwire pane opened." : `inkwire pane waits: ${opened.reason}` };
    } catch {
      return { text: "This surface cannot show the inkwire pane. Use the browser panel." };
    }
  });

  on("ui.render", { component: "Pane", requestId: "inkwire" }, async ($, e) => {
    noteSurface(e.viewport?.isFullscreen);
    return renderPane($, e);
  });

  // Draws nothing. It learns whether the surface docks a pane, so the mod
  // opens the pane unasked only where it is a sidebar.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    noteSurface(e.viewport?.isFullscreen);
    return next(e);
  });

  // Settings hook events. Each posts first, then runs the settings hooks of
  // the person (next), then adds the verdict of the daemon. An error in this
  // hook lets the event go on unchanged.
  on("classic.Stop", async ($, e, next) => {
    await rememberPermission($, e.permission_mode);
    const verdict = await postHook($, { ...e });
    return merge(await next(e), verdict);
  }).catch(($, e, next) => next(e));

  on("classic.SessionStart", async ($, e, next) => {
    await rememberPermission($, e.permission_mode);
    const event: Record<string, unknown> = { ...e };
    let known: string | null = null;
    try {
      known = await read($, sessionAtom);
    } catch {
      known = null;
    }
    // /clear and /resume give a new session id in the same process. The
    // daemon rekeys the Client that has the old id.
    if ((e.source === "clear" || e.source === "resume") && known && known !== e.session_id) event.prev_session_id = known;
    const verdict = await postHook($, event);
    try {
      if (known !== e.session_id) await update($, sessionAtom, () => e.session_id);
    } catch {
      // the next event tries again
    }
    wake($);
    return merge(await next(e), verdict);
  }).catch(($, e, next) => next(e));

  on("classic.UserPromptSubmit", async ($, e, next) => {
    await rememberPermission($, e.permission_mode);
    // A reply of the outbox that Claude Code took leaves the outbox, also
    // after a reload of the module lost the submit's own result.
    if (typeof e.prompt === "string") await accepted($, e.prompt);
    // A new turn: the daemon stops waiting on a reply.
    const verdict = await postHook($, { ...e });
    return merge(await next(e), verdict);
  }).catch(($, e, next) => next(e));

  on("classic.PreToolUse", { tool: SESSION_MODE_TOOLS }, async ($, e, next) => {
    // In a mod this event carries the call alone, so the mod adds the fields
    // that hooks/forward.sh gets from the settings hook input.
    const { tool, tool_use_id, ...input } = e;
    let session_id = "";
    let permission_mode: string | null = null;
    try {
      session_id = await $.session.id();
      permission_mode = await read($, permissionAtom);
    } catch {
      // send what the mod has
    }
    await postHook($, {
      hook_event_name: "PreToolUse",
      session_id,
      tool_name: tool,
      tool_input: input,
      tool_use_id,
      ...(permission_mode ? { permission_mode } : {}),
    });
    return next(e);
  }).catch(($, e, next) => next(e));

  // A main turn ended: count it (a submit that did not start a turn is lost),
  // and submit a reply that came during the turn. A refused reply waits for the person.
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await turnEnded($);
        await deliver($);
      } catch {
        // the next view tries again
      }
    }
    return next(e);
  });
};
