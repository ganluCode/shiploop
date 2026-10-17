import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { ControlledGitCommitService } from '../ports/controlled-git-commit.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type {
  FeatureFinalizationRecord,
  FeatureFinalizationOutcome,
} from '../ports/feature-finalization.js';

export interface FeatureFinalizationInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly operationId: string | null;
}

export interface FeatureFinalizationVerification {
  readonly passed: boolean;
  readonly reason: string;
}

export interface FeatureFinalizationApproval {
  readonly valid: boolean;
  readonly reason: string;
}

export interface FeatureFinalizationOptions {
  readonly atomic: AtomicCommandStore;
  readonly verify: (input: FeatureFinalizationInput) => Promise<FeatureFinalizationVerification>;
  readonly readApproval: (input: FeatureFinalizationInput) => Promise<FeatureFinalizationApproval>;
  readonly commit?: ControlledGitCommitService;
}

function isTerminal(feature: { status: string }, run: { status: string }, batch: { status: string }): boolean {
  return ['completed', 'partial', 'failed'].includes(feature.status) &&
    ['succeeded', 'failed', 'cancelled'].includes(run.status) &&
    ['succeeded', 'failed', 'cancelled'].includes(batch.status);
}

/**
 * F-007 Feature 收尾编排：外部验证、人审和 Git 在事务外完成；最终状态、Run、
 * 单 Feature Batch 与脱敏事件由一个原子事务提交。不会创建 Attempt、Runtime 或
 * 修复 Session，重复唤醒在前置读取处直接返回既有终态。
 */
export function createFeatureFinalizationService(options: FeatureFinalizationOptions) {
  const inFlight = new Map<string, Promise<FeatureFinalizationRecord>>();
  async function runFinalize(input: FeatureFinalizationInput): Promise<FeatureFinalizationRecord> {
    const current = options.atomic.transact('FeatureFinalization.read', (transaction) => {
      const plan = transaction.getFeaturePlan(input.projectId, input.featureId);
      const run = transaction.getExecutionRun(input.projectId, input.runId);
      const batch = transaction.getExecutionBatch(input.projectId, input.batchId);
      if (run.batchId !== batch.id || run.featureId !== input.featureId || batch.featureId !== input.featureId) {
        throw new Error('Feature、Run、Batch 归属不一致');
      }
      return { feature: plan.feature, run, batch };
    });

    if (isTerminal(current.feature, current.run, current.batch)) {
      return {
        ...current,
        deliveryStatus: current.feature.deliveryStatus,
        outcome: current.feature.status as FeatureFinalizationOutcome,
        reason: current.run.reason ?? 'already_settled',
        operationId: input.operationId,
      };
    }

    const verification = await options.verify(input);
    if (!verification.passed) {
      return options.atomic.transact('FeatureFinalization.verificationFailed', (transaction) => transaction.finalizeFeatureDelivery({
        ...input, expectedFeatureRevision: current.feature.revision, expectedRunRevision: current.run.revision,
        expectedBatchRevision: current.batch.revision, outcome: 'partial', reason: verification.reason,
        deliveryStatus: 'not_requested', operationId: input.operationId,
      }));
    }

    const approval = await options.readApproval(input);
    if (!approval.valid) {
      return options.atomic.transact('FeatureFinalization.awaitingApproval', (transaction) => transaction.finalizeFeatureDelivery({
        ...input, expectedFeatureRevision: current.feature.revision, expectedRunRevision: current.run.revision,
        expectedBatchRevision: current.batch.revision, outcome: 'awaiting_approval', reason: approval.reason,
        deliveryStatus: 'not_requested', operationId: input.operationId,
      }));
    }

    let outcome: FeatureFinalizationOutcome = 'completed';
    let deliveryStatus: 'not_requested' | 'succeeded' | 'failed' | 'pending' = 'succeeded';
    let reason = 'feature_finalized';
    if (options.commit === undefined || input.operationId === null) {
      outcome = 'failed';
      deliveryStatus = 'failed';
      reason = 'commit_authority_missing';
    } else {
      try {
        const operation: GitOperationRecord = await options.commit.commit({ projectId: input.projectId, operationId: input.operationId });
        if (operation.intent.operationId !== input.operationId) throw new Error('delivery_receipt_mismatch');
        deliveryStatus = operation.deliveryStatus ?? (operation.status === 'unknown' ? 'pending' : operation.status === 'failed' ? 'failed' : 'succeeded');
        if (deliveryStatus !== 'succeeded') {
          outcome = 'partial';
          reason = operation.reasonCode ?? 'delivery_failed';
        }
      } catch (error) {
        outcome = 'partial';
        deliveryStatus = 'pending';
        reason = error instanceof Error && error.message.length > 0 ? error.message.slice(0, 500) : 'delivery_outcome_unknown';
      }
    }

    return options.atomic.transact('FeatureFinalization.commitResult', (transaction) => transaction.finalizeFeatureDelivery({
      ...input, expectedFeatureRevision: current.feature.revision, expectedRunRevision: current.run.revision,
      expectedBatchRevision: current.batch.revision, outcome, reason, deliveryStatus, operationId: input.operationId,
    }));
  }
  async function finalize(input: FeatureFinalizationInput): Promise<FeatureFinalizationRecord> {
    const key = `${input.projectId}:${input.featureId}:${input.batchId}:${input.runId}`;
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = runFinalize(input);
    inFlight.set(key, promise);
    try { return await promise; } finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
  }
  return { finalize };
}
