/**
 * Scaffold the governance skeleton in a target repository: the Agent Note lifecycle
 * tree, an empty frozen-archive manifest, a doc-budget manifest measured from the
 * target's real files, and a copy of the bundled verifiers.
 *
 * Verifiers are COPIED, never referenced: a gate must run in a fresh clone and in CI
 * without this skill installed. Re-run with `--force` to refresh the copies after
 * upgrading the harness. Refreshing stops at the copies: every manifest carries the
 * adopter's own declarations, the starter documents are written once and never
 * re-created, and the sealed archive's files are left as the repository froze them —
 * re-seeding a declaration takes the separate `--reset-manifests`, never a side
 * effect of an upgrade.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASELINE_REL } from './baseline.ts'
import { countDocWords } from './doc-words.ts'
// Type-only: stripped at run time, so the single-skill layout — which carries the
// aliases beside this script, with no sibling directory to resolve — never loads this
// path. Turning it into a runtime import would break that layout.
import type { ClassSlot, LifecycleSlot, Locale } from './aliases.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(SCRIPT_DIR, '..')
const HARNESS_DIR = 'scripts/harness'

/**
 * The one copied file that carries the adopter's own declaration — its list of gates.
 * Every other verifier is refreshed wholesale by `--force`; this one is preserved once
 * edited, because a check that the repository chose to run must not disappear as a
 * side effect of an upgrade.
 */
const GATE_TABLE = 'run-gates.ts'

/** The bundle version file, inside this skill's directory so a single-copy install carries it. */
const VERSION_FILE = join(SKILL_ROOT, 'VERSION')

/**
 * The version of the bundle these verifiers were copied from. A copy without the
 * version file still installs — the gates do not depend on it — but the record then
 * says `unknown`, which is the honest answer to "what did we install".
 */
