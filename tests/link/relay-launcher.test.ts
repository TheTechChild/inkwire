// relay.sh, the command of plugin.json (ADR 0005): it runs relay.ts with
// Node 26 or later. The node on PATH can come from the .nvmrc of the project
// of the session. Fake node and mise scripts on PATH show which command
// relay.sh runs, and that it runs it with exec (the pid stays, so the relay's
// ppid is the Claude Code pid).
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root, tempDir } from "../integration/daemon-helpers.ts";

const LAUNCHER = path.join(root, "plugin", "src", "link", "relay.sh");
const RELAY = path.join(root, "plugin", "src", "link", "relay.ts");

/** A bin folder with a fake node that says it is `major`, and a fake mise when `mise` is true. */
function fakeBin(major: number | null, mise: boolean): string {
  const bin = path.join(tempDir("relay-launcher"), "bin");
  mkdirSync(bin, { recursive: true });
  const write = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  if (major !== null) write("node", `if [ "$1" = "-p" ]; then echo ${major}; exit 0; fi\necho "node pid=$$ $*"`);
  if (mise) write("mise", `echo "mise pid=$$ $*"`);
  return bin;
}

function run(bin: string): Promise<{ code: number | null; pid: number; out: string; err: string }> {
  return new Promise((resolve) => {
    // /bin and /usr/bin for sh, dirname and the shell tools; no real node or mise.
    const child = spawn("/bin/sh", [LAUNCHER], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("exit", (code) => resolve({ code, pid: child.pid!, out: out.trim(), err }));
  });
}

describe("relay.sh", () => {
  it("runs the node on PATH with exec when it is Node 26 or later", async () => {
    const r = await run(fakeBin(26, true));
    expect(r.code).toBe(0);
    expect(r.out).toBe(`node pid=${r.pid} ${RELAY}`);
  });

  it("runs Node 26 through mise with exec when the node on PATH is older (a project .nvmrc)", async () => {
    const r = await run(fakeBin(20, true));
    expect(r.code).toBe(0);
    expect(r.out).toBe(`mise pid=${r.pid} x node@26 -- node ${RELAY}`);
  });

  it("uses mise when no node is on PATH", async () => {
    const r = await run(fakeBin(null, true));
    expect(r.out).toBe(`mise pid=${r.pid} x node@26 -- node ${RELAY}`);
  });

  it("stops with a message on stderr and nothing on stdout when there is no Node 26 and no mise", async () => {
    const r = await run(fakeBin(22, false));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("Node 26 or later is necessary, but the node on PATH is 22");
  });
});
