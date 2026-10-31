/**
 * Enforce Agent Note lifecycle/class paths and dated filenames. Structural rules
 * are shared with `agent-note-tree.ts`; the closed classification rules live
 * in `.agents/notes/README.md`.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { walkAgentNoteTree } from './agent-note-tree.ts'
import { resolveRepoRoot } from './harness-root.ts'

let repoRoot: string
try {
  repoRoot = resolveRepoRoot()
} catch (error: unknown) {
  console.error(`verify-agent-note-classification: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { notes, errors } = walkAgentNoteTree(repoRoot)

// Keep the former homes unavailable so new notes cannot silently escape this tree.
for (const legacyRoot of ['docs/rfc', 'docs/rfcs']) {
  if (existsSync(resolve(repoRoot, legacyRoot))) {
    errors.push(`legacy-path: ${legacyRoot}/ is forbidden — put Agent Notes under .agents/notes/`)
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-classification: ${notes.length} Agent Note(s) checked, structure consistent.`)
  process.exit(0)
}

console.error('verify-agent-note-classification: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
