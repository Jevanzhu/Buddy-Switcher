/**
 * Tests for `verify-doc-budgets.ts`. The counting rule is the load-bearing part:
 * a token-only count reads a Chinese paragraph as a single word, so an English-sized
 * ceiling would pass Chinese documents at any length — green while bounding nothing.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-doc-budgets.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'verify-doc-budgets.ts')
const MANIFEST_REL = 'scripts/harness/doc-budgets.manifest.json'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repository root holding one budgeted document and one declared ceiling. */
function fixture(doc: string, ceiling: number): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-budgets-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts/harness'), { recursive: true })
  writeFileSync(join(root, 'docs.md'), doc)
  writeFileSync(join(root, MANIFEST_REL), `${JSON.stringify({ 'docs.md': ceiling })}\n`)
  return root
}

function run(root: string, extra: string[] = []): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [GATE, '--root', root, ...extra], { encoding: 'utf8' })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('word-budget enforcement', () => {
  test('accepts an English document at its exact ceiling', () => {
    const result = run(fixture('# Doc\n\nalpha beta gamma\n', 5))
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /1 budgeted docs within ceiling/)
  })

  test('rejects an English document one word over', () => {
    const result = run(fixture('# Doc\n\nalpha beta gamma\n', 4))
    assert.equal(result.code, 1)
    assert.match(result.output, /5 words exceeds the 4-word ceiling/)
  })

  test('counts each CJK ideograph as a word, so token count alone cannot pass a Chinese document', () => {
    // Three whitespace tokens carrying ten ideographs: under `wc -w` this document is
    // 3 words and fits under almost any ceiling. The shared rule must read it as 13.
    const result = run(fixture('# 示例\n\n这一段有十个汉字。\n', 5))
    assert.equal(result.code, 1)
    assert.match(result.output, /13 words exceeds the 5-word ceiling/)
  })

  test('fails a budgeted document that is missing, naming the manifest to update', () => {
    const root = fixture('# Doc\n', 10)
    rmSync(join(root, 'docs.md'))
    const result = run(root)
    assert.equal(result.code, 1)
    assert.match(result.output, /docs\.md: budgeted file does not exist/)
    assert.match(result.output, /update scripts\/harness\/doc-budgets\.manifest\.json/)
  })

  test('fails a ceiling that is not a positive integer', () => {
    const result = run(fixture('# Doc\n', 0))
    assert.equal(result.code, 1)
    assert.match(result.output, /ceiling must be a positive integer, got 0/)
  })

  test('--list reports usage without failing, so an editor can show it inline', () => {
    const result = run(fixture('# 示例\n\n这一段有十个汉字。\n', 5), ['--list'])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /OVER\s+13 \/ 5\s+docs\.md/)
  })
})

describe('the shared counting rule', () => {
  test('the gate and the bootstrap seed measure in the same unit', () => {
    // Two definitions of "word" would let bootstrap seed a ceiling its own gate
    // cannot satisfy, or one it satisfies trivially. Both import `doc-words.ts`.
    const gate = readFileSync(GATE, 'utf8')
    assert.match(gate, /import \{ countDocWords \} from '\.\/doc-words\.ts'/)
    const bootstrap = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.ts'), 'utf8')
    assert.match(bootstrap, /import \{ countDocWords \} from '\.\/doc-words\.ts'/)
  })
})
