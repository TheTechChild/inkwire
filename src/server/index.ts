#!/usr/bin/env node
// Inkwire entry: MCP over stdio + panel HTTP/WS on 127.0.0.1.
// stdout belongs to the MCP transport — every log goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Sessions } from "./session.js";
import { createHttpServer } from "./http.js";
import { PanelHub } from "./ws.js";
import { Screenshots } from "./screenshot.js";
import { buildMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const sessions = new Sessions(store);

  let screenshots: Screenshots;
  const http = createHttpServer({ store, sessions, screenshots: () => screenshots });
  const hub = new PanelHub(http, sessions);
  screenshots = new Screenshots(hub, store.imagesDir);

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
  console.error(
    `inkwire panel on http://127.0.0.1:${config.port}/  (data: ${config.dataDir}, project root: ${config.projectRoot})`,
  );

  const mcp = buildMcpServer({
    sessions,
    store,
    screenshots: () => screenshots,
    projectRoot: config.projectRoot,
    panelUrl: (boardId) => `http://127.0.0.1:${config.port}/?board=${boardId}`,
  });
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

async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: string };
    return body.name === "inkwire";
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("inkwire failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
