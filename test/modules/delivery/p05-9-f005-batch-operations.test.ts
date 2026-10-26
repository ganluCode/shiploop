import { describe, expect, it, vi } from 'vitest';
import {
  createBatchOperationsService,
} from '../../../packages/core/src/application/batch-operations.ts';
import type { BatchLeafFinalizationService } from '../../../packages/core/src/application/batch-leaf-finalization.ts';

const receipt = (operation: string) => ({
  schemaVersion: 7,
  operation,
  commandId: `${operation}-command`,
  status: 'completed',
} as any);

function deliveryView() {
  return {
    schemaVersion: 1,
    scope: 'batch-delivery',
    batch: { id: 'batch-1', projectId: 'project-1', phaseId: 'phase-1', status: 'running', revision: 4, featureIds: ['feature-a', 'feature-b'], maxConcurrentFeatures: 1, concurrencySource: 'approved', deadlineAt: null, budget: { status: 'available', blockingReasons: [], runsCreated: 1, attemptsCreated: 0, runtimeStarts: 0, deadlineAt: null, tokenUsed: null, costUsed: null } },
    records: [
      { featureId: 'feature-a', featureStatus: 'failed', deliveryStatus: 'failed', status: 'failed', reason: 'verification_failed', failurePredecessors: [], blockingReasons: ['verification_failed'], delivery: {} as any, runs: [], integrations: [], stopOperations: [], budget: { status: 'available', blockingReasons: [], runsCreated: null, attemptsCreated: null, runtimeStarts: null, deadlineAt: null, tokenUsed: null, costUsed: null }, evidenceRefs: [] },
      { featureId: 'feature-b', featureStatus: 'pending', deliveryStatus: 'not_requested', status: 'blocked', reason: 'dependency_failed', failurePredecessors: ['feature-a'], blockingReasons: ['dependency_failed'], delivery: {} as any, runs: [], integrations: [], stopOperations: [], budget: { status: 'available', blockingReasons: [], runsCreated: null, attemptsCreated: null, runtimeStarts: null, deadlineAt: null, tokenUsed: null, costUsed: null }, evidenceRefs: [] },
    ],
    nextCursor: null,
    summary: { completed: 0, failed: 1, blocked: 1, cancelled: 0, awaiting_approval: 0, in_progress: 0, budget_exhausted: 0 },
    currentRunningCount: 0,
    readyCount: 0,
    resourceWaitingCount: 0,
    stopOperations: [],
    integrations: [],
    limit: 50,
  } as any;
}

function controlView() {
  return {
    schemaVersion: 1,
    scope: 'batch-control',
    batch: { batchId: 'batch-1', projectId: 'project-1', phaseId: 'phase-1', status: 'running', revision: 4 },
    runs: { records: [], truncated: false },
    attempts: { records: [], truncated: false },
    stopOperations: [],
    leases: [],
    nextActions: ['none'],
  } as any;
}

describe('P05-9 F-005 Batch operations facade', () => {
  it('[case:batch-operations-route-and-observe] routes commands through the existing command service and combines bounded observations', async () => {
    const submit = vi.fn(async (_principal: unknown, envelope: any) => receipt(envelope.operation));
    const getBatchDelivery = vi.fn(async () => deliveryView());
    const getBatchControl = vi.fn(async () => controlView());
    const service = createBatchOperationsService({
      commands: { submit },
      queries: { getBatchDelivery, getBatchControl },
    });
    const principal = { principalId: 'owner-1' };
    const command = (operation: string) => ({ operation, scope: { kind: 'project', projectId: 'project-1' } });

    await service.preview(principal, command('execution.preview'));
    await service.start(principal, command('execution.start'));
    await service.pause(principal, command('execution.pause'));
    await service.resume(principal, command('execution.resume'));
    await service.cancel(principal, command('execution.cancel'));
    const observed = await service.observe(principal, { projectId: 'project-1', batchId: 'batch-1', limit: 25 });

    expect(submit.mock.calls.map((call) => call[1].operation)).toEqual([
      'execution.preview', 'execution.start', 'execution.pause', 'execution.resume', 'execution.cancel',
    ]);
    expect(getBatchDelivery).toHaveBeenCalledWith(principal, { projectId: 'project-1', batchId: 'batch-1', limit: 25 });
    expect(getBatchControl).toHaveBeenCalledWith(principal, { projectId: 'project-1', batchId: 'batch-1' });
    expect(observed.blockingChain).toEqual([
      { featureId: 'feature-a', failurePredecessors: [], blockingReasons: ['verification_failed'] },
      { featureId: 'feature-b', failurePredecessors: ['feature-a'], blockingReasons: ['dependency_failed'] },
    ]);
    expect(observed.control.nextActions).toEqual(['none']);
  });

  it('[case:batch-operations-rejects-wrong-operation-and-preserves-command-failure] checks the operation before delegation and preserves a durable command error', async () => {
    const submit = vi.fn(async () => { throw new Error('persisted command failure'); });
    const service = createBatchOperationsService({ commands: { submit }, queries: { getBatchDelivery: vi.fn(), getBatchControl: vi.fn() } });

    await expect(service.start({}, { operation: 'execution.pause' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: expect.objectContaining({ field: 'operation', reason: 'unexpected_operation' }),
    });
    await expect(service.start({}, { operation: 'execution.start' })).rejects.toThrow('persisted command failure');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('[case:batch-operations-finalization-is-authorized] requires explicit finalization authorization and delegates the existing finalization service', async () => {
    const run = vi.fn(async (input: any) => ({ status: 'ready_for_phase_approval', blockReasons: [], candidate: { commandId: input.commandId } }));
    const authorize = vi.fn(async () => undefined);
    const finalization = { run } as unknown as BatchLeafFinalizationService;
    const service = createBatchOperationsService({
      commands: { submit: vi.fn() },
      queries: { getBatchDelivery: vi.fn(), getBatchControl: vi.fn() },
      finalization,
      authorizeFinalization: authorize,
    });
    const request = { projectId: 'project-1', batchId: 'batch-1', commandId: 'finalize-1' };

    await expect(service.finalize({ principalId: 'owner-1' }, request)).resolves.toMatchObject({ status: 'ready_for_phase_approval' });
    expect(authorize).toHaveBeenCalledWith({ principalId: 'owner-1' }, request);
    expect(run).toHaveBeenCalledWith(request);
  });
});
