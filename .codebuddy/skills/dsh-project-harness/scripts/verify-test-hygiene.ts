/**
 * Test-surface hygiene: a focused test (`.only`) or an unconditionally skipped test
 * (`.skip('title')`) keeps the gate green while the suite shrinks. The failure is
 * silent by construction — the run stays fast, the report stays clean, and only the
 * coverage disappeared — so it is a gate's business rather than a reviewer's.
 *
 * Which files are tests and which receivers belong to the test API are repository data
 * (`scripts/harness/test-hygiene.manifest.json`); this gate owns the two rules, the
 * fail-closed scan, and the reporting. `{}` declares no test surface and passes.
 *
 * Both rules read the code surface from `surface.ts`, never raw text: a `.only` quoted
 * in a string or parked in a comment is not a focused run.
 *
 * A skip whose first argument is a condition is an environment gate and stays legal
 * (`test.skip(process.platform === 'win32')`); one whose first argument is a title or
 * `true` is a silent hole. That is a formal distinction, not a semantic one: a
 * condition that is always true reads as an environment gate here and is caught in
 * review, which is where judgement belongs.
 *
 *   node scripts/harness/verify-test-hygiene.ts [--root <path>] [--list]
 *   node scripts/harness/verify-test-hygiene.ts [--root <path>] --write-baseline [--accept-new]
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ScanSpec } from './surface.ts'
import { codeSurface, scanSurface } from './surface.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'
import { reportBaseline, runBaselineGate } from './baseline.ts'

const MANIFEST_REL = 'scripts/harness/test-hygiene.manifest.json'

/** Filename fragments that make a file a test file. */
const DEFAULT_SUFFIXES = ['.test.', '.spec.']

/** Calls that register a test, a suite, or a context; the framework's API surface. */
const DEFAULT_RECEIVERS = ['test', 'it', 'describe', 'suite', 'context']

/** Repository data: which files are tests, and which names register one. */
export interface TestManifest extends ScanSpec {
  suffixes?: string[]
  receivers?: string[]
}

/** Outcome of reading the manifest file. */
export interface ManifestRead {
  manifest?: TestManifest
  /** True for `{}`: no test surface is declared, so there is nothing to check. */
  empty?: boolean
  error?: string
}

/** One hit: a focused run or a silent skip. */
export interface Hit {
  path: string
  line: number
  /** `focused run` or `unconditional skip`. */
  rule: string
  /** The call that carries the violation, e.g. `test.only`. */
  token: string
  /** The whole source line, for display and for the ledger key. */
  text: string
}

const MANIFEST_FIELDS = ['scan', 'extensions', 'suffixes', 'receivers'] as const

function stringList(value: unknown, what: string, predicate: (entry: string) => boolean, describe: string): { list?: string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: `${what} must be a non-empty array when present` }
  const list: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || !predicate(entry)) {
      return { error: `${what} entry ${JSON.stringify(entry)}: ${describe}` }
    }
    list.push(entry)
  }
  return { list }
}

/** Parse the manifest text. `{}` is a deliberate "no test surface declared". */
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
    if (typeof entry !== 'string' || entry.trim() === '') return { error: 'each `scan` entry must be a non-empty string' }
    const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      return { error: `scan entry ${JSON.stringify(entry)}: must be a relative path without \`..\`` }
    }
    scan.push(normalized)
  }

  let extensions: string[] | undefined
  if (record.extensions !== undefined) {
    const parsed = stringList(record.extensions, '`extensions`', entry => entry.startsWith('.'), 'must start with a dot')
    if (parsed.error !== undefined) return { error: parsed.error }
    extensions = parsed.list?.map(entry => entry.toLowerCase())
  }

  let suffixes: string[] | undefined
  if (record.suffixes !== undefined) {
    const parsed = stringList(record.suffixes, '`suffixes`', entry => entry.startsWith('.'), 'must start with a dot')
    if (parsed.error !== undefined) return { error: parsed.error }
    suffixes = parsed.list
  }

  let receivers: string[] | undefined
  if (record.receivers !== undefined) {
    const parsed = stringList(record.receivers, '`receivers`', entry => /^[A-Za-z_$][\w$]*$/.test(entry), 'must be an identifier')
    if (parsed.error !== undefined) return { error: parsed.error }
    receivers = parsed.list
  }

  const manifest: TestManifest = { scan }
  if (extensions !== undefined) manifest.extensions = extensions
  if (suffixes !== undefined) manifest.suffixes = suffixes
  if (receivers !== undefined) manifest.receivers = receivers
  return { manifest }
}

/** Whether a path is a test file by the declared (or default) suffixes. */
export function isTestFile(path: string, suffixes: readonly string[]): boolean {
  const name = path.split('/').at(-1) ?? path
  return suffixes.some(suffix => name.includes(suffix))
}

/** The first non-space character of a call's first argument, or undefined when it has none. */
function firstArgumentHead(surface: string, openParen: number): string | undefined {
  let depth = 0
  let index = openParen
  while (index < surface.length) {
    const ch = surface[index] ?? ''
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return undefined
    } else if (ch === ',' && depth === 1) return undefined
    else if (depth === 1 && !/\s/.test(ch)) return ch
    index += 1
  }
  return undefined
}

