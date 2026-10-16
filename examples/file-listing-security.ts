import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'

/**
 * Resolve a client-supplied path against an explicit root and reject anything
 * that escapes it. Both `..` traversal and symlinks are checked: the final,
 * symlink-resolved destination must remain inside the root. This is used by
 * the `file-listing-server` example so its `list_files`, `get_file_info`,
 * `file://read`, and `watch_files` operations cannot reach files outside the
 * directory the server was started in.
 */

/** True when `candidate` is `root` itself or lives inside it. */
function isWithin (root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' ||
    (rel !== '..' && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

/**
 * Resolve symlinks on the deepest existing ancestor of `target`, then re-append
 * the remaining (currently non-existent) path components. This lets callers
 * verify containment even when the requested path does not exist yet, while
 * still following symlinks in every existing prefix.
 */
async function resolveSymlinks (target: string): Promise<string> {
  let existing = target
  const remainder: string[] = []

  for (;;) {
    try {
      const real = await fs.realpath(existing)
      return remainder.length === 0 ? real : join(real, ...remainder)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(existing)
      if (parent === existing) break
      remainder.unshift(basename(existing))
      existing = parent
    }
  }

  throw new Error(`Path is outside the allowed root: ${target}`)
}

/**
 * Resolve `userPath` against `root` and return the canonical path to use for
 * the filesystem operation, throwing if it escapes the root. `root` defaults
 * to the current working directory.
 */
export async function resolveWithinRoot (
  userPath: string,
  root: string = process.cwd()
): Promise<string> {
  const canonicalRoot = await fs.realpath(root)
  const resolved = resolve(canonicalRoot, userPath)
  const real = await resolveSymlinks(resolved)
  if (!isWithin(canonicalRoot, real)) {
    throw new Error(`Path is outside the allowed root: ${userPath}`)
  }
  return real
}
