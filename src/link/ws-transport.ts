// An MCP SDK Transport over one WebSocket (ADR 0001): one JSON-RPC message in
// each text frame. Both ends of the link use it. Nothing outside src/link/
// imports ws for MCP (tests/link/boundary.test.ts).
import { WebSocket } from "ws";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class WsTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private started = false;
  /** Messages that arrive before start(): McpServer.connect awaits start(), so none may be lost. */
  private early: JSONRPCMessage[] = [];
  private closedEarly = false;
  private closeFired = false;
  /** The close code of the socket, once it closed. */
  closeCode: number | null = null;
  closeReason = "";

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onerror?.(new Error("link: binary frame ignored"));
        return;
      }
      let msg: JSONRPCMessage;
      try {
        msg = JSON.parse(String(data)) as JSONRPCMessage;
      } catch (err) {
        this.onerror?.(new Error(`link: bad JSON frame: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (!this.started) this.early.push(msg);
      else this.onmessage?.(msg);
    });
    socket.on("close", (code, reason) => {
      this.closeCode = code;
      this.closeReason = String(reason);
      if (!this.started) this.closedEarly = true;
      else this.fireClose();
    });
    socket.on("error", (err) => this.onerror?.(err));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const msg of this.early.splice(0)) this.onmessage?.(msg);
    if (this.closedEarly) this.fireClose();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("link closed"));
        return;
      }
      this.socket.send(JSON.stringify(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.fireClose();
      return;
    }
    if (this.socket.readyState !== WebSocket.CLOSING) this.socket.close(1000);
  }

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onclose?.();
  }
}
