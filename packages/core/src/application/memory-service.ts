import {
  assertTrustedPrincipal,
  authorizeProjectRead,
  requireCapability,
  requireProjectVisible,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import type { MemoryRecord, MemoryStore } from '../ports/knowledge.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from '../ports/validation.js';

const OPERATION = 'MemoryService';

export interface MemoryServiceDeps {
  readonly memories: MemoryStore;
  readonly artifacts: Pick<ArtifactStore, 'getArtifact'>;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
}

export interface MemoryService {
  readonly createCandidate: (principal: unknown, projectId: string, input: unknown) => Promise<MemoryRecord>;
  readonly accept: (principal: unknown, projectId: string, id: string, expectedRevision: number) => Promise<MemoryRecord>;
  readonly revoke: (principal: unknown, projectId: string, id: string, expectedRevision: number) => Promise<MemoryRecord>;
  readonly get: (principal: unknown, projectId: string, recordKey: string, version?: number) => Promise<MemoryRecord>;
}

function authorizeWrite(principal: unknown, projectId: string, operation: string): asserts principal is TrustedPrincipal {
  assertTrustedPrincipal(principal);
  requireCapability(principal, 'project.metadata.write', operation);
  requireProjectVisible(principal, projectId, operation);
}

function sourceInput(value: unknown, projectId: string, operation: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) throw validationError({ operation }, 'sourceRefs', '记忆候选必须至少有一个来源引用');
  return value.map((item, index) => {
    const field = `sourceRefs[${index}]`;
    const object = requirePlainObject(item, { operation }, field);
    rejectUnknownKeys(object, ['projectId', 'artifactId', 'version', 'contentHash'], { operation }, field);
    const artifactId = validateStableId(object.artifactId, { operation }, `${field}.artifactId`);
    const version = validatePositiveInteger(object.version, { operation }, `${field}.version`);
    const contentHash = object.contentHash === undefined ? undefined : validateSha256Digest(object.contentHash, { operation }, `${field}.contentHash`);
    return { projectId, artifactId, version, ...(contentHash === undefined ? {} : { contentHash }) };
  });
}

function contentInput(value: unknown, projectId: string, operation: string): Record<string, unknown> {
  const object = requirePlainObject(value, { operation }, 'contentRef');
  rejectUnknownKeys(object, ['projectId', 'artifactId', 'version', 'contentHash', 'sizeBytes'], { operation }, 'contentRef');
  return {
    projectId,
    artifactId: validateStableId(object.artifactId, { operation }, 'contentRef.artifactId'),
    version: validatePositiveInteger(object.version, { operation }, 'contentRef.version'),
    contentHash: validateSha256Digest(object.contentHash, { operation }, 'contentRef.contentHash'),
    sizeBytes: typeof object.sizeBytes === 'number' && Number.isInteger(object.sizeBytes) && object.sizeBytes >= 0
      ? object.sizeBytes : (() => { throw validationError({ operation }, 'contentRef.sizeBytes', '必须是非负整数', object.sizeBytes); })(),
  };
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createMemoryService: deps 必须是对象');
  async function createCandidate(principal: unknown, projectId: string, input: unknown): Promise<MemoryRecord> {
    const operation = `${OPERATION}.createCandidate`;
    authorizeWrite(principal, projectId, operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const object = requirePlainObject(input, { operation }, 'input');
    rejectUnknownKeys(object, ['recordKey', 'version', 'scope', 'contentRef', 'sourceRefs'], { operation }, 'input');
    const contentRef = contentInput(object.contentRef, validProjectId, operation);
    const sourceRefs = sourceInput(object.sourceRefs, validProjectId, operation);
    const content = await deps.artifacts.getArtifact(validProjectId, contentRef.artifactId as string);
    if (content.status !== 'ready' || content.version !== contentRef.version || content.contentHash !== contentRef.contentHash || content.sizeBytes !== contentRef.sizeBytes) {
      throw new StorageError('validation', operation, '记忆正文引用与 ready 制品身份不一致', { details: { reason: 'content_ref_mismatch' } });
    }
    const verified = await deps.verifier.readVerifiedContent(validProjectId, content.id);
    if (verified.contentHash !== contentRef.contentHash || verified.sizeBytes !== contentRef.sizeBytes) {
      throw new StorageError('corrupt', operation, '记忆正文完整性核验失败', { details: { reason: 'content_identity_mismatch' } });
    }
    for (const source of sourceRefs) {
      const artifact = await deps.artifacts.getArtifact(validProjectId, source.artifactId as string);
      if (artifact.status !== 'ready' || artifact.version !== source.version || (source.contentHash !== undefined && artifact.contentHash !== source.contentHash)) {
        throw new StorageError('validation', operation, '记忆来源引用与 ready 制品身份不一致', { details: { reason: 'source_ref_mismatch' } });
      }
    }
    return deps.memories.createMemoryRecord({
      projectId: validProjectId,
      recordKey: object.recordKey,
      version: object.version,
      scope: object.scope,
      status: 'candidate',
      contentRef,
      sourceRefs,
    });
  }
  async function transition(principal: unknown, projectId: string, id: string, expectedRevision: number, status: 'accepted' | 'revoked'): Promise<MemoryRecord> {
    const operation = `${OPERATION}.${status}`;
    authorizeWrite(principal, projectId, operation);
    validateStableId(projectId, { operation }, 'projectId');
    validateStableId(id, { operation }, 'id');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw validationError({ operation }, 'expectedRevision', '必须是正整数', expectedRevision);
    return deps.memories.updateMemoryStatus(projectId, id, expectedRevision, status);
  }
  async function get(principal: unknown, projectId: string, recordKey: string, version?: number): Promise<MemoryRecord> {
    const operation = `${OPERATION}.get`;
    assertTrustedPrincipal(principal);
    authorizeProjectRead(principal, projectId, operation);
    return deps.memories.getMemoryRecord(validateStableId(projectId, { operation }, 'projectId'), recordKey, version);
  }
  return {
    createCandidate,
    accept: (principal, projectId, id, revision) => transition(principal, projectId, id, revision, 'accepted'),
    revoke: (principal, projectId, id, revision) => transition(principal, projectId, id, revision, 'revoked'),
    get,
  };
}
