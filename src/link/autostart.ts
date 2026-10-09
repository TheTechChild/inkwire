// Find or start the daemon (ADR 0001, plan M4.6). Probe /healthz; when no
// inkwire answers, spawn a detached daemon that logs to <dataDir>/daemon.log,
// then poll. A racing second daemon exits 0 (it loses the port before it opens
// the store), and every relay uses the winner.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeDaemon, type Health } from "./probe.js";

export interface AutostartConfig {
  port: number;
  dataDir: string;
  /** The daemon's env. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** The poll limit. Default 10 s. */
  timeoutMs?: number;
}

/** A state of the port that no retry can fix: the relay stops. */
export class DaemonUnavailable extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

/** The daemon entry next to this file's dir: src under tsx, dist under node. */
export function daemonEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL("../server/daemon" + path.extname(self), import.meta.url));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureDaemon(config: AutostartConfig): Promise<Health> {
  const { port } = config;
  const first = await probeDaemon(port);
  if (first.state === "daemon") return first.health;
  if (first.state === "old") throw oldServer(port);
  if (first.state === "foreign") throw foreign(port);

  mkdirSync(config.dataDir, { recursive: true });
  const logFile = path.join(config.dataDir, "daemon.log");
  const log = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, daemonEntry()], {
      detached: true,
      // The repo (or plugin) dir: `--import tsx` under tests resolves from here.
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdio: ["ignore", log, log],
      env: { ...(config.env ?? process.env), INKWIRE_PORT: String(port), INKWIRE_DATA_DIR: config.dataDir },
    });
    child.on("error", (err) => console.error(`inkwire relay: daemon spawn failed: ${err.message}`));
    child.unref();
  } finally {
    closeSync(log);
  }

  const deadline = Date.now() + (config.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    await sleep(100);
    const p = await probeDaemon(port);
    if (p.state === "daemon") return p.health;
    if (p.state === "old") throw oldServer(port);
    if (p.state === "foreign") throw foreign(port);
  }
  throw new DaemonUnavailable(`inkwire daemon did not start on port ${port} in time; see ${logFile}`, false);
}

const oldServer = (port: number) =>
  new DaemonUnavailable(`port ${port} is held by an old inkwire server; close the old Claude Code sessions`, true);

const foreign = (port: number) =>
  new DaemonUnavailable(`port ${port} is taken by another process; set INKWIRE_PORT to a free port`, true);
