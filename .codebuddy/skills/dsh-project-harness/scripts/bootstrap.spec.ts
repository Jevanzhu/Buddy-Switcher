/**
 * Tests for `bootstrap.ts`. The two failure modes covered here both produced a
 * repository that looked installed but could not run a single gate:
 *
 *   - a verifier left out of the copy list, so the copied gate dies on import
 *   - an incomplete skill copy, so the Agent Note gates cannot start at all
 *
 * Run with: node --test skills/dsh-project-harness/scripts/bootstrap.spec.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { findWrapViolations } from './verify-md-wrap.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(SCRIPT_DIR, 'bootstrap.ts')
const SKILL_ROOT = resolve(SCRIPT_DIR, '..')

/** A fresh git-less directory to bootstrap into. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'harness-bootstrap-'))
}

const roots: string[] = []
function tracked(): string {
  const root = scratch()
  roots.push(root)
  return root
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('bootstrapping a fresh repository', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
  })

  test('succeeds and reports what it created', () => {
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /harness bootstrap: v\d+\.\d+\.\d+, \d+ path\(s\) created/)
  })

  test('copies every verifier the gate list runs', () => {
    // Each entry names a file the copied run-gates.ts spawns or a verifier imports.
    for (const file of [
      'harness-root.ts',
      'surface.ts',
      'markdown.ts',
      'doc-words.ts',
      'baseline.ts',
      'aliases.ts',
      'harness-config.ts',
      'agent-note-tree.ts',
      'pair-record.ts',
      'archived-agent-notes.ts',
      'verify-agent-note-format.ts',
      'verify-agent-note-classification.ts',
      'verify-archived-agent-notes.ts',
      'verify-comment-hygiene.ts',
      'verify-doc-budgets.ts',
      'verify-doc-claims.ts',
      'verify-doc-index.ts',
      'verify-md-links.ts',
      'verify-md-wrap.ts',
      'verify-skill-catalog.ts',
      'verify-test-hygiene.ts',
      'run-gates.ts',
    ]) {
      assert.ok(existsSync(join(target, 'scripts/harness', file)), `${file} was not copied`)
    }
  })

  test('every copied gate actually starts', () => {
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    // A missing import surfaces as MODULE_NOT_FOUND; the gates must get far enough
    // to report their own verdicts instead.
    assert.doesNotMatch(out, /MODULE_NOT_FOUND|Cannot find module/)
    assert.match(out, /11 passed, 0 failed, 0 skipped/, out)
  })

  test('runs the modes the starter AGENTS.md tells the adopter to run', () => {
    // The copied template is the adopter's standing orders: the commands in it are
    // promises. `check-all` was documented there while the table did not define it, so
    // both promised modes are run here, on a repository the harness itself set up.
    for (const mode of ['doc-quick', 'check-all']) {
      const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), mode], {
        cwd: target,
        encoding: 'utf8',
      })
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
      assert.equal(run.status, 0, `${mode}: ${out}`)
      assert.match(out, /11 passed, 0 failed, 0 skipped/, out)
    }
  })

  test('creates the Agent Note lifecycle and archive trees the gates require', () => {
    for (const lifecycle of ['proposed', 'implemented', 'rejected']) {
      for (const cls of ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']) {
        assert.ok(existsSync(join(target, '.agents/notes', lifecycle, cls)), `${lifecycle}/${cls} missing`)
        assert.ok(existsSync(join(target, '.agents/notes/archived', cls)), `archived/${cls} missing`)
      }
    }
  })

  test('declares an English, monolingual corpus, since no counterpart files exist', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, '.agents/notes/harness.json'), 'utf8')), {
      primaryLanguage: 'en',
      pairedDocuments: false,
    })
  })

  test('writes the starter standing docs in the declared language, not the skill author’s', () => {
    // The starters are language-paired and picked by the same resolution as the
    // corpus: an English repository handed Chinese standing orders is the same
    // defect as a Chinese corpus spelled in English folder names.
    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    assert.match(agents, /## Maintaining these instructions/)
    assert.match(agents, /repository's working language: \*\*English\*\*/)
    assert.doesNotMatch(agents, /本文件的维护/)
    assert.match(readFileSync(join(target, 'docs/AGENTS.md'), 'utf8'), /## One fact, one home/)
    assert.match(readFileSync(join(target, 'lefthook.yml'), 'utf8'), /Commit hooks: deliberately thin/)
    assert.match(result.stdout ?? '', /ledger\.en\.md/)
    assert.match(result.stdout ?? '', /docs-index\.en\.md/)
  })

  test('measures the standing docs that already existed, not the templates it just wrote', () => {
    // Budgets are seeded before templates are copied, so a freshly copied skeleton
    // cannot set a ceiling the first real paragraph blows through. The manifest is
    // therefore empty here, and says how to seed it.
    const manifest = JSON.parse(readFileSync(join(target, 'scripts/harness/doc-budgets.manifest.json'), 'utf8'))
    assert.deepEqual(manifest, {})
    assert.match(result.stdout ?? '', /no standing documents to measure yet/)
    assert.match(result.stdout ?? '', /re-run bootstrap to seed their ceilings/)
  })

  test('writes no ledger, because it had no violations to record', () => {
    assert.equal(existsSync(join(target, 'scripts/harness/baseline.json')), false)
  })

  test('seeds an empty document-chain manifest, so the index gate has an answer on day one', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'scripts/harness/doc-index.manifest.json'), 'utf8')), {})
    assert.match(result.stdout ?? '', /doc-index\.manifest\.json declares no chain yet/)
  })

  test('seeds an empty claim manifest, since which numbers a document states is a judgement', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'scripts/harness/doc-claims.manifest.json'), 'utf8')), {})
    assert.match(result.stdout ?? '', /doc-claims\.manifest\.json declares no claims yet/)
  })

  test('seeds an empty skill-catalog manifest, so the catalog gate runs on day one', () => {
    // `{}` declares no skill roots: the gate reports a pass without scanning, because a
    // target that ships no skills has nothing to check. The copy of the verifier ships
    // beside it, and invoking it reaches its own report line — a gate that silently
    // exits green is the failure the entry-point guard exists to prevent.
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'scripts/harness/skill-catalog.manifest.json'), 'utf8')), {})
    assert.match(result.stdout ?? '', /skill-catalog\.manifest\.json declares no skill roots yet/)
    const copy = join(target, 'scripts/harness/verify-skill-catalog.ts')
    assert.ok(existsSync(copy), 'verify-skill-catalog.ts was not copied')
    const run = spawnSync(process.execPath, [copy], { cwd: target, encoding: 'utf8' })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.equal(run.status, 0, out)
    assert.match(out, /verify-skill-catalog: .*declares no skill roots; nothing to check/)
  })

  test('seeds comment rules against the measured tree, never against a guessed root', () => {
    // The verifiers were just copied into scripts/, so that root is measured as
    // present and scanned deliberately; a source tree would join the list, and a
    // root the target does not have is never declared (the gate fails closed on one).
    const manifest = JSON.parse(readFileSync(join(target, 'scripts/harness/comment-hygiene.manifest.json'), 'utf8'))
    assert.deepEqual(manifest.scan, ['scripts'])
    assert.equal(manifest.labels.length, 4)
    assert.equal(manifest.residue.length, 2)
    assert.match(result.stdout ?? '', /comment-hygiene scans scripts for the starter shapes/)
  })

  test('declares no test surface when the target keeps no tests yet', () => {
    // A declared root holding no test file would be reported by the gate's fail-closed
    // rule, so the seed writes nothing rather than a root that cannot be satisfied.
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'scripts/harness/test-hygiene.manifest.json'), 'utf8')), {})
    assert.match(result.stdout ?? '', /no test directory found \(test, tests, __tests__\)/)
  })

  test('is idempotent: a second run preserves the files the first run wrote', () => {
    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    writeFileSync(join(target, 'AGENTS.md'), `${agents}\n<!-- local edit -->\n`)
    const again = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(again.status, 0, String(again.stderr))
    assert.match(again.stdout ?? '', /preserved \d+ existing path/)
    assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /<!-- local edit -->/)
  })

  test('records the bundle version, so the target can say what it installed', () => {
    const version = readFileSync(join(SKILL_ROOT, 'VERSION'), 'utf8').trim()
    assert.match(version, /^\d+\.\d+\.\d+$/, `VERSION holds ${JSON.stringify(version)}`)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'scripts/harness/version.json'), 'utf8')), { version })
    assert.match(result.stdout ?? '', new RegExp(`harness bootstrap: v${version.replaceAll('.', '\\.')},`))
  })

  test('rewrites the version record when the installed bundle changed', () => {
    // Installer metadata rather than an adopter declaration: it follows its content,
    // so the record cannot drift from the copies actually sitting in the target.
    const record = join(target, 'scripts/harness/version.json')
    writeFileSync(record, '{\n  "version": "0.0.0"\n}\n')
    const run = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(run.status, 0, String(run.stderr))
    assert.match(run.stdout ?? '', /^ {2}\+ scripts[\\/]harness[\\/]version\.json$/m)
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), {
      version: readFileSync(join(SKILL_ROOT, 'VERSION'), 'utf8').trim(),
    })
  })

  test('points at templates on paths that resolve', () => {
    // The chain templates are deliberately not copied into the target, so a mention
    // that reads as target-relative sends the reader looking for a file that is not
    // there. Every template the output names must exist in this skill's templates/.
    const mentioned = [...(result.stdout ?? '').matchAll(/templates[\\/]([A-Za-z0-9_.-]+\.(?:md|yml))/g)].map(match => match[1])
    assert.ok(mentioned.length >= 2, `the output names no template: ${result.stdout ?? ''}`)
    for (const name of new Set(mentioned)) {
      assert.ok(existsSync(join(SKILL_ROOT, 'templates', name)), `${name} is named in the output but not shipped`)
    }
  })
})

