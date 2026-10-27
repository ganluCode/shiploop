import { describe, expect, it } from 'vitest';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  createIntegrationPlanGenerationService,
  type IntegrationBatchApproval,
  type IntegrationPredecessorEvidence,
  type IntegrationPredecessorEvidenceReader,
} from '../../../packages/core/src/application/integration-plan-generation.ts';
import type { AtomicCommandStore, CommandTransaction } from '../../../packages/core/src/ports/atomic-commands.ts';
import {
  createIntegrationPlan,
} from '../../../packages/core/src/ports/integration-plan.ts';
import type { IntegrationPlanAccess, PersistedIntegrationPlan } from '../../../packages/core/src/ports/integration-plan-store.ts';

const BASELINE = 'c'.repeat(40);
const evidenceDigest = (value: string) => value.repeat(64 / value.length);

function batch(overrides: Partial<IntegrationBatchApproval> = {}) {
  return {
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    successorFeatureId: 'feature-c',
    predecessorFeatureIds: ['feature-b', 'feature-a'],
    targetBaseline: BASELINE,
    approvedInputs: [
      { inputId: 'input-a', digest: evidenceDigest('1') },
      { inputId: 'input-b', digest: evidenceDigest('2') },
    ],
    verificationScope: ['typecheck', 'integration-tests'],
    strategySummary: { conflictPolicy: 'deterministic-only', maxAttempts: 1 },
    ...overrides,
  };
}

function evidence(featureId: string, overrides: Partial<IntegrationPredecessorEvidence> = {}) {
  const letter = featureId.at(-1)!;
  return {
    projectId: 'project-1', phaseId: 'phase-1', featureId,
    dependencyPassed: true,
    delivery: {
      commitSha: letter.repeat(40), evidenceId: `delivery-${featureId}`,
      evidenceDigest: evidenceDigest(letter),
    },
    commitExists: true,
    coveredInputIds: [`input-${letter}`],
    ancestorVerified: true,
    evidenceFresh: true,
    ...overrides,
  };
}

function harness(readBatch: (projectId: string, batchId: string) => IntegrationBatchApproval | undefined = () => batch(),
  readEvidence: IntegrationPredecessorEvidenceReader['readEvidence'] = (_project, _phase, featureId) => evidence(featureId),
) {
  const records = new Map<string, PersistedIntegrationPlan>();
  let createCount = 0;
  let mergeCount = 0;
  const tx = {
    createIntegrationPlan(input: unknown) {
      const plan = createIntegrationPlan(input);
      const record = { ...plan, revision: 1, createdAtUtcMs: 100, updatedAtUtcMs: 100, frozenAtUtcMs: null } as PersistedIntegrationPlan;
      if (records.has(record.integrationId)) throw new StorageError('conflict', 'fake.create', 'duplicate');
      records.set(record.integrationId, record);
      createCount += 1;
      return record;
    },
    getIntegrationPlan(_projectId: string, integrationId: string) {
      const record = records.get(integrationId);
      if (record === undefined) throw new StorageError('not_found', 'fake.get', 'missing');
      return record;
    },
    freezeIntegrationPlan(input: { projectId: string; integrationId: string; expectedRevision: number }) {
      const record = records.get(input.integrationId)!;
      if (record.revision !== input.expectedRevision) throw new StorageError('conflict', 'fake.freeze', 'stale');
      const frozen = { ...record, revision: record.revision + 1, updatedAtUtcMs: 101, frozenAtUtcMs: 101 };
      records.set(input.integrationId, frozen);
      return frozen;
    },
  } as unknown as CommandTransaction;
  const atomic = { transact: (_operation: string, callback: (transaction: CommandTransaction) => unknown) => callback(tx) } as unknown as AtomicCommandStore;
  const plans = { readIntegrationPlan: (_projectId: unknown, integrationId: unknown) => records.get(String(integrationId)) } as unknown as IntegrationPlanAccess;
  const service = createIntegrationPlanGenerationService({
    atomic,
    plans,
    batches: { readApprovedBatch: readBatch },
    predecessors: { readEvidence },
  });
  return { service, records, get createCount() { return createCount; }, get mergeCount() { return mergeCount; } };
}

describe('P05-6 F-003 integration plan generation service', () => {
  it('[case:integration-generation-freeze-reuse] 从已批准 Batch 固定 A/B 成果并重复复用同一身份', () => {
    const h = harness();
    const first = h.service.generate({ projectId: 'project-1', batchId: 'batch-1' });
    expect(first.plan.status).toBe('dependency_passed');
    expect(first.plan.frozenAtUtcMs).not.toBeNull();
    expect(first.plan.mergeOrder).toEqual(['feature-a', 'feature-b']);
    expect(first.plan.predecessors.map(item => item.delivery?.commitSha)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(first.plan.targetBaseline).toBe(BASELINE);
    expect(first.plan.verificationScope).toEqual(['integration-tests', 'typecheck']);
    expect(first.plan.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    const replay = h.service.generate({ projectId: 'project-1', batchId: 'batch-1' });
    expect(replay.plan.integrationId).toBe(first.plan.integrationId);
    expect(replay.reused).toBe(true);
    expect(h.createCount).toBe(1);
    expect(h.mergeCount).toBe(0);
  });

  it('[case:integration-generation-blocked-inputs] 缺成果或获准输入覆盖不完整时持久 blocked 且不冻结', () => {
    const h = harness(() => batch(), (_project, _phase, featureId) => evidence(featureId,
      featureId === 'feature-b' ? { delivery: null, commitExists: false, coveredInputIds: [] } : {}));
    const result = h.service.generate({ projectId: 'project-1', batchId: 'batch-1' });
    expect(result.plan.status).toBe('blocked');
    expect(result.plan.blockReasons).toEqual(expect.arrayContaining(['missing_delivery_evidence', 'input_coverage_incomplete']));
    expect(result.plan.frozenAtUtcMs).toBeNull();
  });

  it('[case:integration-generation-single-ancestor] 单前置未核对祖先关系时拒绝复用', () => {
    const h = harness(() => batch({ predecessorFeatureIds: ['feature-a'], approvedInputs: [{ inputId: 'input-a', digest: evidenceDigest('1') }] }),
      (_project, _phase, featureId) => evidence(featureId, { ancestorVerified: false }));
    expect(() => h.service.generate({ projectId: 'project-1', batchId: 'batch-1' }))
      .toThrowError(expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason: 'ancestor_not_verified' }) }));
    expect(h.createCount).toBe(0);
  });

  it('[case:integration-generation-stale] 冻结后观察到基线或输入变化时报告 stale，保留原成果 SHA', () => {
    const h = harness();
    const first = h.service.generate({ projectId: 'project-1', batchId: 'batch-1' });
    const stale = h.service.status('project-1', first.plan.integrationId, {
      targetBaseline: 'd'.repeat(40),
      inputDigest: 'e'.repeat(64),
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleReasons).toEqual(expect.arrayContaining(['target_baseline_changed', 'input_digest_changed']));
    expect(stale.plan.predecessors[0]?.delivery?.commitSha).toBe('a'.repeat(40));
    expect(h.mergeCount).toBe(0);
  });
});
