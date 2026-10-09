// Shared helpers for the daemon and relay tests. Every test gets a random
// port (never 4691 or 4692) and a temp data dir (never ~/.inkwire or
// ~/.inkwire-dev). Every spawned process must be killed in a finally block.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectLink } from "../../src/link/ws-client.js";
import { LINK_VERSION, type Hello } from "../../src/link/hello.js";
import type { Health } from "../../src/link/probe.js";

export const root = fileURLToPath(new URL("../..", import.meta.url));

const RESERVED = new Set([4691, 4692]);

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    if (!RESERVED.has(port)) return port;
  }
}

export const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), `inkwire-${prefix}-`));

/** The env of a spawned daemon or relay: the test port and dir, never the person's. */
export function testEnv(port: number, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, INKWIRE_PORT: String(port), INKWIRE_DATA_DIR: dataDir, ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

export interface Spawned {
  child: ChildProcess;
  stderr: () => string;
  /** Everything the daemon wrote to stdout. It must stay empty (M4.4 f). */
  stdout: () => string;
  exited: Promise<number | null>;
}

export function spawnDaemon(port: number, dataDir: string, extra: NodeJS.ProcessEnv = {}): Spawned {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/daemon.ts"], {
    cwd: root,
    env: testEnv(port, dataDir, extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  let out = "";
  child.stderr!.on("data", (c) => (err += String(c)));
  child.stdout!.on("data", (c) => (out += String(c)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, stderr: () => err, stdout: () => out, exited };
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body.name === "inkwire" ? body : null;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a pid and its children (a `sh -c` wrapper and the relay under it). */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid) return;
  let kids: number[] = [];
  try {
    kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    // no children
  }
  for (const k of kids) killTree(k, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // gone already
  }
}

export function hello(pid: number, extra: Partial<Hello> = {}): Hello {
  return {
    type: "hello",
    v: LINK_VERSION,
    pid,
    session_id: `s-${pid}`,
    cwd: `/work/pid-${pid}`,
    build: { id: "test-build", built_at: null },
    ...extra,
  };
}

export interface LinkClient {
  client: Client;
  close: () => Promise<void>;
  closed: Promise<void>;
}

/** An SDK Client over a raw link (no relay): it acts as the Claude Code session of `pid`. */
export async function linkClient(port: number, pid: number, extra: Partial<Hello> = {}): Promise<LinkClient> {
  const transport = await connectLink(`ws://127.0.0.1:${port}/mcp`, hello(pid, extra));
  const closed = new Promise<void>((resolve) => transport.socket.once("close", () => resolve()));
  const client = new Client({ name: `test-${pid}`, version: "0.0.0" });
  await client.connect(transport);
  return { client, closed, close: () => client.close() };
}

export type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

export async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await c.callTool({ name, arguments: args })) as ToolResult;
}

/** The first text block: the context line, then the notices. */
export const head = (r: ToolResult) => r.content[0]?.text ?? "";
/** The body after the head block. */
export const body = (r: ToolResult) => r.content[1]?.text ?? "";

/** An HTTP request with headers that fetch cannot set (Host, Origin). */
export function rawRequest(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  data = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += String(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** POST a hook event as hooks/forward.sh does (no Origin). */
export function postHook(port: number, pid: number, event: Record<string, unknown>, bg = "0") {
  return rawRequest(port, "POST", `/api/hook?bg=${bg}&pid=${pid}`, { "content-type": "application/json" }, JSON.stringify(event));
}
