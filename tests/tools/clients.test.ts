// Clients (M2.2): one record per Claude Code pid, its links, the hook-only TTL,
// and the Author of each board.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Clients, HOOK_ONLY_TTL_MS, type Client, type ReleaseReason } from "../../src/server/clients.js";
import { hookEvent, sessionSend } from "../../src/server/session-mode.js";
import { Sessions } from "../../src/server/session.js";
import { Store } from "../../src/server/store.js";

const store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-clients-")));
let clock = 0;
let sessions: Sessions;
let clients: Clients;

const board = (name = "b") => sessions.create(name, tmpdir()).boardId;
const hello = (pid: number, link = `link-${pid}`, cwd = `/work/repo${pid}`) => {
  const c = clients.ensure(pid, { cwd, sessionId: `s${pid}` });
  clients.attach(pid, link);
  return c;
};

beforeEach(() => {
  clock = 1_000;
  sessions = new Sessions(store, { now: () => clock });
  clients = new Clients(sessions);
});

afterAll(() => store.close());

describe("records", () => {
  it("a hook then a hello merge into one record; the hello fills the missing fields", () => {
    const fromHook = clients.ensure(101, { sessionId: "s1" });
    expect(fromHook).toMatchObject({ pid: 101, sessionId: "s1", cwd: "", termProgram: null, mode: "pty", currentBoardId: null });
    const fromHello = clients.ensure(101, { sessionId: "other", cwd: "/work/content-collections", termProgram: "iTerm.app" });
    clients.attach(101, "l1");
    expect(fromHello).toBe(fromHook);
    expect(fromHello).toMatchObject({ sessionId: "s1", cwd: "/work/content-collections", label: "content-collections", termProgram: "iTerm.app" });
    expect(clients.all()).toHaveLength(1);
  });

  it("rekey keeps the pid and the record; bySessionId finds the new id only", () => {
    const c = hello(101);
    clients.rekey(101, "s-new");
    expect(clients.get(101)).toBe(c);
    expect(c.sessionId).toBe("s-new");
    expect(clients.bySessionId("s-new")).toBe(c);
    expect(clients.bySessionId("s101")).toBeUndefined();
  });

  it("remove releases authorship", () => {
    const c = hello(101);
    const x = board();
    clients.commitClaim(c, x);
    expect(clients.authorOf(x)).toBe(101);
    expect(clients.remove(101)).toBe(c);
    expect(clients.authorOf(x)).toBeNull();
    expect(clients.get(101)).toBeUndefined();
  });

  it("a hook-only record with no hello goes after the TTL; a hello before the TTL keeps it", () => {
    clients.ensure(101);
    clients.ensure(202);
    clock += HOOK_ONLY_TTL_MS - 1;
    hello(202);
    expect(clients.get(101)).toBeDefined();
    clock += 1;
    expect(clients.get(101)).toBeUndefined();
    expect(clients.get(202)).toBeDefined();
    clock += 10 * HOOK_ONLY_TTL_MS;
    expect(clients.get(202)).toBeDefined();
    // A later process with the same pid gets a fresh record.
    expect(clients.ensure(101).sessionId).toBeNull();
  });

  it("two links for one pid keep the Client until the second detach", () => {
    const c = hello(101, "l1");
    clients.attach(101, "l2");
    expect(clients.detach(101, "l1")).toBeNull();
    expect(clients.get(101)).toBe(c);
    expect(clients.detach(101, "l2")).toBe(c);
    expect(clients.get(101)).toBeUndefined();
  });

  it("a detach of an old link after a newer hello does not remove the Client", () => {
    hello(101, "old");
    clients.detach(101, "old");
    const fresh = hello(101, "new");
    expect(clients.detach(101, "old")).toBeNull();
    expect(clients.get(101)).toBe(fresh);
  });
});

