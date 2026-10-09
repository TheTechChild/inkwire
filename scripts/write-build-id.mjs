/*
 * Writes dist/build.json: { id, built_at } (ADR 0001, plan M4.1). `yarn build` runs it last.
 *
 * The id is the first 16 hex of a sha256 over every built file in dist/server, dist/core,
 * dist/shared, dist/link and dist/ui: each relative path and its content, in sorted path order.
 * build.json itself is skipped, and built_at is not in the hash, so a rebuild with the same
 * output keeps the same id. The daemon reads this file one time, at boot.
 *
 * Plain .mjs for the same reason as map-anchor-check.mjs: `node file.mjs` needs no install.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILT_DIRS = ['server', 'core', 'shared', 'link', 'ui']

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of every file under dir
 */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * The build id of a dist directory.
 * @param {string} distDir
 * @returns {string}
 */
export function buildId(distDir) {
  const files = []
  for (const sub of BUILT_DIRS) {
    const dir = join(distDir, sub)
    if (existsSync(dir)) files.push(...walk(dir))
  }
  const rel = files
    .map((f) => relative(distDir, f).split(sep).join('/'))
    .filter((p) => p !== 'build.json')
    .sort()
  const hash = createHash('sha256')
  for (const p of rel) {
    hash.update(p)
    hash.update('\0')
    hash.update(readFileSync(join(distDir, p)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Write <distDir>/build.json and return what it wrote.
 * @param {string} distDir
 * @param {Date} [now]
 * @returns {{ id: string, built_at: string }}
 */
export function writeBuildId(distDir, now = new Date()) {
  const info = { id: buildId(distDir), built_at: now.toISOString() }
  writeFileSync(join(distDir, 'build.json'), JSON.stringify(info, null, 2) + '\n')
  return info
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const distDir = process.argv[2] ?? join(process.cwd(), 'dist')
  const info = writeBuildId(distDir)
  console.error(`build ${info.id} (${info.built_at})`)
}