function bundleVersion(): string {
  try {
    return readFileSync(VERSION_FILE, 'utf8').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Gates that can record day-one debt. Adopting the harness on a repository that
 * already has violations records them in the ledger, so the gate blocks the next
 * violation instead of failing on all the old ones.
 */
const BASELINE_GATES: ReadonlyArray<readonly [gate: string, file: string]> = [
  ['markdown-links', 'verify-md-links.ts'],
  ['markdown-wrap', 'verify-md-wrap.ts'],
  ['comment-hygiene', 'verify-comment-hygiene.ts'],
  ['test-hygiene', 'verify-test-hygiene.ts'],
]

/**
 * Verifier files copied into the target repository, all read from this skill's own
 * `scripts/` directory. The copied `run-gates.ts` invokes every one of them, so a
 * missing file does not degrade gracefully — it produces a repository whose gates die
 * with MODULE_NOT_FOUND. The precondition is therefore checked up front and reported
 * as an error, never skipped.
 */
const VERIFIER_FILES: readonly string[] = [
  // Shared by every gate.
  'harness-root.ts',
  // The shared scanners the text gates import.
  'surface.ts',
  'markdown.ts',
  // The word-counting rule the budget gate and this script's seed both measure in.
  'doc-words.ts',
  // The debt ledger every baseline-aware gate records into.
  'baseline.ts',
  // The Agent Note corpus gates.
  'aliases.ts',
  'harness-config.ts',
  'agent-note-tree.ts',
  'pair-record.ts',
  'archived-agent-notes.ts',
  'verify-agent-note-format.ts',
  'verify-agent-note-classification.ts',
  'verify-archived-agent-notes.ts',
  // The repository-wide gates.
  'verify-comment-hygiene.ts',
  'verify-doc-budgets.ts',
  'verify-doc-claims.ts',
  'verify-doc-index.ts',
  'verify-md-links.ts',
  'verify-md-wrap.ts',
  'verify-skill-catalog.ts',
  'verify-test-hygiene.ts',
  'run-gates.ts',
]

/**
 * Directories the comment-hygiene seed scans, measured from the target's own tree.
 * `scripts/` is first because the verifiers were just copied into it and a toolchain is
 * narrative surface too; a source tree joins the list only when it exists, so the seed
 * never declares a scan root the fail-closed gate would report as missing.
 */
const COMMENT_SCAN_CANDIDATES = ['scripts', 'src', 'app', 'lib']

/**
 * Starter comment rules: shapes that are chronology in any repository, so the gate has
 * a real first day instead of an empty shell. Shapes are extended by the adopter;
 * exceptions are how a real technical term colliding with one of them is admitted.
 */
const COMMENT_HYGIENE_STARTER = {
  labels: [
    { name: '日期戳', pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { name: '年月戳', pattern: '\\d{4}\\s*年\\s*\\d{1,2}\\s*月' },
    { name: '轮次', pattern: '第\\s*(?:\\d{1,3}|[一二三四五六七八九十百]{1,3})\\s*轮' },
    { name: '批次括注', pattern: '[（(]\\s*批\\s*\\d{1,3}' },
  ],
  residue: [
    { name: '括注被切空', pattern: '（\\s*）' },
    { name: '括注只剩破折号', pattern: '（\\s*[-—–]+\\s*）' },
  ],
}

/**
 * Directories a repository conventionally keeps its tests in, for the test-hygiene
 * seed. A source tree is not among them: a repository whose tests sit next to the code
 * declares that root itself, and the seed does not guess it.
 */
const TEST_SCAN_CANDIDATES = ['test', 'tests', '__tests__']

/** Standing docs the budget manifest measures on first run. */
const BUDGET_CANDIDATES = ['AGENTS.md', 'docs/AGENTS.md', 'README.md', 'docs/architecture.md']

/** Headroom added above the current measurement when seeding a ceiling. */
const BUDGET_HEADROOM = 1.15

/**
 * The Agent Note tree's language-driven names, loaded at run time from the aliases
 * table beside this script. A static import would fail before this script's own
 * completeness check could explain the problem.
 */
interface NoteTreeNames {
  LIFECYCLE_SLOTS: readonly LifecycleSlot[]
  CLASS_SLOTS: readonly ClassSlot[]
  lifecycleDir: (slot: LifecycleSlot, locale: Locale) => string
  classDir: (slot: ClassSlot, locale: Locale) => string
  archiveDir: (locale: Locale) => string
}

async function loadNoteTreeNames(): Promise<NoteTreeNames> {
  return await import(pathToFileURL(join(SCRIPT_DIR, 'aliases.ts')).href) as unknown as NoteTreeNames
}

/** The archive's own instruction file, required by the archive gate; its path follows the corpus language. */
const archivedAgentsPath = (locale: Locale, archive: string): string => `.agents/notes/${archive}/AGENTS.md`

/** Notes-tree configuration: the corpus's primary language and paired-document mode. */
const NOTES_CONFIG = '.agents/notes/harness.json'

/** What the archive gate requires at its root. Sealed artifacts are immutable. */
const ARCHIVED_AGENTS_CONTENT: Record<Locale, string> = {
  en: `# Archived Agent Notes

Sealed decision records. Every artifact here is frozen: never edit, reformat, translate, repair, move, or delete one. \`manifest.json\` records a content hash per file and is append-only, so any change to sealed bytes is rejected by \`scripts/harness/verify-archived-agent-notes.ts\`.

Archiving a note is the only way files appear here:

1. Move the complete artifact set from \`implemented/<class>/\`.
2. Insert an identical \`Archived: YYYY-MM-DD\` line directly below \`Status: implemented\` in every language file.
3. Re-record any paired-content hashes.
4. Repair or remove inbound links.
5. Seal with \`node scripts/harness/verify-archived-agent-notes.ts --write\`.

Archive links are checked inbound only: links pointing into this tree are validated, but links this tree makes to the outside are not, because they may be stale by design.
`,
  zh: `# 归档决策记录

封存的决策记录。此处的每一件都已冻结：永不编辑、重排、翻译、修复、移动或删除。\`manifest.json\` 逐条记录内容哈希且只增不改——对已封存字节的任何改动都会被 \`scripts/harness/verify-archived-agent-notes.ts\` 拒绝。

归档是文件进入此树的唯一途径：

1. 从 \`已实施/<类>/\` 移动完整的三件套。
2. 在每个语言文件的 \`Status: implemented\` 行正下方插入一行相同的 \`Archived: YYYY-MM-DD\`。
3. 重录任何配对内容哈希。
4. 修理或删除指向它的入站链接。
5. 用 \`node scripts/harness/verify-archived-agent-notes.ts --write\` 封存。

归档树的链接只查入站：指向本树的链接会被校验，本树发出的链接不查——它们按设计可能已经过时。
`,
}

interface Options {
  target: string
  dryRun: boolean
  /** Refresh the copied verifiers. Never touches the manifests that hold declarations. */
  force: boolean
  /** Re-seed the manifests even where they already exist — destructive, so its own flag. */
  resetManifests: boolean
  adopt: boolean
  /** Language of a fresh Agent Note corpus; ignored once the target declares its own. */
  notesLanguage?: Locale
}

function usage(): never {
  console.error('usage: node bootstrap.ts --target <repo> [--adopt] [--notes-language en|zh] [--dry-run] [--force] [--reset-manifests]')
  console.error('  --adopt            record the violations already in the target as accepted debt,')
  console.error('                     so the Markdown gates fail only on violations added from now on')
  console.error('  --notes-language   the working language of a fresh scaffold (default en): it spells')
  console.error('                     the lifecycle folders, the class folders, the archive container, and')
  console.error('                     .agents/notes/harness.json together, and picks the starter templates')
  console.error('                     (AGENTS, docs/AGENTS, lefthook) written in that language')
  console.error('  --force            refresh the copied verifiers; declarations are preserved —')
  console.error('                     the manifests, and a gate table the target has edited')
  console.error('  --reset-manifests  re-seed the manifests and the gate table even where they exist,')
  console.error('                     replacing the declarations in them')
  process.exit(1)
}

function parseArgs(argv: readonly string[]): Options {
  let target: string | undefined
  let dryRun = false
  let force = false
  let resetManifests = false
  let adopt = false
  let notesLanguage: Locale | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target') {
      index += 1
      target = argv[index]
      if (target === undefined) usage()
    } else if (arg === '--notes-language') {
      index += 1
      const value = argv[index]
      if (value !== 'en' && value !== 'zh') {
        console.error(`bootstrap: --notes-language must be en or zh (got ${JSON.stringify(value ?? '')})`)
        usage()
      }
      notesLanguage = value
    } else if (arg === '--dry-run') dryRun = true
    else if (arg === '--force') force = true
    else if (arg === '--reset-manifests') resetManifests = true
    else if (arg === '--adopt') adopt = true
    else usage()
  }
  if (target === undefined) usage()
  return { target: resolve(target), dryRun, force, resetManifests, adopt, notesLanguage }
}

/**
 * The corpus language for this run: the target's own declaration when it has one, else
 * the flag, else the upstream default. A flag that contradicts an existing declaration
 * is refused — changing a corpus's language moves its whole tree, so it is its own act,
 * never a side effect of a re-run.
 */
function resolveNotesLanguage(options: Options): Locale {
  const configPath = join(options.target, NOTES_CONFIG)
  if (!existsSync(configPath)) return options.notesLanguage ?? 'en'
  let declared: unknown
  try {
    declared = (JSON.parse(readFileSync(configPath, 'utf8')) as { primaryLanguage?: unknown }).primaryLanguage
  } catch {
    console.error(`bootstrap: ${NOTES_CONFIG} is not valid JSON; fix or remove it before bootstrapping`)
    process.exit(1)
  }
  if (declared !== 'en' && declared !== 'zh') {
    console.error(`bootstrap: ${NOTES_CONFIG} declares primaryLanguage ${JSON.stringify(declared ?? '')}; expected en or zh`)
    process.exit(1)
  }
  if (options.notesLanguage !== undefined && options.notesLanguage !== declared) {
    console.error(`bootstrap: --notes-language ${options.notesLanguage} contradicts ${NOTES_CONFIG} (declared ${declared}).`)
    console.error('Changing a corpus\'s language means moving its whole tree — every lifecycle folder,')
    console.error('class folder, and archive container. Do that as its own change, or pass the declared language.')
    process.exit(1)
  }
  return declared
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.target) || !statSync(options.target).isDirectory()) {
    console.error(`bootstrap: target ${JSON.stringify(options.target)} is not a directory`)
    process.exit(1)
  }

  // The verifiers are a precondition, not a nice-to-have: the copied `run-gates.ts`
  // runs all of them, so a target built without them has gates that cannot start. A
  // copy missing one is therefore a mistake worth failing on, not a configuration
  // worth supporting.
  const missingVerifiers = VERIFIER_FILES.filter(file => !existsSync(join(SCRIPT_DIR, file)))
  if (missingVerifiers.length > 0) {
    console.error(`bootstrap: this skill copy is incomplete (expected the verifiers in ${SCRIPT_DIR}):`)
    for (const file of missingVerifiers) console.error(`  ${file} not found`)
    console.error(`
Refusing to continue: run-gates.ts calls every one of these, so the target would end up
with gates that die on MODULE_NOT_FOUND. Re-copy the whole skill directory
(${SKILL_ROOT}) from its source repository and run again.`)
    process.exit(1)
  }

  // The corpus language spells the whole Agent Note tree, so the scaffold and the
  // declaration are written together from one resolution.
  const notesLanguage = resolveNotesLanguage(options)
  const names = await loadNoteTreeNames()
  const archive = names.archiveDir(notesLanguage)
  const archiveRootRel = `.agents/notes/${archive}`

  // Whether the harness was already installed when this run started, read before any
  // write. It separates the first scaffold, which writes the starter documents, from an
  // upgrade, which must not: a destination missing on an upgrade was deleted on
  // purpose, and re-creating it would revert that decision as a refresh's side effect.
  const installedBefore = existsSync(join(options.target, HARNESS_DIR, GATE_TABLE))

  const planned: string[] = []
  const skipped: string[] = []
  const notes: string[] = []

  const write = (relPath: string, content: string | Buffer, overwrite = false): void => {
    const abs = join(options.target, relPath)
    if (existsSync(abs) && !options.force && !overwrite) {
      skipped.push(relPath)
      return
    }
    planned.push(relPath)
    if (options.dryRun) return
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  // 1. Agent Note lifecycle tree with a placeholder per lifecycle/class folder, named
  // in the corpus language (提案中/已实施/已否决 × 功能/缺陷修复/… when it is zh).
  for (const lifecycle of names.LIFECYCLE_SLOTS) {
    for (const cls of names.CLASS_SLOTS) {
      const keep = join('.agents/notes', names.lifecycleDir(lifecycle, notesLanguage), names.classDir(cls, notesLanguage), '.gitkeep')
      const abs = join(options.target, keep)
      if (existsSync(abs)) continue
      planned.push(keep)
      if (!options.dryRun) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, '')
      }
    }
  }

  // 2. Archive tree: all six class directories are required by the gate, even empty.
  for (const cls of names.CLASS_SLOTS) {
    const keep = join(archiveRootRel, names.classDir(cls, notesLanguage), '.gitkeep')
    const abs = join(options.target, keep)
    if (existsSync(abs)) continue
    planned.push(keep)
    if (!options.dryRun) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, '')
    }
  }
  // The archive's instruction file is sealed with the tree it describes: written once
  // on the first scaffold, then the repository's own bytes. Re-writing it would revert
  // an adaptation as an upgrade's side effect — and silently touch a tree whose gate
  // rejects changed bytes.
  const archivedAgentsRel = archivedAgentsPath(notesLanguage, archive)
  if (!existsSync(join(options.target, archivedAgentsRel))) {
    write(archivedAgentsRel, ARCHIVED_AGENTS_CONTENT[notesLanguage])
  } else {
    skipped.push(archivedAgentsRel)
  }
  const manifestRel = `${archiveRootRel}/manifest.json`
  if (!existsSync(join(options.target, manifestRel))) {
    write(manifestRel, '{\n  "version": 1,\n  "files": {}\n}\n')
  } else {
    skipped.push(manifestRel)
  }
  // The declared language carries the whole corpus: notes are written in it, and it
  // spells the tree. Pairing stays off until a repository asks for counterparts.
  if (!existsSync(join(options.target, NOTES_CONFIG))) {
    write(NOTES_CONFIG, `{\n  "primaryLanguage": "${notesLanguage}",\n  "pairedDocuments": false\n}\n`)
  } else {
    skipped.push(NOTES_CONFIG)
  }

  // 3. Copy the verifiers so gates run in a fresh clone with no skill installed, and
  // record the bundle version they came from alongside them.
  for (const file of VERIFIER_FILES) {
    const source = join(SCRIPT_DIR, file)
    const rel = join(HARNESS_DIR, file)
    const abs = join(options.target, rel)
    if (existsSync(abs) && !options.force) {
      skipped.push(rel)
      continue
    }
    // The gate table declares which checks THIS repository runs, so refreshing it
    // would revert that decision the moment an upgrade runs — the same quiet narrowing
    // the manifests are protected from. An unmodified copy still upgrades with the
    // rest; replacing an edited one takes the explicit --reset-manifests.
    if (
      file === GATE_TABLE &&
      existsSync(abs) &&
      !options.resetManifests &&
      readFileSync(abs, 'utf8') !== readFileSync(source, 'utf8')
    ) {
      skipped.push(rel)
      notes.push(`${GATE_TABLE} holds this repository's gate table and was preserved (--reset-manifests restores the shipped table)`)
      continue
    }
    planned.push(rel)
    if (!options.dryRun) {
      mkdirSync(dirname(abs), { recursive: true })
      cpSync(source, abs)
    }
  }

  // The version record is installer metadata, not an adopter declaration: it is
  // rewritten whenever its content changes, so it always answers which bundle is
  // installed. Reported only when it changes, so a re-run stays quiet.
  const version = bundleVersion()
  const versionRecord = join(HARNESS_DIR, 'version.json')
  const versionContent = `${JSON.stringify({ version }, null, 2)}\n`
  const versionAbs = join(options.target, versionRecord)
  if (!existsSync(versionAbs) || readFileSync(versionAbs, 'utf8') !== versionContent) {
    planned.push(versionRecord)
    if (!options.dryRun) {
      mkdirSync(dirname(versionAbs), { recursive: true })
      writeFileSync(versionAbs, versionContent)
    }
  }

  // 4. Seed the doc-budget manifest from the target's measured word counts.
  //
  // This runs BEFORE the templates are copied, on purpose: measuring a freshly copied
  // skeleton would set a ceiling that the first real paragraph blows through, and "a
  // too-low ceiling is a budget bug". A repository whose only standing docs are the
  // templates therefore starts with an empty manifest and seeds it on a later run.
  const budgetPath = join(options.target, HARNESS_DIR, 'doc-budgets.manifest.json')
  if (existsSync(budgetPath) && !options.resetManifests) {
    skipped.push(relative(options.target, budgetPath))
  } else {
    const budgets: Record<string, number> = {}
    for (const candidate of BUDGET_CANDIDATES) {
      const abs = join(options.target, candidate)
      if (!existsSync(abs)) continue
      const words = countDocWords(readFileSync(abs, 'utf8'))
      budgets[candidate] = Math.ceil(words * BUDGET_HEADROOM)
    }
    if (Object.keys(budgets).length === 0) {
      notes.push(`no standing documents to measure yet (${BUDGET_CANDIDATES.join(', ')}); the budget manifest starts empty`)
      notes.push('once AGENTS.md and the other standing docs have real content, re-run bootstrap to seed their ceilings')
    }
    write(join(HARNESS_DIR, 'doc-budgets.manifest.json'), `${JSON.stringify(budgets, null, 2)}\n`, options.resetManifests)
  }

  // 5. Seed the document-chain manifest empty. `{}` declares no chain, so the index
  // gate passes until this repository writes an index and declares its slots; the
  // gate's "no manifest" error then stays reserved for a repository that deleted it.
  const docIndexPath = join(options.target, HARNESS_DIR, 'doc-index.manifest.json')
  if (existsSync(docIndexPath) && !options.resetManifests) {
    skipped.push(relative(options.target, docIndexPath))
  } else {
    write(join(HARNESS_DIR, 'doc-index.manifest.json'), '{}\n', options.resetManifests)
    // Named by absolute path: these templates live in the skill, not in the target,
    // so a relative-looking path would send the reader looking for a file that is not
    // there. They are deliberately not copied — the chain slots are a judgement call.
    notes.push(`doc-index.manifest.json declares no chain yet; when this repository keeps an indexed document chain, start it from ${join(SKILL_ROOT, 'templates')} (ledger.${notesLanguage}.md, docs-index.${notesLanguage}.md) — the language tier names the template's language, not a counterpart`)
  }

  // 6. Seed the comment rules against the target's own tree. Which candidate roots
  // exist is measured rather than guessed: the gate fails closed on a declared root
  // that is missing, so the seed never writes one.
  const commentPath = join(options.target, HARNESS_DIR, 'comment-hygiene.manifest.json')
  if (existsSync(commentPath) && !options.resetManifests) {
    skipped.push(relative(options.target, commentPath))
  } else {
    const scan = COMMENT_SCAN_CANDIDATES.filter(candidate => existsSync(join(options.target, candidate)))
    write(join(HARNESS_DIR, 'comment-hygiene.manifest.json'), `${JSON.stringify({ scan, ...COMMENT_HYGIENE_STARTER }, null, 2)}\n`, options.resetManifests)
    notes.push(`comment-hygiene scans ${scan.join(', ')} for the starter shapes; add a root to the manifest when code lands elsewhere, and register a real term that collides with a shape as an exception`)
  }

  // 7. Seed the test surface from the directories the target actually keeps tests in.
  // With none of them present, `{}` declares no test surface: the gate's fail-closed
  // "scanned nothing" rule must never fire on a repository that has no tests yet.
  const testPath = join(options.target, HARNESS_DIR, 'test-hygiene.manifest.json')
  if (existsSync(testPath) && !options.resetManifests) {
    skipped.push(relative(options.target, testPath))
  } else {
    const scan = TEST_SCAN_CANDIDATES.filter(candidate => existsSync(join(options.target, candidate)))
    if (scan.length === 0) {
      write(join(HARNESS_DIR, 'test-hygiene.manifest.json'), '{}\n', options.resetManifests)
      notes.push(`no test directory found (${TEST_SCAN_CANDIDATES.join(', ')}); the test-hygiene manifest starts empty — declare the root when tests land, including a source tree if tests sit next to the code`)
    } else {
      write(join(HARNESS_DIR, 'test-hygiene.manifest.json'), `${JSON.stringify({ scan }, null, 2)}\n`, options.resetManifests)
      notes.push(`test-hygiene scans ${scan.join(', ')} for focused runs and titled skips`)
    }
  }

  // 8. Seed the claim manifest empty. No claim can be inferred from a tree: which
  // numbers a document states, and which command decides them, is the adopter's
  // judgement. `{}` declares none, so the gate stays quiet until that judgement lands.
  const claimsPath = join(options.target, HARNESS_DIR, 'doc-claims.manifest.json')
  if (existsSync(claimsPath) && !options.resetManifests) {
    skipped.push(relative(options.target, claimsPath))
  } else {
    write(join(HARNESS_DIR, 'doc-claims.manifest.json'), '{}\n', options.resetManifests)
    notes.push('doc-claims.manifest.json declares no claims yet; when a document states a number or a list a command can measure (how many gates, which directories), declare the claim so a stale copy fails the gate')
  }

  // 9. Seed the skill-catalog manifest empty. `{}` declares no skill roots, so the gate
  // stays quiet in a repository that ships no skills; a repository that keeps skills of
  // its own declares their root and gets the name and description checks.
  const catalogPath = join(options.target, HARNESS_DIR, 'skill-catalog.manifest.json')
  if (existsSync(catalogPath) && !options.resetManifests) {
    skipped.push(relative(options.target, catalogPath))
  } else {
    write(join(HARNESS_DIR, 'skill-catalog.manifest.json'), '{}\n', options.resetManifests)
    notes.push('skill-catalog.manifest.json declares no skill roots yet; after installing skills into .agents/skills, add that directory to `roots` so the gate checks their names and description budgets')
  }

  // 10. Write the starter templates on the first scaffold only. The starters are
  // language-paired, and the same resolution that spells the notes tree picks them:
  // the standing orders an adopter reads are written in the repository's working
  // language, never in the skill author's. A template for a language the bundle does
  // not carry is left uncopied and reported, not silently substituted. Once the
  // harness is installed the repository owns these files — a destination missing on
  // an upgrade was deleted on purpose, so it is reported instead of re-created, with
  // the starter still available in this skill for whoever wants it back.
  for (const [template, destination] of [
    [`AGENTS.${notesLanguage}.md`, 'AGENTS.md'],
    [`lefthook.${notesLanguage}.yml`, 'lefthook.yml'],
    [`docs-AGENTS.${notesLanguage}.md`, 'docs/AGENTS.md'],
  ] as const) {
    const source = join(SKILL_ROOT, 'templates', template)
    if (!existsSync(source)) {
      notes.push(`no ${template} in this bundle; write ${destination} yourself (the other language's starter is in ${join(SKILL_ROOT, 'templates')})`)
      continue
    }
    const abs = join(options.target, destination)
    if (existsSync(abs)) {
      skipped.push(destination)
      continue
    }
    if (installedBefore) {
      notes.push(`${destination} is missing; starter documents are written only on the first scaffold, so a deleted one stays deleted — take ${join(SKILL_ROOT, 'templates', template)} if it should come back`)
      continue
    }
    planned.push(destination)
    if (!options.dryRun) {
      mkdirSync(dirname(abs), { recursive: true })
      cpSync(source, abs)
    }
  }

  // 11. Adoption: record the debt that predates the harness. Without this an existing
  // repository goes red on its own history, and a gate that is red on day one gets
  // switched off on day two. The ledger is the difference between "this repository is
  // dirty" and "this change made it dirtier".
  const adopted: string[] = []
  if (options.adopt) {
    for (const [gate, file] of BASELINE_GATES) {
      const script = join(options.target, HARNESS_DIR, file)
      if (options.dryRun) {
        notes.push(`--adopt would record the target's current ${gate} violations in ${BASELINE_REL}`)
        continue
      }
      if (!existsSync(script)) {
        notes.push(`--adopt skipped ${gate}: ${join(HARNESS_DIR, file)} was not copied`)
        continue
      }
      const run = spawnSync(process.execPath, [script, '--root', options.target, '--write-baseline'], {
        cwd: options.target,
        encoding: 'utf8',
      })
      const line = (run.stdout ?? '').split('\n').find(text => text.includes('recorded'))
      if (line !== undefined) adopted.push(line.trim())
      // Exit 0 with nothing recorded means the gate found no debt to record — an empty
      // or disabled manifest, not a failure worth a note. A non-zero exit is.
      else if (run.status !== 0) notes.push(`--adopt: ${gate} did not record (exit ${String(run.status)}): ${(run.stderr ?? '').trim().split('\n')[0] ?? ''}`)
    }
  } else if (existsSync(join(options.target, 'README.md'))) {
    notes.push(`this target already has documents; re-run with --adopt to record its existing violations as debt instead of failing on them`)
  }

  const verb = options.dryRun ? 'would create' : 'created'
  console.log(`harness bootstrap: v${version}, ${planned.length} path(s) ${verb} in ${options.target}`)
  for (const path of planned) console.log(`  + ${path}`)
  if (skipped.length > 0) {
    const hint = options.force ? '' : ' (pass --force to refresh the copied verifiers)'
    console.log(`preserved ${skipped.length} existing path(s)${hint}:`)
    for (const path of skipped) console.log(`  = ${path}`)
  }
  if (options.force && !options.resetManifests) {
    notes.push('--force refreshed the copied verifiers only; the manifests holding your declarations were preserved (--reset-manifests re-seeds them)')
  }
  if (options.force) {
    notes.push("an upgrade can change what a gate accepts, not just its code: re-check any document that states a gate's behavior or explains why one is not wired — that statement is a copy of behavior, and a copy does not update itself")
  }
  for (const line of adopted) console.log(`adopted: ${line}`)
  for (const note of notes) console.log(`note: ${note}`)

  console.log(`
Next steps that need your judgment (the harness cannot infer these):
  1. Write AGENTS.md: standing orders only, one to three lines per rule.
  2. Pick the checks this repository must run, then list them in scripts/harness/run-gates.ts.
     The table ships \`text\` (every text-surface gate — wire it into CI as \`npm run check\`),
     \`doc-quick\` (text plus the note gates) and \`check-all\` (the full run: add your build,
     test and platform gates here). The commands in the copied AGENTS.md only hold as long
     as these modes exist.
  3. Add a package.json script per gate so editors and CI share one entry point.
  4. Install the git hooks (lefthook.yml) and wire the same gates into CI.
  5. To require the archive gate, seal the tree with:
       node ${HARNESS_DIR}/verify-archived-agent-notes.ts --write
  6. If this repository keeps an indexed document chain (an index document, slot
     directories, a ledger of open items), start it from ${join(SKILL_ROOT, 'templates', `ledger.${notesLanguage}.md`)}
     and ${join(SKILL_ROOT, 'templates', `docs-index.${notesLanguage}.md`)}, then declare the slots in
     ${HARNESS_DIR}/doc-index.manifest.json.
  7. When a document states a number or a list a command can measure (how many gates
     run, which directories exist), declare it in ${HARNESS_DIR}/doc-claims.manifest.json
     — a stated number is a copy, and this is what keeps it from drifting.${options.adopt ? `

The ledger shows what was adopted. Pay it down deliberately: fix a batch, then
re-record with \`--write-baseline\` so the file visibly shrinks. Each entry left in
${BASELINE_REL} is a violation the gates will not stop from spreading.` : ''}`)
}

await main()
