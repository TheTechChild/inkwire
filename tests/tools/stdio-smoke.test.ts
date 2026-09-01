// Spawned-stdio smoke test: the in-process transport cannot catch stray
// writes to stdout, so talk to the real entry point over real pipes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server/index.ts"],
    cwd: root,
    env: {
      ...process.env,
      INKWIRE_DATA_DIR: mkdtempSync(path.join(tmpdir(), "inkwire-smoke-")),
      INKWIRE_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      INKWIRE_PROJECT_ROOT: root,
    },
    stderr: "ignore",
  });
  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
}, 20000);

afterAll(async () => {
  await client.close();
});

describe("stdio transport", () => {
  it("lists all 17 tools over real pipes", async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(17);
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("boards_create");
    expect(names).toContain("canvas_get_state");
    expect(names).toContain("history_get");
  });

  it("creates a board and reads clean state (no stdout pollution)", async () => {
    const created = (await client.callTool({
      name: "boards_create",
      arguments: { name: "smoke board" },
    })) as { content: { type: string; text?: string }[] };
    const body = JSON.parse(created.content[0]!.text!);
    expect(body.board_id).toBeTruthy();
    expect(body.panel_url).toContain("http://127.0.0.1:");

    const state = (await client.callTool({
      name: "canvas_get_state",
      arguments: {},
    })) as { content: { type: string; text?: string }[] };
    const parsed = JSON.parse(state.content[0]!.text!);
    expect(parsed.graph.nodes).toEqual([]);
    expect(parsed.history.steps).toBe(0);
  });
});
