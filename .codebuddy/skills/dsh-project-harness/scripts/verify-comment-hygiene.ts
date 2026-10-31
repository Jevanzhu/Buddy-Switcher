/**
 * Comment hygiene: a comment carries what the code cannot say — constraints,
 * invariants, semantics, platform differences, sync obligations. History does not
 * belong in one: what changed, when, and which review round said so belongs to git
 * and to decision records.
 *
 * Two judgement families, and both are needed. Declared shapes catch chronology
 * written into a comment (a date, a review round, a batch marker). Residue catches
 * what a botched cleanup leaves behind (a parenthesis emptied of its content) —
 * a shape the declared list alone reports as clean.
 *
 * Shapes, exception tokens, and test-pinned comments are repository data
 * (`scripts/harness/comment-hygiene.manifest.json`); this gate owns the rules, the
 * fail-closed scan, and the reporting. `{}` declares no rules and passes. The comment
 * surface itself comes from `surface.ts`: string, template, and regex literals are
 * skipped, so text that merely looks like a tag inside a literal is never reported.
 *
 * Scan-surface failures are fail-closed and never recorded as debt: a missing scan
 * root, a root holding zero scannable files, and an unreadable directory are errors,
 * because a gate that scanned nothing and passed is a false green rather than an
 * acceptable state.
 *
 *   node scripts/harness/verify-comment-hygiene.ts [--root <path>] [--list]
 *   node scripts/harness/verify-comment-hygiene.ts [--root <path>] --write-baseline [--accept-new]
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommentLine, ScanSpec } from './surface.ts'
import { commentLines, scanSurface } from './surface.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'
import { reportBaseline, runBaselineGate } from './baseline.ts'

const MANIFEST_REL = 'scripts/harness/comment-hygiene.manifest.json'

/** One forbidden shape. `pattern` is a regular expression source, matched per comment. */
export interface CommentRule {
  name: string
  pattern: string
}

/** A literal the shape table would hit on a real technical term. */
export interface ExceptionRule {
  match: string
  reason: string
}

/** A comment a test pins by reading the source; editing it breaks that test. */
export interface AnchorRule {
  path: string
  text: string
  pinnedBy: string
}

/** Repository data: what to scan, and which shapes count as history. */
export interface CommentManifest extends ScanSpec {
  labels: CommentRule[]
  residue?: CommentRule[]
  exceptions?: ExceptionRule[]
  anchors?: AnchorRule[]
}

/** Outcome of reading the manifest file. */
export interface ManifestRead {
  manifest?: CommentManifest
  /** True for `{}`: no rules are declared, so there is nothing to check. */
  empty?: boolean
  error?: string
}

/** One hit: a declared shape or a residue found inside a comment. */
export interface Hit {
  path: string
  line: number
  /** The rule's name, or the residue's name. */
  rule: string
  /** The exact matched text. */
  token: string
  /** The whole source line, for display and for the ledger key. */
  text: string
}

const MANIFEST_FIELDS = ['scan', 'extensions', 'labels', 'residue', 'exceptions', 'anchors'] as const

function ruleFrom(value: unknown, what: string): { rule?: CommentRule; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: `each ${what} must be an object` }
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'pattern') return { error: `unknown ${what} field ${JSON.stringify(key)}` }
  }
  const name = record.name
  const pattern = record.pattern
  if (typeof name !== 'string' || name.trim() === '') return { error: `${what} \`name\` must be a non-empty string` }
  if (typeof pattern !== 'string' || pattern === '') return { error: `${what} ${JSON.stringify(name)}: \`pattern\` must be a non-empty string` }
  try {
    new RegExp(pattern)
  } catch (error: unknown) {
    return { error: `${what} ${JSON.stringify(name)}: not a valid regular expression (${error instanceof Error ? error.message : String(error)})` }
  }
  return { rule: { name, pattern } }
}

function relativePath(value: unknown, what: string): { path?: string; error?: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${what} must be a non-empty string` }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return { error: `${what} ${JSON.stringify(value)}: must be a relative path without \`..\`` }
  }
  return { path: normalized }
}

