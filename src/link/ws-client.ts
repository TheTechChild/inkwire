// The relay end of the link: open the /mcp WebSocket, send the hello first,
// then hand back the Transport.
import { WebSocket } from "ws";
import type { Hello } from "./hello.js";
import { WsTransport } from "./ws-transport.js";

export function connectLink(url: string, hello: Hello, timeoutMs = 5000): Promise<WsTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    // Made before open: a frame that arrives at once is kept until start().
    const transport = new WsTransport(socket);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`link: no connection to ${url} in ${timeoutMs} ms`));
    }, timeoutMs);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once("error", fail);
    socket.once("unexpected-response", (_req, res) => {
      socket.terminate();
      fail(new Error(`link: the daemon answered ${res.statusCode} to ${url}`));
    });
    socket.once("open", () => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.send(JSON.stringify(hello), (err) => (err ? reject(err) : resolve(transport)));
    });
  });
}
