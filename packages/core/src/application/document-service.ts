/**
 * P06-2 / F-002 文档版本发布与受控读取应用服务。
 *
 * 文件来源只经过 InputSourceFileReader；已有正文只经过 ArtifactStore/Verifier。
 * 这里不接收绝对路径，也不把请求中的 projectId 当作授权依据：项目身份由
 * Host 传入的 TrustedPrincipal 可见范围与独立的目标参数共同核验。
 */
import { createHash } from 'node:crypto';
import type { DocumentRecord, DocumentStore, DocumentVersionRecord, KnowledgeSourceRef } from '../ports/knowledge.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  assertTrustedPrincipal,
  requireCapability,
  requireProjectVisible,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { ArtifactVerifier, VerifiedArtifactContent } from './artifact-verify.js';
import type { InputSourceFileReader } from '../ports/execution-input.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateArtifactLocator,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from '../ports/validation.js';

const OPERATION = 'DocumentService';
const DOCUMENT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export type DocumentSource =
  | { readonly kind: 'file'; readonly root: string; readonly relativePath: string; readonly mediaType?: string }
  | { readonly kind: 'artifact'; readonly artifactId: string };

interface ValidatedDocumentSourceFile {
  readonly kind: 'file';
  readonly root: string;
  readonly relativePath: string;
  readonly mediaType: string;
}

interface ValidatedDocumentSourceArtifact {
  readonly kind: 'artifact';
  readonly artifactId: string;
}

interface ValidatedPublishInput {
  readonly title: string;
  readonly documentType: string;
  readonly documentId: string | undefined;
  readonly version: number;
  readonly status: 'draft' | 'published' | 'withdrawn';
  readonly reviewStatus: 'pending' | 'approved' | 'rejected';
  readonly reviewedAgainstRevision: string | null;
  readonly source: ValidatedDocumentSourceFile | ValidatedDocumentSourceArtifact;
  readonly sourceRefs: readonly { artifactId: string; version: number; contentHash?: string }[];
}

export interface DocumentPublicationResult {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
  readonly artifact: DocumentVersionRecord['contentRef'];
}

export interface DocumentReadResult {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
  readonly projectId: string;
  readonly content: Uint8Array;
  readonly contentText: string | null;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly sourceRefs: readonly KnowledgeSourceRef[];
  readonly truncated: boolean;
  readonly offsetBytes: 0;
}

export interface DocumentService {
  readonly createDocument: (principal: unknown, projectId: string, input: unknown) => Promise<DocumentRecord>;
  readonly registerDocumentVersion: (principal: unknown, projectId: string, input: unknown) => Promise<DocumentPublicationResult>;
  /** Alias used by callers that name the operation after its publication effect. */
  readonly publishDocumentVersion: (principal: unknown, projectId: string, input: unknown) => Promise<DocumentPublicationResult>;
  readonly readDocument: (principal: unknown, projectId: string, documentId: string, version?: number, options?: unknown) => Promise<DocumentReadResult>;
  readonly readDocumentVersion: (principal: unknown, projectId: string, documentId: string, version?: number, options?: unknown) => Promise<DocumentReadResult>;
}

export interface DocumentServiceDeps {
  readonly documents: DocumentStore;
  readonly artifacts: ArtifactStore;
  readonly publisher: Pick<ArtifactPublisher, 'publishArtifact'>;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  readonly sources: Pick<InputSourceFileReader, 'openSourceRead'>;
  readonly maxSourceBytes?: number;
}

function failValidation(operation: string, field: string, message: string, value?: unknown): never {
  throw validationError({ operation, entity: { type: 'document' } }, field, message, value);
}

function validateSource(value: unknown, operation: string): ValidatedDocumentSourceFile | ValidatedDocumentSourceArtifact {
  const object = requirePlainObject(value, { operation, entity: { type: 'document' } }, 'source');
  if (object.kind === 'file') {
    rejectUnknownKeys(object, ['kind', 'root', 'relativePath', 'mediaType'], { operation }, 'source');
    return {
      kind: 'file',
      root: validateStableId(object.root, { operation }, 'source.root'),
      relativePath: validateArtifactLocator(object.relativePath, { operation }, 'source.relativePath'),
      mediaType: object.mediaType === undefined ? 'text/plain' : requireNonEmptyString(object.mediaType, { operation }, 'source.mediaType'),
    };
  }
  if (object.kind === 'artifact') {
    rejectUnknownKeys(object, ['kind', 'artifactId'], { operation }, 'source');
    return { kind: 'artifact', artifactId: validateStableId(object.artifactId, { operation }, 'source.artifactId') };
  }
  return failValidation(operation, 'source.kind', '文档来源必须是 file 或 artifact', object.kind);
}

