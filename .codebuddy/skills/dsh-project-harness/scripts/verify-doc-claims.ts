/**
 * Claims in the documents, checked against the source that decides them. A number a
 * document states about the repository (how many skills, how many gates) is a copy the
 * moment it is written, and copies do not update themselves; a list a document enumerates
 * (which directories exist) drifts the same way. Self-discipline does not hold here —
 * the snapshot that was true when it was written is stale by the next change and nobody
 * re-checks it — so the comparison is a gate that runs every time.
 *
 * A claim is repository data (`scripts/harness/doc-claims.manifest.json`): where the
 * number is written, and the command that measures it. Two kinds:
 *
 *   - `count` — the command prints one integer (or one item per line with `byLines`),
 *     and the document states it. `expect` allows a floor or a ceiling, which is how a
 *     gate table that may only grow is held to its floor.
 *   - `list` — the command prints one item per line, and the document mentions each one.
 *
 * Commands are argv arrays, never shell strings: no quoting rules and no platform
 * differences. A claim has no debt ledger on purpose — fixing a wrong number is cheaper
 * than recording it, and a ledger would reward leaving it wrong.
 *
 *   node scripts/harness/verify-doc-claims.ts [--root <path>] [--list]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { proseLines } from './markdown.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'

const MANIFEST_REL = 'scripts/harness/doc-claims.manifest.json'

/** How the measured value relates to the number the document states. */
export type Expectation = 'equal' | 'atLeast' | 'atMost'

/** One number or list a document states, and the command that decides it. */
export interface Claim {
  name: string
  kind: 'count' | 'list'
  /** Document the claim is written in, relative to the repository root. */
  doc: string
  /** argv of the command that measures it; it runs with the repository root as cwd. */
  command: string[]
  /** `count` only: regular expression with one capture group, matched in the document. */
  pattern?: string
  /** `count` only: count the command's non-empty output lines instead of parsing an integer. */
  byLines?: boolean
  /** `count` only: how the stated number relates to the measured one. Defaults to equal. */
  expect?: Expectation
}

/** Outcome of reading the manifest file. */
export interface ManifestRead {
  claims?: Claim[]
  /** True for `{}`: no claims are declared, so there is nothing to check. */
  empty?: boolean
  error?: string
}

/** One claim's verdict. */
export interface ClaimResult {
  claim: Claim
  /** The measured value: an integer for `count`, the item list for `list`. */
  measured: number | string[]
  /** The number the document states, when it could be read. */
  stated?: number
  problems: string[]
}

const CLAIM_FIELDS = ['name', 'kind', 'doc', 'command', 'pattern', 'byLines', 'expect'] as const
const EXPECTATIONS: readonly Expectation[] = ['equal', 'atLeast', 'atMost']

function relativePath(value: unknown, what: string): { path?: string; error?: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${what} must be a non-empty string` }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return { error: `${what} ${JSON.stringify(value)}: must be a relative path without \`..\`` }
  }
  return { path: normalized }
}

/** Number of capture groups in a pattern source. */
function captureGroups(pattern: string): number {
  let count = 0
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]
    if (ch === '\\') { index += 1; continue }
    if (ch === '(' && pattern[index + 1] !== '?') count += 1
  }
  return count
}

function claimFrom(value: unknown): { claim?: Claim; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'each claim must be an object' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!CLAIM_FIELDS.includes(key as (typeof CLAIM_FIELDS)[number])) return { error: `unknown claim field ${JSON.stringify(key)}` }
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') return { error: 'claim `name` must be a non-empty string' }
  const name = record.name
  if (record.kind !== 'count' && record.kind !== 'list') return { error: `claim ${JSON.stringify(name)}: \`kind\` must be "count" or "list"` }
  const doc = relativePath(record.doc, `claim ${JSON.stringify(name)}: \`doc\``)
  if (doc.error !== undefined) return { error: doc.error }
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.some(entry => typeof entry !== 'string' || entry === '')) {
    return { error: `claim ${JSON.stringify(name)}: \`command\` must be a non-empty argv array` }
  }

  const claim: Claim = { name, kind: record.kind, doc: doc.path ?? '', command: record.command as string[] }

  if (record.kind === 'count') {
    if (typeof record.pattern !== 'string' || record.pattern === '') {
      return { error: `claim ${JSON.stringify(name)}: a count claim needs \`pattern\` — the expression that finds the number in the document` }
    }
    try {
      new RegExp(record.pattern)
    } catch (error: unknown) {
      return { error: `claim ${JSON.stringify(name)}: \`pattern\` is not a valid regular expression (${error instanceof Error ? error.message : String(error)})` }
    }
    if (captureGroups(record.pattern) !== 1) {
      return { error: `claim ${JSON.stringify(name)}: \`pattern\` must have exactly one capture group — the number itself` }
    }
    claim.pattern = record.pattern
    if (record.byLines !== undefined) {
      if (typeof record.byLines !== 'boolean') return { error: `claim ${JSON.stringify(name)}: \`byLines\` must be a boolean` }
      claim.byLines = record.byLines
    }
    if (record.expect !== undefined) {
      if (typeof record.expect !== 'string' || !EXPECTATIONS.includes(record.expect as Expectation)) {
        return { error: `claim ${JSON.stringify(name)}: \`expect\` must be one of ${EXPECTATIONS.join(', ')}` }
      }
      claim.expect = record.expect as Expectation
    }
  } else {
    for (const forbidden of ['pattern', 'byLines', 'expect'] as const) {
      if (record[forbidden] !== undefined) {
        return { error: `claim ${JSON.stringify(name)}: a list claim has no \`${forbidden}\`` }
      }
    }
  }
  return { claim }
}

