// MCP health suite (plan M8): the daemon's lifetime through real relays.
// Autostart, the autostart race, release on close, /clear, a SIGKILL and the
// reconnect, a stale build, both restarts, the idle grace, and the dist relay
// as the plugin runs it. Each case has its own random port and temp data dir;
// stop() in finally closes the relays and kills every daemon pid it saw.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_RULE_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../../src/server/mcp.js";
import { STALE_NOTICE } from "../../src/server/clients.js";
import { alive, body, call, freePort, head, health, postHook, rawRequest, root, tempDir, waitFor } from "../integration/daemon-helpers.js";
import { distSkipReason, startRelays, type Relay, type Relays } from "./harness.js";

const TOOL_COUNT = WRITE_TOOLS.length + READ_TOOLS.length + OWN_RULE_TOOLS.length;

async function createBoard(relay: Relay, name: string, projectRoot: string): Promise<string> {
  const res = await call(relay.client, "boards_create", { name, project_root: projectRoot });
  expect(res.isError, body(res)).toBeFalsy();
  return JSON.parse(body(res)).board_id as string;
}

async function addNode(relay: Relay, boardId: string, label: string) {
  return call(relay.client, "canvas_add_node", { board_id: boardId, label, kind: "service", at: [0, 0] });
}

/** Wait for a new daemon on the port (another pid than before) and remember it for stop(). */
async function nextDaemon(r: Relays, before: number): Promise<number> {
  const h = await waitFor(async () => {
    const x = await r.health();
    return x && x.pid !== before ? x : null;
  }, 15_000);
  return h.pid;
}

