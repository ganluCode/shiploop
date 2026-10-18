import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openCoreApplication } from '../../../../packages/core/src/adapters/composition.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import type { CoreApplication } from '../../../../packages/core/src/adapters/composition.ts';
import type { RuntimeRecoveryCapabilities } from '../../../../packages/core/src/ports/runtime-recovery.ts';

import type { ExecutionInputRef, RuntimeRecoverySourceReader, RuntimeRecoveryCurrentContext, RuntimeRecoverySourceState, RuntimeRecoverySourceEvidence } from '../../../../packages/core/src/index.ts';
import {
  createStaticRuntimeCapabilityCatalog, createStaticRuntimeRecoveryCatalog,
  validateRuntimeRecoveryStrategy, createArtifactPublisher, createArtifactVerifier, computeExecutionPermissionsDigest,
} from '../../../../packages/core/src/index.ts';

export function recoveryDescriptor(): RuntimeRecoveryCapabilities {
  return {
    schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0', sdkVersion: null,
    nativeFormats: [{ format: 'synthetic-json', versions: ['1'] }], limits: [],
    capabilities: {
      nativeHistory: { status: 'verified', evidenceRef: 'evidence-1', limits: [] },
      conversationResume: { status: 'verified', evidenceRef: 'evidence-1', limits: [] },
      executionRecovery: { status: 'verified', evidenceRef: 'evidence-1', limits: [] },
      modelSwitchOnResume: { status: 'verified', evidenceRef: 'evidence-1', limits: [] },
      nativeFork: { status: 'verified', evidenceRef: 'evidence-1', limits: [] },
    },  };
}
const configuration = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'provider', models: ['model'] }] },
]);

describe('F-002 independent recovery capability assembly', () => {
  it('rejects duplicate and unknown runtimes without changing the configuration catalog', () => {
    const config = configuration();
    expect(() => createStaticRuntimeRecoveryCatalog([recoveryDescriptor(), recoveryDescriptor()], config))
      .toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'duplicate_runtime_id' }) }));
    expect(() => createStaticRuntimeRecoveryCatalog([{ ...recoveryDescriptor(), runtimeId: 'pi-durable' }], config))
      .toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'unknown_runtime' }) }));
    expect(config.resolve('pi-durable')).toBeUndefined();
  });
  it('reuses configuration compatibility and separately checks the recovery descriptor', () => {
    const config = configuration();
    const recovery = createStaticRuntimeRecoveryCatalog([recoveryDescriptor()], config);
    const strategy = { runtime: 'fake', provider: 'provider', model: 'model' };
    expect(validateRuntimeRecoveryStrategy(strategy, config, recovery)?.runtimeId).toBe('fake');
    for (const change of [{ runtime: 'unknown' }, { provider: 'unknown' }, { model: 'unknown' }]) {
      expect(() => validateRuntimeRecoveryStrategy({ ...strategy, ...change }, config, recovery)).toThrow();
    }
    expect(() => validateRuntimeRecoveryStrategy(strategy, config, {
      resolve: () => ({ ...recoveryDescriptor(), runtimeId: 'other' }),
    })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'descriptor_runtime_mismatch' }) }));
    expect(validateRuntimeRecoveryStrategy(strategy, config, undefined)).toBeUndefined();
  });
  it('keeps trusted capability evidence detached from callers', () => {
    const descriptor = recoveryDescriptor();
    const catalog = createStaticRuntimeRecoveryCatalog([descriptor], configuration());
    (descriptor.capabilities.nativeFork as { status: string }).status = 'unsupported';
    const first = catalog.resolve('fake')!;
    (first.nativeFormats[0].versions as string[]).push('99');
    expect(catalog.resolve('fake')!.nativeFormats[0].versions).toEqual(['1']);
    expect(catalog.resolve('fake')!.capabilities.nativeFork.status).toBe('verified');
  });
});

