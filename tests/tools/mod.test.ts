// ADR 0004: mod delivery for session mode, and the hook events that the mod
// forwards in place of hooks/forward.sh. One Sessions + Clients, one MCP
// server for Client 101, and a clock the test moves.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../plugin/src/server/mcp.ts";
import { Screenshots } from "../../plugin/src/server/screenshot.ts";
import { hookEvent, modPrompt, sessionMode, sessionReply, sessionSend } from "../../plugin/src/server/session-mode.ts";
import { Sessions } from "../../plugin/src/server/session.ts";
import { Clients, MOD_TTL_MS, type Client as InkwireClient } from "../../plugin/src/server/clients.ts";
import { Store } from "../../plugin/src/server/store.ts";
import { toolBody } from "../helpers.ts";

const store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-mod-")));
let t = 1_000_000;
let sessions: Sessions;
let clients: Clients;
let me: InkwireClient;
let mcp: Client;
let boardId: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const raw = (await mcp.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const content = toolBody(raw.content);
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return { isError: raw.isError, text, json: () => JSON.parse(text) };
}

/** One GET /api/mod/view of the mod's loop: only this marks the mod live. */
const poll = () => clients.markMod(me);
/** A hook event from the mod (?via=mod): no pid. */
const modHook = (event: Record<string, unknown>, bg = "unset") =>
  hookEvent(clients, { permission_mode: "default", session_id: "s1", ...event, via: "mod" }, bg);
/** A hook event from hooks/forward.sh (?pid=101). */
const forward = (event: Record<string, unknown>, bg = "0") =>
  hookEvent(clients, { permission_mode: "auto", session_id: "s1", claude_pid: 101, ...event }, bg);
const reply = (text: string) =>
  sessionReply(clients, sessions.open(boardId), { text, focus: null, selection: null, trace: null, draft: null, notebook: null });

/** Mode on with the mod live, in permission mode default and backgrounding unset. */
async function modOn() {
  poll();
  modHook({ hook_event_name: "PreToolUse" });
  const on = await call("session_mode", { on: true });
  expect(on.isError, on.text).toBeFalsy();
  return on.json();
}

