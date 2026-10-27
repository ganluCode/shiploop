/**
 * P06-2 / F-003 bounded document knowledge query contracts.
 *
 * The query index contains identities and logical artifact locators only. It is
 * never authoritative for document bytes; the application service must verify
 * the selected Artifact before returning a hit or body.
 */
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from './validation.js';
import type { DocumentRecord, DocumentVersionRecord } from './knowledge.js';

export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 100;
export const KNOWLEDGE_SEARCH_DEFAULT_SNIPPET_MAX_CHARS = 240;
export const KNOWLEDGE_SEARCH_MAX_SNIPPET_MAX_CHARS = 2_000;
export const KNOWLEDGE_SEARCH_DEFAULT_MAX_READ_BYTES = 64 * 1024;
export const KNOWLEDGE_SEARCH_MAX_READ_BYTES = 16 * 1024 * 1024;
export const KNOWLEDGE_SEARCH_DEFAULT_MAX_CANDIDATES = 100;
export const KNOWLEDGE_SEARCH_MAX_CANDIDATES = 500;

export interface KnowledgeDocumentQueryFilter {
  readonly documentId?: string;
  readonly version?: number;
  readonly limit: number;
  readonly maxCandidates: number;
}

export interface KnowledgeDocumentQueryRow {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
  /** Controlled logical locator of the content Artifact, never a physical path. */
  readonly contentLocator: string;
  readonly sourceLocators: readonly string[];
}

export interface KnowledgeQueryReadStore {
  readonly listDocumentVersions: (
    projectId: string,
    filter: KnowledgeDocumentQueryFilter,
  ) => readonly KnowledgeDocumentQueryRow[];
}

export interface KnowledgeSearchInput {
  readonly documentId?: string;
  readonly version?: number;
  readonly keyword?: string;
  readonly title?: string;
  /** A logical source/Artifact locator fragment; absolute paths are rejected. */
  readonly path?: string;
  readonly limit?: number;
  readonly snippetMaxChars?: number;
  /** Total bytes which this search may read from verified Artifacts. */
  readonly maxReadBytes?: number;
  /** Maximum indexed candidates inspected in this query. */
  readonly maxCandidates?: number;
}

export interface ValidatedKnowledgeSearchInput {
  readonly documentId?: string;
  readonly version?: number;
  readonly keyword?: string;
  readonly title?: string;
  readonly path?: string;
  readonly limit: number;
  readonly snippetMaxChars: number;
  readonly maxReadBytes: number;
  readonly maxCandidates: number;
}

export interface KnowledgeQueryInfo {
  readonly documentId: string | null;
  readonly version: number | null;
  readonly keyword: string | null;
  readonly title: string | null;
  readonly path: string | null;
}

export interface KnowledgeQueryBudget {
  readonly limit: number;
  readonly snippetMaxChars: number;
  readonly maxReadBytes: number;
  readonly maxCandidates: number;
  readonly candidatesInspected: number;
  readonly bytesRead: number;
}

