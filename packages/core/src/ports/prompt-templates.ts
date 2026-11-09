import { createHash } from 'node:crypto';
import { resolveWorkflowLocale, type WorkflowLocale } from './locale.js';

export interface PromptTemplateProvenance {
  readonly locale?: WorkflowLocale;
  readonly version: 1;
  readonly modules: readonly { readonly id: string; readonly sha256: string; readonly locale?: WorkflowLocale }[];
}

export interface PromptTemplateCatalog {
  readonly locale: WorkflowLocale;
  forLocale(locale: unknown): PromptTemplateCatalog;
  render(id: string, variables?: Readonly<Record<string, string>>): string;
  provenance(ids: readonly string[]): PromptTemplateProvenance;
}

const VARIABLE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)\s*\}\}/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Pure, frozen template snapshot. Substituted values are never re-parsed as templates. */
export function createPromptTemplateCatalog(input: Readonly<Record<string, string>>, selectedLocale: WorkflowLocale = 'en-US'): PromptTemplateCatalog {
  input = Object.freeze({ ...input });
  selectedLocale = resolveWorkflowLocale(selectedLocale);
  const entries = new Map<string, { body: string; sha256: string }>();
  for (const [id, body] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9/_-]*\.md$/.test(id) || id.includes('//') || id.length > 160) throw new Error('prompt_template_id_invalid');
    if (typeof body !== 'string' || body.trim().length === 0 || Buffer.byteLength(body, 'utf8') > 131072) throw new Error(`prompt_template_invalid:${id}`);
    const stripped = body.replace(VARIABLE, (_match, key: string) => {
      if (key.split('.').some(part => FORBIDDEN_KEYS.has(part))) throw new Error(`prompt_variable_invalid:${id}`);
      return '';
    });
    if (stripped.includes('{{') || stripped.includes('}}')) throw new Error(`prompt_template_syntax:${id}`);
    entries.set(id, { body, sha256: createHash('sha256').update(body).digest('hex') });
  }
  const get = (id: string) => {
    const localized = entries.get(`${selectedLocale.toLowerCase()}/${id}`);
    const english = entries.get(`en-us/${id}`);
    const entry = localized ?? english ?? entries.get(id);
    if (entry === undefined) throw new Error(`prompt_template_missing:${id}`);
    return { ...entry, locale: localized ? selectedLocale : english ? 'en-US' as const : selectedLocale };
  };
  return Object.freeze({
    locale: selectedLocale,
    forLocale(locale: unknown): PromptTemplateCatalog {
      const next = resolveWorkflowLocale(locale);
      return createPromptTemplateCatalog(input, next);
    },
    render(id: string, variables: Readonly<Record<string, string>> = {}): string {
      return get(id).body.replace(VARIABLE, (_match, key: string) => {
        if (!Object.hasOwn(variables, key) || typeof variables[key] !== 'string') throw new Error(`prompt_variable_missing:${key}`);
        return variables[key]!;
      });
    },
    provenance(ids: readonly string[]): PromptTemplateProvenance {
      return { version: 1, locale: selectedLocale, modules: [...new Set(ids)].map(id => ({ id, sha256: get(id).sha256, locale: get(id).locale })) };
    },
  });
}

const LANGUAGE_MODULES: Readonly<Record<string, string>> = {
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript', javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  python: 'python', py: 'python', java: 'jvm', kotlin: 'jvm', go: 'go', golang: 'go', rust: 'rust',
  sql: 'sql', shell: 'shell', bash: 'shell', sh: 'shell', zsh: 'shell', c: 'c-cpp', 'c++': 'c-cpp', cpp: 'c-cpp',
  'c#': 'csharp', csharp: 'csharp', swift: 'swift', 'objective-c': 'swift', html: 'web', css: 'web', scss: 'web',
};

export function selectTaskPromptModules(languages: readonly string[] = []): readonly string[] {
  const selected = languages.map(language => LANGUAGE_MODULES[language.trim().toLowerCase()])
    .filter((module): module is string => typeof module === 'string');
  return ['languages/common.md', ...[...new Set(selected)].sort().map(module => `languages/${module}.md`)];
}
