/**
 * Shared structural source of truth for the Agent Note tree. Lifecycle and class
 * sets are closed under `.agents/notes/README.md`; the language contract lives in
 * `aliases.ts` and `.agents/notes/harness.json`, and it spells the tree: the three
 * lifecycle folders, the six class folders, and the archive container all take the
 * corpus's declared language, so one tree never mixes the two spellings.
 *
 * A note is its primary-language file (`yyyy-mm-dd-topic.md`) plus an optional
 * counterpart in the other language. Both members of a pair are the same Agent
 * Note: the walk reports one entry per note, carrying the counterpart's path so
 * the format gate can check the pairing.
 */

import { globSync, readdirSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import {
  archiveDir,
  classDirs,
  classSlotAny,
  classSlotOf,
  lifecycleDir,
  lifecycleDirs,
  lifecycleSlotAny,
  lifecycleSlotOf,
  LIFECYCLE_SLOTS,
  otherLocale,
  SIDECAR_SUFFIX,
  splitTier,
  tierSuffix,
  type Locale,
} from './aliases.ts'
import { readHarnessConfig, type HarnessConfig } from './harness-config.ts'

/** Location of the Agent Note tree inside a repository. */
export function agentNoteRoot(repoRoot: string): string {
  return resolve(repoRoot, '.agents/notes')
}

/** Non-Agent Note Markdown allowed to sit directly at a lifecycle root. */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** One Agent Note, as discovered by the walker. */
export interface AgentNote {
  lifecycle: string
  /** Path of the primary-language file, relative to .agents/notes. */
  rel: string
  /** `yyyy-mm-dd` from the filename. */
  date: string
  /** Path of the counterpart written in the other language, when the note is paired. */
  counterpart?: string
  /** Path of the pair's section-keyed consistency record, when it exists. */
  record?: string
}

/** One note's files while the walk groups them by lifecycle, class, and stem. */
interface NoteGroup {
  cls: string
  stem: string
  primary?: string
  counterpart?: string
  record?: string
}

/**
 * Walk the Agent Note tree, enforcing the structure rules. Returns one entry per
 * Agent Note plus one error string per violation (unknown lifecycle or class
 * folder, bad depth, bad filename, or a counterpart without its primary file).
 * Callers treat a non-empty error list as fatal.
 */
export function walkAgentNoteTree(repoRoot: string): { notes: AgentNote[]; errors: string[]; config: HarnessConfig } {
  const root = agentNoteRoot(repoRoot)
  const { config, errors } = readHarnessConfig(root)
  const locale = config.primaryLanguage
  const archive = archiveDir(locale)
  const notes: AgentNote[] = []
  // An absent tree is a valid, empty corpus — gates stay green before the first note.
  let topLevel: string[]
  try {
    topLevel = readdirSync(root).filter(name => !name.startsWith('.'))
  } catch {
    return { notes, errors, config }
  }
  // The lifecycle set is closed too: any directory under .agents/notes/ that is not
  // a known lifecycle would otherwise hold Agent Notes invisible to the walk below.
  for (const name of topLevel) {
    if (name === 'INDEX.md') {
      errors.push('structure: INDEX.md — centralized Agent Note indexes are forbidden; browse the lifecycle/class tree or search the repository')
      continue
    }
    if (isDirectory(resolve(root, name)) && name !== archive && lifecycleSlotOf(name, locale) === undefined) {
      errors.push(lifecycleError(name, locale, archive))
    }
  }
  for (const lifecycle of LIFECYCLE_SLOTS) {
    const dir = lifecycleDir(lifecycle, locale)
    const groups = new Map<string, NoteGroup>()
    for (const match of globSync(`${dir}/**/*.md`, { cwd: root }).map(path => path.split(sep).join('/')).sort()) {
      const segs = match.split('/')
      // Allowlisted file directly at the lifecycle root (e.g. implemented/AGENTS.md).
      if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
      const clsName = segs[1]
      const base = segs[2]
      if (segs.length !== 3 || clsName === undefined || base === undefined) {
        errors.push(`structure: ${match} — expected {lifecycle}/{class}/file.md (got depth ${segs.length})`)
        continue
      }
      const cls = classSlotOf(clsName, locale)
      if (cls === undefined) {
        errors.push(classError(match, clsName, locale))
        continue
      }
      const { stem, tier } = splitTier(base)
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base) || !/^\d{4}-\d{2}-\d{2}-.+$/.test(stem)) {
        errors.push(`structure: ${match} — filename must be yyyy-mm-dd-topic.md`)
        continue
      }
      if (tier === config.primaryLanguage) {
        errors.push(`structure: ${match} — \`${tierSuffix(tier)}\` names the primary language; the primary file drops the tier (${stem}.md)`)
        continue
      }
      const key = `${cls}/${stem}`
      const group = groups.get(key) ?? { cls, stem }
      if (tier === undefined) group.primary = match
      else group.counterpart = match
      groups.set(key, group)
    }
    for (const [key, sidecar] of sidecarFiles(root, dir, locale, errors)) {
      const group = groups.get(key)
      if (group === undefined) {
        errors.push(`structure: ${sidecar} — consistency record without its note; a record belongs to a pair`)
        continue
      }
      group.record = sidecar
    }
    for (const group of groups.values()) {
      if (group.primary === undefined) {
        errors.push(`structure: ${group.counterpart} — counterpart without its primary file (${group.cls}/${group.stem}.md); a counterpart translates its note rather than standing alone`)
        continue
      }
      if (group.record !== undefined && group.counterpart === undefined) {
        errors.push(`structure: ${group.record} — consistency record without a counterpart file (${group.cls}/${group.stem}${tierSuffix(otherLocale(config.primaryLanguage))}); a record confirms a pair`)
      }
      notes.push({
        lifecycle,
        rel: group.primary,
        date: group.stem.slice(0, 10),
        counterpart: group.counterpart,
        record: group.record,
      })
    }
  }
  notes.sort((left, right) => left.rel.localeCompare(right.rel))
  return { notes, errors, config }
}

