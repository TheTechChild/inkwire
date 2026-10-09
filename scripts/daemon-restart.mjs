/*
 * yarn daemon:restart — the person's restart of the inkwire daemon (ADR 0001, plan M4.9).
 * Agents must not run it (Decision 12). It prints the board and client counts that the restart
 * affects, posts POST /api/daemon/restart, waits for that pid to stop, then starts the daemon
 * again from dist (dist/link/autostart.js), so the panel comes back even with no session.
 * A restart drops the undo history and every pending session_send on every board.
 *
 * Env: INKWIRE_PORT (default 4691), INKWIRE_DATA_DIR (default ~/.inkwire).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.INKWIRE_PORT ?? 4691)
const base = `http://127.0.0.1:${port}`
const dist = new URL('../dist/', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function health() {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function main() {
  if (!existsSync(fileURLToPath(new URL('link/autostart.js', dist)))) {
    console.error('dist/link/autostart.js is missing: run yarn build first')
    process.exit(1)
  }
  const h = await health()
  if (h && h.name === 'inkwire' && !h.build) {
    console.error(`port ${port} is held by an old inkwire server; close the old Claude Code sessions`)
    process.exit(1)
  }
  if (h && h.name === 'inkwire') {
    console.error(`inkwire daemon pid ${h.pid}, build ${h.build.id}: ${h.boards} open boards, ${h.clients} clients`)
    const res = await fetch(`${base}/api/daemon/restart`, { method: 'POST' })
    if (res.status !== 202) {
      console.error(`restart refused: HTTP ${res.status}`)
      process.exit(1)
    }
    const deadline = Date.now() + 10_000
    while (alive(h.pid) && Date.now() < deadline) await sleep(100)
    if (alive(h.pid)) {
      console.error(`pid ${h.pid} did not stop in 10 s`)
      process.exit(1)
    }
    console.error(`pid ${h.pid} stopped`)
  } else {
    console.error(`no inkwire daemon on port ${port}`)
  }
  const { loadConfig } = await import(new URL('server/config.js', dist).href)
  const { ensureDaemon } = await import(new URL('link/autostart.js', dist).href)
  const config = loadConfig()
  const started = await ensureDaemon({ port: config.port, dataDir: config.dataDir })
  console.error(`inkwire daemon pid ${started.pid}, build ${started.build.id} on ${base}/`)
}

main().catch((err) => {
  console.error(`daemon:restart failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
