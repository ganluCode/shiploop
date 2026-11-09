import { requireNonEmptyString, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/** Open vocabulary: supports languages such as C++, C#, SQL and project-specific DSLs. */
export function normalizeTaskLanguages(value: unknown, context: ValidationContext, field = 'languages'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw validationError(context, field, '必须是最多 16 项的开发语言字符串数组');
  }
  const languages = value.map((item, index) => {
    const language = requireNonEmptyString(item, context, `${field}[${index}]`).trim().toLowerCase();
    if (language.length > 64 || /[\u0000-\u001f\u007f]/.test(language)) {
      throw validationError(context, `${field}[${index}]`, '语言名称不得超过 64 字符或含控制字符');
    }
    return language;
  });
  return [...new Set(languages)].sort();
}

/** Empty/legacy tasks keep their pre-languages digest and prompt identity. */
export function taskLanguagesProjection(languages: readonly string[] | undefined): { languages?: readonly string[] } {
  return languages === undefined || languages.length === 0 ? {} : { languages };
}