/** Content that marks a manifest as the adopter's own, so an overwrite is visible. */
const MINE = '{"__mine__": 1}\n'

describe('scaffolding a Chinese corpus', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--notes-language', 'zh'], { encoding: 'utf8' })
  })

  test('succeeds, and spells the whole Agent Note tree in the declared language', () => {
    assert.equal(result.status, 0, String(result.stderr))
    for (const lifecycle of ['提案中', '已实施', '已否决']) {
      for (const cls of ['功能', '缺陷修复', '简化', '架构', '流程', '测试']) {
        assert.ok(existsSync(join(target, '.agents/notes', lifecycle, cls)), `${lifecycle}/${cls} missing`)
        assert.ok(existsSync(join(target, '.agents/notes/归档', cls)), `归档/${cls} missing`)
      }
    }
  })

  test('declares the language it seeded, so tree and declaration cannot disagree', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, '.agents/notes/harness.json'), 'utf8')), {
      primaryLanguage: 'zh',
      pairedDocuments: false,
    })
  })

  test('writes the archive instruction file in that language, naming folders that exist', () => {
    const doc = readFileSync(join(target, '.agents/notes/归档/AGENTS.md'), 'utf8')
    assert.match(doc, /归档是文件进入此树的唯一途径/)
    assert.match(doc, /已实施\/<类>\//)
    assert.equal(existsSync(join(target, '.agents/notes/archived')), false, 'the English container is not seeded alongside')
  })

  test('writes the starter standing docs in that same language', () => {
    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    assert.match(agents, /## 本文件的维护/)
    assert.match(agents, /本仓的工作语言在这里声明：\*\*中文\*\*/)
    assert.match(readFileSync(join(target, 'docs/AGENTS.md'), 'utf8'), /## 一个事实一个家/)
    assert.match(readFileSync(join(target, 'lefthook.yml'), 'utf8'), /提交钩子：刻意保持薄/)
    assert.match(result.stdout ?? '', /ledger\.zh\.md/)
    assert.match(result.stdout ?? '', /docs-index\.zh\.md/)
  })

  test('runs the note gates green on the tree it just seeded', () => {
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'agent-notes'], {
      cwd: target,
      encoding: 'utf8',
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.equal(run.status, 0, out)
    assert.match(out, /3 passed, 0 failed, 0 skipped/, out)
  })

  test('refuses a flag that contradicts an existing declaration', () => {
    // Changing a corpus's language moves its whole tree, so it is its own change,
    // never a side effect of re-running the scaffold.
    const directory = tracked()
    spawnSync(process.execPath, [BOOTSTRAP, '--target', directory], { encoding: 'utf8' })
    const refused = spawnSync(process.execPath, [BOOTSTRAP, '--target', directory, '--notes-language', 'zh'], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr ?? '', /--notes-language zh contradicts \.agents\/notes\/harness\.json \(declared en\)/)
  })

  test('rejects a language it does not know', () => {
    const directory = tracked()
    const refused = spawnSync(process.execPath, [BOOTSTRAP, '--target', directory, '--notes-language', 'jp'], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr ?? '', /--notes-language must be en or zh/)
  })
})

describe('the archive instruction file', () => {
  test('is wrap-conformant prose in either language', () => {
    // Sealed bytes, but still Markdown a repository may scan with the wrap gate: a
    // scaffold shipping a wrapped paragraph goes red on day one, before anyone has
    // edited a line.
    for (const [language, container] of [['en', 'archived'], ['zh', '归档']] as const) {
      const target = tracked()
      const run = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--notes-language', language], {
        encoding: 'utf8',
      })
      assert.equal(run.status, 0, String(run.stderr))
      const doc = readFileSync(join(target, '.agents/notes', container, 'AGENTS.md'), 'utf8')
      assert.deepEqual(findWrapViolations(doc), [], `${language}: the archive instructions ship wrapped prose`)
    }
  })
})

