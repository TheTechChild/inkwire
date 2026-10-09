// What holds the inkwire port: a daemon, an old stdio inkwire server, another
// process, or nothing. The relay, the autostart and the daemon's port-conflict
// path use it.
import type { BuildInfo } from "../server/build-info.js";

export interface Health {
  ok: boolean;
  name: "inkwire";
  pid: number;
  build: BuildInfo;
  clients: number;
  boards: number;
}

export type Probe =
  | { state: "daemon"; health: Health }
  /** /healthz says inkwire but has no build: the stdio server from before M4. */
  | { state: "old" }
  /** Some other process answers on the port. */
  | { state: "foreign" }
  /** Nothing listens (connection refused). */
  | { state: "down" }
  /** No answer in time: maybe a busy daemon. */
  | { state: "unknown" };

export async function probeDaemon(port: number, timeoutMs = 1000): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return { state: "down" };
    if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") return { state: "unknown" };
    // Not HTTP (a parse error) or another failure: some other process.
    return code === undefined ? { state: "unknown" } : { state: "foreign" };
  }
  let body: Partial<Health> = {};
  try {
    body = (await res.json()) as Partial<Health>;
  } catch {
    return { state: "foreign" };
  }
  if (!res.ok || body.name !== "inkwire") return { state: "foreign" };
  if (!body.build) return { state: "old" };
  return { state: "daemon", health: body as Health };
}

/** True when an inkwire server (daemon or old stdio server) answers on the port. */
export async function probeHealth(port: number): Promise<boolean> {
  const p = await probeDaemon(port);
  return p.state === "daemon" || p.state === "old";
}