/** Parse the manifest text. `{}` is a deliberate "no claims declared". */
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
    if (key !== 'claims') return { error: `unknown field ${JSON.stringify(key)}` }
  }
  if (!Array.isArray(record.claims)) return { error: '`claims` must be an array (it may be empty)' }
  const claims: Claim[] = []
  for (const entry of record.claims) {
    const parsed = claimFrom(entry)
    if (parsed.error !== undefined) return { error: parsed.error }
    if (parsed.claim !== undefined) claims.push(parsed.claim)
  }
  return { claims }
}

/** Read one integer from a command's output, or count its non-empty lines. */
export function measuredFrom(stdout: string, byLines: boolean): { measured?: number; error?: string } {
  if (byLines) {
    const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length === 0) return { error: 'the command printed no line to count' }
    return { measured: lines.length }
  }
  const trimmed = stdout.trim()
  if (trimmed === '') return { error: 'the command printed nothing' }
  if (!/^-?\d+$/.test(trimmed)) return { error: `the command printed ${JSON.stringify(trimmed.slice(0, 80))}, not a single integer` }
  return { measured: Number(trimmed) }
}

/** The number the document states, read through the claim's capture group. */
function statedIn(documentText: string, pattern: string): number | undefined {
  const match = new RegExp(pattern).exec(documentText)
  const captured = match?.[1]
  if (captured === undefined) return undefined
  const value = Number(captured.trim())
  return Number.isInteger(value) ? value : undefined
}

/** Check every declared claim against its source and its document. */
export function checkClaims(root: string, claims: readonly Claim[]): ClaimResult[] {
  const results: ClaimResult[] = []
  for (const claim of claims) {
    const problems: string[] = []
    const docPath = resolve(root, claim.doc)
    const documentText = existsSync(docPath)
      ? proseLines(readFileSync(docPath, 'utf8')).map(({ text }) => text).join('\n')
      : undefined
    if (documentText === undefined) problems.push(`${claim.doc}: the document does not exist`)

    const run = spawnSync(claim.command[0] ?? '', claim.command.slice(1), { cwd: root, encoding: 'utf8' })
    if (run.status !== 0) {
      const reason = (run.stderr ?? '').trim().split('\n')[0] ?? ''
      problems.push(`the source command failed (exit ${String(run.status)}${reason === '' ? '' : `: ${reason}`})`)
      results.push({ claim, measured: claim.kind === 'count' ? 0 : [], problems })
      continue
    }
    const stdout = run.stdout ?? ''

    if (claim.kind === 'list') {
      const items = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      if (items.length === 0) problems.push('the source command printed no item')
      for (const item of items) {
        if (documentText !== undefined && !documentText.includes(item)) {
          problems.push(`${claim.doc}: the source lists ${JSON.stringify(item)}, which the document does not mention`)
        }
      }
      results.push({ claim, measured: items, problems })
      continue
    }

    const measured = measuredFrom(stdout, claim.byLines === true)
    if (measured.measured === undefined) {
      problems.push(measured.error ?? 'the source command printed nothing usable')
      results.push({ claim, measured: 0, problems })
      continue
    }
    const stated = documentText === undefined ? undefined : statedIn(documentText, claim.pattern ?? '')
    if (stated === undefined) {
      if (documentText !== undefined) {
        problems.push(`${claim.doc}: the claim is no longer written there (pattern ${JSON.stringify(claim.pattern ?? '')} matches nothing)`)
      }
      results.push({ claim, measured: measured.measured, problems })
      continue
    }
    const expectation = claim.expect ?? 'equal'
    // `atLeast` reads as: expect the source to measure at least what the document states,
    // so the stated number is a floor the repository may only rise above.
    const satisfied = expectation === 'equal'
      ? stated === measured.measured
      : expectation === 'atLeast'
        ? measured.measured >= stated
        : measured.measured <= stated
    if (!satisfied) {
      problems.push(`${claim.doc}: the document says ${stated} but the source measures ${measured.measured}${expectation === 'equal' ? '' : ` (expect ${expectation})`}`)
    }
    results.push({ claim, measured: measured.measured, stated, problems })
  }
  return results
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-doc-claims: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const manifestPath = resolve(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) {
    console.error(`verify-doc-claims: no manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to declare no claims.`)
    process.exit(1)
  }
  const read = parseManifest(readFileSync(manifestPath, 'utf8'))
  if (read.error !== undefined) {
    console.error(`verify-doc-claims: ${MANIFEST_REL}: ${read.error}`)
    process.exit(1)
  }
  const claims = read.claims
  if (read.empty === true || claims === undefined || claims.length === 0) {
    console.log(`verify-doc-claims: ${MANIFEST_REL} declares no claims; nothing to check.`)
    process.exit(0)
  }

  const results = checkClaims(root, claims)
  if (process.argv.includes('--list')) {
    for (const result of results) {
      const measured = Array.isArray(result.measured) ? `${result.measured.length} item(s)` : String(result.measured)
      console.log(`${result.claim.name.padEnd(24)} ${result.claim.doc}  measured ${measured}${result.stated === undefined ? '' : `  stated ${result.stated}`}`)
    }
    process.exit(0)
  }

  const problems = results.flatMap(result => result.problems)
  if (problems.length === 0) {
    console.log(`verify-doc-claims: ${claims.length} claim(s) checked against their sources.`)
    process.exit(0)
  }
  console.error('verify-doc-claims: the documents and their sources disagree:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('  A stated number is a copy: update it from the source, or delete the statement.')
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
