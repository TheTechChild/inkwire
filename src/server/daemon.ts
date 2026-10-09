#!/usr/bin/env node
// Inkwire daemon entry (ADR 0001, plan M4.4): one long-lived process owns the
// database, every open board and the panel port. Each Claude Code session
// reaches it through a relay (src/link/relay.ts) over the /mcp link: one
// McpServer per link, one Client per Claude Code pid. No stdio transport.
// The daemon writes nothing to stdout; its logs go to stderr (daemon.log when
// a relay starts it).
import { createServer, type Server } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { openCore, type Core } from "./bootstrap.js";
import { buildMcpServer } from "./mcp.js";
import { readBuildInfo, isNewerBuild, type BuildInfo } from "./build-info.js";
import { IdleTimer } from "./idle.js";
import { createRestart } from "./restart.js";
import { checkBrowserRequest } from "./origin.js";
import { createLinkEndpoint, type Link, type LinkEndpoint } from "../link/endpoint.js";
import { probeHealth } from "../link/probe.js";

export interface LinkHost {
  /** Make (or fill) the Client of the hello's pid and connect a new McpServer to the link. */
  accept(link: Link): Promise<void>;
  count(): number;
}

/**
 * The daemon side of each link (M4.4 e). A hook that came first made the
 * Client; the hello fills it. Two links with one pid share one Client
 * (Decision 11); the last close removes it, which releases its authorship
 * (reason disconnect) and its pending session_send. A reconnect hello with
 * current_board restores the current board only (M4.7).
 */
export function createLinkHost(core: Pick<Core, "clients" | "mcpDeps">, build: BuildInfo, onCount: (n: number) => void = () => {}): LinkHost {
  const { clients } = core;
  let seq = 0;
  let open = 0;
  return {
    count: () => open,
    async accept(link) {
      const h = link.hello;
      const linkId = `link-${++seq}`;
      const client = clients.ensure(h.pid, {
        sessionId: h.session_id,
        cwd: h.cwd,
        build: h.build,
        termProgram: h.term_program ?? null,
      });
      clients.attach(h.pid, linkId);
      open++;
      onCount(open);
      // A second link of a live Client keeps that Client's current board.
      if (h.current_board && client.currentBoardId === null) clients.restoreCurrentBoard(client, h.current_board);
      if (isNewerBuild(h.build, build)) clients.markStale(h.build, client);
      const mcp = buildMcpServer({ ...core.mcpDeps, client, cwd: () => client.cwd || h.cwd });
      void link.closed.then(async () => {
        open--;
        try {
          await mcp.close();
        } catch {
          // the link is gone already
        }
        const removed = clients.detach(h.pid, linkId);
        // remove() released a talking Author with mode_off; this is the backstop.
        if (removed?.pending) clients.resolvePending(removed, { status: "idle" });
        onCount(open);
      });
      await mcp.connect(link.transport);
    },
  };
}

export interface DaemonOptions {
  config: Config;
  /** Default: read from buildFile one time here (Decision 10). */
  build?: BuildInfo;
  /** The build file to read at boot when build is not given. Default dist/build.json. */
  buildFile?: string;
  /** Default process.exit. Tests pass their own. */
  exit?: (code: number) => void;
}

export interface Daemon {
  port: number;
  http: Server;
  core: Core;
  endpoint: LinkEndpoint;
  host: LinkHost;
  idle: IdleTimer;
  build: BuildInfo;
  restart: () => void;
  shutdown: (why: string) => void;
}

/**
 * Bind first, then open the store (M4.4 a, b): the loser of an autostart race
 * never runs migrations on the shared DB. Resolves null when another process
 * owns the port (exit was called).
 */
export function startDaemon(opts: DaemonOptions): Promise<Daemon | null> {
  const { config } = opts;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const build = opts.build ?? readBuildInfo(opts.buildFile);
  const http = createServer();

  const boot = (): Daemon => {
    const addr = http.address();
    const port = addr && typeof addr === "object" ? addr.port : config.port;
    const endpoint = createLinkEndpoint({ verify: (req) => checkBrowserRequest(req) });
    let restart: () => void = () => {};
    const core = openCore(config, http, {
      build,
      restart: () => restart(),
      upgrades: { "/mcp": (req, socket, head) => endpoint.handleUpgrade(req, socket, head) },
    });

    let stopping = false;
    const close = () => {
      core.store.close();
      http.closeAllConnections();
    };
    const shutdown = (why: string) => {
      if (stopping) return;
      stopping = true;
      console.error(`inkwire daemon stops (${why})`);
      try {
        core.sessions.persistAll();
      } catch (err) {
        console.error("flush failed:", err);
      }
      http.close();
      endpoint.closeAll(1001, "inkwire daemon stops");
      try {
        close();
      } catch (err) {
        console.error("close failed:", err);
      }
      exit(0);
    };
    restart = createRestart({
      persistAll: () => core.sessions.persistAll(),
      stopListening: () => {
        stopping = true;
        http.close();
      },
      closeLinks: () => endpoint.closeAll(),
      linkCount: () => endpoint.count(),
      close,
      exit,
    });

    const idle = new IdleTimer(config.idleGraceMs, () => shutdown("idle"));
    const host = createLinkHost(core, build, (n) => (n === 0 ? idle.arm() : idle.disarm()));
    endpoint.onLink((link) => {
      host.accept(link).catch((err) => console.error("link failed:", err instanceof Error ? err.message : err));
    });
    idle.boot();
    console.error(
      `inkwire daemon pid ${process.pid} build ${build.id} on http://127.0.0.1:${port}/  (data: ${config.dataDir}; idle grace ${config.idleGraceMs ?? "off"})`,
    );
    return { port, http, core, endpoint, host, idle, build, restart: () => restart(), shutdown };
  };

  return new Promise<Daemon | null>((resolve, reject) => {
    const onError = async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      // No store is open here: the loser never touches the shared DB.
      if (await probeHealth(config.port)) {
        console.error(`another inkwire daemon already owns port ${config.port}; this daemon exits`);
        exit(0);
      } else {
        console.error(`port ${config.port} is taken by another process; set INKWIRE_PORT to a free port`);
        exit(1);
      }
      resolve(null);
    };
    http.once("error", onError);
    http.listen(config.port, "127.0.0.1", () => {
      http.off("error", onError);
      http.on("error", (err) => console.error("http server error:", err.message));
      // Synchronous: the handler is attached before any request is read.
      try {
        resolve(boot());
      } catch (err) {
        reject(err);
      }
    });
  });
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  startDaemon({ config: loadConfig() })
    .then((daemon) => {
      if (!daemon) return;
      // No stdin close handler: a detached daemon has stdin set to ignore (M4.4 d).
      process.on("SIGINT", () => daemon.shutdown("SIGINT"));
      process.on("SIGTERM", () => daemon.shutdown("SIGTERM"));
    })
    .catch((err) => {
      console.error("inkwire daemon failed to start:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
