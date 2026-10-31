/**
 * Enforce the word ceilings in `scripts/harness/doc-budgets.manifest.json`.
 * Missing files and invalid ceilings fail; `--list` reports current usage.
 * Only listed standing docs are budgeted. Ceilings ratchet down with at least
 * 5% headroom; raising one requires the justification defined in `docs/AGENTS.md`.
 *
 * A word is a whitespace-delimited token or one CJK ideograph — the counting rule
 * lives in `doc-words.ts`, shared with the bootstrap seed so ceilings and their
 * enforcement cannot be measured in different units.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { countDocWords } from './doc-words.ts'
import { resolveRepoRoot } from './harness-root.ts'

const MANIFEST_REL = 'scripts/harness/doc-budgets.manifest.json'

let root: string
try {
  root = resolveRepoRoot()
} catch (error: unknown) {
  console.error(`verify-doc-budgets: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const manifestPath = resolve(root, MANIFEST_REL)
if (!existsSync(manifestPath)) {
  console.error(`verify-doc-budgets: no budget manifest at ${MANIFEST_REL}; create it with the harness bootstrap script or write \`{}\` to disable budgeting.`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, number>

const listOnly = process.argv.includes('--list')
const failures: string[] = []
const rows: string[] = []

for (const [path, ceiling] of Object.entries(manifest)) {
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    rows.push(`BAD   ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: ceiling must be a positive integer, got ${ceiling}`)
    continue
  }
  const abs = resolve(root, path)
  if (!existsSync(abs)) {
    rows.push(`MISS  ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: budgeted file does not exist (renamed or deleted? update ${MANIFEST_REL} in the same change)`)
    continue
  }
  const words = countDocWords(readFileSync(abs, 'utf8'))
  rows.push(`${words <= ceiling ? 'ok  ' : 'OVER'}  ${String(words).padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
  if (words > ceiling) {
    failures.push(`${path}: ${words} words exceeds the ${ceiling}-word ceiling — relocate or condense per docs/AGENTS.md (raising the ceiling requires justification in the same change)`)
  }
}

if (listOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error('verify-doc-budgets failed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nSee docs/AGENTS.md for the documentation standard and the relocation-first rule.')
  process.exit(1)
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} budgeted docs within ceiling.`)
