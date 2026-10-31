/**
 * Verify that relative links in Markdown resolve to a real file and that fragment
 * targets exist in their destination document.
 *
 * Scope is Markdown plus a small set of ignored directories; external URLs are not
 * fetched. This is a deliberately shallow scan — it proves a target exists, not that
 * the prose around it is accurate.
 *
 *   node scripts/harness/verify-md-links.ts [--root <path>] [--list]
 *   node scripts/harness/verify-md-links.ts --write-baseline [--accept-new]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { documentAnchors, isExternalTarget, linkTargets, proseLines } from './markdown.ts'
import { isEntryPoint, resolveRepoRoot } from './harness-root.ts'
import { runBaselineGate, reportBaseline } from './baseline.ts'

/** A resolved link that points at nothing. */
interface Violation {
  path: string
  line: number
  target: string
  reason: string
}

/** Build artifacts and dependency trees: never authored documentation. */
const BUILD_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.cache', '.next', '.turbo', '.venv', '__pycache__', 'vendor',
])

/**
 * Directories holding recorded or expected output rather than authored prose.
 * Their Markdown quotes model- or test-generated text, so placeholder links such as
 * `path/to/image.png` are content, not broken references. Add a pattern file to
 * include one deliberately.
 */
const GENERATED_CONTENT_DIRECTORIES = new Set([
  'expected', 'fixtures', '__snapshots__', 'snapshots', 'cassettes', 'recordings',
])

/** A glob reached by `**`: matches any number of path segments. */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      // `**/` spans directories; a trailing `**` spans the rest.
      if (pattern[index + 2] === '/') {
        source += '(?:[^/]+/)*'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char !== undefined && '.+^${}()|[]\\'.includes(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

/** An optional include list; when present it replaces the default directory walk. */
function readPatterns(root: string): RegExp[] | undefined {
  const path = resolve(root, 'scripts/harness/markdown-patterns.json')
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) {
    throw new Error('scripts/harness/markdown-patterns.json must be an array of glob strings')
  }
  return parsed.map(entry => globToRegExp(entry as string))
}

/**
 * Read the root `.gitignore` and return the paths it excludes, relative to the root.
 * Only directory and literal path entries are honored: gitignore's full pattern
 * language would make a documentation gate harder to predict than the problems it
 * catches. A glob segment ends the entry, so `dist/**` excludes `dist` while
 * `Dev/reference-clone` excludes exactly that path and leaves its parent scanned —
 * reading only the first segment would drop the whole `Dev` tree, silently voiding
 * every scan surface under it.
 */
function gitignoredPaths(root: string): Set<string> {
  const path = resolve(root, '.gitignore')
  const ignored = new Set<string>()
  if (!existsSync(path)) return ignored
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const literal: string[] = []
    for (const segment of line.replace(/^\/+/, '').split('/')) {
      if (segment === '') continue
      if (segment.includes('*') || segment.includes('?')) break
      literal.push(segment)
    }
    if (literal.length > 0) ignored.add(literal.join('/'))
  }
  return ignored
}

/** Every Markdown file under `root`, relative to it, honoring patterns when configured. */
export function markdownFiles(root: string): string[] {
  const patterns = readPatterns(root)
  const gitignored = gitignoredPaths(root)
  const found: string[] = []
  const walk = (absDir: string): void => {
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // The default walk skips dot directories: they hold tool state, not prose. A
      // pattern list may name one on purpose (`.agents/notes/**/*.md`), so the skip
      // yields to the declaration — otherwise that pattern silently matches nothing
      // and the surface looks checked while nothing under it ever was.
      if (entry.name.startsWith('.') && patterns === undefined) continue
      const abs = resolve(absDir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (gitignored.has(rel)) continue
      if (entry.isDirectory()) {
        if (BUILD_DIRECTORIES.has(entry.name)) continue
        // A pattern list decides for itself what to include.
        if (patterns === undefined && GENERATED_CONTENT_DIRECTORIES.has(entry.name)) continue
        walk(abs)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (patterns !== undefined && !patterns.some(pattern => pattern.test(rel))) continue
        found.push(rel)
      }
    }
  }
  walk(root)
  return found.sort()
}

