/**
 * Tests for `verify-doc-index.ts`. The gate exists to keep a document chain's index
 * and its tree from drifting apart, so every rule is exercised in both directions:
 * the well-formed chain passes, and each single break turns it red.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-doc-index.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { parseManifest } from './verify-doc-index.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-doc-index.ts')
const INDEX = 'docs/README.md'
const MANIFEST = 'scripts/harness/doc-index.manifest.json'
const WELL_FORMED = JSON.stringify({ index: INDEX, scan: 'docs', entries: [{ dir: '03-设计', count: true }] }, null, 2)

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repository whose index, disk, and manifest agree before a test breaks one. */
function chainRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-doc-index-'))
  roots.push(root)
  const all: Record<string, string> = {
    [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n- 03-设计：1 篇\n',
    'docs/00-总览.md': '# 总览\n',
    'docs/03-设计/流程吸纳-设计方案-2026-10-13.md': '# 设计\n',
    [MANIFEST]: `${WELL_FORMED}\n`,
    ...files,
  }
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

describe('a chain whose index and disk agree', () => {
  test('passes', () => {
    const result = run(chainRepo())
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /1 chain entry matches the index and the disk/)
  })

  test('ignores hidden files: a directory holding only .gitkeep counts as 0', () => {
    const result = run(chainRepo({
      [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n- 03-设计：1 篇\n- 04-调研：0 篇\n',
      'docs/04-调研/.gitkeep': '',
      [MANIFEST]: `${JSON.stringify({
        index: INDEX,
        scan: 'docs',
        entries: [{ dir: '03-设计', count: true }, { dir: '04-调研', count: true }],
      })}\n`,
    }))
    assert.equal(result.status, 0, combined(result))
  })

  test('reads names and references through code formatting, and counts from plain text', () => {
    // Names are often written as `code` in a table; the count sits in its own cell.
    // A count inside a code span is an example, not a declaration, so it does not count.
    const result = run(chainRepo({
      [INDEX]: '# Docs\n\n- `00-总览.md`\n\n| 目录 | 篇数 |\n|---|---|\n| `03-设计` | 1 |\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })
})

describe('the manifest itself', () => {
  test('fails loudly when it is missing, instead of passing an unchecked chain', () => {
    const root = chainRepo()
    rmSync(join(root, MANIFEST))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /no manifest at scripts\/harness\/doc-index\.manifest\.json/)
    assert.match(result.stderr ?? '', /write `\{\}` to declare no chain/)
  })

  test('treats {} as declaring no chain', () => {
    const result = run(chainRepo({ [MANIFEST]: '{}\n' }))
    assert.equal(result.status, 0)
    assert.match(result.stdout ?? '', /declares no chain; nothing to check/)
  })

  test('rejects unknown fields and malformed entries', () => {
    const unknown = run(chainRepo({ [MANIFEST]: `{"index":"${INDEX}","scan":"docs","entries":[],"extra":1}\n` }))
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr ?? '', /unknown field "extra"/)

    assert.match(parseManifest('[]').error ?? '', /must be a JSON object/)
    assert.match(parseManifest('nope').error ?? '', /not valid JSON/)
    assert.match(parseManifest(JSON.stringify({ index: INDEX, scan: 'docs', entries: [{ dir: 'a' }, { dir: 'a' }] })).error ?? '', /duplicate entry "a"/)
    assert.match(parseManifest(JSON.stringify({ index: INDEX, scan: 'docs', entries: [{ dir: '../x' }] })).error ?? '', /without `\.\.`/)
  })
})

describe('index and tree disagreements', () => {
  test('fails when the index document is absent', () => {
    const root = chainRepo()
    rmSync(join(root, INDEX))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /docs\/README\.md: index document does not exist/)
  })

  test('fails when a declared directory is missing on disk', () => {
    const result = run(chainRepo({
      [MANIFEST]: `${JSON.stringify({
        index: INDEX,
        scan: 'docs',
        entries: [{ dir: '03-设计' }, { dir: '04-调研' }],
      })}\n`,
    }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /04-调研: declared in the manifest but missing under docs/)
  })

  test('fails when a directory exists on disk and no entry declares it', () => {
    const result = run(chainRepo({ 'docs/01-评审/review-2026-10-13.md': '# 评审\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /docs\/01-评审: directory exists on disk but no manifest entry declares it/)
  })

  test('fails when a count claim does not match the disk', () => {
    const result = run(chainRepo({
      [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n- 03-设计：3 篇\n',
    }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /"03-设计" claims \[3\] but 1 file\(s\) are on disk/)
  })

  test('fails when the line naming a count-checked directory carries no number', () => {
    const result = run(chainRepo({ [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n- 03-设计\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /"03-设计" claims no count but 1 file\(s\) are on disk/)
  })

  test('fails when the index never names a declared directory', () => {
    const result = run(chainRepo({ [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /docs\/README\.md: no line names "03-设计"/)
  })

  test('fails when a top-level document is not referenced from the index', () => {
    const result = run(chainRepo({ 'docs/09-附.md': '# 附\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /docs\/09-附\.md: document is not referenced from docs\/README\.md/)
  })
})

describe('--list', () => {
  test('reports measured counts without failing, even mid-drift', () => {
    const root = chainRepo({ [INDEX]: '# Docs\n\n- [总览](00-总览.md)\n- 03-设计：3 篇\n' })
    const result = run(root, '--list')
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /\s+1 {2}03-设计/)
  })
})