beforeEach(async () => {
  sessions = new Sessions(store, { debounceMs: 50, sendTimeoutMs: 5_000, now: () => t });
  clients = new Clients(sessions);
  me = clients.ensure(101, { sessionId: "s1", cwd: "/work/repo" });
  clients.attach(101, "test");
  const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
  const server = buildMcpServer({
    sessions,
    clients,
    client: me,
    store,
    screenshots: () => screenshots,
    pluginRoot: "/repo",
    focusTerminal: () => {},
    panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  boardId = (await call("boards_create", { name: "mod board", project_root: tmpdir() })).json().board_id;
});

afterEach(async () => {
  if (me.mode === "inkwire") sessionMode(clients, me, false, { focusTerminal: () => {} });
  await mcp.close();
});

afterAll(() => store.close());

describe("mod liveness", () => {
  it("a view poll marks the Client; the mod is live for MOD_TTL_MS", () => {
    expect(clients.hasLiveMod(me)).toBe(false);
    poll();
    expect(me.mod).toEqual({ at: t });
    expect(clients.hasLiveMod(me)).toBe(true);
    t += MOD_TTL_MS - 1;
    expect(clients.hasLiveMod(me)).toBe(true);
    t += 1;
    expect(clients.hasLiveMod(me)).toBe(false);
  });

  it("a mod hook event does not make the mod live, but the mod answers the hooks", () => {
    modHook({ hook_event_name: "SessionStart", source: "startup" });
    expect(clients.hasLiveMod(me)).toBe(false);
    expect(clients.modAnswersHooks(me)).toBe(true);
    t += MOD_TTL_MS;
    expect(clients.modAnswersHooks(me)).toBe(false);
  });

  it("a session id that two Clients hold names no Client", () => {
    const other = clients.ensure(202, { sessionId: "s1", cwd: "/work/other" });
    expect(clients.bySessionId("s1")).toBeUndefined();
    expect(modHook({ hook_event_name: "Stop" })).toEqual({});
    expect(me.modHookAt).toBeNull();
    expect(other.modHookAt).toBeNull();
  });

  it("a mod event never makes a Client", () => {
    expect(modHook({ hook_event_name: "Stop", session_id: "nobody" })).toEqual({});
    expect(clients.all()).toHaveLength(1);
  });
});

describe("session_mode(on) with a live mod", () => {
  it("needs neither permission mode auto nor backgrounding 0", async () => {
    const on = await modOn();
    expect(on).toMatchObject({ mode: "inkwire", hook: "Stop", delivery: "mod" });
    expect(on.instruction).toContain("delivered");
    expect(me.hook).toMatchObject({ permissionMode: "default", autoBackground: "unset" });
  });

  it("without a live mod, the same hook report fails", async () => {
    poll();
    modHook({ hook_event_name: "PreToolUse" });
    t += MOD_TTL_MS;
    const r = await call("session_mode", { on: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("--permission-mode auto");
  });

  it("still needs a hook event", async () => {
    clients.markMod(me);
    const r = await call("session_mode", { on: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no hook event");
  });
});

describe("mod delivery", () => {
  it("session_send returns delivered at once: a Thread row, awaiting, no pending send", async () => {
    await modOn();
    const r = await call("session_send", { text: "which store?" });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.json()).toMatchObject({ status: "delivered" });
    expect(r.json().note).toContain("End your turn");
    expect(me.pending).toBeNull();
    expect(me.awaiting).toBe(true);
    expect(sessions.open(boardId).thread.at(-1)).toMatchObject({ type: "claude", text: "which store?" });
  });

  it("Stop passes while awaiting and blocks when not", async () => {
    await modOn();
    expect(modHook({ hook_event_name: "Stop" }).block).toContain("session_send");
    expect(me.blocks).toBe(1);
    await call("session_send", { text: "hi" });
    expect(me.blocks).toBe(0);
    expect(modHook({ hook_event_name: "Stop" })).toEqual({});
    expect(modHook({ hook_event_name: "Stop" })).toEqual({});
    expect(me.blocks).toBe(0);
    expect(me.mode).toBe("inkwire");
  });

  it("a reply goes to the inbox as a prompt with the inkwire ctx line; awaiting ends", async () => {
    await modOn();
    await call("session_send", { text: "which store?" });
    reply("the cache");
    expect(me.awaiting).toBe(false);
    const row = sessions.open(boardId).thread.at(-1)!;
    expect(row).toMatchObject({ type: "you", text: "the cache" });
    expect(me.inbox).toHaveLength(1);
    expect(me.inbox[0]!.id).toBe(row.id);
    const lines = me.inbox[0]!.prompt.split("\n");
    expect(lines[0]).toBe("the cache");
    expect(lines[1]!.startsWith("inkwire ctx: ")).toBe(true);
    expect(JSON.parse(lines[1]!.slice("inkwire ctx: ".length))).toEqual({
      focus: null,
      selection: null,
      trace: null,
      draft: null,
      notebook: null,
      revision: sessions.open(boardId).graphRevision,
      board: boardId,
    });
    expect(lines[2]).toBe("Answer with session_send.");
    expect(lines).toHaveLength(3);
    expect(me.inbox[0]!.prompt).toBe(modPrompt("the cache", JSON.parse(lines[1]!.slice(13))));
  });

  it("a reply with nothing awaited fails as today; a reply while awaiting with the mod gone tells the person to type in the terminal", async () => {
    await modOn();
    expect(() => reply("early")).toThrow("claude code is still working");
    await call("session_send", { text: "q" });
    t += MOD_TTL_MS;
    const before = sessions.open(boardId).thread.length;
    expect(() => reply("late")).toThrow("type it in the terminal");
    expect(sessions.open(boardId).thread).toHaveLength(before);
    expect(me.inbox).toHaveLength(0);
    expect(me.awaiting).toBe(true);
  });

  it("a reply before the Stop: the Stop still lets the turn end, and no block is counted", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    reply("yes");
    expect(me.awaiting).toBe(false);
    expect(me.delivered).toBe(true);
    expect(modHook({ hook_event_name: "Stop" })).toEqual({});
    expect(me.blocks).toBe(0);
    // The mod submits the reply: a new turn, which must answer with session_send.
    modHook({ hook_event_name: "UserPromptSubmit" });
    expect(me.delivered).toBe(false);
    expect(modHook({ hook_event_name: "Stop" }).block).toBeTruthy();
  });

  it("a Stop while awaiting with the mod's loop gone blocks, and clears awaiting", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    t += MOD_TTL_MS;
    expect(modHook({ hook_event_name: "Stop" }).block).toContain("session_send");
    expect(me.awaiting).toBe(false);
    expect(me.delivered).toBe(false);
    expect(me.blocks).toBe(1);
  });

  it("without a live mod, in a session that cannot block, session_send turns the mode off", async () => {
    await modOn();
    t += MOD_TTL_MS;
    const rows = sessions.open(boardId).thread.filter((r) => r.type === "claude").length;
    const r = await call("session_send", { text: "q" });
    expect(r.json()).toMatchObject({ status: "mode_off" });
    expect(r.json().note).toContain("permission mode is default");
    expect(me.mode).toBe("pty");
    expect(me.pending).toBeNull();
    expect(sessions.open(boardId).thread.filter((x) => x.type === "claude")).toHaveLength(rows);
  });

  it("a repeated session_mode(on) keeps the inbox and the awaited reply", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    reply("a");
    await call("session_send", { text: "q2" });
    expect(me.inbox).toHaveLength(1);
    const on = await call("session_mode", { on: true });
    expect(on.isError, on.text).toBeFalsy();
    expect(me.inbox).toHaveLength(1);
    expect(me.awaiting).toBe(true);
  });

  it("UserPromptSubmit clears awaiting, so the next Stop blocks again", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    expect(modHook({ hook_event_name: "UserPromptSubmit" })).toEqual({});
    expect(me.awaiting).toBe(false);
    expect(modHook({ hook_event_name: "Stop" }).block).toBeTruthy();
  });

  it("mode off clears awaiting and the inbox", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    reply("a");
    await call("session_send", { text: "q2" });
    expect(me.inbox).toHaveLength(1);
    expect(me.awaiting).toBe(true);
    sessionMode(clients, me, false, { focusTerminal: () => {} });
    expect(me.awaiting).toBe(false);
    expect(me.inbox).toEqual([]);
  });

  it("a person release (mode off) clears them too", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    clients.release(boardId, "person");
    expect(me.mode).toBe("pty");
    expect(me.awaiting).toBe(false);
  });

  it("without a live mod, session_send blocks as today and a reply resolves it", async () => {
    forward({ hook_event_name: "PreToolUse" });
    await call("session_mode", { on: true });
    expect(me.mode).toBe("inkwire");
    const pending = sessionSend(clients, me, sessions.open(boardId), { text: "q" });
    expect(me.pending).not.toBeNull();
    expect(me.awaiting).toBe(false);
    reply("a");
    expect(await pending).toMatchObject({ status: "reply", reply: "a" });
    expect(me.inbox).toEqual([]);
  });
});

