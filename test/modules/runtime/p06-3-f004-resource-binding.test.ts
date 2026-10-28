import { describe, expect, it } from 'vitest';
import {
  PROJECT_RESOURCE_SCHEMA_VERSION,
  assembleProjectResourceLoadManifest,
  buildRuntimeWorkAccessSnapshot,
  deriveProjectResourceIdentity,
  validateProjectResourceSelection,
} from '../../../packages/core/src/ports/project-resources.ts';
import { createPiRuntimeAdapter, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const GRANT = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

function resource(overrides: Record<string, unknown> = {}) {
  const value = {
    projectId: PROJECT, sourceProjectId: PROJECT, kind: 'skill', name: 'approved-skill',
    sourceRef: SOURCE, sourceRevision: 'rev-1', version: '1.0.0', contentDigest: DIGEST,
    transport: null, capabilities: ['resource_selection'], credentialRef: null,
    required: true, onUnavailable: 'reject', ...overrides,
  };
  return { ...value, id: deriveProjectResourceIdentity(value) };
}

function selection() {
  return validateProjectResourceSelection({
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION, projectId: PROJECT, revision: 7,
    resources: [resource()], operations: ['task.read'], allowGlobalScan: false,
    allowProjectDirectoryScan: false, allowSdkDefaultScan: false,
  });
}

function request(workAccess: unknown): RuntimeExecutionRequest {
  const ref = (purpose: string) => ({ projectId: PROJECT, artifactId: `artifact-${purpose}`,
    kind: 'execution-input', purpose, version: 1, contentHash: DIGEST, sizeBytes: 1,
    locator: `inputs/${purpose}`, mediaType: 'text/plain', origin: { kind: 'artifact' as const } });
  return {
    schemaVersion: 1, projectId: PROJECT, featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 1, owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
    prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 1000, maxEvents: 10, maxOutputBytes: 1000 }, recovery: { mode: 'new' },
    workAccess,
  } as RuntimeExecutionRequest;
}

describe('P06-3 F-004 project resource Attempt binding', () => {
  it('[case:attempt-snapshot] fixes revision and load identities in the redacted runtime snapshot', () => {
    const approved = selection();
    const loaded = assembleProjectResourceLoadManifest(approved, [{
      ...resource(), status: 'available', unavailableReason: null, loadedCapabilities: ['resource_selection'],
    }]);
    const snapshot = buildRuntimeWorkAccessSnapshot({
      selection: approved, loadManifest: loaded,
      projectId: PROJECT, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1',
      invocationId: 'invocation-1', executionVersion: 1,
      owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
      strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
      permissions: { grants: [], isolation: 'trusted_project' }, grantId: GRANT,
      policyDigest: DIGEST,
      authentication: { status: 'ready', digest: DIGEST, sourceRef: SOURCE, kind: 'environment' },
    });
    expect(snapshot.resources).toMatchObject({ selectionRevision: 7, selectionDigest: approved.digest, loadManifestDigest: loaded.digest });
    expect(snapshot.resources.entries[0]).toMatchObject({ id: approved.resources[0]!.id, name: 'approved-skill', sourceRevision: 'rev-1', status: 'available' });
    expect(JSON.stringify(snapshot)).not.toContain('credentialRef');
  });

  it('[case:manifest-drift] rejects a changed manifest before it can become an Attempt snapshot', () => {
    const approved = selection();
    const loaded = assembleProjectResourceLoadManifest(approved, [{
      ...resource(), status: 'available', unavailableReason: null, loadedCapabilities: ['resource_selection'],
    }]);
    expect(() => buildRuntimeWorkAccessSnapshot({
      selection: approved, loadManifest: { ...loaded, selectionRevision: 8 }, projectId: PROJECT,
      runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', invocationId: 'invocation-1', executionVersion: 1,
      owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
      strategy: { runtime: 'pi', provider: 'provider', model: 'model' }, permissions: { grants: [], isolation: 'trusted_project' },
      grantId: GRANT, policyDigest: DIGEST,
      authentication: { status: 'ready', digest: DIGEST, sourceRef: SOURCE, kind: 'environment' },
    })).toThrow();
  });

  it('[case:actual-load-fence] refuses Pi startup when the trusted assembly reports a different load manifest', async () => {
    const approved = selection();
    const loaded = assembleProjectResourceLoadManifest(approved, [{
      ...resource(), status: 'available', unavailableReason: null, loadedCapabilities: ['resource_selection'],
    }]);
    const snapshot = buildRuntimeWorkAccessSnapshot({
      selection: approved, loadManifest: loaded, projectId: PROJECT, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1',
      invocationId: 'invocation-1', executionVersion: 1, owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
      strategy: { runtime: 'pi', provider: 'provider', model: 'model' }, permissions: { grants: [], isolation: 'trusted_project' },
      grantId: GRANT, policyDigest: DIGEST,
      authentication: { status: 'ready', digest: DIGEST, sourceRef: SOURCE, kind: 'environment' },
    });
    const assembly: PiTrustedAssembly = {
      agentDir: '/trusted', resolveWorkingDirectory: () => '/trusted', inputReader: { read: async () => 'input' },
      credentialRef: { kind: 'trusted-resolution', id: 'credential' },
      resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
      prepareAccess: async () => ({ snapshot, resourceManifest: { ...loaded, digest: 'b'.repeat(64) },
        resourceLoadPolicy: { selectedResourceIds: [approved.resources[0]!.id], allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false },
        credentialRef: { kind: 'trusted-resolution', id: 'credential' },
        resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']> }),
    };
    const sessionFactory = async () => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} });
    const adapter = createPiRuntimeAdapter({ providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [],
      isolationModes: ['trusted_project'], assembly, sessionFactory });
    await expect(adapter.adapter.start(request(snapshot))).rejects.toMatchObject({ reason: 'work_resource_manifest_mismatch' });
  });
});
