import { describe, expect, it, vi } from 'vitest';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { validateRuntimeExecutionRequest, type RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createPiRuntimeAdapter, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';

const digest = 'a'.repeat(64);
const uuid = '11111111-1111-4111-8111-111111111111';
const ref = (purpose: string) => ({ projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
  version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`, mediaType: 'text/plain', origin: { kind: 'artifact' as const } });

const access = {
  schemaVersion: 1,
  projectId: 'project-1', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', invocationId: 'invocation-1', executionVersion: 1,
  owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
  strategy: { runtime: 'pi', provider: 'provider', model: 'model' }, permissions: { grants: [], isolation: 'trusted_project' },
  grantId: uuid,
  policyDigest: digest,
  authentication: { status: 'ready', digest, sourceRef: uuid, kind: 'environment' },
  resources: { digest, entries: [{ id: uuid, kind: 'tool', sourceRef: uuid, version: '1.0.0', contentDigest: digest,
    status: 'available', capabilities: ['tool_interception'], transport: null }] },
};

function request(overrides: Record<string, unknown> = {}): RuntimeExecutionRequest {
  return {
    schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1', executionVersion: 1,
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' }, invocationId: 'invocation-1',
    strategy: { runtime: 'pi', provider: 'provider', model: 'model' }, prompt: ref('prompt'), inputManifest: ref('manifest'),
    cwd: { root: 'workspace', relativePath: '.' }, permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 1000, maxEvents: 10, maxOutputBytes: 1000 }, recovery: { mode: 'new' },
    workAccess: access, ...overrides,
  } as RuntimeExecutionRequest;
}

function assembly(): PiTrustedAssembly {
  return {
    agentDir: '/trusted', resolveWorkingDirectory: () => '/trusted', inputReader: { read: async () => 'prompt' },
    credentialRef: { kind: 'trusted-resolution', id: 'credential-1' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
    prepareAccess: async () => ({ snapshot: access, credentialRef: { kind: 'trusted-resolution', id: 'credential-1' },
      resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']> }),
  } as PiTrustedAssembly;
}

it('[case:f004-runtime-request-access-snapshot] validates and preserves the Attempt-bound access snapshot', () => {
  const validated = validateRuntimeExecutionRequest(request());
  expect(validated.workAccess).toEqual(access);
  expect(() => validateRuntimeExecutionRequest(request({ workAccess: { ...access, grantId: uuid.replaceAll('1', '2') } })))
    .not.toThrow();
});

it('[case:f004-pi-access-drift] rejects actual authentication/resource assembly drift before SDK startup', async () => {
  const sessionFactory = vi.fn(async () => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} }));
  const registration = createPiRuntimeAdapter({ providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [],
    isolationModes: ['trusted_project'], assembly: { ...assembly(), prepareAccess: async () => ({ ...await assembly().prepareAccess!(request()),
      snapshot: { ...access, resources: { ...access.resources, digest: 'b'.repeat(64) } },
    }) } as PiTrustedAssembly, sessionFactory });
  await expect(registration.adapter.start(request())).rejects.toMatchObject({ kind: 'authentication', reason: 'work_access_snapshot_mismatch' });
  expect(sessionFactory).not.toHaveBeenCalled();
});

it('[case:f004-pi-authentication-not-ready] rejects an expired preflight without creating a session', async () => {
  const sessionFactory = vi.fn(async () => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} }));
  const registration = createPiRuntimeAdapter({ providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [],
    isolationModes: ['trusted_project'], assembly: { ...assembly(), prepareAccess: async () => ({ ...await assembly().prepareAccess!(request()),
      snapshot: { ...access, authentication: { ...access.authentication, status: 'expired' } },
    }) } as PiTrustedAssembly, sessionFactory });
  await expect(registration.adapter.start(request())).rejects.toMatchObject({ kind: 'authentication', reason: 'work_authentication_not_ready' });
  expect(sessionFactory).not.toHaveBeenCalled();
});

it('[case:f004-pi-resource-unauthorized] refuses an omitted approved resource before SDK startup', async () => {
  const sessionFactory = vi.fn(async () => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} }));
  const unavailable = { ...access, resources: { ...access.resources, entries: [{ ...access.resources.entries[0]!, status: 'omitted' as const }] } };
  const registration = createPiRuntimeAdapter({ providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [],
    isolationModes: ['trusted_project'], assembly: { ...assembly(), prepareAccess: async () => ({ ...await assembly().prepareAccess!(request()), snapshot: unavailable }) } as PiTrustedAssembly, sessionFactory });
  await expect(registration.adapter.start(request({ workAccess: unavailable }))).rejects.toMatchObject({ kind: 'permission', reason: 'resource_not_authorized' });
  expect(sessionFactory).not.toHaveBeenCalled();
});
it('[case:f004-runtime-access-strict-boundary] rejects unapproved access fields and invalid resource transport', () => {
  expect(() => validateRuntimeExecutionRequest(request({ workAccess: { ...access, unapproved: true } }))).toThrow();
  expect(() => validateRuntimeExecutionRequest(request({ workAccess: { ...access, resources: {
    ...access.resources, entries: [{ ...access.resources.entries[0], transport: 'stdio' }],
  } } }))).toThrow();
});
