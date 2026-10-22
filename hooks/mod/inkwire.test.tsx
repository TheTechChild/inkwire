// Tests of the inkwire mod. Run them with `yarn mod:test`: it copies the
// plugin manifest and hooks/ to a temp folder and runs `claude plugin test`
// there, because `claude plugin test .` also collects the vitest files in
// tests/. Each test stands for the engine and the daemon: the hooks the test
// registers with `on` answer $.http.fetch and the other calls.
import { expect, mock, test } from "claude-code/testing";
import type { On, SessionStartInput } from "claude-code";

const SESSION = "S1";
const PORT = "5999";

type Sent = { url: string; method: string; body: unknown };

const BOARD = {
  id: "b1",
  name: "checkout flow",
  state: {
    board: { id: "b1", name: "checkout flow", project_root: "/repo" },
    graph: {
      revision: 7,
      nodes: [
        { id: "n1", label: "cart", kind: "service" },
        { id: "n2", label: "payments", kind: "service" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", label: "charge", kind: "sync" }],
    },
    layers: [
      {
        id: "L1",
        letter: "A",
        title: "pay path",
        note: "",
        nodes: ["n1", "n2"],
        author: "ai",
        paths: [{ id: "P1", title: "charge", steps: [{ edge: "e1", caption: "cart asks payments to charge", ref: null }], author: "ai" }],
      },
    ],
    focus: "L1",
    drafts: [],
    active_draft: null,
    notebooks: [],
    active_notebook: null,
  },
  history: [{ id: "s1", index: 1, label: "add cart", author: "human", skipped: false, conflict: false, ahead: false, at: 1 }],
  session: {
    author: { pid: 4242, label: "shop", mode: "inkwire", pending: true, notice: null },
    readers: 1,
    released_from: null,
    thread: [
      { id: "t1", at: 1, type: "call", name: "canvas_add_node", text: "added cart" },
      { id: "t2", at: 2, type: "call", name: "canvas_add_edge", text: "added edge" },
      { id: "t3", at: 3, type: "claude", text: "Which way does **refund** go?" },
    ],
    highlight: null,
    trace: null,
  },
  daemon: { build_id: "b-1", stale: null },
};

function view(over: { inbox?: number; pending?: boolean } = {}) {
  return {
    key: `k-${over.inbox ?? 0}-${String(over.pending ?? true)}`,
    client: { pid: 4242, label: "shop", mode: "inkwire", awaiting: true, inbox: over.inbox ?? 0, current_board: "b1" },
    board: {
      ...BOARD,
      session: { ...BOARD.session, author: { ...BOARD.session.author, pending: over.pending ?? true } },
    },
  };
}

const PANE = {
  plugin: "inkwire",
  component: "Pane",
  requestId: "inkwire",
  props: {
    title: "inkwire",
    isFocused: true,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 140, rows: 40, isFullscreen: true },
} as const;

/**
 * The engine and the daemon beneath the mod. `daemon` answers each request by
 * its path; `sent` records every request.
 */
function engine(on: On, daemon: (path: string, body: unknown) => { status: number; text: string } | "down") {
  const sent: Sent[] = [];
  const opens: unknown[] = [];
  const session = { id: SESSION };
  const statuses: (string | undefined)[] = [];
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, { INKWIRE_PORT: PORT, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" });
  on("session.id", () => ({ value: session.id }));
  on("command.register", () => ({ value: { command: "inkwire" } }));
  on("ui.open", (_, e) => {
    opens.push(e);
    return { value: { isPlaced: true } };
  });
  on("ui.status", ($, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("http.fetch", ($, e) => {
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined;
    sent.push({ url: e.url, method: e.init?.method ?? "GET", body });
    const answer = daemon(new URL(e.url).pathname, body);
    if (answer === "down") throw new Error("connect ECONNREFUSED");
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: answer.text } };
  });
  return { sent, statuses, clock, opens, session };
}

/** Starts the session and lets the first view come back: the mod then knows the daemon has its routes. */
async function start($: { session: { start: (input: SessionStartInput) => Promise<unknown> } }, clock: { settle: () => Promise<unknown> }) {
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();
}

test("Stop: the block of the daemon joins the result of the settings hooks", async ($, on) => {
  const { sent, clock } = engine(on, (path) =>
    path === "/api/hook" ? { status: 200, text: "block\nanswer with session_send" } : { status: 200, text: JSON.stringify(view()) },
  );
  on("classic.Stop", () => ({}));
  await start($, clock);

  const result = await $.classic.Stop({ stop_hook_active: false, session_id: SESSION, permission_mode: "auto" });

  expect(result.block).toBe("answer with session_send");
  const hook = sent.find((s) => s.url.includes("/api/hook"));
  expect(hook?.url).toBe(`http://127.0.0.1:${PORT}/api/hook?via=mod&bg=0`);
  expect(hook?.body).toMatchObject({ hook_event_name: "Stop", session_id: SESSION, permission_mode: "auto" });
});

test("Stop: a block of the settings hooks stays, and the daemon's is added", async ($, on) => {
  const { clock } = engine(on, () => ({ status: 200, text: "block\ninkwire reason" }));
  on("classic.Stop", () => ({ block: "user reason" }));
  await start($, clock);

  const result = await $.classic.Stop({ stop_hook_active: false });

  expect(result.block).toBe("user reason\ninkwire reason");
});

test("Stop: a daemon that is down changes nothing", async ($, on) => {
  engine(on, () => "down");
  on("classic.Stop", () => ({}));

  const result = await $.classic.Stop({ stop_hook_active: false });

  expect(result.block).toBeUndefined();
});

test("SessionStart compact: the context of the daemon goes to the model", async ($, on) => {
  const { clock } = engine(on, (path) =>
    path === "/api/hook" ? { status: 200, text: 'context\nboard b1 "checkout flow" · you: author · mode: inkwire' } : { status: 200, text: JSON.stringify(view()) },
  );
  on("classic.SessionStart", () => ({ additionalContext: ["user note"] }));
  await start($, clock);

  const result = await $.classic.SessionStart({ source: "compact" });

  expect(result.additionalContext).toEqual(["user note", 'board b1 "checkout flow" · you: author · mode: inkwire']);
});

test("SessionStart clear: the mod sends the session id it knew before", async ($, on) => {
  const { sent, clock } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : { status: 200, text: "ok" }));
  on("classic.SessionStart", () => ({}));

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.classic.SessionStart({ source: "clear", session_id: "S2" });

  const hook = sent.find((s) => s.url.includes("/api/hook"));
  expect(hook?.body).toMatchObject({ hook_event_name: "SessionStart", source: "clear", session_id: "S2", prev_session_id: SESSION });
});

test("PreToolUse on session_mode: the mod sends the call with the session id", async ($, on) => {
  const { sent, clock } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : { status: 200, text: "ok" }));
  on("tool.call", () => ({ result: {} }));
  await start($, clock);

  await $.tool.call({ tool: "mcp__plugin_inkwire_inkwire__session_mode", mode: "inkwire" });

  const hook = sent.find((s) => s.url.includes("/api/hook"));
  expect(hook?.body).toMatchObject({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "mcp__plugin_inkwire_inkwire__session_mode",
    tool_input: { mode: "inkwire" },
  });
});

