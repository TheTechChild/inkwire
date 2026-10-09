// hooks/forward.sh finds the Claude Code pid (the nearest `claude` ancestor)
// and sends it as ?pid= on the hook URL. It must exit 0 on every failure.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../hooks/forward.sh", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "inkwire-forward-"));
const claude = path.join(dir, "claude");
symlinkSync("/bin/sh", claude);

// A stub `ps` on PATH that breaks one of the two matches, so each branch of
// forward.sh is tested alone. FAKE_PS=cut-comm gives the cut comm that macOS
// ps can give (/private/tmp/cla); FAKE_PS=node-args gives the args of Claude
// Code run as node. Every other query goes to the real ps.
const stubBin = path.join(dir, "bin");
mkdirSync(stubBin);
writeFileSync(
  path.join(stubBin, "ps"),
  `#!/bin/sh
case "$FAKE_PS:$2" in
  cut-comm:comm=) echo /private/tmp/cla; exit 0 ;;
  node-args:args=) echo "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"; exit 0 ;;
esac
exec /bin/ps "$@"
`,
);
chmodSync(path.join(stubBin, "ps"), 0o755);
const stubPath = `${stubBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;

let server: Server;
let port: number;
const hits: URLSearchParams[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(new URL(req.url ?? "/", "http://localhost").searchParams);
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Run cmd, feed the event on stdin, and give the pid and exit code of the spawned process. */
function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ pid: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ pid: child.pid!, code }));
    child.stdin.end('{"hook_event_name":"Stop"}');
  });
}

describe("hooks/forward.sh", () => {
  it("sends the pid of the nearest claude ancestor", async () => {
    hits.length = 0;
    // `; exit $?` keeps sh from exec-ing forward.sh in place of the claude process.
    const { pid, code } = await run(claude, ["-c", `sh '${script}'; exit $?`], { INKWIRE_PORT: String(port) });
    expect(code).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.get("pid")).toBe(String(pid));
    expect(hits[0]!.get("bg")).toBeTruthy();
  });

  it("the args first-word match alone finds claude when ps cuts comm", async () => {
    hits.length = 0;
    const { pid, code } = await run(claude, ["-c", `sh '${script}'; exit $?`], { INKWIRE_PORT: String(port), PATH: stubPath, FAKE_PS: "cut-comm" });
    expect(code).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.get("pid")).toBe(String(pid));
  });

  it("the comm match alone finds claude when args name node", async () => {
    hits.length = 0;
    const { pid, code } = await run(claude, ["-c", `sh '${script}'; exit $?`], { INKWIRE_PORT: String(port), PATH: stubPath, FAKE_PS: "node-args" });
    expect(code).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.get("pid")).toBe(String(pid));
  });

  it("sends no pid when no claude ancestor exists, and exits 0", async () => {
    hits.length = 0;
    const rc = path.join(dir, "rc");
    // The subshell outlives its parent, so pid 1 adopts it: no claude above forward.sh.
    await run("/bin/sh", ["-c", `( sleep 0.3; echo '{}' | sh '${script}'; echo $? > '${rc}' ) >/dev/null 2>&1 &`], {
      INKWIRE_PORT: String(port),
    });
    for (let i = 0; i < 100 && !existsSync(rc); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(rc, "utf8").trim()).toBe("0");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.has("pid")).toBe(false);
  });

  it("also finds a claude ancestor that is not the direct parent", async () => {
    hits.length = 0;
    const { pid, code } = await run(claude, ["-c", `sh -c "sh '${script}'; exit \\$?"; exit $?`], { INKWIRE_PORT: String(port) });
    expect(code).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.get("pid")).toBe(String(pid));
  });

  it("exits 0 when the server is down", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { code } = await run(claude, ["-c", `sh '${script}'; exit $?`], { INKWIRE_PORT: String(freePort) });
    expect(code).toBe(0);
  });
});
