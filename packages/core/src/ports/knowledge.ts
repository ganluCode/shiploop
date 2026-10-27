/**
 * P06-2 文档版本与轻量记忆的 Core 端口契约。
 *
 * 正文只通过同项目 Artifact 引用保存；这些端口只描述索引身份和运行时校验，
 * 不读取文件、不访问网络，也不把任意路径当作正文来源。
 */
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export type DocumentStatus = 'active' | 'archived';
export type DocumentVersionStatus = 'draft' | 'published' | 'withdrawn';
export type DocumentReviewStatus = 'pending' | 'approved' | 'rejected';
export type MemoryRecordStatus = 'candidate' | 'accepted' | 'revoked';

export interface KnowledgeArtifactRef {
  readonly projectId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export interface KnowledgeSourceRef {
  readonly projectId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash?: string;
}

export interface DocumentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly documentType: string;
  readonly effectiveVersionId: string | null;
  readonly status: DocumentStatus;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface DocumentVersionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly version: number;
  readonly status: DocumentVersionStatus;
  readonly contentRef: KnowledgeArtifactRef;
  readonly contentHash: string;
  readonly sourceRefs: readonly KnowledgeSourceRef[];
  readonly reviewStatus: DocumentReviewStatus;
  readonly reviewedAgainstRevision: string | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface MemoryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly recordKey: string;
  readonly version: number;
  readonly scope: string;
  readonly status: MemoryRecordStatus;
  readonly contentRef: KnowledgeArtifactRef;
  readonly contentHash: string;
  readonly sourceRefs: readonly KnowledgeSourceRef[];
  readonly retrievalCount: number;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

function context(operation: string, projectId?: string, type: 'document' | 'document_version' | 'memory_record' = 'document'): ValidationContext {
  return {
    operation,
    ...(projectId === undefined ? {} : { entity: { type, projectId } }),
  };
}

function requireOwnedArtifactRef(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
): KnowledgeArtifactRef {
  const ctx = context(operation, projectId, 'document_version');
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, ['projectId', 'artifactId', 'version', 'contentHash', 'sizeBytes'], ctx, field);
  const refProjectId = validateStableId(object.projectId, ctx, `${field}.projectId`);
  if (refProjectId !== projectId) {
    throw validationError(ctx, `${field}.projectId`, '必须与记录 projectId 一致，禁止跨项目引用');
  }
  return {
    projectId: refProjectId,
    artifactId: validateStableId(object.artifactId, ctx, `${field}.artifactId`),
    version: validatePositiveInteger(object.version, ctx, `${field}.version`),
    contentHash: validateSha256Digest(object.contentHash, ctx, `${field}.contentHash`),
    sizeBytes: validateNonNegativeInteger(object.sizeBytes, ctx, `${field}.sizeBytes`),
  };
}

function requireSourceRefs(value: unknown, projectId: string, operation: string, field: string): KnowledgeSourceRef[] {
  const ctx = context(operation, projectId);
  if (!Array.isArray(value)) throw validationError(ctx, field, '必须是数组', value);
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(item, ctx, itemField);
    rejectUnknownKeys(object, ['projectId', 'artifactId', 'version', 'contentHash'], ctx, itemField);
    const refProjectId = validateStableId(object.projectId, ctx, `${itemField}.projectId`);
    if (refProjectId !== projectId) {
      throw validationError(ctx, `${itemField}.projectId`, '必须与记录 projectId 一致，禁止跨项目引用');
    }
    return {
      projectId: refProjectId,
      artifactId: validateStableId(object.artifactId, ctx, `${itemField}.artifactId`),
      version: validatePositiveInteger(object.version, ctx, `${itemField}.version`),
      ...(object.contentHash === undefined ? {} : { contentHash: validateSha256Digest(object.contentHash, ctx, `${itemField}.contentHash`) }),
    };
  });
}

export function validateDocumentInput(value: unknown, operation = 'DocumentStore.createDocument'): {
  projectId: string; title: string; documentType: string; status: DocumentStatus;
} {
  const object = requirePlainObject(value, context(operation), 'input');
  rejectUnknownKeys(object, ['projectId', 'title', 'documentType', 'status'], context(operation), 'input');
  const projectId = validateStableId(object.projectId, context(operation, undefined, 'document'), 'projectId');
  const status = object.status === undefined ? 'active' : object.status;
  if (status !== 'active' && status !== 'archived') throw validationError(context(operation, projectId), 'status', '必须是 active 或 archived', status);
  return {
    projectId,
    title: requireNonEmptyString(object.title, context(operation, projectId), 'title'),
    documentType: requireNonEmptyString(object.documentType, context(operation, projectId), 'documentType'),
    status,
  };
}