test("the view draws the pane, on the terminal and the desktop", async ($, on) => {
  const { clock, statuses } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : "down"));

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(statuses).toContain("inkwire · checkout flow · inkwire");

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ type: "Text", text: /INKWIRE MODE · WAITING ON YOU/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /shop · pid 4242 · inkwire · this session/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /2 calls: canvas_add_node, canvas_add_edge/ })).toBeDefined();
    expect(await ui.find({ type: "Markdown", text: /refund/ })).toBeDefined();
    expect(await ui.find({ type: "Input", key: "reply" })).toBeDefined();

    await ui.press({ key: "tab:layers" });
    expect(await ui.find({ key: "layer:L1" })).toBeDefined();
    await ui.press({ key: "path:P1" });
    expect(await ui.find({ type: "Text", text: /cart → payments/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /cart asks payments to charge/ })).toBeDefined();
    // The pane state stays for the session: close the path and go back.
    await ui.press({ key: "path:P1" });
    expect(await ui.find({ type: "Text", text: /cart → payments/ })).toBeUndefined();
    await ui.press({ key: "tab:session" });
    await ui.unmount();
  }
});

test("the daemon down: the pane says so", async ($, on) => {
  const { clock } = engine(on, () => "down");

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /does not answer on 127\.0\.0\.1:5999/ })).toBeDefined();
  await ui.unmount();
});

test("the reply box posts session_reply with the context ids", async ($, on) => {
  const { sent, clock } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view()) };
    if (path === "/api/mod/intent") return { status: 200, text: JSON.stringify({ ok: true }) };
    return "down";
  });

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.input({ key: "reply", text: "go left" });
    await ui.unmount();
  }

  const intents = sent.filter((s) => s.url.endsWith("/api/mod/intent"));
  expect(intents).toHaveLength(2);
  expect(intents[0]?.body).toEqual({
    session: SESSION,
    board: "b1",
    intent: { type: "session_reply", text: "go left", focus: "L1", selection: null, trace: null, draft: null, notebook: null },
  });
});

test("the reply box is closed while Claude Code works", async ($, on) => {
  const { clock } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view({ pending: false })) } : "down"));

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await ui.find({ type: "Input", key: "reply" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /CLAUDE CODE IS WORKING/ })).toBeDefined();
  await ui.unmount();
});

test("a reply in the inbox becomes the next prompt, as the person's words", async ($, on) => {
  const submitted: { text: string; asUser: unknown }[] = [];
  const { sent, clock } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left\ninkwire ctx: {}\nAnswer with session_send." }] }) };
    return "down";
  });
  on("prompt.submit", (_, e) => {
    submitted.push({ text: e.text, asUser: (e.origin as { asUser?: unknown }).asUser });
    return { text: e.text };
  });

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();

  expect(sent.find((s) => s.url.endsWith("/api/mod/take"))?.body).toEqual({ session: SESSION });
  expect(submitted).toEqual([{ text: "go left\ninkwire ctx: {}\nAnswer with session_send.", asUser: true }]);

  // Accepted: nothing waits in the pane.
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /waits? to go to Claude Code/ })).toBeUndefined();
  await ui.unmount();
});

