// Find or start the daemon (ADR 0001, plan M4.6). Probe /healthz; when no
// inkwire answers, spawn a detached daemon that logs to <dataDir>/daemon.log,
// then poll. A racing second daemon exits 0 (it loses the port before it opens
// the store), and every relay uses the winner. The daemon that starts is the
// newest registered build whose daemon entry is still on disk (the build
// registry, build-info.ts), not always the relay's own: an old session that
// starts the daemon after an update starts the new build.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeDaemon, type Health } from "./probe.ts";
import { daemonEntryOf, liveBuilds, readRegistry } from "../server/build-info.ts";

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
  readonly fatal: boolean;

  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

/** This relay's plugin root (plugin/). */
const OWN_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/** The daemon entry of this relay's copy: plugin/src/server/daemon.ts, which Node runs from the source. */
export function daemonEntry(): string {
  return daemonEntryOf(OWN_ROOT);
}

/**
 * The plugin root whose daemon a relay starts: the newest build in the data
 * dir's registry whose daemon entry is still on disk, else the relay's own.
 */
export function pickDaemonRoot(dataDir: string, ownRoot: string = OWN_ROOT, exists?: (file: string) => boolean): string {
  return liveBuilds(readRegistry(dataDir), exists)[0]?.entry.root ?? ownRoot;
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
  const daemonRoot = pickDaemonRoot(config.dataDir);
  try {
    const child = spawn(process.execPath, [...process.execArgv, daemonEntryOf(daemonRoot)], {
      detached: true,
      // The plugin root of that build, not the cwd of the session.
      cwd: daemonRoot,
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
