/**
 * Negative-control tests for the Agent Note gates: every rule must reject a tree that
 * violates it. A gate that passes both ways guards nothing.
 *
 * Run with: node --test skills/dsh-project-harness/scripts/gates.spec.ts
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import {
  archiveDir,
  classDir,
  classSlotAny,
  CLASS_SLOTS,
  lifecycleDir,
  lifecycleSlotAny,
  LIFECYCLE_SLOTS,
  type Locale,
} from './aliases.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** Temporary repository roots created by this suite, removed on exit. */
const created: string[] = []
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/**
 * The declared corpus language of every fixture root: fixtures must build the tree
 * their own declaration names, since the gates reject the other language's spelling.
 */
const localeOfRoot = new Map<string, Locale>()

/** The declared corpus language of a fixture root, defaulting to the upstream `en`. */
function localeOf(root: string): Locale {
  return localeOfRoot.get(root) ?? 'en'
}

/** Create an empty repository root with the full lifecycle and archive tree. */
function makeRepo(withArchive = false, options: { pairedDocuments?: boolean; primaryLanguage?: Locale } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-notes-'))
  created.push(root)
  const locale = options.primaryLanguage ?? 'en'
  localeOfRoot.set(root, locale)
  for (const lifecycle of LIFECYCLE_SLOTS) {
    for (const cls of CLASS_SLOTS) {
      mkdirSync(join(root, '.agents/notes', lifecycleDir(lifecycle, locale), classDir(cls, locale)), { recursive: true })
    }
  }
  if (withArchive) {
    for (const cls of CLASS_SLOTS) {
      mkdirSync(join(root, '.agents/notes', archiveDir(locale), classDir(cls, locale)), { recursive: true })
    }
    writeFileSync(join(root, '.agents/notes', archiveDir(locale), 'AGENTS.md'), '# Archived\n')
    writeFileSync(join(root, '.agents/notes', archiveDir(locale), 'manifest.json'), '{\n  "version": 1,\n  "files": {}\n}\n')
  }
  const config: Record<string, unknown> = {}
  if (options.pairedDocuments !== undefined) config.pairedDocuments = options.pairedDocuments
  if (options.primaryLanguage !== undefined) config.primaryLanguage = options.primaryLanguage
  if (Object.keys(config).length > 0) {
    writeFileSync(join(root, '.agents/notes/harness.json'), `${JSON.stringify(config, null, 2)}\n`)
  }
  return root
}

/** A conforming Chinese note body for each lifecycle. */
function zhBody(lifecycle: string): string {
  const header = lifecycle === 'rejected'
    ? 'Status: rejected — 已被更窄的决策取代\n'
    : `Status: ${lifecycle}\n`
  if (lifecycle === 'proposed') {
    return `# Agent Note: 示例主题\n\n${header}\n## 问题\n这一段脱离方案也能独立成立。\n\n## 提案\n打算做什么。\n\n## 曾考虑的替代方案\n**维持现状。** 否决，因为失败会复现。\n\n## 验收标准\n可观察的完成状态。\n\n## 风险\n可能出什么错。\n`
  }
  if (lifecycle === 'rejected') {
    return `# Agent Note: 示例主题\n\n${header}\n## 问题\n这一段脱离方案也能独立成立。\n\n## 提案\n当初的提案。\n\n## 曾考虑的替代方案\n**维持现状。** 否决，因为失败会复现。\n`
  }
  return `# Agent Note: 示例主题\n\n${header}\n## 问题\n这一段脱离方案也能独立成立。\n\n## 决策\n已交付的事实，现在时。\n\n## 曾考虑的替代方案\n**维持现状。** 否决，因为失败会复现。\n\n## 后果\n代价与收获。\n`
}

/**
 * Write one Agent Note into a lifecycle/class folder, in the fixture's own language.
 * A name from the closed sets — in either language — is placed under the fixture's
 * spelling of that slot; anything else is written verbatim, so a negative-control
 * case can plant the folder it means to reject.
 */