export interface KnowledgeMatchPosition {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface KnowledgeSearchResult {
  readonly documentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly title: string;
  readonly documentType: string;
  readonly status: DocumentVersionRecord['status'];
  readonly contentRef: DocumentVersionRecord['contentRef'];
  readonly contentHash: string;
  readonly sourceRefs: DocumentVersionRecord['sourceRefs'];
  readonly sourceLocators: readonly string[];
  readonly snippet: string;
  readonly position: KnowledgeMatchPosition;
  readonly query: KnowledgeQueryInfo;
  readonly selectionReason: string;
}

export type KnowledgeSearchDiagnosticCode =
  | 'no_results'
  | 'budget_exceeded'
  | 'corrupt_content'
  | 'unavailable_version';

export interface KnowledgeSearchDiagnostic {
  readonly code: KnowledgeSearchDiagnosticCode;
  readonly documentId?: string;
  readonly version?: number;
  readonly reason: string;
  readonly bytesRead: number;
}

export interface KnowledgeSearchResultSet {
  readonly schemaVersion: 1;
  readonly scope: 'knowledge-search';
  readonly projectId: string;
  readonly query: KnowledgeQueryInfo;
  readonly budget: KnowledgeQueryBudget;
  readonly results: readonly KnowledgeSearchResult[];
  readonly diagnostics: readonly KnowledgeSearchDiagnostic[];
  readonly truncated: boolean;
}

export interface KnowledgeReadInput {
  readonly projectId?: string;
  readonly documentId?: string;
  readonly version?: number;
  readonly maxReadBytes?: number;
}

export interface KnowledgeReadResult {
  readonly schemaVersion: 1;
  readonly scope: 'knowledge-read';
  readonly projectId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly title: string;
  readonly documentType: string;
  readonly status: DocumentVersionRecord['status'];
  readonly contentRef: DocumentVersionRecord['contentRef'];
  readonly contentHash: string;
  readonly sourceRefs: DocumentVersionRecord['sourceRefs'];
  readonly contentText: string;
  readonly sizeBytes: number;
  readonly query: KnowledgeQueryInfo;
  readonly budget: { readonly maxReadBytes: number; readonly bytesRead: number };
}

export function validateKnowledgeSearchInput(
  value: unknown,
  operation = 'knowledge.search',
): ValidatedKnowledgeSearchInput {
  const context = { operation };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, [
    'documentId', 'version', 'keyword', 'title', 'path', 'limit',
    'snippetMaxChars', 'maxReadBytes', 'maxCandidates',
  ], context, 'input');
  const documentId = object.documentId === undefined
    ? undefined
    : validateStableId(object.documentId, context, 'documentId');
  const version = object.version === undefined
    ? undefined
    : validatePositiveInteger(object.version, context, 'version');
  if (version !== undefined && documentId === undefined) {
    throw validationError(context, 'version', '按版本检索时必须同时提供 documentId');
  }
  const validateText = (field: string): string | undefined => object[field] === undefined
    ? undefined
    : requireNonEmptyString(object[field], context, field);
  const keyword = validateText('keyword');
  const title = validateText('title');
  const path = validateText('path');
  if (path !== undefined && (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || path.includes('\0'))) {
    throw validationError(context, 'path', '只能检索受控逻辑路径片段', path);
  }
  if (documentId === undefined && keyword === undefined && title === undefined && path === undefined) {
    throw validationError(context, 'input', '必须提供 documentId、keyword、title 或 path 之一');
  }
  const limit = object.limit === undefined ? KNOWLEDGE_SEARCH_DEFAULT_LIMIT : validatePositiveInteger(object.limit, context, 'limit');
  if (limit > KNOWLEDGE_SEARCH_MAX_LIMIT) throw validationError(context, 'limit', `不能超过 ${KNOWLEDGE_SEARCH_MAX_LIMIT}`, limit);
  const snippetMaxChars = object.snippetMaxChars === undefined
    ? KNOWLEDGE_SEARCH_DEFAULT_SNIPPET_MAX_CHARS
    : validatePositiveInteger(object.snippetMaxChars, context, 'snippetMaxChars');
  if (snippetMaxChars > KNOWLEDGE_SEARCH_MAX_SNIPPET_MAX_CHARS) throw validationError(context, 'snippetMaxChars', `不能超过 ${KNOWLEDGE_SEARCH_MAX_SNIPPET_MAX_CHARS}`, snippetMaxChars);
  const maxReadBytes = object.maxReadBytes === undefined
    ? KNOWLEDGE_SEARCH_DEFAULT_MAX_READ_BYTES
    : validatePositiveInteger(object.maxReadBytes, context, 'maxReadBytes');
  if (maxReadBytes > KNOWLEDGE_SEARCH_MAX_READ_BYTES) throw validationError(context, 'maxReadBytes', `不能超过 ${KNOWLEDGE_SEARCH_MAX_READ_BYTES}`, maxReadBytes);
  const maxCandidates = object.maxCandidates === undefined
    ? KNOWLEDGE_SEARCH_DEFAULT_MAX_CANDIDATES
    : validatePositiveInteger(object.maxCandidates, context, 'maxCandidates');
  if (maxCandidates > KNOWLEDGE_SEARCH_MAX_CANDIDATES) throw validationError(context, 'maxCandidates', `不能超过 ${KNOWLEDGE_SEARCH_MAX_CANDIDATES}`, maxCandidates);
  return { documentId, version, keyword, title, path, limit, snippetMaxChars, maxReadBytes, maxCandidates };
}

export function validateKnowledgeReadInput(value: unknown, operation = 'knowledge.read'): {
  readonly documentId: string;
  readonly version?: number;
  readonly maxReadBytes: number;
} {
  const context = { operation };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['documentId', 'version', 'maxReadBytes'], context, 'input');
  const documentId = validateStableId(object.documentId, context, 'documentId');
  const version = object.version === undefined ? undefined : validatePositiveInteger(object.version, context, 'version');
  const maxReadBytes = object.maxReadBytes === undefined
    ? KNOWLEDGE_SEARCH_MAX_READ_BYTES
    : validatePositiveInteger(object.maxReadBytes, context, 'maxReadBytes');
  if (maxReadBytes > KNOWLEDGE_SEARCH_MAX_READ_BYTES) throw validationError(context, 'maxReadBytes', `不能超过 ${KNOWLEDGE_SEARCH_MAX_READ_BYTES}`, maxReadBytes);
  return { documentId, version, maxReadBytes };
}

export function createKnowledgeQueryInfo(input: ValidatedKnowledgeSearchInput): KnowledgeQueryInfo {
  return {
    documentId: input.documentId ?? null,
    version: input.version ?? null,
    keyword: input.keyword ?? null,
    title: input.title ?? null,
    path: input.path ?? null,
  };
}
