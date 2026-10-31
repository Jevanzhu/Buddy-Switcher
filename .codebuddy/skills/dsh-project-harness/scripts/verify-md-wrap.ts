/**
 * Enforce one physical line per paragraph: a paragraph broken across lines makes
 * diffs, review, and translation pairing harder to follow.
 *
 * Lists, tables, headings, and fenced blocks keep their own formatting. A line is a
 * violation when it is prose that continues into another prose line inside the same
 * block.
 *
 *   node scripts/harness/verify-md-wrap.ts [--root <path>] [--list]
 *   node scripts/harness/verify-md-wrap.ts --write-baseline [--accept-new]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { proseLines } from './markdown.ts'
import { markdownFiles } from './verify-md-links.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'
import { reportBaseline, runBaselineGate } from './baseline.ts'

/** A prose line that should have been joined with the next one. */
interface Violation {
  path: string
  line: number
  next: number
  /** The prose line's own text, used to key the debt ledger by content. */
  text: string
  /** The continuation line's text. */
  nextText: string
}

/** Whether a line starts a block that owns its own line: heading, list, table, quote. */
function startsOwnBlock(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed === ''
    || /^#{1,6}\s/.test(trimmed)
    || /^([-*+]|\d+[.)])\s/.test(trimmed)
    || /^>/.test(trimmed)
    || /^\|/.test(trimmed)
    || /^<[a-zA-Z/!]/.test(trimmed)
    || /^(---|\*\*\*|___)\s*$/.test(trimmed)
}

/**
 * Find prose lines that continue into the next line. A continuation is a
 * non-blank line whose predecessor is also non-blank prose.
 */
export function findWrapViolations(source: string): Violation[] {
  const lines = proseLines(source)
  const violations: Violation[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index]
    const next = lines[index + 1]
    if (current === undefined || next === undefined) continue
    if (current.text.trim() === '' || next.text.trim() === '') continue
    if (startsOwnBlock(current.text) || startsOwnBlock(next.text)) continue
    // A line ending in a hard break is an intentional wrap, not a violation.
    if (current.text.endsWith('\\') || current.text.endsWith('  ')) continue
    // A table row continued by another table row is normal table layout.
    if (current.text.trimStart().startsWith('|') && next.text.trimStart().startsWith('|')) continue
    violations.push({ path: '', line: current.line, next: next.line, text: current.text.trim(), nextText: next.text.trim() })
  }
  return violations
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-md-wrap: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const files = markdownFiles(root)
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'))
    process.exit(0)
  }

  const violations: Violation[] = []
  for (const path of files) {
    for (const violation of findWrapViolations(readFileSync(resolve(root, path), 'utf8'))) {
      violations.push({ ...violation, path })
    }
  }

  // A line number shifts under any edit above it, so the ledger keys on the two
  // lines' text: unchanged prose stays recorded, and editing the paragraph is what
  // re-surfaces the violation — which is exactly when someone should join it.
  const run = runBaselineGate(
    root,
    'markdown-wrap',
    violations,
    (violation: Violation): string => `${violation.path}|${violation.text} ⏎ ${violation.nextText}`,
  )
  if (run.action === 'recorded') process.exit(0)

  const outcome = run.outcome
  const remaining = outcome.remaining
  if (remaining.length === 0) {
    console.log(`verify-md-wrap: ${files.length} Markdown file(s) scanned, one physical line per paragraph.`)
    reportBaseline(outcome, 'markdown-wrap')
    process.exit(0)
  }

  // Suppressed violations are counted, not listed: a recorded paragraph that later
  // disappears shows up as a stale ledger entry instead.
  console.error('verify-md-wrap: paragraphs broken across lines:')
  for (const violation of remaining.slice(0, 200)) {
    console.error(`  ${violation.path}:${violation.line} — continues onto line ${violation.next}; join into one physical line`)
  }
  if (remaining.length > 200) console.error(`  ... and ${remaining.length - 200} more`)
  reportBaseline(outcome, 'markdown-wrap')
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
