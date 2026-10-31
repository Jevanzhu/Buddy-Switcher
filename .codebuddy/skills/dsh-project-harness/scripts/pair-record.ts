/**
 * Section-keyed consistency records for active bilingual pairs: `foo.i18n.yaml`
 * holds one entry per heading section, a hash of each side's blocks outside
 * fenced code blocks. Editing either side without re-recording the pair turns the
 * gate red, which is the mechanical half of "the two sides say the same thing".
 *
 * Keys are the primary side's heading-slug path (`/` for the preamble, `~2` on a
 * repeated path), so independent edits to different sections change separate
 * record lines and merge with Git's default text merge. Port note: blocks are
 * blank-line-separated runs of non-fence lines rather than parsed Markdown nodes,
 * which keeps this module dependency-free; the consequences are narrower only in
 * how a reformat of one section is spelled, never in whether an edit is detected.
 *
 * Archiving rewrites this record into the whole-file Git blob record that
 * `.agents/notes/archived/manifest.json` seals — see `archived-agent-notes.ts`.
 */

import { createHash } from 'node:crypto'
import type { Locale } from './aliases.ts'

/** One section's recorded hashes, one per language. */
export interface SectionHashes {
  en: string
  zh: string
}

/** Section key → hashes, in document order. */
export type PairRecord = ReadonlyMap<string, SectionHashes>

/** Section key line: `/heading/slug`, `/` for the preamble. */
const KEY_LINE = /^(\/[^\s:#]*):$/

/** Hash line: the fixed two-space indentation, the language, and 16 hex digits. */
const HASH_LINE = /^ {2}(en|zh): ([0-9a-f]{16})$/

/** A heading line starts a new section; its text names the key segment. */
const HEADING_LINE = /^#{1,6} /

/** Split a file into [key segment, block lines] sections. */
function sectionsOf(source: string): Array<{ heading: string | undefined; blocks: string[] }> {
  const sections: Array<{ heading: string | undefined; blocks: string[] }> = [{ heading: undefined, blocks: [] }]
  let inFence = false
  let block: string[] = []
  const flush = (): void => {
    if (block.length > 0) sections.at(-1)?.blocks.push(block.join('\n'))
    block = []
  }
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (HEADING_LINE.test(line)) {
      flush()
      sections.push({ heading: line, blocks: [] })
      continue
    }
    if (line.trim() === '') flush()
    else block.push(line.trimEnd())
  }
  flush()
  return sections
}

/** The key segment of a heading: lowercase, alphanumerics kept, everything else dashed. */
function slug(heading: string): string {
  const text = heading.replace(/^#{1,6} /, '')
  const slugged = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  return slugged === '' ? 'section' : slugged
}

/** sha256 over a section's blocks, truncated to 16 hex digits (the upstream width). */
function sectionHash(blocks: readonly string[]): string {
  return createHash('sha256').update(blocks.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Compute the record a pair's current contents deserve. Keys come from the
 * primary side; section `i` of one side answers section `i` of the other. A
 * section with no blocks on either side records no entry.
 *
 * Returns an error instead of a record when the two sides' heading counts differ:
 * the mirror check owns that violation, and a half-aligned record must not be
 * written.
 */
export function computePairRecord(
  primarySource: string,
  counterpartSource: string,
  primaryLocale: Locale,
): { record?: PairRecord; error?: string } {
  const primary = sectionsOf(primarySource)
  const counterpart = sectionsOf(counterpartSource)
  if (primary.length !== counterpart.length) {
    return { error: `the pair has ${primary.length - 1} heading(s) on one side and ${counterpart.length - 1} on the other` }
  }
  const record = new Map<string, SectionHashes>()
  const ancestors: Array<{ depth: number; slug: string }> = []
  const keys = new Set<string>()
  for (const [index, section] of primary.entries()) {
    let path = '/'
    if (section.heading !== undefined) {
      const depth = section.heading.match(/^#+/)?.[0].length ?? 1
      while ((ancestors.at(-1)?.depth ?? 0) >= depth) ancestors.pop()
      ancestors.push({ depth, slug: slug(section.heading) })
      path = `/${ancestors.map(ancestor => ancestor.slug).join('/')}`
    }
    let key = path
    for (let repeat = 2; keys.has(key); repeat += 1) key = `${path}~${repeat}`
    keys.add(key)
    const counterpartBlocks = counterpart[index]?.blocks ?? []
    if (section.blocks.length === 0 && counterpartBlocks.length === 0) continue
    const primaryHash = sectionHash(section.blocks)
    const counterpartHash = sectionHash(counterpartBlocks)
    record.set(key, primaryLocale === 'en'
      ? { en: primaryHash, zh: counterpartHash }
      : { en: counterpartHash, zh: primaryHash })
  }
  return { record }
}

/**
 * Parse a consistency record. Returns undefined for a malformed or duplicated
 * entry, so a hand-edited record fails loudly instead of dropping entries.
 */
export function parsePairRecord(content: string): PairRecord | undefined {
  const record = new Map<string, SectionHashes>()
  const lines = content.split('\n').filter(line => line !== '' && !line.startsWith('#'))
  for (let index = 0; index < lines.length; index += 3) {
    const key = KEY_LINE.exec(lines[index] ?? '')?.[1]
    const en = HASH_LINE.exec(lines[index + 1] ?? '')
    const zh = HASH_LINE.exec(lines[index + 2] ?? '')
    if (key === undefined || record.has(key) || en?.[1] !== 'en' || zh?.[1] !== 'zh' || en[2] === undefined || zh[2] === undefined) {
      return undefined
    }
    record.set(key, { en: en[2], zh: zh[2] })
  }
  return record
}

/** Render the canonical record text, with exactly one trailing newline. */
export function renderPairRecord(primaryFile: string, record: PairRecord): string {
  return [
    `# Bilingual-pair consistency record for ${primaryFile}: per heading section, a hash of`,
    '# each side\'s blocks outside fenced code blocks. After editing either side, bring the',
    '# other along and re-record the pair with:',
    '#   verify-agent-note-format.ts --write',
    ...[...record].flatMap(([key, hashes]) => [`${key}:`, `  en: ${hashes.en}`, `  zh: ${hashes.zh}`]),
    '',
  ].join('\n')
}

/**
 * Describe how a current record differs from the recorded one: one message per
 * changed, unconfirmed, or vanished section; empty when the pair is in sync.
 */
export function pairRecordDiff(recorded: PairRecord, current: PairRecord): string[] {
  const problems: string[] = []
  for (const [key, hashes] of current) {
    const confirmed = recorded.get(key)
    if (confirmed === undefined) {
      problems.push(`section ${key} has unconfirmed translated content`)
      continue
    }
    const sides = (['en', 'zh'] as const).filter(side => confirmed[side] !== hashes[side])
    if (sides.length > 0) problems.push(`section ${key} changed since confirmation (${sides.join(', ')})`)
  }
  for (const key of recorded.keys()) {
    if (!current.has(key)) problems.push(`section ${key} is recorded but no longer has translated content`)
  }
  return problems
}
