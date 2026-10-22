// The daemon's bootstrap (daemon.ts): open the store, Sessions, Clients, the
// panel hub and the screenshot broker, and attach the HTTP handler and the
// upgrade router to an http server. All of it is synchronous (better-sqlite3),
// so the daemon can call it in its listen callback and no request arrives
// before the handler.
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { Store } from "./store.ts";
import { Sessions } from "./session.ts";
import { Clients } from "./clients.ts";
import { requestHandler, type HealthStats } from "./http.ts";
import { PanelHub } from "./ws.ts";
import { Screenshots } from "./screenshot.ts";
import { routeUpgrades, type UpgradeHandler } from "./upgrade.ts";
import type { BuildInfo } from "./build-info.ts";
import type { McpDeps } from "./mcp.ts";
import type { UiFiles } from "./ui-bundle.ts";
import { installFonts } from "./rasterize.ts";

export interface CoreOptions {
  /** The daemon's build (Decision 10). */
  build: BuildInfo;
  stats?: () => HealthStats;
  /** The panel files (the daemon's in-memory bundle). Default: this copy's bundle (ui-bundle.ts). */
  ui?: () => Promise<UiFiles>;
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
  let hub: PanelHub;
  http.on(
    "request",
    requestHandler({
      store,
      sessions,
      clients,
      screenshots: () => screenshots,
      build: opts.build,
      stats: opts.stats,
      ui: opts.ui,
      restart: opts.restart,
      // The mod's routes (ADR 0004) read the push fields and apply intents through the hub.
      hub: () => hub,
    }),
  );
  hub = new PanelHub(sessions, clients, { pluginRoot, build: opts.build, restart: opts.restart });
  // The fonts go to the data dir now, at boot: Claude Code can remove this plugin folder after an update.
  screenshots = new Screenshots(hub, store.imagesDir, installFonts(config.dataDir));
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
