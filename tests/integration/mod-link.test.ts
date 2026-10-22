// ADR 0004 end to end: the mod's HTTP flow against a real daemon that a real
// relay autostarts (the full link). The relay carries CLAUDE_CODE_SESSION_ID,
// as Claude Code sets it, so the mod finds its Client by session id. Each
// request has the shape that hooks/mod/daemon.ts sends: no Origin, JSON body.
// Random port, temp data dir; stop() kills the daemon.
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../plugin/src/shared/protocol.ts";
import { body, call, freePort, head, postHook, rawRequest, tempDir } from "./daemon-helpers.ts";
import { startRelays, type Relay, type Relays } from "../health/harness.ts";

const SESSION = "mod-link-session";
const JSON_HEADERS = { "content-type": "application/json" };

let r: Relays;
let A: Relay;
let port: number;

interface View {
  key: string;
  client: { pid: number; label: string; mode: string; awaiting: boolean; inbox: number; current_board: string | null } | null;
  board: { id: string; name: string; author: { pid: number; mode: string; pending: boolean; awaiting?: boolean } | null } | null;
}

async function view(since = "", wait = 0): Promise<View> {
  const q = new URLSearchParams({ session: SESSION, since, wait: String(wait) });
  const res = await rawRequest(port, "GET", `/api/mod/view?${q.toString()}`);
  expect(res.status, res.body).toBe(200);
  return JSON.parse(res.body) as View;
}

/** The mod's POST /api/hook?via=mod: the text verdict. */
async function modHook(event: Record<string, unknown>, bg = "unset"): Promise<string> {
  const res = await rawRequest(port, "POST", `/api/hook?via=mod&bg=${bg}`, JSON_HEADERS, JSON.stringify(event));
  expect(res.status).toBe(200);
  return res.body;
}

async function take(session = SESSION) {
  const res = await rawRequest(port, "POST", "/api/mod/take", JSON_HEADERS, JSON.stringify({ session }));
  return { status: res.status, json: JSON.parse(res.body) as { replies?: { id: string; prompt: string }[]; error?: string } };
}

