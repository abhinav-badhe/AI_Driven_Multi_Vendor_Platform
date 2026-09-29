/**
 * BOUNDED CONTEXT: AI Capability Layer
 * Ownership: Typed commerce tool orchestration, prompt templates, intent mapping.
 *
 * Invariant: AI is an application capability using authorized tools, NOT a replacement
 * for domain ownership.
 *
 * Architecture Boundary:
 * - AI code MUST NOT import database connection pools or repositories directly.
 * - AI code MUST interact with commerce capabilities exclusively through authorized,
 *   typed tool interfaces exposed by domain module public interfaces.
 */
export interface AiModule {
  readonly contextName: 'ai';
}

export const aiModule: AiModule = {
  contextName: 'ai',
};
