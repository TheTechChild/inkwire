// The daemon end of the link: the /mcp upgrade (ADR 0001). The first frame
// must be a hello. The whole contract with the daemon is the Link value: an
// MCP SDK Transport, the hello, and a closed promise.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LINK_CLOSE, LINK_VERSION, helloSchema, type Hello } from "./hello.js";
import { WsTransport } from "./ws-transport.js";

export interface Link {
  transport: Transport;
  hello: Hello;
  /** Resolves when the socket closes, for any reason. */
  closed: Promise<void>;
}

export interface LinkEndpointOptions {
  /** Null when the upgrade may pass, else the reason for a 403 (the Origin and Host check, M4.11). */
  verify?: (req: IncomingMessage) => string | null;
  /** The time for the hello frame. Default 5 s. */
  helloTimeoutMs?: number;
}

export interface LinkEndpoint {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** The links with a valid hello that are still open. */
  count(): number;
  onLink(fn: (link: Link) => void): () => void;
  /** Close every link (restart, shutdown). */
  closeAll(code?: number, reason?: string): void;
}

export function createLinkEndpoint(opts: LinkEndpointOptions = {}): LinkEndpoint {
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const listeners = new Set<(link: Link) => void>();
  const open = new Set<WebSocket>();
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: (info, cb) => {
      const reason = opts.verify?.(info.req) ?? null;
      if (reason === null) return cb(true);
      console.error(`inkwire refused ${info.req.method ?? "?"} /mcp: ${reason}`);
      cb(false, 403, "Forbidden");
    },
  });

  wss.on("connection", (socket: WebSocket) => {
    const timer = setTimeout(() => socket.close(LINK_CLOSE.badHello, "no hello"), helloTimeoutMs);
    socket.once("close", () => clearTimeout(timer));
    socket.once("message", (data) => {
      clearTimeout(timer);
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        socket.close(LINK_CLOSE.badHello, "the first frame must be a hello");
        return;
      }
      const r = raw as { type?: unknown; v?: unknown };
      if (r && r.type === "hello" && r.v !== LINK_VERSION) {
        socket.close(LINK_CLOSE.version, "link version mismatch: run yarn daemon:restart");
        return;
      }
      const parsed = helloSchema.safeParse(raw);
      if (!parsed.success) {
        socket.close(LINK_CLOSE.badHello, "the first frame must be a hello");
        return;
      }
      // Made here, in the handler of the first frame: a frame in the same
      // tick as the hello reaches the transport's own listener.
      const transport = new WsTransport(socket);
      open.add(socket);
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => {
          open.delete(socket);
          resolve();
        }),
      );
      const link: Link = { transport, hello: parsed.data, closed };
      for (const fn of listeners) fn(link);
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    count: () => open.size,
    onLink(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    closeAll(code: number = LINK_CLOSE.restart, reason = "inkwire daemon restart") {
      for (const socket of wss.clients) socket.close(code, reason);
    },
  };
}
