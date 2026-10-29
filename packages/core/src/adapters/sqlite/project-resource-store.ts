import { StorageError } from '../../ports/errors.js';
import {
  computeProjectResourceConfigurationDigest, PROJECT_RESOURCE_MAX_RESOURCES, validateProjectResourceCandidate,
  type ProjectResourceConfiguration, type ProjectResourceRecord,
} from '../../ports/project-resources.js';
import { freezeProjectResourceValue, projectResourceDescriptor, type ProjectResourceStore } from '../../ports/project-resource-store.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteStateAccess } from './state-store.js';

/** No new tables or migrations: project_settings remains the sole configuration authority. */
export function createSqliteProjectResourceStore(
  session: SqliteStorageSession, options: { readonly nowUtcMs?: () => number } = {},
): ProjectResourceStore {
  const state = createSqliteStateAccess(session, options);
  const now = options.nowUtcMs ?? Date.now;
  const operation = 'ProjectResourceStore';

  function fail(kind: 'conflict' | 'not_found' | 'validation', projectId: string, reason: string): never {
    throw new StorageError(kind, operation, `Project resource rejected: ${reason}`, {
      entity: { type: 'project_resource', projectId }, details: { reason },
    });
  }

  function getConfiguration(projectId: string): ProjectResourceConfiguration {
    state.getProject(projectId);
    const settings = state.getProjectSettingsOrNull(projectId);
    const body = { schemaVersion: 1 as const, projectId, revision: settings?.revision ?? 0,
      resources: settings?.payload.projectResources?.resources ?? [] };
    return freezeProjectResourceValue({ ...body, digest: computeProjectResourceConfigurationDigest(body) });
  }

  function current(projectId: string, expected: number) {
    if (!session.database.inTransaction) throw new TypeError('Resource mutations require a caller-owned write transaction');
    if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) fail('validation', projectId, 'invalid_revision');
    const configuration = getConfiguration(projectId);
    if (configuration.revision !== expected) fail('conflict', projectId, 'stale_revision');
    return configuration;
  }

  function persist(projectId: string, expected: number, resources: readonly ProjectResourceRecord[]): ProjectResourceConfiguration {
    // Reuse the existing insert-only/CAS SQL, FK checks and same-transaction audit.
    const settings = state.getProjectSettingsOrNull(projectId);
    const payload = { ...(settings?.payload ?? { schemaVersion: 2 as const }),
      projectResources: { schemaVersion: 1 as const, projectId, resources } };
    if (settings === null) {
      state.createProjectSettingsInTransaction(projectId, { payload }, { resourceWrite: true, recordCreatedEvent: true });
    } else {
      state.updateProjectSettingsInTransaction(projectId, { payload, expectedRevision: expected }, { resourceWrite: true });
    }
    return getConfiguration(projectId);
  }

  return {
    getConfiguration,
    transactWrite: (name, fn) => session.transactWrite(name, fn),
    importCandidateInTransaction(projectId, expectedRevision, input) {
      const configuration = current(projectId, expectedRevision);
      const candidate = validateProjectResourceCandidate(input);
      if (candidate.projectId !== projectId) fail('validation', projectId, 'cross_project_reference');
      const existing = configuration.resources.find(r => r.id === candidate.id);
      if (existing) {
        if (existing.candidateDigest !== candidate.digest) fail('conflict', projectId, 'resource_identity_conflict');
        if (existing.status === 'revoked') fail('conflict', projectId, 'resource_revoked');
        return configuration;
      }
      if (configuration.resources.some(r => r.kind === candidate.kind && r.name === candidate.name && r.status === 'active')) fail('conflict', projectId, 'duplicate_name');
      if (configuration.resources.length >= PROJECT_RESOURCE_MAX_RESOURCES) fail('validation', projectId, 'limit_exceeded');
      const resource: ProjectResourceRecord = { ...projectResourceDescriptor(candidate), candidateDigest: candidate.digest,
        importedAtUtcMs: now(), enabled: true, status: 'active' };
      return persist(projectId, expectedRevision, [...configuration.resources, resource].sort((a, b) => a.id.localeCompare(b.id)));
    },
    setEnabledInTransaction(projectId, expectedRevision, resourceId, enabled) {
      const configuration = current(projectId, expectedRevision);
      if (typeof enabled !== 'boolean') fail('validation', projectId, 'invalid_enabled');
      const resource = configuration.resources.find(r => r.id === resourceId);
      if (!resource) fail('not_found', projectId, 'resource_not_found');
      if (resource.status === 'revoked') fail('conflict', projectId, 'resource_revoked');
      if (resource.enabled === enabled) return configuration;
      return persist(projectId, expectedRevision, configuration.resources.map(r => r.id === resourceId ? { ...r, enabled } : r));
    },
    revokeInTransaction(projectId, expectedRevision, resourceId) {
      const configuration = current(projectId, expectedRevision);
      const resource = configuration.resources.find(r => r.id === resourceId);
      if (!resource) fail('not_found', projectId, 'resource_not_found');
      if (resource.status === 'revoked') fail('conflict', projectId, 'already_revoked');
      return persist(projectId, expectedRevision, configuration.resources.map(r => r.id === resourceId ? { ...r, enabled: false, status: 'revoked' } : r));
    },
  };
}
