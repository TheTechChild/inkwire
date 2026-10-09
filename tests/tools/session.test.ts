// Session handoff: session_mode / session_send over the real MCP server,
// the hook endpoint's decisions, and the thread they leave behind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../src/server/mcp.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { hookEvent, sessionMode, sessionReply } from "../../src/server/session-mode.js";
import { Sessions } from "../../src/server/session.js";
import { Clients, type Client as InkwireClient } from "../../src/server/clients.js";
import { Store } from "../../src/server/store.js";
import { toolBody } from "../helpers.js";

let client: Client;
let store: Store;
let sessions: Sessions;
let clients: Clients;
/** The one Client this server speaks for (pid 101). */
let me: InkwireClient;
let boardId: string;
let a: string;
let b: string;
const focused: (string | undefined)[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const raw = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  // The board context line and the notices come first (M3.5); res holds the body only.
  const head = raw.content[0]?.text ?? "";
  const res = { ...raw, content: toolBody(raw.content) };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { res, raw, head, text, json: () => JSON.parse(text) };
}

const armed = (permission_mode = "auto", bg = "0") =>
  hookEvent(clients, { hook_event_name: "PreToolUse", permission_mode, session_id: "s1", claude_pid: 101 }, bg);

beforeAll(async () => {
  store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-session-")));
  sessions = new Sessions(store, { debounceMs: 50, sendTimeoutMs: 80 });
  clients = new Clients(sessions);
  me = clients.ensure(101, { sessionId: "s1", cwd: "/work/repo" });
  clients.attach(101, "test");
  const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
  const mcp = buildMcpServer({
    sessions,
    clients,
    client: me,
    store,
    screenshots: () => screenshots,
    pluginRoot: "/repo",
    focusTerminal: (program) => focused.push(program),
    panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(st);
  await client.connect(ct);
  boardId = (await call("boards_create", { name: "session board", project_root: tmpdir() })).json().board_id;
  a = (await call("canvas_add_node", { label: "auth", kind: "service" })).json().ids[0];
  b = (await call("canvas_add_node", { label: "db", kind: "store" })).json().ids[0];
});

afterAll(async () => {
  await client.close();
  store.close();
});

describe("session_mode", () => {
  it("lists 46 tools with the two session tools registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(46);
    expect(names).toContain("session_mode");
    expect(names).toContain("session_send");
  });

  it("on fails with an install hint until a hook event proves the plugin is there", async () => {
    const r = await call("session_mode", { on: true });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("--plugin-dir /repo");
    expect(me.mode).toBe("pty");
  });

  it("on fails with a relaunch hint unless permission mode is auto and backgrounding is off", async () => {
    armed("default");
    let r = await call("session_mode", { on: true });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("--permission-mode auto");
    armed("auto", "unset");
    r = await call("session_mode", { on: true });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0");
    expect(me.mode).toBe("pty");
  });

  it("on flips the flag, carries the instruction, and records a call row; off releases and focuses the terminal", async () => {
    armed("bypassPermissions");
    const on = (await call("session_mode", { on: true })).json();
    expect(on).toMatchObject({ mode: "inkwire", hook: "Stop" });
    expect(on.instruction).toContain("session_send");
    expect(me.mode).toBe("inkwire");
    const thread = sessions.open(boardId).thread;
    expect(thread.at(-1)).toMatchObject({ type: "call", name: "session_mode" });

    const off = (await call("session_mode", { on: false })).json();
    expect(off).toMatchObject({ mode: "pty" });
    expect(me.mode).toBe("pty");
    expect(focused).toHaveLength(1);
  });
});

describe("session_send", () => {
  it("returns mode_off at once in pty mode and appends nothing", async () => {
    const before = sessions.open(boardId).thread.length;
    const r = (await call("session_send", { text: "hello?" })).json();
    expect(r.status).toBe("mode_off");
    expect(sessions.open(boardId).thread).toHaveLength(before);
  });

  it("blocks until the human replies; returns ids only; drops unknown highlight ids into warnings", async () => {
    armed();
    await call("session_mode", { on: true });
    const session = sessions.open(boardId);
    const pending = call("session_send", {
      text: "Look here.",
      highlight: { nodes: [a, "n_ghost"], edges: ["e_ghost"], label: "x".repeat(50) },
    });
    // The message and its highlight land before the reply.
    await new Promise((r) => setTimeout(r, 10));
    expect(me.pending).not.toBeNull();
    const msg = session.thread.at(-1)!;
    expect(msg).toMatchObject({ type: "claude", text: "Look here." });
    expect(msg.type === "claude" && msg.highlight).toEqual({ label: "x".repeat(40), nodes: [a], edges: [] });
    expect(session.highlight?.msgId).toBe(msg.id);

    sessionReply(clients, session, { text: "Why?", focus: null, selection: b });
    const r = (await pending).json();
    expect(r).toMatchObject({
      status: "reply",
      reply: "Why?",
      ctx: { focus: null, selection: b, revision: session.graphRevision },
    });
    expect(r.warnings).toEqual([
      "unknown node dropped from highlight: n_ghost",
      "unknown edge dropped from highlight: e_ghost",
    ]);
    expect(session.thread.at(-1)).toMatchObject({ type: "you", text: "Why?" });
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((c) => c.label)).toEqual([`${b} · db`, `rev ${session.graphRevision}`]);
    expect(me.pending).toBeNull();
  });

  it("a path pins the trace running and wins over the highlight; the reply's scrubber position comes back as ids", async () => {
    const session = sessions.open(boardId);
    const c = (await call("canvas_add_node", { label: "cache", kind: "store" })).json().ids[0];
    await call("canvas_add_edge", { from: a, to: b });
    await call("canvas_add_edge", { from: b, to: c });
    await call("canvas_add_edge", { from: c, to: a });
    const layerId = (await call("layers_create", { node_ids: [a, b, c], title: "loop" })).json().layer_id;
    expect((await call("paths_create", { layer_id: layerId, title: "round", nodes: [a, b, c, a] })).json().hops).toBe(3);

    const pending = call("session_send", {
      text: "Follow this.",
      highlight: { nodes: [a], edges: [], label: "here" },
      path: { layer_id: layerId, path_id: "P1" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const msg = session.thread.at(-1)!;
    expect(msg).toMatchObject({ type: "claude", text: "Follow this.", path: { layer_id: layerId, path_id: "P1" } });
    expect(session.trace).toMatchObject({ layer_id: layerId, path_id: "P1", running: true, loop: false, t: 0 });
    expect(session.highlight).toBeNull();

    sessionReply(clients, session, { text: "What is this hop?", focus: null, selection: null, trace: { path: "P1", hop: 2 } });
    const r = (await pending).json();
    expect(r.ctx).toEqual({ focus: null, selection: null, trace: { path: "P1", hop: 2 }, draft: null, notebook: null, revision: session.graphRevision });
    expect(r.warnings).toBeUndefined();
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toEqual(["P1 · hop 2/3", `rev ${session.graphRevision}`]);
  });

  it("an unknown path is dropped into warnings with no chip; a reply's hop clamps to the path, an unknown path is null", async () => {
    const session = sessions.open(boardId);
    const pending = call("session_send", { text: "Hmm.", path: { layer_id: "L_x", path_id: "P9" } });
    await new Promise((r) => setTimeout(r, 10));
    const msg = session.thread.at(-1)!;
    expect(msg.type === "claude" && msg.path).toBeUndefined();
    sessionReply(clients, session, { text: "ok", focus: null, selection: null, trace: { path: "P1", hop: 9 } });
    const r = (await pending).json();
    expect(r.warnings).toEqual(["unknown path dropped: P9"]);
    expect(r.ctx.trace).toEqual({ path: "P1", hop: 3 });

    const again = call("session_send", { text: "Still." });
    await new Promise((r) => setTimeout(r, 10));
    sessionReply(clients, session, { text: "ok", focus: null, selection: null, trace: { path: "P9", hop: 1 } });
    expect((await again).json().ctx.trace).toBeNull();
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toEqual([`rev ${session.graphRevision}`]);
  });

  it("a draft activates on send and shows a thread chip; unknown draft is dropped into warnings; a reply's draft comes back as ctx.draft", async () => {
    const session = sessions.open(boardId);
    const draftId = (await call("drafts_create", { title: "d" })).json().draft_id;

    const pending = call("session_send", { text: "About this change.", draft: draftId });
    await new Promise((r) => setTimeout(r, 10));
    const msg = session.thread.at(-1)!;
    expect(msg).toMatchObject({ type: "claude", text: "About this change.", draft: draftId });
    expect(session.activeDraft).toBe(draftId);

    sessionReply(clients, session, { text: "ok", focus: null, selection: null, draft: draftId });
    const r = (await pending).json();
    expect(r.ctx.draft).toBe(draftId);
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toContain(`${draftId} · d`);

    const pending2 = call("session_send", { text: "Hmm.", draft: "D9" });
    await new Promise((r) => setTimeout(r, 10));
    const dropped = session.thread.at(-1)!;
    expect(dropped.type === "claude" && dropped.draft).toBeUndefined();
    sessionReply(clients, session, { text: "ok", focus: null, selection: null });
    const r2 = (await pending2).json();
    expect(r2.warnings).toEqual(["unknown draft dropped: D9"]);
    expect(r2.ctx.draft).toBeNull();
  });

  it("a notebook opens on send and shows a thread chip; unknown notebook is dropped into warnings; a reply's notebook comes back as ctx.notebook", async () => {
    const session = sessions.open(boardId);
    const notebookId = (await call("notebooks_create", { title: "n" })).json().notebook_id;

    const pending = call("session_send", { text: "About this element.", notebook: notebookId });
    await new Promise((r) => setTimeout(r, 10));
    const msg = session.thread.at(-1)!;
    expect(msg).toMatchObject({ type: "claude", text: "About this element.", notebook: notebookId });
    expect(session.activeNotebook).toBe(notebookId);

    sessionReply(clients, session, { text: "ok", focus: null, selection: null, notebook: notebookId });
    const r = (await pending).json();
    expect(r.ctx.notebook).toBe(notebookId);
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toContain(`${notebookId} · n`);

    const pending2 = call("session_send", { text: "Hmm.", notebook: "N9" });
    await new Promise((r) => setTimeout(r, 10));
    const dropped = session.thread.at(-1)!;
    expect(dropped.type === "claude" && dropped.notebook).toBeUndefined();
    sessionReply(clients, session, { text: "ok", focus: null, selection: null });
    const r2 = (await pending2).json();
    expect(r2.warnings).toEqual(["unknown notebook dropped: N9"]);
    expect(r2.ctx.notebook).toBeNull();
  });

  it("a reply with nothing pending is rejected", () => {
    expect(() => sessionReply(clients, sessions.open(boardId), { text: "x", focus: null, selection: null })).toThrow(
      /no session_send is pending/,
    );
  });

  it("mode off releases a pending send with mode_off", async () => {
    const pending = call("session_send", { text: "still there?" });
    await new Promise((r) => setTimeout(r, 10));
    await call("session_mode", { on: false });
    expect((await pending).json()).toMatchObject({ status: "mode_off" });
  });

  it("times out to idle and flips the mode to pty with a notice", async () => {
    armed();
    await call("session_mode", { on: true });
    const r = (await call("session_send", { text: "anyone?" })).json();
    expect(r).toEqual({ status: "idle" });
    expect(me.mode).toBe("pty");
    expect(clients.noticeByBoard.get(boardId)).toContain("timed out");
  });
});

describe("hook endpoint", () => {
  it("Stop passes in pty, blocks in inkwire, and gives up after the ceiling", async () => {
    expect(hookEvent(clients, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0")).toEqual({});
    armed();
    await call("session_mode", { on: true });
    for (let i = 0; i < 3; i++) {
      const v = hookEvent(clients, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0");
      expect(v.block).toContain("session_send");
    }
    expect(hookEvent(clients, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0")).toEqual({});
    expect(me.mode).toBe("pty");
  });

  it("SessionStart compact returns the board context line, and the instruction only while the mode is on", async () => {
    const line = `board ${boardId} "session board" · you: author · mode: pty`;
    expect(hookEvent(clients, { hook_event_name: "SessionStart", source: "compact", session_id: "s1" }, "0")).toEqual({ context: line });
    armed();
    await call("session_mode", { on: true });
    const on = hookEvent(clients, { hook_event_name: "SessionStart", source: "compact", session_id: "s1" }, "0").context!;
    expect(on.split("\n")[0]).toBe(`board ${boardId} "session board" · you: author · mode: inkwire`);
    expect(on).toContain("session_send");
    expect(hookEvent(clients, { hook_event_name: "SessionStart", source: "startup", session_id: "s1" }, "0")).toEqual({});
    await call("session_mode", { on: false });
  });
});

describe("thread", () => {
  it("every other tool call folds in as a call row captioned by its mutation labels", async () => {
    const session = sessions.open(boardId);
    await call("canvas_add_edge", { from: a, to: b, label: "reads" });
    const row = session.thread.at(-1)!;
    expect(row).toMatchObject({ type: "call", name: "canvas_add_edge" });
    expect(row.type === "call" && row.text).toMatch(/^add_edge/);
    expect(row.type === "call" && row.json).toContain("graph_revision");
    await call("canvas_get_state");
    const read = session.thread.at(-1)!;
    expect(read).toMatchObject({ type: "call", name: "canvas_get_state", text: "no arguments" });
    expect(read.type === "call" && read.json).toBeUndefined();
  });

  it("highlight toggles by message id and rejects messages without one", () => {
    const session = sessions.open(boardId);
    const msg = session.thread.find((m) => m.type === "claude" && m.highlight)!;
    session.setHighlight(null);
    session.setHighlight(msg.id);
    expect(session.highlight?.msgId).toBe(msg.id);
    session.setHighlight(msg.id);
    expect(session.highlight).toBeNull();
    const plain = session.thread.find((m) => m.type === "call")!;
    expect(() => session.setHighlight(plain.id)).toThrow(/no highlight/);
  });
});

describe("review fixes", () => {
  it("a Stop from another Claude Code session passes through and does not count", async () => {
    armed();
    await call("session_mode", { on: true });
    expect(hookEvent(clients, { hook_event_name: "Stop", session_id: "other" }, "0")).toEqual({});
    expect(me.blocks).toBe(0);
    expect(hookEvent(clients, { hook_event_name: "Stop", session_id: "s1" }, "0").block).toBeTruthy();
    await call("session_mode", { on: false });
  });

  it("the block ceiling releases a stranded send", async () => {
    armed();
    await call("session_mode", { on: true });
    const pending = call("session_send", { text: "x" });
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 4; i++) hookEvent(clients, { hook_event_name: "Stop", session_id: "s1" }, "0");
    expect((await pending).json()).toEqual({ status: "idle" });
    expect(me.mode).toBe("pty");
  });

  it("a reply from a board that no Client talks on is rejected; deleting the board releases the send", async () => {
    armed();
    await call("session_mode", { on: true });
    const other = sessions.create("other", tmpdir());
    const pending = call("session_send", { text: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(() => sessionReply(clients, other, { text: "y", focus: null, selection: null })).toThrow(/no Claude Code session talks on this board/);
    expect(sessions.delete(boardId)).toBe(true);
    expect((await pending).json()).toEqual({ status: "idle" });
    expect(me.mode).toBe("pty");
    boardId = (await call("boards_create", { name: "session board 2", project_root: tmpdir() })).json().board_id;
    a = (await call("canvas_add_node", { label: "auth", kind: "service" })).json().ids[0];
  });

  it("captions survive the 200-entry log cap, and server notes reach the thread", async () => {
    const session = sessions.open(boardId);
    for (let i = 0; i < 205; i++) session.addLog("human", `filler ${i}`);
    await call("canvas_update_node", { node_id: a, label: "auth2" });
    const row = session.thread.at(-1)!;
    expect(row.type === "call" && row.text).toMatch(/^update_node/);
    // Rewind, then edit: the discarded-steps note is a server row in the thread.
    session.historyOp("rewind", 0, "all");
    await call("canvas_add_node", { label: "late", kind: "service" });
    expect(session.thread.some((m) => m.type === "call" && m.name === "server" && /discarded/.test(m.text))).toBe(true);
  });
});

describe("per-client state (M2)", () => {
  // A fresh daemon-like setup: one Sessions + Clients, one MCP server per Client.
  let s2: Sessions;
  let cs: Clients;
  let focus2: (string | undefined)[];
  const servers = new Map<number, Client>();

  const connect = async (pid: number, init: { sessionId?: string; termProgram?: string | null } = {}) => {
    const c = cs.ensure(pid, { cwd: `/work/p${pid}`, ...init });
    cs.attach(pid, `link-${pid}`);
    const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
    const mcp = buildMcpServer({
      sessions: s2,
      clients: cs,
      client: c,
      store,
      screenshots: () => screenshots,
      pluginRoot: "/repo",
      focusTerminal: (program) => focus2.push(program),
      panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mc = new Client({ name: `test-${pid}`, version: "0.0.0" });
    await mcp.connect(st);
    await mc.connect(ct);
    servers.set(pid, mc);
    return c;
  };
  const callAs = async (pid: number, name: string, args: Record<string, unknown> = {}) => {
    const raw = (await servers.get(pid)!.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    // The board context line and the notices come first (M3.5); res holds the body only.
    const head = raw.content[0]?.text ?? "";
    const res = { ...raw, content: toolBody(raw.content) };
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    return { res, raw, head, text, json: () => JSON.parse(text) };
  };
  const arm = (pid: number, session_id?: string) =>
    hookEvent(cs, { hook_event_name: "PreToolUse", permission_mode: "auto", session_id, claude_pid: pid }, "0");
  const newBoard = async (pid: number, name: string) =>
    (await callAs(pid, "boards_create", { name, project_root: tmpdir() })).json().board_id as string;

  beforeEach(() => {
    s2 = new Sessions(store, { debounceMs: 50, sendTimeoutMs: 5_000 });
    cs = new Clients(s2);
    focus2 = [];
    servers.clear();
  });

  afterEach(async () => {
    for (const c of cs.all()) if (c.mode === "inkwire") sessionMode(cs, c, false, { focusTerminal: () => {} });
    for (const mc of servers.values()) await mc.close();
  });

  it("a hook with claude_pid 202 does not arm Client 101", async () => {
    const c101 = await connect(101, { sessionId: "s101" });
    await newBoard(101, "m2 arm");
    arm(202, "s202");
    expect(c101.hook).toBeNull();
    expect(cs.get(202)?.hook).toMatchObject({ permissionMode: "auto", sessionId: "s202" });
    const r = await callAs(101, "session_mode", { on: true });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("--plugin-dir /repo");
    expect(c101.mode).toBe("pty");
  });

  it("SessionStart clear with a new id rekeys the Client, and the mode stays on", async () => {
    const c101 = await connect(101, { sessionId: "s1" });
    await newBoard(101, "m2 clear");
    arm(101, "s1");
    await callAs(101, "session_mode", { on: true });
    expect(hookEvent(cs, { hook_event_name: "SessionStart", source: "clear", session_id: "s2", claude_pid: 101 }, "0")).toEqual({});
    expect(c101.sessionId).toBe("s2");
    expect(cs.get(101)).toBe(c101);
    expect(c101.mode).toBe("inkwire");
    // With no pid, the new session id finds the Client.
    expect(hookEvent(cs, { hook_event_name: "Stop", session_id: "s2" }, "0").block).toContain("session_send");
    expect(hookEvent(cs, { hook_event_name: "Stop", session_id: "s1" }, "0")).toEqual({});
  });

  it("SessionStart resume with a new id rekeys the Client, and the mode stays on", async () => {
    const c101 = await connect(101, { sessionId: "s1" });
    await newBoard(101, "m2 resume");
    arm(101, "s1");
    await callAs(101, "session_mode", { on: true });
    expect(hookEvent(cs, { hook_event_name: "SessionStart", source: "resume", session_id: "s3", claude_pid: 101 }, "0")).toEqual({});
    expect(c101.sessionId).toBe("s3");
    expect(c101.mode).toBe("inkwire");
    expect(hookEvent(cs, { hook_event_name: "Stop", session_id: "s3" }, "0").block).toContain("session_send");
  });

  it("limit: with no claude pid, SessionStart clear cannot rekey, so later Stops with the new id go nowhere", async () => {
    // forward.sh found no claude ancestor: the hook routes by session_id only, and the new id matches no Client.
    const c101 = await connect(101, { sessionId: "s-old" });
    await newBoard(101, "m2 no pid");
    hookEvent(cs, { hook_event_name: "PreToolUse", permission_mode: "auto", session_id: "s-old", claude_pid: null }, "0");
    await callAs(101, "session_mode", { on: true });
    expect(c101.mode).toBe("inkwire");
    expect(hookEvent(cs, { hook_event_name: "SessionStart", source: "clear", session_id: "s-new", claude_pid: null }, "0")).toEqual({});
    expect(c101.sessionId).toBe("s-old");
    expect(hookEvent(cs, { hook_event_name: "Stop", session_id: "s-new", claude_pid: null }, "0")).toEqual({});
    expect(c101.blocks).toBe(0);
  });

  it("in inkwire mode, boards_open of B keeps A current, and session_mode(on) or a new board fails", async () => {
    const c101 = await connect(101);
    const y = await newBoard(101, "m2 other B");
    const x = await newBoard(101, "m2 talk A");
    expect(cs.authorOf(x)).toBe(101);
    expect(cs.authorOf(y)).toBeNull();
    arm(101);
    await callAs(101, "session_mode", { on: true });
    expect(cs.talkingOn(x)).toBe(c101);

    // Open does not move a talking Author: B's state comes back, the current board stays A.
    const opened = await callAs(101, "boards_open", { board_id: y });
    expect(opened.res.isError).toBeFalsy();
    expect(opened.res.content[1]?.text).toBe(
      `You are the author of ${x}. Your current board is still ${x}. You are talking with the person on ${x}. Turn the mode off before you move to a different board.`,
    );
    expect(c101.currentBoardId).toBe(x);
    const pending = callAs(101, "session_send", { text: "still on A" });
    await new Promise((r) => setTimeout(r, 10));
    expect(c101.pending?.boardId).toBe(x);
    sessionReply(cs, s2.open(x), { text: "ok", focus: null, selection: null });
    expect((await pending).json()).toMatchObject({ status: "reply", reply: "ok" });

    // M3.5: a new board would claim it, so boards_create fails, and A stays authored, current and talking.
    const refused = await callAs(101, "boards_create", { name: "m2 new C", project_root: tmpdir() });
    expect(refused.res.isError).toBe(true);
    expect(refused.text).toContain(`You are talking with the person on ${x}. Turn the mode off before you move to a different board.`);
    expect(c101.currentBoardId).toBe(x);
    expect(cs.authorOf(x)).toBe(101);
    expect(cs.talkingOn(x)).toBe(c101);
    expect(s2.open(x).thread.some((m) => m.type === "call" && /authorship released/.test(m.text))).toBe(false);

    // In pty mode, boards_open still does not move an Author; it says how to move.
    await callAs(101, "session_mode", { on: false });
    const again = await callAs(101, "boards_open", { board_id: y });
    expect(again.res.content[1]?.text).toBe(
      `You are the author of ${x}. Your current board is still ${x}. A write to ${y} moves you to ${y} and releases ${x}.`,
    );
    expect(c101.currentBoardId).toBe(x);
  });

  it("SessionStart compact re-injects the instruction only for the talking Client", async () => {
    await connect(101);
    await connect(202);
    await newBoard(101, "m2 compact");
    arm(101);
    arm(202);
    await callAs(101, "session_mode", { on: true });
    // 202 gets its board context line only; 101 also gets the instruction.
    expect(hookEvent(cs, { hook_event_name: "SessionStart", source: "compact", claude_pid: 202 }, "0")).toEqual({ context: "board: none · mode: pty" });
    expect(hookEvent(cs, { hook_event_name: "SessionStart", source: "compact", claude_pid: 101 }, "0").context).toContain("session_send");
  });

  it("mode off of Client B does not resolve the pending send of Client A; B cannot talk on A's board", async () => {
    const a1 = await connect(101);
    const b1 = await connect(202);
    const x = await newBoard(101, "m2 board A");
    arm(101);
    arm(202);
    await callAs(101, "session_mode", { on: true });
    expect(cs.authorOf(x)).toBe(101);
    const pending = callAs(101, "session_send", { text: "waiting" });
    await new Promise((r) => setTimeout(r, 10));
    expect(a1.pending).not.toBeNull();

    // B on A's board: the mode stays off and names the Author.
    await callAs(202, "boards_open", { board_id: x });
    const refused = await callAs(202, "session_mode", { on: true });
    expect(refused.res.isError).toBe(true);
    expect(refused.text).toContain("pid 101");
    expect(b1.mode).toBe("pty");
    expect(cs.talkingOn(x)).toBe(a1);

    // B on its own board: on, then off. A's send is still pending.
    await newBoard(202, "m2 board B");
    expect((await callAs(202, "session_mode", { on: true })).json().mode).toBe("inkwire");
    await callAs(202, "session_mode", { on: false });
    expect(b1.mode).toBe("pty");
    expect(a1.pending).not.toBeNull();
    expect(a1.mode).toBe("inkwire");

    sessionReply(cs, s2.open(x), { text: "here", focus: null, selection: null });
    expect((await pending).json()).toMatchObject({ status: "reply", reply: "here" });
  });

  it("a board delete during a pending send returns idle and sets the notice of that board", async () => {
    const a1 = await connect(101);
    const x = await newBoard(101, "m2 delete pending");
    arm(101);
    await callAs(101, "session_mode", { on: true });
    const pending = callAs(101, "session_send", { text: "waiting" });
    await new Promise((r) => setTimeout(r, 10));
    const notices: (string | undefined)[] = [];
    cs.onChange(() => notices.push(cs.noticeByBoard.get(x)));
    expect(s2.delete(x)).toBe(true);
    expect((await pending).json()).toEqual({ status: "idle" });
    expect(a1.mode).toBe("pty");
    expect(a1.pending).toBeNull();
    // The panels are told the notice; after that the deleted board keeps no entry.
    expect(notices).toContain("board deleted · mode pty");
    expect(cs.noticeByBoard.has(x)).toBe(false);
    expect(cs.authorOf(x)).toBeNull();
  });

  it("a reader whose current board is deleted gets no board is open on its next call with no board_id", async () => {
    await connect(101);
    const reader = await connect(202);
    const x = await newBoard(101, "m2 delete reader");
    await callAs(202, "boards_open", { board_id: x });
    expect(reader.currentBoardId).toBe(x);
    await callAs(101, "boards_delete", { board_id: x });
    expect(reader.currentBoardId).toBeNull();
    expect(cs.readerCount(x)).toBe(0);
    const r = await callAs(202, "canvas_get_state");
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("no board is open");
  });

  it("session_mode(off) from a Client that authors no board writes no Thread row", async () => {
    await connect(101);
    await connect(202);
    const x = await newBoard(101, "m2 reader off");
    arm(101);
    await callAs(101, "session_mode", { on: true });
    await callAs(202, "boards_open", { board_id: x });
    const before = s2.open(x).thread.length;
    expect((await callAs(202, "session_mode", { on: false })).json().mode).toBe("pty");
    expect(s2.open(x).thread).toHaveLength(before);
    // A refused session_mode(on) writes no row either.
    arm(202);
    expect((await callAs(202, "session_mode", { on: true })).res.isError).toBe(true);
    expect(s2.open(x).thread).toHaveLength(before);
  });

  it("mode off focuses the Client's terminal app; a Client with no termProgram uses the daemon env", async () => {
    const saved = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "Apple_Terminal";
    try {
      await connect(101, { termProgram: "iTerm.app" });
      await connect(202, { termProgram: null });
      await newBoard(101, "m2 focus");
      arm(101);
      await callAs(101, "session_mode", { on: true });
      await callAs(101, "session_mode", { on: false });
      await callAs(202, "session_mode", { on: false });
      expect(focus2).toEqual(["iTerm.app", "Apple_Terminal"]);
    } finally {
      if (saved === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = saved;
    }
  });
});
