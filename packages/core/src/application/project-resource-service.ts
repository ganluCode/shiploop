import {
  assertTrustedPrincipal, authorizeProjectSettingsRead, requireCapability, requireProjectVisible, mapProjectLookupError,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import { StorageError, type StorageErrorKind } from '../ports/errors.js';
import {
  PROJECT_RESOURCE_PUBLIC_OPERATIONS, validateProjectResourceCandidate, validateProjectResourceSelection,
  type ProjectResourceCandidate, type ProjectResourceConfiguration, type ProjectResourceSelection,
  type ProjectResourceSummary,
} from '../ports/project-resources.js';
import { freezeProjectResourceValue, type ProjectResourceStore } from '../ports/project-resource-store.js';
import {
  type ProjectResourceCandidateSource, type ProjectResourceCandidateSourceReader,
  type ProjectResourceCandidateDiscoveryResult, type ProjectResourceCandidatePreview,
} from '../ports/project-resource-candidates.js';

import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from '../ports/validation.js';
import { createProjectResourceCandidateDiscovery } from './project-resource-discovery.js';
import { LOCAL_OWNER_PRINCIPAL_ID } from '../ports/commands.js';
import type { ProjectResourceSourceInput, ProjectResourceSourceResult, ProjectResourceSourceDirectory } from '../ports/project-resource-sources.js';

/** Trusted assembly directory. No path, principal or resource body is taken from a mutation request. */
export interface ProjectResourceCandidateSources {
  configure?: ProjectResourceSourceDirectory['configure'];
  getSource(projectId: string, sourceId: string): (ProjectResourceCandidateSource & { readonly projectId: string }) | null;
}
export interface ProjectResourceImportRequest {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
}
export interface ProjectResourceService {
  configureSource(principal: TrustedPrincipal, input: unknown): Promise<ProjectResourceSourceResult>;
  assertWriteAccess(principal: TrustedPrincipal, projectId: string): void;
  discoverCandidates(principal: TrustedPrincipal, projectId: string, sourceIds: readonly string[]): Promise<ProjectResourceCandidateDiscoveryResult>;
  previewCandidates(principal: TrustedPrincipal, projectId: string, sourceIds: readonly string[], selectedResourceIds?: readonly string[]): Promise<ProjectResourceCandidatePreview>;
  prepareImportCandidate(principal: TrustedPrincipal, projectId: string, expectedRevision: number, request: unknown): Promise<ProjectResourceCandidate>;
  prepareEnable(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string): Promise<ProjectResourceCandidate>;
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
  async function configureSource(principal: TrustedPrincipal, value: unknown): Promise<ProjectResourceSourceResult> {
    assertTrustedPrincipal(principal);
    // This management operation accepts a local path, never an Agent-supplied authority claim.
    if (principal.principalId !== LOCAL_OWNER_PRINCIPAL_ID) fail('ownership', 'owner_required');
    const raw = requirePlainObject(value, CONTEXT, 'source');
    rejectUnknownKeys(raw, ['projectId', 'sourceId', 'action', 'expectedRevision', 'manifestPath'], CONTEXT, 'source');
    const projectId = validateStableId(raw.projectId, CONTEXT, 'projectId');
    const sourceId = validateStableId(raw.sourceId, CONTEXT, 'sourceId');
    authorize(principal, projectId, true);
    read(projectId); // Confirm the project exists before touching any source file.
    if ((raw.action !== 'register' && raw.action !== 'remove') || !Number.isSafeInteger(raw.expectedRevision)
      || (raw.expectedRevision as number) < 0 || (raw.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
      || (raw.action === 'register' && (typeof raw.manifestPath !== 'string' || raw.manifestPath.length > 4096 || raw.manifestPath.includes('\0')))
      || (raw.action === 'remove' && raw.manifestPath !== undefined)) fail('validation', 'invalid_source_registration');
    if (!deps.sources.configure) fail('validation', 'source_registration_unavailable');
    if (raw.action === 'register') {
      const result = await discovery.discover({ projectId, sources: [{ sourceId, path: raw.manifestPath as string }] });
      if (result.rejected.length || result.candidates.length === 0) fail('validation', 'invalid_source_manifest');
    }
    return deps.sources.configure(raw as unknown as ProjectResourceSourceInput);
  }
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
  function candidateSources(projectId: string, sourceIds: readonly string[]): ProjectResourceCandidateSource[] {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 32) fail('validation', 'invalid_source_list');
    const ids = sourceIds.map(sourceId => validateStableId(sourceId, CONTEXT, 'sourceId'));
    if (new Set(ids).size !== ids.length) fail('validation', 'duplicate_source');
    return ids.map(sourceId => {
      const source = deps.sources.getSource(projectId, sourceId);
      if (!source || source.projectId !== projectId || source.sourceId !== sourceId) fail('not_found', 'unknown_source');
      return { sourceId: source.sourceId, path: source.path, ...(source.expectedDigest === undefined ? {} : { expectedDigest: source.expectedDigest }) };
    });
  }

  function existingSummaries(configuration: ProjectResourceConfiguration): ProjectResourceSummary[] {
    return configuration.resources.map(resource => ({
      id: resource.id,
      projectId: resource.projectId,
      kind: resource.kind,
      name: resource.name,
      sourceRef: resource.sourceRef,
      sourceRevision: resource.sourceRevision,
      version: resource.version,
      contentDigest: resource.contentDigest,
      transport: resource.transport,
      capabilities: [...resource.capabilities],
      credentialConfigured: resource.credentialRef !== null,
      required: resource.required,
      onUnavailable: resource.onUnavailable,
    }));
  }

  async function discoverCandidates(principal: TrustedPrincipal, projectId: string, sourceIds: readonly string[]) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    authorize(principal, id, false);
    return discovery.discover({ projectId: id, sources: candidateSources(id, sourceIds) });
  }

  async function previewCandidates(principal: TrustedPrincipal, projectId: string, sourceIds: readonly string[], selectedResourceIds: readonly string[] = []) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    authorize(principal, id, false);
    const configuration = read(id);
    return discovery.preview({
      projectId: id,
      sources: candidateSources(id, sourceIds),
      selectedResourceIds,
      existingResources: existingSummaries(configuration),
    });
  }

  function assertWriteAccess(principal: TrustedPrincipal, projectId: string) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    authorize(principal, id, true);
  }

  async function prepareImportCandidate(principal: TrustedPrincipal, projectId: string, expectedRevision: number, value: unknown) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    check(principal, id, expectedRevision);
    return verify(principal, id, expectedRevision, request(value));
  }

  async function prepareEnable(principal: TrustedPrincipal, projectId: string, expectedRevision: number, resourceId: string) {
    const id = validateStableId(projectId, CONTEXT, 'projectId');
    const configuration = check(principal, id, expectedRevision);
    const rid = validateStableId(resourceId, CONTEXT, 'resourceId');
    const resource = configuration.resources.find(item => item.id === rid);
    if (!resource) fail('not_found', 'resource_not_found');
    if (resource.status === 'revoked') fail('conflict', 'resource_revoked');
    const found = await resolve(id, resource.sourceRef, rid);
    if (found.candidate.digest !== resource.candidateDigest) fail('conflict', 'resource_identity_conflict');
    await verify(principal, id, expectedRevision, {
      sourceId: resource.sourceRef,
      sourceDigest: found.sourceDigest,
      candidateId: rid,
      candidateDigest: resource.candidateDigest,
    });
    return found.candidate;
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
    configureSource,
    assertWriteAccess,
    discoverCandidates,
    previewCandidates,
    prepareImportCandidate,
    prepareEnable,
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
