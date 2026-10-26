import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppCliParseError, parseAppCliArgs, getAppCliHelp } from '../../../packages/cli/src/index.ts';
import {
  buildBatchDeliveryView,
  buildBatchObservationView,
  formatBatchDeliveryView,
  formatBatchObservationView,
} from '../../../packages/cli/src/app/delivery.ts';

const projectId = randomUUID();
const batchId = randomUUID();
const phaseId = 'phase-1';
const candidateId = 'candidate-1';

function rejects(args: string[], reason: string) {
  expect(() => parseAppCliArgs(args)).toThrowError(AppCliParseError);
  try {
    parseAppCliArgs(args);
  } catch (error) {
    expect(error).toMatchObject({ reason });
  }
}

describe('P05-9 Batch delivery CLI arguments', () => {
  it('[case:batch-delivery-commands] maps read and write entry points to stable command identities', () => {
    expect(parseAppCliArgs(['execution', 'batch-delivery', batchId, '--project', projectId, '--limit', '10']))
      .toMatchObject({ commandId: 'execution.batch-delivery', projectId, batchId, limit: 10 });
    expect(parseAppCliArgs(['execution', 'batch-observe', batchId, '--project', projectId, '--json']))
      .toMatchObject({ commandId: 'execution.batch-observe', projectId, batchId, json: true });
    expect(parseAppCliArgs(['execution', 'finalize', batchId, '--project', projectId, '--phase', phaseId, '--revision', '3', '--confirm']))
      .toMatchObject({ commandId: 'execution.finalize', operation: 'execution.batch.finalize', projectId, phaseId, batchId, revision: 3, confirm: true });
    expect(parseAppCliArgs(['phase', 'delivery-approve', phaseId, '--project', projectId, '--batch', batchId, '--candidate', candidateId, '--revision', '4', '--candidate-revision', '2', '--confirm']))
      .toMatchObject({ commandId: 'phase.delivery-approve', operation: 'phase.delivery.approve', projectId, phaseId, batchId, candidateId, revision: 4, candidateRevision: 2, confirm: true });
  });

  it('[case:batch-delivery-views] preserves blocking, concurrency, budget, stop and evidence facts without claiming phase completion', () => {
    const result = {
      schemaVersion: 5,
      scope: 'batch-delivery',
      batch: {
        id: batchId, projectId, phaseId, status: 'running', revision: 4,
        featureIds: ['feature-a', 'feature-b'], maxConcurrentFeatures: 2,
        deadlineAt: null,
        budget: { status: 'available', blockingReasons: [], runsCreated: 1, attemptsCreated: null, runtimeStarts: 1, deadlineAt: null, tokenUsed: null, costUsed: null },
      },
      records: [
        { featureId: 'feature-a', featureStatus: 'failed', deliveryStatus: 'failed', status: 'failed', reason: 'verification_failed', failurePredecessors: [], blockingReasons: ['verification_failed'], delivery: {}, runs: [], integrations: [], stopOperations: [], budget: {}, evidenceRefs: ['evidence-a'] },
        { featureId: 'feature-b', featureStatus: 'pending', deliveryStatus: 'not_requested', status: 'blocked', reason: 'dependency_failed', failurePredecessors: ['feature-a'], blockingReasons: ['dependency_failed'], delivery: {}, runs: [], integrations: [], stopOperations: [], budget: {}, evidenceRefs: [] },
      ],
      summary: { completed: 0, failed: 1, blocked: 1, cancelled: 0, awaiting_approval: 0, in_progress: 0, budget_exhausted: 0 },
      currentRunningCount: 0, readyCount: 0, resourceWaitingCount: 1,
      stopOperations: [{ operationId: 'stop-1', status: 'uncertain' }],
      integrations: [{ integrationId: 'integration-1', status: 'blocked' }],
      nextCursor: null, limit: 50,
    } as any;
    const delivery = buildBatchDeliveryView(result);
    expect(delivery).toMatchObject({ state: 'failed', phaseCompleted: false, evidenceRefs: ['evidence-a'] });
    expect(formatBatchDeliveryView(delivery)).toContain('phaseCompleted=false');
    expect(formatBatchDeliveryView(delivery)).toContain('predecessors=feature-a');
    expect(formatBatchDeliveryView(delivery)).toContain('resourceWaiting=1');
    const observation = buildBatchObservationView({ delivery: result, control: { batch: { status: 'running', featureIds: ['feature-a', 'feature-b'] }, nextActions: ['resume'], stopOperations: [] } as any, blockingChain: [{ featureId: 'feature-b', failurePredecessors: ['feature-a'], blockingReasons: ['dependency_failed'] }] });
    expect(observation.actualConcurrency).toBe(0);
    expect(formatBatchObservationView(observation)).toContain('nextActions=resume');
  });

  it('[case:batch-delivery-help] documents the explicit approval and observation boundaries', () => {
    expect(getAppCliHelp('execution.batch-observe')).toContain('不认领');
    expect(getAppCliHelp('phase.delivery-approve')).toContain('不关闭 Phase');
  });

  it('[case:batch-delivery-invalid-input] rejects unsafe arguments before any Host I/O', () => {
    rejects(['execution', 'batch-delivery', 'bad', '--project', projectId], 'invalid_batch_id');
    rejects(['execution', 'batch-observe', batchId, '--project', projectId, '--limit', '201'], 'invalid_limit');
    rejects(['execution', 'finalize', batchId, '--project', projectId, '--phase', phaseId, '--revision', '1'], 'confirmation_required');
    rejects(['phase', 'delivery-approve', phaseId, '--project', projectId, '--batch', batchId, '--candidate', candidateId, '--revision', '1', '--candidate-revision', '1'], 'confirmation_required');
    rejects(['execution', 'batch-delivery', batchId, '--project', projectId, '--unknown'], 'unknown_argument');
    rejects(['execution', 'finalize', batchId, '--project', projectId, '--phase', phaseId, '--revision', '0', '--confirm'], 'invalid_revision');
  });
});