describe('seeding budgets from a Chinese document', () => {
  test('counts CJK ideographs, so the seeded ceiling measures the same document the gate will', () => {
    // Three whitespace tokens carrying ten ideographs: a token-only seed would set a
    // ceiling of ~3, and the same gate measuring ideographs would then fail the very
    // document the ceiling was measured from.
    const target = tracked()
    const text = '# 示例\n\n这一段有十个汉字。\n'
    writeFileSync(join(target, 'README.md'), text)
    const run = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--notes-language', 'zh'], { encoding: 'utf8' })
    assert.equal(run.status, 0, String(run.stderr))
    const budgets = JSON.parse(readFileSync(join(target, 'scripts/harness/doc-budgets.manifest.json'), 'utf8')) as Record<string, number>
    const tokens = text.split(/\s+/).filter(Boolean).length
    const ideographs = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
    assert.equal(ideographs, 10)
    assert.equal(budgets['README.md'], Math.ceil((tokens + ideographs) * 1.15))
  })
})

/** The manifests bootstrap seeds; every one of them carries adopter declarations. */
const SEEDED_MANIFESTS = [
  'doc-budgets.manifest.json',
  'doc-index.manifest.json',
  'comment-hygiene.manifest.json',
  'test-hygiene.manifest.json',
  'doc-claims.manifest.json',
  'skill-catalog.manifest.json',
] as const

