import { validationError, type ValidationContext } from './validation.js';

export const SUPPORTED_LOCALES = ['en-US', 'zh-CN'] as const;
export type WorkflowLocale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: WorkflowLocale = 'en-US';

export function resolveWorkflowLocale(value?: unknown, context: ValidationContext = { operation: 'Locale.resolve' }): WorkflowLocale {
  if (value === undefined) return DEFAULT_LOCALE;
  if (value !== 'en-US' && value !== 'zh-CN') throw validationError(context, 'locale', 'unsupported_locale');
  return value;
}
