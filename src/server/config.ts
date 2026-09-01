import { homedir } from "node:os";
import path from "node:path";

export interface Config {
  /** Fixed local port for the panel + WebSocket. 127.0.0.1 only (SPEC § 1). */
  port: number;
  /** Directory holding inkwire.db and the images/ dir. */
  dataDir: string;
  /** Root that canvas.bind_code refs are resolved against (SPEC § 8). */
  projectRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: env.INKWIRE_PORT ? Number(env.INKWIRE_PORT) : 4691,
    dataDir: env.INKWIRE_DATA_DIR ?? path.join(homedir(), ".inkwire"),
    projectRoot: env.INKWIRE_PROJECT_ROOT ?? process.cwd(),
  };
}