function validateSourceRefs(value: unknown, projectId: string, operation: string): ValidatedDocumentVersionInputSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return failValidation(operation, 'sourceRefs', 'sourceRefs 必须是数组');
  return value.map((item, index) => {
    const field = `sourceRefs[${index}]`;
    const object = requirePlainObject(item, { operation }, field);
    rejectUnknownKeys(object, ['artifactId', 'version', 'contentHash'], { operation }, field);
    return {
      artifactId: validateStableId(object.artifactId, { operation }, `${field}.artifactId`),
      version: validatePositiveInteger(object.version, { operation }, `${field}.version`),
      ...(object.contentHash === undefined ? {} : { contentHash: validateSha256Digest(object.contentHash, { operation }, `${field}.contentHash`) }),
    };
  });
}

type ValidatedDocumentVersionInputSource = { readonly artifactId: string; readonly version: number; readonly contentHash?: string };

function validatePublishInput(value: unknown, projectId: string, operation: string): ValidatedPublishInput {
  const object = requirePlainObject(value, { operation, entity: { type: 'document', projectId } }, 'input');
  rejectUnknownKeys(object, ['title', 'documentType', 'documentId', 'version', 'status', 'reviewStatus', 'reviewedAgainstRevision', 'source', 'sourceRefs'], { operation }, 'input');
  const documentId = object.documentId === undefined ? undefined : validateStableId(object.documentId, { operation }, 'documentId');
  const status = object.status === undefined ? 'published' : object.status;
  if (status !== 'draft' && status !== 'published' && status !== 'withdrawn') failValidation(operation, 'status', '文档版本状态无效', status);
  const reviewStatus = object.reviewStatus === undefined ? 'pending' : object.reviewStatus;
  if (reviewStatus !== 'pending' && reviewStatus !== 'approved' && reviewStatus !== 'rejected') failValidation(operation, 'reviewStatus', '文档复核状态无效', reviewStatus);
  const reviewedAgainstRevision = object.reviewedAgainstRevision === undefined || object.reviewedAgainstRevision === null
    ? null : requireNonEmptyString(object.reviewedAgainstRevision, { operation }, 'reviewedAgainstRevision');
  return {
    title: requireNonEmptyString(object.title, { operation }, 'title'),
    documentType: requireNonEmptyString(object.documentType, { operation }, 'documentType'),
    documentId,
    version: object.version === undefined ? 1 : validatePositiveInteger(object.version, { operation }, 'version'),
    status,
    reviewStatus,
    reviewedAgainstRevision,
    source: validateSource(object.source, operation),
    sourceRefs: validateSourceRefs(object.sourceRefs, projectId, operation),
  };
}

function authorize(principal: unknown, projectId: string, operation: string, write: boolean): asserts principal is TrustedPrincipal {
  assertTrustedPrincipal(principal);
  requireCapability(principal, write ? 'project.metadata.write' : 'project.read', operation);
  requireProjectVisible(principal, projectId, operation);
}

async function readSourceFile(
  sources: Pick<InputSourceFileReader, 'openSourceRead'>,
  source: ValidatedDocumentSourceFile,
  maxBytes: number,
): Promise<{ readonly body: Uint8Array; readonly hash: string; readonly sizeBytes: number }> {
  const content = await sources.openSourceRead({ root: source.root, relativePath: source.relativePath });
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    for await (const raw of content.stream) {
      const chunk = Buffer.from(raw as Uint8Array);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) {
        throw new StorageError('validation', `${OPERATION}.registerDocumentVersion`, '文档正文超过受控大小上限', {
          details: { reason: 'source_size_limit', maxSourceBytes: maxBytes },
        });
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    content.stream.destroy();
    throw error;
  }
  if (sizeBytes !== content.sizeBytes) {
    throw new StorageError('conflict', `${OPERATION}.registerDocumentVersion`, '文档来源在读取期间发生变化，拒绝发布不确定正文', {
      details: { reason: 'source_changed_during_read' },
    });
  }
  return { body: Buffer.concat(chunks), hash: hash.digest('hex'), sizeBytes };
}