/** An installation that has been used since: edited copies plus real declarations. */
function usedInstallation(): string {
  const target = tracked()
  const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
  assert.equal(install.status, 0, String(install.stderr))
  writeFileSync(join(target, 'scripts/harness/verify-md-wrap.ts'), '// locally customised\n')
  writeFileSync(join(target, 'AGENTS.md'), '# Mine\n')
  for (const manifest of SEEDED_MANIFESTS) writeFileSync(join(target, 'scripts/harness', manifest), MINE)
  return target
}

describe('upgrading with --force', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = usedInstallation()
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
  })

  test('refreshes every copied verifier back to the shipped bytes', () => {
    assert.equal(result.status, 0, String(result.stderr))
    for (const entry of readdirSync(join(target, 'scripts/harness'))) {
      if (!entry.endsWith('.ts')) continue
      const shipped = join(SKILL_ROOT, 'scripts', entry)
      assert.ok(existsSync(shipped), `${entry} sits in the target but ships in the skill`)
      assert.equal(
        readFileSync(join(target, 'scripts/harness', entry), 'utf8'),
        readFileSync(shipped, 'utf8'),
        `${entry} was not refreshed`,
      )
    }
  })

  test('leaves the declarations in every manifest untouched', () => {
    // The manifests are where the adopter's judgement lives: which numbers a document
    // states, which roots the comment gate scans. An upgrade that resets them quietly
    // narrows the gates, and nothing downstream reports it.
    for (const manifest of SEEDED_MANIFESTS) {
      assert.equal(readFileSync(join(target, 'scripts/harness', manifest), 'utf8'), MINE, `${manifest} was reset by --force`)
    }
    assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), '# Mine\n')
    assert.match(result.stdout ?? '', /--force refreshed the copied verifiers only/)
  })
})

