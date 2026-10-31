/**
 * Resolve the repository a gate validates. Gates run from `cwd` so they work from
 * any subdirectory; `--root <path>` overrides for tests, CI, and cross-repository runs.
 *
 * This file is byte-identical in every bundled skill so the installer can copy it once.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A directory carrying any of these marks is a repository root. */
const ROOT_MARKERS = ['.git', '.agents/notes'] as const

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A path in comparable form: symlinks resolved when the path exists, absolute either way.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether the module at `moduleUrl` is the process entry point — the guard that decides
 * if a gate should run at all. Call it as `isEntryPoint(import.meta.url)`.
 *
 * The argument is required rather than defaulted: a default would be evaluated in THIS
 * module, so every gate would compare this file's path against the invoked one, answer
 * false, and exit 0 having checked nothing — the exact silent green the guard exists to
 * prevent. Missing the argument is a type error instead.
 *
 * It compares paths rather than reading `import.meta.main`: that property only exists from
 * Node 24.2 / 22.18, and everywhere else it reads as false. On Node 23.6–23.x — old enough
 * to lack the property, new enough to execute TypeScript — the guard would then be a silent
 * green on every gate using it. A guard must fail closed, never quietly.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const called = canonical(entry)
  const self = canonical(fileURLToPath(moduleUrl))
  return process.platform === 'win32' ? called.toLowerCase() === self.toLowerCase() : called === self
}

/**
 * Walk up from `start` to the nearest directory marked as a repository root, falling
 * back to `start` itself when no ancestor is marked (a fresh tree before bootstrap).
 */
export function findRepoRoot(start: string = process.cwd()): string {
  const origin = resolve(start)
  let current = origin
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(resolve(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return origin
    current = parent
  }
}

/**
 * Read `--root <path>` from argv. Returns undefined when absent, so callers can fall
 * back to discovery.
 */
export function parseRootArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--root')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--root requires a directory path')
  }
  return resolve(value)
}

/** Resolve the validated repository root: `--root` wins, otherwise discovery from cwd. */
export function resolveRepoRoot(argv: readonly string[] = process.argv.slice(2)): string {
  const explicit = parseRootArgument(argv)
  if (explicit === undefined) return findRepoRoot()
  if (!isDirectory(explicit)) throw new Error(`--root ${JSON.stringify(explicit)} is not a directory`)
  return explicit
}