/** The text of a call's first argument, for the `true` check. */
function firstArgumentText(surface: string, openParen: number): string {
  let depth = 0
  let index = openParen
  const start = index + 1
  while (index < surface.length) {
    const ch = surface[index] ?? ''
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return surface.slice(start, index)
    } else if (ch === ',' && depth === 1) return surface.slice(start, index)
    index += 1
  }
  return surface.slice(start, index)
}

function lineAt(source: string, position: number): number {
  let line = 1
  for (let index = 0; index < position && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/** Focused runs and silent skips on the code surface, one hit per call. */
export function findHits(path: string, source: string, receivers: readonly string[]): Hit[] {
  const surface = codeSurface(source)
  const rawLines = source.split('\n')
  const hits: Hit[] = []
  const seen = new Set<number>()
  const push = (index: number, rule: string, token: string): void => {
    if (seen.has(index)) return
    seen.add(index)
    const line = lineAt(surface, index)
    hits.push({ path, line, rule, token, text: (rawLines[line - 1] ?? '').replace(/\r$/, '') })
  }

  for (const receiver of receivers) {
    const re = new RegExp(`(^|[^\\w$.])${receiver}\\.only(?:\\.each)?\\(`, 'g')
    for (const match of surface.matchAll(re)) {
      // The boundary group can be a newline, so the call starts after it, not at it.
      push((match.index ?? 0) + (match[1]?.length ?? 0), 'focused run', `${receiver}.only`)
    }

    const skip = new RegExp(`(^|[^\\w$.])${receiver}\\.skip(?:\\.each)?\\(`, 'g')
    for (const match of surface.matchAll(skip)) {
      const at = (match.index ?? 0) + (match[1]?.length ?? 0)
      const openParen = at + match[0].length - 1 - (match[1]?.length ?? 0)
      const each = match[0].includes('.each(')
      const head = firstArgumentHead(surface, openParen)
      const condition = !each && head !== undefined && !/['"`\d]/.test(head) && firstArgumentText(surface, openParen).trim() !== 'true'
      if (condition) continue
      push(at, 'unconditional skip', `${receiver}.skip`)
    }
  }
  return hits
}

/** The ledger key: stable under unrelated edits, re-exposed by editing the call. */
function keyOf(hit: Hit): string {
  return `${hit.path}|${hit.text.trim()}|${hit.token}`
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-test-hygiene: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const manifestPath = resolve(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) {
    console.error(`verify-test-hygiene: no manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to declare no test surface.`)
    process.exit(1)
  }
  const read = parseManifest(readFileSync(manifestPath, 'utf8'))
  if (read.error !== undefined) {
    console.error(`verify-test-hygiene: ${MANIFEST_REL}: ${read.error}`)
    process.exit(1)
  }
  const manifest = read.manifest
  if (read.empty === true || manifest === undefined) {
    console.log(`verify-test-hygiene: ${MANIFEST_REL} declares no test surface; nothing to check.`)
    process.exit(0)
  }

  const suffixes = manifest.suffixes ?? DEFAULT_SUFFIXES
  const receivers = manifest.receivers ?? DEFAULT_RECEIVERS
  const surface = scanSurface(root, manifest)
  const files = surface.files.filter(path => isTestFile(path, suffixes))
  if (files.length === 0 && surface.problems.length === 0) {
    surface.problems.push(`no file under ${manifest.scan.join(', ')} matches the test suffixes (${suffixes.join(' ')}); a gate that scanned nothing must not pass`)
  }

  if (process.argv.includes('--list')) {
    console.log(files.join('\n'))
    for (const problem of surface.problems) console.error(`  ${problem}`)
    process.exit(0)
  }
  if (surface.problems.length > 0) {
    // Fail-closed: an untrustworthy scan surface is an error, and no ledger records it.
    console.error('verify-test-hygiene: the scan surface is not trustworthy:')
    for (const problem of surface.problems) console.error(`  ${problem}`)
    process.exit(1)
  }

  const hits: Hit[] = []
  for (const path of files) {
    hits.push(...findHits(path, readFileSync(resolve(root, path), 'utf8'), receivers))
  }

  const unique = [...new Map(hits.map(hit => [keyOf(hit), hit])).values()]
  const run = runBaselineGate(root, 'test-hygiene', unique, keyOf)
  if (run.action === 'recorded') process.exit(0)

  const outcome = run.outcome
  if (outcome.remaining.length === 0) {
    console.log(`verify-test-hygiene: ${files.length} test file(s) scanned, no focused run and no unconditional skip.`)
    reportBaseline(outcome, 'test-hygiene')
    process.exit(0)
  }

  console.error('verify-test-hygiene: the suite is smaller than it looks:')
  for (const hit of outcome.remaining.slice(0, 200)) {
    console.error(`  ${hit.path}:${hit.line} — ${hit.rule} ${JSON.stringify(hit.token)}: ${hit.text.trim()}`)
  }
  if (outcome.remaining.length > 200) console.error(`  ... and ${outcome.remaining.length - 200} more`)
  console.error('  A focused run or a titled skip keeps the gate green while coverage disappears.')
  console.error('  An environment gate is written as a condition, e.g. test.skip(!env.CI) — never as a title.')
  reportBaseline(outcome, 'test-hygiene')
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
