// RelayCore in-process (plan M4.7): downstream and upstream are InMemoryTransport
// pairs. The generic cases use a trivial McpServer upstream; the current-board
// cases use the daemon's own link host (createLinkHost) over one Sessions + Clients.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GAP_TEXT, LINK_LOST_CODE, LOST_TEXT, REINIT_PREFIX, RelayCore, type UpstreamFactory } from "../../src/link/relay-core.js";
import { LINK_VERSION, type Hello } from "../../src/link/hello.js";
import { createLinkHost, type LinkHost } from "../../src/server/daemon.js";
import { Store } from "../../src/server/store.js";
import { Sessions } from "../../src/server/session.js";
import { Clients } from "../../src/server/clients.js";
import { Screenshots } from "../../src/server/screenshot.js";

type Extra = { current_board?: string };

const quiet = { backoffMs: 10, maxBackoffMs: 40, log: () => {} };

const waitFor = async <T>(check: () => T | null | undefined | false, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** An upstream factory whose links can be killed and whose connects can be blocked. */
class Upstreams {
  blocked = false;
  /** When set, a connect throws this (for example a fatal DaemonUnavailable). */
  failWith: Error | null = null;
  connects = 0;
  extras: Extra[] = [];
  /** Every message the relay sent upstream, one list for each link. */
  upSent: any[][] = [];
  /** The daemon side of the newest link. */
  current: InMemoryTransport | null = null;
  /** The close code and reason of the newest link, as WsTransport keeps them. */
  link = { closeCode: null as number | null, closeReason: "" };
  constructor(private serve: (t: InMemoryTransport, extra: Extra) => Promise<void>, private buildId = "build-1") {}
  factory: UpstreamFactory = async (extra) => {
    if (this.failWith) throw this.failWith;
    if (this.blocked) throw new Error("connect refused (test)");
    this.connects++;
    this.extras.push(extra);
    const [relaySide, daemonSide] = InMemoryTransport.createLinkedPair();
    const sent: any[] = [];
    this.upSent.push(sent);
    const send = relaySide.send.bind(relaySide);
    relaySide.send = async (m, o) => {
      sent.push(m);
      return send(m, o);
    };
    await this.serve(daemonSide, extra);
    this.current = daemonSide;
    this.link = { closeCode: null, closeReason: "" };
    return { transport: relaySide, buildId: this.buildId, link: this.link };
  };
  setBuild(id: string) {
    this.buildId = id;
  }
  /** The daemon side goes away (a SIGKILL, a restart). */
  async kill() {
    await this.current?.close();
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** A relay with a downstream SDK Client, and every message the relay sent downstream. */
async function relayWith(up: Upstreams, opts: ConstructorParameters<typeof RelayCore>[2] = {}) {
  const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
  const sent: any[] = [];
  const send = relaySide.send.bind(relaySide);
  relaySide.send = async (m, o) => {
    sent.push(m);
    return send(m, o);
  };
  const core = new RelayCore(relaySide, up.factory, { ...quiet, ...opts });
  await core.start();
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  const errors: Error[] = [];
  client.onerror = (e) => errors.push(e);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close().catch(() => {});
    await core.stop();
  });
  return { core, client, sent, errors };
}

/** A trivial upstream: `slow` waits for release(); `say` answers its text. */
function trivial() {
  const releases: (() => void)[] = [];
  const up = new Upstreams(async (t) => {
    const mcp = new McpServer({ name: "trivial", version: "0.0.0" });
    mcp.registerTool("slow", { description: "slow" }, async () => {
      await new Promise<void>((r) => releases.push(r));
      return { content: [{ type: "text", text: "slow done" }] };
    });
    mcp.registerTool("say", { description: "say", inputSchema: { text: z.string() } }, async ({ text }) => ({
      content: [{ type: "text", text }],
    }));
    await mcp.connect(t);
  });
  return { up, releases };
}

describe("RelayCore: reconnect", () => {
  it("the second initialize response never goes downstream", async () => {
    const { up } = trivial();
    const { client, sent, errors } = await relayWith(up);
    await client.listTools();
    await up.kill();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["slow", "say"]);
    expect(up.connects).toBe(2);
    expect(sent.filter((m) => m.result?.serverInfo)).toHaveLength(1);
    expect(sent.some((m) => typeof m.id === "string" && m.id.startsWith(REINIT_PREFIX))).toBe(false);
    expect(errors.map((e) => e.message).join()).not.toContain("unknown message ID");
  });

  it("an in-flight request gets -32000 after an upstream close", async () => {
    const { up, releases } = trivial();
    const { client } = await relayWith(up);
    const slow = client.callTool({ name: "slow", arguments: {} }).catch((e) => e);
    await waitFor(() => releases.length === 1);
    await up.kill();
    const err = await slow;
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(LINK_LOST_CODE);
    expect((err as McpError).message).toContain(LOST_TEXT);
  });

  it("a request in the gap is answered after the reconnect, with its id kept", async () => {
    const { up } = trivial();
    const { client, sent } = await relayWith(up);
    await client.listTools();
    up.blocked = true;
    await up.kill();
    const pending = client.callTool({ name: "say", arguments: { text: "after the gap" } });
    await new Promise((r) => setTimeout(r, 60));
    expect(up.connects).toBe(1);
    up.blocked = false;
    const r = (await pending) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("after the gap");
    const answer = sent.find((m) => m.result?.content?.[0]?.text === "after the gap");
    expect(typeof answer.id).toBe("number");
  });

  it("the queue limit gives errors", async () => {
    const { up } = trivial();
    const { client } = await relayWith(up, { queueMax: 3 });
    await client.listTools();
    up.blocked = true;
    await up.kill();
    const calls = [1, 2, 3, 4].map((i) => client.callTool({ name: "say", arguments: { text: `q${i}` } }).catch((e) => e));
    const fourth = await calls[3];
    expect(fourth).toBeInstanceOf(McpError);
    expect((fourth as McpError).message).toContain(GAP_TEXT);
    up.blocked = false;
    const first = (await calls[0]) as { content: { text: string }[] };
    expect(first.content[0]!.text).toBe("q1");
  });

  it("after the give-up time, a new request gets the error at once", async () => {
    let now = 0;
    const { up } = trivial();
    const { client } = await relayWith(up, { now: () => now, giveUpMs: 60_000 });
    await client.listTools();
    up.blocked = true;
    await up.kill();
    now = 61_000;
    const err = await client.callTool({ name: "say", arguments: { text: "late" } }).catch((e) => e);
    expect((err as McpError).message).toContain(GAP_TEXT);
  });

  it("a reconnect to a daemon with another build sends tools/list_changed downstream", async () => {
    const { up } = trivial();
    const { client, sent } = await relayWith(up);
    await client.listTools();
    up.setBuild("build-2");
    await up.kill();
    await client.listTools();
    await waitFor(() => sent.some((m) => m.method === "notifications/tools/list_changed"));
  });

  it("after the hidden initialize answers, the cached notifications/initialized goes upstream, then the gap requests in order", async () => {
    const { up } = trivial();
    const { client } = await relayWith(up);
    await client.listTools();
    up.blocked = true;
    await up.kill();
    const calls = ["g1", "g2", "g3"].map((text) => client.callTool({ name: "say", arguments: { text } }));
    await new Promise((r) => setTimeout(r, 30));
    up.blocked = false;
    const answers = (await Promise.all(calls)) as { content: { text: string }[] }[];
    expect(answers.map((a) => a.content[0]!.text)).toEqual(["g1", "g2", "g3"]);
    const second = up.upSent[1]!;
    expect(second[0].method).toBe("initialize");
    expect(second[0].id).toMatch(new RegExp(`^${REINIT_PREFIX}`));
    expect(second[1].method).toBe("notifications/initialized");
    expect(second.slice(2).map((m) => m.params?.arguments?.text)).toEqual(["g1", "g2", "g3"]);
  });

  it("a link closed with 4426 stops the relay with the reason: no reconnect loop", async () => {
    const { up, releases } = trivial();
    const reasons: string[] = [];
    const { client, core } = await relayWith(up, { onFatal: (r) => reasons.push(r) });
    const slow = client.callTool({ name: "slow", arguments: {} }).catch((e) => e);
    await waitFor(() => releases.length === 1);
    up.link.closeCode = 4426;
    up.link.closeReason = "link version mismatch: run yarn daemon:restart";
    await up.kill();
    const err = await slow;
    expect((err as McpError).code).toBe(LINK_LOST_CODE);
    expect((err as McpError).message).toContain("link version mismatch: run yarn daemon:restart");
    await waitFor(() => reasons.length === 1);
    expect(reasons[0]).toContain("4426");
    expect(core.isStopped).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(up.connects).toBe(1);
    expect(reasons).toHaveLength(1);
  });

  it("a fatal connect error on a reconnect stops the relay and answers the queued requests", async () => {
    const { up } = trivial();
    const reasons: string[] = [];
    const { client, core } = await relayWith(up, { onFatal: (r) => reasons.push(r) });
    await client.listTools();
    up.failWith = Object.assign(new Error("port 1 is held by an old inkwire server; close the old Claude Code sessions"), { fatal: true });
    await up.kill();
    const queued = client.callTool({ name: "say", arguments: { text: "never" } }).catch((e) => e);
    const err = await queued;
    expect((err as McpError).message).toContain("held by an old inkwire server");
    await waitFor(() => reasons.length === 1);
    expect(core.isStopped).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(up.connects).toBe(1);
    expect(reasons).toHaveLength(1);
  });

  it("a daemon that accepts the link and closes it at once gets a growing backoff, not a fast loop", async () => {
    const up = new Upstreams(async (t) => {
      // Close right after the relay starts the link, before any message.
      setTimeout(() => void t.close(), 0);
    });
    // No downstream Client: nothing would answer its initialize.
    const [, relaySide] = InMemoryTransport.createLinkedPair();
    const core = new RelayCore(relaySide, up.factory, { ...quiet, backoffMs: 10, maxBackoffMs: 1000 });
    cleanups.push(() => core.stop());
    await core.start();
    await new Promise((r) => setTimeout(r, 350));
    // 10 + 20 + 40 + 80 + 160 ms: at most about 6 connects. A fixed 10 ms loop gives about 30.
    expect(up.connects).toBeLessThanOrEqual(7);
    await core.stop();
  });

  it("the first connect tries again after a failure that is not fatal", async () => {
    const { up } = trivial();
    let n = 0;
    const factory = up.factory;
    const flaky: UpstreamFactory = async (extra) => {
      if (++n === 1) throw new Error("connect ECONNREFUSED (test)");
      return factory(extra);
    };
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    const core = new RelayCore(relaySide, flaky, quiet);
    await core.start();
    const client = new Client({ name: "claude-code", version: "0.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await core.stop();
    });
    expect((await client.listTools()).tools.length).toBe(2);
    expect(n).toBe(2);
  });

  it("the first connect stops at once on a fatal error", async () => {
    let n = 0;
    const fatal = Object.assign(new Error("port 1 is taken by another process"), { fatal: true });
    const [, relaySide] = InMemoryTransport.createLinkedPair();
    const core = new RelayCore(relaySide, async () => {
      n++;
      throw fatal;
    }, quiet);
    await expect(core.start()).rejects.toBe(fatal);
    expect(n).toBe(1);
    expect(core.isStopped).toBe(true);
  });

  it("the first connect gives up after firstConnectMs", async () => {
    let n = 0;
    const [, relaySide] = InMemoryTransport.createLinkedPair();
    const core = new RelayCore(relaySide, async () => {
      n++;
      throw new Error("connect ECONNREFUSED (test)");
    }, { ...quiet, firstConnectMs: 100 });
    await expect(core.start()).rejects.toThrow("ECONNREFUSED");
    expect(n).toBeGreaterThan(1);
  });

  it("a closed downstream closes upstream and stops the reconnect", async () => {
    const { up } = trivial();
    const { client, core } = await relayWith(up);
    await client.listTools();
    let upClosed = false;
    const daemonSide = up.current!;
    const prev = daemonSide.onclose;
    daemonSide.onclose = () => {
      upClosed = true;
      prev?.();
    };
    await client.close();
    await waitFor(() => upClosed);
    expect(core.isStopped).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(up.connects).toBe(1);
  });
});

