/**
 * Shared Markdown line scanning for the documentation gates. Zero dependencies:
 * these gates must run in a fresh clone with no install step.
 *
 * Fenced code blocks, inline code, and HTML comments are excluded from every
 * scan, so examples and quoted markup never trip a rule.
 */

/** One source line with its 1-based number. */
export interface SourceLine {
  line: number
  text: string
}

/**
 * Whether a fenced block opens at this line, and the fence marker it uses.
 * Indentation is deliberately unconstrained: a fence inside a list item carries the
 * list's indentation, and treating it as prose would flag every code sample as
 * hard-wrapped text.
 */
function fenceOpener(line: string): string | undefined {
  const match = /^\s*(`{3,}|~{3,})/.exec(line)
  return match?.[1]
}

/**
 * Blank out the leading YAML frontmatter block and VitePress container markers.
 * Frontmatter is metadata: its field continuation lines are not prose paragraphs,
 * and a link inside a `description:` field is not a document reference.
 */
function maskNonProseBlocks(lines: readonly string[]): string[] {
  const masked = [...lines]
  if (masked[0]?.trim() === '---') {
    for (let index = 1; index < masked.length; index += 1) {
      const isClosing = masked[index]?.trim() === '---'
      masked[index] = ''
      if (isClosing) break
    }
    masked[0] = ''
  }
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index]?.trimStart().startsWith(':::')) masked[index] = ''
  }
  return masked
}

/**
 * Return the lines that are prose: outside fenced blocks, frontmatter, container
 * markers, and multi-line HTML comments. Inline code spans are left in place —
 * callers that care strip them.
 */
export function proseLines(source: string): SourceLine[] {
  const kept: SourceLine[] = []
  let fence: string | undefined
  let inComment = false
  const lines = maskNonProseBlocks(source.split('\n'))
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? ''
    const opener = fenceOpener(text)
    if (fence !== undefined) {
      // A closing fence uses the same character and is at least as long.
      if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) fence = undefined
      continue
    }
    if (opener !== undefined) {
      fence = opener
      continue
    }
    let visible = text
    if (inComment) {
      const end = visible.indexOf('-->')
      if (end === -1) continue
      visible = visible.slice(end + 3)
      inComment = false
    }
    // Drop any complete comments on this line, then detect an unterminated opener.
    for (;;) {
      const start = visible.indexOf('<!--')
      if (start === -1) break
      const end = visible.indexOf('-->', start + 4)
      if (end === -1) {
        visible = visible.slice(0, start)
        inComment = true
        break
      }
      visible = `${visible.slice(0, start)}${visible.slice(end + 3)}`
    }
    kept.push({ line: index + 1, text: visible })
  }
  return kept
}

/** Strip inline code spans so their contents are not read as prose or links. */
export function stripInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, match => ' '.repeat(match.length))
}

/** A relative link or image target found in prose. */
export interface LinkTarget {
  line: number
  /** Raw target as written, without any title. */
  target: string
}

/**
 * Collect inline `[text](target)` and image `![alt](target)` targets. Reference-style
 * links and autolinks are out of scope: they are rare in this corpus and a false
 * "valid" is cheaper than a false violation.
 */
export function linkTargets(lines: readonly SourceLine[]): LinkTarget[] {
  const found: LinkTarget[] = []
  for (const { line, text } of lines) {
    const stripped = stripInlineCode(text)
    const pattern = /!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g
    for (const match of stripped.matchAll(pattern)) {
      const target = match[1]
      if (target !== undefined) found.push({ line, target })
    }
  }
  return found
}

/** Whether a target points somewhere other than a file in this repository. */
export function isExternalTarget(target: string): boolean {
  return target === ''
    || target.startsWith('#')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
    || target.startsWith('//')
}

/**
 * GitHub's heading slug: lowercase, drop punctuation but keep hyphens and
 * underscores, then turn spaces into hyphens. Underscores survive, so a heading
 * `### list_agents` is reachable as `#list_agents`.
 */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** Explicit `<a id="...">` / `<a name="...">` anchors a document declares. */
export function explicitAnchors(lines: readonly SourceLine[]): string[] {
  const ids: string[] = []
  for (const { text } of lines) {
    for (const match of text.matchAll(/<a\s+[^>]*?(?:id|name)="([^"]+)"/gi)) {
      if (match[1] !== undefined) ids.push(match[1])
    }
  }
  return ids
}

/** Every heading slug a document defines, plus its explicit anchors. */
export function documentAnchors(source: string): Set<string> {
  const lines = proseLines(source)
  const anchors = new Set<string>(explicitAnchors(lines))
  const seen = new Map<string, number>()
  for (const { text } of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(text)
    const heading = match?.[2]
    if (heading === undefined) continue
    const base = githubSlug(heading)
    // A repeated heading gets a -1, -2, ... suffix in the same order GitHub assigns.
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}
