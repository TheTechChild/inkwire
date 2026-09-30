// Tests for scripts/map-anchor-check.mjs, which is both a Stop hook and a CI gate.
//
// Every case here is a bug that shipped. The script guards the MAP.md files, nothing guards the
// script, and its failure mode is silence: each of these bugs made it report success while
// checking less than it claimed. A green run that verified nothing is worse than no check at all,
// so the assertions below care as much about what the script *fails* on as what it passes.
//
// Each test builds a throwaway git repo in a temp dir, because the script reads git state
// (branch point, tracked files) and behaves differently in a fresh clone than in a worktree.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { after, test } from 'node:test'

// Spawns keep cwd here and point at the fixture repo instead: --all takes it as an argument, and
// hook mode takes it from the payload's `cwd`.
const REPO = process.cwd()
const SCRIPT = 'scripts/map-anchor-check.mjs'
const scratch = []

after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })))

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })

const write = (cwd, path, body) => {
  mkdirSync(join(cwd, dirname(path)), { recursive: true })
  writeFileSync(join(cwd, path), body)
}

const makeRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'map-anchor-'))
  scratch.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  for (const [path, body] of Object.entries(files)) write(dir, path, body)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const run = (args, input) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', input })

const runAll = (dir) => {
  const r = run(['--all', dir])
  return { code: r.status, out: r.stdout + r.stderr }
}

// Session ids key a marker file in the real tmpdir, so fixed ids would let two concurrent runs
// on one host cross-contaminate. Each test gets its own.
const runHook = (dir, { continuing = false, session = randomUUID(), env } = {}) => {
  const payload = JSON.stringify({ cwd: dir, session_id: session, stop_hook_active: continuing })
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    input: payload,
    env: { ...process.env, ...env },
  })
  return { code: r.status, out: r.stdout, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }
}

test('--all passes when every anchor resolves', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  const { code, out } = runAll(dir)
  assert.equal(code, 0)
  assert.match(out, /1 checked/)
})

test('--all fails when a symbol has moved off its line', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /1 of 1 drifted/)
})

// A gate that finds nothing must fail, not report OK. Renaming or moving the maps used to
// print "MAP.md anchors OK — 0 checked." and exit 0.
test('--all fails when it finds no anchors at all', () => {
  const dir = makeRepo({ 'src/a.ts': 'export const alpha = 1\n' })
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /no MAP\.md anchors at all/)
})

// The counter used `[ \t]`, which in a POSIX bracket expression is space/backslash/t, not a tab.
// The awk matcher did honour the tab, so the two disagreed and the reported total was wrong.
test('--all counts a tab-separated anchor the same as a space-separated one', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1\talpha\n',
  })
  const { code, out } = runAll(dir)
  assert.equal(code, 0)
  assert.match(out, /1 checked/)
})

// Substring matching let "active" keep resolving after the route became "inactive".
test('--all matches whole words, not substrings', () => {
  const dir = makeRepo({
    'src/routes.ts': "app.post('/api/cache/active', handler)\n",
    'MAP.md': 'src/routes.ts:1  active\n',
  })
  assert.equal(runAll(dir).code, 0, 'baseline should pass')
  write(dir, 'src/routes.ts', "app.post('/api/cache/inactive', handler)\n")
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /drifted/)
})

// getline returns 0 at EOF and -1 on error. Treating both as "gone" reported an existing but
// empty file as deleted.
test('--all distinguishes an empty file from a deleted one', () => {
  const dir = makeRepo({ 'src/e.ts': '', 'MAP.md': 'src/e.ts:1  thing\n' })
  const empty = runAll(dir)
  assert.equal(empty.code, 1)
  assert.match(empty.out, /past the end of the file/)
  assert.doesNotMatch(empty.out, /missing or unreadable/)

  rmSync(join(dir, 'src/e.ts'))
  const gone = runAll(dir)
  assert.equal(gone.code, 1)
  assert.match(gone.out, /missing or unreadable/)
})

