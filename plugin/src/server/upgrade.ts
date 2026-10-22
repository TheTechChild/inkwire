// One upgrade router for the http server (plan M4.2). A WebSocketServer made
// with { server, path } takes every upgrade and answers 400 for other paths,
// so the panel's /ws and the link's /mcp cannot share one server that way.
// Each handler owns a noServer WebSocketServer; this file does not import ws.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** Send each upgrade to the handler of its pathname. Destroy the socket of any other path. */
export function routeUpgrades(server: Server, routes: Record<string, UpgradeHandler>): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    const handler = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    if (!handler) {
      socket.destroy();
      return;
    }
    handler(req, socket, head);
  });
}
