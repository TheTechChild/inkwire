// ADR 0004: the mod's HTTP routes on a real daemon (random port, temp data
// dir): the hook with ?via=mod, GET /api/mod/view (long poll), POST
// /api/mod/take, and the Origin check on them.
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { startDaemon, type Daemon } from "../../plugin/src/server/daemon.ts";
import { sessionMode, sessionSend } from "../../plugin/src/server/session-mode.ts";
import * as mutations from "../../plugin/src/server/mutations.ts";
import type { Client } from "../../plugin/src/server/clients.ts";
import type { ServerMessage } from "../../plugin/src/shared/protocol.ts";
import { rawRequest, tempDir } from "./daemon-helpers.ts";

let d: Daemon;
let port: number;
let boardId: string;
let me: Client;
const SID = "sess-mod";
let errors: MockInstance<typeof console.error>;

const json = { "content-type": "application/json" };
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  rawRequest(port, "POST", p, { ...json, ...headers }, typeof body === "string" ? body : JSON.stringify(body));
const view = async (q: string, headers: Record<string, string> = {}) => {
  const r = await rawRequest(port, "GET", `/api/mod/view?${q}`, headers);
  return { status: r.status, body: JSON.parse(r.body) };
};

beforeAll(async () => {
  const started = await startDaemon({
    config: { port: 0, dataDir: tempDir("mod"), idleGraceMs: null },
    build: { id: "mod", built_at: null },
    exit: () => {},
  });
  d = started!;
  port = d.port;
  const root = tempDir("mod-root");
  boardId = d.core.sessions.create("mod board", root).boardId;
  me = d.core.clients.ensure(5151, { sessionId: SID, cwd: "/work/modrepo" });
  d.core.clients.attach(5151, "link-test");
  d.core.clients.commitClaim(me, boardId);
});

beforeEach(() => {
  errors?.mockRestore();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  errors?.mockRestore();
  d.shutdown("test end");
});

function panel(board: string): Promise<{ messages: ServerMessage[]; waitFor: (f: (m: ServerMessage) => boolean) => Promise<ServerMessage>; send: (m: unknown) => void; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`);
    const messages: ServerMessage[] = [];
    const waiters: { f: (m: ServerMessage) => boolean; r: (m: ServerMessage) => void }[] = [];
    socket.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      messages.push(m);
      for (const w of [...waiters]) if (w.f(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.r(m);
      }
    });
    socket.on("error", reject);
    socket.on("open", () =>
      resolve({
        messages,
        waitFor: (f) => {
          const hit = messages.find(f);
          if (hit) return Promise.resolve(hit);
          return new Promise((r, j) => {
            waiters.push({ f, r });
            setTimeout(() => j(new Error("timed out waiting for a push")), 3000);
          });
        },
        send: (m) => socket.send(JSON.stringify(m)),
        close: () => socket.close(),
      }),
    );
  });
}

describe("POST /api/hook?via=mod", () => {
  it("marks the mod's hooks (not its loop), records the hook report, and rekeys by prev_session_id", async () => {
    me.mod = null;
    me.modHookAt = null;
    const r = await post("/api/hook?via=mod&bg=unset", { hook_event_name: "PreToolUse", session_id: SID, permission_mode: "default" });
    expect(r).toEqual({ status: 200, body: "ok" });
    expect(d.core.clients.hasLiveMod(me)).toBe(false);
    expect(d.core.clients.modAnswersHooks(me)).toBe(true);
    expect(me.hook).toMatchObject({ permissionMode: "default", autoBackground: "unset" });
    const clear = await post("/api/hook?via=mod&bg=unset", { hook_event_name: "SessionStart", source: "clear", session_id: "sess-new", prev_session_id: SID });
    expect(clear.body).toBe("ok");
    expect(me.sessionId).toBe("sess-new");
    // Back to the id the other tests use.
    await post("/api/hook?via=mod", { hook_event_name: "SessionStart", source: "resume", session_id: SID, prev_session_id: "sess-new" });
    expect(me.sessionId).toBe(SID);
  });

  it("a forward.sh Stop for a Client with a live mod returns ok and counts nothing", async () => {
    await view(`session=${SID}&wait=0`);
    sessionMode(d.core.clients, me, true, { focusTerminal: () => {} });
    try {
      const r = await post(`/api/hook?bg=0&pid=5151`, { hook_event_name: "Stop", session_id: SID, permission_mode: "auto" });
      expect(r.body).toBe("ok");
      expect(me.blocks).toBe(0);
      const viaMod = await post(`/api/hook?via=mod`, { hook_event_name: "Stop", session_id: SID });
      expect(viaMod.body.startsWith("block\n")).toBe(true);
    } finally {
      sessionMode(d.core.clients, me, false, { focusTerminal: () => {} });
    }
  });
});

describe("GET /api/mod/view", () => {
  it("an unknown session gets client null and board null", async () => {
    const r = await view("session=nobody&wait=0");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ client: null, board: null });
    expect(typeof r.body.key).toBe("string");
  });

  it("bad input gets 400", async () => {
    expect((await view("wait=0")).status).toBe(400);
    expect((await view(`session=${SID}&wait=soon`)).status).toBe(400);
  });

  it("a known session gets its client and its current board: id, name and the Author push", async () => {
    me.mod = null;
    const r = await view(`session=${SID}&wait=0`);
    expect(r.status).toBe(200);
    expect(r.body.client).toEqual({ pid: 5151, label: "modrepo", mode: "pty", awaiting: false, inbox: 0, current_board: boardId });
    expect(r.body.board).toMatchObject({ id: boardId, name: "mod board" });
    expect(Object.keys(r.body.board).sort()).toEqual(["author", "id", "name"]);
    expect(r.body.board.author).toMatchObject({ pid: 5151, pending: false });
    // The view (the mod's loop) marks the mod live.
    expect(d.core.clients.hasLiveMod(me)).toBe(true);
  });

  it("alias: a Client that holds the launch id is found and rekeyed to the current id", async () => {
    // A hello after /clear made the Client with the launch id from the relay's env.
    me.sessionId = "sess-launch";
    try {
      const r = await view(`session=${SID}&alias=sess-launch&wait=0`);
      expect(r.body.client).toMatchObject({ pid: 5151 });
      expect(me.sessionId).toBe(SID);
    } finally {
      me.sessionId = SID;
    }
  });

  it("a differing since answers at once", async () => {
    const t0 = Date.now();
    const r = await view(`session=${SID}&since=stale&wait=5000`);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a board edit does not change the key: the view holds only the status line's fields", async () => {
    const first = (await view(`session=${SID}&wait=0`)).body;
    mutations.addNode(d.core.sessions.open(boardId), "human", { label: "not shown", kind: "service", at: [0, 0] });
    expect((await view(`session=${SID}&wait=0`)).body.key).toBe(first.key);
  });

  it("the long poll wakes on a Clients change", async () => {
    const first = (await view(`session=${SID}&wait=0`)).body;
    const waiting = view(`session=${SID}&since=${first.key}&wait=5000`);
    setTimeout(() => sessionMode(d.core.clients, me, true, { focusTerminal: () => {} }), 100);
    try {
      const r = await waiting;
      expect(r.body.client.mode).toBe("inkwire");
    } finally {
      sessionMode(d.core.clients, me, false, { focusTerminal: () => {} });
    }
  });

  it("with no change, it answers after wait with the same key", async () => {
    const first = (await view(`session=${SID}&wait=0`)).body;
    const t0 = Date.now();
    const r = await view(`session=${SID}&since=${first.key}&wait=300`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.body.key).toBe(first.key);
  });

  it("a closed request removes its listeners", async () => {
    const listeners = (d.core.sessions as unknown as { listeners: Set<unknown> }).listeners;
    const before = listeners.size;
    const first = (await view(`session=${SID}&wait=0`)).body;
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${port}/api/mod/view?session=${SID}&since=${first.key}&wait=5000`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    expect(listeners.size).toBe(before + 1);
    ac.abort();
    await req;
    await new Promise((r) => setTimeout(r, 100));
    expect(listeners.size).toBe(before);
  });
});

