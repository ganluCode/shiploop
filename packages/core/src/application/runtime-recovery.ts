import type { ArtifactStore } from '../ports/artifact-store.js';
import { computeExecutionPermissionsDigest } from '../ports/execution-input-prepare.js';
import { validateExecutionInputRef } from '../ports/execution-input.js';
import type { ExecutionInputRef } from '../ports/execution-input.js';
import { stableStringify } from '../ports/feature-plan.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { validateRuntimeRecoveryStrategy } from '../ports/runtime-recovery-catalog.js';
import type { RuntimeRecoveryCatalog } from '../ports/runtime-recovery-catalog.js';
import { decideRuntimeRecovery, validateRuntimeRecoveryReference, validateRuntimeRecoveryRequest } from '../ports/runtime-recovery.js';
import type { RuntimeRecoveryDecision } from '../ports/runtime-recovery.js';
import { RUNTIME_RECOVERY_EVIDENCE_KIND } from '../ports/runtime-recovery-source.js';
import type { RuntimeRecoveryCurrentContext, RuntimeRecoveryAccessSnapshot, RuntimeRecoverySourceEvidence, RuntimeRecoverySourceReader, RuntimeRecoverySourceState } from '../ports/runtime-recovery-source.js';
import { rejectUnknownKeys, requirePlainObject, requireNonEmptyString, validateSha256Digest, validateStableId, validationError } from '../ports/validation.js';
import type { ArtifactVerifier } from './artifact-verify.js';

