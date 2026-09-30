/*
 * Verifies MAP.md anchors still point at the symbols they name.
 *
 * Anchor format in MAP.md:  <repo-relative-path>:<line>  <symbol>
 *
 * Two modes, one implementation — so the local nudge and the CI gate can never disagree:
 *
 *   --all [dir]  CI gate. Checks every anchor in every MAP.md and exits non-zero on drift, or if
 *                it finds no anchors at all. This is the real gate: a Stop hook only ever sees one
 *                agent's worktree, never the merge result that lands on main. `dir` defaults to
 *                the working directory and exists so tests can point it at a fixture repo.
 *
 *   (no args)    Claude Code Stop hook, fired once when the whole unit of work is done — after any
 *                subagents have handed back and the main thread finishes. Reads the hook payload
 *                on stdin and checks only anchors pointing into TypeScript files this branch
 *                changed.
 *
 *                First stop of a turn: emits a `block` decision so the agent fixes the map, and
 *                leaves a marker file recording that WE blocked. The stop that follows: if our
 *                marker is there, re-check and REPORT the outcome (never block, so the turn cannot
 *                loop), then clear the marker. `stop_hook_active` only means "some hook blocked",
 *                so without the marker we would report on another hook's continuation.
 *
 *                Registered on Stop only, deliberately. SubagentStop fires per subagent — the
 *                wrong boundary, and it interrupts M times instead of once. The main thread's Stop
 *                already sees every subagent's edits, because the check reads the git working tree.
 *
 * Plain .mjs with JSDoc types rather than .ts on purpose: this runs as a Stop hook in worktrees
 * that have no `yarn install`, and on whatever Node a developer has. `node file.mjs` needs neither,
 * while tsx needs an install and native type stripping needs Node >= 23.6 — above the version this
 * repo pins. Revisit once the Node floor moves.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @typedef {object} Anchor
 * @property {string} map      MAP.md path, relative to the repo root
 * @property {number} mapLine  1-based line in that MAP.md where the anchor is written
 * @property {string} path     source file the anchor points at, relative to the repo root
 * @property {number} line     1-based line in that source file
 * @property {string} symbol   identifier expected on that line
 */

/**
 * @typedef {object} HookPayload
 * @property {string} [cwd]
 * @property {string} [session_id]
 * @property {boolean} [stop_hook_active]
 */

const ANCHOR_PATTERN = /([A-Za-z0-9_./-]+\.tsx?):(\d+)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Runs git and returns stdout, or '' if the command fails. Callers treat '' as "not available",
 * which is why no failure is thrown: a missing ref is an expected outcome here, not an error.
 * @param {string} root
 * @param {...string} args
 * @returns {string}
 */
const git = (root, ...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/** @param {string} raw @returns {string[]} */
const lineList = (raw) => raw.split('\n').filter((entry) => entry.length > 0)

/** @param {string} value @returns {string} */
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/**
 * Whole-word match. A bare substring test lets "active" keep resolving after the route it
 * anchors is renamed to "inactive".
 * @param {string} haystack @param {string} needle @returns {boolean}
 */
const containsWord = (haystack, needle) =>
  new RegExp(`(^|[^A-Za-z0-9_])${escapeForRegex(needle)}($|[^A-Za-z0-9_])`).test(haystack)

/**
 * Splits without inventing a trailing empty line, so `lines.length` is the real line count and an
 * empty file yields zero lines rather than one blank one.
 * @param {string} content @returns {string[]}
 */
const splitLines = (content) =>
  content.length === 0 ? [] : content.replace(/\n$/, '').split('\n')

/** @returns {HookPayload} */
const readPayload = () => {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw.trim().length === 0 ? {} : JSON.parse(raw)
  } catch {
    return {}
  }
}

