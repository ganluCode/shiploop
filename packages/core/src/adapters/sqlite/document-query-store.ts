/** P06-2 / F-003 SQLite read adapter for bounded document searches. */
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import {
  validateDocumentVersionInput,
  type DocumentRecord,
  type DocumentVersionRecord,
} from '../../ports/knowledge.js';
import {
  validateStableId,
  validateSha256Digest,
} from '../../ports/validation.js';
import type {
  KnowledgeDocumentQueryFilter,
  KnowledgeDocumentQueryRow,
  KnowledgeQueryReadStore,
} from '../../ports/knowledge-query.js';
import type { SqliteStorageSession } from './session.js';

interface QueryRow {
  readonly document_id: string;
  readonly document_created_at: number;
  readonly document_project_id: string;
  readonly document_revision: number;
  readonly document_updated_at: number;
  readonly title: string;
  readonly document_type: string;
  readonly effective_version_id: string | null;
  readonly document_status: string;
  readonly version_id: string;
  readonly version_created_at: number;
  readonly version_revision: number;
  readonly version_updated_at: number;
  readonly version: number;
  readonly version_status: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly source_refs: string;
  readonly review_status: string;
  readonly reviewed_against_revision: string | null;
  readonly artifact_status: string;
  readonly artifact_hash: string | null;
  readonly artifact_size: number | null;
  readonly artifact_version: number;
  readonly artifact_locator: string;
}

const DOCUMENT_STATUSES = new Set(['active', 'archived']);
const VERSION_STATUSES = new Set(['draft', 'published', 'withdrawn']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);

function corrupt(operation: string, row: QueryRow, reason: string): never {
  throw new StorageError('corrupt', operation, '文档检索索引损坏，拒绝返回结果', {
    entity: { type: 'document_version', id: row.version_id, projectId: row.document_project_id },
    details: { reason },
  });
}

function mapRow(row: QueryRow, operation: string): KnowledgeDocumentQueryRow {
  if (row.document_project_id.length === 0 || row.artifact_status !== 'ready' || row.artifact_hash === null || row.artifact_size === null) {
    corrupt(operation, row, 'artifact_identity_incomplete');
  }
  if (!DOCUMENT_STATUSES.has(row.document_status) || !VERSION_STATUSES.has(row.version_status) || !REVIEW_STATUSES.has(row.review_status)) {
    corrupt(operation, row, 'unknown_enum');
  }
  if (!Number.isInteger(row.version) || row.version < 1 || !Number.isInteger(row.artifact_version) || row.artifact_version < 1) {
    corrupt(operation, row, 'invalid_version');
  }
  let sourceRefs: unknown;
  try {
    sourceRefs = JSON.parse(row.source_refs);
  } catch (cause) {
    throw new StorageError('corrupt', operation, '文档来源索引不是有效 JSON', {
      entity: { type: 'document_version', id: row.version_id, projectId: row.document_project_id },
      details: { reason: 'invalid_source_refs_json' },
      cause,
    });
  }
  const projectId = validateStableId(row.document_project_id, { operation }, 'projectId');
  const contentHash = validateSha256Digest(row.content_hash, { operation }, 'contentHash');
  if (row.artifact_hash !== contentHash || row.artifact_size < 0 || row.content_ref.length === 0) {
    corrupt(operation, row, 'content_identity_mismatch');
  }
  let valid;
  try {
    valid = validateDocumentVersionInput({
      projectId,
      documentId: row.document_id,
      version: row.version,
      status: row.version_status,
      contentRef: {
        projectId,
        artifactId: row.content_ref,
        version: row.artifact_version,
        contentHash,
        sizeBytes: row.artifact_size,
      },
      contentHash,
      sourceRefs,
      reviewStatus: row.review_status,
      reviewedAgainstRevision: row.reviewed_against_revision,
    }, operation);
  } catch (cause) {
    throw new StorageError('corrupt', operation, '文档版本索引形状非法', {
      entity: { type: 'document_version', id: row.version_id, projectId },
      details: { reason: 'invalid_version_shape' },
      cause,
    });
  }
  const document: DocumentRecord = {
    id: row.document_id,
    projectId,
    title: row.title,
    documentType: row.document_type,
    effectiveVersionId: row.effective_version_id,
    status: row.document_status as DocumentRecord['status'],
    revision: row.document_revision,
    createdAtUtcMs: row.document_created_at,
    updatedAtUtcMs: row.document_updated_at,
  };
  const version: DocumentVersionRecord = {
    ...valid,
    id: row.version_id,
    revision: row.version_revision,
    createdAtUtcMs: row.version_created_at,
    updatedAtUtcMs: row.version_updated_at,
  };
  return { document, version, contentLocator: row.artifact_locator, sourceLocators: [] };
}

export function createSqliteDocumentQueryStore(session: SqliteStorageSession): KnowledgeQueryReadStore {
  if (session === null || typeof session !== 'object') throw new TypeError('createSqliteDocumentQueryStore: session 必须是 SqliteStorageSession');
  return {
    listDocumentVersions(projectId: string, filter: KnowledgeDocumentQueryFilter): readonly KnowledgeDocumentQueryRow[] {
      const operation = 'KnowledgeQueryStore.listDocumentVersions';
      if (!session.isOpen()) throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      if (!Number.isInteger(filter.limit) || filter.limit < 1) throw new StorageError('validation', operation, '检索条数上限必须是正整数');
      if (!Number.isInteger(filter.maxCandidates) || filter.maxCandidates < 1) throw new StorageError('validation', operation, '候选读取上限无效');
      const clauses = [
        'd.project_id = ?',
        "v.status = 'published'",
      ];
      const params: Array<string | number> = [validProjectId];
      if (filter.documentId !== undefined) {
        const documentId = validateStableId(filter.documentId, { operation }, 'documentId');
        clauses.push('d.id = ?');
        params.push(documentId);
      }
      if (filter.version !== undefined) {
        if (!Number.isInteger(filter.version) || filter.version < 1) throw new StorageError('validation', operation, '文档版本必须是正整数');
        clauses.push('v.version = ?');
        params.push(filter.version);
      }
      const limit = Math.min(filter.maxCandidates + 1, 501);
      params.push(limit);
      const query = `SELECT d.id AS document_id, d.created_at AS document_created_at, d.project_id AS document_project_id,
        d.revision AS document_revision, d.updated_at AS document_updated_at, d.title, d.document_type,
        d.effective_version_id, d.status AS document_status, v.id AS version_id, v.created_at AS version_created_at,
        v.revision AS version_revision, v.updated_at AS version_updated_at, v.version, v.status AS version_status,
        v.content_ref, v.content_hash, v.source_refs, v.review_status, v.reviewed_against_revision,
        a.status AS artifact_status, a.content_hash AS artifact_hash, a.size_bytes AS artifact_size,
        a.version AS artifact_version, a.storage_locator AS artifact_locator
        FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.project_id = d.project_id
        JOIN artifacts a ON a.id = v.content_ref AND a.project_id = v.project_id
        WHERE ${clauses.join(' AND ')} ORDER BY d.id ASC, v.version ASC LIMIT ?`;
      // better-sqlite3's generic prepare overload is not useful for typed dynamic params.
      const result = session.database.prepare(query).all(...params) as QueryRow[];
      return result.map(row => mapRow(row, operation));
    },
  };
}
