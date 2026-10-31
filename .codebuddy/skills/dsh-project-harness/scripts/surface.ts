/**
 * The source-surface scanner, shared by every gate that must read a repository's own
 * text without ever reading its literals: comment hygiene looks at the comment surface,
 * test hygiene looks at the code surface. One implementation, one set of shapes — a
 * gate and a cleaner each carrying their own scanner is how they come to disagree about
 * what a violation looks like.
 *
 * The machine is lexical over the C-family forms (`//`, `/* *\/`): it skips string and
 * template literals (returning into code after an interpolation, so `${}` content is
 * code again), and reads a slash after an operator as a regex literal rather than a
 * division. Misreading a regex degrades to scanning it as code, never to reporting a
 * literal's text as a comment.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

/** Comment syntaxes this scanner understands: the JavaScript/TypeScript family. */
export const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Never walked: dependencies and build output are not this repository's prose. */
export const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'coverage'])

/** A half-open range of source offsets. */
export interface Span {
  start: number
  end: number
}

/** Comment content per source line, plus the line as written. */
export interface CommentLine {
  /** 1-based line number. */
  line: number
  /** Comment content on that line; empty when the line holds no comment. */
  text: string
  /** The whole source line, as written. */
  raw: string
}

/** What to walk: the roots, and which extensions count as source. */
export interface ScanSpec {
  scan: string[]
  extensions?: string[]
}

type Frame = { kind: 'template'; start: number } | { kind: 'interp'; depth: number }

/** Skip a quoted string starting at `start`; an unterminated one stops at the newline. */
function skipQuoted(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') { index += 2; continue }
    if (ch === quote) return index + 1
    if (ch === '\n') return index
    index += 1
  }
  return index
}

/**
 * Whether the slash at `index` opens a regular expression rather than a division.
 * Heuristic by design: an expression can start after an operator or a bracket, not
 * after a value.
 */
