import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPromptTemplateCatalog, type PromptTemplateCatalog } from '../../ports/prompt-templates.js';
import { resolveWorkflowLocale } from '../../ports/locale.js';

const ROOT = fileURLToPath(new URL('../../../prompts/', import.meta.url));

/** Package-owned assets only; called by assembly, never during import. */
export function loadBuiltinPromptTemplates(locale: unknown = 'en-US'): PromptTemplateCatalog {
  const templates: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  function read(directory: string, prefix = ''): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), id = prefix + name;
      if (stat.isSymbolicLink()) throw new Error('prompt_asset_symlink');
      if (stat.isDirectory()) { read(path, `${id}/`); continue; }
      if (!name.endsWith('.md')) continue;
      if (!stat.isFile() || stat.size > 131072 || (totalBytes += stat.size) > 2097152) throw new Error('prompt_asset_limit');
      templates[id.replace(/^en-US\//, 'en-us/').replace(/^zh-CN\//, 'zh-cn/')] = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).replace(/\r\n/g, '\n').trimEnd();
    }
  }
  read(ROOT);
  return createPromptTemplateCatalog(templates, resolveWorkflowLocale(locale));
}
