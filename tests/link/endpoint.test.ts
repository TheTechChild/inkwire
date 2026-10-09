// The /mcp link endpoint (plan M4.3): a real http server on port 0 with
// routeUpgrades, a trivial McpServer per link, and an SDK Client over the
// link client transport.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { routeUpgrades } from "../../src/server/upgrade.js";
import { createLinkEndpoint, type Link, type LinkEndpoint } from "../../src/link/endpoint.js";
import { connectLink } from "../../src/link/ws-client.js";
import { LINK_VERSION, type Hello } from "../../src/link/hello.js";

let http: Server;
let endpoint: LinkEndpoint;
let port: number;
let links: Link[];

const hello = (pid = 101): Hello => ({
  type: "hello",
  v: LINK_VERSION,
  pid,
  session_id: "s-1",
  cwd: "/work/repo",
  build: { id: "test", built_at: null },
});

beforeEach(async () => {
  links = [];
  http = createServer();
  endpoint = createLinkEndpoint({ helloTimeoutMs: 300 });
  endpoint.onLink((link) => {
    links.push(link);
    const mcp = new McpServer({ name: "trivial", version: "0.0.0" });
    mcp.registerTool("echo", { description: "echo" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    void mcp.connect(link.transport);
  });
  routeUpgrades(http, { "/mcp": (req, socket, head) => endpoint.handleUpgrade(req, socket, head) });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  port = (http.address() as AddressInfo).port;
});

afterEach(async () => {
  endpoint.closeAll(1001, "test end");
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
});

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.on("close", (code) => resolve(code)));
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("link endpoint", () => {
  it("a hello then initialize and tools/list reach the McpServer", async () => {
    const transport = await connectLink(`ws://127.0.0.1:${port}/mcp`, hello());
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(links[0]!.hello.pid).toBe(101);
    expect(links[0]!.hello.cwd).toBe("/work/repo");
    expect(endpoint.count()).toBe(1);
    await client.close();
  });

  it("no hello closes with 4400", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    const code = closeCode(socket);
    expect(await code).toBe(4400);
    expect(links).toHaveLength(0);
  });

  it("a first frame that is not a hello closes with 4400", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    const code = closeCode(socket);
    socket.on("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })));
    expect(await code).toBe(4400);
  });

  it("a wrong link version closes with 4426", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    const code = closeCode(socket);
    let reason = "";
    socket.on("close", (_c, r) => (reason = String(r)));
    socket.on("open", () => socket.send(JSON.stringify({ ...hello(), v: 99 })));
    expect(await code).toBe(4426);
    expect(reason).toContain("link version mismatch");
  });

  it("a message in the same tick as the hello is not lost", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    const reply = new Promise<any>((resolve) => socket.on("message", (raw) => resolve(JSON.parse(String(raw)))));
    socket.on("open", () => {
      socket.send(JSON.stringify(hello()));
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        }),
      );
    });
    const msg = await reply;
    expect(msg.id).toBe(1);
    expect(msg.result.serverInfo.name).toBe("trivial");
    socket.close();
  });

  it("a client close fires closed and lowers count()", async () => {
    const transport = await connectLink(`ws://127.0.0.1:${port}/mcp`, hello(202));
    await waitFor(() => endpoint.count() === 1);
    let closed = false;
    void links[0]!.closed.then(() => (closed = true));
    await transport.close();
    await waitFor(() => closed);
    expect(endpoint.count()).toBe(0);
  });
});
