/**
 * Tests for `verify-skill-catalog.ts`. The gate exists because a broken skill catalog
 * fails silently: the file is installed, a directory lists it, and no client ever
 * selects it. Every rule is therefore exercised in both directions — a loadable catalog
 * passes, and each single break turns it red.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/verify-skill-catalog.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { parseManifest } from './verify-skill-catalog.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-skill-catalog.ts')
const MANIFEST = 'scripts/harness/skill-catalog.manifest.json'

/** A frontmatter block for a skill whose catalog entry would load. */
function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

/** The manifest a healthy repository declares, formatted like the shipped one. */
function manifestText(roots: readonly string[] = ['skills'], maxDescriptionLength?: number): string {
  const body: Record<string, unknown> = { roots }
  if (maxDescriptionLength !== undefined) body.maxDescriptionLength = maxDescriptionLength
  return `${JSON.stringify(body, null, 2)}\n`
}

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** A repository whose skill catalog is loadable before a test breaks one entry. */
function catalogRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-skill-catalog-'))
  roots.push(root)
  const all: Record<string, string> = {
    [MANIFEST]: manifestText(),
    'skills/alpha/SKILL.md': skill('alpha', 'The first skill.'),
    'skills/beta/SKILL.md': skill('beta', 'The second skill.'),
    ...files,
  }
  for (const [rel, content] of Object.entries(all)) write(root, rel, content)
  return root
}

function run(root: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
}

function combined(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

describe('a loadable catalog', () => {
  test('passes, and its report line names the count and the budget', () => {
    const result = run(catalogRepo())
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /verify-skill-catalog: 2 skills across 1 root, every frontmatter name is loadable and every description fits 500/)
  })

  test('accepts a folded block scalar description', () => {
    const result = run(catalogRepo({
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: >-\n  Routes the first kind of task.\n  Carries the trigger words.\n---\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })

  test('accepts a literal block scalar description', () => {
    const result = run(catalogRepo({
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: |\n  Routes the first kind of task.\n  Carries the trigger words.\n---\n',
    }))
    assert.equal(result.status, 0, combined(result))
  })

  test('accepts a flat document and ignores files that are not skill documents', () => {
    // A root conventionally carries a version file and directories that are not skills;
    // neither is a document this gate decides, and neither may be mistaken for one.
    const result = run(catalogRepo({
      'skills/flat-one.md': skill('flat-one', 'A flat document.'),
      'skills/VERSION': '0.0.0\n',
      'skills/not-a-skill/README.md': '# Not a skill\n',
      'skills/.hidden.md': skill('hidden', 'Ignored.'),
    }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /3 skills across 1 root/)
  })
})

describe('the manifest itself', () => {
  test('fails loudly when it is missing, instead of passing an unchecked catalog', () => {
    const root = catalogRepo()
    rmSync(join(root, MANIFEST))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /no manifest at scripts\/harness\/skill-catalog\.manifest\.json/)
    assert.match(result.stderr ?? '', /write `\{\}` to declare no skill roots/)
  })

  test('treats {} as declaring no skill roots', () => {
    const result = run(catalogRepo({ [MANIFEST]: '{}\n' }))
    assert.equal(result.status, 0, combined(result))
    assert.match(result.stdout ?? '', /declares no skill roots; nothing to check/)
  })

  test('rejects an unknown field instead of reading a manifest it does not understand', () => {
    const result = run(catalogRepo({ [MANIFEST]: '{"roots":["skills"],"everySkill":true}\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /unknown field "everySkill"/)
  })

  test('rejects malformed shapes', () => {
    assert.match(parseManifest('nope').error ?? '', /not valid JSON/)
    assert.match(parseManifest('[]').error ?? '', /must be a JSON object/)
    assert.match(parseManifest('{"roots":"skills"}').error ?? '', /`roots` must be an array/)
    assert.match(parseManifest('{"roots":["../outside"]}').error ?? '', /without `\.\.`/)
    assert.match(parseManifest('{"roots":["skills","skills"]}').error ?? '', /duplicate root "skills"/)
    assert.match(parseManifest('{"roots":["skills"],"maxDescriptionLength":0}').error ?? '', /must be a positive integer/)
    assert.match(parseManifest('{"roots":["skills"],"maxDescriptionLength":"500"}').error ?? '', /must be a positive integer/)
    assert.deepEqual(parseManifest('{}'), { empty: true })
  })
})

describe('the description budget', () => {
  test('fails when a plain description is over the budget, and reports the measured length', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': skill('alpha', 'x'.repeat(520)) }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /skills\/alpha\/SKILL\.md: description is 520 characters after whitespace normalization, over the 500-character budget/)
  })

  test('folds a block scalar before measuring, because the client sees one line', () => {
    // Six short lines: a parser that read only the header line would measure 90 and pass.
    const body = Array.from({ length: 6 }, () => 'a'.repeat(90)).join('\n  ')
    const root = catalogRepo()
    write(root, 'skills/alpha/SKILL.md', `---\nname: alpha\ndescription: >-\n  ${body}\n---\n`)
    const result = run(root)
    assert.equal(result.status, 1)
    // 6 x 90 characters joined by five spaces.
    assert.match(result.stderr ?? '', /description is 545 characters after whitespace normalization/)
    assert.match(result.stderr ?? '', /over the 500-character budget/)
  })

  test('measures whitespace-collapsed characters, not raw bytes', () => {
    // 602 raw bytes of which 600 are a run of spaces the client collapses to one.
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': skill('alpha', `a${' '.repeat(600)}b`) }))
    assert.equal(result.status, 0, combined(result))
  })

  test('applies the budget the manifest declares', () => {
    const result = run(catalogRepo({
      [MANIFEST]: manifestText(['skills'], 20),
      'skills/alpha/SKILL.md': skill('alpha', 'Routes the first kind of task.'),
    }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /over the 20-character budget/)
  })
})

describe('name and directory agreement', () => {
  test('fails when a directory package declares another name', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': skill('beta', 'The first skill.') }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /skills\/alpha\/SKILL\.md: name "beta" does not match its directory "alpha"/)
  })

  test('fails when a name is not kebab-case', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': skill('Agent_Notes', 'The first skill.') }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /name "Agent_Notes" is not kebab-case/)
  })

  test('fails when the frontmatter has no name', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': '---\ndescription: The first skill.\n---\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /has no `name` in its frontmatter/)
  })

  test('fails when the frontmatter has no description', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': '---\nname: alpha\n---\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /has no `description` in its frontmatter/)
  })

  test('fails when a description is present but empty', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription:\n---\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /has no `description` in its frontmatter/)
  })
})

