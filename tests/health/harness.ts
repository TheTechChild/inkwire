// The MCP health suite harness (plan M8): real relays over real stdio pipes,
// one real daemon that the first relay autostarts, a random port and a temp
// data dir. Each relay runs under its own `sh -c` wrapper, so each relay has
// its own parent pid: the daemon sees one Claude Code session per relay.
// Never port 4691 or 4692, never ~/.inkwire or ~/.inkwire-dev. stop() closes
// every relay and kills every daemon pid that the harness saw.
import path from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Health } from "../../plugin/src/link/probe.ts";
import type { ClientIntent, ServerMessage } from "../../plugin/src/shared/protocol.ts";
import { alive, health, killTree, root, testEnv, waitFor } from "../integration/daemon-helpers.ts";

export interface RelayOptions {
  port: number;
  dataDir: string;
  /** INKWIRE_IDLE_GRACE_MS of the relay env, which an autostarted daemon inherits. */
  graceMs: number | "off";
  /** Run the relay from this repo copy (a copy with other source, so another build id). Default: this repo. */
  repo?: string;
  /** The cwd of the relay: the project of the session. Default: the repo. */
  cwd?: string;
  /** More env for the relay, set after testEnv (for example CLAUDE_CODE_SESSION_ID for the mod, ADR 0004). */
  env?: NodeJS.ProcessEnv;
}

export interface Relay {
  client: Client;
  transport: StdioClientTransport;
  /** The Claude Code pid that the daemon sees: the pid of the `sh -c` wrapper (the relay's ppid). */
  pid: number;
  /** Errors that the SDK Client saw (for example "unknown message ID" or a line on stdout that is not JSON-RPC). */
  errors: Error[];
  stderr: () => string;
  close: () => Promise<void>;
}

export interface Panel {
  messages: ServerMessage[];
  send: (intent: ClientIntent) => void;
  /** The first message (already received or new) that matches. */
  waitFor: (match: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  close: () => void;
}

export interface Relays {
  relays: Relay[];
  /** The daemon pid from /healthz after the relays connected. */
  daemonPid: number;
  port: number;
  dataDir: string;
  health: () => Promise<Health | null>;
  /** Start one more relay on the same port and data dir. */
  add: (opts?: Partial<RelayOptions>) => Promise<Relay>;
  panel: (boardId: string) => Promise<Panel>;
  /** Remember a daemon pid, so stop() kills it. */
  track: (pid: number) => void;
  /**
   * Close the relays, then wait for each daemon to exit (the idle grace stops it).
   * After waitMs, kill what is left. True when every daemon exited by itself.
   */
  stop: (waitMs?: number) => Promise<boolean>;
}

/** The relay entry of a repo, as the plugin manifest runs it: `sh <plugin root>/src/link/relay.sh`, which runs relay.ts with Node 26. */
export const relayEntry = (repo: string) => path.join(repo, "plugin", "src", "link", "relay.sh");

/** The TERM_PROGRAM of every health relay: not in focusTerminal's table, so it activates no app. */
export const HEALTH_TERM_PROGRAM = "inkwire-health";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Start one relay under `sh -c 'sh relay.sh; :'`. The `; :` keeps sh in the
 * foreground, so the relay's ppid stays: relay.sh runs node with exec. The node
 * of the test comes first on PATH.
 */
export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const repo = opts.repo ?? root;
  const cwd = opts.cwd ?? repo;
  const env = { ...testEnv(opts.port, opts.dataDir, { INKWIRE_IDLE_GRACE_MS: String(opts.graceMs) }), ...opts.env };
  // A TERM_PROGRAM that focusTerminal does not map: the hello carries term_program
  // (Open question 3), and session_mode(off) brings no terminal to the front.
  env.TERM_PROGRAM = HEALTH_TERM_PROGRAM;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  const transport = new StdioClientTransport({
    command: "/bin/sh",
    args: ["-c", `sh ${quote(relayEntry(repo))}; :`],
    cwd,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (c) => (err += String(c)));
  const client = new Client({ name: "inkwire-health", version: "0.0.0" });
  const errors: Error[] = [];
  client.onerror = (e) => errors.push(e);
  try {
    await client.connect(transport);
  } catch (e) {
    // The SDK says only "Connection closed": name the relay's own reason (its stderr).
    if (transport.pid) killTree(transport.pid);
    throw new Error(`relay failed to start: ${(e as Error).message}\nrelay stderr:\n${err || "(empty)"}`);
  }
  const pid = transport.pid;
  if (!pid) throw new Error("relay wrapper has no pid");
  const close = async () => {
    await client.close().catch(() => {});
    killTree(pid);
  };
  return { client, transport, pid, errors, stderr: () => err, close };
}

/** Open a panel WebSocket on a board and keep every message. */
export function openPanel(port: number, boardId: string): Promise<Panel> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${encodeURIComponent(boardId)}`);
    const messages: ServerMessage[] = [];
    const waiters = new Set<() => void>();
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)) as ServerMessage);
      for (const w of [...waiters]) w();
    });
    const panel: Panel = {
      messages,
      send: (intent) => socket.send(JSON.stringify(intent)),
      waitFor: (match, timeoutMs = 5000) =>
        new Promise((res, rej) => {
          let from = 0;
          const check = () => {
            for (; from < messages.length; from++) {
              const m = messages[from]!;
              if (match(m)) {
                waiters.delete(check);
                clearTimeout(timer);
                res(m);
                return;
              }
            }
          };
          const timer = setTimeout(() => {
            waiters.delete(check);
            rej(new Error("panel: no matching message in time"));
          }, timeoutMs);
          waiters.add(check);
          check();
        }),
      close: () => socket.terminate(),
    };
    socket.once("open", () => resolve(panel));
    socket.once("error", reject);
  });
}

/** Spawn n relays at the same time on one port: the first autostart wins and every relay uses one daemon. */
export async function startRelays(n: number, opts: RelayOptions): Promise<Relays> {
  const seen = new Set<number>();
  const relays: Relay[] = [];
  const panels: Panel[] = [];
  const base = opts;
  const stopAll = async (waitMs = 5000): Promise<boolean> => {
    for (const p of panels) p.close();
    for (const r of relays) await r.close();
    const h = await health(base.port);
    if (h) seen.add(h.pid);
    let clean = true;
    for (const pid of seen) {
      try {
        await waitFor(() => !alive(pid), waitMs);
      } catch {
        clean = false;
        killTree(pid);
      }
    }
    return clean;
  };
  try {
    const started = await Promise.allSettled(Array.from({ length: n }, () => startRelay(opts)));
    for (const s of started) if (s.status === "fulfilled") relays.push(s.value);
    const failed = started.find((s) => s.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    // The link opens when the relay starts; wait until the daemon counts every Client.
    const h = await waitFor(async () => {
      const x = await health(opts.port);
      return x && x.clients >= n ? x : null;
    }, 15_000);
    seen.add(h.pid);
    return {
      relays,
      daemonPid: h.pid,
      port: opts.port,
      dataDir: opts.dataDir,
      health: async () => {
        const x = await health(opts.port);
        if (x) seen.add(x.pid);
        return x;
      },
      add: async (more = {}) => {
        const r = await startRelay({ ...opts, ...more });
        relays.push(r);
        return r;
      },
      panel: async (boardId) => {
        const p = await openPanel(opts.port, boardId);
        panels.push(p);
        return p;
      },
      track: (pid) => seen.add(pid),
      stop: stopAll,
    };
  } catch (err) {
    await stopAll(0);
    throw err;
  }
}