test('--all distinguishes a blank line from running past the end of the file', () => {
  const dir = makeRepo({
    'src/b.ts': 'one\n\nthree\n',
    'MAP.md': 'src/b.ts:2  foo\nsrc/b.ts:99  bar\n',
  })
  const { out } = runAll(dir)
  assert.match(out, /<blank line>/)
  assert.match(out, /:99 is past the end of the file/)
})

test('--all ignores anchors whose line still holds the symbol after unrelated edits', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\nexport const beta = 2\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', 'export const alpha = 99\nexport const beta = 2\n')
  assert.equal(runAll(dir).code, 0)
})

test('hook mode stays silent when nothing drifted', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  const { code, out } = runHook(dir)
  assert.equal(code, 0)
  assert.equal(out.trim(), '')
})

test('hook mode blocks on drift in an uncommitted edit', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')
  const { json } = runHook(dir)
  assert.equal(json.decision, 'block')
  assert.match(json.reason, /src\/a\.ts/)
})

// The branch point was resolved against a local `main` only. A clone made with
// `--branch <feature>` has origin/main but no local main, so the committed half of the diff was
// dropped and drift already committed to the branch passed silently.
test('hook mode sees drift committed to the branch when only origin/main exists', () => {
  const origin = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  const bare = mkdtempSync(join(tmpdir(), 'map-anchor-origin-'))
  scratch.push(bare)
  git(origin, 'clone', '-q', '--bare', origin, join(bare, 'o.git'))

  const clone = mkdtempSync(join(tmpdir(), 'map-anchor-clone-'))
  scratch.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', join(bare, 'o.git'), clone])
  git(clone, 'config', 'user.email', 'test@test')
  git(clone, 'config', 'user.name', 'test')
  git(clone, 'checkout', '-qb', 'feature')
  git(clone, 'branch', '-qD', 'main')
  assert.throws(() => git(clone, 'rev-parse', '--verify', 'main'), 'local main must not exist')

  write(clone, 'src/a.ts', '\nexport const alpha = 1\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-qm', 'shift the mapped file')
  assert.equal(git(clone, 'status', '--porcelain').toString().trim(), '', 'tree must be clean')

  const { json } = runHook(clone)
  assert.ok(json, 'hook must report drift that exists only in a commit')
  assert.equal(json.decision, 'block')
})

// stop_hook_active only means "some hook blocked". Without a marker of our own we would report on
// another hook's continuation.
test('hook mode stays silent on a continuation it did not cause', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')
  const { code, out } = runHook(dir, { continuing: true, session: randomUUID() })
  assert.equal(code, 0)
  assert.equal(out.trim(), '')
})

test('hook mode reports, and does not block, on its own continuation', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')

  const cycle = randomUUID()
  const blocked = runHook(dir, { session: cycle })
  assert.equal(blocked.json.decision, 'block')

  const stillStale = runHook(dir, { continuing: true, session: cycle })
  assert.equal(stillStale.json.decision, undefined, 'must never block twice')
  assert.match(stillStale.json.systemMessage, /STILL stale/)

  runHook(dir, { session: cycle })
  write(dir, 'MAP.md', 'src/a.ts:2  alpha\n')
  const fixed = runHook(dir, { continuing: true, session: cycle })
  assert.equal(fixed.json.decision, undefined)
  assert.match(fixed.json.systemMessage, /clean/)
})

// `ls-files --cached` keeps listing a MAP.md deleted from the worktree with plain `rm`. Reading it
// unguarded used to throw ENOENT out of the process, so every Stop for the rest of the session
// ended in a stack trace instead of a report.
test('--all reports an unreadable map instead of crashing', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  rmSync(join(dir, 'MAP.md'))
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /could not be read/)
  assert.doesNotMatch(out, /no MAP\.md anchors at all/, 'must not be mistaken for missing maps')
  assert.doesNotMatch(out, /ENOENT|at Object\.readFileSync/, 'must not leak a stack trace')
  // The headline must count maps, not pretend an unreadable map is a drifted anchor.
  assert.match(out, /1 map could not be read/)
  assert.doesNotMatch(out, /of 0 drifted/, 'ratio must not compare anchors against an empty total')
})