/** @param {string} root @returns {string[]} */
const findMaps = (root) =>
  lineList(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', '*MAP.md'))

/**
 * Returns null when the map cannot be read. `ls-files --cached` keeps listing a MAP.md deleted
 * from the worktree with plain `rm`, and an unguarded read there would take the whole gate down
 * with a stack trace instead of reporting the problem.
 * @param {string} root @param {string} map @returns {Anchor[] | null}
 */
const parseAnchors = (root, map) => {
  /** @type {string} */
  let content
  try {
    content = readFileSync(join(root, map), 'utf8')
  } catch {
    return null
  }
  /** @type {Anchor[]} */
  const anchors = []
  splitLines(content).forEach((text, index) => {
    for (const match of text.matchAll(ANCHOR_PATTERN)) {
      anchors.push({
        map,
        mapLine: index + 1,
        path: match[1],
        line: Number(match[2]),
        symbol: match[3],
      })
    }
  })
  return anchors
}

/** @param {string} root @param {Anchor} anchor @returns {string | null} */
const describeDrift = (root, anchor) => {
  const { map, mapLine, path, line, symbol } = anchor
  if (!Number.isInteger(line) || line < 1) {
    return `  ${map}:${mapLine}  ${path}:${line} is not a valid line number (anchor ${symbol})`
  }
  /** @type {string[]} */
  let lines
  try {
    lines = splitLines(readFileSync(join(root, path), 'utf8'))
  } catch {
    return `  ${map}:${mapLine}  ${path} is missing or unreadable (anchor ${symbol})`
  }
  if (line > lines.length) {
    return `  ${map}:${mapLine}  ${path}:${line} is past the end of the file (anchor ${symbol})`
  }
  const found = lines[line - 1]
  if (containsWord(found, symbol)) return null
  return `  ${map}:${mapLine}  expects ${symbol} at ${path}:${line} — line reads: ${found.length === 0 ? '<blank line>' : found}`
}

/**
 * origin/main first: a clone made with `--branch <feature>` has no local main, and losing this
 * drops the committed half of the branch diff.
 * @param {string} root @returns {string}
 */
const resolveBase = (root) => {
  for (const ref of ['origin/main', 'main']) {
    const base = git(root, 'merge-base', 'HEAD', ref).trim()
    if (base.length > 0) return base
  }
  return ''
}

/**
 * Removes the marker, ignoring any failure. A marker we cannot delete only costs a stale file in
 * the temp dir; throwing here would take down the stop that was about to report success.
 * @param {string} marker @returns {void}
 */
const clearMarker = (marker) => {
  try {
    rmSync(marker, { force: true })
  } catch {
    // stale marker in the temp dir is harmless
  }
}

/** @param {string} root @param {string} base @returns {Set<string>} */
const changedSources = (root, base) => {
  const entries = [
    base.length > 0 ? git(root, 'diff', '--name-only', base, 'HEAD') : '',
    git(root, 'diff', '--name-only', 'HEAD'),
    git(root, 'ls-files', '--others', '--exclude-standard'),
  ]
  return new Set(entries.flatMap(lineList).filter((path) => /\.tsx?$/.test(path)))
}

/**
 * @typedef {object} Findings
 * @property {string[]} lines       every problem, in report order
 * @property {number} drifted       anchors whose symbol moved
 * @property {number} unreadable    maps that could not be read at all
 * @property {number} total         anchors actually examined on this walk
 */

/**
 * Counts drifted anchors and unreadable maps separately. Lumping them together made the headline
 * ratio compare two different things — an unreadable map contributes a finding but none of its
 * anchors reach `total`, so a single unreadable map reported as "1 of 0 drifted".
 * @param {string} root
 * @param {Set<string> | null} touched  null checks every anchor
 * @returns {Findings}
 */
const collectFindings = (root, touched) => {
  /** @type {Findings} */
  const findings = { lines: [], drifted: 0, unreadable: 0, total: 0 }
  for (const map of findMaps(root)) {
    const anchors = parseAnchors(root, map)
    if (anchors === null) {
      findings.lines.push(`  ${map} is tracked by git but could not be read — deleted without \`git rm\`?`)
      findings.unreadable += 1
      continue
    }
    findings.total += anchors.length
    for (const anchor of anchors) {
      if (touched !== null && !touched.has(anchor.path)) continue
      const entry = describeDrift(root, anchor)
      if (entry === null) continue
      findings.lines.push(entry)
      findings.drifted += 1
    }
  }
  return findings
}

/**
 * Headline that matches the detail beneath it: a drifted anchor is a ratio of anchors, an
 * unreadable map is a count of maps, and they are not interchangeable.
 * @param {Findings} findings @returns {string}
 */
const summarize = ({ drifted, unreadable, total }) => {
  const parts = []
  if (drifted > 0) parts.push(`${drifted} of ${total} drifted`)
  if (unreadable > 0) parts.push(`${unreadable} map${unreadable === 1 ? '' : 's'} could not be read`)
  return parts.join(', ')
}

/** @param {string} from @returns {string} */
const repoRoot = (from) => git(from, 'rev-parse', '--show-toplevel').trim()

/** @param {string} target @returns {never} */
const runAll = (target) => {
  const root = repoRoot(target)
  if (root.length === 0) {
    console.error('map-anchor-check: not a git repository')
    process.exit(1)
  }
  // One walk produces both the findings and the total, so the headline provably counts the same
  // anchors the checker examined rather than a second, independently gathered number.
  const findings = collectFindings(root, null)
  if (findings.lines.length === 0 && findings.total === 0) {
    console.error('map-anchor-check: found no MAP.md anchors at all — expected at least one.')
    console.error("Either the maps moved out of reach of '*MAP.md', or the anchor format changed.")
    process.exit(1)
  }
  if (findings.lines.length > 0) {
    console.log(`MAP.md anchors are stale — ${summarize(findings)}:`)
    console.log(findings.lines.join('\n'))
    console.log('')
    console.log('Fix the line number or symbol in the MAP.md file, or remove the anchor if the code is gone.')
    process.exit(1)
  }
  console.log(`MAP.md anchors OK — ${findings.total} checked.`)
  process.exit(0)
}

/** @returns {never} */
const runHook = () => {
  // With no args the script waits for a hook payload on stdin. From a terminal that just hangs,
  // so say what it wants instead of appearing to freeze.
  if (process.stdin.isTTY) {
    console.error('map-anchor-check: with no arguments this reads a Claude Code Stop hook payload on stdin.')
    console.error('To check every anchor:  node scripts/map-anchor-check.mjs --all [dir]')
    process.exit(1)
  }
  const payload = readPayload()
  const root = repoRoot(payload.cwd && payload.cwd.length > 0 ? payload.cwd : process.cwd())
  if (root.length === 0) process.exit(0)

  const session = (payload.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'nosession'
  const marker = join(tmpdir(), `claude-map-anchor-${session}.blocked`)
  const continuing = payload.stop_hook_active === true

  // A continuation we did not cause belongs to some other Stop hook — say nothing.
  if (continuing && !existsSync(marker)) process.exit(0)

  const base = resolveBase(root)
  const touched = changedSources(root, base)
  // No branch point at all (detached HEAD, single-branch clone). Scoping is impossible, so widen
  // to every anchor rather than silently check less than intended.
  const widened = base.length === 0
  const drift = (widened || touched.size > 0 ? collectFindings(root, widened ? null : touched) : { lines: [] }).lines

  if (continuing) {
    clearMarker(marker)
    console.log(
      JSON.stringify({
        systemMessage:
          drift.length > 0
            ? `MAP.md anchors are STILL stale after the fix:\n${drift.join('\n')}`
            : 'MAP.md anchors re-checked — clean.',
      }),
    )
    process.exit(0)
  }

  if (drift.length === 0) {
    clearMarker(marker)
    process.exit(0)
  }

  // The block matters more than the follow-up report: if the marker cannot be written (read-only
  // or full temp dir, restricted sandbox) still deliver the block, and simply forgo the re-check
  // on the next stop rather than throwing away a real finding with a stack trace.
  try {
    writeFileSync(marker, '')
  } catch {
    // no marker, so the next stop stays silent instead of confirming — an acceptable loss
  }
  const note = widened
    ? ' (no branch point found — checked every anchor, so some may predate your work)'
    : ''
  console.log(
    JSON.stringify({
      decision: 'block',
      reason:
        `MAP.md anchors are stale for files this branch changed${note}. Re-read each one and ` +
        `correct the line number or symbol, then add entries for any code path you introduced ` +
        `that the map does not cover:\n${drift.join('\n')}`,
    }),
  )
  process.exit(0)
}

const args = process.argv.slice(2)
// Without this, any argument that is not --all falls through to hook mode, which reads an empty
// stdin and exits 0. A typo'd flag in a CI step would then pass green having gated nothing — the
// exact failure this script exists to catch.
if (args.length > 0 && args[0] !== '--all') {
  console.error(`map-anchor-check: unknown argument '${args[0]}' — did you mean --all?`)
  console.error('Usage:  node scripts/map-anchor-check.mjs --all [dir]   (CI gate)')
  console.error('        node scripts/map-anchor-check.mjs               (Stop hook, payload on stdin)')
  process.exit(1)
}
if (args[0] === '--all') runAll(args[1] ?? process.cwd())
else runHook()