async function sourceHarness() {
  const sandbox = createTempSandbox('shiploop-f002-source-');
  let current: RuntimeRecoveryCurrentContext | undefined;
  let state: RuntimeRecoverySourceState | undefined;
  const reader: RuntimeRecoverySourceReader = {
    readCurrent: vi.fn(() => current), readSource: vi.fn(() => state),
  };
  const app = await openCoreApplication({ dataRoot: join(sandbox.path, 'data'),
    capabilityCatalog: configuration(), runtimeRecoveryDescriptors: [recoveryDescriptor()],
    runtimeRecoverySources: reader });
  try {
    const project = await app.stateStore.createProject({ displayName: 'recovery-test' });
    const publisher = createArtifactPublisher({ artifacts: app.artifactStore, files: app.artifactFileStore,
      limits: { maxSizeBytes: 1_000_000, timeoutMs: 10_000 } });
    const publish = async (kind: string, body: string, projectId = project.id): Promise<ExecutionInputRef> => {
      const result = await publisher.publishArtifact({ projectId, kind, mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `recovery/${kind}`,
        content: [Buffer.from(body)] });
      const record = await app.artifactStore.getArtifact(projectId, result.artifact.id);
      return { projectId, artifactId: record.id, kind, purpose: kind, contentHash: record.contentHash!,
        sizeBytes: record.sizeBytes!, locator: record.locator, mediaType: record.mediaType,
        version: record.version, origin: { kind: 'artifact' } };
    };
    const archive = await publish('native-archive', '{"native":"synthetic"}');
    const snapshot = { ...(await publish('execution-snapshot', '{"input":"immutable"}')), purpose: 'snapshot' };
    const stop = await publish('stop-evidence', '{"supervisor":"synthetic-stop"}');
    const source = { schemaVersion: 1 as const, purpose: 'work' as const, kind: 'conversation' as const,
      sourceProjectId: project.id, sourceSessionId: 'session-old', sourceTaskId: 'task-1',
      sourceAttemptId: 'attempt-old', runtime: 'fake', provider: 'provider', model: 'model',
      providerSessionId: 'native-1', nativeArchiveRef: archive.artifactId, nativeFormat: 'synthetic-json',
      nativeFormatVersion: '1', sourceDigest: archive.contentHash };
    const request = { schemaVersion: 1, projectId: project.id, sessionId: 'session-new', executionVersion: 2,
      invocationId: 'invocation-new', identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
      strategy: { runtime: 'fake', provider: 'provider', model: 'model' },
      recovery: { mode: 'required', kind: 'conversation', source: structuredClone(source) } };
    const evidence = { schemaVersion: 1 as const, source, archive,
      inputSnapshot: snapshot, codeDigest: 'b'.repeat(64), permissionsDigest: computeExecutionPermissionsDigest(['read']) } satisfies RuntimeRecoverySourceEvidence;
    current = { inputSnapshot: snapshot, codeDigest: evidence.codeDigest, permissions: { grants: ['read'] } };
    state = { evidence: await publish('runtime-recovery-evidence', JSON.stringify(evidence)),
      stopped: 'confirmed', stopEvidence: stop };
    return { app, sandbox, reader, request, evidence, archive, snapshot, publish,
      get current() { return current; }, set current(value) { current = value; },
      get state() { return state; }, set state(value) { state = value; },
      async saveEvidence() { state = { ...state!, evidence: await publish('runtime-recovery-evidence', JSON.stringify(evidence)) }; },
      close() { app.close(); sandbox.cleanup(); } };
  } catch (error) { app.close(); sandbox.cleanup(); throw error; }
}

