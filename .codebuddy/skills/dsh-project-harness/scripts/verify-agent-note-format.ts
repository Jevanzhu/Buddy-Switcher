/**
 * Enforce Agent Note headers, lifecycle-specific sections, alternatives, retired
 * marker rules, and the bilingual pairing contract. Classification and filenames
 * belong to the sibling tree gate; frozen-archive triplets belong to the archive
 * gate. Exact format and grandfathering rules live in `.agents/notes/README.md`.
 *
 * Every note file is checked in its own language against that language's
 * skeleton: the primary file in the corpus's primary language, the counterpart
 * in the other. A paired note additionally carries the language switcher on line
 * 5, mirrors its counterpart section for section, and keeps the section-keyed
 * `foo.i18n.yaml` record in sync — `--write` re-records pairs whose structure is
 * already sound, which is the act of confirming the two sides consistent.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree, type AgentNote } from './agent-note-tree.ts'
import { resolveRepoRoot } from './harness-root.ts'
import {
  anyCanonicalHeading,
  headingFor,
  otherLocale,
  PROPOSAL_ERA_SLOTS,
  REQUIRED_SLOTS,
  sidecarName,
  slotOf,
  switcherLine,
  TITLE_PREFIX,
  type Locale,
  type SectionSlot,
} from './aliases.ts'
import { computePairRecord, pairRecordDiff, parsePairRecord, renderPairRecord } from './pair-record.ts'

/** The date these format rules took effect; the grandfather comment is valid only before it. */
const FORMAT_ADOPTED = '2026-07-05'

/** The exact comment a pre-format Agent Note carries in place of `## Alternatives considered`. */
const GRANDFATHER = '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->'

/** The retired debt marker that flagged pre-format bodies; banned so it cannot creep back. */
const LEGACY_MARKERS = ['XXX: legacy ADR/RFC body format', 'XXX: legacy ADR/Agent Note body format']

/** Status value per lifecycle. The label is shared across languages; only a rejected reason is prose. */
const STATUS_LABEL: Record<string, string> = {
  proposed: 'Status: proposed',
  implemented: 'Status: implemented',
}

