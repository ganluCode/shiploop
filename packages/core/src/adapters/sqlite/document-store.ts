/**
 * P06-2 / F-002 文档索引 SQLite 适配器。
 *
 * 文档正文永不写入 SQLite；document_versions 只保存同项目 ready
 * Artifact 的身份、来源和不可变版本元数据。所有写入都是短同步事务，文件
 * 读取/发布由 application 层在事务外完成。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type {
  DocumentRecord,
  DocumentStore,
  DocumentVersionRecord,
  KnowledgeArtifactRef,
  KnowledgeSourceRef,
} from '../../ports/knowledge.js';
import {
  validateDocumentInput,
  validateDocumentVersionInput,
} from '../../ports/knowledge.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

interface DocumentRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly title: string;
  readonly document_type: string;
  readonly effective_version_id: string | null;
  readonly status: string;
}

interface DocumentVersionRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly document_id: string;
  readonly version: number;
  readonly status: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly source_refs: string;
  readonly review_status: string;
  readonly reviewed_against_revision: string | null;
}

interface ArtifactIdentityRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly content_hash: string | null;
  readonly expected_hash: string;
  readonly size_bytes: number | null;
  readonly version: number;
}

const DOCUMENT_STATUSES = new Set(['active', 'archived']);
const VERSION_STATUSES = new Set(['draft', 'published', 'withdrawn']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);

export interface SqliteDocumentStoreOptions {
  readonly nowUtcMs?: () => number;
}

function assertKnown(value: string, values: ReadonlySet<string>, operation: string, field: string): void {
  if (!values.has(value)) {
    throw new StorageError('corrupt', operation, `${operation}: 文档索引 ${field} 超出契约枚举`, {
      details: { field, reason: 'unknown_enum' },
    });
  }
}

function parseSources(value: string, projectId: string, operation: string): KnowledgeSourceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new StorageError('corrupt', operation, `${operation}: 文档来源索引不是有效 JSON`, {
      entity: { type: 'document_version', projectId },
      details: { field: 'sourceRefs', reason: 'invalid_json' },
      cause,
    });
  }
  try {
    // The version validator also checks every source identity and project binding.
    return validateDocumentVersionInput({
      projectId,
      documentId: 'document-placeholder',
      version: 1,
      contentRef: {
        projectId,
        artifactId: 'artifact-placeholder',
        version: 1,
        contentHash: 'ab'.repeat(32),
        sizeBytes: 0,
      },
      contentHash: 'ab'.repeat(32),
      sourceRefs: parsed,
    }, operation).sourceRefs;
  } catch (cause) {
    throw new StorageError('corrupt', operation, `${operation}: 文档来源索引形状非法`, {
      entity: { type: 'document_version', projectId },
      details: { field: 'sourceRefs', reason: 'invalid_shape' },
      cause,
    });
  }
}

function documentFromRow(row: DocumentRow, operation: string): DocumentRecord {
  assertKnown(row.status, DOCUMENT_STATUSES, operation, 'status');
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    throw new StorageError('corrupt', operation, `${operation}: 文档 revision 无效`, {
      entity: { type: 'document', id: row.id, projectId: row.project_id },
      details: { field: 'revision', reason: 'invalid_integer' },
    });
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    documentType: row.document_type,
    effectiveVersionId: row.effective_version_id,
    status: row.status as DocumentRecord['status'],
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
  };
}

function artifactRefFromRow(row: ArtifactIdentityRow, projectId: string, operation: string): KnowledgeArtifactRef {
  if (row.project_id !== projectId) {
    throw new StorageError('ownership', operation, '正文制品不属于请求项目，拒绝文档读取', {
      entity: { type: 'document_version', projectId },
    });
  }
  if (row.status !== 'ready') {
    throw new StorageError('conflict', operation, `文档正文制品尚未可读（状态 ${row.status}）`, {
      entity: { type: 'artifact', id: row.id, projectId },
      details: { status: row.status, reason: 'artifact_not_ready' },
    });
  }
  if (row.content_hash === null || row.size_bytes === null || row.content_hash !== row.expected_hash) {
    throw new StorageError('corrupt', operation, '文档正文制品缺少一致的 hash/size 身份', {
      entity: { type: 'artifact', id: row.id, projectId },
      details: { reason: 'artifact_identity_incomplete' },
    });
  }
  return {
    projectId,
    artifactId: row.id,
    version: row.version,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  };
}

export function createSqliteDocumentStore(
  session: SqliteStorageSession,
  options: SqliteDocumentStoreOptions = {},
): DocumentStore {
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const assertOpen = (operation: string): void => {
    if (!session.isOpen()) throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
  };

  function validProjectId(projectId: string, operation: string): string {
    return validateStableId(projectId, { operation, entity: { type: 'project', id: projectId } }, 'projectId');
  }

  function requireDocument(db: Database.Database, projectId: string, documentId: string, operation: string): DocumentRow {
    const id = validateStableId(documentId, { operation, entity: { type: 'document', id: documentId, projectId } }, 'documentId');
    const row = db.prepare<[string], DocumentRow>('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (row === undefined) {
      throw new StorageError('not_found', operation, '文档不存在', { entity: { type: 'document', id, projectId } });
    }
    if (row.project_id !== projectId) {
      throw new StorageError('ownership', operation, '文档不属于请求项目，拒绝跨项目访问', { entity: { type: 'document', projectId } });
    }
    return row;
  }

  function requireArtifact(db: Database.Database, projectId: string, artifactId: string, operation: string): ArtifactIdentityRow {
    const id = validateStableId(artifactId, { operation, entity: { type: 'artifact', id: artifactId, projectId } }, 'artifactId');
    const row = db.prepare<[string], ArtifactIdentityRow>('SELECT id, project_id, status, content_hash, expected_hash, size_bytes, version FROM artifacts WHERE id = ?').get(id) as ArtifactIdentityRow | undefined;
    if (row === undefined) {
      throw new StorageError('not_found', operation, '文档正文制品不存在', { entity: { type: 'artifact', projectId } });
    }
    return row;
  }

  function versionFromRow(db: Database.Database, row: DocumentVersionRow, operation: string): DocumentVersionRecord {
    assertKnown(row.status, VERSION_STATUSES, operation, 'status');
    assertKnown(row.review_status, REVIEW_STATUSES, operation, 'reviewStatus');
    if (!Number.isInteger(row.version) || row.version < 1 || !Number.isInteger(row.revision) || row.revision < 1) {
      throw new StorageError('corrupt', operation, '文档版本的 version/revision 无效', {
        entity: { type: 'document_version', id: row.id, projectId: row.project_id },
        details: { reason: 'invalid_integer' },
      });
    }
    const sources = parseSources(row.source_refs, row.project_id, operation);
    const artifact = artifactRefFromRow(requireArtifact(db, row.project_id, row.content_ref, operation), row.project_id, operation);
    if (artifact.contentHash !== row.content_hash) {
      throw new StorageError('corrupt', operation, '文档版本 hash 与正文制品不一致', {
        entity: { type: 'document_version', id: row.id, projectId: row.project_id },
        details: { reason: 'content_hash_mismatch' },
      });
    }
    return {
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      version: row.version,
      status: row.status as DocumentVersionRecord['status'],
      contentRef: artifact,
      contentHash: row.content_hash,
      sourceRefs: sources,
      reviewStatus: row.review_status as DocumentVersionRecord['reviewStatus'],
      reviewedAgainstRevision: row.reviewed_against_revision,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    };
  }

  return {
    async createDocument(input: unknown): Promise<DocumentRecord> {
      const operation = 'DocumentStore.createDocument';
      assertOpen(operation);
      const valid = validateDocumentInput(input, operation);
      const id = randomUUID();
      const now = nowUtcMs();
      return session.transactWrite(operation, db => {
        if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(valid.projectId) === undefined) {
          throw new StorageError('not_found', operation, '项目不存在', { entity: { type: 'project', id: valid.projectId } });
        }
        db.prepare('INSERT INTO documents (id, created_at, project_id, revision, updated_at, title, document_type, effective_version_id, status) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?)')
          .run(id, now, valid.projectId, now, valid.title, valid.documentType, valid.status);
        return documentFromRow(requireDocument(db, valid.projectId, id, operation), operation);
      });
    },

    async createDocumentVersion(input: unknown): Promise<DocumentVersionRecord> {
      const operation = 'DocumentStore.createDocumentVersion';
      assertOpen(operation);
      const valid = validateDocumentVersionInput(input, operation);
      const id = randomUUID();
      const now = nowUtcMs();
      const entity = { type: 'document_version' as const, id, projectId: valid.projectId };
      return session.transactWrite(operation, db => {
        requireDocument(db, valid.projectId, valid.documentId, operation);
        const existing = db.prepare<[string, number], DocumentVersionRow>('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(valid.documentId, valid.version) as DocumentVersionRow | undefined;
        if (existing !== undefined) {
          throw new StorageError('conflict', operation, '同一文档版本已经登记，正文和身份不可覆盖', { entity, details: { reason: 'version_immutable', version: valid.version } });
        }
        const artifact = requireArtifact(db, valid.projectId, valid.contentRef.artifactId, operation);
        const contentRef = artifactRefFromRow(artifact, valid.projectId, operation);
        if (contentRef.version !== valid.contentRef.version || contentRef.contentHash !== valid.contentHash || contentRef.sizeBytes !== valid.contentRef.sizeBytes) {
          throw new StorageError('validation', operation, '文档版本正文引用与实际制品身份不一致', { entity, details: { reason: 'content_ref_mismatch' } });
        }
        for (const source of valid.sourceRefs) {
          const sourceArtifact = requireArtifact(db, valid.projectId, source.artifactId, operation);
          const sourceRef = artifactRefFromRow(sourceArtifact, valid.projectId, operation);
          if (sourceRef.version !== source.version || (source.contentHash !== undefined && source.contentHash !== sourceRef.contentHash)) {
            throw new StorageError('validation', operation, '文档来源引用与实际制品身份不一致', { entity, details: { reason: 'source_ref_mismatch' } });
          }
        }
        db.prepare('INSERT INTO document_versions (id, created_at, project_id, revision, updated_at, document_id, version, status, content_ref, content_hash, source_refs, review_status, reviewed_against_revision) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, now, valid.projectId, now, valid.documentId, valid.version, valid.status, valid.contentRef.artifactId, valid.contentHash, JSON.stringify(valid.sourceRefs), valid.reviewStatus, valid.reviewedAgainstRevision);
        if (valid.status === 'published') {
          db.prepare('UPDATE documents SET revision = revision + 1, updated_at = ?, effective_version_id = ? WHERE id = ? AND project_id = ?').run(now, id, valid.documentId, valid.projectId);
        }
        const row = db.prepare<[string], DocumentVersionRow>('SELECT * FROM document_versions WHERE id = ?').get(id) as DocumentVersionRow;
        return versionFromRow(db, row, operation);
      });
    },

    async getDocument(projectId: string, documentId: string): Promise<DocumentRecord> {
      const operation = 'DocumentStore.getDocument';
      assertOpen(operation);
      const validProjectId = validProjectIdFn(projectId, operation);
      return documentFromRow(requireDocument(session.database, validProjectId, documentId, operation), operation);
    },

    async getDocumentVersion(projectId: string, documentId: string, version?: number): Promise<DocumentVersionRecord> {
      const operation = 'DocumentStore.getDocumentVersion';
      assertOpen(operation);
      const validProject = validProjectIdFn(projectId, operation);
      const doc = requireDocument(session.database, validProject, documentId, operation);
      let row: DocumentVersionRow | undefined;
      if (version !== undefined) {
        if (!Number.isInteger(version) || version < 1) throw new StorageError('validation', operation, '文档版本必须是正整数', { entity: { type: 'document', projectId: validProject } });
        row = session.database.prepare<[string, number], DocumentVersionRow>('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(doc.id, version) as DocumentVersionRow | undefined;
      } else if (doc.effective_version_id !== null) {
        row = session.database.prepare<[string], DocumentVersionRow>('SELECT * FROM document_versions WHERE id = ?').get(doc.effective_version_id) as DocumentVersionRow | undefined;
      } else {
        row = session.database.prepare<[string], DocumentVersionRow>('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(doc.id) as DocumentVersionRow | undefined;
      }
      if (row === undefined) throw new StorageError('not_found', operation, '文档版本不存在', { entity: { type: 'document', projectId: validProject } });
      if (row.project_id !== validProject || row.document_id !== doc.id) throw new StorageError('ownership', operation, '文档版本归属不一致，拒绝读取', { entity: { type: 'document_version', projectId: validProject } });
      return versionFromRow(session.database, row, operation);
    },
  };
}

function validProjectIdFn(projectId: string, operation: string): string {
  return validateStableId(projectId, { operation, entity: { type: 'project', id: projectId } }, 'projectId');
}