/** A copy of this repo's src with its own dist/build.json: a relay of a newer build. */
function newerBuildRepo(buildId: string): string {
  const repo = tempDir("health-newer");
  cpSync(path.join(root, "src"), path.join(repo, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) copyFileSync(path.join(root, f), path.join(repo, f));
  symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"), "dir");
  mkdirSync(path.join(repo, "dist"));
  writeFileSync(
    path.join(repo, "dist", "build.json"),
    JSON.stringify({ id: buildId, built_at: new Date(Date.now() + 24 * 3600_000).toISOString() }),
  );
  return repo;
}

describe("health: daemon lifecycle", () => {
  it("lifecycle: the first relay autostarts a daemon when none runs", async () => {
    const port = await freePort();
    const dataDir = tempDir("health-auto");
    expect(await health(port)).toBeNull();
    let r: Relays | null = null;
    try {
      r = await startRelays(1, { port, dataDir, graceMs: 300 });
      const h = (await r.health())!;
      expect(h).toMatchObject({ ok: true, name: "inkwire", clients: 1 });
      expect(h.pid).not.toBe(r.relays[0]!.pid);
      expect(existsSync(path.join(dataDir, "daemon.log"))).toBe(true);
      expect((await r.relays[0]!.client.listTools()).tools).toHaveLength(TOOL_COUNT);
    } finally {
      await r?.stop();
    }
  }, 30_000);

  it("lifecycle: three relays that start at one time give one daemon pid and clients: 3", async () => {
    let r: Relays | null = null;
    try {
      r = await startRelays(3, { port: await freePort(), dataDir: tempDir("health-race"), graceMs: 300 });
      const pids = new Set(r.relays.map((x) => x.pid));
      expect(pids.size).toBe(3);
      for (let i = 0; i < 5; i++) {
        const h = (await r.health())!;
        expect(h.pid).toBe(r.daemonPid);
        expect(h.clients).toBe(3);
        await new Promise((res) => setTimeout(res, 100));
      }
      const lists = await Promise.all(r.relays.map((x) => x.client.listTools()));
      for (const l of lists) expect(l.tools).toHaveLength(TOOL_COUNT);
    } finally {
      await r?.stop();
    }
  }, 30_000);

  it("lifecycle: a relay close releases its authorship, and the panel push shows author: null", async () => {
    let r: Relays | null = null;
    try {
      r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-release"), graceMs: 300 });
      const [A, B] = r.relays as [Relay, Relay];
      const board = await createBoard(A, "release on close", tempDir("health-release-root"));
      const panel = await r.panel(board);
      await panel.waitFor((m) => m.type === "state" && m.session.author?.pid === A.pid);
      expect(body(await addNode(B, board, "refused"))).toContain(`pid ${A.pid}`);

      await A.close();
      await panel.waitFor((m) => m.type === "state" && m.session.author === null);
      const claimed = await addNode(B, board, "mine now");
      expect(claimed.isError, body(claimed)).toBeFalsy();
      expect(head(claimed)).toMatch(new RegExp(`^board ${board} "release on close" · you: author`));
      await waitFor(async () => (await r!.health())?.clients === 1, 5000);
    } finally {
      await r?.stop();
    }
  }, 30_000);

  it("lifecycle: /clear (SessionStart clear with a new session id) keeps the Client and its authorship", async () => {
    let r: Relays | null = null;
    try {
      r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-clear"), graceMs: 300 });
      const [A, B] = r.relays as [Relay, Relay];
      const board = await createBoard(A, "after clear", tempDir("health-clear-root"));
      const res = await postHook(r.port, A.pid, { hook_event_name: "SessionStart", source: "clear", session_id: `s-${A.pid}-cleared`, permission_mode: "auto" });
      expect(res.status).toBe(200);
      expect((await r.health())?.clients).toBe(2);
      const write = await addNode(A, board, "still mine");
      expect(write.isError, body(write)).toBeFalsy();
      expect(head(write)).toMatch(new RegExp(`^board ${board} "after clear" · you: author`));
      const refused = await addNode(B, board, "not yours");
      expect(refused.isError).toBe(true);
      expect(body(refused)).toContain(`pid ${A.pid}`);
    } finally {
      await r?.stop();
    }
  }, 30_000);

  it("lifecycle: after a SIGKILL of the daemon, the relays reconnect to a new daemon with no unknown message ID", async () => {
    let r: Relays | null = null;
    try {
      r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-kill"), graceMs: 300 });
      const [A, B] = r.relays as [Relay, Relay];
      const board = await createBoard(A, "kept board", tempDir("health-kill-root"));
      process.kill(r.daemonPid, "SIGKILL");
      await waitFor(() => !alive(r!.daemonPid), 5000);

      expect((await A.client.listTools()).tools).toHaveLength(TOOL_COUNT);
      expect((await B.client.listTools()).tools).toHaveLength(TOOL_COUNT);
      await nextDaemon(r, r.daemonPid);
      await waitFor(async () => (await r!.health())?.clients === 2, 10_000);

      // The current board is kept; authorship is not, and the next write claims it again.
      const state = await call(A.client, "canvas_get_state");
      expect(state.isError, body(state)).toBeFalsy();
      expect(head(state)).toMatch(new RegExp(`^board ${board} "kept board" · you: reader`));
      const write = await addNode(A, board, "again");
      expect(write.isError, body(write)).toBeFalsy();
      expect(head(write)).toMatch(new RegExp(`^board ${board} "kept board" · you: author`));
      const errors = [...A.errors, ...B.errors].map((e) => e.message).join("\n");
      expect(errors).not.toContain("unknown message ID");
    } finally {
      await r?.stop();
    }
  }, 40_000);

  it("lifecycle: a stale build reaches the panel; the panel restart and POST /api/daemon/restart both restart, and saved boards come back", async () => {
    let r: Relays | null = null;
    try {
      r = await startRelays(1, { port: await freePort(), dataDir: tempDir("health-stale"), graceMs: 300 });
      const [A] = r.relays as [Relay];
      const board = await createBoard(A, "survives restarts", tempDir("health-stale-root"));
      expect((await addNode(A, board, "kept")).isError).toBeFalsy();
      const panel = await r.panel(board);
      await panel.waitFor((m) => m.type === "state");

      // A relay of another build id with a later built_at: the daemon is stale.
      const newer = `health-newer-${process.pid}`;
      const N = await r.add({ repo: newerBuildRepo(newer) });
      await panel.waitFor((m) => (m.type === "state" || m.type === "daemon") && m.daemon.stale?.newer_build_id === newer);
      expect(head(await call(N.client, "boards_list"))).toContain(STALE_NOTICE);
      // The stale notice stays after that relay leaves; a restart then starts this repo's build.
      await N.close();

      // 1. The panel's Restart, for the build id the notice showed.
      const first = r.daemonPid;
      panel.send({ type: "daemon_restart", build_id: newer });
      await waitFor(() => !alive(first), 10_000);
      expect((await A.client.listTools()).tools).toHaveLength(TOOL_COUNT);
      const second = await nextDaemon(r, first);
      const afterPanel = await call(A.client, "canvas_get_state", { board_id: board });
      expect(afterPanel.isError, body(afterPanel)).toBeFalsy();
      expect(JSON.parse(body(afterPanel)).graph.nodes.map((n: { label: string }) => n.label)).toEqual(["kept"]);

      // 2. POST /api/daemon/restart, as yarn daemon:restart sends it.
      const res = await rawRequest(r.port, "POST", "/api/daemon/restart");
      expect(res.status).toBe(202);
      await waitFor(() => !alive(second), 10_000);
      expect((await A.client.listTools()).tools).toHaveLength(TOOL_COUNT);
      await nextDaemon(r, second);
      const afterPost = await call(A.client, "canvas_get_state", { board_id: board });
      expect(afterPost.isError, body(afterPost)).toBeFalsy();
      expect(JSON.parse(body(afterPost)).graph.nodes.map((n: { label: string }) => n.label)).toEqual(["kept"]);
      expect(A.errors.map((e) => e.message)).toEqual([]);
    } finally {
      await r?.stop();
    }
  }, 50_000);

  it("lifecycle: the idle grace stops the daemon after the last relay closes", async () => {
    let r: Relays | null = null;
    // stop() runs in finally; its result is checked after the body, so a cleanup failure never hides a body failure.
    let clean: boolean | undefined;
    try {
      r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-idle"), graceMs: 300 });
      const pid = r.daemonPid;
      await r.relays[0]!.close();
      // One relay is left: the daemon stays.
      await new Promise((res) => setTimeout(res, 800));
      expect(alive(pid)).toBe(true);
      await r.relays[1]!.close();
      await waitFor(() => !alive(pid), 5000);
      expect(await health(r.port)).toBeNull();
    } finally {
      clean = await r?.stop();
    }
    expect(clean, "every daemon exited by itself").toBe(true);
  }, 30_000);

  // yarn test skips the dist-relay case when dist/ is not a build of src/. yarn health
  // (INKWIRE_HEALTH=1) builds first, so there the case never skips: a stale dist fails it.
  const healthRun = process.env.INKWIRE_HEALTH === "1";
  const distSkip = distSkipReason();
  it.skipIf(distSkip !== null && !healthRun)(
    `lifecycle: the dist relay, as the plugin runs it, autostarts the dist daemon and runs tools${distSkip && !healthRun ? ` (skipped: ${distSkip})` : ""}`,
    async () => {
      expect(distSkipReason(), "yarn health: dist/ must be a build of the current src/").toBeNull();
      let r: Relays | null = null;
      let clean: boolean | undefined;
      try {
        r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-dist"), graceMs: 300, entry: "dist" });
        const command = execFileSync("ps", ["-o", "command=", "-p", String(r.daemonPid)], { encoding: "utf8" });
        expect(command).toContain(path.join("dist", "server", "daemon.js"));
        const [A, B] = r.relays as [Relay, Relay];
        expect((await A.client.listTools()).tools).toHaveLength(TOOL_COUNT);
        const board = await createBoard(A, "dist board", tempDir("health-dist-root"));
        expect((await addNode(A, board, "n")).isError).toBeFalsy();
        const refused = await addNode(B, board, "x");
        expect(body(refused)).toContain(`pid ${A.pid}`);
        const state = await call(B.client, "canvas_get_state", { board_id: board });
        expect(JSON.parse(body(state)).graph.nodes).toHaveLength(1);
      } finally {
        clean = await r?.stop();
      }
      expect(clean, "every daemon exited by itself").toBe(true);
    },
    30_000,
  );
});