export function createDocumentService(deps: DocumentServiceDeps): DocumentService {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createDocumentService: deps 必须是对象');
  for (const [name, value] of Object.entries(deps)) {
    if (name !== 'maxSourceBytes' && (value === null || typeof value !== 'object')) throw new TypeError(`createDocumentService: ${name} 端口未装配`);
  }
  const maxSourceBytes = deps.maxSourceBytes ?? DOCUMENT_MAX_SOURCE_BYTES;
  if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1) throw new TypeError('createDocumentService: maxSourceBytes 必须是正整数');

  async function createDocument(principal: unknown, projectId: string, input: unknown): Promise<DocumentRecord> {
    const operation = `${OPERATION}.createDocument`;
    authorize(principal, projectId, operation, true);
    const object = requirePlainObject(input, { operation }, 'input');
    rejectUnknownKeys(object, ['title', 'documentType', 'status'], { operation }, 'input');
    return deps.documents.createDocument({ projectId, title: object.title, documentType: object.documentType, status: object.status });
  }

  async function registerDocumentVersion(principal: unknown, projectId: string, input: unknown): Promise<DocumentPublicationResult> {
    const operation = `${OPERATION}.registerDocumentVersion`;
    authorize(principal, projectId, operation, true);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const valid = validatePublishInput(input, validProjectId, operation);

    let document: DocumentRecord;
    if (valid.documentId !== undefined) {
      document = await deps.documents.getDocument(validProjectId, valid.documentId);
      // Retry/replay is checked before opening a source or publishing another Artifact.
      try {
        const existing = await deps.documents.getDocumentVersion(validProjectId, document.id, valid.version);
        return { document, version: existing, artifact: existing.contentRef };
      } catch (error) {
        if (!isStorageError(error, 'not_found')) throw error;
      }
    } else {
      document = await deps.documents.createDocument({ projectId: validProjectId, title: valid.title, documentType: valid.documentType });
    }

    let contentRef: DocumentVersionRecord['contentRef'];
    let sourceRefs = valid.sourceRefs.map(source => ({ projectId: validProjectId, ...source }));
    let body: Uint8Array;
    let expectedHash: string;
    let mediaType = 'text/plain';
    let sizeBytes: number;
    if (valid.source.kind === 'artifact') {
      const artifact = await deps.artifacts.getArtifact(validProjectId, valid.source.artifactId);
      const verified = await deps.verifier.readVerifiedContent(validProjectId, artifact.id);
      body = verified.content;
      expectedHash = verified.contentHash;
      sizeBytes = verified.sizeBytes;
      mediaType = artifact.mediaType;
      if (sourceRefs.length === 0) sourceRefs = [{ projectId: validProjectId, artifactId: artifact.id, version: artifact.version, contentHash: verified.contentHash }];
    } else {
      const captured = await readSourceFile(deps.sources, valid.source, maxSourceBytes);
      body = captured.body;
      expectedHash = captured.hash;
      sizeBytes = captured.sizeBytes;
      mediaType = valid.source.mediaType;
    }
    const published = await deps.publisher.publishArtifact({
      projectId: validProjectId,
      kind: 'document',
      mediaType,
      expectedHash,
      locator: `documents/${document.id}/v${valid.version}`,
      version: valid.version,
      content: [body],
    });
    const artifact = published.artifact;
    contentRef = {
      projectId: validProjectId,
      artifactId: artifact.id,
      version: artifact.version,
      contentHash: artifact.contentHash ?? expectedHash,
      sizeBytes: artifact.sizeBytes ?? sizeBytes,
    };

    const version = await deps.documents.createDocumentVersion({
      projectId: validProjectId,
      documentId: document.id,
      version: valid.version,
      status: valid.status,
      contentRef,
      contentHash: contentRef.contentHash,
      sourceRefs,
      reviewStatus: valid.reviewStatus,
      reviewedAgainstRevision: valid.reviewedAgainstRevision,
    });
    return { document: await deps.documents.getDocument(validProjectId, document.id), version, artifact: version.contentRef };
  }

  async function readDocument(principal: unknown, projectId: string, documentId: string, version?: number, options?: unknown): Promise<DocumentReadResult> {
    const operation = `${OPERATION}.readDocument`;
    authorize(principal, projectId, operation, false);
    const object = options === undefined ? {} : requirePlainObject(options, { operation }, 'options');
    rejectUnknownKeys(object, ['maxBytes'], { operation }, 'options');
    const maxBytes = object.maxBytes === undefined ? maxSourceBytes : validatePositiveInteger(object.maxBytes, { operation }, 'options.maxBytes');
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const docVersion = await deps.documents.getDocumentVersion(validProjectId, documentId, version);
    const verified: VerifiedArtifactContent = await deps.verifier.readVerifiedContent(validProjectId, docVersion.contentRef.artifactId);
    if (verified.contentHash !== docVersion.contentHash || verified.sizeBytes !== docVersion.contentRef.sizeBytes) {
      throw new StorageError('corrupt', operation, '文档正文核验结果与版本身份不一致', {
        entity: { type: 'document_version', id: docVersion.id, projectId: validProjectId },
        details: { reason: 'content_identity_mismatch' },
      });
    }
    const content = verified.content.byteLength > maxBytes ? verified.content.slice(0, maxBytes) : verified.content;
    let contentText: string | null = null;
    if (docVersion.contentRef.sizeBytes <= maxBytes && /^text\//u.test('text/plain')) contentText = new TextDecoder().decode(content);
    return {
      document: await deps.documents.getDocument(validProjectId, docVersion.documentId),
      version: docVersion,
      projectId: validProjectId,
      content,
      contentText,
      contentHash: verified.contentHash,
      sizeBytes: verified.sizeBytes,
      sourceRefs: docVersion.sourceRefs,
      truncated: verified.content.byteLength > maxBytes,
      offsetBytes: 0,
    };
  }

  return {
    createDocument,
    registerDocumentVersion,
    publishDocumentVersion: registerDocumentVersion,
    readDocument,
    readDocumentVersion: readDocument,
  };
}
