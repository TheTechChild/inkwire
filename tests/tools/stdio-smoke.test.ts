// Spawned-stdio smoke test: the in-process transport cannot catch stray
// writes to stdout, so talk to the real entry point over real pipes. The
// entry is the relay as the plugin manifest runs it (plan M7.1): `node
// <plugin root>/src/link/relay.ts`, with no tsx and no build, from a cwd
// outside the repo and with a clean env (no NODE_OPTIONS from the test
// runner). It autostarts a daemon on a random port with a temp dir; the test
// covers relay plus daemon.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolArgs } from "../../plugin/src/shared/schemas.ts";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { alive, freePort, health, killTree, root, tempDir, waitFor } from "../integration/daemon-helpers.ts";

let client: Client;
let transport: StdioClientTransport;
let port: number;
let daemonPid: number | null = null;

beforeAll(async () => {
  port = await freePort();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "plugin", "src", "link", "relay.ts")],
    cwd: tempDir("smoke-cwd"),
    // A clean shell: only PATH and HOME, plus the test port and dir.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? tempDir("smoke-home"),
      INKWIRE_PORT: String(port),
      INKWIRE_DATA_DIR: tempDir("smoke"),
      INKWIRE_IDLE_GRACE_MS: "300",
    },
    stderr: "ignore",
  });
  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  daemonPid = (await health(port))?.pid ?? null;
}, 20000);

afterAll(async () => {
  const relayPid = transport?.pid ?? undefined;
  if (daemonPid === null) daemonPid = (await health(port))?.pid ?? null;
  await client?.close().catch(() => {});
  // Kill only the relay, not its tree: the daemon is the relay's child, and a
  // tree kill would stop it here and hide a broken idle grace.
  if (relayPid) {
    try {
      process.kill(relayPid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  if (daemonPid === null) return;
  const pid = daemonPid;
  // The last relay closed: the idle grace (300 ms) stops the daemon.
  try {
    await waitFor(() => !alive(pid), 5000);
  } catch (e) {
    killTree(pid);
    throw e;
  }
}, 10000);

describe("stdio transport (relay plus daemon)", () => {
  it("lists every tool in toolArgs over real pipes", async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(Object.keys(toolArgs).length);
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("boards_create");
    expect(names).toContain("boards_delete");
    expect(names).toContain("canvas_get_state");
    expect(names).toContain("history_get");
  });

  it("creates a board and reads clean state (no stdout pollution)", async () => {
    const created = (await client.callTool({
      name: "boards_create",
      arguments: { name: "smoke board", project_root: root },
    })) as { content: { type: string; text?: string }[] };
    // The board context line comes first (M3.5), then the body.
    expect(created.content[0]!.text).toMatch(/^board b_\w+ "smoke board" · you: author · mode: pty/);
    const body = JSON.parse(created.content[1]!.text!);
    expect(body.board_id).toBeTruthy();
    expect(body.panel_url).toContain(`http://127.0.0.1:${port}/`);

    const state = (await client.callTool({
      name: "canvas_get_state",
      arguments: {},
    })) as { content: { type: string; text?: string }[] };
    const parsed = JSON.parse(state.content[1]!.text!);
    expect(parsed.graph.nodes).toEqual([]);
    expect(parsed.history.steps).toBe(0);
  });

  it("the daemon answers /healthz with a pid", () => {
    expect(daemonPid).toBeTypeOf("number");
  });

  it("the daemon runs from the source and serves the panel it bundles", async () => {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(daemonPid)], { encoding: "utf8" });
    expect(command).toContain(path.join(root, "plugin", "src", "server", "daemon.ts"));
    const base = `http://127.0.0.1:${port}`;
    for (const [file, type] of [["/", "text/html"], ["/main.js", "text/javascript"], ["/styles.css", "text/css"]] as const) {
      const res = await fetch(base + file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get("content-type"), file).toContain(type);
    }
  });
});
