/**
 * Check the document chain against its index: every declared directory exists,
 * every directory on disk is declared, every top-level document is referenced
 * from the index, and each required count matches the files actually on disk.
 *
 * The chain's names, its index path, and which directories carry counts are
 * repository data (`scripts/harness/doc-index.manifest.json`); this gate owns
 * only the rules. `{}` declares no chain and passes, so a repository that keeps
 * no index is not blocked by the gate's absence of data.
 *
 *   node scripts/harness/verify-doc-index.ts [--root <path>] [--list]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SourceLine } from './markdown.ts'
import { proseLines, stripInlineCode } from './markdown.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'

const MANIFEST_REL = 'scripts/harness/doc-index.manifest.json'

/** One chain slot: a directory under the scan root, optionally count-checked. */
export interface DocIndexEntry {
  /** Directory path relative to the scan root, using forward slashes. */
  dir: string
  /** Require the index line naming this directory to carry the measured file count. */
  count?: boolean
}

/** The declared chain: where its index lives, where its slots are, what they are. */
export interface DocIndexManifest {
  /** Index document path, relative to the repository root. */
  index: string
  /** Root directory holding the chain's slot directories. */
  scan: string
  entries: DocIndexEntry[]
}

/** Outcome of reading the manifest file. */
export interface ManifestRead {
  manifest?: DocIndexManifest
  /** True for `{}`: no chain is declared, so there is nothing to check. */
  empty?: boolean
  error?: string
}

const MANIFEST_FIELDS = ['index', 'scan', 'entries'] as const
const ENTRY_FIELDS = ['dir', 'count'] as const

function parseEntry(value: unknown): { entry?: DocIndexEntry; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'each entry must be an object' }
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ENTRY_FIELDS.includes(key as (typeof ENTRY_FIELDS)[number])) {
      return { error: `unknown entry field ${JSON.stringify(key)}` }
    }
  }
  const dir = record.dir
  if (typeof dir !== 'string' || dir.trim() === '') return { error: 'entry `dir` must be a non-empty string' }
  if (record.count !== undefined && typeof record.count !== 'boolean') {
    return { error: `entry ${JSON.stringify(dir)}: \`count\` must be a boolean` }
  }
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return { error: `entry ${JSON.stringify(dir)}: must be a relative path without \`..\`` }
  }
  const entry: DocIndexEntry = normalized === dir ? { dir } : { dir: normalized }
  if (record.count === true) entry.count = true
  return { entry }
}

/** Parse the manifest text. `{}` is a deliberate "no chain declared". */
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
  if (typeof record.index !== 'string' || record.index.trim() === '') {
    return { error: '`index` must be a non-empty string' }
  }
  if (typeof record.scan !== 'string' || record.scan.trim() === '') {
    return { error: '`scan` must be a non-empty string' }
  }
  if (!Array.isArray(record.entries)) return { error: '`entries` must be an array' }
  const entries: DocIndexEntry[] = []
  for (const raw of record.entries) {
    const parsed = parseEntry(raw)
    if (parsed.error !== undefined) return { error: parsed.error }
    const entry = parsed.entry
    if (entry === undefined) continue
    if (entries.some(existing => existing.dir === entry.dir)) {
      return { error: `duplicate entry ${JSON.stringify(entry.dir)}` }
    }
    entries.push(entry)
  }
  return { manifest: { index: record.index, scan: record.scan, entries } }
}

