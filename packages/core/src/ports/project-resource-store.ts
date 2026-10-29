import { StorageError } from './errors.js';
import {
  PROJECT_RESOURCE_MAX_RESOURCES,
  ProjectResourceError,
  validateProjectResourceCandidate,
  type ProjectResourceCandidate,
  type ProjectResourceConfiguration,
  type ProjectResourceDescriptor,
  type ProjectResourceRecord,
} from './project-resources.js';
import {
  rejectUnknownKeys, requirePlainObject, validateNonNegativeInteger, validationError,
  type ValidationContext,
} from './validation.js';

/** Optional v1 section of the authoritative project_settings v2 payload. */
export interface ProjectResourceSettings {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly resources: readonly ProjectResourceRecord[];
}

export function projectResourceDescriptor(candidate: ProjectResourceCandidate): ProjectResourceDescriptor {
  const { schemaVersion: _schema, state: _state, summary: _summary, digest: _digest, ...descriptor } = candidate;
  return descriptor;
}

export function freezeProjectResourceValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProjectResourceValue(child);
    Object.freeze(value);
  }
  return value;
}

const RECORD_KEYS = ['id', 'projectId', 'sourceProjectId', 'kind', 'name', 'sourceRef', 'sourceRevision',
  'version', 'contentDigest', 'transport', 'capabilities', 'credentialRef', 'required', 'onUnavailable',
  'candidateDigest', 'importedAtUtcMs', 'enabled', 'status'] as const;

/** Revalidate persisted identities, digests, status and bounds; never accept arbitrary JSON. */
export function validateProjectResourceSettings(value: unknown, context: ValidationContext): ProjectResourceSettings {
  const raw = requirePlainObject(value, context, 'payload.projectResources');
  rejectUnknownKeys(raw, ['schemaVersion', 'projectId', 'resources'], context, 'payload.projectResources');
  if (raw.schemaVersion !== 1) throw validationError(context, 'payload.projectResources.schemaVersion', 'Unsupported resource schema');
  if (!Array.isArray(raw.resources) || raw.resources.length > PROJECT_RESOURCE_MAX_RESOURCES) {
    throw validationError(context, 'payload.projectResources.resources', 'Invalid resource list');
  }
  const resources = raw.resources.map(item => {
    const row = requirePlainObject(item, context, 'payload.projectResources.resources[]');
    rejectUnknownKeys(row, RECORD_KEYS, context, 'payload.projectResources.resources[]');
    const { candidateDigest, importedAtUtcMs, enabled, status, ...descriptor } = row;
    let candidate: ProjectResourceCandidate;
    try {
      candidate = validateProjectResourceCandidate({ ...descriptor, schemaVersion: 1, state: 'candidate', digest: candidateDigest });
    } catch (error) {
      if (error instanceof ProjectResourceError) {
        throw new StorageError('validation', context.operation, 'Invalid project resource identity', {
          entity: context.entity, details: { reason: error.reason, field: 'payload.projectResources' },
        });
      }
      throw error;
    }
    if (candidate.projectId !== raw.projectId || typeof candidateDigest !== 'string' || candidateDigest !== candidate.digest
      || typeof enabled !== 'boolean' || (status !== 'active' && status !== 'revoked') || (status === 'revoked' && enabled)) {
      throw validationError(context, 'payload.projectResources', 'Invalid resource ownership, digest or status');
    }
    return { ...projectResourceDescriptor(candidate), candidateDigest, enabled, status,
      importedAtUtcMs: validateNonNegativeInteger(importedAtUtcMs, context, 'importedAtUtcMs') } as ProjectResourceRecord;
  });
  // The selection validator also checks project UUIDs when the resource list is empty.
  if (typeof raw.projectId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.projectId)) {
    throw validationError(context, 'payload.projectResources.projectId', 'Invalid project identity');
  }
  if (new Set(resources.map(r => r.id)).size !== resources.length) {
    throw validationError(context, 'payload.projectResources.resources', 'Duplicate resource identity');
  }
  return { schemaVersion: 1, projectId: raw.projectId, resources: resources.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Storage primitives share the StateStore settings CAS and audit transaction. */
export interface ProjectResourceStore {
  getConfiguration(projectId: string): ProjectResourceConfiguration;
  transactWrite<T>(operation: string, fn: () => T): T;
  importCandidateInTransaction(projectId: string, expectedRevision: number, candidate: ProjectResourceCandidate): ProjectResourceConfiguration;
  setEnabledInTransaction(projectId: string, expectedRevision: number, resourceId: string, enabled: boolean): ProjectResourceConfiguration;
  revokeInTransaction(projectId: string, expectedRevision: number, resourceId: string): ProjectResourceConfiguration;
}
