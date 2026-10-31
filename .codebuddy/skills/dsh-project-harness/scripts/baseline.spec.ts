/**
 * Tests for the debt ledger: what it suppresses, how it shrinks, and the one thing it
 * must never do — quietly absorb a regression.
 *
 * The refusal path calls `process.exit`, so it is exercised against a real fixture
 * repository through a child process rather than in-process.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/baseline.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import {
  applyBaseline,
  BASELINE_REL,
  baselineGrowth,
  readBaseline,
  writeBaseline,
  type Baseline,
} from './baseline.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** A scratch repository for the tests that need real files. */
function scratchRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-baseline-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  return root
}

describe('the ledger file', () => {
  const roots: string[] = []
  const temp = (): string => {
    const root = scratchRepository()
    roots.push(root)
    return root
  }
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  test('a missing ledger is empty, not an error', () => {
    assert.deepEqual(readBaseline(temp()), { version: 1, entries: {} })
  })

  test('round-trips entries with sorted gates and keys', () => {
    const root = temp()
    writeBaseline(root, {
      version: 1,
      entries: { zeta: ['b', 'a'], alpha: ['d', 'c'] },
    })
    assert.deepEqual(readBaseline(root), {
      version: 1,
      entries: { alpha: ['c', 'd'], zeta: ['a', 'b'] },
    })
    // Stable ordering keeps the file's diffs about debt, not about key order.
    assert.equal(
      readFileSync(join(root, BASELINE_REL), 'utf8'),
      '{\n  "version": 1,\n  "entries": {\n    "alpha": [\n      "c",\n      "d"\n    ],\n    "zeta": [\n      "a",\n      "b"\n    ]\n  }\n}\n',
    )
  })

  test('drops a gate whose entries are all fixed', () => {
    const root = temp()
    writeBaseline(root, { version: 1, entries: { alpha: ['a'], zeta: ['z'] } })
    writeBaseline(root, { version: 1, entries: { alpha: [], zeta: ['z'] } })
    assert.deepEqual(readBaseline(root).entries, { zeta: ['z'] })
  })

  test('rejects an unknown version', () => {
    const root = temp()
    mkdirSync(join(root, 'scripts/harness'), { recursive: true })
    writeFileSync(join(root, BASELINE_REL), '{"version":2,"entries":{}}')
    assert.throws(() => readBaseline(root), /unsupported version/)
  })

  test('rejects entries that are not string arrays', () => {
    const root = temp()
    mkdirSync(join(root, 'scripts/harness'), { recursive: true })
    writeFileSync(join(root, BASELINE_REL), '{"version":1,"entries":{"markdown-links":[42]}}')
    assert.throws(() => readBaseline(root), /must be an array of strings/)
  })
})

describe('applying a ledger', () => {
  const ledger: Baseline = { version: 1, entries: { gate: ['a', 'b'] } }
  const keyOf = (value: string): string => value

  test('splits recorded debt from new violations', () => {
    const outcome = applyBaseline(ledger, 'gate', ['a', 'c'], keyOf)
    assert.deepEqual(outcome.suppressed, ['a'])
    assert.deepEqual(outcome.remaining, ['c'])
  })

  test('reports entries that matched nothing so the file can shrink', () => {
    assert.deepEqual(applyBaseline(ledger, 'gate', ['a'], keyOf).stale, ['b'])
  })

  test('an unknown gate has no recorded debt', () => {
    const outcome = applyBaseline(ledger, 'other', ['a'], keyOf)
    assert.deepEqual(outcome.suppressed, [])
    assert.deepEqual(outcome.remaining, ['a'])
    assert.deepEqual(outcome.stale, [])
  })

  test('growth lists only keys the ledger does not already hold', () => {
    assert.deepEqual(baselineGrowth(ledger, 'gate', ['a', 'c']), ['c'])
    assert.deepEqual(baselineGrowth(ledger, 'other', ['x']), ['x'])
  })
})

