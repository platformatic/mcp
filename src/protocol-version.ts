/**
 * Helpers for behaving according to the revision a client actually negotiated,
 * rather than always answering with the newest one we implement.
 *
 * Protocol versions are `YYYY-MM-DD` strings, so ordering them is a plain
 * lexicographic comparison.
 */

/** The revision that introduced tasks, icons, URL elicitation and the JSON Schema dialect */
export const REVISION_2025_11_25 = '2025-11-25'

/**
 * True when `version` is `minimum` or newer. An absent version is treated as
 * older than everything, so features stay off unless we positively know better.
 */
export function atLeast (version: string | undefined, minimum: string): boolean {
  if (!version) return false
  return version >= minimum
}

/** Task-augmented execution and the `tasks/*` methods (SEP-1686) */
export function supportsTasks (version: string | undefined): boolean {
  return atLeast(version, REVISION_2025_11_25)
}

/** `icons` metadata on tools, resources, resource templates and prompts (SEP-973) */
export function supportsIcons (version: string | undefined): boolean {
  return atLeast(version, REVISION_2025_11_25)
}

/** `execution.taskSupport` on tool definitions (SEP-1686) */
export function supportsToolExecutionMetadata (version: string | undefined): boolean {
  return atLeast(version, REVISION_2025_11_25)
}

/** Declaring JSON Schema 2020-12 as the dialect of published schemas (SEP-1613) */
export function supportsSchemaDialect (version: string | undefined): boolean {
  return atLeast(version, REVISION_2025_11_25)
}

/** URL mode elicitation (SEP-1036) */
export function supportsUrlElicitation (version: string | undefined): boolean {
  return atLeast(version, REVISION_2025_11_25)
}

/**
 * Remove definition fields a revision does not define, so a client never sees a
 * field the revision it negotiated has no meaning for.
 */
export function trimDefinitionToRevision<T extends Record<string, any>> (definition: T, version: string | undefined): T {
  if (supportsIcons(version) && supportsToolExecutionMetadata(version)) {
    return definition
  }

  const trimmed: Record<string, any> = { ...definition }
  if (!supportsIcons(version)) {
    delete trimmed.icons
  }
  if (!supportsToolExecutionMetadata(version)) {
    delete trimmed.execution
  }
  return trimmed as T
}

/**
 * Drop capabilities that postdate the negotiated revision, so we never advertise
 * something the client's revision cannot express.
 */
export function capabilitiesForRevision<T extends Record<string, any>> (capabilities: T, version: string | undefined): T {
  if (supportsTasks(version) || capabilities.tasks === undefined) {
    return capabilities
  }

  const { tasks, ...rest } = capabilities
  return rest as T
}