/** Reject a lifecycle folder that is not this corpus's name for one of the three. */
function lifecycleError(name: string, locale: Locale, archive: string): string {
  const foreign = lifecycleSlotAny(name) !== undefined || name === archiveDir(otherLocale(locale))
  const why = foreign
    ? ` — that is the ${otherLocale(locale)} spelling, and the two spellings never share one tree`
    : ''
  return `structure: ${name}/ — unknown lifecycle folder (allowed: ${lifecycleDirs(locale).join(', ')}, plus ${archive}/)${why}`
}

/** Reject a class folder that is not this corpus's name for one of the six. */
function classError(path: string, name: string, locale: Locale): string {
  const foreign = classSlotAny(name) !== undefined
  const why = foreign
    ? ` — that is the ${otherLocale(locale)} spelling; the corpus declares primaryLanguage "${locale}", so rename it or flip the declaration and move the tree with it`
    : ''
  return `structure: ${path} — unknown class folder "${name}" (allowed: ${classDirs(locale).join(', ')})${why}`
}

/** The section-keyed consistency records of one lifecycle, keyed by class and stem. */
function sidecarFiles(root: string, lifecycleDirName: string, locale: Locale, errors: string[]): Map<string, string> {
  const records = new Map<string, string>()
  for (const match of globSync(`${lifecycleDirName}/**/*.i18n.yaml`, { cwd: root }).map(path => path.split(sep).join('/')).sort()) {
    const segs = match.split('/')
    const clsName = segs[1]
    const base = segs[2]
    if (segs.length !== 3 || clsName === undefined || base === undefined) {
      errors.push(`structure: ${match} — expected {lifecycle}/{class}/file.i18n.yaml`)
      continue
    }
    const cls = classSlotOf(clsName, locale)
    if (cls === undefined) {
      errors.push(classError(match, clsName, locale))
      continue
    }
    const stem = base.slice(0, -SIDECAR_SUFFIX.length)
    if (stem.endsWith('.md')) {
      errors.push(`structure: ${match} — expected {lifecycle}/{class}/file.i18n.yaml`)
      continue
    }
    records.set(`${cls}/${stem}`, match)
  }
  return records
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
