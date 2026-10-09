// The daemon over real links (plan M4.4): a spawned `node --import tsx
// src/server/daemon.ts` on a random port with a temp dir, and SDK Clients over
// raw links that act as Claude Code sessions with their own pids.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon, type Daemon } from "../../src/server/daemon.js";
import { STALE_NOTICE } from "../../src/server/clients.js";
import {
  alive,
  body,
  call,
  freePort,
  head,
  health,
  linkClient,
  postHook,
  rawRequest,
  spawnDaemon,
  tempDir,
  waitFor,
  type LinkClient,
  type Spawned,
} from "./daemon-helpers.js";

let port: number;
let dataDir: string;
let projectRoot: string;
let daemon: Spawned;
const open: LinkClient[] = [];

async function link(pid: number): Promise<LinkClient> {
  const l = await linkClient(port, pid);
  open.push(l);
  return l;
}

async function createBoard(l: LinkClient, name: string): Promise<string> {
  const r = await call(l.client, "boards_create", { name, project_root: projectRoot });
  expect(r.isError, body(r)).toBeFalsy();
  return JSON.parse(body(r)).board_id as string;
}

const clientsCount = async () => (await health(port))?.clients;

beforeAll(async () => {
  port = await freePort();
  dataDir = tempDir("daemon");
  projectRoot = tempDir("daemon-root");
  daemon = spawnDaemon(port, dataDir, { INKWIRE_IDLE_GRACE_MS: "off" });
  try {
    await waitFor(() => health(port), 15_000);
  } catch (err) {
    daemon.child.kill("SIGKILL");
    throw err;
  }
}, 20_000);

afterAll(async () => {
  for (const l of open) await l.close().catch(() => {});
  daemon.child.kill("SIGKILL");
});

