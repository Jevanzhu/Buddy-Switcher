/**
 * Tests for `verify-doc-claims.ts`. The gate exists because a stated number is a copy:
 * it is right on the day it is written and stale after the next change, and no reviewer
 * re-checks arithmetic. Each rule is shown red once and its boundary green once, and the
 * commands used as sources are real commands run against the fixture repository.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-doc-claims.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { measuredFrom, parseManifest } from './verify-doc-claims.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-doc-claims.ts')
const MANIFEST = 'scripts/harness/doc-claims.manifest.json'

/** A source command that prints a fixed integer, as an argv array. */
function prints(value: string): string[] {
  return ['node', '-e', `process.stdout.write(${JSON.stringify(value)})`]
}

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repository with a document and a manifest of claims, ready for a run. */
function repo(files: Record<string, string>, manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-doc-claims-'))
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

const countClaim = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '技能数',
  kind: 'count',
  doc: 'README.md',
  command: prints('2'),
  pattern: '共 (\\d+) 个技能',
  ...overrides,
})

describe('count claims', () => {
  test('passes when the document states what the source measures', () => {
    const result = run(repo({ 'README.md': '# 仓库\n\n本仓共 2 个技能。\n' }, { claims: [countClaim()] }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /1 claim\(s\) checked against their sources/)
  })

  test('fails when the document is stale, naming both numbers', () => {
    const result = run(repo({ 'README.md': '# 仓库\n\n本仓共 3 个技能。\n' }, { claims: [countClaim()] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /README\.md: the document says 3 but the source measures 2/)
    assert.match(result.stderr ?? '', /A stated number is a copy/)
  })

  test('fails when the claim is no longer written in the document', () => {
    const result = run(repo({ 'README.md': '# 仓库\n\n技能若干。\n' }, { claims: [countClaim()] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /the claim is no longer written there/)
  })

  test('holds a floor with atLeast: rising is fine, falling is not', () => {
    const doc = '门禁共 10 道。'
    const rising = run(repo({ 'README.md': doc }, { claims: [countClaim({ command: prints('12'), pattern: '门禁共 (\\d+) 道', expect: 'atLeast' })] }))
    assert.equal(rising.status, 0, combined(rising))

    const falling = run(repo({ 'README.md': doc }, { claims: [countClaim({ command: prints('9'), pattern: '门禁共 (\\d+) 道', expect: 'atLeast' })] }))
    assert.equal(falling.status, 1)
    assert.match(falling.stderr ?? '', /the document says 10 but the source measures 9 \(expect atLeast\)/)
  })

  test('holds a ceiling with atMost', () => {
    const doc = '字数上限 1960。'
    const under = run(repo({ 'README.md': doc }, { claims: [countClaim({ command: prints('1800'), pattern: '字数上限 (\\d+)', expect: 'atMost' })] }))
    assert.equal(under.status, 0, combined(under))

    const over = run(repo({ 'README.md': doc }, { claims: [countClaim({ command: prints('2100'), pattern: '字数上限 (\\d+)', expect: 'atMost' })] }))
    assert.equal(over.status, 1)
    assert.match(over.stderr ?? '', /the source measures 2100 \(expect atMost\)/)
  })

  test('counts output lines when byLines says the command prints a list', () => {
    const command = ['node', '-e', "console.log('a\\nb\\nc')"]
    const result = run(repo({ 'README.md': '槽位 3 个。' }, { claims: [countClaim({ command, byLines: true, pattern: '槽位 (\\d+) 个' })] }))
    assert.equal(result.status, 0, combined(result))

    const stale = run(repo({ 'README.md': '槽位 4 个。' }, { claims: [countClaim({ command, byLines: true, pattern: '槽位 (\\d+) 个' })] }))
    assert.equal(stale.status, 1)
    assert.match(stale.stderr ?? '', /the document says 4 but the source measures 3/)
  })

  test('runs the source command with the repository root as cwd', () => {
    const command = ['node', '-e', "console.log(require('fs').readFileSync('count.txt','utf8').trim())"]
    const result = run(repo({ 'README.md': '条目 7 个。', 'count.txt': '7\n' }, { claims: [countClaim({ command, pattern: '条目 (\\d+) 个' })] }))
    assert.equal(result.status, 0, combined(result))
  })
})

describe('list claims', () => {
  test('passes when the document mentions every item the source lists', () => {
    const command = ['node', '-e', "console.log('skills/agent-notes\\nskills/project-harness')"]
    const result = run(repo({ 'README.md': '- skills/agent-notes\n- skills/project-harness\n' }, { claims: [{ name: '技能目录', kind: 'list', doc: 'README.md', command }] }))
    assert.equal(result.status, 0, combined(result))
  })

  test('fails when the source lists an item the document never mentions', () => {
    const command = ['node', '-e', "console.log('skills/agent-notes\\nskills/project-harness')"]
    const result = run(repo({ 'README.md': '- skills/agent-notes\n' }, { claims: [{ name: '技能目录', kind: 'list', doc: 'README.md', command }] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /the source lists "skills\/project-harness", which the document does not mention/)
  })
})

describe('the sources', () => {
  test('fails when a source command fails, naming its exit code', () => {
    const result = run(repo({ 'README.md': '共 2 个技能。' }, { claims: [countClaim({ command: ['node', '-e', "process.stderr.write('boom'); process.exit(3)"] })] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /the source command failed \(exit 3: boom\)/)
  })

  test('fails when a source command does not print a single integer', () => {
    const result = run(repo({ 'README.md': '共 2 个技能。' }, { claims: [countClaim({ command: prints('about 2 skills') })] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /not a single integer/)
  })

  test('treats empty and blank output as a failure, not as zero', () => {
    assert.match(measuredFrom('', false).error ?? '', /printed nothing/)
    assert.match(measuredFrom('  \n \n', true).error ?? '', /no line to count/)
    assert.equal(measuredFrom(' 42 \n', false).measured, 42)
  })
})

describe('the manifest itself', () => {
  test('fails loudly when it is missing, and {} declares no claims', () => {
    const root = repo({ 'README.md': '共 2 个技能。' }, { claims: [countClaim()] })
    rmSync(join(root, MANIFEST))
    const missing = run(root)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr ?? '', /no manifest at scripts\/harness\/doc-claims\.manifest\.json/)

    const disabled = run(repo({ 'README.md': '共 9 个技能。' }, {}))
    assert.equal(disabled.status, 0)
    assert.match(disabled.stdout ?? '', /declares no claims; nothing to check/)
  })

  test('fails when the document a claim names does not exist', () => {
    const result = run(repo({ 'README.md': '共 2 个技能。' }, { claims: [countClaim({ doc: 'docs/GONE.md' })] }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /docs\/GONE\.md: the document does not exist/)
  })

  test('rejects unknown fields and ill-formed claims', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ claims: [countClaim()], extra: 1 }, /unknown field "extra"/],
      [{ claims: [countClaim({ pattern: undefined })] }, /a count claim needs `pattern`/],
      [{ claims: [countClaim({ pattern: '共 \\d+ 个技能' })] }, /exactly one capture group/],
      [{ claims: [countClaim({ pattern: '(' })] }, /not a valid regular expression/],
      [{ claims: [countClaim({ expect: 'roughly' })] }, /`expect` must be one of equal, atLeast, atMost/],
      [{ claims: [{ name: 'x', kind: 'list', doc: 'README.md', command: prints('a'), expect: 'equal' }] }, /a list claim has no `expect`/],
      [{ claims: [{ name: 'x', kind: 'count', doc: 'README.md', command: [] }] }, /non-empty argv array/],
      [{ claims: [{ name: 'x', kind: 'guess', doc: 'README.md', command: prints('1') }] }, /`kind` must be "count" or "list"/],
    ]
    for (const [manifest, expected] of cases) {
      const result = run(repo({ 'README.md': '共 2 个技能。' }, manifest))
      assert.equal(result.status, 1, combined(result))
      assert.match(result.stderr ?? '', expected)
    }
  })

  test('parses an empty declaration as empty, not as an error', () => {
    assert.equal(parseManifest('{}').empty, true)
    assert.match(parseManifest('[]').error ?? '', /must be a JSON object/)
  })
})

describe('--list', () => {
  test('reports each claim with its measured and stated values, without failing', () => {
    const root = repo({ 'README.md': '共 3 个技能。' }, { claims: [countClaim()] })
    const result = run(root, '--list')
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /技能数\s+README\.md\s+measured 2\s+stated 3/)
  })
})
