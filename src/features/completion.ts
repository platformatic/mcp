import type { CompleteRequest, CompleteResult, PromptReference, ResourceTemplateReference } from '../schema.ts'

/**
 * Completion provider function type.
 *
 * Providers receive the argument being completed and optional context,
 * and return an array of completion values.
 */
export type CompletionProvider = (
  argumentName: string,
  argumentValue: string,
  context?: { arguments?: Record<string, string> }
) => Promise<string[]> | string[]

/**
 * Completion service for MCP servers.
 *
 * Manages completion providers for prompts and resource templates,
 * allowing servers to provide autocompletion suggestions for
 * prompt arguments and resource template variables.
 */
export class CompletionService {
  private readonly promptProviders = new Map<string, CompletionProvider>()
  private readonly resourceProviders = new Map<string, CompletionProvider>()

  /**
   * Registers a completion provider for a prompt.
   *
   * @param promptName - The name of the prompt
   * @param provider - Function that provides completion values
   */
  registerPromptCompletion (
    promptName: string,
    provider: CompletionProvider
  ): void {
    this.promptProviders.set(promptName, provider)
  }

  /**
   * Registers a completion provider for a resource template.
   *
   * @param uriPattern - The URI pattern/template for the resource
   * @param provider - Function that provides completion values
   */
  registerResourceCompletion (
    uriPattern: string,
    provider: CompletionProvider
  ): void {
    this.resourceProviders.set(uriPattern, provider)
  }

  /**
   * Processes a completion request and returns matching values.
   *
   * @param request - The completion request
   * @returns Completion result with values
   */
  async complete (request: CompleteRequest['params']): Promise<CompleteResult> {
    const { ref, argument, context } = request
    let provider: CompletionProvider | undefined

    // Find the appropriate provider based on reference type
    if (ref.type === 'ref/prompt') {
      const promptRef = ref as PromptReference
      provider = this.promptProviders.get(promptRef.name)
    } else if (ref.type === 'ref/resource') {
      const resourceRef = ref as ResourceTemplateReference
      provider = this.resourceProviders.get(resourceRef.uri)
    }

    // If no provider found, return empty completions
    if (!provider) {
      return {
        completion: {
          values: [],
          total: 0,
          hasMore: false
        }
      }
    }

    // Call the provider to get completion values
    let values = await provider(
      argument.name,
      argument.value,
      context
    )

    // Ensure we don't exceed the 100 item limit
    const total = values.length
    const hasMore = values.length > 100
    if (hasMore) {
      values = values.slice(0, 100)
    }

    return {
      completion: {
        values,
        total,
        hasMore
      }
    }
  }

  /**
   * Checks if a completion provider exists for the given reference.
   *
   * @param ref - Prompt or resource reference
   * @returns True if a provider is registered
   */
  hasProvider (ref: PromptReference | ResourceTemplateReference): boolean {
    if (ref.type === 'ref/prompt') {
      return this.promptProviders.has((ref as PromptReference).name)
    } else if (ref.type === 'ref/resource') {
      return this.resourceProviders.has((ref as ResourceTemplateReference).uri)
    }
    return false
  }

  /**
   * Removes a completion provider for a prompt.
   *
   * @param promptName - The name of the prompt
   */
  removePromptCompletion (promptName: string): void {
    this.promptProviders.delete(promptName)
  }

  /**
   * Removes a completion provider for a resource template.
   *
   * @param uriPattern - The URI pattern/template
   */
  removeResourceCompletion (uriPattern: string): void {
    this.resourceProviders.delete(uriPattern)
  }
}