const context = { operation: 'RuntimeRecovery.evaluate' };
function fail(field: string, reason: string): never {
  throw validationError(context, field, reason);
}
function object(value: unknown, keys: readonly string[], field: string) {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, keys, context, field);
  return raw;
}
function currentContext(value: unknown): RuntimeRecoveryCurrentContext {
  const raw = object(value, ['inputSnapshot', 'codeDigest', 'permissions', 'workAccess'], 'current');
  const permissions = object(raw.permissions, ['grants'], 'current.permissions');
  if (!Array.isArray(permissions.grants)) fail('current.permissions.grants', 'array_required');
  return { inputSnapshot: validateExecutionInputRef(raw.inputSnapshot, context.operation),
    codeDigest: validateSha256Digest(raw.codeDigest, context, 'current.codeDigest'),
    permissions: { grants: permissions.grants.map((grant, i) => requireNonEmptyString(grant, context, `grants[${i}]`)) },
    ...(raw.workAccess === undefined ? {} : { workAccess: access(raw.workAccess, 'current.workAccess') }),
  };
}
function access(value: unknown, field: string): RuntimeRecoveryAccessSnapshot {
  const raw = object(value, ['strategy', 'authentication', 'resources'], field);
  const strategyRaw = object(raw.strategy, ['runtime', 'provider', 'model'], `${field}.strategy`);
  const strategy = {
    runtime: requireNonEmptyString(strategyRaw.runtime, context, `${field}.strategy.runtime`),
    provider: requireNonEmptyString(strategyRaw.provider, context, `${field}.strategy.provider`),
    model: requireNonEmptyString(strategyRaw.model, context, `${field}.strategy.model`),
  } as RuntimeRecoveryAccessSnapshot['strategy'];
  const authRaw = object(raw.authentication, ['status', 'digest', 'sourceRef', 'kind'], `${field}.authentication`);
  const status = authRaw.status;
  if (!['ready', 'missing', 'expired', 'revoked', 'invalid', 'unknown'].includes(status as string)) {
    fail(`${field}.authentication.status`, 'invalid_authentication_status');
  }
  if (!['environment', 'local_login', 'plugin'].includes(authRaw.kind as string)) {
    fail(`${field}.authentication.kind`, 'invalid_authentication_kind');
  }
  const authentication = {
    status: status as RuntimeRecoveryAccessSnapshot['authentication']['status'],
    digest: validateSha256Digest(authRaw.digest, context, `${field}.authentication.digest`),
    sourceRef: validateStableId(authRaw.sourceRef, context, `${field}.authentication.sourceRef`),
    kind: authRaw.kind as RuntimeRecoveryAccessSnapshot['authentication']['kind'],
  };
  const resourcesRaw = object(raw.resources, ['digest', 'entries'], `${field}.resources`);
  if (!Array.isArray(resourcesRaw.entries) || resourcesRaw.entries.length > 64) {
    fail(`${field}.resources.entries`, 'invalid_resource_entries');
  }
  const entries = resourcesRaw.entries.map((entry, index) => {
    const item = object(entry, ['id', 'kind', 'sourceRef', 'version', 'contentDigest', 'status', 'capabilities', 'transport'], `${field}.resources.entries[${index}]`);
    if (!['auth_plugin', 'skill', 'mcp', 'extension', 'tool'].includes(item.kind as string)) fail(`${field}.resources.entries[${index}].kind`, 'invalid_resource_kind');
    if (!['available', 'omitted'].includes(item.status as string)) fail(`${field}.resources.entries[${index}].status`, 'invalid_resource_status');
    if (!Array.isArray(item.capabilities) || item.capabilities.some((value) => typeof value !== 'string')) fail(`${field}.resources.entries[${index}].capabilities`, 'invalid_resource_capabilities');
    if (item.transport !== null && item.transport !== 'stdio' && item.transport !== 'streamable_http') fail(`${field}.resources.entries[${index}].transport`, 'invalid_resource_transport');
    if ((item.kind === 'mcp') !== (item.transport !== null)) fail(`${field}.resources.entries[${index}].transport`, 'resource_transport_mismatch');
    if (typeof item.version !== 'string' && item.version !== null) fail(`${field}.resources.entries[${index}].version`, 'invalid_resource_version');
    if (item.version === null && item.contentDigest === null) fail(`${field}.resources.entries[${index}]`, 'resource_identity_missing');
    return {
      id: validateStableId(item.id, context, `${field}.resources.entries[${index}].id`),
      kind: item.kind as RuntimeRecoveryAccessSnapshot['resources']['entries'][number]['kind'],
      sourceRef: validateStableId(item.sourceRef, context, `${field}.resources.entries[${index}].sourceRef`),
      version: item.version as string | null,
      contentDigest: item.contentDigest === null ? null : validateSha256Digest(item.contentDigest, context, `${field}.resources.entries[${index}].contentDigest`),
      status: item.status as 'available' | 'omitted',
      capabilities: [...item.capabilities] as string[],
      transport: item.transport as 'stdio' | 'streamable_http' | null,
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail(`${field}.resources.entries`, 'duplicate_resource');
  return { strategy, authentication, resources: {
    digest: validateSha256Digest(resourcesRaw.digest, context, `${field}.resources.digest`), entries,
  }};
}
function sourceState(value: unknown): RuntimeRecoverySourceState {
  const raw = object(value, ['evidence', 'stopped', 'stopEvidence'], 'sourceState');
  if (raw.stopped !== 'confirmed' || raw.stopEvidence === undefined) fail('sourceState.stopped', 'stop_unconfirmed');
  return { evidence: validateExecutionInputRef(raw.evidence, context.operation), stopped: 'confirmed',
    stopEvidence: validateExecutionInputRef(raw.stopEvidence, context.operation) };
}
function sourceEvidence(value: unknown): RuntimeRecoverySourceEvidence {
  const raw = object(value, ['schemaVersion', 'source', 'inputSnapshot', 'archive', 'checkpoint', 'codeDigest', 'permissionsDigest', 'workAccess'], 'sourceEvidence');
  if (raw.schemaVersion !== 1) fail('sourceEvidence.schemaVersion', 'unsupported_schema_version');
  const source = validateRuntimeRecoveryReference(raw.source);
  if ((source.kind === 'checkpoint') !== (raw.checkpoint !== undefined)) fail('sourceEvidence.checkpoint', 'checkpoint_kind_mismatch');
  return { schemaVersion: 1, source,
    inputSnapshot: validateExecutionInputRef(raw.inputSnapshot, context.operation),
    archive: validateExecutionInputRef(raw.archive, context.operation),
    ...(raw.checkpoint === undefined ? {} : { checkpoint: validateExecutionInputRef(raw.checkpoint, context.operation) }),
    codeDigest: validateSha256Digest(raw.codeDigest, context, 'sourceEvidence.codeDigest'),
    permissionsDigest: validateSha256Digest(raw.permissionsDigest, context, 'sourceEvidence.permissionsDigest'),
    ...(raw.workAccess === undefined ? {} : { workAccess: access(raw.workAccess, 'sourceEvidence.workAccess') }),
  };
}
export interface RuntimeRecoveryService {
  /** Internal preflight only: does not authorize/start a process or reserve/refund budgets. */
  evaluate(request: unknown): Promise<RuntimeRecoveryDecision>;
}
export interface RuntimeRecoveryServiceDeps {
  readonly configuration: RuntimeCapabilityCatalog;
  readonly capabilities?: RuntimeRecoveryCatalog;
  readonly sources?: RuntimeRecoverySourceReader;
  readonly artifacts: ArtifactStore;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
}

export function createRuntimeRecoveryService(deps: RuntimeRecoveryServiceDeps): RuntimeRecoveryService {
  async function read(projectId: string, ref: ExecutionInputRef): Promise<Uint8Array> {
    if (ref.projectId !== projectId) fail('ref.projectId', 'source_project_mismatch');
    const record = await deps.artifacts.getArtifact(projectId, ref.artifactId);
    if (record.projectId !== projectId || record.id !== ref.artifactId || record.status !== 'ready' ||
        record.kind !== ref.kind || record.mediaType !== ref.mediaType || record.version !== ref.version ||
        record.contentHash !== ref.contentHash || record.sizeBytes !== ref.sizeBytes || record.locator !== ref.locator) {
      fail('ref', 'artifact_identity_mismatch');
    }
    const verified = await deps.verifier.readVerifiedContent(projectId, ref.artifactId);
    if (verified.projectId !== projectId || verified.artifactId !== ref.artifactId ||
        verified.contentHash !== ref.contentHash || verified.sizeBytes !== ref.sizeBytes || verified.locator !== ref.locator) {
      fail('ref', 'artifact_content_mismatch');
    }
    return verified.content;
  }
  return {
    async evaluate(value) {
      const request = validateRuntimeRecoveryRequest(value);
      const descriptor = validateRuntimeRecoveryStrategy(request.strategy, deps.configuration, deps.capabilities);
      const selection = request.recovery;
      if (selection.mode === 'new' || selection.source === undefined) {
        return decideRuntimeRecovery(request, descriptor);
      }
      const reader = deps.sources;
      if (reader === undefined) fail('sources', 'source_reader_unavailable');
      // Keep the detached request private: injected readers receive copies, not the validation baseline.
      const readCurrent = () => currentContext(reader.readCurrent(validateRuntimeRecoveryRequest(request)));
      const readState = () => sourceState(reader.readSource(request.projectId, validateRuntimeRecoveryReference(selection.source)));
      const current = readCurrent();
      const state = readState();
      if (state.evidence.kind !== RUNTIME_RECOVERY_EVIDENCE_KIND || state.evidence.mediaType !== 'application/json') {
        fail('sourceState.evidence', 'invalid_evidence_artifact');
      }
      const bytes = await read(request.projectId, state.evidence);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('sourceEvidence', 'invalid_evidence_json'); }
      const evidence = sourceEvidence(parsed);
      if (stableStringify(evidence.source) !== stableStringify(selection.source)) fail('sourceEvidence.source', 'source_identity_mismatch');
      if (evidence.archive.artifactId !== selection.source.nativeArchiveRef ||
          evidence.archive.contentHash !== selection.source.sourceDigest ||
          (selection.source.kind === 'checkpoint' && evidence.checkpoint?.artifactId !== selection.source.checkpointRef)) {
        fail('sourceEvidence.archive', 'source_archive_mismatch');
      }
      if (evidence.inputSnapshot.purpose !== 'snapshot' || current.inputSnapshot.purpose !== 'snapshot') {
        fail('current.inputSnapshot', 'invalid_input_snapshot');
      }
      if (stableStringify(evidence.inputSnapshot) !== stableStringify(current.inputSnapshot)) {
        fail('current.inputSnapshot', 'input_identity_changed');
      }
      if (evidence.codeDigest !== current.codeDigest) fail('current.codeDigest', 'code_changed');
      if (evidence.permissionsDigest !== computeExecutionPermissionsDigest(current.permissions.grants)) {
        fail('current.permissions', 'permissions_changed');
      }
      if (selection.source.purpose === 'work') {
        if (current.workAccess === undefined || evidence.workAccess === undefined) {
          fail('current.workAccess', 'work_access_missing');
        }
        if (current.workAccess.authentication.status !== 'ready' ||
            current.workAccess.resources.entries.some((entry) => entry.status !== 'available')) {
          fail('current.workAccess', 'work_access_unavailable');
        }
        if (stableStringify(evidence.workAccess) !== stableStringify(current.workAccess)) {
          fail('current.workAccess', 'work_access_changed');
        }
        if (current.workAccess.strategy.runtime !== request.strategy.runtime ||
            current.workAccess.strategy.provider !== request.strategy.provider ||
            current.workAccess.strategy.model !== request.strategy.model) {
          fail('current.workAccess.strategy', 'work_access_changed');
        }
      }
      await read(request.projectId, evidence.inputSnapshot);
      await read(request.projectId, current.inputSnapshot);
      await read(request.projectId, evidence.archive);
      if (evidence.checkpoint !== undefined) await read(request.projectId, evidence.checkpoint);
      await read(request.projectId, state.stopEvidence!);
      if (stableStringify(current) !== stableStringify(readCurrent()) || stableStringify(state) !== stableStringify(readState())) {
        fail('sources', 'authority_changed_during_read');
      }
      return decideRuntimeRecovery(request, descriptor);
    },
  };
}
