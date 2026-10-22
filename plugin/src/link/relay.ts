#!/usr/bin/env node
// Inkwire relay (ADR 0001, plan M4.6): the thin stdio process that Claude Code
// starts. It finds or starts the daemon, then pipes MCP between stdio and the
// /mcp link. stdout is the MCP transport: log to stderr only. The relay does
// not import the store, session.ts or better-sqlite3 (tests/link/boundary.test.ts).
import "./node-version.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../server/config.ts";
import { currentBuild, registerBuild } from "../server/build-info.ts";
import { LINK_VERSION, type Hello } from "./hello.ts";
import { connectLink } from "./ws-client.ts";
import { OWN_ROOT, ensureDaemon } from "./autostart.ts";
import { RelayCore } from "./relay-core.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  // Register this copy's build in the data dir with the Claude Code pid: a new
  // Claude Code process makes this build the newest (Decision 7).
  const build = currentBuild(config.dataDir, undefined, { pid: process.ppid });
  const env = process.env;
  const base: Hello = {
    type: "hello",
    v: LINK_VERSION,
    pid: process.ppid,
    session_id: env.CLAUDE_CODE_SESSION_ID ?? null,
    cwd: process.cwd(),
    build,
    ...(env.TERM_PROGRAM ? { term_program: env.TERM_PROGRAM } : {}),
  };

  // Exit 1 after stdout drains: the error answers to Claude Code must reach it first.
  const exitFailed = () => process.stdout.write("", () => process.exit(1));

  const core = new RelayCore(
    new StdioServerTransport(),
    async (extra) => {
      const health = await ensureDaemon({
        port: config.port,
        dataDir: config.dataDir,
        env,
        // Before an autostart, put a lost entry back with this relay's own time; the order does not change.
        register: () => {
          if (build.id !== "unbuilt") {
            registerBuild(config.dataDir, build.id, OWN_ROOT, { pid: process.ppid, touch: false, now: new Date(build.built_at ?? Date.now()) });
          }
        },
      });
      const transport = await connectLink(`ws://127.0.0.1:${config.port}/mcp`, { ...base, ...extra });
      return { transport, buildId: health.build.id, link: transport };
    },
    {
      // A link of another version (4426), a bad hello (4400), or an old inkwire
      // server or another process on the port after a reconnect: no loop.
      onFatal: (reason) => {
        console.error(`inkwire relay stops: ${reason}`);
        exitFailed();
      },
    },
  );

  const done = async (why: string) => {
    console.error(`inkwire relay stops (${why})`);
    await core.stop();
    process.exit(0);
  };
  // When stdin closes, close the link at once: the daemon then releases this session's authorship.
  process.stdin.on("end", () => void done("stdin closed"));
  process.stdin.on("close", () => void done("stdin closed"));
  process.on("SIGTERM", () => void done("SIGTERM"));
  process.on("SIGINT", () => void done("SIGINT"));

  try {
    await core.start();
  } catch (err) {
    // The first connect failed: an old inkwire server, another process on the port, or no daemon in time.
    console.error(`inkwire relay: ${err instanceof Error ? err.message : String(err)}`);
    exitFailed();
  }
}

main().catch((err) => {
  console.error("inkwire relay failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