describe("authorship", () => {
  it("a claim on an unclaimed board makes the Client its Author", () => {
    const c = hello(101);
    const x = board();
    expect(clients.authorOf(x)).toBeNull();
    clients.checkWrite(c, x);
    clients.commitClaim(c, x);
    expect(clients.authorOf(x)).toBe(101);
    expect(clients.authoredBy(c)).toBe(x);
  });

  it("a claim of B releases A", () => {
    const c = hello(101);
    const [a, b] = [board("A"), board("B")];
    clients.commitClaim(c, a);
    clients.commitClaim(c, b);
    expect(clients.authorOf(a)).toBeNull();
    expect(clients.authorOf(b)).toBe(101);
  });

  it("checkWrite on another Author's board throws and names the Author; A stays claimed", () => {
    const c1 = hello(101, "l", "/work/content-collections");
    const c2 = hello(202);
    const [a, b] = [board("A"), board("B")];
    clients.commitClaim(c1, b);
    clients.commitClaim(c2, a);
    expect(() => clients.checkWrite(c2, b)).toThrow(/content-collections · pid 101.*release it in the panel/);
    expect(() => clients.commitClaim(c2, b)).toThrow(/pid 101/);
    expect(clients.authorOf(a)).toBe(202);
    expect(clients.authorOf(b)).toBe(101);
  });

  it("readerCount does not count the Author", () => {
    const [c1, c2, c3] = [hello(101), hello(202), hello(303)];
    const x = board();
    for (const c of [c1, c2, c3]) c.currentBoardId = x;
    clients.commitClaim(c1, x);
    expect(clients.readerCount(x)).toBe(2);
  });

  it("talkingOn is null unless the Author is in inkwire mode", () => {
    const [c1, c2] = [hello(101), hello(202)];
    const x = board();
    c2.mode = "inkwire"; // not the Author
    expect(clients.talkingOn(x)).toBeNull();
    clients.commitClaim(c1, x);
    expect(clients.talkingOn(x)).toBeNull();
    c1.mode = "inkwire";
    expect(clients.talkingOn(x)).toBe(c1);
  });

  it("boardDeleted(B) clears the current board of the Author and of every reader; readerCount(B) is 0", () => {
    const [c1, c2, c3] = [hello(101), hello(202), hello(303)];
    const [a, b] = [board("A"), board("B")];
    for (const c of [c1, c2]) c.currentBoardId = b;
    c3.currentBoardId = a;
    clients.commitClaim(c1, b);
    expect(sessions.delete(b)).toBe(true);
    expect(c1.currentBoardId).toBeNull();
    expect(c2.currentBoardId).toBeNull();
    expect(c3.currentBoardId).toBe(a);
    expect(clients.authorOf(b)).toBeNull();
    expect(clients.readerCount(b)).toBe(0);
  });

  it("commitClaim on a deleted board does nothing", () => {
    const c = hello(101);
    const [a, b] = [board("A"), board("B")];
    clients.commitClaim(c, a);
    sessions.delete(b);
    clients.commitClaim(c, b);
    expect(clients.authorOf(b)).toBeNull();
    expect(clients.authorOf(a)).toBe(101);
  });

  it("commitClaim throws and changes nothing when another pid claimed the board after checkWrite", () => {
    const [c1, c2] = [hello(101), hello(202)];
    const [a, b] = [board("A"), board("B")];
    clients.commitClaim(c1, a);
    clients.checkWrite(c1, b); // passes: B has no Author yet
    clients.commitClaim(c2, b); // another pid wins the race
    expect(() => clients.commitClaim(c1, b)).toThrow(/pid 202/);
    expect(clients.authorOf(a)).toBe(101);
    expect(clients.authorOf(b)).toBe(202);
  });

  it("release returns the released Client and fires onChange", () => {
    const c = hello(101);
    const x = board();
    clients.commitClaim(c, x);
    let changes = 0;
    clients.onChange(() => changes++);
    expect(clients.release(x, "client")).toBe(c);
    expect(clients.authorOf(x)).toBeNull();
    expect(changes).toBeGreaterThan(0);
    expect(clients.release(x, "client")).toBeNull();
  });
});

