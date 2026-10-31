/**
 * Tests for `verify-comment-hygiene.ts`. Two things must hold at once, and they pull
 * in opposite directions: shape and residue rules must fire on history written into a
 * comment, and they must never read a production literal — text that looks like a tag
 * inside a string, template, or regex is content, not narration. Every rule is shown
 * red once, every boundary green once.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-comment-hygiene.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { parseManifest } from './verify-comment-hygiene.ts'
import { commentLines } from './surface.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-comment-hygiene.ts')
const MANIFEST = 'scripts/harness/comment-hygiene.manifest.json'

/** The shapes bootstrap seeds: chronology in any language, and emptied parentheses. */
const STARTER = {
  scan: ['src'],
  labels: [
    { name: 'date stamp', pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { name: 'review round', pattern: '第\\s*\\d{1,3}\\s*轮' },
  ],
  residue: [
    { name: 'emptied parenthesis', pattern: '（\\s*）' },
    { name: 'dash-only parenthesis', pattern: '（\\s*[-—–]+\\s*）' },
  ],
}

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repository with a `src/` tree and the given manifest, ready for a run. */
function repo(files: Record<string, string>, manifest: unknown = STARTER): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-comment-hygiene-'))
  roots.push(root)
  const all: Record<string, string> = { [MANIFEST]: `${JSON.stringify(manifest, null, 2)}\n`, ...files }
  for (const [rel, content] of Object.entries(all)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function run(root: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
}

function combined(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

describe('the comment surface', () => {
  test('reads line comments, and a block comment lands on every line it covers', () => {
    const lines = commentLines(['// first', 'const a = 1', '/* one', 'two */', 'const b = 2'].join('\n'))
    assert.deepEqual(lines.map(line => line.text), [' first', '', ' one', 'two ', ''])
  })

  test('never reads a literal: strings, templates with interpolated code, and regexes', () => {
    const lines = commentLines([
      "const a = '2026-10-13 // not a comment'",
      'const b = `x ${ compute("// also not") }` // 2026-10-13 is a real comment',
      'const re = /(\\s*)/',
      'const half = width / 2 // 第 2 轮',
    ].join('\n'))
    assert.equal(lines[0]?.text, '')
    assert.equal(lines[1]?.text, ' 2026-10-13 is a real comment')
    assert.equal(lines[2]?.text, '')
    assert.equal(lines[3]?.text, ' 第 2 轮')
  })

  test('scans a comment written inside an interpolation, since that is code again', () => {
    const lines = commentLines('const label = `total ${ amount /* 2026-10-13 */ }`')
    assert.equal(lines[0]?.text, ' 2026-10-13 ')
  })
})

describe('shapes declared in the manifest', () => {
  test('passes when comments carry constraints and nothing else', () => {
    const result = run(repo({
      'src/a.ts': '/**\n * Keeps the write path ordered: readers never observe a half-applied batch.\n */\nexport const write = (): void => {}\n',
    }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /4 shape\(s\) enforced, comments carry no history/)
  })

  test('fails on a date stamp written into a line comment', () => {
    const result = run(repo({ 'src/a.ts': 'export const a = 1 // 2026-10-13: switched to the new writer\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /src\/a\.ts:1 — date stamp matches "2026-10-13": export const a = 1/)
    assert.match(result.stderr ?? '', /A comment carries constraints, not chronology/)
  })

  test('fails on a review round written into a block comment', () => {
    const result = run(repo({ 'src/b.ts': '/*\n * Retry budget, see 第 3 轮 review.\n */\nexport const b = 2\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /src\/b\.ts:2 — review round matches "第 3 轮"/)
  })

  test('never fires on a literal that merely looks like a tag', () => {
    const result = run(repo({
      'src/c.ts': 'export const stamp = "2026-10-13"\nexport const re = /第 \\d+ 轮/\nexport const t = `第 ${1} 轮`\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })
})

describe('residue: what a botched cleanup leaves behind', () => {
  test('fails on a parenthesis emptied of its content', () => {
    const result = run(repo({ 'src/a.ts': 'export const a = 1 // reads the catalog （）before writing\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /emptied parenthesis matches "（）"/)
  })

  test('fails on a parenthesis left holding only a dash', () => {
    const result = run(repo({ 'src/a.ts': 'export const a = 1 // keeps the order （-）under contention\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /dash-only parenthesis matches "（-）"/)
  })

  test('leaves half-width parentheses alone, because comments quote code in them', () => {
    const result = run(repo({
      'src/a.ts': 'export const a = 1 // calls run() and passes (a, b)\nexport const b = 2 // 见上（- 说明）\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })
})

describe('the manifest itself', () => {
  test('fails loudly when it is missing', () => {
    const root = repo({ 'src/a.ts': 'export const a = 1\n' })
    rmSync(join(root, MANIFEST))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /no manifest at scripts\/harness\/comment-hygiene\.manifest\.json/)
    assert.match(result.stderr ?? '', /write `\{\}` to declare no rules/)
  })

  test('treats {} as declaring no rules', () => {
    const result = run(repo({ 'src/a.ts': 'export const a = 1 // 2026-10-13\n' }, {}))
    assert.equal(result.status, 0)
    assert.match(result.stdout ?? '', /declares no rules; nothing to check/)
  })

  test('rejects unknown fields, invalid patterns, and suppressions without a reason', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...STARTER, extra: 1 }, /unknown field "extra"/],
      [{ scan: ['src'], labels: [{ name: 'x', pattern: '([' }] }, /not a valid regular expression/],
      [{ scan: ['src'], labels: [{ name: 'x', pattern: 'x' }], exceptions: [{ match: 'V8' }] }, /`reason` is required/],
      [{ scan: ['src'], labels: [{ name: 'x', pattern: 'x' }], anchors: [{ path: 'src/a.ts', text: 'x' }] }, /`pinnedBy` is required/],
      [{ scan: [], labels: [] }, /`scan` must list at least one/],
    ]
    for (const [manifest, expected] of cases) {
      const result = run(repo({ 'src/a.ts': 'export const a = 1\n' }, manifest))
      assert.equal(result.status, 1, combined(result))
      assert.match(result.stderr ?? '', expected)
    }
  })

  test('parses an empty declaration as empty, not as an error', () => {
    assert.equal(parseManifest('{}').empty, true)
    assert.equal(parseManifest('{}').error, undefined)
  })
})

describe('fail-closed scan surface', () => {
  test('fails when a declared root is missing, and no ledger records that', () => {
    const root = repo({ 'src/a.ts': 'export const a = 1\n' })
    rmSync(join(root, 'src'), { recursive: true })
    const plain = run(root)
    assert.equal(plain.status, 1)
    assert.match(plain.stderr ?? '', /src: scan root does not exist/)
    assert.match(plain.stderr ?? '', /the scan surface is not trustworthy/)

    const recording = run(root, '--write-baseline')
    assert.equal(recording.status, 1, 'a broken scan surface must not become accepted debt')
    assert.match(combined(recording), /scan root does not exist/)
  })

  test('fails when a declared root holds no scannable file', () => {
    const result = run(repo({ 'src/notes.md': '# nothing here\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /src: no scannable file under this root/)
  })

  test('fails when a declared file has no extension the scanner reads', () => {
    const result = run(repo({ 'src/a.txt': 'x\n' }, { scan: ['src/a.txt'], labels: [] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /no extension this scanner reads/)
  })

  test('--list prints the surface without failing', () => {
    const root = repo({ 'src/a.ts': 'export const a = 1\n' })
    rmSync(join(root, 'src'), { recursive: true })
    const result = run(root, '--list')
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stderr ?? '', /src: scan root does not exist/)
  })
})

describe('exceptions and anchors', () => {
  test('an exception suppresses its token, and is reported when it stops being needed', () => {
    const withHit = run(repo(
      { 'src/a.ts': 'export const a = 1 // domain id R40-3 selects the writer\n' },
      { scan: ['src'], labels: [{ name: 'domain id', pattern: 'R\\d{1,3}(?:-[\\w]+)*' }], exceptions: [{ match: 'R40-3', reason: 'catalog entry id' }] },
    ))
    assert.equal(withHit.status, 0, combined(withHit))

    const without = run(repo(
      { 'src/a.ts': 'export const a = 1 // selects the writer\n' },
      { scan: ['src'], labels: [{ name: 'domain id', pattern: 'R\\d{1,3}(?:-[\\w]+)*' }], exceptions: [{ match: 'R40-3', reason: 'catalog entry id' }] },
    ))
    assert.equal(without.status, 0, combined(without))
    assert.match(without.stdout ?? '', /exception "R40-3" was not needed in this scan; remove it/)
  })

  test('an anchor suppresses the comment its test pins, and editing that comment re-exposes it', () => {
    const manifest = (text: string): unknown => ({
      scan: ['src'],
      labels: [{ name: 'date stamp', pattern: '\\d{4}-\\d{2}-\\d{2}' }],
      anchors: [{ path: 'src/a.ts', text, pinnedBy: 'test/surface.test.ts' }],
    })
    const pinned = run(repo(
      { 'src/a.ts': 'export const a = 1 // 2026-10-13 is the fixture stamp\n' },
      manifest('2026-10-13 is the fixture stamp'),
    ))
    assert.equal(pinned.status, 0, combined(pinned))

    // Edited but still a hit: the anchor no longer covers the line, so the hit is live.
    const edited = run(repo(
      { 'src/a.ts': 'export const a = 1 // 2026-10-13: rewritten\n' },
      manifest('2026-10-13 is the fixture stamp'),
    ))
    assert.equal(edited.status, 1)
    assert.match(edited.stderr ?? '', /date stamp matches "2026-10-13"/)
    assert.match(edited.stdout ?? '', /note|matched nothing/)

    // Cleaned: nothing to suppress, so the anchor itself is now dead weight.
    const cleaned = run(repo(
      { 'src/a.ts': 'export const a = 1 // the fixture stamp lives in the test\n' },
      manifest('2026-10-13 is the fixture stamp'),
    ))
    assert.equal(cleaned.status, 0, combined(cleaned))
    assert.match(cleaned.stdout ?? '', /anchor "2026-10-13 is the fixture stamp" in src\/a\.ts matched nothing; remove it/)
  })
})

describe('the debt ledger', () => {
  test('records what history already left behind, then fails only on what is new', () => {
    const root = repo({ 'src/a.ts': 'export const a = 1 // 2026-10-13: switched writer\n' })
    const recorded = run(root, '--write-baseline')
    assert.equal(recorded.status, 0, combined(recorded))

    const after = run(root)
    assert.equal(after.status, 0, combined(after))
    assert.match(after.stdout ?? '', /1 recorded in scripts\/harness\/baseline\.json \(pre-existing debt, not counted\)/)

    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1 // 2026-10-13: switched writer\nexport const b = 2 // 第 2 轮 review\n')
    const regression = run(root)
    assert.equal(regression.status, 1)
    assert.match(regression.stderr ?? '', /review round matches "第 2 轮"/)

    const blind = run(root, '--write-baseline')
    assert.equal(blind.status, 1, 'growing the ledger needs --accept-new, out loud')
    assert.match(blind.stderr ?? '', /pass --accept-new to record them as accepted debt/)
  })
})
