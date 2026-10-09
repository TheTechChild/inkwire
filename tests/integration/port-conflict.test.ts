// Two Claude Code sessions share one daemon (plan M8). Before the daemon, a
// second session on the same port exited with EADDRINUSE (the bug that showed
// as CONNECTION_CLOSED in a second Claude session). Now the second relay uses
// the daemon that the first one started. A port that a non-inkwire process
// holds still makes the relay exit 1 with the reason.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startRelay, type Relay } from "../health/harness.js";
import { body, call, freePort, health, killTree, root, tempDir, testEnv, waitFor } from "./daemon-helpers.js";

describe("port conflict: two sessions share one daemon", () => {
  it("a second relay on the port does not fail; both list tools and see one board list", async () => {
    const port = await freePort();
    const dataDir = tempDir("conflict");
    const relays: Relay[] = [];
    const seen = new Set<number>();
    try {
      const A = await startRelay({ port, dataDir, graceMs: 300 });
      relays.push(A);
      const first = await waitFor(() => health(port));
      seen.add(first.pid);
      const B = await startRelay({ port, dataDir, graceMs: 300 });
      relays.push(B);

      const [la, lb] = await Promise.all([A.client.listTools(), B.client.listTools()]);
      expect(la.tools.length).toBeGreaterThan(30);
      expect(lb.tools.map((t) => t.name).sort()).toEqual(la.tools.map((t) => t.name).sort());

      const created = await call(A.client, "boards_create", { name: "shared", project_root: tempDir("conflict-root") });
      expect(created.isError, body(created)).toBeFalsy();
      const id = JSON.parse(body(created)).board_id as string;
      const listed = JSON.parse(body(await call(B.client, "boards_list", { all: true })));
      expect(listed.boards.map((b: { id: string }) => b.id)).toContain(id);

      const h = await waitFor(async () => {
        const x = await health(port);
        return x && x.clients === 2 ? x : null;
      });
      expect(h.pid).toBe(first.pid);
      expect([...A.errors, ...B.errors]).toEqual([]);
      expect(B.stderr()).not.toContain("EADDRINUSE");
    } finally {
      for (const r of relays) await r.close();
      const h = await health(port);
      if (h) seen.add(h.pid);
      for (const pid of seen) killTree(pid);
    }
  }, 20000);

  it("a port that a non-inkwire process holds makes the relay exit 1 with the reason", async () => {
    const port = await freePort();
    const plain = createServer((_req, res) => {
      res.writeHead(404);
      res.end("not here");
    });
    await new Promise<void>((r) => plain.listen(port, "127.0.0.1", () => r()));
    const child = spawn(process.execPath, ["--import", "tsx", "src/link/relay.ts"], {
      cwd: root,
      env: testEnv(port, tempDir("conflict-foreign"), { INKWIRE_IDLE_GRACE_MS: "300" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stderr = "";
      child.stderr!.on("data", (c) => (stderr += String(c)));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code).toBe(1);
      expect(stderr).toContain(`port ${port} is taken by another process`);
      expect(stderr).not.toContain("Unhandled");
    } finally {
      child.kill("SIGKILL");
      plain.closeAllConnections();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  }, 20000);
});
