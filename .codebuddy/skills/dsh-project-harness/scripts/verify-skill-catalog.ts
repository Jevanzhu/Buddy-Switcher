/**
 * Skill catalog readiness: what a client reads out of a skill before it decides to load
 * one. A client copies each skill's `name` and `description` into the session catalog; a
 * description longer than the catalog budget is truncated, so the trigger words at its
 * tail never reach the model and the skill stops being routed to. A name that is not
 * kebab-case, a name that disagrees with its directory, or a frontmatter missing either
 * field is skipped by the loader with only a warning. Every one of those failures is
 * silent from the repository's side — the skill is installed, a directory lists it, and
 * nothing reports it — so the properties are a gate rather than a convention.
 *
 * The rules live here; which directories hold skills, and how long a description may be,
 * are repository data (`scripts/harness/skill-catalog.manifest.json`). `{}` declares no
 * skill roots and passes, so a repository that ships no skills is not blocked by the
 * gate's absence of data. Two layouts are scanned under each declared root:
 * `<root>/<name>/SKILL.md` (a directory package) and `<root>/<name>.md` (a flat
 * document).
 *
 * Frontmatter is read line by line rather than by a YAML parser: this bundle is pure
 * Node, zero dependencies, on purpose. The approximation keeps the two keys this gate
 * decides — `name` and `description`, the latter as a plain scalar or a folded (`>-`)
 * or literal (`|`) block scalar — and joins a block's indented lines into one
 * whitespace-normalized value. Nested structures, anchors, quoted scalars, and multiple
 * documents are not interpreted; a plain scalar continued on indented lines is measured
 * from its first line, a repeated key keeps its first value, quotes in a plain scalar
 * count as characters, and a block's line breaks fold to spaces because the measured
 * form collapses whitespace anyway. A file the approximation cannot read is reported
 * rather than passed.
 *
 *   node scripts/harness/verify-skill-catalog.ts [--root <path>] [--list]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'

const MANIFEST_REL = 'scripts/harness/skill-catalog.manifest.json'

/** The client's default truncation length: a longer description loses its tail. */
export const DEFAULT_MAX_DESCRIPTION = 500

/** The name shape a client requires: lowercase words joined by single hyphens. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A top-level frontmatter key. Continuation lines are indented and never match. */
const FIELD_LINE = /^([A-Za-z0-9_-]+):(.*)$/

/** A block scalar header: folded (`>`), literal (`|`), with an optional chomping mark. */
const BLOCK_SCALAR = /^[>|][+-]?$/

/** Repository data: which directories hold skills, and the description budget. */
export interface SkillCatalogManifest {
  roots: string[]
  maxDescriptionLength: number
}

/** Outcome of reading the manifest file. */
export interface ManifestRead {
  manifest?: SkillCatalogManifest
  /** True for `{}` or a manifest that declares no roots: nothing to check. */
  empty?: boolean
  error?: string
}

/** One skill document found under a declared root. */
export interface SkillDocument {
  /** Path relative to the repository root, using forward slashes. */
  path: string
  /** The directory name of a directory package; undefined for a flat document. */
  packageName?: string
}

/** What a scan found, and every declared root that cannot be trusted as a surface. */
export interface CatalogScan {
  documents: SkillDocument[]
  problems: string[]
}

/** The two frontmatter fields this gate decides. Missing values stay undefined. */
export interface Frontmatter {
  name?: string
  description?: string
}

/** Outcome of reading one document's frontmatter. */
export interface FrontmatterRead {
  fields?: Frontmatter
  error?: string
}

const MANIFEST_FIELDS = ['roots', 'maxDescriptionLength'] as const

function relativePath(value: unknown, what: string): { path?: string; error?: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${what} must be a non-empty string` }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return { error: `${what} ${JSON.stringify(value)}: must be a relative path without \`..\`` }
  }
  return { path: normalized }
}

/** Parse the manifest text. `{}` is a deliberate "no skill roots declared". */
export function parseManifest(text: string): ManifestRead {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    return { error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'must be a JSON object' }
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length === 0) return { empty: true }
  for (const key of Object.keys(record)) {
    if (!MANIFEST_FIELDS.includes(key as (typeof MANIFEST_FIELDS)[number])) {
      return { error: `unknown field ${JSON.stringify(key)}` }
    }
  }

  const roots: string[] = []
  if (record.roots !== undefined) {
    if (!Array.isArray(record.roots)) return { error: '`roots` must be an array of directory paths (it may be empty)' }
    for (const entry of record.roots) {
      const parsed = relativePath(entry, 'each `roots` entry')
      if (parsed.error !== undefined) return { error: parsed.error }
      const path = parsed.path ?? ''
      if (roots.includes(path)) return { error: `duplicate root ${JSON.stringify(path)}` }
      roots.push(path)
    }
  }

  let maxDescriptionLength = DEFAULT_MAX_DESCRIPTION
  if (record.maxDescriptionLength !== undefined) {
    const declared = record.maxDescriptionLength
    if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
      return { error: '`maxDescriptionLength` must be a positive integer' }
    }
    maxDescriptionLength = declared
  }

  if (roots.length === 0) return { empty: true }
  return { manifest: { roots, maxDescriptionLength } }
}

/**
 * The skill documents under every declared root, plus the roots that are missing or hold
 * nothing to scan. A declared root that scans empty is an error, never a quiet pass:
 * "checked nothing" is not the same as "nothing to check", and only an explicit `{}`
 * says there are no skills.
 */