/** Parse the manifest text. `{}` is a deliberate "no rules declared". */
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

  if (!Array.isArray(record.scan) || record.scan.length === 0) {
    return { error: '`scan` must list at least one directory or file' }
  }
  const scan: string[] = []
  for (const entry of record.scan) {
    const parsed = relativePath(entry, 'each `scan` entry')
    if (parsed.error !== undefined) return { error: parsed.error }
    if (parsed.path !== undefined) scan.push(parsed.path)
  }

  let extensions: string[] | undefined
  if (record.extensions !== undefined) {
    if (!Array.isArray(record.extensions) || record.extensions.length === 0) {
      return { error: '`extensions` must be a non-empty array when present' }
    }
    extensions = []
    for (const entry of record.extensions) {
      if (typeof entry !== 'string' || !entry.startsWith('.')) {
        return { error: `extensions entry ${JSON.stringify(entry)}: must be a string starting with a dot` }
      }
      extensions.push(entry.toLowerCase())
    }
  }

  if (!Array.isArray(record.labels)) return { error: '`labels` must be an array (it may be empty)' }
  const labels: CommentRule[] = []
  for (const entry of record.labels) {
    const parsed = ruleFrom(entry, 'label')
    if (parsed.error !== undefined) return { error: parsed.error }
    if (parsed.rule !== undefined) labels.push(parsed.rule)
  }

  const residue: CommentRule[] = []
  if (record.residue !== undefined) {
    if (!Array.isArray(record.residue)) return { error: '`residue` must be an array when present' }
    for (const entry of record.residue) {
      const parsed = ruleFrom(entry, 'residue rule')
      if (parsed.error !== undefined) return { error: parsed.error }
      if (parsed.rule !== undefined) residue.push(parsed.rule)
    }
  }

  const exceptions: ExceptionRule[] = []
  if (record.exceptions !== undefined) {
    if (!Array.isArray(record.exceptions)) return { error: '`exceptions` must be an array when present' }
    for (const entry of record.exceptions) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { error: 'each exception must be an object' }
      const item = entry as Record<string, unknown>
      for (const key of Object.keys(item)) {
        if (key !== 'match' && key !== 'reason') return { error: `unknown exception field ${JSON.stringify(key)}` }
      }
      if (typeof item.match !== 'string' || item.match === '') return { error: 'exception `match` must be a non-empty string' }
      if (typeof item.reason !== 'string' || item.reason.trim() === '') {
        return { error: `exception ${JSON.stringify(item.match)}: \`reason\` is required — an unexplained suppression is not a decision` }
      }
      exceptions.push({ match: item.match, reason: item.reason })
    }
  }

  const anchors: AnchorRule[] = []
  if (record.anchors !== undefined) {
    if (!Array.isArray(record.anchors)) return { error: '`anchors` must be an array when present' }
    for (const entry of record.anchors) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { error: 'each anchor must be an object' }
      const item = entry as Record<string, unknown>
      for (const key of Object.keys(item)) {
        if (key !== 'path' && key !== 'text' && key !== 'pinnedBy') return { error: `unknown anchor field ${JSON.stringify(key)}` }
      }
      const path = relativePath(item.path, 'anchor `path`')
      if (path.error !== undefined) return { error: path.error }
      if (typeof item.text !== 'string' || item.text === '') return { error: 'anchor `text` must be a non-empty string' }
      if (typeof item.pinnedBy !== 'string' || item.pinnedBy.trim() === '') {
        return { error: `anchor ${JSON.stringify(item.text)}: \`pinnedBy\` is required — name the test that pins this comment` }
      }
      if (path.path !== undefined) anchors.push({ path: path.path, text: item.text, pinnedBy: item.pinnedBy })
    }
  }

  const manifest: CommentManifest = { scan, labels }
  if (extensions !== undefined) manifest.extensions = extensions
  if (residue.length > 0) manifest.residue = residue
  if (exceptions.length > 0) manifest.exceptions = exceptions
  if (anchors.length > 0) manifest.anchors = anchors
  return { manifest }
}

interface CompiledRule {
  name: string
  re: RegExp
}

/** Compile rule patterns for scanning; the manifest parser already rejected invalid ones. */
export function compileRules(rules: readonly CommentRule[]): CompiledRule[] {
  return rules.map(rule => ({ name: rule.name, re: new RegExp(rule.pattern, 'g') }))
}

