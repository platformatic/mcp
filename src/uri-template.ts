const URI_TEMPLATE_REGEX = /\{[^}]+\}/
const VARNAME_REGEX = /^[A-Za-z0-9_]+$/

export function isTemplateUri (uri: string): boolean {
  return URI_TEMPLATE_REGEX.test(uri)
}

export interface CompiledUriTemplate {
  // Anchored regex for the URI, or for the part before '?' when the template
  // has query expressions
  regex: RegExp
  names: string[]
  // Variables of the trailing {?...}{&...} expressions, null when there are none
  queryNames: string[] | null
  // Number of literal characters, used to prefer the most specific template
  literalLength: number
}

const compiledUriTemplates = new Map<string, CompiledUriTemplate>()

/**
 * Compile the supported subset of RFC 6570 into a matcher:
 *
 * - `{name}`: one non-empty segment without `/`
 * - `{+name}`: one non-empty value that may contain `/` (but not `?` or `#`)
 * - `{/a,b}`: optional `/value` path segments
 * - `{?a,b}{&c}`: optional query parameters, in any order; these must
 *   trail the template
 *
 * Anything else (other operators, prefix/explode modifiers, multi-variable
 * `{a,b}` or `{+a,b}`) throws, so a template that could never be read is
 * rejected at registration instead of being listed.
 */
export function compileUriTemplate (template: string): CompiledUriTemplate {
  let compiled = compiledUriTemplates.get(template)
  if (compiled !== undefined) return compiled

  const unsupported = (reason: string) => new Error(`Unsupported URI template '${template}': ${reason}`)

  const names: string[] = []
  let queryNames: string[] | null = null
  let source = '^'
  let literalLength = 0
  let lastIndex = 0
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const body = match[1]
    const literal = template.slice(lastIndex, match.index)
    lastIndex = match.index + match[0].length
    literalLength += literal.length

    const operator = /^[+#./;?&=,!@|]/.test(body) ? body[0] : ''
    const vars = body.slice(operator.length).split(',')
    for (const name of vars) {
      if (!VARNAME_REGEX.test(name)) {
        throw unsupported(`expression '{${body}}' must list variable names made of letters, digits and '_' (modifiers are not supported)`)
      }
    }

    if (queryNames !== null && (literal !== '' || (operator !== '?' && operator !== '&'))) {
      throw unsupported('query expressions {?...} and {&...} must come last')
    }

    switch (operator) {
      case '':
      case '+':
        if (vars.length > 1) {
          throw unsupported(`expression '{${body}}' must have a single variable`)
        }
        source += escapeRegExp(literal) + (operator === '+' ? '([^?#]+)' : '([^/]+)')
        names.push(vars[0])
        break
      case '/':
        source += escapeRegExp(literal) + vars.map(() => '(?:/([^/?#]+))?').join('')
        names.push(...vars)
        break
      case '?':
        if (queryNames !== null || template.slice(0, match.index).includes('?')) {
          throw unsupported(`expression '{${body}}' follows another query component`)
        }
        source += escapeRegExp(literal)
        queryNames = [...vars]
        break
      case '&':
        if (queryNames === null) {
          throw unsupported(`expression '{${body}}' must follow a {?...} expression`)
        }
        queryNames.push(...vars)
        break
      default:
        throw unsupported(`operator '${operator}' is not supported`)
    }
  }

  const tail = template.slice(lastIndex)
  if (queryNames !== null && tail !== '') {
    throw unsupported('query expressions {?...} and {&...} must come last')
  }
  source += escapeRegExp(tail) + '$'
  literalLength += tail.length

  compiled = { regex: new RegExp(source), names, queryNames, literalLength }
  compiledUriTemplates.set(template, compiled)
  return compiled
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decode (raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function matchUriTemplate (compiled: CompiledUriTemplate, uri: string): Record<string, string> | null {
  let path = uri
  let query: string | undefined
  if (compiled.queryNames !== null) {
    const index = uri.indexOf('?')
    if (index !== -1) {
      path = uri.slice(0, index)
      query = uri.slice(index + 1)
    }
  }

  const match = compiled.regex.exec(path)
  if (!match) return null

  const params: Record<string, string> = {}
  compiled.names.forEach((name, i) => {
    const raw = match[i + 1]
    if (raw !== undefined) params[name] = decode(raw)
  })

  if (query !== undefined) {
    // Order-tolerant: each declared parameter may appear at most once, and
    // any parameter the template does not declare means no match
    const seen = new Set<string>()
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      const name = eq === -1 ? pair : pair.slice(0, eq)
      if (!compiled.queryNames!.includes(name) || seen.has(name)) return null
      seen.add(name)
      params[name] = decode(eq === -1 ? '' : pair.slice(eq + 1))
    }
  }

  return params
}