test("a refused reply waits, and goes again from the pane", async ($, on) => {
  let refuse = true;
  const submitted: string[] = [];
  const { clock } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return "down";
  });
  on("prompt.submit", (_, e) => {
    submitted.push(e.text);
    return refuse ? { drop: "the person pressed Esc" } : { text: e.text };
  });

  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(submitted).toEqual(["go left"]);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /1 reply waits to go to Claude Code/ })).toBeDefined();
  refuse = false;
  await ui.press({ key: "outbox-send" });
  await clock.settle();
  expect(submitted).toEqual(["go left", "go left"]);
  expect(await ui.find({ type: "Text", text: /reply waits/ })).toBeUndefined();
  await ui.unmount();
});

test("an old daemon (no mod routes): the mod sends no hook event, so forward.sh alone counts it", async ($, on) => {
  const { sent, clock } = engine(on, () => ({ status: 404, text: "not found" }));
  on("classic.Stop", () => ({}));
  await start($, clock);

  await $.classic.Stop({ stop_hook_active: false, session_id: SESSION });

  expect(sent.some((s) => s.url.includes("/api/hook"))).toBe(false);
});

test("the view sends the launch id as the alias after /clear", async ($, on) => {
  const { sent, clock, session } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : { status: 200, text: "ok" }));
  on("classic.SessionStart", () => ({}));
  await start($, clock);
  session.id = "S2";
  await $.classic.SessionStart({ source: "clear", session_id: "S2" });
  await clock.settle();

  const last = sent.filter((s) => s.url.includes("/api/mod/view")).at(-1)!;
  const q = new URL(last.url).searchParams;
  expect(q.get("session")).toBe("S2");
  expect(q.get("alias")).toBe(SESSION);
});

test("a refused reply is not submitted again by itself; Discard removes it", async ($, on) => {
  const submitted: string[] = [];
  let inbox = 1;
  const { clock } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox })) };
    if (path === "/api/mod/take") {
      inbox = 0;
      return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    }
    return "down";
  });
  on("prompt.submit", (_, e) => {
    submitted.push(e.text);
    return { drop: "a hook refused it" };
  });
  on("turn.complete", () => ({ text: "" }));

  await start($, clock);
  await clock.advance(60_000);
  await clock.settle();
  await $.turn.complete({ answer: "", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
  expect(submitted).toEqual(["go left"]);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /1 reply waits to go to Claude Code/ })).toBeDefined();
  await ui.press({ key: "outbox-discard" });
  expect(await ui.find({ type: "Text", text: /reply waits/ })).toBeUndefined();
  await ui.unmount();
});

test("a queued reply shows no Discard, and leaves when UserPromptSubmit shows its text", async ($, on) => {
  const { clock } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return { status: 200, text: "ok" };
  });
  // Queued until the session is idle: the submit does not resolve in this test.
  on("prompt.submit", () => new Promise(() => {}));
  on("classic.UserPromptSubmit", () => ({}));

  await start($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /1 reply is queued/ })).toBeDefined();
  expect(await ui.find({ key: "outbox-discard" })).toBeUndefined();
  await $.classic.UserPromptSubmit({ prompt: "go left", session_id: SESSION });
  expect(await ui.find({ type: "Text", text: /queued/ })).toBeUndefined();
  await ui.unmount();
});

test("mode off clears the outbox", async ($, on) => {
  let mode = "inkwire";
  const { clock } = engine(on, (path) => {
    if (path === "/api/mod/view") {
      const v = view({ inbox: mode === "inkwire" ? 1 : 0 });
      return { status: 200, text: JSON.stringify({ ...v, key: `${v.key}-${mode}`, client: { ...v.client, mode } }) };
    }
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return "down";
  });
  on("prompt.submit", () => ({ drop: "the person pressed Esc" }));

  await start($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /1 reply waits/ })).toBeDefined();
  mode = "pty";
  await clock.advance(30_000);
  await clock.settle();
  expect(await ui.find({ type: "Text", text: /reply waits/ })).toBeUndefined();
  await ui.unmount();
});

test("the pane opens by itself only where the surface docks it", async ($, on) => {
  const { clock, opens } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : "down"));

  // The engine's own band beneath the plugins: nothing to draw.
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });

  await start($, clock);
  // Nothing said that the surface docks a pane: no unasked open.
  expect(opens).toEqual([]);

  const band = await $.ui.mount({
    plugin: "inkwire",
    component: "AbovePrompt",
    surface: "terminal",
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 } },
    viewport: { columns: 160, rows: 40, isFullscreen: true },
  } as never);
  await band.unmount();
  await clock.advance(30_000);
  await clock.settle();
  expect(opens).toHaveLength(1);
});