describe("RelayCore: the current board across a reconnect (Open question 11)", () => {
  function daemon() {
    const store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-relay-core-")));
    const sessions = new Sessions(store, { debounceMs: 20 });
    const clients = new Clients(sessions);
    const screenshots = new Screenshots({ requestCapture: () => false }, store.imagesDir);
    const host: LinkHost = createLinkHost(
      {
        clients,
        mcpDeps: { sessions, clients, store, screenshots: () => screenshots, panelUrl: (id) => `http://127.0.0.1:0/?board=${id}` },
      },
      { id: "daemon-build", built_at: null },
    );
    const root = mkdtempSync(path.join(tmpdir(), "inkwire-relay-core-root-"));
    cleanups.push(() => {
      sessions.persistAll();
      store.close();
    });
    const helloOf = (pid: number, extra: Extra = {}): Hello => ({
      type: "hello",
      v: LINK_VERSION,
      pid,
      session_id: null,
      cwd: `/work/pid-${pid}`,
      build: { id: "daemon-build", built_at: null },
      ...extra,
    });
    const linkTo = (pid: number) => async (t: InMemoryTransport, extra: Extra) => {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => (resolveClosed = r));
      t.onclose = () => resolveClosed();
      await host.accept({ transport: t, hello: helloOf(pid, extra), closed });
    };
    /** Another Claude Code session on the same daemon, with no relay. */
    const direct = async (pid: number) => {
      const [c, d] = InMemoryTransport.createLinkedPair();
      await linkTo(pid)(d, {});
      const client = new Client({ name: `direct-${pid}`, version: "0" });
      await client.connect(c);
      cleanups.push(() => client.close().catch(() => {}));
      return client;
    };
    return { sessions, clients, root, up: new Upstreams(linkTo(101)), direct };
  }

  const first = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

  it("keeps the last board id, sends it in the second hello, and the daemon restores the current board but not authorship", async () => {
    const d = daemon();
    const { client, core } = await relayWith(d.up);
    const created = await client.callTool({ name: "boards_create", arguments: { name: "kept", project_root: d.root } });
    const id = JSON.parse((created as { content: { text: string }[] }).content[1]!.text).board_id;
    expect(core.currentBoard).toBe(id);
    expect(d.clients.authorOf(id)).toBe(101);

    // An argument error from the SDK has no context line: the kept id stays.
    const bad = await client.callTool({ name: "canvas_add_node", arguments: { kind: "service" } });
    expect(first(bad)).not.toMatch(/^board /);
    expect(core.currentBoard).toBe(id);

    // The Client talks with the person before the drop: the daemon must not restore that mode.
    d.clients.get(101)!.mode = "inkwire";
    const talking = await client.callTool({ name: "canvas_get_state", arguments: {} });
    expect(first(talking)).toMatch(/· mode: inkwire/);

    await d.up.kill();
    await waitFor(() => d.clients.get(101) === undefined);
    expect(d.clients.authorOf(id)).toBeNull();
    const state = await client.callTool({ name: "canvas_get_state", arguments: {} });
    expect(d.up.extras).toEqual([{}, { current_board: id }]);
    expect(first(state)).toMatch(new RegExp(`^board ${id} "kept" · you: reader · mode: pty`));
    expect(first(state)).toContain(
      `The connection to the daemon was restored. Your current board is still ${id}. You are a reader until your next write claims it.`,
    );
    expect(d.clients.authorOf(id)).toBeNull();
    // The notice is shown once.
    const again = await client.callTool({ name: "canvas_get_state", arguments: {} });
    expect(first(again)).not.toContain("restored");
    // The next write claims the board again.
    const write = await client.callTool({ name: "canvas_add_node", arguments: { label: "n", kind: "service", at: [0, 0] } });
    expect(first(write)).toMatch(new RegExp(`^board ${id} "kept" · you: author`));
    expect(d.clients.authorOf(id)).toBe(101);
  });

  it("board: none clears the kept id", async () => {
    const d = daemon();
    const { client, core } = await relayWith(d.up);
    const created = await client.callTool({ name: "boards_create", arguments: { name: "doomed", project_root: d.root } });
    const id = JSON.parse((created as { content: { text: string }[] }).content[1]!.text).board_id;
    expect(core.currentBoard).toBe(id);
    const deleted = await client.callTool({ name: "boards_delete", arguments: { board_id: id } });
    expect(first(deleted)).toMatch(/^board: none/);
    expect(core.currentBoard).toBeNull();
    await d.up.kill();
    await client.listTools();
    expect(d.up.extras).toEqual([{}, {}]);
  });

  it("another author in the gap: the notice names it, and the board stays current for reads", async () => {
    const d = daemon();
    const { client } = await relayWith(d.up);
    const created = await client.callTool({ name: "boards_create", arguments: { name: "taken", project_root: d.root } });
    const id = JSON.parse((created as { content: { text: string }[] }).content[1]!.text).board_id;
    d.up.blocked = true;
    await d.up.kill();
    await waitFor(() => d.clients.get(101) === undefined);
    const other = await d.direct(202);
    await other.callTool({ name: "canvas_add_node", arguments: { board_id: id, label: "mine", kind: "service", at: [0, 0] } });
    expect(d.clients.authorOf(id)).toBe(202);
    d.up.blocked = false;
    const state = await client.callTool({ name: "canvas_get_state", arguments: {} });
    expect(first(state)).toMatch(new RegExp(`^board ${id} "taken" · you: reader`));
    expect(first(state)).toContain(
      `The connection to the daemon was restored. Your current board is still ${id}. ${id} now has another author (pid-202 · pid 202). You can read it.`,
    );
  });

  it("a board deleted in the gap: the notice says so, and there is no current board", async () => {
    const d = daemon();
    const { client, core } = await relayWith(d.up);
    const created = await client.callTool({ name: "boards_create", arguments: { name: "gone", project_root: d.root } });
    const id = JSON.parse((created as { content: { text: string }[] }).content[1]!.text).board_id;
    d.up.blocked = true;
    await d.up.kill();
    await waitFor(() => d.clients.get(101) === undefined);
    d.sessions.delete(id);
    d.up.blocked = false;
    const list = await client.callTool({ name: "boards_list", arguments: {} });
    expect(first(list)).toMatch(/^board: none · mode: pty/);
    expect(first(list)).toContain(`The connection to the daemon was restored. Board ${id} no longer exists. You have no current board.`);
    expect(core.currentBoard).toBeNull();
  });
});
