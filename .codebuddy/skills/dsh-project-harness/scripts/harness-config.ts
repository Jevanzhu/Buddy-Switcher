/**
 * Read `.agents/notes/harness.json`, the notes corpus's language and pairing
 * configuration. Both the active-tree gates and the archive gate resolve it
 * through this module so one repository cannot be read two different ways.
 *
 * Every field is optional. Defaults describe the upstream corpus: English
 * primary files, no paired counterparts required. A corpus that maintains
 * paired documents is the deliberate choice and must say so.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCALES, type Locale } from './aliases.ts'

/** The resolved configuration of a notes corpus. */
export interface HarnessConfig {
  /** Require the archived triplet (primary file, counterpart, consistency record). */
  pairedDocuments: boolean
  /** The language of `yyyy-mm-dd-topic.md`; counterparts carry the other tier. */
  primaryLanguage: Locale
}

/** Repository path of the configuration file, for error messages. */
export const HARNESS_CONFIG_PATH = '.agents/notes/harness.json'

const DEFAULT_CONFIG: HarnessConfig = { pairedDocuments: false, primaryLanguage: 'en' }

/**
 * Resolve the corpus configuration. Returns the defaults with one error per
 * rejected field, so a malformed file fails the gate instead of silently
 * reverting to the default language.
 */
export function readHarnessConfig(notesRoot: string): { config: HarnessConfig; errors: string[] } {
  const errors: string[] = []
  const config = { ...DEFAULT_CONFIG }
  const configPath = resolve(notesRoot, 'harness.json')
  if (!existsSync(configPath)) return { config, errors }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error: unknown) {
    errors.push(`${HARNESS_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`)
    return { config, errors }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(`${HARNESS_CONFIG_PATH}: expected a JSON object`)
    return { config, errors }
  }
  const record = parsed as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'pairedDocuments' && key !== 'primaryLanguage') {
      errors.push(`${HARNESS_CONFIG_PATH}: unknown field ${JSON.stringify(key)} (allowed: pairedDocuments, primaryLanguage)`)
    }
  }
  const paired = record.pairedDocuments
  if (paired !== undefined) {
    if (typeof paired !== 'boolean') errors.push(`${HARNESS_CONFIG_PATH}: \`pairedDocuments\` must be a boolean`)
    else config.pairedDocuments = paired
  }
  const primary = record.primaryLanguage
  if (primary !== undefined) {
    if (typeof primary !== 'string' || !(LOCALES as readonly string[]).includes(primary)) {
      errors.push(`${HARNESS_CONFIG_PATH}: \`primaryLanguage\` must be one of ${LOCALES.join(', ')}`)
    } else {
      config.primaryLanguage = primary as Locale
    }
  }
  return { config, errors }
}
