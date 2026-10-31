/** Pure archive-format, triplet, and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { classSlotAny, otherLocale, splitTier, tierSuffix, type Locale } from './aliases.ts'

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1
  files: Readonly<Record<string, string>>
}

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** Compute the SHA-1 Git blob id used by paired consistency sidecars. */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

/**
 * Reject any change to an already-sealed entry. Archival is append-only: a sealed
 * artifact may never be edited, rehashed, or removed. There is no exemption list —
 * a legitimate content change means the archive was sealed prematurely, and the
 * correction is a new note, not a rewritten seal.
 */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  const errors: string[] = []
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`)
    else if (actual !== expected) errors.push(`${path}: sealed manifest hash changed`)
  }
  return errors
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

interface Triplet {
  source?: Buffer
  counterpart?: Buffer
  /** The counterpart's sealed filename; its tier is read off the file, never assumed. */
  counterpartName?: string
  meta?: Buffer
}

/** Options controlling how strictly an archived artifact set is validated. */
export interface ArchiveValidationOptions {
  /**
   * Require the paired-document triplet: a primary file, a counterpart, and the
   * consistency sidecar recording both blob hashes. Set false for a monolingual
   * corpus, where the counterpart and its hash record cannot exist.
   */
  pairedDocuments: boolean
  /** The language of the primary file; the triplet's counterpart carries the other tier. */
  primaryLanguage: Locale
}

function pairMeta(content: string): Map<string, string> | undefined {
  const entries = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([^:#]+\.md): ([0-9a-f]{40})$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    entries.set(match[1], match[2])
  }
  return entries
}

function validateMetadata(path: string, content: Buffer, sourceBase: string): { errors: string[]; date: string | undefined } {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  const status = lines.findIndex(line => line.startsWith('Status:'))
  if (lines[status] !== 'Status: implemented') errors.push(`${path}: requires \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[status + 1] ?? '')?.[1]
  if (status < 0 || archived === undefined || !validDate(archived)) {
    errors.push(`${path}: requires \`Archived: YYYY-MM-DD\` with a valid date immediately after the status`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  return { errors, date: archived }
}

/**
 * Validate the closed kind tree, archive metadata, and the artifact set each note
 * shipped with. In paired mode the set is a complete triplet; in monolingual mode a
 * single primary file is complete.
 *
 * A kind directory is accepted in either language: sealed paths keep the spelling
 * they were sealed under, so a corpus that changed its declared language still reads
 * the entries archived before the change. New entries follow the declared language's
 * spelling; that rule belongs to the archive gate, which walks the tree.
 */
export function validateArchiveArtifacts(
  artifacts: ReadonlyMap<string, Buffer>,
  options: ArchiveValidationOptions,
): string[] {
  const errors: string[] = []
  const triplets = new Map<string, Triplet>()
  const counterpartSuffix = tierSuffix(otherLocale(options.primaryLanguage))
  const shapeAlternatives = options.pairedDocuments
    ? `{md,${counterpartSuffix.slice(1)},i18n.yaml}`
    : '{md}'
  for (const [path, content] of artifacts) {
    const match = /^([^/]+)\/(.+)$/.exec(path)
    const kind = match?.[1]
    const name = match?.[2]
    if (kind === undefined || name === undefined) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.${shapeAlternatives}`)
      continue
    }
    if (classSlotAny(kind) === undefined) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(kind)}`)
      continue
    }
    let role: 'source' | 'counterpart' | 'meta'
    let stem: string
    if (name.endsWith('.i18n.yaml')) {
      role = 'meta'
      stem = name.slice(0, -'.i18n.yaml'.length)
      if (stem.endsWith('.md')) {
        errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.${shapeAlternatives}`)
        continue
      }
    } else {
      const split = splitTier(name)
      stem = split.stem
      if (split.tier === undefined) {
        if (!name.endsWith('.md')) {
          errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.${shapeAlternatives}`)
          continue
        }
        role = 'source'
      } else {
        // The tier is read off the sealed file rather than against the current
        // declaration: a corpus that changed its declared language keeps the tiers it
        // sealed under, and re-reading them against the new primary would demand a
        // rename the seal forbids. What a new triplet must look like is the tree
        // gate's business — the archive only proves the set is complete.
        role = 'counterpart'
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}-.+$/.test(stem)) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.${shapeAlternatives}`)
      continue
    }
    const key = `${kind}/${stem}`
    const triplet = triplets.get(key) ?? {}
    if (role === 'source') triplet.source = content
    else if (role === 'counterpart') {
      triplet.counterpart = content
      triplet.counterpartName = name
    } else triplet.meta = content
    triplets.set(key, triplet)
  }

  for (const [key, triplet] of [...triplets].sort(([left], [right]) => left.localeCompare(right))) {
    const sourcePath = `${key}.md`
    const { source, counterpart, counterpartName, meta } = triplet
    if (source === undefined) {
      const found = [counterpartName, meta === undefined ? undefined : `${key}.i18n.yaml`]
        .filter((path): path is string => path !== undefined)
      errors.push(`${key}: archived note has no primary file (found ${found.join(', ')})`)
      continue
    }
    const sourceBase = basename(key)
    const { errors: sourceErrors, date: sourceDate } = validateMetadata(sourcePath, source, sourceBase)
    errors.push(...sourceErrors)

    if (!options.pairedDocuments) {
      // A stray counterpart is a configuration mismatch, not a formatting slip.
      if (counterpart !== undefined || meta !== undefined) {
        errors.push(`${key}: carries a counterpart or consistency record, but this repository is configured monolingual (set \`pairedDocuments\` to true in .agents/notes/harness.json)`)
      }
      continue
    }

    const missing = [
      counterpart === undefined ? `${key}${counterpartSuffix}` : undefined,
      meta === undefined ? `${key}.i18n.yaml` : undefined,
    ].filter((path): path is string => path !== undefined)
    if (missing.length > 0) {
      errors.push(`${key}: incomplete archived triplet; missing ${missing.join(', ')}`)
      continue
    }
    const { errors: counterpartErrors, date: counterpartDate } = validateMetadata(`${key}${counterpartName}`, counterpart!, sourceBase)
    errors.push(...counterpartErrors)
    if (sourceDate !== undefined && counterpartDate !== undefined && sourceDate !== counterpartDate) {
      errors.push(`${key}: primary and counterpart archive dates differ (${sourceDate} vs ${counterpartDate})`)
    }
    const pair = pairMeta(meta!.toString('utf8'))
    if (pair === undefined || pair.size !== 2
      || pair.get(`${sourceBase}.md`) !== gitBlobHash(source)
      || pair.get(counterpartName!) !== gitBlobHash(counterpart!)) {
      errors.push(`${key}.i18n.yaml: consistency record must contain the current Git blob hashes of both archived sides`)
    }
  }
  return errors
}

/** Preserve every sealed path/hash and append hashes for newly archived artifacts. */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = []
  const files: Record<string, string> = { ...existing.files }
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}
