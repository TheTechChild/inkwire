// The relay as Claude Code runs it (plan M4.6, M4.7): a spawned
// `node --import tsx src/link/relay.ts` over real stdio pipes, which
// autostarts a detached daemon on a random port with a temp dir.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  alive,
  body,
  freePort,
  head,
  health,
  killTree,
  rawRequest,
  root,
  tempDir,
  testEnv,
  waitFor,
  type ToolResult,
} from "../integration/daemon-helpers.js";

const RELAY = ["--import", "tsx", "src/link/relay.ts"];

interface Relay {
  client: Client;
  transport: StdioClientTransport;
  errors: Error[];
  stderr: () => string;
}

/**
 * Start a relay with an SDK Client on its stdio. wrap: run it under `sh -c 'node …; :'`, so each
 * relay has its own parent pid (its Claude Code pid). The `; :` keeps sh in the foreground.
 */
async function startRelay(port: number, dataDir: string, wrap = false): Promise<Relay> {
  const transport = new StdioClientTransport({
    command: wrap ? "/bin/sh" : process.execPath,
    args: wrap ? ["-c", `"${process.execPath}" ${RELAY.join(" ")}; :`] : RELAY,
    cwd: root,
    env: testEnv(port, dataDir, { INKWIRE_IDLE_GRACE_MS: "300" }) as Record<string, string>,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (c) => (err += String(c)));
  const client = new Client({ name: "relay-test", version: "0.0.0" });
  const errors: Error[] = [];
  client.onerror = (e) => errors.push(e);
  await client.connect(transport);
  return { client, transport, errors, stderr: () => err };
}

async function stopRelay(r: Relay | null): Promise<void> {
  if (!r) return;
  const pid = r.transport.pid ?? undefined;
  await r.client.close().catch(() => {});
  killTree(pid);
}

/** Kill the daemon on the port, if any, and every pid the test saw. */
async function killDaemons(port: number, seen: Set<number>): Promise<void> {
  const h = await health(port);
  if (h) seen.add(h.pid);
  for (const pid of seen) killTree(pid);
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await c.callTool({ name, arguments: args })) as ToolResult;
}

