// The autostart (autostart.ts): a relay starts the daemon of the newest
// registered build. When that daemon exits with an error before it answers
// (a build that cannot boot), the relay starts the next build in the order,
// and at the end its own. Random port, temp data dir; the test kills each
// daemon that it started.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDaemon } from "../../plugin/src/link/autostart.ts";
import { readBuildInfo, readRegistry, registerBuild } from "../../plugin/src/server/build-info.ts";
import { freePort, killTree, root, tempDir, testEnv, waitFor, alive } from "../integration/daemon-helpers.ts";

/** A plugin root whose daemon exits with code 3 at once: a build that cannot boot. */
function brokenRoot(): string {
  const broken = path.join(tempDir("autostart-broken"), "plugin");
  mkdirSync(path.join(broken, "src", "server"), { recursive: true });
  writeFileSync(path.join(broken, "src", "server", "daemon.ts"), 'console.error("broken build");\nprocess.exit(3);\n');
  return broken;
}

describe("autostart", () => {
  it("falls back to the relay's own build when the newest build's daemon exits with an error", async () => {
    const dataDir = tempDir("autostart-fallback");
    const port = await freePort();
    const own = path.join(root, "plugin");
    const broken = brokenRoot();
    registerBuild(dataDir, "broken0000000000", broken, { now: new Date(Date.now() + 86_400_000) });
    let registered = 0;
    let pid: number | undefined;
    try {
      const health = await ensureDaemon({
        port,
        dataDir,
        env: testEnv(port, dataDir, { INKWIRE_IDLE_GRACE_MS: "off" }),
        ownRoot: own,
        timeoutMs: 15_000,
        register: () => registered++,
      });
      pid = health.pid;
      expect(health.build.id).toBe(readBuildInfo(path.join(own, "src")).id);
      expect(registered).toBe(1);
      const log = readFileSync(path.join(dataDir, "daemon.log"), "utf8");
      expect(log).toContain("broken build");
      // The broken build stays in the registry; the next autostart tries it first again.
      expect(readRegistry(dataDir)["broken0000000000"]?.root).toBe(broken);
      expect(existsSync(path.join(broken, "src", "server", "daemon.ts"))).toBe(true);
    } finally {
      if (pid !== undefined) {
        killTree(pid);
        const dead = pid;
        await waitFor(() => !alive(dead), 5000);
      }
    }
  }, 30_000);
});
