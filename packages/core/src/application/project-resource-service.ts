import {
  assertTrustedPrincipal, authorizeProjectSettingsRead, requireCapability, requireProjectVisible, mapProjectLookupError,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import { StorageError, type StorageErrorKind } from '../ports/errors.js';
import {
  PROJECT_RESOURCE_PUBLIC_OPERATIONS, validateProjectResourceCandidate, validateProjectResourceSelection,
  type ProjectResourceCandidate, type ProjectResourceConfiguration, type ProjectResourceSelection,
} from '../ports/project-resources.js';
import { freezeProjectResourceValue, type ProjectResourceStore } from '../ports/project-resource-store.js';
import {
  type ProjectResourceCandidateSource, type ProjectResourceCandidateSourceReader,
} from '../ports/project-resource-candidates.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from '../ports/validation.js';
import { createProjectResourceCandidateDiscovery } from './project-resource-discovery.js';

/** Trusted assembly directory. No path, principal or resource body is taken from a mutation request. */
export interface ProjectResourceCandidateSources {
  getSource(projectId: string, sourceId: string): (ProjectResourceCandidateSource & { readonly projectId: string }) | null;
}
export interface ProjectResourceImportRequest {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
}
export interface ProjectResourceService {
  getConfiguration(principal: TrustedPrincipal, projectId: string): ProjectResourceConfiguration;
  list(principal: TrustedPrincipal, projectId: string): ProjectResourceConfiguration;
  importCandidate(principal: TrustedPrincipal, projectId: string, expectedRevision: number, request: unknown): Promise<ProjectResourceConfiguration>;
  select(principal: TrustedPrincipal, projectId: string, expectedRevision: number, request: unknown): Promise<ProjectResourceConfiguration>;
  enable(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string): Promise<ProjectResourceConfiguration>;
  disable(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string): Promise<ProjectResourceConfiguration>;
  revoke(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string): Promise<ProjectResourceConfiguration>;
  /** New execution input boundary only. F-004 binds it to Run/Attempt artifacts. */
  snapshotForAttempt(principal: TrustedPrincipal, projectId: string): ProjectResourceSelection;
}

const OPERATION = 'ProjectResourceService';
const CONTEXT = { operation: OPERATION };
function fail(kind: StorageErrorKind, reason: string): never {
  throw new StorageError(kind, OPERATION, `Project resource rejected: ${reason}`, { details: { reason } });
}
function request(value: unknown): ProjectResourceImportRequest {
  const raw = requirePlainObject(value, CONTEXT, 'request');
  rejectUnknownKeys(raw, ['sourceId', 'sourceDigest', 'candidateId', 'candidateDigest'], CONTEXT, 'request');
  const sourceId = validateStableId(raw.sourceId, CONTEXT, 'sourceId');
  const candidateId = validateStableId(raw.candidateId, CONTEXT, 'candidateId');
  for (const key of ['sourceDigest', 'candidateDigest']) {
    if (typeof raw[key] !== 'string' || !/^[a-f0-9]{64}$/.test(raw[key])) throw validationError(CONTEXT, key, 'Expected SHA-256 digest');
  }
  return { sourceId, candidateId, sourceDigest: raw.sourceDigest as string, candidateDigest: raw.candidateDigest as string };
}

export function createProjectResourceService(deps: {
  readonly store: ProjectResourceStore;
  readonly sources: ProjectResourceCandidateSources;
  readonly sourceReader: ProjectResourceCandidateSourceReader;
}): ProjectResourceService {
  const discovery = createProjectResourceCandidateDiscovery({ sourceReader: deps.sourceReader });
  function authorize(principal: TrustedPrincipal, id: string, write: boolean) {
    assertTrustedPrincipal(principal);
    if (write) {
      requireCapability(principal, 'settings.project.write', OPERATION);
      requireProjectVisible(principal, id, OPERATION);
    } else authorizeProjectSettingsRead(principal, id, OPERATION);
  }
  function read(projectId: string) {
    try { return deps.store.getConfiguration(projectId); }
    catch (error) { return mapProjectLookupError(error, OPERATION); }
  }
  function check(principal: TrustedPrincipal, projectId: string, expectedRevision: number) {
    authorize(principal, projectId, true);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('validation', 'invalid_revision');
    const configuration = read(projectId);
    if (configuration.revision !== expectedRevision) fail('conflict', 'stale_revision');
    return configuration;
  }
  function getConfiguration(principal: TrustedPrincipal, projectId: string) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    authorize(principal, id, false);
    return read(id);
  }

  async function resolve(projectId: string, sourceId: string, candidateId: string, expectedSourceDigest?: string) {
    const source = deps.sources.getSource(projectId, sourceId);
    if (!source) fail('not_found', 'unknown_source');
    if (source.projectId !== projectId) fail('ownership', 'cross_project_reference');
    if (source.expectedDigest !== undefined && expectedSourceDigest !== undefined
      && source.expectedDigest !== expectedSourceDigest) fail('conflict', 'digest_mismatch');
    // Copy before await: a mutable directory entry cannot redirect a verified read.
    const input = { sourceId: source.sourceId, path: source.path,
      ...(expectedSourceDigest === undefined && source.expectedDigest === undefined ? {} : { expectedDigest: expectedSourceDigest ?? source.expectedDigest }) };
    if (source.sourceId !== sourceId) fail('ownership', 'cross_project_reference');
    const found = await discovery.discover({ projectId, sources: [input] });
    const rejected = found.rejected[0];
    if (rejected) {
      const reason = rejected.reason;
      fail(reason === 'source_missing' ? 'not_found' : reason === 'digest_mismatch' ? 'conflict' : 'validation', reason);
    }
    const candidate = found.candidates.find(c => c.id === candidateId);
    if (!candidate) fail('not_found', 'unknown_candidate');
    const { availability: _availability, metadata: _metadata, ...base } = candidate;
    return { candidate: validateProjectResourceCandidate(base), sourceDigest: found.sources[0]!.sourceDigest! };
  }

  async function verify(principal: TrustedPrincipal, projectId: string, expectedRevision: number, input: ProjectResourceImportRequest): Promise<ProjectResourceCandidate> {
    const first = await resolve(projectId, input.sourceId, input.candidateId, input.sourceDigest);
    if (first.candidate.digest !== input.candidateDigest) fail('conflict', 'digest_mismatch');
    // Re-read outside the write transaction, pinned to the prepared digest. File
    // drift/disappearance and source-directory changes reject before committing.
    check(principal, projectId, expectedRevision);
    const last = await resolve(projectId, input.sourceId, input.candidateId, first.sourceDigest);
    if (last.candidate.digest !== input.candidateDigest) fail('conflict', 'digest_mismatch');
    return last.candidate;
  }

  async function importCandidate(principal: TrustedPrincipal, projectId: string, expectedRevision: number, value: unknown) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    check(principal, id, expectedRevision);
    const input = request(value);
    const candidate = await verify(principal, id, expectedRevision, input);
    return deps.store.transactWrite(`${OPERATION}.import`, () => {
      check(principal, id, expectedRevision);
      return deps.store.importCandidateInTransaction(id, expectedRevision, candidate);
    });
  }

  async function changeEnabled(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string, enabled: boolean) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    const configuration = check(principal, id, expectedRevision);
    const rid = validateStableId(resourceId, CONTEXT, 'resourceId');
    const resource = configuration.resources.find(r => r.id === rid);
    if (!resource) fail('not_found', 'resource_not_found');
    if (resource.status === 'revoked') fail('conflict', 'resource_revoked');
    if (enabled) {
      const found = await resolve(id, resource.sourceRef, rid);
      if (found.candidate.digest !== resource.candidateDigest) fail('conflict', 'resource_identity_conflict');
      await verify(principal, id, expectedRevision, { sourceId: resource.sourceRef, sourceDigest: found.sourceDigest, candidateId: rid, candidateDigest: resource.candidateDigest });
    }
    return deps.store.transactWrite(`${OPERATION}.enable`, () => {
      check(principal, id, expectedRevision);
      return deps.store.setEnabledInTransaction(id, expectedRevision, rid, enabled);
    });
  }

  return {
    getConfiguration, list: getConfiguration, importCandidate, select: importCandidate,
    enable: (p, id, revision, rid) => changeEnabled(p, id, revision, rid, true),
    disable: (p, id, revision, rid) => changeEnabled(p, id, revision, rid, false),
    async revoke(principal, projectId, expectedRevision, resourceId) {
      const id = validateStableId(projectId, CONTEXT, 'projectId');
      check(principal, id, expectedRevision);
      const rid = validateStableId(resourceId, CONTEXT, 'resourceId');
      return deps.store.transactWrite(`${OPERATION}.revoke`, () => {
        check(principal, id, expectedRevision);
        return deps.store.revokeInTransaction(id, expectedRevision, rid);
      });
    },
    snapshotForAttempt(principal, projectId) {
      const configuration = getConfiguration(principal, projectId);
      const resources = configuration.resources.filter(r => r.status === 'active' && r.enabled)
        .map(({ candidateDigest: _digest, importedAtUtcMs: _time, enabled: _enabled, status: _status, ...descriptor }) => descriptor);
      return freezeProjectResourceValue(validateProjectResourceSelection({ schemaVersion: 1, projectId,
        revision: configuration.revision, resources, operations: [...PROJECT_RESOURCE_PUBLIC_OPERATIONS],
        allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false }));
    },
  };
}