export function validateDocumentVersionInput(value: unknown, operation = 'DocumentStore.createDocumentVersion'): {
  projectId: string; documentId: string; version: number; status: DocumentVersionStatus;
  contentRef: KnowledgeArtifactRef; contentHash: string; sourceRefs: KnowledgeSourceRef[];
  reviewStatus: DocumentReviewStatus; reviewedAgainstRevision: string | null;
} {
  const object = requirePlainObject(value, context(operation), 'input');
  rejectUnknownKeys(object, ['projectId', 'documentId', 'version', 'status', 'contentRef', 'contentHash', 'sourceRefs', 'reviewStatus', 'reviewedAgainstRevision'], context(operation), 'input');
  const projectId = validateStableId(object.projectId, context(operation, undefined, 'document_version'), 'projectId');
  const status = object.status === undefined ? 'draft' : object.status;
  if (status !== 'draft' && status !== 'published' && status !== 'withdrawn') throw validationError(context(operation, projectId), 'status', '文档版本状态无效', status);
  const reviewStatus = object.reviewStatus === undefined ? 'pending' : object.reviewStatus;
  if (reviewStatus !== 'pending' && reviewStatus !== 'approved' && reviewStatus !== 'rejected') throw validationError(context(operation, projectId), 'reviewStatus', '文档复核状态无效', reviewStatus);
  const reviewedAgainstRevision = object.reviewedAgainstRevision === undefined || object.reviewedAgainstRevision === null
    ? null : requireNonEmptyString(object.reviewedAgainstRevision, context(operation, projectId), 'reviewedAgainstRevision');
  return {
    projectId,
    documentId: validateStableId(object.documentId, context(operation, projectId, 'document_version'), 'documentId'),
    version: validatePositiveInteger(object.version, context(operation, projectId, 'document_version'), 'version'),
    status,
    contentRef: requireOwnedArtifactRef(object.contentRef, projectId, operation, 'contentRef'),
    contentHash: validateSha256Digest(object.contentHash, context(operation, projectId, 'document_version'), 'contentHash'),
    sourceRefs: requireSourceRefs(object.sourceRefs, projectId, operation, 'sourceRefs'),
    reviewStatus,
    reviewedAgainstRevision,
  };
}

export function validateMemoryRecordInput(value: unknown, operation = 'MemoryStore.createMemoryRecord'): {
  projectId: string; recordKey: string; version: number; scope: string; status: MemoryRecordStatus;
  contentRef: KnowledgeArtifactRef; sourceRefs: KnowledgeSourceRef[]; retrievalCount: number;
} {
  const object = requirePlainObject(value, context(operation), 'input');
  rejectUnknownKeys(object, ['projectId', 'recordKey', 'version', 'scope', 'status', 'contentRef', 'sourceRefs', 'retrievalCount'], context(operation), 'input');
  const projectId = validateStableId(object.projectId, context(operation, undefined, 'memory_record'), 'projectId');
  const status = object.status === undefined ? 'candidate' : object.status;
  if (status !== 'candidate' && status !== 'accepted' && status !== 'revoked') throw validationError(context(operation, projectId), 'status', '记忆状态无效', status);
  return {
    projectId,
    recordKey: requireNonEmptyString(object.recordKey, context(operation, projectId, 'memory_record'), 'recordKey'),
    version: validatePositiveInteger(object.version, context(operation, projectId, 'memory_record'), 'version'),
    scope: requireNonEmptyString(object.scope, context(operation, projectId, 'memory_record'), 'scope'),
    status,
    contentRef: requireOwnedArtifactRef(object.contentRef, projectId, operation, 'contentRef'),
    sourceRefs: requireSourceRefs(object.sourceRefs, projectId, operation, 'sourceRefs'),
    retrievalCount: object.retrievalCount === undefined ? 0 : validateNonNegativeInteger(object.retrievalCount, context(operation, projectId, 'memory_record'), 'retrievalCount'),
  };
}

export interface DocumentStore {
  readonly createDocument: (input: unknown) => Promise<DocumentRecord>;
  readonly createDocumentVersion: (input: unknown) => Promise<DocumentVersionRecord>;
  readonly getDocument: (projectId: string, documentId: string) => Promise<DocumentRecord>;
  readonly getDocumentVersion: (projectId: string, documentId: string, version?: number) => Promise<DocumentVersionRecord>;
}

export interface MemoryStore {
  readonly createMemoryRecord: (input: unknown) => Promise<MemoryRecord>;
  readonly getMemoryRecord: (projectId: string, recordKey: string, version?: number) => Promise<MemoryRecord>;
  readonly updateMemoryStatus: (projectId: string, id: string, expectedRevision: number, status: MemoryRecordStatus) => Promise<MemoryRecord>;
}
