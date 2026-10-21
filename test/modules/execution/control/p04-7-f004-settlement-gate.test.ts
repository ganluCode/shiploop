import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createExecutionStopControl } from '../../../../packages/core/src/application/execution-stop-control.ts';
import { createSqliteAttemptAccess } from '../../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import type { ExecutionCompletion } from '../../../../packages/core/src/application/execution-supervision.ts';
import type { WorkResourceIdentity } from '../../../../packages/core/src/ports/work-resources.ts';
import type { VerificationStopControl } from '../../../../packages/core/src/ports/verification-stop.ts';
import { fixture } from '../../../helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from '../../../helpers/p03-6/input-binding-fixture.ts';

function requestStop(f: Awaited<ReturnType<typeof fixture>>) {
  const run = f.query('SELECT revision FROM runs WHERE id = ?', f.runId) as { revision: number };
  return f.deps.atomic.transact('f004.request-stop', transaction => transaction.requestExecutionCancel({
    projectId: f.projectId,
    targetKind: 'run',
    targetId: f.runId,
    expectedRevision: run.revision,
    commandId: randomUUID(),
  }));
}

function completion(overrides: Partial<ExecutionCompletion> = {}): ExecutionCompletion {
  return {
    stopConfirmed: true,
    persisted: true,
    retained: false,
    error: null,
    recordingFlushed: true,
    exitCode: null,
    signal: null,
    forced: null,
    ...overrides,
  };
}

function noVerifierStop(): VerificationStopControl {
  return { begin: () => { throw new Error('begin not used'); }, stop: async () => [] };
}

function publishToStore(f: Awaited<ReturnType<typeof fixture>>) {
  return async (projectId: string, operationId: string, evidence: unknown): Promise<string> => {
    const content = Buffer.from(JSON.stringify(evidence));
    return (await f.publisher.publishArtifact({
      projectId,
      kind: 'execution_stop_evidence',
      mediaType: 'application/json',
      expectedHash: createHash('sha256').update(content).digest('hex'),
      locator: `stops/${operationId}.json`,
      content: [content],
    })).artifact.id;
  };
}

function controlFor(
  f: Awaited<ReturnType<typeof fixture>>,
  stopRuntime: (identity: WorkResourceIdentity) => Promise<ExecutionCompletion | null>,
  verifiers: VerificationStopControl = noVerifierStop(),
  publishEvidence: (projectId: string, operationId: string, evidence: unknown) => Promise<string> = publishToStore(f),
) {
  return createExecutionStopControl({
    atomic: f.deps.atomic,
    attempts: createSqliteAttemptAccess(f.session),
    resources: f.resources,
    stopRuntime,
    verifiers,
    publishEvidence,
    nowUtcMs: () => BINDING_NOW,
  });
}

describe('P04-7 / F-004 settlement gate', () => {
  it('keeps the operation uncertain when Runtime persistence is incomplete', async () => {
    const f = await fixture();
    try {
      const request = requestStop(f);
      const outcome = await controlFor(f, async () => completion({ persisted: false, recordingFlushed: false }))
        .stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      expect(outcome).toMatchObject({ stopConfirmed: false, operationStatus: 'uncertain' });
      expect(outcome!.evidence.gaps).toEqual(expect.arrayContaining(['runtime_settlement_incomplete', 'recording_flush_incomplete']));
      expect(f.deps.atomic.getExecutionStopOperation(f.projectId, request.stopOperationId!)).toMatchObject({ status: 'uncertain' });
      expect(f.resources.read(f.identity).leases.every(lease => lease.state === 'quarantined')).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('records Verifier failure as a gap and does not release the WorkResource', async () => {
    const f = await fixture();
    try {
      const request = requestStop(f);
      const verifiers: VerificationStopControl = { begin: () => { throw new Error('begin not used'); }, stop: vi.fn(async () => { throw new Error('verifier unavailable'); }) };
      const outcome = await controlFor(f, async () => completion(), verifiers)
        .stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      expect(outcome).toMatchObject({ stopConfirmed: false, operationStatus: 'uncertain' });
      expect(outcome!.evidence.gaps).toEqual(expect.arrayContaining(['verifier:Error', 'verifier_stop_failed']));
      expect(f.resources.read(f.identity).leases.every(lease => lease.state === 'quarantined')).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('does not turn a WorkResource identity read failure into an empty lease set', async () => {
    const f = await fixture();
    try {
      const request = requestStop(f);
      const resources = { ...f.resources, read: vi.fn(() => { throw new Error('identity mismatch'); }) };
      const control = createExecutionStopControl({
        atomic: f.deps.atomic,
        attempts: createSqliteAttemptAccess(f.session),
        resources,
        stopRuntime: async () => completion(),
        verifiers: noVerifierStop(),
        publishEvidence: publishToStore(f),
        nowUtcMs: () => BINDING_NOW,
      });
      const outcome = await control.stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      expect(outcome).toMatchObject({ stopConfirmed: false, operationStatus: 'uncertain' });
      expect(outcome!.evidence.gaps).toContain('work_resource_identity_unverified');
    } finally {
      await f.dispose();
    }
  });

  it('coalesces concurrent stop probes', async () => {
    const f = await fixture();
    try {
      const request = requestStop(f);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const stopRuntime = vi.fn(async () => { await gate; return completion(); });
      const publishEvidence = vi.fn(publishToStore(f));
      const control = controlFor(f, stopRuntime, undefined, publishEvidence);
      const first = control.stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      const second = control.stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toEqual(two);
      expect(stopRuntime).toHaveBeenCalledOnce();
      expect(publishEvidence).toHaveBeenCalledOnce();
    } finally {
      await f.dispose();
    }
  });

  it('leaves publication failures retryable instead of settling success', async () => {
    const f = await fixture();
    try {
      const request = requestStop(f);
      const publishEvidence = vi.fn()
        .mockRejectedValueOnce(new Error('public store unavailable'))
        .mockImplementation(publishToStore(f));
      const stopRuntime = vi.fn(async () => completion());
      const control = controlFor(f, stopRuntime, undefined, publishEvidence);
      await expect(control.stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! })).rejects.toThrow('public store unavailable');
      expect(f.deps.atomic.getExecutionStopOperation(f.projectId, request.stopOperationId!)).toMatchObject({ status: 'stopping' });
      const retry = await control.stop({ projectId: f.projectId, stopOperationId: request.stopOperationId! });
      expect(retry).toMatchObject({ stopConfirmed: true, operationStatus: 'stopped' });
      expect(stopRuntime).toHaveBeenCalledTimes(2);
      expect(publishEvidence).toHaveBeenCalledTimes(2);
    } finally {
      await f.dispose();
    }
  });
});
