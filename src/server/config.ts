import { homedir } from "node:os";
import path from "node:path";

export interface Config {
  /** Fixed local port for the panel + WebSocket. 127.0.0.1 only (SPEC § 1). */
  port: number;
  /** Directory holding inkwire.db and the images/ dir. */
  dataDir: string;
  /**
   * The daemon stops this long after its last link closes (ADR 0001).
   * INKWIRE_IDLE_GRACE_MS, default 30000; `off` (null) turns the idle stop off.
   */
  idleGraceMs: number | null;
}

export const DEFAULT_IDLE_GRACE_MS = 30_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: env.INKWIRE_PORT ? Number(env.INKWIRE_PORT) : 4691,
    dataDir: env.INKWIRE_DATA_DIR ?? path.join(homedir(), ".inkwire"),
    idleGraceMs: parseIdleGrace(env.INKWIRE_IDLE_GRACE_MS),
  };
}

function parseIdleGrace(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_GRACE_MS;
  if (raw.trim().toLowerCase() === "off") return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_GRACE_MS;
}
