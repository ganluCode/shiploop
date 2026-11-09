import { loadBuiltinPromptTemplates } from 'shiploop-core/assembly';
import type { PromptTemplateCatalog } from 'shiploop-core';

let catalog: PromptTemplateCatalog | undefined;

/** One immutable asset snapshot per Runner; no filesystem access during import. */
export function getRuntimePromptTemplates(locale: unknown = 'en-US'): PromptTemplateCatalog {
  return (catalog ??= loadBuiltinPromptTemplates()).forLocale(locale);
}
