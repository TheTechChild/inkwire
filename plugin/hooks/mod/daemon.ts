// The HTTP surface of the daemon that the mod uses (ADR 0004). The mod uses
// only these routes. It never calls $.mcp.call: that goes through the relay
// of the agent and counts as the agent.
import { atom, read, update } from "claude-code";
import type { EngineInterface, HttpResponse } from "claude-code";
import type { InkwireReply, InkwireView } from "./contract";

/**
 * True after a GET /api/mod/view of this daemon answered 200: the daemon has
 * the mod's routes. A daemon from before ADR 0004 answers 404, and it would
 * read a hook event of the mod as one from forward.sh. So the mod sends hook
 * events only while this is true, and forward.sh sends them for an old daemon.
 * It is in $.state, so a reload of the module keeps it.
 */
const routesAtom = atom({ plugin: "inkwire", key: "routes" } as const, false);

export type Engine = EngineInterface;

/** The port of the daemon when INKWIRE_PORT is unset. */
export const DEFAULT_PORT = 4691;

/** What fetchView returns for a daemon that answers 404: it is older than the mod. */
export const OLD_DAEMON = "old";

/** A hook path waits this long for the daemon at most. */
export const HOOK_TIMEOUT_MS = 3000;
/** The long poll asks the daemon to hold the request this long. */
export const VIEW_WAIT_MS = 20000;

export interface Verdict {
  block?: string;
  context?: string;
}

/** INKWIRE_PORT, or 4691 when it is unset or not a port. */
export async function port($: Engine): Promise<number> {
  let raw: string | undefined;
  try {
    raw = await $.env.get("INKWIRE_PORT");
  } catch {
    raw = undefined;
  }
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export async function baseUrl($: Engine): Promise<string> {
  return `http://127.0.0.1:${await port($)}`;
}

/**
 * Fetch, with a limit on the time. $.http.fetch has no time limit, and the
 * time of a call on $ does not count against the budget of a hook, so a
 * daemon that does not answer could hold a hook. Returns null on any error
 * and when the time is over.
 */
export async function fetchWithin($: Engine, url: string, init: Parameters<Engine["http"]["fetch"]>[1], ms: number): Promise<HttpResponse | null> {
  const stop = new AbortController();
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => null,
    // An aborted or refused wait must not end the race: wait for the fetch.
    () => new Promise<null>(() => {}),
  );
  try {
    return await Promise.race([$.http.fetch(url, init).catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    stop.abort();
  }
}

async function postJson($: Engine, path: string, body: unknown, ms: number): Promise<HttpResponse | null> {
  return fetchWithin(
    $,
    `${await baseUrl($)}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ms,
  );
}

/** The text verdict of /api/hook: `ok`, `block\n<reason>` or `context\n<text>`. */
export function parseVerdict(text: string): Verdict {
  const nl = text.indexOf("\n");
  const head = (nl < 0 ? text : text.slice(0, nl)).trim();
  const body = nl < 0 ? "" : text.slice(nl + 1).replace(/\s+$/, "");
  if (head === "block") return { block: body || "inkwire blocked the stop" };
  if (head === "context" && body) return { context: body };
  return {};
}

/**
 * Sends one settings hook event to the daemon. Any error gives an empty
 * verdict: the mod never holds the session because the daemon is down.
 */
export async function postHook($: Engine, event: Record<string, unknown>): Promise<Verdict> {
  try {
    if (!(await read($, routesAtom))) return {};
    let bg: string | undefined;
    try {
      bg = await $.env.get("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS");
    } catch {
      bg = undefined;
    }
    const url = `${await baseUrl($)}/api/hook?via=mod&bg=${encodeURIComponent(bg ?? "unset")}`;
    const res = await fetchWithin(
      $,
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) },
      HOOK_TIMEOUT_MS,
    );
    if (!res || !res.ok) return {};
    return parseVerdict(res.text);
  } catch {
    return {};
  }
}

/**
 * The result of one long poll: the view, OLD_DAEMON when the daemon answered
 * 404 (it is from before ADR 0004 and has no mod routes), or null when the
 * daemon did not answer. `alias` is the session id that the mod saw first (the launch id):
 * a Client that a hello made after /clear holds it.
 */
export async function fetchView($: Engine, session: string, since: string, alias: string | null = null): Promise<InkwireView | typeof OLD_DAEMON | null> {
  const q = new URLSearchParams({ session, since, wait: String(VIEW_WAIT_MS) });
  if (alias && alias !== session) q.set("alias", alias);
  const res = await fetchWithin($, `${await baseUrl($)}/api/mod/view?${q.toString()}`, { method: "GET" }, VIEW_WAIT_MS + 10000);
  // A 404 is a daemon with no mod routes; no answer says nothing about the routes.
  if (res && (res.ok || res.status === 404)) await setRoutes($, res.ok);
  if (res?.status === 404) return OLD_DAEMON;
  if (!res || !res.ok) return null;
  try {
    const view = JSON.parse(res.text) as InkwireView;
    return typeof view === "object" && view !== null && typeof view.key === "string" ? view : null;
  } catch {
    return null;
  }
}

/** Takes the replies from the inbox of the Client. The daemon empties the inbox. */
export async function takeReplies($: Engine, session: string): Promise<InkwireReply[]> {
  const res = await postJson($, "/api/mod/take", { session }, HOOK_TIMEOUT_MS);
  if (!res || !res.ok) return [];
  try {
    const body = JSON.parse(res.text) as { replies?: unknown };
    if (!Array.isArray(body.replies)) return [];
    return body.replies.filter(
      (r): r is InkwireReply => typeof r === "object" && r !== null && typeof (r as InkwireReply).id === "string" && typeof (r as InkwireReply).prompt === "string",
    );
  } catch {
    return [];
  }
}

async function setRoutes($: Engine, ok: boolean): Promise<void> {
  try {
    if ((await read($, routesAtom)) !== ok) await update($, routesAtom, () => ok);
  } catch {
    // state is not available: the next view tries again
  }
}
