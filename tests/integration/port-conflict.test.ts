// A second inkwire on an owned port must exit with the clear single-instance
// message — not crash with an unhandled EADDRINUSE (the bug that surfaced as
// CONNECTION_CLOSED in a second Claude session).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

function startServer(port: number, dataDir: string) {
  return spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env: { ...process.env, INKWIRE_PORT: String(port), INKWIRE_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("port conflict", () => {
  it("second instance exits cleanly, naming the running server", async () => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const dataDir = mkdtempSync(path.join(tmpdir(), "inkwire-conflict-"));

    const first = startServer(port, dataDir);
    try {
      // Wait for the first server to own the port.
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          return res.ok;
        } catch {
          return false;
        }
      });

      const second = startServer(port, dataDir);
      let stderr = "";
      second.stderr!.on("data", (chunk) => (stderr += String(chunk)));
      const code = await new Promise<number | null>((resolve) => second.on("exit", resolve));

      expect(code).toBe(1);
      expect(stderr).toContain("another inkwire server already owns port");
      expect(stderr).not.toContain("Unhandled");
    } finally {
      first.kill("SIGTERM");
    }
  }, 20000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("condition not met in time");
}
