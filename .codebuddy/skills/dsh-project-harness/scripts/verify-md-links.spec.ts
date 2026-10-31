/**
 * Tests for `verify-md-links.ts`. The gate decides two things a repository can get
 * wrong in opposite directions: which files are scanned — a surface that quietly
 * shrinks passes forever — and whether each link on that surface resolves. Every
 * exclusion rule is exercised as a pair: the excluded path must not be reported, and
 * its visible sibling must be.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-md-links.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { findLinkViolations, markdownFiles } from './verify-md-links.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-md-links.ts')

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-md-links-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** Violations as `path -> target`, so a failure reads as the link that went wrong. */
function report(root: string): string[] {
  return findLinkViolations(root, markdownFiles(root)).map(violation => `${violation.path} -> ${violation.target}`)
}

describe('link resolution', () => {
  test('a relative link to a file that exists passes', () => {
    const root = fixture({ 'docs/a.md': '[b](./b.md)\n', 'docs/b.md': '# B\n' })
    assert.deepEqual(report(root), [])
  })

  test('a missing target is reported', () => {
    const root = fixture({ 'docs/a.md': '[gone](./missing.md)\n' })
    assert.deepEqual(report(root), ['docs/a.md -> ./missing.md'])
    const [violation] = findLinkViolations(root, markdownFiles(root))
    assert.equal(violation?.line, 1)
    assert.match(violation?.reason ?? '', /target does not exist/)
  })

  test('an anchor that exists passes and one that does not is reported', () => {
    const present = fixture({ 'docs/a.md': '[x](./b.md#section-one)\n', 'docs/b.md': '# Section one\n' })
    assert.deepEqual(report(present), [])

    const absent = fixture({ 'docs/a.md': '[x](./b.md#absent)\n', 'docs/b.md': '# Other\n' })
    assert.deepEqual(report(absent), ['docs/a.md -> ./b.md#absent'])
  })

  test('external URLs and bare anchors are not followed', () => {
    const root = fixture({ 'docs/a.md': '[web](https://example.com/missing.md) [here](#elsewhere)\n' })
    assert.deepEqual(report(root), [])
  })
})

describe('scan surface', () => {
  test('a nested gitignore entry excludes that path and leaves its parent scanned', () => {
    // Reading only the entry's first segment would drop `local` entirely, and with it
    // every authored document beside the vendored clone — a surface that shrinks in
    // silence while the gate stays green.
    const root = fixture({
      '.gitignore': 'local/reference-clone\n',
      'local/reference-clone/clone.md': '[gone](./missing.md)\n',
      'local/authored.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['local/authored.md -> ./missing.md'])
  })

  test('a trailing slash names the same path', () => {
    const root = fixture({
      '.gitignore': 'local/reference-clone/\n',
      'local/reference-clone/clone.md': '[gone](./missing.md)\n',
      'local/authored.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['local/authored.md -> ./missing.md'])
  })

  test('a glob entry excludes the tree it names', () => {
    const root = fixture({
      '.gitignore': 'archive/**\n',
      'archive/a.md': '[gone](./missing.md)\n',
      'docs/a.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['docs/a.md -> ./missing.md'])
  })

  test('a bare top-level entry excludes that directory only', () => {
    const root = fixture({
      '.gitignore': 'generated\n',
      'generated/a.md': '[gone](./missing.md)\n',
      'generated-two/a.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['generated-two/a.md -> ./missing.md'])
  })

  test('a pattern file replaces the default walk', () => {
    const root = fixture({
      'scripts/harness/markdown-patterns.json': '[\n  "docs/**/*.md"\n]\n',
      'docs/a.md': '[gone](./missing.md)\n',
      'notes/a.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['docs/a.md -> ./missing.md'])
  })

  test('a pattern may name a dot directory the default walk skips', () => {
    const root = fixture({
      'scripts/harness/markdown-patterns.json': '[\n  ".agents/notes/implemented/**/*.md"\n]\n',
      '.agents/notes/implemented/a.md': '[gone](./missing.md)\n',
      '.agents/notes/archived/b.md': '[gone](./missing.md)\n',
      'docs/a.md': '[gone](./missing.md)\n',
    })
    // Pair: the declared dot subtree is scanned, its undeclared sibling under the same
    // dot tree is not, and a non-dot tree stays out of an explicit list.
    assert.deepEqual(report(root), ['.agents/notes/implemented/a.md -> ./missing.md'])
  })

  test('the default walk still skips dot directories', () => {
    const root = fixture({
      '.agents/notes/implemented/a.md': '[gone](./missing.md)\n',
      'docs/a.md': '[gone](./missing.md)\n',
    })
    assert.deepEqual(report(root), ['docs/a.md -> ./missing.md'])
  })

  test('a pattern file that is not an array of strings is an error, not a full scan', () => {
    const root = fixture({
      'scripts/harness/markdown-patterns.json': '{ "scan": ["docs/**"] }\n',
      'docs/a.md': '# A\n',
    })
    assert.throws(() => markdownFiles(root), /must be an array of glob strings/)
  })

  test('an empty surface fails the gate instead of passing it', () => {
    const root = fixture({ 'scripts/harness/markdown-patterns.json': '[\n  "docs/**/*.md"\n]\n' })
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(`${run.stdout}${run.stderr}`, /scanned nothing must not pass/)
  })
})