describe('what an upgrade leaves alone', () => {
  test('a repository-edited archive instruction file survives a refresh', () => {
    // The archive's instruction file is sealed with the tree it describes. An upgrade
    // that rewrites it reverts an adaptation silently — and touches a tree whose gate
    // rejects changed bytes.
    const target = tracked()
    const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(install.status, 0, String(install.stderr))
    const archived = join(target, '.agents/notes/archived/AGENTS.md')
    writeFileSync(archived, '# Mine\n')
    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
    assert.equal(result.status, 0, String(result.stderr))
    assert.equal(readFileSync(archived, 'utf8'), '# Mine\n', '--force rewrote the sealed archive instructions')
    assert.match(result.stdout ?? '', /\.agents[\\/]notes[\\/]archived[\\/]AGENTS\.md/)
  })

  test('a starter document deleted since the install stays deleted', () => {
    // The starters exist so the first run has a shape to edit. Once the harness is
    // installed the repository owns them: re-creating a missing one would resurrect a
    // decision — a real incident for lefthook.yml, deleted deliberately — as a side
    // effect of re-running or upgrading.
    const target = tracked()
    const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(install.status, 0, String(install.stderr))
    rmSync(join(target, 'lefthook.yml'))
    for (const args of [[], ['--force']] as const) {
      const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, String(result.stderr))
      assert.equal(
        existsSync(join(target, 'lefthook.yml')),
        false,
        `the ${args.join(' ') || 'plain'} re-run resurrected a deleted starter`,
      )
    }
    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
    assert.match(result.stdout ?? '', /starter documents are written only on the first scaffold/)
    assert.match(result.stdout ?? '', /templates[\\/]lefthook\.en\.yml/)
  })

  test('says that an upgrade can change what a gate accepts', () => {
    // A version bump can change what a gate accepts without touching the adopting
    // repository, so the documents that describe gate behavior have to be re-checked
    // by hand. The flag that performs the upgrade is the one that says so.
    const target = tracked()
    spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /an upgrade can change what a gate accepts/)
  })
})

