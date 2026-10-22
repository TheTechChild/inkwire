// Find or start the daemon (ADR 0001, plan M4.6). Probe /healthz; when no
// inkwire answers, spawn a detached daemon that logs to <dataDir>/daemon.log,
// then poll. A racing second daemon exits 0 (it loses the port before it opens
// the store), and every relay uses the winner. The daemon that starts is the
// newest registered build whose daemon entry is still on disk (the build
// registry, build-info.ts), not always the relay's own: an old session that
// starts the daemon after an update starts the new build. When that daemon
// exits with an error before it answers, the relay starts the next build in
// the order, and at the end its own.
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
  /** Called before the daemon root is chosen: the relay registers its build again, in case a registry write lost it. */
  register?: () => void;
  /** The relay's own plugin root, the last choice. Default this copy. */
  ownRoot?: string;
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
export const OWN_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/** The daemon entry of this relay's copy: plugin/src/server/daemon.ts, which Node runs from the source. */
export function daemonEntry(): string {
  return daemonEntryOf(OWN_ROOT);
}

/**
 * The plugin roots whose daemon a relay can start, in order: the builds in the
 * data dir's registry whose daemon entry is still on disk, newest first, then
 * the relay's own root. No root is in the list two times.
 */
export function daemonRoots(dataDir: string, ownRoot: string = OWN_ROOT, exists?: (file: string) => boolean): string[] {
  const roots = [...liveBuilds(readRegistry(dataDir), exists).map((b) => b.entry.root), ownRoot];
  return roots.filter((r, i) => roots.findIndex((x) => path.resolve(x) === path.resolve(r)) === i);
}

/** The plugin root whose daemon a relay starts first: the first of daemonRoots. */
export function pickDaemonRoot(dataDir: string, ownRoot: string = OWN_ROOT, exists?: (file: string) => boolean): string {
  return daemonRoots(dataDir, ownRoot, exists)[0]!;
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
  try {
    config.register?.();
  } catch (err) {
    console.error(`inkwire relay: cannot register the build: ${err instanceof Error ? err.message : String(err)}`);
  }
  const roots = daemonRoots(config.dataDir, config.ownRoot ?? OWN_ROOT);
  const deadline = Date.now() + (config.timeoutMs ?? 10_000);
  for (let i = 0; i < roots.length; i++) {
    const daemonRoot = roots[i]!;
    // A daemon that exits with an error (a build that cannot boot) sets run.failed.
    // Exit 0 is the loser of a port race: another daemon answers soon.
    const run: { failed: string | null } = { failed: null };
    const log = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [...process.execArgv, daemonEntryOf(daemonRoot)], {
        detached: true,
        // The plugin root of that build, not the cwd of the session.
        cwd: daemonRoot,
        stdio: ["ignore", log, log],
        env: { ...(config.env ?? process.env), INKWIRE_PORT: String(port), INKWIRE_DATA_DIR: config.dataDir },
      });
      child.on("error", (err) => {
        run.failed = `spawn failed: ${err.message}`;
        console.error(`inkwire relay: daemon spawn failed: ${err.message}`);
      });
      child.on("exit", (code, signal) => {
        if (code !== 0) run.failed = `exited with ${code ?? signal}`;
      });
      child.unref();
    } finally {
      closeSync(log);
    }

    while (Date.now() < deadline) {
      await sleep(100);
      const p = await probeDaemon(port);
      if (p.state === "daemon") return p.health;
      if (p.state === "old") throw oldServer(port);
      if (p.state === "foreign") throw foreign(port);
      if (run.failed !== null) break;
    }
    if (run.failed === null) break;
    const next = roots[i + 1];
    console.error(`inkwire relay: the daemon of ${daemonRoot} ${run.failed}${next ? `; the relay starts the daemon of ${next}` : ""}`);
  }
  throw new DaemonUnavailable(`inkwire daemon did not start on port ${port} in time; see ${logFile}`, false);
}

const oldServer = (port: number) =>
  new DaemonUnavailable(`port ${port} is held by an old inkwire server; close the old Claude Code sessions`, true);

const foreign = (port: number) =>
  new DaemonUnavailable(`port ${port} is taken by another process; set INKWIRE_PORT to a free port`, true);