export function scanCatalog(root: string, manifest: SkillCatalogManifest): CatalogScan {
  const documents: SkillDocument[] = []
  const problems: string[] = []
  for (const relRoot of manifest.roots) {
    const absRoot = resolve(root, relRoot)
    if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
      problems.push(`${relRoot}: declared in the manifest but no such directory exists`)
      continue
    }
    const before = documents.length
    const entries = readdirSync(absRoot, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const skillFile = resolve(absRoot, entry.name, 'SKILL.md')
        if (existsSync(skillFile) && statSync(skillFile).isFile()) {
          documents.push({ path: `${relRoot}/${entry.name}/SKILL.md`, packageName: entry.name })
        }
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        documents.push({ path: `${relRoot}/${entry.name}` })
      }
    }
    if (documents.length === before) {
      problems.push(`${relRoot}: declared in the manifest but holds no skill document (expected <name>/SKILL.md or <name>.md)`)
    }
  }
  return { documents, problems }
}

/**
 * Read a document's frontmatter line by line. The block scalar collector consumes the
 * indented lines that follow a `>`/`|` header and joins them with spaces; everything
 * else between the fences is ignored except the two keys this gate decides.
 */
export function readFrontmatter(text: string): FrontmatterRead {
  const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if ((lines[0] ?? '').trim() !== '---') {
    return { error: 'has no frontmatter: the file does not start with a `---` line' }
  }
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      closing = index
      break
    }
  }
  if (closing === -1) return { error: 'opens its frontmatter with `---` but never closes it' }

  const fields: Frontmatter = {}
  let index = 1
  while (index < closing) {
    const line = lines[index] ?? ''
    index += 1
    if (line.trim() === '' || line.startsWith(' ') || line.startsWith('\t')) continue
    const match = FIELD_LINE.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    if (key !== 'name' && key !== 'description') continue
    const header = (match[2] ?? '').trim()
    let value = header
    if (BLOCK_SCALAR.test(header)) {
      const block: string[] = []
      while (index < closing) {
        const next = lines[index] ?? ''
        if (next.trim() === '') {
          index += 1
          continue
        }
        if (!next.startsWith(' ') && !next.startsWith('\t')) break
        block.push(next.trim())
        index += 1
      }
      value = block.join(' ')
    }
    if (key === 'name' && fields.name === undefined) fields.name = value
    if (key === 'description' && fields.description === undefined) fields.description = value
  }
  return { fields }
}

/** The client's measured unit: whitespace collapsed to single spaces, then trimmed. */
export function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Every way one document would fail to reach a client's catalog. One message per broken
 * rule, each naming the document and the reason, so a red run is a worklist.
 */
export function documentProblems(root: string, document: SkillDocument, maxDescriptionLength: number): string[] {
  let text: string
  try {
    text = readFileSync(resolve(root, document.path), 'utf8')
  } catch (error: unknown) {
    return [`${document.path}: cannot be read (${error instanceof Error ? error.message : String(error)})`]
  }
  const read = readFrontmatter(text)
  if (read.error !== undefined) return [`${document.path}: ${read.error}`]
  const fields = read.fields ?? {}
  const problems: string[] = []

  const name = (fields.name ?? '').trim()
  if (name === '') {
    problems.push(`${document.path}: has no \`name\` in its frontmatter`)
  } else {
    if (!KEBAB_CASE.test(name)) {
      problems.push(`${document.path}: name ${JSON.stringify(name)} is not kebab-case (lowercase words joined by single hyphens)`)
    }
    if (document.packageName !== undefined && name !== document.packageName) {
      problems.push(`${document.path}: name ${JSON.stringify(name)} does not match its directory ${JSON.stringify(document.packageName)}`)
    }
  }

  const description = (fields.description ?? '').trim()
  if (description === '') {
    problems.push(`${document.path}: has no \`description\` in its frontmatter`)
  } else {
    const measured = normalizeDescription(description)
    if (measured.length > maxDescriptionLength) {
      problems.push(`${document.path}: description is ${measured.length} characters after whitespace normalization, over the ${maxDescriptionLength}-character budget (the client would truncate it and drop the trailing triggers)`)
    }
  }
  return problems
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-skill-catalog: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const manifestPath = resolve(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) {
    console.error(`verify-skill-catalog: no manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to declare no skill roots.`)
    process.exit(1)
  }
  let read: ManifestRead
  try {
    read = parseManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error: unknown) {
    console.error(`verify-skill-catalog: ${MANIFEST_REL}: cannot be read (${error instanceof Error ? error.message : String(error)})`)
    process.exit(1)
  }
  if (read.error !== undefined) {
    console.error(`verify-skill-catalog: ${MANIFEST_REL}: ${read.error}`)
    process.exit(1)
  }
  const manifest = read.manifest
  if (read.empty === true || manifest === undefined) {
    console.log(`verify-skill-catalog: ${MANIFEST_REL} declares no skill roots; nothing to check.`)
    process.exit(0)
  }

  const scan = scanCatalog(root, manifest)
  if (process.argv.includes('--list')) {
    for (const document of scan.documents) console.log(document.path)
    for (const problem of scan.problems) console.error(`  ${problem}`)
    process.exit(0)
  }

  const problems = [...scan.problems]
  for (const document of scan.documents) {
    problems.push(...documentProblems(root, document, manifest.maxDescriptionLength))
  }
  if (problems.length === 0) {
    const count = scan.documents.length
    const rootCount = manifest.roots.length
    console.log(`verify-skill-catalog: ${count} ${count === 1 ? 'skill' : 'skills'} across ${rootCount} ${rootCount === 1 ? 'root' : 'roots'}, every frontmatter name is loadable and every description fits ${manifest.maxDescriptionLength}.`)
    process.exit(0)
  }
  console.error('verify-skill-catalog failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