describe("relay (spawned)", () => {
  it("autostarts a daemon, works, and the daemon stops after the last relay closes", async () => {
    const port = await freePort();
    const dataDir = tempDir("relay-auto");
    const seen = new Set<number>();
    let relay: Relay | null = null;
    try {
      expect(await health(port)).toBeNull();
      relay = await startRelay(port, dataDir);
      const tools = await relay.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(30);
      const created = await call(relay.client, "boards_create", { name: "auto", project_root: tempDir("relay-auto-root") });
      expect(created.isError, body(created)).toBeFalsy();
      expect(head(created)).toMatch(/^board b_[0-9a-f]+ "auto" · you: author/);
      expect(existsSync(path.join(dataDir, "daemon.log"))).toBe(true);
      const h = (await health(port))!;
      seen.add(h.pid);
      expect(h.build).toBeTruthy();
      // A line on stdout that is not JSON-RPC would show here as an error.
      expect(relay.errors).toEqual([]);
      await relay.client.close();
      // Idle grace 300 ms: /healthz stops within about 2 s.
      await new Promise((r) => setTimeout(r, 2500));
      expect(await health(port)).toBeNull();
      await waitFor(async () => !alive(h.pid), 3000);
    } finally {
      await stopRelay(relay);
      await killDaemons(port, seen);
    }
  }, 30_000);

  it("race: two relays on a fresh port use one daemon", async () => {
    const port = await freePort();
    const dataDir = tempDir("relay-race");
    const seen = new Set<number>();
    const relays: Relay[] = [];
    try {
      const started = await Promise.all([startRelay(port, dataDir, true), startRelay(port, dataDir, true)]);
      relays.push(...started);
      const lists = await Promise.all(started.map((r) => r.client.listTools()));
      for (const l of lists) expect(l.tools.length).toBeGreaterThan(30);
      const h1 = (await waitFor(async () => {
        const h = await health(port);
        return h && h.clients === 2 ? h : null;
      }, 5000))!;
      seen.add(h1.pid);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const h = (await health(port))!;
        seen.add(h.pid);
        expect(h.pid).toBe(h1.pid);
        expect(h.clients).toBe(2);
      }
    } finally {
      for (const r of relays) await stopRelay(r);
      await killDaemons(port, seen);
    }
  }, 30_000);

  it("reconnect: after a SIGKILL of the daemon, calls go to a new daemon and the current board is kept", async () => {
    const port = await freePort();
    const dataDir = tempDir("relay-reconnect");
    const seen = new Set<number>();
    let relay: Relay | null = null;
    try {
      relay = await startRelay(port, dataDir);
      const created = await call(relay.client, "boards_create", { name: "kept board", project_root: tempDir("relay-reconnect-root") });
      const id = JSON.parse(body(created)).board_id as string;
      const before = (await health(port))!;
      seen.add(before.pid);
      process.kill(before.pid, "SIGKILL");
      await waitFor(async () => !alive(before.pid), 3000);

      const tools = await relay.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(30);
      const after = (await health(port))!;
      seen.add(after.pid);
      expect(after.pid).not.toBe(before.pid);

      const state = await call(relay.client, "canvas_get_state");
      expect(state.isError, body(state)).toBeFalsy();
      expect(head(state)).toMatch(new RegExp(`^board ${id} "kept board" · you: reader`));
      expect(head(state)).toContain(`The connection to the daemon was restored. Your current board is still ${id}.`);
      const write = await call(relay.client, "canvas_add_node", { label: "again", kind: "service", at: [0, 0] });
      expect(write.isError, body(write)).toBeFalsy();
      expect(head(write)).toMatch(new RegExp(`^board ${id} "kept board" · you: author`));
      expect(relay.errors.map((e) => e.message).join("\n")).not.toContain("unknown message ID");
    } finally {
      await stopRelay(relay);
      await killDaemons(port, seen);
    }
  }, 40_000);

  it("restart: a relay survives a restart with no error to the client", async () => {
    const port = await freePort();
    const dataDir = tempDir("relay-restart");
    const seen = new Set<number>();
    let relay: Relay | null = null;
    try {
      relay = await startRelay(port, dataDir);
      await relay.client.listTools();
      const before = (await health(port))!;
      seen.add(before.pid);
      const res = await rawRequest(port, "POST", "/api/daemon/restart");
      expect(res.status).toBe(202);
      await waitFor(async () => !alive(before.pid), 5000);
      const tools = await relay.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(30);
      const after = (await health(port))!;
      seen.add(after.pid);
      expect(after.pid).not.toBe(before.pid);
      expect(relay.errors).toEqual([]);
    } finally {
      await stopRelay(relay);
      await killDaemons(port, seen);
    }
  }, 40_000);

  async function relayExit(port: number, dataDir: string): Promise<{ code: number | null; stderr: string; ms: number }> {
    const started = Date.now();
    const child = spawn(process.execPath, RELAY, {
      cwd: root,
      env: testEnv(port, dataDir, { INKWIRE_IDLE_GRACE_MS: "300" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stderr = "";
      child.stderr!.on("data", (c) => (stderr += String(c)));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      return { code, stderr, ms: Date.now() - started };
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("a port held by a non-inkwire server makes the relay exit 1 with the reason", async () => {
    const port = await freePort();
    const plain = createServer((_req, res) => {
      res.writeHead(404);
      res.end("not here");
    });
    await new Promise<void>((r) => plain.listen(port, "127.0.0.1", () => r()));
    try {
      const r = await relayExit(port, tempDir("relay-foreign"));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`port ${port} is taken by another process`);
    } finally {
      plain.closeAllConnections();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  }, 20_000);

  it("a daemon of another link version (close 4426) makes the relay exit 1 with the reason, after one link", async () => {
    const port = await freePort();
    let links = 0;
    const stub = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "inkwire", pid: 1, build: { id: "other", built_at: null }, clients: 0, boards: 0 }));
    });
    const wss = new WebSocketServer({ server: stub, path: "/mcp" });
    wss.on("connection", (socket) => {
      links++;
      socket.once("message", () => socket.close(4426, "link version mismatch: run yarn daemon:restart"));
    });
    await new Promise<void>((r) => stub.listen(port, "127.0.0.1", () => r()));
    try {
      const r = await relayExit(port, tempDir("relay-version"));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("link version mismatch: run yarn daemon:restart");
      expect(r.stderr).not.toContain("link restored");
      expect(links).toBe(1);
    } finally {
      for (const c of wss.clients) c.terminate();
      wss.close();
      stub.closeAllConnections();
      await new Promise<void>((r) => stub.close(() => r()));
    }
  }, 20_000);

  it("an old inkwire server (healthz with no build) makes the relay exit 1 at once, with no reconnect", async () => {
    const port = await freePort();
    const stub = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "inkwire" }));
    });
    await new Promise<void>((r) => stub.listen(port, "127.0.0.1", () => r()));
    const dataDir = tempDir("relay-old");
    try {
      const r = await relayExit(port, dataDir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`port ${port} is held by an old inkwire server; close the old Claude Code sessions`);
      expect(r.stderr).not.toContain("connects again");
      expect(existsSync(path.join(dataDir, "daemon.log"))).toBe(false);
    } finally {
      stub.closeAllConnections();
      await new Promise<void>((r) => stub.close(() => r()));
    }
  }, 20_000);
});