describe('the gate table under --force', () => {
  test('an edited gate table survives a refresh, and the rest of the copies still upgrade', () => {
    // The table declares which checks this repository runs. Refreshing it wholesale
    // reverts that decision as a side effect of an upgrade, and the adopter learns
    // about it from a gate that stopped running, not from a report.
    const target = tracked()
    const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(install.status, 0, String(install.stderr))
    const table = join(target, 'scripts/harness/run-gates.ts')
    const mine = `${readFileSync(table, 'utf8')}\n// this repository runs three gates\n`
    writeFileSync(table, mine)
    const stale = join(target, 'scripts/harness/verify-md-wrap.ts')
    writeFileSync(stale, '// stale copy\n')

    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
    assert.equal(result.status, 0, String(result.stderr))
    assert.equal(readFileSync(table, 'utf8'), mine, '--force reverted the gate table')
    assert.equal(
      readFileSync(stale, 'utf8'),
      readFileSync(join(SKILL_ROOT, 'scripts/verify-md-wrap.ts'), 'utf8'),
      'the guard must not stop the other copies from refreshing',
    )
    assert.match(result.stdout ?? '', /gate table/)
  })

  test('an unedited gate table refreshes without a preservation note', () => {
    // The guard keys on a real difference from the shipped bytes, so a table nobody
    // touched upgrades with the rest and says nothing.
    const target = tracked()
    const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(install.status, 0, String(install.stderr))

    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force'], { encoding: 'utf8' })
    assert.equal(result.status, 0, String(result.stderr))
    assert.doesNotMatch(result.stdout ?? '', /gate table/)
    assert.equal(
      readFileSync(join(target, 'scripts/harness/run-gates.ts'), 'utf8'),
      readFileSync(join(SKILL_ROOT, 'scripts/run-gates.ts'), 'utf8'),
    )
  })

  test('--reset-manifests is what restores the shipped table', () => {
    const target = tracked()
    const install = spawnSync(process.execPath, [BOOTSTRAP, '--target', target], { encoding: 'utf8' })
    assert.equal(install.status, 0, String(install.stderr))
    const table = join(target, 'scripts/harness/run-gates.ts')
    writeFileSync(table, '// mine\n')

    const result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--force', '--reset-manifests'], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, String(result.stderr))
    assert.equal(readFileSync(table, 'utf8'), readFileSync(join(SKILL_ROOT, 'scripts/run-gates.ts'), 'utf8'))
  })
})

describe('re-seeding with --reset-manifests', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = usedInstallation()
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--reset-manifests'], { encoding: 'utf8' })
  })

  test('rebuilds the manifests from the repository it finds now', () => {
    const seeded = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(target, 'scripts/harness', name), 'utf8')) as Record<string, unknown>
    assert.equal(result.status, 0, String(result.stderr))
    assert.deepEqual(seeded('doc-index.manifest.json'), {})
    assert.deepEqual(seeded('doc-claims.manifest.json'), {})
    assert.deepEqual(seeded('test-hygiene.manifest.json'), {})
    assert.deepEqual(seeded('skill-catalog.manifest.json'), {})
    const comments = seeded('comment-hygiene.manifest.json')
    assert.deepEqual(comments.scan, ['scripts'])
    assert.equal((comments.labels as unknown[]).length, 4)
    const budgets = seeded('doc-budgets.manifest.json')
    assert.equal(budgets.__mine__, undefined)
    assert.equal(typeof budgets['AGENTS.md'], 'number')
  })

  test('is all it does: the adopter’s own edits survive', () => {
    // Re-seeding the copy is a separate decision, so this flag must not make it.
    assert.equal(readFileSync(join(target, 'scripts/harness/verify-md-wrap.ts'), 'utf8'), '// locally customised\n')
    assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), '# Mine\n')
  })
})

describe('--dry-run', () => {
  test('writes nothing, and promises exactly what a real run creates', () => {
    const dryTarget = tracked()
    const realTarget = tracked()
    const dry = spawnSync(process.execPath, [BOOTSTRAP, '--target', dryTarget, '--dry-run'], { encoding: 'utf8' })
    assert.equal(dry.status, 0, String(dry.stderr))
    // Not the tree, not the verifiers, not the version record.
    assert.deepEqual(readdirSync(dryTarget), [])
    assert.match(dry.stdout ?? '', /would create/)

    const real = spawnSync(process.execPath, [BOOTSTRAP, '--target', realTarget], { encoding: 'utf8' })
    assert.equal(real.status, 0, String(real.stderr))
    const planOf = (stdout: string): string[] => (stdout.match(/^ {2}\+ (.+)$/gm) ?? []).map(line => line.slice(4))
    assert.deepEqual(planOf(dry.stdout ?? ''), planOf(real.stdout ?? ''))
    for (const path of planOf(dry.stdout ?? '')) {
      assert.ok(existsSync(join(realTarget, path)), `${path} was promised but the real run did not create it`)
    }
  })
})