/** Split a link target into its path and fragment parts. */
function splitTarget(target: string): { path: string; fragment: string } {
  const hash = target.indexOf('#')
  if (hash === -1) return { path: target, fragment: '' }
  return { path: target.slice(0, hash), fragment: target.slice(hash + 1) }
}

/** Find every link whose target file or anchor is missing. */
export function findLinkViolations(root: string, files: readonly string[]): Violation[] {
  const violations: Violation[] = []
  const anchorCache = new Map<string, Set<string>>()
  const anchorsOf = (relPath: string): Set<string> => {
    const cached = anchorCache.get(relPath)
    if (cached !== undefined) return cached
    const anchors = documentAnchors(readFileSync(resolve(root, relPath), 'utf8'))
    anchorCache.set(relPath, anchors)
    return anchors
  }

  for (const relPath of files) {
    const source = readFileSync(resolve(root, relPath), 'utf8')
    for (const { line, target } of linkTargets(proseLines(source))) {
      if (isExternalTarget(target)) continue
      const { path, fragment } = splitTarget(target)
      if (path === '') continue
      // Strip an optional query string before touching the filesystem.
      const cleanPath = path.split('?')[0] ?? path
      const decoded = safeDecode(cleanPath)
      const absTarget = resolve(dirname(resolve(root, relPath)), decoded)
      if (!existsSync(absTarget)) {
        violations.push({ path: relPath, line, target, reason: `target does not exist: ${decoded}` })
        continue
      }
      if (fragment === '') continue
      let stats
      try {
        stats = statSync(absTarget)
      } catch {
        continue
      }
      if (!stats.isFile() || !decoded.toLowerCase().endsWith('.md')) continue
      const relTarget = relative(root, absTarget).split(sep).join('/')
      if (!relTarget.startsWith('..') && !anchorsOf(relTarget).has(fragment)) {
        violations.push({ path: relPath, line, target, reason: `missing anchor #${fragment} in ${relTarget}` })
      }
    }
  }
  return violations
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function main(): void {
  let root: string
  try {
    root = resolveRepoRoot()
  } catch (error: unknown) {
    console.error(`verify-md-links: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const files = markdownFiles(root)
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'))
    process.exit(0)
  }
  // An empty scan surface passes every link check there is; the failure mode it
  // hides — a patterns file that matches nothing, or a root resolved too high — is
  // exactly the one worth failing on. Recording an empty surface is allowed: the
  // ledger has nothing to adopt, which is a fact rather than a silent pass.
  if (files.length === 0 && !process.argv.includes('--write-baseline')) {
    console.error('verify-md-links: no Markdown file to scan; a gate that scanned nothing must not pass (check `scripts/harness/markdown-patterns.json` and the repository root).')
    process.exit(1)
  }

  const violations = findLinkViolations(root, files)
  // A link target is stable under unrelated edits; a line number is not, so the
  // ledger keys on the target and survives reformatting above it.
  const run = runBaselineGate(
    root,
    'markdown-links',
    violations,
    (violation: Violation): string => `${violation.path}|${violation.target}`,
  )
  if (run.action === 'recorded') process.exit(0)

  const { outcome } = run
  const remaining = outcome.remaining
  if (remaining.length === 0) {
    console.log(`verify-md-links: ${files.length} Markdown file(s) scanned, every relative link resolves.`)
    reportBaseline(outcome, 'markdown-links')
    process.exit(0)
  }

  console.error('verify-md-links: broken links found:')
  for (const violation of remaining) {
    console.error(`  ${violation.path}:${violation.line} — ${violation.reason} (link target ${JSON.stringify(violation.target)})`)
  }
  reportBaseline(outcome, 'markdown-links')
  process.exit(1)
}

if (isEntryPoint(import.meta.url)) main()
