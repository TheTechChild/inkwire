// Session handoff: session_mode / session_send over the real MCP server,
// the hook endpoint's decisions, and the thread they leave behind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../src/server/mcp.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { hookEvent, sessionReply } from "../../src/server/session-mode.js";
import { Sessions } from "../../src/server/session.js";
import { Store } from "../../src/server/store.js";

let client: Client;
let store: Store;
let sessions: Sessions;
let boardId: string;
let a: string;
let b: string;
const focused: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { res, text, json: () => JSON.parse(text) };
}

const armed = (permission_mode = "auto", bg = "0") =>
  hookEvent(sessions, { hook_event_name: "PreToolUse", permission_mode, session_id: "s1" }, bg);

beforeAll(async () => {
  store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-session-")));
  sessions = new Sessions(store, { debounceMs: 50, sendTimeoutMs: 80 });
  const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
  const mcp = buildMcpServer({
    sessions,
    store,
    screenshots: () => screenshots,
    projectRoot: tmpdir(),
    pluginRoot: "/repo",
    focusTerminal: () => focused.push("focus"),
    panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(st);
  await client.connect(ct);
  boardId = (await call("boards_create", { name: "session board" })).json().board_id;
  a = (await call("canvas_add_node", { label: "auth", kind: "service" })).json().ids[0];
  b = (await call("canvas_add_node", { label: "db", kind: "store" })).json().ids[0];
});

afterAll(async () => {
  await client.close();
  store.close();
});

describe("session_mode", () => {
  it("lists 43 tools with the two session tools registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(43);
    expect(names).toContain("session_mode");
    expect(names).toContain("session_send");
  });

  it("on fails with an install hint until a hook event proves the plugin is there", async () => {
    const r = await call("session_mode", { on: true });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("--plugin-dir /repo");
    expect(sessions.mode).toBe("pty");
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
    expect(sessions.mode).toBe("pty");
  });

  it("on flips the flag, carries the instruction, and records a call row; off releases and focuses the terminal", async () => {
    armed("bypassPermissions");
    const on = (await call("session_mode", { on: true })).json();
    expect(on).toMatchObject({ mode: "inkwire", hook: "Stop" });
    expect(on.instruction).toContain("session_send");
    expect(sessions.mode).toBe("inkwire");
    const thread = sessions.open(boardId).thread;
    expect(thread.at(-1)).toMatchObject({ type: "call", name: "session_mode" });

    const off = (await call("session_mode", { on: false })).json();
    expect(off).toMatchObject({ mode: "pty" });
    expect(sessions.mode).toBe("pty");
    expect(focused).toEqual(["focus"]);
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
    expect(sessions.pending).not.toBeNull();
    const msg = session.thread.at(-1)!;
    expect(msg).toMatchObject({ type: "claude", text: "Look here." });
    expect(msg.type === "claude" && msg.highlight).toEqual({ label: "x".repeat(40), nodes: [a], edges: [] });
    expect(session.highlight?.msgId).toBe(msg.id);

    sessionReply(sessions, session, { text: "Why?", focus: null, selection: b });
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
    expect(sessions.pending).toBeNull();
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

    sessionReply(sessions, session, { text: "What is this hop?", focus: null, selection: null, trace: { path: "P1", hop: 2 } });
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
    sessionReply(sessions, session, { text: "ok", focus: null, selection: null, trace: { path: "P1", hop: 9 } });
    const r = (await pending).json();
    expect(r.warnings).toEqual(["unknown path dropped: P9"]);
    expect(r.ctx.trace).toEqual({ path: "P1", hop: 3 });

    const again = call("session_send", { text: "Still." });
    await new Promise((r) => setTimeout(r, 10));
    sessionReply(sessions, session, { text: "ok", focus: null, selection: null, trace: { path: "P9", hop: 1 } });
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

    sessionReply(sessions, session, { text: "ok", focus: null, selection: null, draft: draftId });
    const r = (await pending).json();
    expect(r.ctx.draft).toBe(draftId);
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toContain(`${draftId} · d`);

    const pending2 = call("session_send", { text: "Hmm.", draft: "D9" });
    await new Promise((r) => setTimeout(r, 10));
    const dropped = session.thread.at(-1)!;
    expect(dropped.type === "claude" && dropped.draft).toBeUndefined();
    sessionReply(sessions, session, { text: "ok", focus: null, selection: null });
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

    sessionReply(sessions, session, { text: "ok", focus: null, selection: null, notebook: notebookId });
    const r = (await pending).json();
    expect(r.ctx.notebook).toBe(notebookId);
    const you = session.thread.at(-1)!;
    expect(you.type === "you" && you.ctx.map((x) => x.label)).toContain(`${notebookId} · n`);

    const pending2 = call("session_send", { text: "Hmm.", notebook: "N9" });
    await new Promise((r) => setTimeout(r, 10));
    const dropped = session.thread.at(-1)!;
    expect(dropped.type === "claude" && dropped.notebook).toBeUndefined();
    sessionReply(sessions, session, { text: "ok", focus: null, selection: null });
    const r2 = (await pending2).json();
    expect(r2.warnings).toEqual(["unknown notebook dropped: N9"]);
    expect(r2.ctx.notebook).toBeNull();
  });

  it("a reply with nothing pending is rejected", () => {
    expect(() => sessionReply(sessions, sessions.open(boardId), { text: "x", focus: null, selection: null })).toThrow(
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
    expect(sessions.mode).toBe("pty");
    expect(sessions.notice).toContain("timed out");
  });
});

describe("hook endpoint", () => {
  it("Stop passes in pty, blocks in inkwire, and gives up after the ceiling", async () => {
    expect(hookEvent(sessions, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0")).toEqual({});
    armed();
    await call("session_mode", { on: true });
    for (let i = 0; i < 3; i++) {
      const v = hookEvent(sessions, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0");
      expect(v.block).toContain("session_send");
    }
    expect(hookEvent(sessions, { hook_event_name: "Stop", permission_mode: "auto", session_id: "s1" }, "0")).toEqual({});
    expect(sessions.mode).toBe("pty");
  });

  it("SessionStart compact re-injects the instruction only while the mode is on", async () => {
    expect(hookEvent(sessions, { hook_event_name: "SessionStart", source: "compact", session_id: "s1" }, "0")).toEqual({});
    armed();
    await call("session_mode", { on: true });
    expect(hookEvent(sessions, { hook_event_name: "SessionStart", source: "compact", session_id: "s1" }, "0").context).toContain("session_send");
    expect(hookEvent(sessions, { hook_event_name: "SessionStart", source: "startup", session_id: "s1" }, "0")).toEqual({});
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
    expect(hookEvent(sessions, { hook_event_name: "Stop", session_id: "other" }, "0")).toEqual({});
    expect(sessions.blocks).toBe(0);
    expect(hookEvent(sessions, { hook_event_name: "Stop", session_id: "s1" }, "0").block).toBeTruthy();
    await call("session_mode", { on: false });
  });

  it("the block ceiling releases a stranded send", async () => {
    armed();
    await call("session_mode", { on: true });
    const pending = call("session_send", { text: "x" });
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 4; i++) hookEvent(sessions, { hook_event_name: "Stop", session_id: "s1" }, "0");
    expect((await pending).json()).toEqual({ status: "idle" });
    expect(sessions.mode).toBe("pty");
  });

  it("a reply from another board is rejected; deleting the board releases the send", async () => {
    armed();
    await call("session_mode", { on: true });
    const other = sessions.create("other");
    const pending = call("session_send", { text: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(() => sessionReply(sessions, other, { text: "y", focus: null, selection: null })).toThrow(/on board/);
    expect(sessions.delete(boardId)).toBe(true);
    expect((await pending).json()).toEqual({ status: "idle" });
    expect(sessions.mode).toBe("pty");
    boardId = (await call("boards_create", { name: "session board 2" })).json().board_id;
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