describe('F-002 trusted immutable recovery source gates', () => {
  it('resolves verified same-project source without altering artifacts or installing an executor', async () => {
    const h = await sourceHarness();
    try {
      const before = await h.app.artifactStore.listArtifacts(h.request.projectId);
      expect(await h.app.runtimeRecovery.evaluate(h.request)).toMatchObject({ mode: 'resume', kind: 'conversation' });
      expect(await h.app.runtimeRecovery.evaluate(h.request)).toMatchObject({ mode: 'resume' });
      expect(await h.app.artifactStore.listArtifacts(h.request.projectId)).toEqual(before);
      expect(h.request.identity.attemptId).toBe('attempt-new');
      expect(h.request.invocationId).toBe('invocation-new');
    } finally { h.close(); }
  });
  it.each(['source', 'current', 'active', 'unknown', 'stop-evidence', 'permissions', 'code', 'input'])
    ('rejects unavailable or changed %s even for auto', async failure => {
      const h = await sourceHarness();
      try {
        h.request.recovery.mode = 'auto';
        if (failure === 'source') h.state = undefined;
        if (failure === 'current') h.current = undefined;
        if (failure === 'active' || failure === 'unknown') h.state = { ...h.state!, stopped: failure };
        if (failure === 'stop-evidence') h.state = { evidence: h.state!.evidence, stopped: 'confirmed' };
        if (failure === 'permissions') h.current = { ...h.current!, permissions: { grants: ['write'] } };
        if (failure === 'code') h.current = { ...h.current!, codeDigest: 'c'.repeat(64) };
        if (failure === 'input') h.current = { ...h.current!, inputSnapshot: { ...(await h.publish('execution-snapshot', '{"input":"changed"}')), purpose: 'snapshot' } };
        await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
      } finally { h.close(); }
    });
  it.each(['project', 'purpose', 'runtime', 'format', 'session', 'attempt', 'archive', 'digest', 'path', 'schema'])
    ('rejects stored source %s contradictions', async failure => {
      const h = await sourceHarness();
      try {
        const source = h.evidence.source as unknown as Record<string, unknown>;
        const changes: Record<string, [string, unknown]> = {
          project: ['sourceProjectId', 'another'], purpose: ['purpose', 'chat'], runtime: ['runtime', 'other'],
          format: ['nativeFormatVersion', '99'], session: ['providerSessionId', 'changed'], attempt: ['sourceAttemptId', 'different'],
          archive: ['nativeArchiveRef', 'missing-artifact'], digest: ['sourceDigest', 'c'.repeat(64)],
          path: ['nativeArchiveRef', '/tmp/native.db'], schema: ['schemaVersion', 2],
        };
        const [field, value] = changes[failure]; source[field] = value;
        await h.saveEvidence();
        await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
      } finally { h.close(); }
    });
  it.each(['missing', 'modified'])('rejects %s physical archive bytes', async failure => {
    const h = await sourceHarness();
    try {
      const verified = await createArtifactVerifier({ artifacts: h.app.artifactStore, files: h.app.artifactFileStore,
        limits: { maxReadBytes: 1_000_000 } }).readVerifiedContent(h.request.projectId, h.archive.artifactId);
      const path = join(h.app.dataRoot, verified.relativePath);
      expect(existsSync(path)).toBe(true);
      if (failure === 'missing') rmSync(path); else writeFileSync(path, '{"native":"tampered!"}');
      await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
    } finally { h.close(); }
  });
  it('rejects cross-project artifact refs and pending artifacts', async () => {
    const h = await sourceHarness();
    try {
      const other = await h.app.stateStore.createProject({ displayName: 'other' });
      h.evidence.archive = await h.publish('native-archive', '{}', other.id);
      await h.saveEvidence();
      await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
      const pending = await h.app.artifactStore.registerArtifact({ projectId: h.request.projectId, kind: 'native-archive',
        mediaType: 'application/json', expectedHash: h.archive.contentHash, locator: 'native/pending' });
      h.evidence.archive = { ...h.archive, artifactId: pending.id, locator: pending.locator };
      await h.saveEvidence();
      await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
    } finally { h.close(); }
  });
  it('rechecks current authority after asynchronous Artifact reads', async () => {
    const h = await sourceHarness();
    try {
      const read = h.app.artifactFileStore.openFinalRead.bind(h.app.artifactFileStore);
      vi.spyOn(h.app.artifactFileStore, 'openFinalRead').mockImplementation(async input => {
        const value = await read(input);
        h.current = { ...h.current!, permissions: { grants: ['changed'] } };
        return value;
      });
      await expect(h.app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
    } finally { h.close(); }
  });
});

it('F-002 optional composition is fail-closed and invalid injection causes no I/O', async () => {
  const sandbox = createTempSandbox('shiploop-f002-assembly-');
  let app: CoreApplication | undefined;
  try {
    for (const option of [{ runtimeRecoveryDescriptors: [recoveryDescriptor(), recoveryDescriptor()] },
      { runtimeRecoveryDescriptors: [{ ...recoveryDescriptor(), runtimeId: 'pi-durable' }] },
      { runtimeRecoverySources: {} }]) {
      const dataRoot = join(sandbox.path, 'invalid');
      await expect(openCoreApplication({ dataRoot, capabilityCatalog: configuration(), ...option })).rejects.toThrow();
      expect(existsSync(dataRoot)).toBe(false);
    }
    app = await openCoreApplication({ dataRoot: join(sandbox.path, 'valid'), capabilityCatalog: configuration() });
    const h = await sourceHarness();
    try {
      await expect(app.runtimeRecovery.evaluate(h.request)).rejects.toThrow();
      expect(await app.runtimeRecovery.evaluate({ ...h.request, recovery: { mode: 'new' } })).toEqual({ mode: 'new', reasons: ['explicit_new'] });
    } finally { h.close(); }
  } finally { app?.close(); sandbox.cleanup(); }
});
