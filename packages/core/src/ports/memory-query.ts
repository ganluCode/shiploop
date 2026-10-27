import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validatePositiveInteger,
  validationError,
} from './validation.js';
import type { MemoryRecord, KnowledgeSourceRef } from './knowledge.js';

export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const MEMORY_SEARCH_MAX_LIMIT = 100;
export const MEMORY_SEARCH_DEFAULT_SNIPPET_MAX_CHARS = 240;
export const MEMORY_SEARCH_MAX_SNIPPET_MAX_CHARS = 2_000;
export const MEMORY_SEARCH_DEFAULT_MAX_READ_BYTES = 64 * 1024;
export const MEMORY_SEARCH_MAX_READ_BYTES = 16 * 1024 * 1024;
export const MEMORY_SEARCH_DEFAULT_MAX_CANDIDATES = 100;
export const MEMORY_SEARCH_MAX_CANDIDATES = 500;

export interface MemoryQueryFilter {
  readonly recordKey?: string;
  readonly version?: number;
  readonly scope?: string;
  readonly limit: number;
  readonly maxCandidates: number;
}

export interface MemoryQueryRow {
  readonly memory: MemoryRecord;
  readonly contentLocator: string;
  readonly sourceLocators: readonly string[];
}

export interface MemoryQueryReadStore {
  readonly listAcceptedMemories: (projectId: string, filter: MemoryQueryFilter) => readonly MemoryQueryRow[];
}

export interface MemorySearchInput {
  readonly keyword?: string;
  readonly recordKey?: string;
  readonly scope?: string;
  readonly version?: number;
  readonly limit?: number;
  readonly snippetMaxChars?: number;
  readonly maxReadBytes?: number;
  readonly maxCandidates?: number;
}

export interface ValidatedMemorySearchInput {
  readonly keyword?: string;
  readonly recordKey?: string;
  readonly scope?: string;
  readonly version?: number;
  readonly limit: number;
  readonly snippetMaxChars: number;
  readonly maxReadBytes: number;
  readonly maxCandidates: number;
}

export interface MemoryQueryInfo {
  readonly keyword: string | null;
  readonly recordKey: string | null;
  readonly scope: string | null;
  readonly version: number | null;
}

export interface MemorySearchBudget {
  readonly limit: number;
  readonly snippetMaxChars: number;
  readonly maxReadBytes: number;
  readonly maxCandidates: number;
  readonly candidatesInspected: number;
  readonly bytesRead: number;
}

export interface MemoryMatchPosition {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface MemorySearchResult {
  readonly id: string;
  readonly recordKey: string;
  readonly version: number;
  readonly scope: string;
  readonly status: 'accepted';
  readonly contentRef: MemoryRecord['contentRef'];
  readonly contentHash: string;
  readonly sourceRefs: readonly KnowledgeSourceRef[];
  readonly sourceLocators: readonly string[];
  readonly snippet: string;
  readonly position: MemoryMatchPosition;
  readonly query: MemoryQueryInfo;
  readonly selectionReason: string;
}

export type MemorySearchDiagnosticCode =
  | 'no_results'
  | 'budget_exceeded'
  | 'corrupt_content'
  | 'unavailable_source'
  | 'unavailable_memory';

export interface MemorySearchDiagnostic {
  readonly code: MemorySearchDiagnosticCode;
  readonly id?: string;
  readonly recordKey?: string;
  readonly version?: number;
  readonly reason: string;
  readonly bytesRead: number;
}

export interface MemorySearchResultSet {
  readonly schemaVersion: 1;
  readonly scope: 'memory-search';
  readonly projectId: string;
  readonly query: MemoryQueryInfo;
  readonly budget: MemorySearchBudget;
  readonly results: readonly MemorySearchResult[];
  readonly diagnostics: readonly MemorySearchDiagnostic[];
  readonly truncated: boolean;
}

export function validateMemorySearchInput(value: unknown, operation = 'memory.search'): ValidatedMemorySearchInput {
  const context = { operation };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['keyword', 'recordKey', 'scope', 'version', 'limit', 'snippetMaxChars', 'maxReadBytes', 'maxCandidates'], context, 'input');
  const text = (field: string): string | undefined => object[field] === undefined ? undefined : requireNonEmptyString(object[field], context, field);
  const keyword = text('keyword');
  const recordKey = text('recordKey');
  const scope = text('scope');
  const version = object.version === undefined ? undefined : validatePositiveInteger(object.version, context, 'version');
  if (version !== undefined && recordKey === undefined) throw validationError(context, 'version', '按版本检索时必须同时提供 recordKey');
  if (keyword === undefined && recordKey === undefined && scope === undefined) throw validationError(context, 'input', '必须提供 keyword、recordKey 或 scope 之一');
  const limit = object.limit === undefined ? MEMORY_SEARCH_DEFAULT_LIMIT : validatePositiveInteger(object.limit, context, 'limit');
  if (limit > MEMORY_SEARCH_MAX_LIMIT) throw validationError(context, 'limit', `不能超过 ${MEMORY_SEARCH_MAX_LIMIT}`, limit);
  const snippetMaxChars = object.snippetMaxChars === undefined ? MEMORY_SEARCH_DEFAULT_SNIPPET_MAX_CHARS : validatePositiveInteger(object.snippetMaxChars, context, 'snippetMaxChars');
  if (snippetMaxChars > MEMORY_SEARCH_MAX_SNIPPET_MAX_CHARS) throw validationError(context, 'snippetMaxChars', `不能超过 ${MEMORY_SEARCH_MAX_SNIPPET_MAX_CHARS}`, snippetMaxChars);
  const maxReadBytes = object.maxReadBytes === undefined ? MEMORY_SEARCH_DEFAULT_MAX_READ_BYTES : validatePositiveInteger(object.maxReadBytes, context, 'maxReadBytes');
  if (maxReadBytes > MEMORY_SEARCH_MAX_READ_BYTES) throw validationError(context, 'maxReadBytes', `不能超过 ${MEMORY_SEARCH_MAX_READ_BYTES}`, maxReadBytes);
  const maxCandidates = object.maxCandidates === undefined ? MEMORY_SEARCH_DEFAULT_MAX_CANDIDATES : validatePositiveInteger(object.maxCandidates, context, 'maxCandidates');
  if (maxCandidates > MEMORY_SEARCH_MAX_CANDIDATES) throw validationError(context, 'maxCandidates', `不能超过 ${MEMORY_SEARCH_MAX_CANDIDATES}`, maxCandidates);
  return { keyword, recordKey, scope, version, limit, snippetMaxChars, maxReadBytes, maxCandidates };
}

export function createMemoryQueryInfo(input: ValidatedMemorySearchInput): MemoryQueryInfo {
  return { keyword: input.keyword ?? null, recordKey: input.recordKey ?? null, scope: input.scope ?? null, version: input.version ?? null };
}