describe('adopting a repository that already has violations', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    mkdirSync(join(target, 'docs'), { recursive: true })
    writeFileSync(join(target, 'README.md'), '# Existing\n\nSee [gone](docs/GONE.md).\n\nA wrapped\nparagraph.\n')
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--adopt'], { encoding: 'utf8' })
  })

  test('records the pre-existing debt and says so', () => {
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /adopted: markdown-links: recorded 1 existing violation/)
    assert.match(result.stdout ?? '', /adopted: markdown-wrap: recorded 1 existing violation/)
  })

  test('the gates pass on history alone', () => {
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    assert.match(`${run.stdout ?? ''}${run.stderr ?? ''}`, /11 passed, 0 failed, 0 skipped/)
  })

  test('but a newly broken link still fails', () => {
    writeFileSync(join(target, 'docs', 'new.md'), '# New\n\n[broken](nope.md)\n')
    const run = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], {
      cwd: target,
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    assert.match(`${run.stdout ?? ''}${run.stderr ?? ''}`, /docs\/new\.md:3/)
  })
})

describe('adopting a repository whose comments already carry history', () => {
  let target: string
  let result: ReturnType<typeof spawnSync>

  before(() => {
    target = tracked()
    mkdirSync(join(target, 'src'), { recursive: true })
    writeFileSync(join(target, 'src/app.ts'), 'export const a = 1 // 2026-10-13: switched the writer\n')
    result = spawnSync(process.execPath, [BOOTSTRAP, '--target', target, '--adopt'], { encoding: 'utf8' })
  })

  test('records the existing comment hits as debt, without failing the gate', () => {
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout ?? '', /adopted: comment-hygiene: recorded 1 existing violation/)
    assert.match(result.stdout ?? '', /comment-hygiene scans scripts, src for the starter shapes/)
  })

  test('passes on history alone, and still fails on a comment added later', () => {
    const before = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], { cwd: target, encoding: 'utf8' })
    assert.match(`${before.stdout ?? ''}${before.stderr ?? ''}`, /11 passed, 0 failed, 0 skipped/)

    writeFileSync(join(target, 'src/app.ts'), 'export const a = 1 // 2026-10-13: switched the writer\nexport const b = 2 // 第 2 轮: retry budget\n')
    const after = spawnSync(process.execPath, [join(target, 'scripts/harness/run-gates.ts'), 'doc-quick'], { cwd: target, encoding: 'utf8' })
    assert.equal(after.status, 1)
    assert.match(`${after.stdout ?? ''}${after.stderr ?? ''}`, /轮次 matches "第 2 轮"/)
  })
})

describe('an incomplete skill copy', () => {
  test('refuses to bootstrap when a verifier is missing', () => {
    // The copied run-gates.ts calls every verifier, so a copy missing one would hand
    // the target gates that die on MODULE_NOT_FOUND.
    const isolated = tracked()
    cpSync(SKILL_ROOT, join(isolated, 'skill'), { recursive: true })
    rmSync(join(isolated, 'skill/scripts/aliases.ts'))
    const target = tracked()
    const run = spawnSync(process.execPath, [join(isolated, 'skill/scripts/bootstrap.ts'), '--target', target], {
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    // The guard's own message, start to finish. Asserting only the first line let a
    // template-literal syntax error in the closing lines masquerade as this refusal.
    assert.match(run.stderr ?? '', /this skill copy is incomplete/)
    assert.match(run.stderr ?? '', /aliases\.ts not found/)
    assert.match(run.stderr ?? '', /Re-copy the whole skill directory/)
    assert.doesNotMatch(run.stderr ?? '', /ReferenceError|is not defined|SyntaxError/)
    // It must refuse before creating anything, not after.
    assert.equal(existsSync(join(target, 'scripts/harness/run-gates.ts')), false)
  })
})