describe('the frontmatter block', () => {
  test('fails when a document has no frontmatter', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': '# Alpha\n\nNo frontmatter here.\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /has no frontmatter: the file does not start with a `---` line/)
  })

  test('fails when the frontmatter never closes', () => {
    const result = run(catalogRepo({ 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: The first skill.\n' }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /opens its frontmatter with `---` but never closes it/)
  })
})

describe('the scan surface', () => {
  test('fails when a declared root does not exist', () => {
    const result = run(catalogRepo({ [MANIFEST]: manifestText(['skills', 'nowhere']) }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /nowhere: declared in the manifest but no such directory exists/)
  })

  test('fails when a declared root holds no skill document', () => {
    // The directory exists, but nothing under it is a skill: a scan of zero entries is
    // not a green run, or a typo in the root would silence the gate instead of failing it.
    const result = run(catalogRepo({
      [MANIFEST]: manifestText(['packages']),
      'packages/not-a-skill/README.md': '# Not a skill\n',
      'packages/.gitkeep': '',
    }))
    assert.equal(result.status, 1)
    assert.match(result.stderr ?? '', /packages: declared in the manifest but holds no skill document/)
  })
})

describe('--list', () => {
  test('reports the documents it would scan, without failing mid-drift', () => {
    const root = catalogRepo({
      'skills/flat-one.md': skill('flat-one', 'A flat document.'),
      'skills/broken/SKILL.md': '# No frontmatter\n',
    })
    const result = run(root, '--list')
    assert.equal(result.status, 0, combined(result))
    assert.deepEqual((result.stdout ?? '').split('\n').filter(Boolean), [
      'skills/alpha/SKILL.md',
      'skills/beta/SKILL.md',
      'skills/broken/SKILL.md',
      'skills/flat-one.md',
    ])
  })
})
