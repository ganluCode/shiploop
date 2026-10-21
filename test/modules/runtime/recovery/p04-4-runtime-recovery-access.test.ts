import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRuntimeRecoveryService } from '../../../../packages/core/src/application/runtime-recovery.ts';
import { computeExecutionPermissionsDigest } from '../../../../packages/core/src/ports/execution-input-prepare.ts';

const digest = 'a'.repeat(64);
const projectId = 'project-1';
const source = {
  schemaVersion: 1, purpose: 'work', kind: 'conversation', sourceProjectId: projectId,
  sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
  runtime: 'pi', provider: 'provider', model: 'model', providerSessionId: 'native:session/1',
  nativeArchiveRef: 'artifact-native', nativeFormat: 'synthetic-json', nativeFormatVersion: '1.0', sourceDigest: digest,
};
const request = {
  schemaVersion: 1, projectId, sessionId: 'session-new', executionVersion: 2, invocationId: 'invocation-1',
  identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
  strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
  recovery: { mode: 'required', kind: 'conversation', source },
};

function ref(artifactId: string, purpose: string, content: Uint8Array, kind = 'execution-input') {
  const contentHash = createHash('sha256').update(content).digest('hex');
  return {
    projectId, artifactId, kind, purpose, version: 1, contentHash, sizeBytes: content.byteLength,
    locator: `inputs/${artifactId}`, mediaType: 'application/json', origin: { kind: 'artifact' },
  };
}
function artifact(input: ReturnType<typeof ref>) {
  return {
    id: input.artifactId, projectId, kind: input.kind, mediaType: input.mediaType, status: 'ready' as const,
    expectedHash: input.contentHash, contentHash: input.contentHash, sizeBytes: input.sizeBytes,
    locator: input.locator, version: input.version, failureReason: null, revision: 1,
    createdAtUtcMs: 1, updatedAtUtcMs: 1,
  };
}
function fixture() {
  const contents = new Map<string, Uint8Array>();
  const put = (id: string, purpose: string, value: unknown, kind = 'execution-input') => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const input = ref(id, purpose, bytes, kind);
    contents.set(id, bytes);
    return input;
  };
  const snapshot = put('artifact-snapshot', 'snapshot', { snapshot: true });
  const archiveBytes = new TextEncoder().encode('{"native":"history"}');
  const archive = ref('artifact-native', 'recovery-archive', archiveBytes, 'recovery-archive');
  source.sourceDigest = archive.contentHash;
  contents.set(archive.artifactId, archiveBytes);
  const stop = put('artifact-stop', 'recovery-stop', { stopped: true }, 'recovery-stop');
  const evidenceBody = {
    schemaVersion: 1, source, inputSnapshot: snapshot, archive,
    codeDigest: digest, permissionsDigest: computeExecutionPermissionsDigest(['repo.read']),
    workAccess: {
      strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
      authentication: { status: 'ready', digest, sourceRef: 'credential-1', kind: 'environment' },
      resources: { digest, entries: [{ id: 'tool-1', kind: 'tool', sourceRef: 'tool-source', version: '1', contentDigest: null, status: 'available', capabilities: ['read'], transport: null }] },
    },
  };
  const evidenceBytes = new TextEncoder().encode(JSON.stringify(evidenceBody));
  const evidence = ref('artifact-evidence', 'runtime-recovery-evidence', evidenceBytes, 'runtime-recovery-evidence');
  contents.set(evidence.artifactId, evidenceBytes);
  const current = {
    inputSnapshot: snapshot, codeDigest: digest, permissions: { grants: ['repo.read'] },
    workAccess: evidenceBody.workAccess,
  };
  const records = new Map([snapshot, archive, stop, evidence].map((item) => [item.artifactId, artifact(item)]));
  const service = createRuntimeRecoveryService({
    configuration: {
      resolve: (runtimeId: string) => runtimeId === 'pi' ? ({ runtimeId, providers: [{ providerId: 'provider' }] }) : undefined,
    } as any,
    capabilities: {
      resolve: (runtimeId: string) => runtimeId === 'pi' ? ({
        schemaVersion: 1, runtimeId: 'pi', adapterVersion: '1.0.0', sdkVersion: null,
        nativeFormats: [{ format: 'synthetic-json', versions: ['1.0'] }], limits: [],
        capabilities: Object.fromEntries(['nativeHistory', 'conversationResume', 'executionRecovery', 'modelSwitchOnResume', 'nativeFork'].map((name) => [name, { status: 'verified', limits: [], evidenceRef: 'capability-evidence' }])),
      }) : undefined,
    } as any,
    sources: {
      readCurrent: () => current,
      readSource: () => ({ evidence, stopped: 'confirmed', stopEvidence: stop }),
    },
    artifacts: { getArtifact: async (_project: string, id: string) => records.get(id)! } as any,
    verifier: { readVerifiedContent: async (_project: string, id: string) => ({ ...records.get(id)!, artifactId: id, content: contents.get(id)! }) } as any,
  });
  return { service, current };
}

describe('F-004 runtime recovery access revalidation', () => {
  it('accepts an unchanged ready access snapshot and continues recovery', async () => {
    const { service } = fixture();
    await expect(service.evaluate(request)).resolves.toEqual({ mode: 'resume', kind: 'conversation', reasons: [] });
  });
  it.each([
    ['missing', (current: any) => { delete current.workAccess; }, 'work_access_missing'],
    ['authentication unavailable', (current: any) => { current.workAccess.authentication.status = 'expired'; }, 'work_access_unavailable'],
    ['resource unavailable', (current: any) => { current.workAccess.resources.entries[0].status = 'omitted'; }, 'work_access_unavailable'],
  ])('rejects %s access state', async (_label, mutate, reason) => {
    const { service, current } = fixture();
    mutate(current);
    await expect(service.evaluate(request)).rejects.toMatchObject({
      kind: 'validation', details: expect.objectContaining({ reason }),
    });
  });
  it.each([
    ['authentication', (access: any) => { access.authentication.digest = 'b'.repeat(64); }],
    ['resources', (access: any) => { access.resources.digest = 'b'.repeat(64); }],
    ['provider', (access: any) => { access.strategy.provider = 'provider-new'; }],
    ['model', (access: any) => { access.strategy.model = 'model-new'; }],
  ])('rejects %s drift between source and current access', async (_label, mutate) => {
    const { service, current } = fixture();
    mutate(current.workAccess);
    await expect(service.evaluate(request)).rejects.toMatchObject({
      kind: 'validation',
      details: expect.objectContaining({ reason: 'work_access_changed' }),
    });
  });
});