function startsRegex(source: string, index: number): boolean {
  let back = index - 1
  while (back >= 0 && /\s/.test(source[back] ?? '')) back -= 1
  if (back < 0) return true
  return /[([{,;:=!&|?+\-*%~^<>]/.test(source[back] ?? '')
}

/** Skip a regular expression literal starting at `start`. */
function skipRegex(source: string, start: number): number {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') { index += 2; continue }
    if (ch === '\n') return start + 1
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return index + 1
    index += 1
  }
  return index
}

/**
 * Walk the source once and report where comments and literals are. A template literal's
 * span covers the whole template, including its interpolations; the strings and comments
 * inside an interpolation are reported separately.
 */
export function scanSpans(source: string): { comments: Span[]; literals: Span[] } {
  const comments: Span[] = []
  const literals: Span[] = []
  const frames: Frame[] = []
  let index = 0
  const inCode = (): boolean => frames.length === 0 || frames.at(-1)?.kind === 'interp'
  while (index < source.length) {
    const ch = source[index] ?? ''
    if (!inCode()) {
      if (ch === '\\') { index += 2; continue }
      if (ch === '`') {
        const frame = frames.pop()
        if (frame !== undefined) literals.push({ start: frame.start, end: index + 1 })
        index += 1
        continue
      }
      if (ch === '$' && source[index + 1] === '{') { frames.push({ kind: 'interp', depth: 1 }); index += 2; continue }
      index += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(source, index)
      literals.push({ start: index, end })
      index = end
      continue
    }
    if (ch === '`') { frames.push({ kind: 'template', start: index }); index += 1; continue }
    if (ch === '/' && source[index + 1] === '/') {
      const start = index + 2
      let end = source.indexOf('\n', start)
      if (end === -1) end = source.length
      comments.push({ start, end })
      index = end
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const start = index + 2
      const close = source.indexOf('*/', start)
      const end = close === -1 ? source.length : close
      comments.push({ start, end })
      index = close === -1 ? source.length : close + 2
      continue
    }
    if (ch === '/' && startsRegex(source, index)) {
      const end = skipRegex(source, index)
      literals.push({ start: index, end })
      index = end
      continue
    }
    const top = frames.at(-1)
    if (top?.kind === 'interp') {
      if (ch === '{') top.depth += 1
      else if (ch === '}') {
        top.depth -= 1
        if (top.depth <= 0) frames.pop()
      }
    }
    index += 1
  }
  return { comments, literals }
}

/** Comment content spans as `[start, end)` offsets into the source. */
export function commentSpans(source: string): Span[] {
  return scanSpans(source).comments
}

/** Comment content per source line. A multi-line block comment lands on every line it covers. */
export function commentLines(source: string): CommentLine[] {
  const rawLines = source.split('\n')
  const lines: CommentLine[] = rawLines.map((raw, index) => ({
    line: index + 1,
    text: '',
    raw: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
  }))
  const starts: number[] = []
  let offset = 0
  for (const raw of rawLines) {
    starts.push(offset)
    offset += raw.length + 1
  }
  const lineOf = (position: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if ((starts[mid] ?? 0) > position) high = mid - 1
      else low = mid
    }
    return low + 1
  }

  for (const span of commentSpans(source)) {
    let line = lineOf(span.start)
    let cursor = span.start
    while (cursor < span.end && line <= lines.length) {
      const lineEnd = (starts[line - 1] ?? 0) + (rawLines[line - 1]?.length ?? 0)
      const stop = Math.min(span.end, lineEnd)
      const piece = source.slice(cursor, stop)
      const target = lines[line - 1]
      if (target !== undefined && piece !== '') {
        target.text = target.text === '' ? piece : `${target.text} ${piece}`
      }
      cursor = stop + 1
      line += 1
    }
  }
  return lines
}

/**
 * The source with comments and literal contents blanked. Delimiters survive, so a caller
 * can still see that an argument was a literal; newlines survive, so line numbers still
 * line up; nothing inside a comment or a literal can ever match a rule.
 */
export function codeSurface(source: string): string {
  const chars = source.split('')
  const blank = (start: number, end: number): void => {
    for (let index = Math.max(0, start); index < end && index < chars.length; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  const { comments, literals } = scanSpans(source)
  for (const span of comments) blank(span.start, span.end)
  for (const span of literals) blank(span.start + 1, span.end - 1)
  return chars.join('')
}

/** Files to scan, and every way the scan surface itself failed to be trustworthy. */
export function scanSurface(root: string, spec: ScanSpec): { files: string[]; problems: string[] } {
  const allowed = new Set(spec.extensions ?? DEFAULT_EXTENSIONS)
  const files: string[] = []
  const problems: string[] = []

  const walk = (absDir: string): string[] => {
    const found: string[] = []
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch (error: unknown) {
      problems.push(`${relative(root, absDir).split(sep).join('/')}: cannot read (${error instanceof Error ? error.message : String(error)})`)
      return found
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue
      const abs = resolve(absDir, entry.name)
      if (entry.isDirectory()) found.push(...walk(abs))
      else if (entry.isFile() && allowed.has(extname(entry.name).toLowerCase())) found.push(abs)
    }
    return found
  }

  for (const entry of spec.scan) {
    const abs = resolve(root, entry)
    if (!existsSync(abs)) {
      problems.push(`${entry}: scan root does not exist`)
      continue
    }
    let stats
    try {
      stats = statSync(abs)
    } catch (error: unknown) {
      problems.push(`${entry}: cannot read (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (stats.isFile()) {
      if (!allowed.has(extname(abs).toLowerCase())) {
        problems.push(`${entry}: declared file has no extension this scanner reads (${[...allowed].sort().join(' ')})`)
        continue
      }
      files.push(entry)
      continue
    }
    const collected = walk(abs)
    if (collected.length === 0) {
      problems.push(`${entry}: no scannable file under this root; a gate that scanned nothing must not pass`)
      continue
    }
    files.push(...collected.map(abs => relative(root, abs).split(sep).join('/')))
  }

  return { files: [...new Set(files)].sort(), problems }
}
