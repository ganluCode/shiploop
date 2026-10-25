import { describe, expect, it } from 'vitest';
import {
  createIntegrationPlanControlService,
  type IntegrationPlanControlDeps,
} from '../../../packages/core/src/application/integration-plan-control.ts';
import { createIntegrationPlan, type IntegrationPlanInput } from '../../../packages/core/src/ports/integration-plan.ts';
import type { IntegrationPlanAccess, PersistedIntegrationPlan } from '../../../packages/core/src/ports/integration-plan-store.ts';
import type { AtomicCommandStore, CommandTransaction } from '../../../packages/core/src/ports/atomic-commands.ts';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

function input(): IntegrationPlanInput {
  return {
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: 'feature-c',
    targetBaseline: 'd'.repeat(40),
    predecessors: [{ projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true,
      delivery: { commitSha: 'e'.repeat(40), evidenceId: 'delivery-a', evidenceDigest: DIGEST },
      coveredInputIds: ['input-a'], ancestorVerified: true }],
    approvedInputs: [{ inputId: 'input-a', digest: DIGEST }], mergeOrder: ['feature-a'],
    verificationScope: ['typecheck'], strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
  };
}

function harness(): { service: ReturnType<typeof createIntegrationPlanControlService>; read: () => PersistedIntegrationPlan; writes: { result: number; status: number } } {
  const created = createIntegrationPlan(input());
  let plan = { ...created, revision: 2, createdAtUtcMs: 1, updatedAtUtcMs: 2, frozenAtUtcMs: 2 } as PersistedIntegrationPlan;
  const writes = { result: 0, status: 0 };
  const tx = {
    getIntegrationPlan: (_projectId: string, integrationId: string) => {
      if (integrationId !== plan.integrationId) throw new Error('missing');
      return plan;
    },
    updateIntegrationPlanResult: (raw: { expectedRevision: number; integrationResult: typeof plan.integrationResult }) => {
      if (raw.expectedRevision !== plan.revision) throw Object.assign(new Error('revision'), { kind: 'conflict' });
      if (plan.integrationResult?.operationId !== undefined && plan.integrationResult.operationId !== raw.integrationResult?.operationId) {
        throw Object.assign(new Error('owner'), { kind: 'conflict' });
      }
      const next = createIntegrationPlan({
        projectId: plan.projectId, phaseId: plan.phaseId, batchId: plan.batchId, successorFeatureId: plan.successorFeatureId,
        targetBaseline: plan.targetBaseline, predecessors: plan.predecessors, approvedInputs: plan.approvedInputs,
        mergeOrder: plan.mergeOrder, verificationScope: plan.verificationScope, strategySummary: plan.strategySummary,
        integrationResult: raw.integrationResult,
      });
      plan = { ...next, revision: plan.revision + 1, createdAtUtcMs: 1, updatedAtUtcMs: plan.revision + 1, frozenAtUtcMs: 2 };
      writes.result += 1;
      return plan;
    },
    updateIntegrationPlanStatus: (raw: { expectedRevision: number; status: typeof plan.status; blockReasons: typeof plan.blockReasons; staleReasons: typeof plan.staleReasons }) => {
      if (raw.expectedRevision !== plan.revision) throw Object.assign(new Error('revision'), { kind: 'conflict' });
      plan = { ...plan, revision: plan.revision + 1, updatedAtUtcMs: plan.revision + 1,
        status: raw.status, blockReasons: raw.blockReasons, staleReasons: raw.staleReasons };
      writes.status += 1;
      return plan;
    },
  } as unknown as CommandTransaction;
  const atomic = { transact: (_operation: string, callback: (tx: CommandTransaction) => unknown) => callback(tx) } as unknown as AtomicCommandStore;
  const access = { readIntegrationPlan: () => plan } as unknown as IntegrationPlanAccess;
  const deps: IntegrationPlanControlDeps = { atomic, plans: access };
  return { service: createIntegrationPlanControlService(deps), read: () => plan, writes };
}

describe('P05-6 F-004 integration plan control', () => {
  it('[case:integration-control-fencing] operation result is fenced by owner/version and same replay is idempotent', () => {
    const h = harness();
    const started = h.service.begin({ projectId: 'project-a', integrationId: h.read().integrationId, ownerId: 'runner-a', ownerVersion: 1 });
    expect(started.plan.integrationResult).toMatchObject({ operationStatus: 'pending', ownerId: 'runner-a', ownerVersion: 1 });
    expect(() => h.service.recordResult({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId,
      ownerId: 'runner-b', ownerVersion: 1, result: { commitSha: SHA, treeSha: TREE, verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: null } }))
      .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    const passed = h.service.recordResult({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId,
      ownerId: 'runner-a', ownerVersion: 1, result: { commitSha: SHA, treeSha: TREE, verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: null } });
    expect(passed.plan.status).toBe('integration_passed');
    expect(h.service.recordResult({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId,
      ownerId: 'runner-a', ownerVersion: 1, result: { commitSha: SHA, treeSha: TREE, verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: null } }).plan.revision)
      .toBe(passed.plan.revision);
  });

  it('[case:integration-control-interrupted-reconcile] interruption stays blocked and recovery reuses the persisted operation', () => {
    const h = harness();
    const started = h.service.begin({ projectId: 'project-a', integrationId: h.read().integrationId, ownerId: 'runner-a', ownerVersion: 1 });
    const unknown = h.service.interrupt({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId, ownerId: 'runner-a', ownerVersion: 1 });
    expect(unknown.plan.status).toBe('blocked');
    expect(unknown.plan.integrationResult).toMatchObject({ operationStatus: 'unknown' });
    expect(() => h.service.begin({ projectId: 'project-a', integrationId: h.read().integrationId, ownerId: 'runner-b', ownerVersion: 2 }))
      .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    const recovered = h.service.reconcile({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId,
      ownerId: 'runner-b', ownerVersion: 2, result: { commitSha: SHA, treeSha: TREE, verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: null } });
    expect(recovered.plan.status).toBe('integration_passed');
  });

  it('[case:integration-control-fixed-baseline-gate] successor receives only the fixed integrated commit and rejects drift/incomplete plans', () => {
    const h = harness();
    const started = h.service.begin({ projectId: 'project-a', integrationId: h.read().integrationId, ownerId: 'runner-a', ownerVersion: 1 });
    expect(() => h.service.assertSuccessorStart({ projectId: 'project-a', successorFeatureId: 'feature-c', integrationId: started.plan.integrationId })).toThrowError(expect.objectContaining({ kind: 'conflict' }));
    h.service.recordResult({ projectId: 'project-a', integrationId: h.read().integrationId, operationId: started.operationId,
      ownerId: 'runner-a', ownerVersion: 1, result: { commitSha: SHA, treeSha: TREE, verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: 'no conflicts' } });
    expect(h.service.assertSuccessorStart({ projectId: 'project-a', successorFeatureId: 'feature-c', integrationId: h.read().integrationId })).toMatchObject({ baseCommit: SHA, treeSha: TREE });
    expect(() => h.service.assertSuccessorStart({ projectId: 'project-a', successorFeatureId: 'feature-c', integrationId: h.read().integrationId, targetBaseline: 'f'.repeat(40) })).toThrowError(expect.objectContaining({ kind: 'conflict' }));
  });
});