describe("hook events from the mod and from forward.sh", () => {
  it("while the mod is live, a forward.sh event only rekeys: no hook report, no block count", async () => {
    await modOn();
    const report = me.hook;
    expect(forward({ hook_event_name: "Stop" })).toEqual({});
    expect(forward({ hook_event_name: "PreToolUse", permission_mode: "plan" })).toEqual({});
    expect(me.blocks).toBe(0);
    expect(me.hook).toBe(report);
    expect(forward({ hook_event_name: "SessionStart", source: "clear", session_id: "s2" })).toEqual({});
    expect(me.sessionId).toBe("s2");
    expect(me.hook).toBe(report);
  });

  it("when the mod goes, forward.sh events count again", async () => {
    await modOn();
    t += MOD_TTL_MS;
    expect(forward({ hook_event_name: "Stop" }).block).toBeTruthy();
    expect(me.blocks).toBe(1);
  });

  it("a mod SessionStart clear finds the Client by prev_session_id and rekeys it", () => {
    expect(modHook({ hook_event_name: "SessionStart", source: "clear", session_id: "s9", prev_session_id: "s1" })).toEqual({});
    expect(me.sessionId).toBe("s9");
    expect(clients.bySessionId("s9")).toBe(me);
    // A later mod event with the new id reaches the same Client.
    modHook({ hook_event_name: "PreToolUse", session_id: "s9", permission_mode: "plan" });
    expect(me.hook?.permissionMode).toBe("plan");
  });

  it("a mod SessionStart compact returns the context line", () => {
    expect(modHook({ hook_event_name: "SessionStart", source: "compact" }).context).toContain(`board ${boardId}`);
  });

  it("a forward.sh event with a pid sets the Client's session id to the event's", () => {
    me.sessionId = "launch";
    forward({ hook_event_name: "Stop", session_id: "s7" });
    expect(me.sessionId).toBe("s7");
  });

  it("a forward.sh UserPromptSubmit with no live mod also clears awaiting", async () => {
    await modOn();
    await call("session_send", { text: "q" });
    t += MOD_TTL_MS;
    expect(forward({ hook_event_name: "UserPromptSubmit" })).toEqual({});
    expect(me.awaiting).toBe(false);
  });
});
