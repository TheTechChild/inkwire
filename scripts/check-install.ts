// Installs the plugin as Claude Code does and runs it once.
//
// Usage: node scripts/check-install.ts   (yarn check-install)
//
// 1. Copy plugin/ to a temp folder outside the repo (so that Node cannot
//    find the root node_modules).
// 2. Run "npm ci --ignore-scripts" there. It must finish in 60 s.
// 3. Start the relay as plugin.json does (node <copy>/src/link/relay.ts)
//    with a temp INKWIRE_DATA_DIR, a random INKWIRE_PORT and a clean env.
// 4. Do the MCP handshake, list the tools and call boards_create.
// 5. Check that the relay started the daemon from the copy, and GET /,
//    /main.js and /styles.css from it.
// 6. Stop the relay, then the daemon (the idle grace stops it), and remove
//    the temp folder.
//
// This script never uses port 4691 or 4692 and never uses ~/.inkwire.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_LIMIT_MS = 60_000;
const IDLE_GRACE_MS = 300;

function log(message: string): void {
  console.error(`check-install: ${message}`);
}

/** A port that the OS gives as free, never 4691 or 4692. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port !== 0 && port !== 4691 && port !== 4692) return port;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
}

function text(result: unknown, index: number): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content[index]?.text ?? "";
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), "inkwire-install-"));
  const pluginDir = path.join(work, "plugin");
  const cwd = path.join(work, "cwd");
  mkdirSync(cwd);
  let client: Client | undefined;
  let relayPid: number | undefined;
  let daemonPid: number | undefined;
  try {
    // 1. The copy: the files git tracks would be the same set, less the
    // ignored ones. Leave out node_modules and the generated mod types.
    cpSync(path.join(ROOT, "plugin"), pluginDir, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(path.join(ROOT, "plugin"), src);
        return rel !== "node_modules" && rel !== path.join(".claude-plugin", "types");
      },
    });

    // 2. The install.
    const started = Date.now();
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: pluginDir,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: INSTALL_LIMIT_MS,
    });
    const installMs = Date.now() - started;
    log(`npm ci --ignore-scripts: ${(installMs / 1000).toFixed(1)} s`);
    if (installMs > INSTALL_LIMIT_MS) throw new Error(`the install took more than ${INSTALL_LIMIT_MS / 1000} s`);

    // 3. The relay, as plugin.json runs it.
    const port = await freePort();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pluginDir, "src", "link", "relay.ts")],
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? work,
        INKWIRE_PORT: String(port),
        INKWIRE_DATA_DIR: path.join(work, "data"),
        INKWIRE_IDLE_GRACE_MS: String(IDLE_GRACE_MS),
      },
      stderr: "inherit",
    });
    client = new Client({ name: "check-install", version: "0.0.0" });
    await client.connect(transport);
    relayPid = transport.pid ?? undefined;
    log(`relay: MCP handshake OK (port ${port})`);

    // 4. The tools.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["boards_create", "canvas_get_state", "session_mode"]) {
      if (!tools.includes(name)) throw new Error(`tools/list has no ${name}`);
    }
    log(`tools/list: ${tools.length} tools`);
    const created = await client.callTool({ name: "boards_create", arguments: { name: "install check", project_root: cwd } });
    if (created.isError || !/^board b_\w+ "install check" · you: author/.test(text(created, 0))) {
      throw new Error(`boards_create failed: ${text(created, 0)} ${text(created, 1)}`);
    }
    const boardId = (JSON.parse(text(created, 1)) as { board_id?: string }).board_id;
    log(`boards_create: ${boardId}`);

    // 5. The daemon and the panel.
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/healthz`)).json()) as { pid?: number };
    daemonPid = health.pid;
    if (daemonPid === undefined) throw new Error("/healthz has no pid");
    const command = execFileSync("ps", ["-o", "command=", "-p", String(daemonPid)], { encoding: "utf8" });
    const entry = path.join(pluginDir, "src", "server", "daemon.ts");
    if (!command.includes(entry)) throw new Error(`the daemon does not run ${entry}: ${command.trim()}`);
    log(`daemon: pid ${daemonPid} runs the installed copy`);
    for (const [file, type] of [
      ["/", "text/html"],
      ["/main.js", "text/javascript"],
      ["/styles.css", "text/css"],
    ] as const) {
      const res = await fetch(base + file);
      const body = await res.text();
      if (res.status !== 200 || !res.headers.get("content-type")?.includes(type) || body.length === 0) {
        throw new Error(`GET ${file}: ${res.status} ${res.headers.get("content-type")}`);
      }
      log(`GET ${file}: 200 ${type} (${body.length} bytes)`);
    }
  } finally {
    // 6. Stop everything.
    await client?.close().catch(() => {});
    if (relayPid !== undefined && alive(relayPid)) process.kill(relayPid, "SIGKILL");
    if (daemonPid !== undefined) {
      const pid = daemonPid;
      await waitFor(() => !alive(pid), 5000, "the daemon stops after the idle grace").catch((e: unknown) => {
        log(String(e));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      });
    }
    rmSync(work, { recursive: true, force: true });
  }
  log("OK");
}

main().catch((e: unknown) => {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
