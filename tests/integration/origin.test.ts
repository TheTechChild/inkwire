// The Origin and Host check on the browser routes (plan M4.11, Open question 10).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { startDaemon, type Daemon } from "../../src/server/daemon.js";
import { health, rawRequest, tempDir } from "./daemon-helpers.js";

let d: Daemon;
let port: number;
let boardId: string;
const exits: number[] = [];
let errors: MockInstance<typeof console.error>;
/** The "inkwire refused" stderr lines since the start of the test: one for each refusal. */
const refused = () => errors.mock.calls.filter((c) => String(c[0]).startsWith("inkwire refused"));

beforeAll(async () => {
  const started = await startDaemon({
    config: { port: 0, dataDir: tempDir("origin"), idleGraceMs: null },
    build: { id: "origin", built_at: null },
    exit: (code) => exits.push(code),
  });
  d = started!;
  port = d.port;
  boardId = d.core.sessions.create("origin board", tempDir("origin-root")).boardId;
});

beforeEach(() => {
  errors?.mockRestore();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  errors?.mockRestore();
  d.shutdown("test end");
});

function upgrade(headers: Record<string, string>): Promise<{ open: boolean; status?: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${boardId}`, { headers });
    socket.on("open", () => {
      socket.close();
      resolve({ open: true });
    });
    socket.on("unexpected-response", (_req, res) => resolve({ open: false, status: res.statusCode }));
    socket.on("error", () => resolve({ open: false }));
  });
}

describe("Origin and Host check", () => {
  it("a /ws upgrade with a foreign Origin is refused", async () => {
    expect(await upgrade({ Origin: "https://evil.example" })).toEqual({ open: false, status: 403 });
    expect(refused()).toHaveLength(1);
  });

  it("a /ws upgrade with the panel Origin is accepted", async () => {
    expect((await upgrade({ Origin: `http://127.0.0.1:${port}` })).open).toBe(true);
    expect((await upgrade({ Origin: `http://localhost:${port}` })).open).toBe(true);
    expect(refused()).toHaveLength(0);
  });

  it("a /mcp upgrade with a foreign Origin is refused", async () => {
    const result = await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`, { headers: { Origin: "https://evil.example" } });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      socket.on("open", () => resolve(101));
      socket.on("error", () => resolve(undefined));
    });
    expect(result).toBe(403);
    expect(refused()).toHaveLength(1);
  });

  it("POST /api/daemon/restart with a foreign Origin gets 403 and the daemon keeps running", async () => {
    const res = await rawRequest(port, "POST", "/api/daemon/restart", { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(exits).toEqual([]);
    expect((await health(port))?.name).toBe("inkwire");
    expect(refused()).toHaveLength(1);
  });

  it("a foreign Host gets 403", async () => {
    const res = await rawRequest(port, "DELETE", `/api/boards/${boardId}`, { Host: `evil.example:${port}` });
    expect(res.status).toBe(403);
    expect(d.core.sessions.exists(boardId)).toBe(true);
    expect((await upgrade({ Host: `evil.example:${port}` })).status).toBe(403);
    expect(refused()).toHaveLength(2);
  });

  it("the hook curl with no Origin still works", async () => {
    // Async: the daemon runs in this process, so a sync spawn would block it.
    const { stdout: out } = await promisify(execFile)(
      "curl",
      ["-s", "--max-time", "5", "-X", "POST", `http://127.0.0.1:${port}/api/hook?bg=0`, "-H", "content-type: application/json", "--data-binary", "{}"],
      { encoding: "utf8" },
    );
    expect(out).toBe("ok");
    expect(refused()).toHaveLength(0);
  });
});
