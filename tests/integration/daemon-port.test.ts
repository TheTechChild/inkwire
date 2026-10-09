// Daemon port conflicts (plan M4.5). The stdio-entry test
// (port-conflict.test.ts) stays until the cut-over (M7).
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freePort, health, spawnDaemon, tempDir, waitFor } from "./daemon-helpers.js";

describe("daemon port conflict", () => {
  it("a second daemon on a port that an inkwire daemon owns exits 0 and never opens a DB", async () => {
    const port = await freePort();
    const first = spawnDaemon(port, tempDir("port-first"), { INKWIRE_IDLE_GRACE_MS: "off" });
    let second: ReturnType<typeof spawnDaemon> | null = null;
    try {
      await waitFor(() => health(port), 15_000);
      const loserDir = tempDir("port-loser");
      second = spawnDaemon(port, loserDir, { INKWIRE_IDLE_GRACE_MS: "off" });
      const code = await second.exited;
      expect(code).toBe(0);
      expect(second.stderr()).toContain("another inkwire daemon already owns port");
      expect(existsSync(path.join(loserDir, "inkwire.db"))).toBe(false);
      expect(second.stdout()).toBe("");
    } finally {
      second?.child.kill("SIGKILL");
      first.child.kill("SIGKILL");
    }
  }, 30_000);

  it("a plain http server on the port makes the daemon exit 1 with the reason", async () => {
    const port = await freePort();
    const plain = createServer((_req, res) => {
      res.writeHead(404);
      res.end("not here");
    });
    await new Promise<void>((r) => plain.listen(port, "127.0.0.1", () => r()));
    let daemon: ReturnType<typeof spawnDaemon> | null = null;
    try {
      daemon = spawnDaemon(port, tempDir("port-plain"), { INKWIRE_IDLE_GRACE_MS: "off" });
      expect(await daemon.exited).toBe(1);
      expect(daemon.stderr()).toContain("taken by another process");
      expect(daemon.stderr()).not.toContain("Unhandled");
      expect(daemon.stdout()).toBe("");
    } finally {
      daemon?.child.kill("SIGKILL");
      plain.closeAllConnections();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  }, 30_000);
});