describe("daemon", () => {
  it("two links with different pids both list tools and share boards; closing one leaves the other working", async () => {
    const a = await link(1001);
    const b = await link(1002);
    expect((await a.client.listTools()).tools.length).toBeGreaterThan(30);
    expect((await b.client.listTools()).tools.length).toBeGreaterThan(30);
    const id = await createBoard(a, "shared board");
    const listed = JSON.parse(body(await call(b.client, "boards_list", { all: true })));
    expect(listed.boards.map((x: { id: string }) => x.id)).toContain(id);
    await a.close();
    await a.closed;
    const again = await call(b.client, "boards_list", { all: true });
    expect(again.isError).toBeFalsy();
    await b.close();
  });

  it("A writes and claims, then closes: the board has no Author and B can claim it", async () => {
    const a = await link(2001);
    const b = await link(2002);
    const id = await createBoard(a, "claim board");
    const refused = await call(b.client, "canvas_add_node", { board_id: id, label: "b", kind: "service", at: [0, 0] });
    expect(refused.isError).toBe(true);
    expect(body(refused)).toContain("pid 2001");
    await a.close();
    await a.closed;
    const claimed = await waitFor(async () => {
      const r = await call(b.client, "canvas_add_node", { board_id: id, label: "b", kind: "service", at: [0, 0] });
      return r.isError ? null : r;
    }, 5000);
    expect(head(claimed)).toMatch(new RegExp(`^board ${id} "claim board" · you: author`));
    await b.close();
  });

  it("a hook that arrives before the hello for the same pid gives one Client", async () => {
    await waitFor(async () => (await clientsCount()) === 0, 5000);
    const res = await postHook(port, 3001, { hook_event_name: "SessionStart", source: "startup", session_id: "s-3001", permission_mode: "auto" });
    expect(res.status).toBe(200);
    expect(await clientsCount()).toBe(1);
    const a = await link(3001);
    await a.client.listTools();
    expect(await clientsCount()).toBe(1);
    await a.close();
    await waitFor(async () => (await clientsCount()) === 0, 5000);
  });

  it("two links with one pid give one Client; the first close keeps it and its authorship, the second removes it", async () => {
    const first = await link(4001);
    const second = await link(4001);
    const other = await link(4002);
    expect(await clientsCount()).toBe(2);
    const id = await createBoard(first, "two links");
    await first.close();
    await first.closed;
    // Same pid, other link: still the Author.
    const write = await call(second.client, "canvas_add_node", { board_id: id, label: "n", kind: "service", at: [0, 0] });
    expect(write.isError, body(write)).toBeFalsy();
    const refused = await call(other.client, "canvas_add_node", { board_id: id, label: "x", kind: "service", at: [0, 0] });
    expect(refused.isError).toBe(true);
    expect(await clientsCount()).toBe(2);
    await second.close();
    await second.closed;
    await waitFor(async () => (await clientsCount()) === 1, 5000);
    const claimed = await call(other.client, "canvas_add_node", { board_id: id, label: "x", kind: "service", at: [0, 0] });
    expect(claimed.isError, body(claimed)).toBeFalsy();
    await other.close();
  });

  it("restart: the link closes, the old pid exits, and saved boards are there after a new daemon starts", async () => {
    const a = await link(5001);
    const id = await createBoard(a, "survives restart");
    await call(a.client, "canvas_add_node", { label: "kept", kind: "service", at: [10, 10] });
    const before = (await health(port))!;
    const res = await rawRequest(port, "POST", "/api/daemon/restart");
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ clients: expect.any(Number), boards: expect.any(Number) });
    await a.closed;
    expect(await daemon.exited).toBe(0);
    expect(alive(before.pid)).toBe(false);
    // M4.4 (f): after every session of this file, the daemon wrote nothing to stdout.
    expect(daemon.stdout()).toBe("");

    const respawned = spawnDaemon(port, dataDir, { INKWIRE_IDLE_GRACE_MS: "off" });
    daemon = respawned;
    try {
      const after = await waitFor(() => health(port), 15_000);
      expect(after.pid).not.toBe(before.pid);
      const b = await link(5002);
      const state = await call(b.client, "canvas_get_state", { board_id: id });
      expect(state.isError, body(state)).toBeFalsy();
      expect(JSON.parse(body(state)).graph.nodes.map((n: { label: string }) => n.label)).toContain("kept");
      await b.close();
      expect(respawned.stdout()).toBe("");
    } finally {
      respawned.child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("daemon in-process", () => {
  it("a relay with a newer build marks the daemon stale and gets the stale line once (Decision 7)", async () => {
    const d = (await startDaemon({
      config: { port: 0, dataDir: tempDir("daemon-stale"), idleGraceMs: null },
      build: { id: "old-build", built_at: "2026-10-01T00:00:00.000Z" },
      exit: () => {},
    }))!;
    // M4.9: the stale hello fires onChange (M5 pushes it to the panels).
    const changes: (string | null)[] = [];
    const off = d.core.clients.onChange(() => changes.push(d.core.clients.staleBuild?.id ?? null));
    const same = await linkClient(d.port, 7001, { build: { id: "old-build", built_at: "2026-10-01T00:00:00.000Z" } });
    const older = await linkClient(d.port, 7002, { build: { id: "older", built_at: "2026-09-01T00:00:00.000Z" } });
    expect(changes).not.toContain("new-build");
    const newer = await linkClient(d.port, 7003, { build: { id: "new-build", built_at: "2026-10-08T00:00:00.000Z" } });
    try {
      expect(changes).toContain("new-build");
      off();
      expect(head(await call(same.client, "boards_list"))).not.toContain("old build");
      expect(head(await call(older.client, "boards_list"))).not.toContain("old build");
      expect(d.core.clients.staleBuild).toEqual({ id: "new-build", built_at: "2026-10-08T00:00:00.000Z" });
      expect(head(await call(newer.client, "boards_list"))).toContain(STALE_NOTICE);
      expect(head(await call(newer.client, "boards_list"))).not.toContain(STALE_NOTICE);
    } finally {
      for (const l of [same, older, newer]) await l.close().catch(() => {});
      d.shutdown("test end");
    }
  });

  it("reads the build file one time, at boot: /healthz keeps the boot id after the file changes (Decision 10)", async () => {
    const dir = tempDir("daemon-build");
    const buildFile = path.join(dir, "build.json");
    writeFileSync(buildFile, JSON.stringify({ id: "boot0000boot0000", built_at: "2026-10-08T10:00:00.000Z" }));
    const d = (await startDaemon({ config: { port: 0, dataDir: dir, idleGraceMs: null }, buildFile, exit: () => {} }))!;
    try {
      expect((await health(d.port))?.build).toEqual({ id: "boot0000boot0000", built_at: "2026-10-08T10:00:00.000Z" });
      writeFileSync(buildFile, JSON.stringify({ id: "rebuilt0rebuilt0", built_at: "2026-10-08T12:00:00.000Z" }));
      expect((await health(d.port))?.build).toEqual({ id: "boot0000boot0000", built_at: "2026-10-08T10:00:00.000Z" });
    } finally {
      d.shutdown("test end");
    }
  });

  it("a close during a pending session_send resolves it and leaves no timer", async () => {
    const exits: number[] = [];
    const d: Daemon | null = await startDaemon({
      config: { port: 0, dataDir: tempDir("daemon-inproc"), idleGraceMs: null },
      build: { id: "inproc", built_at: null },
      exit: (code) => exits.push(code),
    });
    expect(d).not.toBeNull();
    const daemonPort = d!.port;
    const l = await linkClient(daemonPort, 6001);
    try {
      const created = await call(l.client, "boards_create", { name: "pending", project_root: tempDir("daemon-inproc-root") });
      expect(created.isError, body(created)).toBeFalsy();
      await postHook(daemonPort, 6001, { hook_event_name: "PreToolUse", permission_mode: "auto", session_id: "s-6001" });
      const on = await call(l.client, "session_mode", { on: true });
      expect(on.isError, body(on)).toBeFalsy();
      const c = d!.core.clients.get(6001)!;
      const sending = call(l.client, "session_send", { text: "waiting" }).catch((err) => err);
      const pending = await waitFor(() => c.pending, 5000);
      let resolved: unknown = null;
      const resolve = pending.resolve;
      pending.resolve = (r) => {
        resolved = r;
        resolve(r);
      };
      await l.close();
      await l.closed;
      await waitFor(() => resolved, 5000);
      expect(c.pending).toBeNull();
      expect(c.mode).toBe("pty");
      // clearTimeout ran on the send timer: Node marks a cleared Timeout as destroyed.
      expect((pending.timer as unknown as { _destroyed: boolean })._destroyed).toBe(true);
      expect(d!.core.clients.get(6001)).toBeUndefined();
      await sending;
    } finally {
      await l.close().catch(() => {});
      d!.shutdown("test end");
    }
    expect(exits).toEqual([0]);
  });
});