// A drifted anchor is a ratio of anchors; an unreadable map is a count of maps. Reporting both at
// once must keep them distinct rather than summing them into one misleading number.
test('--all headlines drifted anchors and unreadable maps separately', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
    'docs/MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')
  rmSync(join(dir, 'docs/MAP.md'))
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /1 of 1 drifted/, 'the ratio counts only anchors that were actually read')
  assert.match(out, /1 map could not be read/)
})

// An anchor written :0 indexed lines[-1], so `found.length` threw a TypeError — a typo in a map
// took the whole gate down rather than being reported as the bad anchor it is.
test('--all reports a zero or negative line number instead of crashing', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:0  alpha\n',
  })
  const { code, out } = runAll(dir)
  assert.equal(code, 1)
  assert.match(out, /is not a valid line number/)
  assert.doesNotMatch(out, /TypeError/, 'must not leak a stack trace')
})

// With no branch point the hook cannot scope to this branch, so it widens to every anchor rather
// than silently checking less. That widening is the most surprising branch in the script.
test('hook mode widens to every anchor when there is no branch point', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'src/b.ts': 'export const beta = 2\n',
    'MAP.md': 'src/a.ts:1  alpha\nsrc/b.ts:1  beta\n',
  })
  // Detached HEAD with no origin: resolveBase finds neither origin/main nor main.
  git(dir, 'checkout', '-q', '--detach')
  git(dir, 'branch', '-qD', 'main')
  assert.throws(() => git(dir, 'rev-parse', '--verify', 'main'), 'no branch point may remain')

  // Drift in a file this session never touched — only the widened path can see it.
  write(dir, 'src/b.ts', '\nexport const beta = 2\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'shift b')
  assert.equal(git(dir, 'status', '--porcelain').toString().trim(), '')

  const { json } = runHook(dir)
  assert.ok(json, 'widened check must still report')
  assert.equal(json.decision, 'block')
  assert.match(json.reason, /no branch point found/)
  assert.match(json.reason, /src\/b\.ts/)
})

// Any argument that is not --all used to fall through to hook mode, which reads an empty stdin and
// exits 0. A typo'd flag in a CI step would pass green having gated nothing.
test('a mistyped flag fails instead of silently taking the hook path', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:99  alpha\n',
  })
  const broken = runAll(dir)
  assert.equal(broken.code, 1, 'fixture must be genuinely broken')

  const typo = run(['--al', dir])
  assert.equal(typo.status, 1, 'a typo must not pass green')
  assert.match(typo.stderr, /unknown argument/)

  const alsoTypo = run(['-all', dir])
  assert.equal(alsoTypo.status, 1)
})

// The marker write sits after the drift has already been found. Letting it throw threw away a real
// finding and ended every subsequent stop in a stack trace — the same class as the deleted-map and
// :0 crashes, in the one place it costs the most.
test('hook mode still blocks when the marker cannot be written', () => {
  const dir = makeRepo({
    'src/a.ts': 'export const alpha = 1\n',
    'MAP.md': 'src/a.ts:1  alpha\n',
  })
  write(dir, 'src/a.ts', '\nexport const alpha = 1\n')

  const readOnly = mkdtempSync(join(tmpdir(), 'map-anchor-ro-'))
  scratch.push(readOnly)
  chmodSync(readOnly, 0o500)
  try {
    writeFileSync(join(readOnly, 'probe'), '')
    return // running as root, chmod does not bite — nothing to assert
  } catch {
    // good: the directory really is unwritable
  }

  const { code, out, json } = runHook(dir, { env: { TMPDIR: readOnly } })
  assert.equal(code, 0, 'must not crash')
  assert.doesNotMatch(out, /writeFileUtf8|EACCES|EPERM/, 'must not leak a stack trace')
  assert.ok(json, 'the block must still be delivered')
  assert.equal(json.decision, 'block')
})
