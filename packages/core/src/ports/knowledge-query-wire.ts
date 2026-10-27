/** Shared, pure knowledge wire validation. Host and clients use the same contract. */
import { requireOwnedArtifactRef, requireSourceRefs } from './knowledge.js';
import { validateArtifactLocator } from './validation.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId, validatePositiveInteger, validateNonNegativeInteger, requireNonEmptyString, validateSha256Digest, validationError } from './validation.js';
import { validateKnowledgeReadInput, validateKnowledgeSearchInput, type KnowledgeReadResult, type KnowledgeSearchResultSet } from './knowledge-query.js';
import { validateMemorySearchInput, type MemorySearchResultSet } from './memory-query.js';

export const KNOWLEDGE_QUERY_OPERATIONS = ['knowledge.search', 'knowledge.read', 'memory.search'] as const;
export type KnowledgeQueryOperation = typeof KNOWLEDGE_QUERY_OPERATIONS[number];
export const MAX_KNOWLEDGE_SEARCH_RESPONSE_BYTES = 1024 * 1024;
export const MAX_KNOWLEDGE_READ_RESPONSE_BYTES = 32 * 1024 * 1024;

export function validateKnowledgeQueryResponse(operation: 'knowledge.search', value: unknown): KnowledgeSearchResultSet;
export function validateKnowledgeQueryResponse(operation: 'knowledge.read', value: unknown): KnowledgeReadResult;
export function validateKnowledgeQueryResponse(operation: 'memory.search', value: unknown): MemorySearchResultSet;
export function validateKnowledgeQueryResponse(operation: KnowledgeQueryOperation, value: unknown): KnowledgeSearchResultSet | KnowledgeReadResult | MemorySearchResultSet;
export function validateKnowledgeQueryResponse(operation: KnowledgeQueryOperation, value: unknown): KnowledgeSearchResultSet | KnowledgeReadResult | MemorySearchResultSet {
  const ctx = { operation };
  const fail = (): never => { throw validationError(ctx, 'response', '知识查询响应不符合契约'); };
  const object = (v: unknown, keys: readonly string[], optional: readonly string[] = []) => {
    const o = requirePlainObject(v, ctx, 'response');
    rejectUnknownKeys(o, [...keys, ...optional], ctx, 'response');
    if (keys.some(k => !Object.hasOwn(o, k))) fail();
    return o;
  };
  const text = (v: unknown) => requireNonEmptyString(v, ctx, 'response');
  const integer = (v: unknown) => validateNonNegativeInteger(v, ctx, 'response');
  const positive = (v: unknown) => validatePositiveInteger(v, ctx, 'response');
  const id = (v: unknown) => validateStableId(v, ctx, 'response');
  const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) return fail(); return v; };
  const read = operation === 'knowledge.read';
  const memory = operation === 'memory.search';
  const queryKeys = memory ? ['keyword', 'recordKey', 'scope', 'version'] : ['documentId', 'version', 'keyword', 'title', 'path'];
  const query = (v: unknown) => {
    const q = object(v, queryKeys);
    for (const k of queryKeys) if (q[k] !== null) { if (k === 'version') positive(q[k]); else text(q[k]); }
    const input = Object.fromEntries(Object.entries(q).filter(([, item]) => item !== null));
    if (read) validateKnowledgeReadInput(input);
    else if (memory) validateMemorySearchInput(input);
    else validateKnowledgeSearchInput(input);
  };
  const common = ['schemaVersion', 'scope', 'projectId', 'query', 'budget'];
  const document = ['documentId', 'versionId', 'version', 'title', 'documentType', 'status', 'contentRef', 'contentHash', 'sourceRefs'];
  const o = object(value, read ? [...common, ...document, 'contentText', 'sizeBytes'] : [...common, 'results', 'diagnostics', 'truncated']);
  if (o.schemaVersion !== 1 || o.scope !== (read ? 'knowledge-read' : memory ? 'memory-search' : 'knowledge-search')) fail();
  const projectId = id(o.projectId);
  query(o.query);
  const budget = object(o.budget, read ? ['maxReadBytes', 'bytesRead'] : ['limit', 'snippetMaxChars', 'maxReadBytes', 'maxCandidates', 'candidatesInspected', 'bytesRead']);
  for (const k of Object.keys(budget)) integer(budget[k]);
  if (positive(budget.maxReadBytes) > 16 * 1024 * 1024 || Number(budget.bytesRead) > Number(budget.maxReadBytes)) fail();
  const refs = (r: Record<string, unknown>) => {
    const ref = requireOwnedArtifactRef(r.contentRef, projectId, operation, 'contentRef');
    if (validateSha256Digest(r.contentHash, ctx, 'contentHash') !== ref.contentHash) fail();
    requireSourceRefs(r.sourceRefs, projectId, operation, 'sourceRefs');
    positive(r.version);
    if (memory ? r.status !== 'accepted' : r.status !== 'published') fail();
    if (memory) { id(r.id); text(r.recordKey); text(r.scope); }
    else { id(r.documentId); id(r.versionId); text(r.title); text(r.documentType); }
    return ref;
  };
  if (read) {
    const ref = refs(o);
    const q = o.query as Record<string, unknown>;
    if (q.documentId !== o.documentId || q.version !== o.version) fail();
    if (typeof o.contentText !== 'string' || integer(o.sizeBytes) !== ref.sizeBytes || o.sizeBytes !== budget.bytesRead || new TextEncoder().encode(o.contentText).byteLength !== o.sizeBytes) fail();
  } else {
    if (positive(budget.limit) > 100 || positive(budget.snippetMaxChars) > 2000 || positive(budget.maxCandidates) > 500 || Number(budget.candidatesInspected) > Number(budget.maxCandidates) || typeof o.truncated !== 'boolean') fail();
    const results = array(o.results);
    if (results.length > Number(budget.limit)) fail();
    let resultBytes = 0;
    for (const entry of results) {
      const r = object(entry, [...(memory ? ['id', 'recordKey', 'version', 'scope', 'status', 'contentRef', 'contentHash', 'sourceRefs'] : document), 'sourceLocators', 'snippet', 'position', 'query', 'selectionReason']);
      resultBytes += refs(r).sizeBytes;
      if (resultBytes > Number(budget.bytesRead)) fail();
      for (const locator of array(r.sourceLocators)) validateArtifactLocator(locator, ctx, 'sourceLocators');
      if (typeof r.snippet !== 'string' || r.snippet.length > Number(budget.snippetMaxChars)) fail();
      text(r.selectionReason);
      query(r.query);
      if (queryKeys.some(key => (r.query as Record<string, unknown>)[key] !== (o.query as Record<string, unknown>)[key])) fail();
      const p = object(r.position, ['start', 'end', 'line', 'column']);
      if (integer(p.start) > integer(p.end) || Number(p.end) > (r.contentRef as { sizeBytes: number }).sizeBytes) fail();
      positive(p.line); positive(p.column);
    }
    for (const entry of array(o.diagnostics)) {
      const d = object(entry, ['code', 'reason', 'bytesRead'], memory ? ['id', 'recordKey', 'version'] : ['documentId', 'version']);
      const codes = memory ? ['no_results', 'budget_exceeded', 'corrupt_content', 'unavailable_source', 'unavailable_memory'] : ['no_results', 'budget_exceeded', 'corrupt_content', 'unavailable_version'];
      if (!codes.includes(String(d.code)) || integer(d.bytesRead) > Number(budget.bytesRead)) fail();
      text(d.reason);
      if (d.version !== undefined) positive(d.version);
      if (d.documentId !== undefined) id(d.documentId);
      if (d.id !== undefined) id(d.id);
      if (d.recordKey !== undefined) text(d.recordKey);
    }
  }
  // Return only after all nested fields have been checked; no private storage fields survive.
  return value as KnowledgeSearchResultSet | KnowledgeReadResult | MemorySearchResultSet;
}
