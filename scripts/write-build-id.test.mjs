// node --test scripts/write-build-id.test.mjs (yarn build-id:test). vitest does not run .mjs files here.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeBuildId } from './write-build-id.mjs'

function fixture() {
  const dist = mkdtempSync(join(tmpdir(), 'inkwire-build-id-'))
  mkdirSync(join(dist, 'server'), { recursive: true })
  mkdirSync(join(dist, 'ui'), { recursive: true })
  writeFileSync(join(dist, 'server', 'daemon.js'), 'console.error("daemon")\n')
  writeFileSync(join(dist, 'ui', 'main.js'), 'export {}\n')
  return dist
}

test('two runs on one tree give the same id and a different built_at', () => {
  const dist = fixture()
  try {
    const a = writeBuildId(dist, new Date('2026-10-08T10:00:00.000Z'))
    const b = writeBuildId(dist, new Date('2026-10-08T11:00:00.000Z'))
    assert.equal(a.id, b.id)
    assert.notEqual(a.built_at, b.built_at)
    assert.match(a.id, /^[0-9a-f]{16}$/)
    assert.deepEqual(JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')), b)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('a changed byte gives a different id', () => {
  const dist = fixture()
  try {
    const a = writeBuildId(dist)
    writeFileSync(join(dist, 'server', 'daemon.js'), 'console.error("daemoN")\n')
    const b = writeBuildId(dist)
    assert.notEqual(a.id, b.id)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('files outside the built dirs do not change the id', () => {
  const dist = fixture()
  try {
    const a = writeBuildId(dist)
    writeFileSync(join(dist, 'notes.txt'), 'not part of the build\n')
    assert.equal(writeBuildId(dist).id, a.id)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
