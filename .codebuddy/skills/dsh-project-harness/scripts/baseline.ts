/**
 * Debt ledger for adopting gates on a repository that already has violations.
 *
 * A gate that goes red on day one gets disabled on day two. The baseline records the
 * violations that already existed when the gate was installed, so the gate blocks NEW
 * debt immediately while the old debt stays visible in one reviewable file.
 *
 * The ledger is meant to shrink. Every run reports entries that no longer match
 * anything, so fixing a violation and re-recording ratchets the file down. Seeding it
 * is a reviewed act: `--write-baseline` refuses to grow a ledger that already exists
 * unless `--accept-new` says so explicitly, which keeps "add a gate" from silently
 * becoming "ignore a gate".
 *
 *   scripts/harness/baseline.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Recorded debt, keyed by gate id. */
export interface Baseline {
  version: 1
  /** Gate id to the sorted list of violation keys it is allowed to report. */
  entries: Readonly<Record<string, readonly string[]>>
}

/** Path of the ledger, relative to the repository root. */
export const BASELINE_REL = 'scripts/harness/baseline.json'

/** Read the ledger. A missing file is an empty ledger, not an error. */
export function readBaseline(root: string): Baseline {
  const path = resolve(root, BASELINE_REL)
  if (!existsSync(path)) return { version: 1, entries: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${BASELINE_REL} must be a JSON object`)
  const record = parsed as { version?: unknown; entries?: unknown }
  if (record.version !== 1) throw new Error(`${BASELINE_REL}: unsupported version (expected 1)`)
  if (record.entries === undefined) return { version: 1, entries: {} }
  if (typeof record.entries !== 'object' || record.entries === null) {
    throw new Error(`${BASELINE_REL}: \`entries\` must be an object`)
  }
  const entries: Record<string, readonly string[]> = {}
  for (const [gate, keys] of Object.entries(record.entries as Record<string, unknown>)) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
      throw new Error(`${BASELINE_REL}: \`${gate}\` must be an array of strings`)
    }
    entries[gate] = keys as string[]
  }
  return { version: 1, entries }
}

/** Write the ledger with stable key ordering so diffs stay readable. */
export function writeBaseline(root: string, baseline: Baseline): void {
  const sorted = Object.fromEntries(
    Object.entries(baseline.entries)
      .filter(([, keys]) => keys.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gate, keys]) => [gate, [...keys].sort()]),
  )
  const path = resolve(root, BASELINE_REL)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`)
}

/** Outcome of applying a ledger to the violations a gate just found. */
export interface BaselineOutcome<T> {
  /** Violations not covered by the ledger; these fail the gate. */
  remaining: T[]
  /** Violations the ledger covers, and which therefore do not fail the gate. */
  suppressed: T[]
  /** Ledger keys that matched nothing this run; the ledger can shrink by these. */
  stale: string[]
}

/**
 * Split violations into recorded debt and new debt. `keyOf` must be stable under
 * unrelated edits (a link target, not a line number) or the ledger churns.
 */
export function applyBaseline<T>(
  baseline: Baseline,
  gate: string,
  violations: readonly T[],
  keyOf: (violation: T) => string,
): BaselineOutcome<T> {
  const recorded = new Set(baseline.entries[gate] ?? [])
  const remaining: T[] = []
  const suppressed: T[] = []
  const matched = new Set<string>()
  for (const violation of violations) {
    const key = keyOf(violation)
    if (recorded.has(key)) {
      suppressed.push(violation)
      matched.add(key)
    } else {
      remaining.push(violation)
    }
  }
  const stale = [...recorded].filter(key => !matched.has(key)).sort()
  return { remaining, suppressed, stale }
}

/**
 * Report the ledger's effect. Stale entries are surfaced every run so the file
 * shrinks instead of quietly accumulating dead keys.
 */
export function reportBaseline(outcome: BaselineOutcome<unknown>, gate: string): void {
  if (outcome.suppressed.length > 0) {
    console.log(`  ${gate}: ${outcome.suppressed.length} recorded in ${BASELINE_REL} (pre-existing debt, not counted).`)
  }
  if (outcome.stale.length > 0) {
    console.log(`  ${gate}: ${outcome.stale.length} ledger ${outcome.stale.length === 1 ? 'entry is' : 'entries are'} no longer matching anything; re-record to drop them.`)
  }
}

/** Keys a re-record would add to a ledger that already holds entries for this gate. */
export function baselineGrowth(baseline: Baseline, gate: string, keys: readonly string[]): string[] {
  const existing = new Set(baseline.entries[gate] ?? [])
  return keys.filter(key => !existing.has(key))
}

/** Outcome of the shared gate wiring. */
export type BaselineRun<T> =
  | { readonly action: 'recorded' }
  | { readonly action: 'checked'; readonly outcome: BaselineOutcome<T> }

/**
 * Wire a gate to the ledger, so every gate enforces the same adoption policy:
 * `--write-baseline` records the current violations as accepted debt and reports
 * `recorded`; any other run reports the violations the ledger does not already cover.
 *
 * Growing a ledger that already exists is refused unless `--accept-new` says so out
 * loud: the difference between recording day-one debt and ignoring a regression is
 * one flag the reviewer can see in the command, not a judgement call buried in a diff.
 */
export function runBaselineGate<T>(
  root: string,
  gate: string,
  violations: readonly T[],
  keyOf: (violation: T) => string,
  argv: readonly string[] = process.argv,
): BaselineRun<T> {
  let baseline: Baseline
  try {
    baseline = readBaseline(root)
  } catch (error: unknown) {
    console.error(`${gate}: ${error instanceof Error ? error.message : String(error)}`)
    return process.exit(1)
  }

  const keys = violations.map(keyOf)
  if (!argv.includes('--write-baseline')) {
    return { action: 'checked', outcome: applyBaseline(baseline, gate, violations, keyOf) }
  }

  const recorded = baseline.entries[gate] ?? []
  const growth = baselineGrowth(baseline, gate, keys)
  if (recorded.length === 0 && keys.length === 0) {
    console.log(`${gate}: no violations to record; ${BASELINE_REL} left untouched.`)
    return { action: 'recorded' }
  }
  if (recorded.length > 0 && growth.length > 0 && !argv.includes('--accept-new')) {
    console.error(`${gate}: ${BASELINE_REL} records ${recorded.length} entr${recorded.length === 1 ? 'y' : 'ies'} and this run found ${growth.length} more:`)
    for (const key of growth) console.error(`  + ${key}`)
    console.error('Fix them, or pass --accept-new to record them as accepted debt.')
    process.exit(1)
  }

  writeBaseline(root, { version: 1, entries: { ...baseline.entries, [gate]: keys } })
  console.log(`${gate}: recorded ${keys.length} existing violation(s) in ${BASELINE_REL}.`)
  if (recorded.length > 0) {
    const dropped = recorded.filter(key => !keys.includes(key)).length
    console.log(`  ${growth.length} newly accepted, ${dropped} fixed since the last recording and now dropped.`)
  }
  console.log('The ledger is debt, not approval: shrink it as the debt is paid down.')
  return { action: 'recorded' }
}