/** Recursively count files under `abs`, ignoring hidden entries (`.gitkeep` included). */
export function countFiles(abs: string): number {
  let total = 0
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) total += countFiles(resolve(abs, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

/** Direct child directories of the scan root, ignoring hidden ones. */
function slotDirectories(root: string, scan: string): string[] {
  return readdirSync(resolve(root, scan), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}

/** The index lines that name `name`, and the integers those lines carry apart from it. */
export function claimNumbers(indexLines: readonly SourceLine[], name: string): { lines: number[]; numbers: number[] } {
  const lines: number[] = []
  const numbers: number[] = []
  for (const { line, text } of indexLines) {
    if (!text.includes(name)) continue
    lines.push(line)
    const stripped = stripInlineCode(text).split(name).join(' ')
    for (const match of stripped.matchAll(/\d+/g)) numbers.push(Number(match[0]))
  }
  return { lines, numbers }
}

/** Every way the chain and its index disagree, as one message per problem. */
export function indexProblems(root: string, manifest: DocIndexManifest): string[] {
  const problems: string[] = []
  const indexPath = resolve(root, manifest.index)
  const scanPath = resolve(root, manifest.scan)
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    return [`${manifest.index}: index document does not exist`]
  }
  if (!existsSync(scanPath) || !statSync(scanPath).isDirectory()) {
    return [`${manifest.scan}: scan root does not exist`]
  }
  const indexLines = proseLines(readFileSync(indexPath, 'utf8'))
  // Reference checks read the raw lines: a document named inside a code span is
  // still referenced. Only count claims disregard code spans, since a number in
  // code is an example rather than a declaration.
  const indexText = indexLines.map(({ text }) => text).join('\n')

  const declared = new Set(manifest.entries.map(entry => entry.dir))
  for (const name of slotDirectories(root, manifest.scan)) {
    if (!declared.has(name)) {
      problems.push(`${manifest.scan}/${name}: directory exists on disk but no manifest entry declares it`)
    }
  }

  for (const entry of manifest.entries) {
    const abs = resolve(scanPath, entry.dir)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      problems.push(`${entry.dir}: declared in the manifest but missing under ${manifest.scan}`)
      continue
    }
    const name = entry.dir.split('/').at(-1) ?? entry.dir
    const claims = claimNumbers(indexLines, name)
    if (claims.lines.length === 0) {
      problems.push(`${manifest.index}: no line names ${JSON.stringify(name)}`)
      continue
    }
    if (entry.count === true) {
      const measured = countFiles(abs)
      if (!claims.numbers.includes(measured)) {
        const claim = claims.numbers.length === 0 ? 'no count' : `[${claims.numbers.join(', ')}]`
        problems.push(`${manifest.index}:${claims.lines[0]}: ${JSON.stringify(name)} claims ${claim} but ${measured} file(s) are on disk`)
      }
    }
  }

  const indexName = manifest.index.split('/').at(-1) ?? manifest.index
  for (const entry of readdirSync(scanPath, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue
    if (entry.name === indexName) continue
    if (!indexText.includes(entry.name)) {
      problems.push(`${manifest.scan}/${entry.name}: document is not referenced from ${manifest.index}`)
    }
  }
  return problems
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-doc-index: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const manifestPath = resolve(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) {
    console.error(`verify-doc-index: no manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to declare no chain.`)
    process.exit(1)
  }
  const read = parseManifest(readFileSync(manifestPath, 'utf8'))
  if (read.error !== undefined) {
    console.error(`verify-doc-index: ${MANIFEST_REL}: ${read.error}`)
    process.exit(1)
  }
  const manifest = read.manifest
  if (read.empty === true || manifest === undefined) {
    console.log(`verify-doc-index: ${MANIFEST_REL} declares no chain; nothing to check.`)
    process.exit(0)
  }

  if (process.argv.includes('--list')) {
    for (const entry of manifest.entries) {
      const abs = resolve(root, manifest.scan, entry.dir)
      const measured = existsSync(abs) ? String(countFiles(abs)) : 'MISS'
      console.log(`${measured.padStart(6)}  ${entry.dir}`)
    }
    process.exit(0)
  }

  const problems = indexProblems(root, manifest)
  if (problems.length === 0) {
    const count = manifest.entries.length
    console.log(`verify-doc-index: ${count} chain ${count === 1 ? 'entry matches' : 'entries match'} the index and the disk.`)
    process.exit(0)
  }
  console.error('verify-doc-index failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