/** Every declared shape matching inside the comment surface, one hit per line and token. */
export function findHits(path: string, source: string, rules: readonly CompiledRule[]): Hit[] {
  const hits: Hit[] = []
  const seen = new Set<string>()
  for (const commentLine of commentLines(source) as CommentLine[]) {
    if (commentLine.text === '') continue
    for (const rule of rules) {
      for (const match of commentLine.text.matchAll(rule.re)) {
        const token = match[0].trim()
        if (token === '') continue
        const key = `${commentLine.line}|${rule.name}|${token}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push({ path, line: commentLine.line, rule: rule.name, token, text: commentLine.raw })
      }
    }
  }
  return hits
}

/** The ledger key: stable under unrelated edits, re-exposed by editing the comment. */
function keyOf(hit: Hit): string {
  return `${hit.path}|${hit.text.trim()}|${hit.token}`
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-comment-hygiene: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const manifestPath = resolve(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) {
    console.error(`verify-comment-hygiene: no manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to declare no rules.`)
    process.exit(1)
  }
  const read = parseManifest(readFileSync(manifestPath, 'utf8'))
  if (read.error !== undefined) {
    console.error(`verify-comment-hygiene: ${MANIFEST_REL}: ${read.error}`)
    process.exit(1)
  }
  const manifest = read.manifest
  if (read.empty === true || manifest === undefined) {
    console.log(`verify-comment-hygiene: ${MANIFEST_REL} declares no rules; nothing to check.`)
    process.exit(0)
  }

  const surface = scanSurface(root, manifest)
  if (process.argv.includes('--list')) {
    console.log(surface.files.join('\n'))
    for (const problem of surface.problems) console.error(`  ${problem}`)
    process.exit(0)
  }
  if (surface.problems.length > 0) {
    // Fail-closed: an untrustworthy scan surface is an error, and no ledger records it.
    console.error('verify-comment-hygiene: the scan surface is not trustworthy:')
    for (const problem of surface.problems) console.error(`  ${problem}`)
    process.exit(1)
  }

  const rules = compileRules([...manifest.labels, ...(manifest.residue ?? [])])
  const all: Hit[] = []
  for (const path of surface.files) {
    all.push(...findHits(path, readFileSync(resolve(root, path), 'utf8'), rules))
  }

  const usedExceptions = new Set<string>()
  const usedAnchors = new Set<string>()
  const hits = all.filter(hit => {
    const exception = manifest.exceptions?.find(rule => rule.match === hit.token)
    if (exception !== undefined) {
      usedExceptions.add(exception.match)
      return false
    }
    const anchor = manifest.anchors?.find(rule => rule.path === hit.path && hit.text.includes(rule.text))
    if (anchor !== undefined) {
      usedAnchors.add(`${anchor.path}|${anchor.text}`)
      return false
    }
    return true
  })

  const scanned = new Set(surface.files)
  const staleNotes: string[] = []
  for (const rule of manifest.exceptions ?? []) {
    if (!usedExceptions.has(rule.match)) staleNotes.push(`exception ${JSON.stringify(rule.match)} was not needed in this scan; remove it`)
  }
  for (const anchor of manifest.anchors ?? []) {
    const key = `${anchor.path}|${anchor.text}`
    if (scanned.has(anchor.path) && !usedAnchors.has(key)) {
      staleNotes.push(`anchor ${JSON.stringify(anchor.text)} in ${anchor.path} matched nothing; remove it (its test no longer pins a hit)`)
    }
  }

  const unique = [...new Map(hits.map(hit => [keyOf(hit), hit])).values()]
  const run = runBaselineGate(root, 'comment-hygiene', unique, keyOf)
  if (run.action === 'recorded') process.exit(0)

  const outcome = run.outcome
  const reportStale = (): void => {
    for (const note of staleNotes) console.log(`  comment-hygiene: ${note}`)
  }
  if (outcome.remaining.length === 0) {
    console.log(`verify-comment-hygiene: ${surface.files.length} file(s) scanned, ${rules.length} shape(s) enforced, comments carry no history.`)
    reportBaseline(outcome, 'comment-hygiene')
    reportStale()
    process.exit(0)
  }

  console.error('verify-comment-hygiene: history written into comments:')
  for (const hit of outcome.remaining.slice(0, 200)) {
    console.error(`  ${hit.path}:${hit.line} — ${hit.rule} matches ${JSON.stringify(hit.token)}: ${hit.text.trim()}`)
  }
  if (outcome.remaining.length > 200) console.error(`  ... and ${outcome.remaining.length - 200} more`)
  console.error('  A comment carries constraints, not chronology: delete the history, or move the reason into a decision record.')
  console.error(`  A comment a test really pins goes into ${MANIFEST_REL} under \`anchors\`, with the test named.`)
  reportBaseline(outcome, 'comment-hygiene')
  reportStale()
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