function writeNote(root: string, lifecycle: string, cls: string, filename: string, body: string): void {
  const locale = localeOf(root)
  const lifecycleName = lifecycleSlotAny(lifecycle) === undefined ? lifecycle : lifecycleDir(lifecycleSlotAny(lifecycle)!, locale)
  const className = classSlotAny(cls) === undefined ? cls : classDir(classSlotAny(cls)!, locale)
  const abs = join(root, '.agents/notes', lifecycleName, className, filename)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

/** A conforming note body for each lifecycle. */
function validBody(lifecycle: string): string {
  const header = lifecycle === 'rejected'
    ? 'Status: rejected — superseded by a narrower decision\n'
    : `Status: ${lifecycle}\n`
  if (lifecycle === 'proposed') {
    return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Proposal\nWhat to build.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n\n## Acceptance criteria\nObservable state that means done.\n\n## Risks\nWhat could go wrong.\n`
  }
  if (lifecycle === 'rejected') {
    return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Proposal\nWhat was proposed.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n`
  }
  return `# Agent Note: Sample topic\n\n${header}\n## Problem\nThe failure this solves.\n\n## Decision\nWhat shipped, in the present tense.\n\n## Alternatives considered\n**Do nothing.** Rejected because the failure recurs.\n\n## Consequences\nWhat the trade-off cost and bought.\n`
}

/** Run one gate as a subprocess against a fixture root. */
function runGate(script: string, root: string, extra: string[] = []): { code: number | null; output: string } {
  const result = spawnSync('node', [join(SCRIPT_DIR, script), '--root', root, ...extra], { encoding: 'utf8' })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

/** The Git blob id of a buffer, as the consistency sidecar records it. */
function gitBlobHash(content: string): string {
  const buffer = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${buffer.byteLength}\0`).update(buffer).digest('hex')
}

interface TripletOptions {
  /** Omit one side to build an incomplete artifact set. */
  omit?: 'counterpart' | 'sidecar'
  /** Record deliberately wrong hashes. */
  staleSidecar?: boolean
  /** Archive date to stamp on both sides. */
  archived?: string
  /** Write only the primary file, for a monolingual corpus. */
  primaryOnly?: boolean
  /** The counterpart's language tier; defaults to the Chinese counterpart. */
  counterpartTier?: 'en' | 'zh'
}

/**
 * Write a complete archived artifact set. With `pairedDocuments` enabled the set is a
 * triplet (primary, counterpart, consistency sidecar); monolingual corpora archive the
 * primary file alone.
 */
function writeTriplet(root: string, cls: string, date: string, options: TripletOptions = {}): { source: string; counterpart: string } {
  const base = `${date}-sample`
  const tier = options.counterpartTier ?? 'zh'
  const counterpartName = `${base}.${tier}.md`
  const archived = options.archived ?? '2026-02-01'
  const header = `# Agent Note: Sample\n\nStatus: implemented\nArchived: ${archived}\n\n## Problem\nx\n\n## Decision\ny\n\n## Alternatives considered\n**Z.** no\n\n## Consequences\ncost\n`
  const source = header
  const counterpart = header.replace('# Agent Note: Sample', '# Agent Note: 示例')
  const locale = localeOf(root)
  const clsName = classSlotAny(cls) === undefined ? cls : classDir(classSlotAny(cls)!, locale)
  const dir = join(root, '.agents/notes', archiveDir(locale), clsName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${base}.md`), source)
  if (options.primaryOnly === true) return { source, counterpart }
  if (options.omit !== 'counterpart') writeFileSync(join(dir, counterpartName), counterpart)
  if (options.omit !== 'sidecar') {
    const primaryHash = options.staleSidecar === true ? '0'.repeat(40) : gitBlobHash(source)
    const counterpartHash = options.staleSidecar === true ? '0'.repeat(40) : gitBlobHash(counterpart)
    writeFileSync(join(dir, `${base}.i18n.yaml`), `# Bilingual-pair consistency record (git blob hashes).\n${base}.md: ${primaryHash}\n${counterpartName}: ${counterpartHash}\n`)
  }
  return { source, counterpart }
}

describe('agent note structure gate', () => {
  test('accepts an empty tree', () => {
    const result = runGate('verify-agent-note-classification.ts', makeRepo())
    assert.equal(result.code, 0, result.output)
  })

  test('accepts a conforming note in every lifecycle', () => {
    const root = makeRepo()
    for (const lifecycle of LIFECYCLE_SLOTS) {
      writeNote(root, lifecycle, 'process', '2026-01-01-sample-topic.md', validBody(lifecycle))
    }
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /3 Agent Note\(s\) checked/)
  })

  test('rejects an unknown lifecycle folder', () => {
    const root = makeRepo()
    mkdirSync(join(root, '.agents/notes/ideas'), { recursive: true })
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown lifecycle folder/)
  })

  test('rejects the English spelling of the tree in a Chinese-primary corpus', () => {
    // The declared language spells the whole path. A corpus that flips its
    // declaration moves its tree with it; the two spellings never share one tree.
    const root = makeRepo(false, { primaryLanguage: 'zh' })
    const english = join(root, '.agents/notes/implemented/process')
    mkdirSync(english, { recursive: true })
    writeFileSync(join(english, '2026-01-01-sample.md'), zhBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /structure: implemented\/ — unknown lifecycle folder \(allowed: 提案中, 已实施, 已否决, plus 归档\/\)/)
    assert.match(result.output, /that is the en spelling, and the two spellings never share one tree/)
  })

  test('rejects the Chinese spelling of the tree in an English-primary corpus', () => {
    const root = makeRepo()
    const chinese = join(root, '.agents/notes/implemented/流程')
    mkdirSync(chinese, { recursive: true })
    writeFileSync(join(chinese, '2026-01-01-sample.md'), validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown class folder "流程" \(allowed: feature, bug-fix, simplification, architecture, process, testing\)/)
    assert.match(result.output, /that is the zh spelling/)
  })

  test('accepts a Chinese-primary corpus tree end to end', () => {
    const root = makeRepo(true, { primaryLanguage: 'zh' })
    assert.ok(existsSync(join(root, '.agents/notes/已实施/流程')), 'lifecycle and class folders are spelled in the declared language')
    assert.ok(existsSync(join(root, '.agents/notes/归档/测试')), 'the archive container and its kind folders follow the same language')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', zhBody('implemented'))
    const classification = runGate('verify-agent-note-classification.ts', root)
    assert.equal(classification.code, 0, classification.output)
    assert.match(classification.output, /1 Agent Note\(s\) checked/)
    const archived = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(archived.code, 0, archived.output)
  })

  test('rejects an unknown class folder', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'refactor', '2026-01-01-sample.md', validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown class folder "refactor"/)
  })

  test('rejects a filename without a leading date', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', 'sample-topic.md', validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /filename must be yyyy-mm-dd-topic\.md/)
  })

  test('rejects a note one level too deep', () => {
    const root = makeRepo()
    const nested = join(root, '.agents/notes/implemented/process/nested/2026-01-01-sample.md')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /expected \{lifecycle\}\/\{class\}\/file\.md/)
  })

  test('rejects a centralized index', () => {
    const root = makeRepo()
    writeFileSync(join(root, '.agents/notes/INDEX.md'), '# Index\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /centralized Agent Note indexes are forbidden/)
  })

  test('rejects a note parked in the former docs/rfc home', () => {
    const root = makeRepo()
    mkdirSync(join(root, 'docs/rfc'), { recursive: true })
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /legacy-path: docs\/rfc\/ is forbidden/)
  })
})