describe("a talking Author that loses its board (releaseAuthorship)", () => {
  /** c claims x, talks on it in inkwire mode, and blocks in a session_send. */
  const talk = (c: Client, x: string) => {
    clients.commitClaim(c, x);
    c.mode = "inkwire";
    return sessionSend(clients, c, sessions.open(x), { text: "waiting" });
  };
  const releasedRows = (x: string) =>
    sessions.open(x).thread.filter((m) => m.type === "call" && /authorship released/.test(m.text)).map((m) => m.text);

  const cases: [string, ReleaseReason, (c: Client, x: string) => void][] = [
    ["remove (disconnect)", "disconnect", (c) => clients.remove(c.pid)],
    ["release by the Client", "client", (_c, x) => clients.release(x, "client")],
    ["release by the person", "person", (_c, x) => clients.release(x, "person")],
  ];
  for (const [name, reason, act] of cases) {
    it(`${name}: the pending send returns mode_off, the mode is pty, and the row names the reason`, async () => {
      const c = hello(101);
      const x = board();
      const pending = talk(c, x);
      act(c, x);
      expect(await pending).toMatchObject({ status: "mode_off" });
      expect(c.mode).toBe("pty");
      expect(c.pending).toBeNull();
      expect(clients.talkingOn(x)).toBeNull();
      expect(clients.authorOf(x)).toBeNull();
      expect(releasedRows(x)).toEqual([`off · authorship released (${reason}); the pending session_send returned mode_off`]);
    });
  }

  it("a switch claim releases the old board only: the send returns mode_off and only the old board gets the row", async () => {
    const c = hello(101);
    const [a, b] = [board("A"), board("B")];
    const pending = talk(c, a);
    clients.commitClaim(c, b);
    expect(await pending).toMatchObject({ status: "mode_off" });
    expect(c.mode).toBe("pty");
    expect(clients.talkingOn(a)).toBeNull();
    expect(clients.talkingOn(b)).toBeNull();
    expect(clients.authorOf(b)).toBe(101);
    expect(releasedRows(a)).toEqual(["off · authorship released (switch); the pending session_send returned mode_off"]);
    expect(releasedRows(b)).toEqual([]);
  });
});

describe("board notices", () => {
  const ceiling = (c: Client, x: string) => {
    clients.commitClaim(c, x);
    c.mode = "inkwire";
    for (let i = 0; i < 4; i++) hookEvent(clients, { hook_event_name: "Stop", claude_pid: c.pid }, "0");
  };

  it("a switch release clears the old board's notice", () => {
    const c = hello(101);
    const [a, b] = [board("A"), board("B")];
    ceiling(c, a);
    expect(c.mode).toBe("pty");
    expect(clients.noticeByBoard.get(a)).toBe("claude code kept replying to the terminal · mode pty");
    clients.commitClaim(c, b);
    expect(clients.authorOf(a)).toBeNull();
    expect(clients.noticeByBoard.has(a)).toBe(false);
  });

  it("a disconnect clears the notice of the board the Client authored", () => {
    const c = hello(101);
    const a = board("A");
    ceiling(c, a);
    expect(clients.noticeByBoard.has(a)).toBe(true);
    clients.remove(101);
    expect(clients.noticeByBoard.has(a)).toBe(false);
  });

  it("a board delete shows its notice to the panels, then keeps no entry for the deleted id", () => {
    const c = hello(101);
    const a = board("A");
    clients.commitClaim(c, a);
    c.mode = "inkwire";
    const seen: (string | undefined)[] = [];
    clients.onChange(() => seen.push(clients.noticeByBoard.get(a)));
    sessions.delete(a);
    expect(seen).toContain("board deleted · mode pty");
    expect(clients.noticeByBoard.has(a)).toBe(false);
  });
});
