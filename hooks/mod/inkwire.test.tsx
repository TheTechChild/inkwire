// Tests of the inkwire mod. Run them with `yarn mod:test`: it copies the
// plugin manifest and hooks/ to a temp folder and runs `claude plugin test`
// there, because `claude plugin test .` also collects the vitest files in
// tests/. Each test stands for the engine and the daemon: the hooks the test
// registers with `on` answer $.http.fetch and the other calls.
import { expect, mock, test } from "claude-code/testing";
import type { On, SessionStartInput } from "claude-code";
import type { InkwireView } from "./contract";
import { statusText } from "./live";

const SESSION = "S1";
const PORT = "5999";

type Sent = { url: string; method: string; body: unknown };

function view(over: { inbox?: number; pending?: boolean; mode?: "pty" | "inkwire"; awaiting?: boolean } = {}): InkwireView {
  const mode = over.mode ?? "inkwire";
  const pending = over.pending ?? true;
  return {
    key: `k-${over.inbox ?? 0}-${String(pending)}-${mode}-${String(over.awaiting ?? pending)}`,
    client: { pid: 4242, label: "shop", mode, awaiting: over.awaiting ?? pending, inbox: over.inbox ?? 0, current_board: "b1" },
    board: { id: "b1", name: "checkout flow", author: { pid: 4242, label: "shop", mode, pending, notice: null } },
  };
}

/**
 * The engine and the daemon beneath the mod. `daemon` answers each request by
 * its path; `sent` records every request; `statuses` every status line.
 */
function engine(on: On, daemon: (path: string, body: unknown) => { status: number; text: string } | "down") {
  const sent: Sent[] = [];
  const session = { id: SESSION };
  const statuses: (string | undefined)[] = [];
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, { INKWIRE_PORT: PORT, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" });
  on("session.id", () => ({ value: session.id }));
  on("command.register", () => ({ value: { command: "inkwire" } }));
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
  return { sent, statuses, clock, session };
}

/** Starts the session and lets the first view come back: the mod then knows the daemon has its routes. */
async function start($: { session: { start: (input: SessionStartInput) => Promise<unknown> } }, clock: { settle: () => Promise<unknown> }) {
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await clock.settle();
}

test("statusText: one short line for each state", async () => {
  expect(statusText(null, [])).toBe("inkwire · daemon not reachable");
  expect(statusText("old", [])).toBe("inkwire · daemon is older than the mod · restart it in the panel");
  expect(statusText({ key: "k", client: null, board: null }, [])).toBe("inkwire · not linked");
  const v = view();
  expect(statusText({ ...v, board: null }, [])).toBe("inkwire · no board");
  expect(statusText(view({ mode: "pty", pending: false }), [])).toBe("inkwire · checkout flow · pty");
  expect(statusText(view({ pending: false }), [])).toBe("inkwire · checkout flow · claude is working");
  expect(statusText(view({ pending: true }), [])).toBe("inkwire · checkout flow · waiting on you");
  // The blocking model: the Author push is pending, the Client does not await.
  expect(statusText(view({ pending: true, awaiting: false }), [])).toBe("inkwire · checkout flow · waiting on you");
  // The pending flag of another Author does not wait on this session.
  const other = view({ pending: true, awaiting: false });
  other.board!.author!.pid = 7;
  expect(statusText(other, [])).toBe("inkwire · checkout flow · claude is working");
  expect(statusText(view({ pending: false }), [{ id: "r1", prompt: "go", sentAt: 1, turn: 0 }])).toBe("inkwire · checkout flow · reply queued");
  expect(statusText(view({ pending: false }), [{ id: "r1", prompt: "go", sentAt: 1, turn: 0, drop: "Esc" }])).toBe(
    "inkwire · checkout flow · reply refused · /inkwire send",
  );
});

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

  await start($, clock);
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

test("an old daemon (no mod routes): the mod sends no hook event, so forward.sh alone counts it", async ($, on) => {
  const { sent, clock } = engine(on, () => ({ status: 404, text: "not found" }));
  on("classic.Stop", () => ({}));
  await start($, clock);

  await $.classic.Stop({ stop_hook_active: false, session_id: SESSION });

  expect(sent.some((s) => s.url.includes("/api/hook"))).toBe(false);
});

test("an old daemon (a 404 view): the status line and /inkwire say so, with the panel URL", async ($, on) => {
  const { clock, statuses } = engine(on, () => ({ status: 404, text: "not found" }));
  await start($, clock);

  expect(statuses.at(-1)).toBe("inkwire · daemon is older than the mod · restart it in the panel");
  const result = await $.command.run({ command: "inkwire", args: "" });
  expect(result.text).toBe(`inkwire · daemon is older than the mod · restart it in the panel\nBrowser panel: http://127.0.0.1:${PORT}/`);
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

test("the status line follows the view", async ($, on) => {
  let current = view({ pending: false });
  const { clock, statuses } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(current) } : "down"));

  await start($, clock);
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · claude is working");

  current = view({ pending: true });
  await clock.advance(30_000);
  await clock.settle();
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · waiting on you");

  current = { ...view(), client: null, board: null, key: "none" };
  await clock.advance(30_000);
  await clock.settle();
  expect(statuses.at(-1)).toBe("inkwire · not linked");
});