describe('agent note format gate', () => {
  test('accepts a conforming implemented note', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('rejects a first line that is not the Agent Note header', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented').replace('# Agent Note: Sample topic', '# Sample topic'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 1 must be `# Agent Note: <title>`/)
  })

  test('rejects a status line that disagrees with the lifecycle folder', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented').replace('Status: implemented', 'Status: proposed'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 3 must match the implemented status grammar/)
  })

  test('rejects a rejected note with no reason', () => {
    const root = makeRepo()
    writeNote(root, 'rejected', 'process', '2026-01-01-sample.md', validBody('rejected').replace('Status: rejected — superseded by a narrower decision', 'Status: rejected'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 3 must match the rejected status grammar/)
  })

  test('rejects a missing required section', () => {
    const root = makeRepo()
    const body = validBody('implemented').replace('## Consequences\nWhat the trade-off cost and bought.\n', '')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /missing the required `## Consequences` section/)
  })

  test('rejects a proposal-era heading in an implemented note', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\n## Plan\nStep one.\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /is a proposal-era heading/)
  })

  test('rejects a note with no alternatives section', () => {
    const root = makeRepo()
    const body = validBody('implemented').replace(/## Alternatives considered\n[^\n]*\n/, '')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /missing `## Alternatives considered`/)
  })

  test('rejects the grandfather comment on a note dated after the format took effect', () => {
    const root = makeRepo()
    const body = validBody('implemented')
      .replace(/## Alternatives considered\n[^\n]*\n/, '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n')
    writeNote(root, 'implemented', 'process', '2026-08-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /grandfather comment is only valid for Agent Notes dated before/)
  })

  test('accepts the grandfather comment on a pre-format note', () => {
    const root = makeRepo()
    const body = validBody('implemented')
      .replace(/## Alternatives considered\n[^\n]*\n/, '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('rejects a second Status line elsewhere in the file', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\nStatus: implemented\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /must be the only one in the file/)
  })

  test('ignores format tokens inside a fenced example', () => {
    const root = makeRepo()
    const body = `${validBody('implemented')}\n## Testing\nA note in a fence is not structure:\n\n\`\`\`markdown\n## Plan\nStatus: proposed\n\`\`\`\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 0, result.output)
  })
})

describe('frozen archive gate', () => {
  test('accepts an empty sealed archive', () => {
    const root = makeRepo(true)
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('accepts a monolingual artifact by default', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    assert.match(sealed.output, /sealed 1 new artifact/)
    const verified = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(verified.code, 0, verified.output)
  })

  test('rejects a counterpart when the corpus is monolingual', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /configured monolingual/)
  })

  test('rejects an incomplete triplet when pairs are required', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { omit: 'counterpart' })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /incomplete archived triplet/)
  })

  test('rejects an archive missing a required kind directory', () => {
    const root = makeRepo(true)
    rmSync(join(root, '.agents/notes/archived/testing'), { recursive: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /required kind directory is missing/)
  })

  test('rejects a note with no primary file', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { omit: 'counterpart' })
    // Remove the primary too, leaving only the sidecar.
    rmSync(join(root, '.agents/notes/archived/process/2026-01-01-sample.md'))
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived note has no primary file/)
  })

  test('rejects a seal whose content hash changed', () => {
    const root = makeRepo(true)
    const triplet = writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    assert.match(sealed.output, /sealed 1 new artifact/)
    // Editing a sealed artifact must fail even when writing, because the seal is
    // append-only: the manifest is never allowed to absorb the change.
    writeFileSync(join(root, '.agents/notes/archived/process/2026-01-01-sample.md'), `${triplet.source}\nrewritten after sealing\n`)
    const result = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(result.code, 1)
    assert.match(result.output, /sealed content hash changed/)
  })

  test('rejects a triplet whose sidecar hashes are stale', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { staleSidecar: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /consistency record must contain the current Git blob hashes/)
  })

  test('rejects an archive date earlier than the note filename', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-05-01', { archived: '2026-01-01', primaryOnly: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archive date 2026-01-01 predates the note filename/)
  })

  test('rejects an unsealed artifact in verify mode', () => {
    const root = makeRepo(true)
    writeTriplet(root, 'process', '2026-01-01', { primaryOnly: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived artifact is not sealed in manifest\.json/)
  })

  test('rejects a missing archived AGENTS.md', () => {
    const root = makeRepo(true)
    rmSync(join(root, '.agents/notes/archived/AGENTS.md'))
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived\/AGENTS\.md is required/)
  })

  test('rejects an unexpected file at the archive root', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/archived/stray.md'), 'x\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unexpected root file/)
  })

  test('rejects a manifest outside its closed schema', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/archived/manifest.json'), '{"version":1,"files":{},"extra":true}\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /expected exactly the fields/)
  })

  test('rejects an invalid pairedDocuments value', () => {
    const root = makeRepo(true)
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"pairedDocuments":"yes"}\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /must be a boolean/)
  })

  test('ignores dotfiles that keep empty kind directories', () => {
    const root = makeRepo(true)
    for (const cls of CLASS_SLOTS) {
      writeFileSync(join(root, '.agents/notes', archiveDir(localeOf(root)), classDir(cls, localeOf(root)), '.gitkeep'), '')
    }
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 0, result.output)
  })

  test('names the declared container when the archive tree is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-notes-'))
    created.push(root)
    mkdirSync(join(root, '.agents/notes'), { recursive: true })
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"primaryLanguage":"zh"}\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /no \.agents\/notes\/归档\/ tree found/)
  })

  test('reads an archive sealed under the other language after the declaration flips', () => {
    // Sealed paths keep the spelling they were sealed under: a corpus that changes
    // its declared language renames the container, never a sealed kind directory.
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01')
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"primaryLanguage":"zh","pairedDocuments":true}\n')
    renameSync(join(root, '.agents/notes/archived'), join(root, '.agents/notes/归档'))
    const verified = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(verified.code, 0, verified.output)
    assert.match(verified.output, /3 frozen artifact\(s\) checked across 6 kind\(s\)/)
  })

  test('rejects a kind folder that is no language spelling of a class', () => {
    const root = makeRepo(true, { primaryLanguage: 'zh' })
    mkdirSync(join(root, '.agents/notes/归档/重构'), { recursive: true })
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown Agent Note kind \(the corpus's own spellings are 功能, 缺陷修复, 简化, 架构, 流程, 测试\)/)
  })
})

describe('bilingual notes', () => {
  /** Insert the line-5 language switcher, which every paired note carries. */
  const withSwitcher = (body: string, line: string): string => {
    const lines = body.split('\n')
    return [...lines.slice(0, 4), line, ...lines.slice(4)].join('\n')
  }

  const enSwitcher = (stem: string): string => `English | [中文](${stem}.zh.md)`
  const zhSwitcher = (stem: string): string => `[English](${stem}.md) | 中文`

  /** Confirm a pair at its current contents, as the author's re-record step does. */
  function sealPair(root: string): void {
    const result = runGate('verify-agent-note-format.ts', root, ['--write'])
    assert.equal(result.code, 0, result.output)
  }

  /** Write a note paired with its Chinese counterpart, both sides conforming and confirmed. */
  function writeChinesePair(root: string, lifecycle: string, stem = '2026-01-01-sample'): void {
    writeNote(root, lifecycle, 'process', `${stem}.md`, withSwitcher(validBody(lifecycle), enSwitcher(stem)))
    writeNote(root, lifecycle, 'process', `${stem}.zh.md`, withSwitcher(zhBody(lifecycle), zhSwitcher(stem)))
    sealPair(root)
  }

  test('accepts a paired note and counts it as one Agent Note', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const format = runGate('verify-agent-note-format.ts', root)
    assert.equal(format.code, 0, format.output)
    const classification = runGate('verify-agent-note-classification.ts', root)
    assert.equal(classification.code, 0, classification.output)
    assert.match(classification.output, /1 Agent Note\(s\) checked/)
  })

  test('accepts a Chinese-primary corpus with an English counterpart', () => {
    const root = makeRepo(false, { primaryLanguage: 'zh' })
    const stem = '2026-01-01-sample'
    writeNote(root, 'implemented', 'process', `${stem}.md`, withSwitcher(zhBody('implemented'), `[English](${stem}.en.md) | 中文`))
    writeNote(root, 'implemented', 'process', `${stem}.en.md`, withSwitcher(validBody('implemented'), `English | [中文](${stem}.md)`))
    const format = runGate('verify-agent-note-format.ts', root)
    assert.equal(format.code, 1)
    assert.match(format.output, /missing `已实施\/流程\/2026-01-01-sample\.i18n\.yaml`/)
    sealPair(root)
    const confirmed = runGate('verify-agent-note-format.ts', root)
    assert.equal(confirmed.code, 0, confirmed.output)
    const classification = runGate('verify-agent-note-classification.ts', root)
    assert.equal(classification.code, 0, classification.output)
    assert.match(classification.output, /1 Agent Note\(s\) checked/)
  })

  test('leaves a Chinese-primary corpus with no counterparts untouched', () => {
    // The bilingual rules are demand-driven: no counterpart file means no switcher,
    // no mirror, and no consistency record to maintain.
    const root = makeRepo(false, { primaryLanguage: 'zh' })
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', zhBody('implemented'))
    const format = runGate('verify-agent-note-format.ts', root)
    assert.equal(format.code, 0, format.output)
    const classification = runGate('verify-agent-note-classification.ts', root)
    assert.equal(classification.code, 0, classification.output)
  })

  test('rejects a pair whose consistency record is missing', () => {
    const root = makeRepo()
    const stem = '2026-01-01-sample'
    writeNote(root, 'implemented', 'process', `${stem}.md`, withSwitcher(validBody('implemented'), enSwitcher(stem)))
    writeNote(root, 'implemented', 'process', `${stem}.zh.md`, withSwitcher(zhBody('implemented'), zhSwitcher(stem)))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /a pair is three sibling files \(re-record with `verify-agent-note-format\.ts --write`\)/)
  })

  test('rejects an edited side whose pair was already confirmed', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const edited = `${withSwitcher(zhBody('implemented'), zhSwitcher('2026-01-01-sample')).replace('代价与收获。', '这段改写没有回到英文侧。')}`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', edited)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /section \/agent-note-sample-topic\/consequences changed since confirmation \(zh\)/)
  })

  test('re-records an edited pair with --write, which then verifies green', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', withSwitcher(
      zhBody('implemented').replace('代价与收获。', '两段都改过，再确认一次。'),
      zhSwitcher('2026-01-01-sample'),
    ))
    const stale = runGate('verify-agent-note-format.ts', root)
    assert.equal(stale.code, 1, stale.output)
    const reRecorded = runGate('verify-agent-note-format.ts', root, ['--write'])
    assert.equal(reRecorded.code, 0, reRecorded.output)
    assert.match(reRecorded.output, /re-recorded 1 pair consistency record\(s\)/)
    const verified = runGate('verify-agent-note-format.ts', root)
    assert.equal(verified.code, 0, verified.output)
  })

  test('rejects a malformed consistency record instead of dropping its entries', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const sidecar = join(root, '.agents/notes/implemented/process/2026-01-01-sample.i18n.yaml')
    writeFileSync(sidecar, `${readFileSync(sidecar, 'utf8').replace('  en: ', '  fr: ')}`)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /malformed consistency record/)
  })

  test('refuses to record a pair whose headings do not mirror', () => {
    const root = makeRepo()
    const stem = '2026-01-01-sample'
    writeNote(root, 'implemented', 'process', `${stem}.md`, withSwitcher(validBody('implemented'), enSwitcher(stem)))
    const body = zhBody('implemented').replace('## 曾考虑的替代方案', '## 决策').replace(/\n## 后果\n/, '\n## 曾考虑的替代方案\n')
    writeNote(root, 'implemented', 'process', `${stem}.zh.md`, withSwitcher(body, zhSwitcher(stem)))
    const result = runGate('verify-agent-note-format.ts', root, ['--write'])
    assert.equal(result.code, 1)
    assert.match(result.output, /section 3 must be `## 曾考虑的替代方案`/)
    assert.ok(!existsSync(join(root, `.agents/notes/implemented/process/${stem}.i18n.yaml`)))
  })

  test('rejects a consistency record without a counterpart file', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.i18n.yaml', '/:\n  en: 0000000000000000\n  zh: 1111111111111111\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /consistency record without a counterpart file \(process\/2026-01-01-sample\.zh\.md\)/)
  })

  test('rejects an orphan consistency record', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-ghost.i18n.yaml', '/:\n  en: 0000000000000000\n  zh: 1111111111111111\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /consistency record without its note/)
  })

  test('rejects a Chinese counterpart whose skeleton keeps English headings', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const body = withSwitcher(zhBody('implemented').replace('## 决策', '## Decision'), zhSwitcher('2026-01-01-sample'))
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /missing the required `## 决策` section/)
  })

  test('rejects a Chinese counterpart whose first section is not `## 问题`', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const body = withSwitcher(zhBody('implemented').replace('## 问题', '## 背景'), zhSwitcher('2026-01-01-sample'))
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', body)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /the first section must be `## 问题`/)
  })

  test('rejects a counterpart whose sections do not mirror the primary sequence', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const body = zhBody('implemented').replace('## 曾考虑的替代方案', '## 决策').replace(/\n## 后果\n/, '\n## 曾考虑的替代方案\n')
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', withSwitcher(body, zhSwitcher('2026-01-01-sample')))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /section 3 must be `## 曾考虑的替代方案` to mirror `## Alternatives considered`/)
  })

  test('rejects a counterpart with a different heading count', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const body = `${zhBody('implemented')}\n## 校准证据\n多出来的一节。\n`
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', withSwitcher(body, zhSwitcher('2026-01-01-sample')))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /mirrors 4 heading\(s\) of `2026-01-01-sample\.md` but carries 5/)
  })

  test('rejects a counterpart that flattens a subsection to its section depth', () => {
    const root = makeRepo()
    writeChinesePair(root, 'implemented')
    const primary = withSwitcher(
      validBody('implemented').replace('## Alternatives considered\n', '## Alternatives considered\n\n### Why not grep?\nA local driver never runs.\n'),
      enSwitcher('2026-01-01-sample'),
    )
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', primary)
    const counterpart = withSwitcher(
      zhBody('implemented').replace('## 曾考虑的替代方案\n', '## 曾考虑的替代方案\n\n## 为什么不用 grep？\n本地驱动永远不会运行。\n'),
      zhSwitcher('2026-01-01-sample'),
    )
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', counterpart)
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /heading 4 must be depth 3 to mirror `### Why not grep\?`/)
  })

  test('requires the language switcher on line 5 of both sides', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', zhBody('implemented'))
    const result = runGate('verify-agent-note-format.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /line 5 must be the language switcher/)
    assert.ok(result.output.includes('`English | [中文](2026-01-01-sample.zh.md)`'), result.output)
    assert.ok(result.output.includes('`[English](2026-01-01-sample.md) | 中文`'), result.output)
  })

  test('rejects a counterpart without its primary file', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.zh.md', zhBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /counterpart without its primary file \(process\/2026-01-01-sample\.md\)/)
  })

  test('rejects a tiered file that names the primary language', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.en.md', validBody('implemented'))
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /`\.en\.md` names the primary language/)
  })

  test('rejects an unknown harness.json field', () => {
    const root = makeRepo()
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"primary":"zh"}\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /unknown field "primary"/)
  })

  test('rejects an unsupported primaryLanguage', () => {
    const root = makeRepo()
    writeFileSync(join(root, '.agents/notes/harness.json'), '{"primaryLanguage":"jp"}\n')
    const result = runGate('verify-agent-note-classification.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /`primaryLanguage` must be one of en, zh/)
  })

  test('seals a triplet whose counterpart is English when the corpus is Chinese-primary', () => {
    const root = makeRepo(true, { pairedDocuments: true, primaryLanguage: 'zh' })
    writeTriplet(root, 'process', '2026-01-01', { counterpartTier: 'en' })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    assert.match(sealed.output, /sealed 3 new artifact/)
    const verified = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(verified.code, 0, verified.output)
  })

  test('accepts a sealed tier that names the declared primary language', () => {
    // The tier is frozen with the seal. A corpus that flips its declaration keeps the
    // tiers it archived under; the tree gate, not the archive, owns the live rule.
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01', { counterpartTier: 'en' })
    const sealed = runGate('verify-archived-agent-notes.ts', root, ['--write'])
    assert.equal(sealed.code, 0, sealed.output)
    const verified = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(verified.code, 0, verified.output)
  })

  test('rejects an archived set with no untiered primary file', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    const dir = join(root, '.agents/notes', archiveDir(localeOf(root)), classDir('process', localeOf(root)))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-01-01-sample.zh.md'), '# Agent Note: Sample\n\nStatus: implemented\nArchived: 2026-02-01\n')
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /archived note has no primary file \(found 2026-01-01-sample\.zh\.md\)/)
  })

  test('rejects an archived pair whose record was not converted to blob hashes', () => {
    const root = makeRepo(true, { pairedDocuments: true })
    writeTriplet(root, 'process', '2026-01-01')
    // The active-tree record is section-keyed; archival must rewrite it to the
    // whole-file blob form the archive seals.
    writeFileSync(
      join(root, '.agents/notes/archived/process/2026-01-01-sample.i18n.yaml'),
      '/agent-note-sample:\n  en: 0123456789abcdef\n  zh: fedcba9876543210\n',
    )
    const result = runGate('verify-archived-agent-notes.ts', root)
    assert.equal(result.code, 1)
    assert.match(result.output, /consistency record must contain the current Git blob hashes/)
  })
})

describe('repository root resolution', () => {
  test('a gate run from a subdirectory finds the same tree', () => {
    const root = makeRepo()
    writeNote(root, 'implemented', 'process', '2026-01-01-sample.md', validBody('implemented'))
    const deep = join(root, 'apps/web/src')
    mkdirSync(deep, { recursive: true })
    const result = spawnSync('node', [join(SCRIPT_DIR, 'verify-agent-note-format.ts')], { cwd: deep, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /1 Agent Note\(s\) checked/)
  })

  test('an unknown --root path fails loudly', () => {
    const result = runGate('verify-agent-note-format.ts', resolve(SCRIPT_DIR, 'does-not-exist'))
    assert.equal(result.code, 1)
    assert.match(result.output, /is not a directory/)
  })
})