describe("mod delivery over HTTP", () => {
  it("delivered send → the push shows pending → a panel reply → take returns the prompt and empties the inbox", async () => {
    await view(`session=${SID}&wait=0`);
    await post("/api/hook?via=mod&bg=unset", { hook_event_name: "PreToolUse", session_id: SID, permission_mode: "default" });
    sessionMode(d.core.clients, me, true, { focusTerminal: () => {} });
    const p = await panel(boardId);
    try {
      const res = await sessionSend(d.core.clients, me, d.core.sessions.open(boardId), { text: "which store?" });
      expect(res.status).toBe("delivered");
      await p.waitFor((m) => m.type === "state" && m.session.author?.pending === true);
      expect((await view(`session=${SID}&wait=0`)).body.client).toMatchObject({ awaiting: true, inbox: 0 });
      p.send({ type: "session_reply", text: "the cache", focus: null, selection: null, trace: null, draft: null, notebook: null });
      await p.waitFor((m) => m.type === "state" && m.session.author?.pending === false);
      expect((await view(`session=${SID}&wait=0`)).body.client).toMatchObject({ awaiting: false, inbox: 1 });
      const take = await post("/api/mod/take", { session: SID });
      expect(take.status).toBe(200);
      const { replies } = JSON.parse(take.body);
      expect(replies).toHaveLength(1);
      expect(replies[0].prompt).toMatch(/^the cache\ninkwire ctx: \{.*"board":"b_[0-9a-f]+".*\}\nAnswer with session_send\.$/);
      expect(JSON.parse((await post("/api/mod/take", { session: SID })).body)).toEqual({ replies: [] });
    } finally {
      p.close();
      sessionMode(d.core.clients, me, false, { focusTerminal: () => {} });
    }
  });

  it("take: an unknown session gets 404", async () => {
    expect((await post("/api/mod/take", { session: "nobody" })).status).toBe(404);
  });
});

describe("Origin check on the mod routes", () => {
  it("a mod request with no Origin passes", async () => {
    expect((await post("/api/mod/take", { session: SID })).status).toBe(200);
    expect((await view(`session=${SID}&wait=0`)).status).toBe(200);
  });

  it("the old intent route is gone", async () => {
    expect((await post("/api/mod/intent", { session: SID, board: boardId, intent: { type: "session_mode_off" } })).status).toBe(404);
  });

  it("a mod request with a foreign Origin is refused", async () => {
    const evil = { Origin: "https://evil.example" };
    expect((await post("/api/mod/take", { session: SID }, evil)).status).toBe(403);
    expect((await rawRequest(port, "GET", `/api/mod/view?session=${SID}&wait=0`, evil)).status).toBe(403);
    expect((await post("/api/hook?via=mod", { hook_event_name: "Stop", session_id: SID }, evil)).status).toBe(403);
  });
});