describe('adopting an existing repository', () => {
  let root: string
  const gate = join(SCRIPT_DIR, 'verify-md-links.ts')

  /** Run the real link gate in a child process, as CI and a pre-push hook would. */
  function runGate(...args: string[]): { status: number | null; out: string } {
    const result = spawnSync(process.execPath, [gate, '--root', root, ...args], { encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  const brokenLink = (name: string, target: string): void => {
    writeFileSync(join(root, 'docs', name), `# Page\n\nSee [there](${target}) for details.\n`)
  }

  before(() => {
    root = scratchRepository()
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('an unadopted repository fails on history it did not introduce', () => {
    brokenLink('a.md', './missing-a.md')
    const run = runGate()
    assert.equal(run.status, 1)
    assert.match(run.out, /broken links found/)
  })

  test('recording the ledger accepts that history', () => {
    const run = runGate('--write-baseline')
    assert.equal(run.status, 0)
    assert.match(run.out, /recorded 1 existing violation/)
    assert.deepEqual(readBaseline(root).entries['markdown-links'], ['docs/a.md|./missing-a.md'])
  })

  test('the gate then passes while reporting the debt it carries', () => {
    const run = runGate()
    assert.equal(run.status, 0)
    assert.match(run.out, /1 recorded in scripts\/harness\/baseline\.json/)
  })

  test('a newly introduced violation still fails', () => {
    brokenLink('b.md', './missing-b.md')
    const run = runGate()
    assert.equal(run.status, 1)
    assert.match(run.out, /docs\/b\.md:3/)
    assert.doesNotMatch(run.out, /docs\/a\.md:3/)
  })

  test('re-recording refuses to absorb that violation without an explicit flag', () => {
    const run = runGate('--write-baseline')
    assert.equal(run.status, 1)
    assert.match(run.out, /--accept-new/)
    assert.deepEqual(readBaseline(root).entries['markdown-links'], ['docs/a.md|./missing-a.md'])
  })

  test('--accept-new records it as debt on purpose', () => {
    const run = runGate('--write-baseline', '--accept-new')
    assert.equal(run.status, 0)
    assert.match(run.out, /1 newly accepted/)
    assert.deepEqual(readBaseline(root).entries['markdown-links'], [
      'docs/a.md|./missing-a.md',
      'docs/b.md|./missing-b.md',
    ])
  })

  test('fixing debt shrinks the ledger and reports the stale entries first', () => {
    writeFileSync(join(root, 'docs', 'a.md'), '# Page\n\nSee [there](./b.md) for details.\n')
    // Before re-recording, the gate names what no longer matches so the fix is visible.
    const checked = runGate()
    assert.equal(checked.status, 0)
    assert.match(checked.out, /1 ledger entry is no longer matching anything/)

    const recorded = runGate('--write-baseline')
    assert.equal(recorded.status, 0)
    assert.match(recorded.out, /1 fixed since the last recording/)
    assert.deepEqual(readBaseline(root).entries['markdown-links'], ['docs/b.md|./missing-b.md'])
  })

  test('a clean repository gets no ledger file at all', () => {
    const clean = scratchRepository()
    writeFileSync(join(clean, 'docs', 'a.md'), '# Page\n')
    const run = spawnSync(process.execPath, [gate, '--root', clean, '--write-baseline'], { encoding: 'utf8' })
    assert.equal(run.status, 0)
    assert.match(run.stdout ?? '', /no violations to record/)
    assert.equal(readBaseline(clean).entries['markdown-links'], undefined)
    rmSync(clean, { recursive: true, force: true })
  })
})

describe('the wrap gate keys on text, not position', () => {
  let root: string
  const wrap = join(SCRIPT_DIR, 'verify-md-wrap.ts')

  function runWrap(): { status: number | null; out: string } {
    const result = spawnSync(process.execPath, [wrap, '--root', root], { encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  const wrapped = (name: string, text: string): void => {
    writeFileSync(join(root, 'docs', name), text)
  }

  before(() => {
    root = scratchRepository()
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('records a wrapped paragraph, then tolerates it', () => {
    wrapped('a.md', '# Page\n\nThis paragraph is broken\nacross two lines.\n')
    const record = spawnSync(process.execPath, [wrap, '--root', root, '--write-baseline'], { encoding: 'utf8' })
    assert.equal(record.status, 0)
    assert.match(record.stdout ?? '', /recorded 1 existing violation/)
    assert.equal(runWrap().status, 0)
  })

  test('a paragraph inserted above the recorded one does not resurface it', () => {
    wrapped('a.md', '# Page\n\nA new first paragraph.\n\nThis paragraph is broken\nacross two lines.\n')
    const run = runWrap()
    assert.equal(run.status, 0, run.out)
  })

  test('editing the wrapped paragraph does resurface it', () => {
    wrapped('a.md', '# Page\n\nThis paragraph is broken differently\nacross two lines.\n')
    const run = runWrap()
    assert.equal(run.status, 1)
    assert.match(run.out, /docs\/a\.md:3/)
  })

  test('a newly wrapped paragraph fails even while the recorded one is tolerated', () => {
    wrapped('a.md', '# Page\n\nThis paragraph is broken\nacross two lines.\n')
    wrapped('b.md', '# Other\n\nAnother paragraph split\nover two lines.\n')
    const run = runWrap()
    assert.equal(run.status, 1)
    assert.match(run.out, /docs\/b\.md:3/)
    assert.doesNotMatch(run.out, /docs\/a\.md:3/)
    assert.match(run.out, /1 recorded in scripts\/harness\/baseline\.json/)
  })
})
