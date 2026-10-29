/**
 * P06-2 / F-003 project-scoped document keyword and identity queries.
 *
 * Search is deliberately a small deterministic local index. It does not invoke a
 * vector service or inspect arbitrary paths. Every candidate body is read through
 * ArtifactVerifier, and an exhausted budget or corrupt body becomes explicit
 * diagnostic evidence rather than a partial hit.
 */
import type { ArtifactVerifier } from './artifact-verify.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import {
  assertTrustedPrincipal,
  authorizeProjectRead,
} from '../ports/authorization.js';
import { mapToPublicError, PublicError } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import type { DocumentStore } from '../ports/knowledge.js';
import {
  createKnowledgeQueryInfo,
  validateKnowledgeReadInput,
  validateKnowledgeSearchInput,
  type KnowledgeDocumentQueryRow,
  type KnowledgeQueryReadStore,
  type KnowledgeReadResult,
  type KnowledgeSearchDiagnostic,
  type KnowledgeSearchResult,
  type KnowledgeSearchResultSet,
  type KnowledgeMatchPosition,
} from '../ports/knowledge-query.js';
import { validateStableId } from '../ports/validation.js';

const SEARCH_OPERATION = 'knowledge.search';
const READ_OPERATION = 'knowledge.read';

export interface KnowledgeQueryServiceDeps {
  readonly documents: Pick<DocumentStore, 'getDocumentVersion' | 'getDocument'>;
  readonly documentQuery: KnowledgeQueryReadStore;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
}

export interface KnowledgeQueryService {
  readonly search: (principal: unknown, projectId: string, input: unknown) => Promise<KnowledgeSearchResultSet>;
  readonly read: (principal: unknown, projectId: string, documentId: string, version?: number, options?: unknown) => Promise<KnowledgeReadResult>;
  /** Descriptive aliases for callers that use document terminology. */
  readonly searchDocuments: KnowledgeQueryService['search'];
  readonly readDocument: KnowledgeQueryService['read'];
}