let repoRoot: string
try {
  repoRoot = resolveRepoRoot()
} catch (error: unknown) {
  console.error(`verify-agent-note-format: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/** Re-record mode: confirm structurally sound pairs at their current contents. */
const writeMode = process.argv.slice(2).includes('--write')

const root = agentNoteRoot(repoRoot)
const { notes, errors, config } = walkAgentNoteTree(repoRoot)

/**
 * Keep a line unless a fenced example opened or closed on it. Format tokens inside
 * examples are not document structure.
 */
function proseText(source: string): string[] {
  const kept: string[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence) kept.push(line)
  }
  return kept
}

/** Every `##`…`######` heading of a document, in order, right-trimmed. */
function headingsOf(prose: readonly string[]): string[] {
  return prose.filter(line => /^#{2,6} /.test(line)).map(line => line.trimEnd())
}

/** The depth of a heading line. */
function depthOf(heading: string): number {
  let depth = 0
  while (heading[depth] === '#') depth += 1
  return depth
}

/** Whether the status line carries this lifecycle's exact label. */
function statusAccepted(line: string, lifecycle: string): boolean {
  if (lifecycle === 'rejected') return /^Status: rejected — .+$/.test(line)
  return line === STATUS_LABEL[lifecycle]
}

/**
 * Whether the counterpart mirrors the primary file's heading structure. Heading
 * depths must match one to one; a heading naming a canonical slot must answer the
 * same slot in the counterpart's language, and a bespoke heading must not collide
 * with any language's canonical name.
 */
function mirrorErrors(
  primary: readonly string[],
  counterpart: readonly string[],
  primaryName: string,
  primaryLocale: Locale,
  counterpartLocale: Locale,
): string[] {
  const errors: string[] = []
  const shared = Math.min(primary.length, counterpart.length)
  if (primary.length !== counterpart.length) {
    errors.push(`mirrors ${primary.length} heading(s) of \`${primaryName}\` but carries ${counterpart.length}`)
  }
  for (let index = 0; index < shared; index += 1) {
    const expectedDepth = depthOf(primary[index] ?? '')
    const actualDepth = depthOf(counterpart[index] ?? '')
    if (expectedDepth !== actualDepth) {
      errors.push(`heading ${index + 1} must be depth ${expectedDepth} to mirror \`${primary[index]}\` (got depth ${actualDepth} \`${counterpart[index]}\`)`)
      break
    }
  }
  const primarySections = primary.filter(heading => heading.startsWith('## '))
  const counterpartSections = counterpart.filter(heading => heading.startsWith('## '))
  // Extra or missing sections are the heading-count check's business; aligned
  // positions only are compared by slot below.
  const sharedSections = Math.min(primarySections.length, counterpartSections.length)
  for (let index = 0; index < sharedSections; index += 1) {
    const heading = counterpartSections[index] ?? ''
    const leftSlot = slotOf(primarySections[index] ?? '', primaryLocale)
    if (leftSlot !== undefined) {
      if (slotOf(heading, counterpartLocale) !== leftSlot) {
        errors.push(`section ${index + 1} must be \`${headingFor(leftSlot, counterpartLocale)}\` to mirror \`${primarySections[index]}\` (got \`${heading}\`)`)
      }
      continue
    }
    if (anyCanonicalHeading(heading)) {
      errors.push(`bespoke section \`${heading}\` uses a canonical heading name; rename it or mirror the canonical row`)
    }
  }
  return errors
}

/**
 * Check one note file against its own language's skeleton. `counterpartFile` is
 * the other member of the pair, present only when the note is paired; `date` is
 * the note's filename date, which bounds the grandfather comment.
 */
function lintFile(
  lifecycle: string,
  date: string,
  locale: Locale,
  source: string,
  counterpartFile: string | undefined,
): string[] {
  const problems: string[] = []
  const fail = (message: string): void => {
    problems.push(message)
  }
  const lines = source.split('\n')
  const prose = proseText(source)

  if (!(lines[0] ?? '').startsWith(TITLE_PREFIX)) fail(`line 1 must be \`${TITLE_PREFIX}<title>\``)
  if (lines[1] !== '') fail('line 2 must be blank')
  const statusLine = lines[2] ?? ''
  if (!/^Status: /.test(statusLine)) {
    fail(`line 3 must be a \`Status:\` line (${lifecycle} lifecycle)`)
  } else if (!statusAccepted(statusLine, lifecycle)) {
    fail(`line 3 must match the ${lifecycle} status grammar`)
  }
  if (lines[3] !== '') fail('line 4 must be blank')
  const statusLines = prose.filter(line => line.startsWith('Status:') && line !== statusLine)
  if (statusLines.length > 0 || prose.filter(line => line === statusLine).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }
  if (counterpartFile !== undefined) {
    const expected = switcherLine(locale, counterpartFile)
    if ((lines[4] ?? '') !== expected) fail(`line 5 must be the language switcher \`${expected}\``)
  }

  const h2s = headingsOf(prose).filter(heading => heading.startsWith('## '))
  if (h2s[0] !== headingFor('problem', locale)) {
    fail(`the first section must be \`${headingFor('problem', locale)}\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`)
  }
  for (const slot of REQUIRED_SLOTS[lifecycle] ?? ([] as readonly SectionSlot[])) {
    const heading = headingFor(slot, locale)
    if (!h2s.includes(heading)) fail(`missing the required \`${heading}\` section`)
  }
  if (lifecycle === 'implemented') {
    for (const heading of h2s) {
      const slot = slotOf(heading, locale)
      if (slot !== undefined && PROPOSAL_ERA_SLOTS.includes(slot)) {
        fail(`\`${heading}\` is a proposal-era heading; an implemented Agent Note states what is (fold it into ${headingFor('decision', locale)}/${headingFor('consequences', locale)}/${headingFor('testing', locale)})`)
      }
    }
  }

  const hasSection = h2s.includes(headingFor('alternatives', locale))
  const hasGrandfather = prose.includes(GRANDFATHER)
  if (hasSection && hasGrandfather) fail('carries both the alternatives section and the grandfather comment — drop the comment')
  if (!hasSection && !hasGrandfather) {
    fail(`missing \`${headingFor('alternatives', locale)}\` (a pre-format Agent Note whose alternatives are not reconstructible carries the grandfather comment instead — see .agents/notes/README.md § The file format)`)
  }
  if (hasGrandfather && date >= FORMAT_ADOPTED) fail(`the grandfather comment is only valid for Agent Notes dated before ${FORMAT_ADOPTED}`)

  if (prose.some(line => LEGACY_MARKERS.some(marker => line.includes(marker)))) fail('carries the retired legacy-format debt marker')
  return problems
}

/**
 * Check a paired note's section-keyed consistency record. In re-record mode a
 * structurally sound pair is re-recorded at its current contents instead; a pair
 * that already has problems of its own is never recorded, so a record can only
 * ever confirm a structurally sound pair.
 *
 * An uncomputable record (the sides' heading counts differ) reports nothing here:
 * the mirror check owns that violation.
 */
function pairRecordProblems(
  note: AgentNote,
  primarySource: string,
  counterpartSource: string,
  primaryLocale: Locale,
  hasStructuralProblems: boolean,
): string[] {
  const problems: string[] = []
  const sidecarRel = note.record ?? note.rel.replace(/[^/]+$/, sidecarName(basename(note.rel)))
  const computed = computePairRecord(primarySource, counterpartSource, primaryLocale)
  if (computed.record === undefined) return problems
  const sidecarAbs = resolve(root, sidecarRel)
  const rendered = renderPairRecord(basename(note.rel), computed.record)
  if (writeMode) {
    if (!hasStructuralProblems && (!existsSync(sidecarAbs) || readFileSync(sidecarAbs, 'utf8') !== rendered)) {
      writeFileSync(sidecarAbs, rendered)
      reRecorded += 1
    }
    return problems
  }
  if (!existsSync(sidecarAbs)) {
    problems.push(`format: ${note.rel} — missing \`${sidecarRel}\`; a pair is three sibling files (re-record with \`verify-agent-note-format.ts --write\`)`)
    return problems
  }
  const recorded = parsePairRecord(readFileSync(sidecarAbs, 'utf8'))
  if (recorded === undefined) {
    problems.push(`format: ${sidecarRel} — malformed consistency record`)
    return problems
  }
  for (const problem of pairRecordDiff(recorded, computed.record)) {
    problems.push(`format: ${sidecarRel} — ${problem}`)
  }
  return problems
}

let reRecorded = 0
for (const note of notes) {
  const problems: string[] = []
  const primaryLocale = config.primaryLanguage
  const primarySource = readFileSync(resolve(root, note.rel), 'utf8')
  const counterpartFile = note.counterpart === undefined ? undefined : basename(note.counterpart)
  for (const problem of lintFile(note.lifecycle, note.date, primaryLocale, primarySource, counterpartFile)) {
    problems.push(`format: ${note.rel} — ${problem}`)
  }

  if (note.counterpart !== undefined) {
    const counterpartLocale = otherLocale(primaryLocale)
    const counterpartSource = readFileSync(resolve(root, note.counterpart), 'utf8')
    for (const problem of lintFile(note.lifecycle, note.date, counterpartLocale, counterpartSource, basename(note.rel))) {
      problems.push(`format: ${note.counterpart} — ${problem}`)
    }
    for (const problem of mirrorErrors(
      headingsOf(proseText(primarySource)),
      headingsOf(proseText(counterpartSource)),
      basename(note.rel),
      primaryLocale,
      counterpartLocale,
    )) {
      problems.push(`format: ${note.counterpart} — ${problem}`)
    }
    problems.push(...pairRecordProblems(note, primarySource, counterpartSource, primaryLocale, problems.length > 0))
  }
  errors.push(...problems)
}

if (errors.length === 0) {
  const verdict = writeMode
    ? `; re-recorded ${reRecorded} pair consistency record(s).`
    : ', all conform to .agents/notes/README.md § The file format.'
  console.log(`verify-agent-note-format: ${notes.length} Agent Note(s) checked${verdict}`)
  process.exit(0)
}

console.error('verify-agent-note-format: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
