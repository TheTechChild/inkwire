// Many Clients over one Sessions + Clients, one real McpServer each over
// InMemoryTransport: the daemon's shape, in-process (ADR 0001, ADR 0002).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/server/mcp.js";
import { Screenshots } from "../../src/server/screenshot.js";
import { hookEvent } from "../../src/server/session-mode.js";
import { Sessions } from "../../src/server/session.js";
import { Clients, type Client as InkwireClient } from "../../src/server/clients.js";
import { Store } from "../../src/server/store.js";
import { toolBody } from "../helpers.js";

export interface CallResult {
  /** The result with the context line and notices removed. */
  res: { content: { type: string; text?: string }[]; isError?: boolean };
  /** The context line and the notices, one per line. */
  head: string;
  /** The first text block of the body. */
  text: string;
  json: () => any;
}

export class Harness {
  readonly store: Store;
  readonly sessions: Sessions;
  readonly clients: Clients;
  /** A project root with auth.ts in it. */
  readonly root: string;
  private mcp = new Map<number, Client>();

  constructor(opts: { sendTimeoutMs?: number } = {}) {
    this.store = new Store(mkdtempSync(path.join(tmpdir(), "inkwire-harness-")));
    this.sessions = new Sessions(this.store, { debounceMs: 50, sendTimeoutMs: opts.sendTimeoutMs ?? 5_000 });
    this.clients = new Clients(this.sessions);
    this.root = mkdtempSync(path.join(tmpdir(), "inkwire-harness-root-"));
    writeFileSync(path.join(this.root, "auth.ts"), "export function verifyToken() {}\n");
  }

  /** The hello of pid: a Client and its MCP server. */
  async connect(pid: number): Promise<InkwireClient> {
    const c = this.clients.ensure(pid, { cwd: `/work/p${pid}`, sessionId: `s${pid}` });
    this.clients.attach(pid, `link-${pid}`);
    const screenshots = new Screenshots({ requestCapture: () => false }, this.store.imagesDir);
    const server = buildMcpServer({
      sessions: this.sessions,
      clients: this.clients,
      client: c,
      store: this.store,
      screenshots: () => screenshots,
      pluginRoot: "/repo",
      focusTerminal: () => {},
      panelUrl: (id) => `http://127.0.0.1:4691/?board=${id}`,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mc = new Client({ name: `test-${pid}`, version: "0.0.0" });
    await server.connect(st);
    await mc.connect(ct);
    this.mcp.set(pid, mc);
    return c;
  }

  async call(pid: number, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const raw = (await this.mcp.get(pid)!.callTool({ name, arguments: args })) as CallResult["res"];
    const res = { ...raw, content: toolBody(raw.content) };
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    return { res, head: raw.content[0]?.text ?? "", text, json: () => JSON.parse(text) };
  }

  async listTools(pid: number): Promise<string[]> {
    return (await this.mcp.get(pid)!.listTools()).tools.map((t) => t.name);
  }

  /** A hook event that lets pid turn inkwire mode on. */
  arm(pid: number): void {
    hookEvent(this.clients, { hook_event_name: "PreToolUse", permission_mode: "auto", session_id: `s${pid}`, claude_pid: pid }, "0");
  }

  async newBoard(pid: number, name: string): Promise<string> {
    const r = await this.call(pid, "boards_create", { name, project_root: this.root });
    if (r.res.isError) throw new Error(r.text);
    return r.json().board_id;
  }

  /** The call rows on a board. */
  callRows(boardId: string): { name: string; text: string }[] {
    return this.sessions
      .open(boardId)
      .thread.filter((m) => m.type === "call")
      .map((m) => ({ name: (m as { name: string }).name, text: m.text }));
  }

  async close(): Promise<void> {
    for (const mc of this.mcp.values()) await mc.close();
    this.sessions.persistAll();
    this.store.close();
  }
}