test("the daemon down: the status line says so", async ($, on) => {
  const { clock, statuses } = engine(on, () => "down");

  await start($, clock);

  expect(statuses.at(-1)).toBe("inkwire · daemon not reachable");
});

test("a reply in the inbox becomes the next prompt, as the person's words", async ($, on) => {
  const submitted: { text: string; asUser: unknown }[] = [];
  const { sent, clock, statuses } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left\ninkwire ctx: {}\nAnswer with session_send." }] }) };
    return "down";
  });
  on("prompt.submit", (_, e) => {
    submitted.push({ text: e.text, asUser: (e.origin as { asUser?: unknown }).asUser });
    return { text: e.text };
  });

  await start($, clock);

  expect(sent.find((s) => s.url.endsWith("/api/mod/take"))?.body).toEqual({ session: SESSION });
  expect(submitted).toEqual([{ text: "go left\ninkwire ctx: {}\nAnswer with session_send.", asUser: true }]);
  // Accepted: nothing waits in the outbox.
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · waiting on you");
  expect(statuses).toContain("inkwire · checkout flow · reply queued");
});

test("a queued reply shows in the status line, and leaves when UserPromptSubmit shows its text", async ($, on) => {
  const { clock, statuses } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return { status: 200, text: "ok" };
  });
  // Queued until the session is idle: the submit does not resolve in this test.
  on("prompt.submit", () => new Promise(() => {}));
  on("classic.UserPromptSubmit", () => ({}));

  await start($, clock);
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · reply queued");
  // A queued reply is not refused: discard does not take it back.
  expect((await $.command.run({ command: "inkwire", args: "discard" })).text).toBe("inkwire · no refused reply to discard");

  await $.classic.UserPromptSubmit({ prompt: "go left", session_id: SESSION });
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · waiting on you");
});

test("a refused reply waits, and /inkwire send submits it again", async ($, on) => {
  let refuse = true;
  const submitted: string[] = [];
  const { clock, statuses } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: 1 })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return "down";
  });
  on("prompt.submit", (_, e) => {
    submitted.push(e.text);
    return refuse ? { drop: "the person pressed Esc" } : { text: e.text };
  });

  await start($, clock);
  expect(submitted).toEqual(["go left"]);
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · reply refused · /inkwire send");

  refuse = false;
  const sent = await $.command.run({ command: "inkwire", args: "send" });
  await clock.settle();
  expect(sent.text).toBe("inkwire · sent 1 reply again");
  expect(submitted).toEqual(["go left", "go left"]);
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · waiting on you");
  expect((await $.command.run({ command: "inkwire", args: "send" })).text).toBe("inkwire · no refused reply to send");
});

test("a refused reply is not submitted again by itself; /inkwire discard removes it", async ($, on) => {
  const submitted: string[] = [];
  let inbox = 1;
  const { clock, statuses } = engine(on, (path) => {
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
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · reply refused · /inkwire send");

  const plain = await $.command.run({ command: "inkwire", args: "" });
  expect(plain.text).toContain("1 reply refused (a hook refused it)");

  const discarded = await $.command.run({ command: "inkwire", args: "discard" });
  expect(discarded.text).toBe("inkwire · discarded 1 reply");
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · waiting on you");
});

test("mode off clears the outbox", async ($, on) => {
  let mode: "pty" | "inkwire" = "inkwire";
  const { clock, statuses } = engine(on, (path) => {
    if (path === "/api/mod/view") return { status: 200, text: JSON.stringify(view({ inbox: mode === "inkwire" ? 1 : 0, mode, pending: mode === "inkwire" })) };
    if (path === "/api/mod/take") return { status: 200, text: JSON.stringify({ replies: [{ id: "r1", prompt: "go left" }] }) };
    return "down";
  });
  on("prompt.submit", () => ({ drop: "the person pressed Esc" }));

  await start($, clock);
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · reply refused · /inkwire send");
  mode = "pty";
  await clock.advance(30_000);
  await clock.settle();
  expect(statuses.at(-1)).toBe("inkwire · checkout flow · pty");
});

test("/inkwire: the status line text and the browser panel URL, with no turn", async ($, on) => {
  const { clock } = engine(on, (path) => (path === "/api/mod/view" ? { status: 200, text: JSON.stringify(view()) } : "down"));
  await start($, clock);

  const result = await $.command.run({ command: "inkwire", args: "" });

  expect(result.text).toBe(`inkwire · checkout flow · waiting on you\nBrowser panel: http://127.0.0.1:${PORT}/?board=b1`);
  expect((await $.command.run({ command: "inkwire", args: "what" })).text).toMatch(/^Usage: \/inkwire/);
});

test("/inkwire with the daemon down says so", async ($, on) => {
  const { clock } = engine(on, () => "down");
  await start($, clock);

  const result = await $.command.run({ command: "inkwire", args: "" });

  expect(result.text).toBe("inkwire · daemon not reachable");
});