function lower(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function positionOf(body: string, offset: number, length: number): KnowledgeMatchPosition {
  const before = body.slice(0, offset);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  return { start: offset, end: offset + length, line, column: offset - lastNewline };
}

function boundedSnippet(body: string, offset: number, length: number, maxChars: number): string {
  const half = Math.max(0, Math.floor((maxChars - length) / 2));
  const start = Math.max(0, offset - half);
  const end = Math.min(body.length, start + maxChars);
  const adjustedStart = Math.max(0, end - maxChars);
  return body.slice(adjustedStart, end);
}

function sourceText(row: KnowledgeDocumentQueryRow): string {
  return [row.document.title, row.document.documentType, row.contentLocator, ...row.sourceLocators].join('\n');
}

function queryText(input: ReturnType<typeof validateKnowledgeSearchInput>): string | null {
  return input.keyword ?? input.title ?? input.path ?? (input.documentId === undefined ? null : input.documentId);
}

function diagnostic(
  code: KnowledgeSearchDiagnostic['code'],
  reason: string,
  row: KnowledgeDocumentQueryRow | undefined,
  bytesRead: number,
): KnowledgeSearchDiagnostic {
  return {
    code,
    reason,
    bytesRead,
    ...(row === undefined ? {} : { documentId: row.document.id, version: row.version.version }),
  };
}

export function createKnowledgeQueryService(deps: KnowledgeQueryServiceDeps): KnowledgeQueryService {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createKnowledgeQueryService: deps 必须是对象');
  if (deps.documents === null || typeof deps.documents !== 'object') throw new TypeError('createKnowledgeQueryService: documents 端口未装配');
  if (deps.documentQuery === null || typeof deps.documentQuery !== 'object') throw new TypeError('createKnowledgeQueryService: documentQuery 端口未装配');
  if (deps.verifier === null || typeof deps.verifier !== 'object') throw new TypeError('createKnowledgeQueryService: verifier 端口未装配');

  async function search(principal: unknown, projectId: string, input: unknown): Promise<KnowledgeSearchResultSet> {
    assertTrustedPrincipal(principal);
    try {
      const parsed = validateKnowledgeSearchInput(input, SEARCH_OPERATION);
      const id = validateStableId(projectId, { operation: SEARCH_OPERATION }, 'projectId');
      authorizeProjectRead(principal, id, SEARCH_OPERATION);
      const query = createKnowledgeQueryInfo(parsed);
      const rows = deps.documentQuery.listDocumentVersions(id, {
        ...(parsed.documentId === undefined ? {} : { documentId: parsed.documentId }),
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        limit: parsed.limit,
        maxCandidates: parsed.maxCandidates,
      });
      const candidates = rows.slice(0, parsed.maxCandidates);
      const truncated = rows.length > parsed.maxCandidates;
      const results: KnowledgeSearchResult[] = [];
      const diagnostics: KnowledgeSearchDiagnostic[] = [];
      let bytesRead = 0;
      const needle = queryText(parsed);
      for (const row of candidates) {
        if (results.length >= parsed.limit) break;
        const metadata = lower(sourceText(row));
        const metadataNeedle = needle === null ? null : lower(needle);
        const metadataOffset = metadataNeedle === null ? 0 : metadata.indexOf(metadataNeedle);
        if (parsed.title !== undefined && !lower(row.document.title).includes(lower(parsed.title))) continue;
        if (parsed.path !== undefined && !metadata.includes(lower(parsed.path))) continue;
        if (row.version.status !== 'published' || row.document.status !== 'active') {
          diagnostics.push(diagnostic('unavailable_version', '版本当前不可检索', row, bytesRead));
          continue;
        }
        if (row.version.contentRef.sizeBytes > parsed.maxReadBytes - bytesRead) {
          diagnostics.push(diagnostic('budget_exceeded', '读取预算不足，未截断读取正文', row, bytesRead));
          continue;
        }
        let verified;
        try {
          verified = await deps.verifier.readVerifiedContent(id, row.version.contentRef.artifactId);
        } catch (error) {
          if (isArtifactVerifyError(error) || isStorageError(error)) {
            diagnostics.push(diagnostic('corrupt_content', '正文制品完整性核验失败', row, bytesRead));
            continue;
          }
          throw error;
        }
        bytesRead += verified.sizeBytes;
        if (verified.sizeBytes !== row.version.contentRef.sizeBytes || verified.contentHash !== row.version.contentHash) {
          diagnostics.push(diagnostic('corrupt_content', '正文制品身份与文档版本不一致', row, bytesRead));
          continue;
        }
        const body = new TextDecoder().decode(verified.content);
        const bodyOffset = needle === null ? -1 : lower(body).indexOf(lower(needle));
        const offset = bodyOffset >= 0 ? bodyOffset : metadataOffset >= 0 ? 0 : (parsed.documentId === undefined ? -1 : 0);
        if (offset < 0) continue;
        const matchLength = bodyOffset >= 0 ? needle!.length : 0;
        results.push({
          documentId: row.document.id,
          versionId: row.version.id,
          version: row.version.version,
          title: row.document.title,
          documentType: row.document.documentType,
          status: row.version.status,
          contentRef: row.version.contentRef,
          contentHash: row.version.contentHash,
          sourceRefs: row.version.sourceRefs,
          sourceLocators: row.sourceLocators,
          snippet: boundedSnippet(body, offset, matchLength, parsed.snippetMaxChars),
          position: positionOf(body, offset, matchLength),
          query,
          selectionReason: bodyOffset >= 0 ? '正文关键词命中' : '文档身份或索引元数据命中',
        });
      }
      if (results.length === 0 && diagnostics.length === 0) diagnostics.push(diagnostic('no_results', '没有匹配的文档版本', undefined, bytesRead));
      return {
        schemaVersion: 1,
        scope: 'knowledge-search',
        projectId: id,
        query,
        budget: {
          limit: parsed.limit,
          snippetMaxChars: parsed.snippetMaxChars,
          maxReadBytes: parsed.maxReadBytes,
          maxCandidates: parsed.maxCandidates,
          candidatesInspected: candidates.length,
          bytesRead,
        },
        results,
        diagnostics,
        truncated,
      };
    } catch (error) {
      throw mapToPublicError(error, { operation: SEARCH_OPERATION });
    }
  }

  async function read(principal: unknown, projectId: string, documentId: string, version?: number, options?: unknown): Promise<KnowledgeReadResult> {
    assertTrustedPrincipal(principal);
    try {
      const id = validateStableId(projectId, { operation: READ_OPERATION }, 'projectId');
      authorizeProjectRead(principal, id, READ_OPERATION);
      const parsed = validateKnowledgeReadInput({
        documentId,
        ...(version === undefined ? {} : { version }),
        ...(options === undefined ? {} : options as object),
      }, READ_OPERATION);
      const record = await deps.documents.getDocumentVersion(id, parsed.documentId, parsed.version);
      if (record.status !== 'published') throw new PublicError('not_found', READ_OPERATION, '文档版本不存在或不可用', { details: { reason: 'unavailable_version' } });
      if (record.contentRef.sizeBytes > parsed.maxReadBytes) {
        throw new PublicError('invalid_input', READ_OPERATION, '读取预算不足，拒绝截断正文', {
          details: { reason: 'budget_exceeded', maxReadBytes: parsed.maxReadBytes, requiredBytes: record.contentRef.sizeBytes },
        });
      }
      let verified;
      try {
        verified = await deps.verifier.readVerifiedContent(id, record.contentRef.artifactId);
      } catch (error) {
        throw new PublicError('corrupt_state', READ_OPERATION, '文档正文完整性核验失败', {
          details: { reason: isArtifactVerifyError(error, 'corrupt') ? 'corrupt_content' : 'artifact_unavailable' },
          cause: error,
        });
      }
      if (verified.contentHash !== record.contentHash || verified.sizeBytes !== record.contentRef.sizeBytes) {
        throw new PublicError('corrupt_state', READ_OPERATION, '文档正文完整性核验失败', { details: { reason: 'content_identity_mismatch' } });
      }
      return {
        schemaVersion: 1,
        scope: 'knowledge-read',
        projectId: id,
        documentId: record.documentId,
        versionId: record.id,
        version: record.version,
        title: (await deps.documents.getDocument(id, record.documentId)).title,
        documentType: (await deps.documents.getDocument(id, record.documentId)).documentType,
        status: record.status,
        contentRef: record.contentRef,
        contentHash: verified.contentHash,
        sourceRefs: record.sourceRefs,
        contentText: new TextDecoder().decode(verified.content),
        sizeBytes: verified.sizeBytes,
        query: { documentId: record.documentId, version: record.version, keyword: null, title: null, path: null },
        budget: { maxReadBytes: parsed.maxReadBytes, bytesRead: verified.sizeBytes },
      };
    } catch (error) {
      throw mapToPublicError(error, { operation: READ_OPERATION });
    }
  }

  return { search, read, searchDocuments: search, readDocument: read };
}

export { KNOWLEDGE_SEARCH_MAX_READ_BYTES } from '../ports/knowledge-query.js';
