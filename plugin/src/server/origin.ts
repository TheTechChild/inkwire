// The Origin and Host check on the browser routes (plan M4.11, Decision 12).
// A web page in the person's browser must not reach the panel WebSocket, the
// link, or a state-changing HTTP route. The Host check stops DNS rebinding.
// A request with no Origin passes: the hook's curl and `yarn daemon:restart`
// send none, and a local process that runs as the person is trusted.
import type { IncomingMessage } from "node:http";

/**
 * Null when the request may pass, else the reason it may not. The port
 * defaults to the local port of the request's socket.
 */
export function checkBrowserRequest(req: IncomingMessage, port: number | undefined = req.socket.localPort): string | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = (req.headers.host ?? "").toLowerCase();
  if (!allowedHosts.includes(host)) return `host ${JSON.stringify(req.headers.host ?? "")} is not allowed`;
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  if (allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) return null;
  return `origin ${JSON.stringify(origin)} is not allowed`;
}

/** Log one stderr line for a refused request. */
export function logRefused(where: string, req: IncomingMessage, reason: string): void {
  console.error(`inkwire refused ${req.method ?? "?"} ${where}: ${reason}`);
}