/** A browser panel on one board: its pushes, a wait for one, and a send of an intent. */
function panel(board: string): Promise<{ waitFor: (f: (m: ServerMessage) => boolean) => Promise<ServerMessage>; send: (m: unknown) => void; close: () => void }> {
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

const json = (res: Awaited<ReturnType<typeof call>>) => JSON.parse(body(res)) as Record<string, unknown>;

beforeAll(async () => {
  port = await freePort();
  r = await startRelays(1, { port, dataDir: tempDir("mod-link"), graceMs: "off", env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  A = r.relays[0]!;
}, 30_000);

afterAll(async () => {
  await r?.stop(0);
});

describe("the mod over the full link (ADR 0004)", () => {
  let board: string;

  it("the view finds the relay's Client by the session id of its hello", async () => {
    const v = await view();
    expect(v.client).toMatchObject({ pid: A.pid, mode: "pty", awaiting: false, inbox: 0, current_board: null });
    expect(v.board).toBeNull();
  });

  it("a write claims a board; the view then has it, with the Author push", async () => {
    const res = await call(A.client, "boards_create", { name: "mod link", project_root: tempDir("mod-link-root") });
    expect(res.isError, body(res)).toBeFalsy();
    board = json(res).board_id as string;
    const v = await view();
    expect(v.client?.current_board).toBe(board);
    expect(v.board).toMatchObject({ id: board, name: "mod link" });
    expect(v.board!.author).toMatchObject({ pid: A.pid, mode: "pty", pending: false });
  });

  it("the key is stable with no change: the long poll waits", async () => {
    const v = await view();
    const t0 = Date.now();
    const again = await view(v.key, 400);
    expect(again.key).toBe(v.key);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it("the long poll wakes on a rename of the board with a new key", async () => {
    const v = await view();
    const t0 = Date.now();
    const polling = view(v.key, 20_000);
    await new Promise((res) => setTimeout(res, 100));
    const renamed = await call(A.client, "boards_update", { board_id: board, name: "mod link 2" });
    expect(renamed.isError, body(renamed)).toBeFalsy();
    const next = await polling;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(next.key).not.toBe(v.key);
    expect(next.board!.name).toBe("mod link 2");
  });

  it("mod delivery: hook via mod → session_mode on → session_send delivered → browser reply → take", async () => {
    // The mod's hook events. Permission mode default and bg unset: with a live mod, mode on does not need them.
    expect(await modHook({ hook_event_name: "SessionStart", source: "startup", session_id: SESSION, permission_mode: "default" })).toBe("ok");
    expect(
      await modHook({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "mcp__plugin_inkwire_inkwire__session_mode", tool_input: { on: true }, tool_use_id: "t1", permission_mode: "default" }),
    ).toBe("ok");
    const on = await call(A.client, "session_mode", { on: true });
    expect(on.isError, body(on)).toBeFalsy();
    expect(json(on)).toMatchObject({ mode: "inkwire", hook: "Stop", delivery: "mod" });
    expect(head(on)).toContain("mode: inkwire");

    // Not awaiting: the Stop is blocked, as in the blocking model.
    expect((await modHook({ hook_event_name: "Stop", session_id: SESSION, permission_mode: "default" })).startsWith("block\n")).toBe(true);

    // session_send returns delivered at once.
    const t0 = Date.now();
    const sent = await call(A.client, "session_send", { text: "which store?" });
    expect(sent.isError, body(sent)).toBeFalsy();
    expect(json(sent)).toMatchObject({ status: "delivered" });
    expect(Date.now() - t0).toBeLessThan(5000);

    // The turn may end: the mod's Stop passes, and forward.sh only gets ok for a Client with a live mod.
    expect(await modHook({ hook_event_name: "Stop", session_id: SESSION, permission_mode: "default" })).toBe("ok");
    expect((await postHook(port, A.pid, { hook_event_name: "Stop", session_id: SESSION, permission_mode: "default" })).body).toBe("ok");

    const waiting = await view();
    expect(waiting.client).toMatchObject({ mode: "inkwire", awaiting: true, inbox: 0 });
    expect(waiting.board!.author).toMatchObject({ pid: A.pid, mode: "inkwire", pending: true, awaiting: true });

    // The person's reply from the browser panel's composer.
    const p = await panel(board);
    try {
      await p.waitFor((m) => m.type === "state");
      p.send({ type: "session_reply", text: "the cache", focus: null, selection: null, trace: null, draft: null, notebook: null });
      await p.waitFor((m) => m.type === "state" && m.session.author?.pending === false && m.session.thread.some((e) => e.type === "you" && e.text === "the cache"));
    } finally {
      p.close();
    }

    const queued = await view();
    expect(queued.client).toMatchObject({ awaiting: false, inbox: 1 });
    expect(queued.board!.author?.pending).toBe(false);
    expect(queued.board!.author?.awaiting).toBe(false);

    const got = await take();
    expect(got.status).toBe(200);
    expect(got.json.replies).toHaveLength(1);
    const prompt = got.json.replies![0]!.prompt.split("\n");
    expect(prompt[0]).toBe("the cache");
    expect(prompt[1]).toMatch(/^inkwire ctx: /);
    expect(JSON.parse(prompt[1]!.slice("inkwire ctx: ".length))).toMatchObject({ board, focus: null, selection: null, trace: null });
    expect(prompt[2]).toBe("Answer with session_send.");
    expect((await take()).json.replies).toEqual([]);

    // The mod submits the prompt: UserPromptSubmit. Then a send, and the person types in the terminal: awaiting clears.
    expect(await modHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "the cache" })).toBe("ok");
    expect(json(await call(A.client, "session_send", { text: "ok, the cache" }))).toMatchObject({ status: "delivered" });
    expect((await view()).client?.awaiting).toBe(true);
    expect(await modHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "typed" })).toBe("ok");
    expect((await view()).client?.awaiting).toBe(false);

    // Mode off from Claude: the view shows pty.
    expect(json(await call(A.client, "session_mode", { on: false }))).toMatchObject({ mode: "pty" });
    expect((await view()).client?.mode).toBe("pty");
  });

  it("take for an unknown session gets 404", async () => {
    expect((await take("no-such-session")).status).toBe(404);
  });
});
