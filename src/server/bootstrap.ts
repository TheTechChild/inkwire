// The daemon's bootstrap (daemon.ts): open the store, Sessions, Clients, the
// panel hub and the screenshot broker, and attach the HTTP handler and the
// upgrade router to an http server. All of it is synchronous (better-sqlite3),
// so the daemon can call it in its listen callback and no request arrives
// before the handler.
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Sessions } from "./session.js";
import { Clients } from "./clients.js";
import { requestHandler, type HealthStats } from "./http.js";
import { PanelHub } from "./ws.js";
import { Screenshots } from "./screenshot.js";
import { routeUpgrades, type UpgradeHandler } from "./upgrade.js";
import type { BuildInfo } from "./build-info.js";
import type { McpDeps } from "./mcp.js";

export interface CoreOptions {
  /** The daemon's build (Decision 10). */
  build: BuildInfo;
  stats?: () => HealthStats;
  restart?: () => void;
  /** More upgrade routes than /ws (the daemon adds /mcp). */
  upgrades?: Record<string, UpgradeHandler>;
}

export interface Core {
  store: Store;
  sessions: Sessions;
  clients: Clients;
  hub: PanelHub;
  screenshots: Screenshots;
  pluginRoot: string;
  /** The McpDeps that every Client shares; the caller adds `client` and `cwd`. */
  mcpDeps: Omit<McpDeps, "client" | "cwd">;
}

export const pluginRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/**
 * Open the store and the in-memory state, and attach the request handler and
 * the upgrade routes to `http`. The port for the panel URL is read from the
 * server once it listens (port 0 in tests), else from the config.
 */
export function openCore(config: Config, http: Server, opts: CoreOptions): Core {
  const store = new Store(config.dataDir);
  const sessions = new Sessions(store);
  const clients = new Clients(sessions);
  let screenshots: Screenshots;
  http.on(
    "request",
    requestHandler({
      store,
      sessions,
      clients,
      screenshots: () => screenshots,
      build: opts.build,
      stats: opts.stats,
      restart: opts.restart,
    }),
  );
  const hub = new PanelHub(sessions, clients, { pluginRoot, build: opts.build, restart: opts.restart });
  screenshots = new Screenshots(hub, store.imagesDir);
  routeUpgrades(http, { "/ws": (req, socket, head) => hub.handleUpgrade(req, socket, head), ...opts.upgrades });
  const port = () => {
    const addr = http.address();
    return addr && typeof addr === "object" ? addr.port : config.port;
  };
  return {
    store,
    sessions,
    clients,
    hub,
    screenshots,
    pluginRoot,
    mcpDeps: {
      sessions,
      clients,
      store,
      screenshots: () => screenshots,
      pluginRoot,
      panelUrl: (boardId) => `http://127.0.0.1:${port()}/?board=${boardId}`,
    },
  };
}
