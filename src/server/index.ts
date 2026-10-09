#!/usr/bin/env node
// Inkwire stdio entry: MCP over stdio + panel HTTP/WS on 127.0.0.1. The plugin
// runs this entry until the cut-over (M7); the daemon entry is daemon.ts.
// stdout belongs to the MCP transport — every log goes to stderr.
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { openCore } from "./bootstrap.js";
import { buildMcpServer } from "./mcp.js";
import { probeHealth } from "../link/probe.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const http = createServer();
  const { store, sessions, clients, mcpDeps } = openCore(config, http);
  // Until the cut-over (M7), this stdio server speaks for one Client: the Claude
  // Code process that spawned it. Hooks from that pid route to it.
  const client = clients.ensure(process.ppid, {
    sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    cwd: process.cwd(),
    termProgram: process.env.TERM_PROGRAM ?? null,
  });
  clients.attach(client.pid, "stdio");

  await new Promise<void>((resolve, reject) => {
    http.once("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const other = await probeHealth(config.port);
        reject(
          new Error(
            other
              ? `another inkwire server already owns port ${config.port} — connect to that one instead of starting a second server against the same database`
              : `port ${config.port} is taken by another process — set INKWIRE_PORT to a free port`,
          ),
        );
      } else {
        reject(err);
      }
    });
    http.listen(config.port, "127.0.0.1", () => resolve());
  });
  console.error(`inkwire panel on http://127.0.0.1:${config.port}/  (data: ${config.dataDir})`);

  const mcp = buildMcpServer({ ...mcpDeps, client });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = (why: string) => {
    console.error(`inkwire shutting down (${why})`);
    try {
      sessions.persistAll();
      store.close();
    } catch (err) {
      console.error("flush failed:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}

main().catch((err) => {
  console.error("inkwire failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
