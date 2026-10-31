/**
 * Tests for `verify-test-hygiene.ts`. The gate exists because both failures it looks for
 * are silent: a focused run and a titled skip each keep the run green while the suite
 * shrinks. So every rule is shown red once, every boundary that must stay legal — an
 * environment gate, a `.only` quoted in a string, a non-test file — is shown green once.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-test-hygiene.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { findHits, parseManifest } from './verify-test-hygiene.ts'
import { codeSurface } from './surface.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-test-hygiene.ts')
const MANIFEST = 'scripts/harness/test-hygiene.manifest.json'
const STARTER = { scan: ['test'] }

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repository with a `test/` tree and the given manifest, ready for a run. */
function repo(files: Record<string, string>, manifest: unknown = STARTER): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-test-hygiene-'))
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

describe('the code surface', () => {
  test('blanks comment and literal contents, keeping delimiters and line structure', () => {
    const source = ['const a = "test.only(\'x\')"', 'const b = \'test.only("y")\' // test.skip("t")', 'test.only(\'real\')'].join('\n')
    const surface = codeSurface(source)
    const lines = surface.split('\n')
    assert.equal(lines[0], `const a = "${' '.repeat("test.only('x')".length)}"`)
    assert.equal(lines[1], `const b = '${' '.repeat('test.only("y")'.length)}' // ${' '.repeat('test.skip("t")'.length)}`)
    assert.equal(lines[2], `test.only('${' '.repeat('real'.length)}')`)
  })

  test('finds only real calls, at their line', () => {
    const source = ['// test.only(ghost)', 'const note = "test.skip(\'ghost\')"', "test.skip('title', () => {})"].join('\n')
    const hits = findHits('test/a.test.ts', source, ['test', 'it', 'describe'])
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.line, 3)
    assert.equal(hits[0]?.rule, 'unconditional skip')
  })
})

describe('focused runs', () => {
  test('fails on test.only, describe.only, and .only.each', () => {
    for (const call of ["test.only('a', () => {})", "describe.only('a', () => {})", "it.only.each([[1]])('a', () => {})"]) {
      const result = run(repo({ 'test/a.test.ts': `${call}\n` }))
      assert.equal(result.status, 1, combined(result))
      assert.match(result.stderr ?? '', /focused run "test\.only"|focused run "describe\.only"|focused run "it\.only"/)
    }
  })

  test('passes on a clean suite, and on a .only that is only quoted', () => {
    const result = run(repo({
      'test/a.test.ts': "const doc = 'test.only selects one case'\n// test.only('a') was removed\ntest('keeps running', () => {})\n",
    }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /1 test file\(s\) scanned, no focused run and no unconditional skip/)
  })

  test('ignores .only on a receiver the manifest does not declare', () => {
    const result = run(repo({ 'test/a.test.ts': 'logger.only(1)\ntest(\'a\', () => {})\n' }))
    assert.equal(result.status, 0, combined(result))
  })

  test('honours a receiver the manifest adds', () => {
    const result = run(repo(
      { 'test/a.test.ts': "bench.only('a', () => {})\n" },
      { scan: ['test'], receivers: ['bench'] },
    ))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /focused run "bench\.only"/)
  })
})

describe('skips', () => {
  test('fails on a titled skip, a skipped suite, and .skip.each', () => {
    for (const call of [
      "test.skip('a', () => {})",
      "describe.skip('a', () => {})",
      "test.skip.each([[1]])('a', () => {})",
      'test.skip(true)',
    ]) {
      const result = run(repo({ 'test/a.test.ts': `${call}\n` }))
      assert.equal(result.status, 1, combined(result))
      assert.match(result.stderr ?? '', /unconditional skip/)
    }
  })

  test('leaves an environment gate alone', () => {
    const result = run(repo({
      'test/a.test.ts': [
        "test.skip(!env.RUN_SLOW)",
        "test.skip(process.platform === 'win32', () => {})",
        "test.skip(trueOrFalse(), () => {})",
      ].join('\n') + '\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })

  test('leaves a todo alone: it is visible in the report, not a silent hole', () => {
    const result = run(repo({ 'test/a.test.ts': "test.todo('later')\n" }))
    assert.equal(result.status, 0, combined(result))
  })
})

describe('the test surface', () => {
  test('scans only test files, so a helper may talk about .only', () => {
    const result = run(repo({
      'src/helper.ts': "export const note = 'test.only'\nexport const pick = (list: unknown[]) => list.only\n",
      'test/a.test.ts': "test('a', () => {})\n",
    }, { scan: ['src', 'test'] }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /1 test file\(s\) scanned/)
  })

  test('fails when no file under the roots matches the test suffixes', () => {
    const result = run(repo({ 'test/helpers.ts': 'export const helper = 1\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /no file under test matches the test suffixes/)
  })

  test('fails on a missing manifest, and {} declares no test surface', () => {
    const root = repo({ 'test/a.test.ts': "test('a', () => {})\n" })
    rmSync(join(root, MANIFEST))
    const missing = run(root)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr ?? '', /no manifest at scripts\/harness\/test-hygiene\.manifest\.json/)

    const disabled = run(repo({ 'test/a.test.ts': "test.only('a', () => {})\n" }, {}))
    assert.equal(disabled.status, 0)
    assert.match(disabled.stdout ?? '', /declares no test surface; nothing to check/)
  })

  test('rejects unknown fields and malformed lists', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...STARTER, extra: 1 }, /unknown field "extra"/],
      [{ scan: [] }, /`scan` must list at least one/],
      [{ scan: ['test'], receivers: ['2bad'] }, /must be an identifier/],
      [{ scan: ['test'], suffixes: ['test'] }, /must start with a dot/],
    ]
    for (const [manifest, expected] of cases) {
      const result = run(repo({ 'test/a.test.ts': "test('a', () => {})\n" }, manifest))
      assert.equal(result.status, 1, combined(result))
      assert.match(result.stderr ?? '', expected)
    }
  })

  test('--list prints the test files it would scan', () => {
    const result = run(repo({ 'test/a.test.ts': "test('a', () => {})\n", 'src/b.ts': 'export const b = 1\n' }, { scan: ['src', 'test'] }), '--list')
    assert.equal(result.status, 0, combined(result))
    assert.equal(result.stdout, 'test/a.test.ts\n')
  })

  test('parses an empty declaration as empty, not as an error', () => {
    assert.equal(parseManifest('{}').empty, true)
    assert.match(parseManifest('[]').error ?? '', /must be a JSON object/)
  })
})

describe('the debt ledger', () => {
  test('records what a legacy suite already carries, then fails only on what is new', () => {
    const root = repo({ 'test/a.test.ts': "test.skip('legacy', () => {})\n" })
    const recorded = run(root, '--write-baseline')
    assert.equal(recorded.status, 0, combined(recorded))

    const after = run(root)
    assert.equal(after.status, 0, combined(after))
    assert.match(after.stdout ?? '', /1 recorded in scripts\/harness\/baseline\.json \(pre-existing debt, not counted\)/)

    writeFileSync(join(root, 'test/a.test.ts'), "test.skip('legacy', () => {})\ntest.only('mine', () => {})\n")
    const regression = run(root)
    assert.equal(regression.status, 1)
    assert.match(regression.stderr ?? '', /focused run "test\.only"/)
  })
})
