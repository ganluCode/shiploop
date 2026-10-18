/**
 * P03-9 / F-010 finalization-only 新 Run 编排（application 层）。
 *
 * 编排顺序：
 * 1. 事务外先复用 F-009 只读资格/范围判定（历史终态 Run、workKey、当前输入、
 *    有效 Task/最终检查/审批证据），任何证据失败都只返回 rejected，不创建 Run；
 * 2. 同一只读现场再核验父 Batch 可继续性（暂停意图/取消/停止不确定会拒绝；
 *    finalization 失败的终态 Batch 只允许显式重开）、遗留占用与父预算
 *    （maxRuns/maxTotalAttempts/maxRuntimeStarts/maxNoProgressRuns/deadline）；
 * 3. 短写事务内重核项目/计划授权/检查政策/Run/Batch revision/同 Feature 活动
 *    Run/Phase 活动 Batch/基线占用与预算；只有全部通过才重开 failed Batch
 *    （不重置任何计数/预算/快照）、递增 runsCreated、按 workKey 递增
 *    dispatchOrdinal、创建 queued Run、写派发事件与 completed 回执。
 *
 * 边界：本 Task 不启动 Runtime、不创建 Attempt/Session、不执行检查/审批/Git，
 * 不增额或新建授权 Batch；零 Runtime 的收尾仍消耗一次 Run 名额，并继续受
 * 无进展上限、父 Batch 绝对 deadline 与统一占用约束。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { isStorageError } from '../ports/errors.js';
import {
  evaluateBatchBudgetReservation,
  type BatchBudgetReservationDecision,
} from '../ports/execution-budget.js';
import type { ExecutionResumeFacts, ExecutionResumeFactsReader } from '../ports/execution-resume-facts.js';
import { EXECUTION_RUN_PURPOSE } from '../ports/execution-start.js';
import {
  EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
  isExecutionTerminalStatus,
} from '../ports/execution-store.js';
import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';
import {
  FINALIZATION_RETRY_OPERATION,
  FINALIZATION_RETRY_RUN_KIND,
  FINALIZATION_RETRY_SCOPE_SCHEMA_VERSION,
  type FinalizationRetryCommandIdentity,
  type FinalizationRetryCommandPayload,
  type FinalizationRetryEnvelopeFace,
  type FinalizationRetryExecutionPort,
  type FinalizationRetryPlan,
  type FinalizationRetryRejectedReason,
  type FinalizationRetryScope,
  type PreparedFinalizationRetry,
  type PreparedFinalizationRetryReady,
} from '../ports/finalization-retry.js';
import { stableStringify } from '../ports/feature-plan.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';

const OPERATION = FINALIZATION_RETRY_OPERATION;
/** 与 ports/execution-store 的 Run 快照上限保持一致；超界在 prepare 即拒绝。 */
const SNAPSHOT_MAX_BYTES = 65_536;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rejected(
  reason: FinalizationRetryRejectedReason,
  detail: string | null = null,
): PreparedFinalizationRetry {
  return { kind: 'rejected', reason, detail };
}

function publicError(reason: string, _detail: string | null = null): PublicError {
  // 回执 error.details 只允许受控白名单键；子原因不进入持久回执。
  return new PublicError('conflict', OPERATION, undefined, { details: { reason } });
}

function validatePayload(raw: unknown): FinalizationRetryCommandPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('FinalizationRetry.prepare: payload must be an object');
  }
  const payload = raw as Record<string, unknown>;
  const allowed = new Set(['featureId', 'historicalRunId', 'workKey']);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new TypeError(`FinalizationRetry.prepare: unknown payload field ${key}`);
    }
  }
  const context: ValidationContext = { operation: OPERATION };
  if (typeof payload.workKey !== 'string' || payload.workKey.length === 0 || payload.workKey.length > 256) {
    throw new TypeError('FinalizationRetry.prepare: workKey must be a non-empty bounded string');
  }
  return {
    featureId: validateStableId(payload.featureId, context, 'featureId'),
    historicalRunId: validateStableId(payload.historicalRunId, context, 'historicalRunId'),
    workKey: payload.workKey,
  };
}

interface BatchContinuationDecision {
  readonly allowed: boolean;
  readonly reopen: boolean;
  readonly detail: string | null;
}

/**
 * 父 Batch 继续政策：只有可继续/可显式重开的 finalization 现场才允许创建新
 * Run。取消/停止不确定/暂停意图/已成功/进行中停止一律拒绝，不用新 Run 绕过。
 */
export function evaluateFinalizationBatchContinuation(batch: ExecutionBatchRecord): BatchContinuationDecision {
  if (batch.pauseRequestedAtUtcMs !== null) {
    return { allowed: false, reopen: false, detail: 'pause_requested' };
  }
  switch (batch.status) {
    case 'queued':
    case 'running':
    case 'paused':
      return { allowed: true, reopen: false, detail: null };
    case 'failed':
      // finalization 检查/提交失败后的显式 retryFinal：只重开父 Batch 承载新
      // Run，累计计数/预算/deadline/快照全部保留。
      return { allowed: true, reopen: true, detail: null };
    case 'succeeded':
      return { allowed: false, reopen: false, detail: 'batch_succeeded' };
    case 'cancelled':
      return { allowed: false, reopen: false, detail: 'batch_cancelled' };
    case 'cancelling':
      return { allowed: false, reopen: false, detail: 'batch_cancelling' };
    case 'pausing':
      return { allowed: false, reopen: false, detail: 'batch_pausing' };
    case 'interrupted':
      return { allowed: false, reopen: false, detail: 'batch_interrupted' };
    default:
      return { allowed: false, reopen: false, detail: `batch_status_${String(batch.status)}` };
  }
}

function budgetDetail(decision: BatchBudgetReservationDecision): string | null {
  if (decision.reasons.length === 0) return null;
  return decision.reasons
    .map(reason => `${reason.dimension}:${reason.reason}`)
    .sort()
    .join(',');
}

function occupancyUnresolved(facts: ExecutionResumeFacts): boolean {
  return facts.activeAttempts.length > 0
    || facts.attemptsWithLeases.length > 0
    || facts.leases.some(lease => lease.state === 'held' || lease.state === 'quarantined');
}

function readInputRefs(
  snapshot: Readonly<Record<string, unknown>>,
): readonly { artifactId: string; version: number; contentHash: string }[] | null {
  const raw = snapshot['inputs'];
  if (!Array.isArray(raw)) return null;
  const refs: { artifactId: string; version: number; contentHash: string }[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    if (typeof object['artifactId'] !== 'string'
      || typeof object['version'] !== 'number' || !Number.isSafeInteger(object['version'])
      || typeof object['contentHash'] !== 'string') {
      return null;
    }
    refs.push({
      artifactId: object['artifactId'],
      version: object['version'],
      contentHash: object['contentHash'],
    });
  }
  return refs;
}

/** 稳定计算并输出 finalization scope（F-009 plan 的完整摘要 + 受限步骤）。 */
export function computeFinalizationRetryScope(plan: FinalizationRetryPlan): FinalizationRetryScope {
  return {
    schemaVersion: FINALIZATION_RETRY_SCOPE_SCHEMA_VERSION,
    kind: FINALIZATION_RETRY_RUN_KIND,
    retryPlanDigest: sha256(stableStringify(plan)),
    historicalRunId: plan.historicalRunId,
    historicalBatchId: plan.historicalBatchId,
    historicalRunStatus: plan.historicalRunStatus,
    historicalRunDispatchOrdinal: plan.historicalRunDispatchOrdinal,
    planDigest: plan.current.planDigest,
    checkPolicyDigest: plan.current.checkPolicyDigest,
    headCommit: plan.current.headCommit,
    codeDigest: plan.current.codeDigest,
    workspaceId: plan.current.workspaceId,
    workspaceRevision: plan.current.workspaceRevision,
    retainedTaskIds: [...plan.retainedTaskIds],
    revalidateTasks: plan.revalidateTasks.map(task => ({
      taskId: task.taskId,
      checkKeys: [...task.checkKeys],
      reasons: [...task.reasons],
    })),
    finalVerification: {
      required: plan.finalVerification.required,
      checkKeys: [...plan.finalVerification.checkKeys],
    },
    approval: {
      required: true,
      valid: plan.approval.valid,
      approvalItemId: plan.approval.approvalItemId,
      reason: plan.approval.reason,
    },
    commit: {
      required: plan.commit.required,
      reconcileRequired: plan.commit.reconcileRequired,
      deliveryStatus: plan.commit.deliveryStatus,
      operationId: plan.commit.operationId,
      reason: plan.commit.reason,
    },
    missingSteps: [...plan.missingSteps],
    codingTaskIds: [],
    runtimeStarts: 0,
    newAttempts: 0,
  };
}

function boundedSnapshot(
  snapshot: Record<string, unknown>,
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > SNAPSHOT_MAX_BYTES) {
    throw new PublicError('invalid_input', OPERATION, undefined, { details });
  }
  return snapshot;
}

export interface FinalizationRetryExecutionDeps {
  /** F-009 只读资格/范围判定（全部证据 I/O 在其内部完成）。 */
  readonly planner: {
    prepare(request: unknown): Promise<
      | { readonly status: 'eligible'; readonly plan: FinalizationRetryPlan }
      | { readonly status: 'rejected'; readonly reason: FinalizationRetryRejectedReason; readonly detail: string | null }
    >;
  };
  /** 同库只读现场（Batch 状态/预算、工作区与遗留占用）。 */
  readonly facts: ExecutionResumeFactsReader;
  readonly nowMs?: () => number;
}

export function createFinalizationRetryExecutionService(
  deps: FinalizationRetryExecutionDeps,
): FinalizationRetryExecutionPort {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('FinalizationRetryExecution dependencies are required');
  }
  if (deps.planner === null || typeof deps.planner !== 'object'
    || typeof deps.planner.prepare !== 'function') {
    throw new TypeError('FinalizationRetryExecution dependency planner is required');
  }
  if (deps.facts === null || typeof deps.facts !== 'object'
    || typeof deps.facts.readFacts !== 'function') {
    throw new TypeError('FinalizationRetryExecution dependency facts is required');
  }
  const now = deps.nowMs ?? Date.now;

  async function prepareExecutionRetryFinal(
    projectId: string,
    rawPayload: unknown,
  ): Promise<PreparedFinalizationRetry> {
    let payload: FinalizationRetryCommandPayload;
    try {
      payload = validatePayload(rawPayload);
    } catch (error) {
      if (isStorageError(error, 'validation')) return rejected('identity_mismatch');
      throw error;
    }

    const planResult = await deps.planner.prepare({ projectId, ...payload });
    if (planResult.status === 'rejected') return rejected(planResult.reason, planResult.detail);
    const plan = planResult.plan;
    if (plan.projectId !== projectId || plan.featureId !== payload.featureId
      || plan.historicalRunId !== payload.historicalRunId || plan.workKey !== payload.workKey) {
      return rejected('identity_mismatch');
    }

    let facts: ExecutionResumeFacts;
    try {
      facts = deps.facts.readFacts({ projectId, targetKind: 'run', targetId: plan.historicalRunId });
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return rejected('run_not_found');
      }
      throw error;
    }
    if (facts.projectStatus !== 'active') return rejected('project_not_active');
    const run = facts.target as RunRecord;
    const batch = facts.batch;
    if (run.featureId !== plan.featureId || run.batchId !== plan.historicalBatchId
      || batch.id !== plan.historicalBatchId || batch.featureId !== plan.featureId) {
      return rejected('identity_mismatch');
    }
    if (!isExecutionTerminalStatus(run.status)) return rejected('run_not_terminal');
    if (run.purpose !== EXECUTION_RUN_PURPOSE) return rejected('unsupported_run_purpose');
    if (run.workKey !== plan.workKey) return rejected('work_key_mismatch');
    if (facts.workspace === null
      || facts.workspace.workspaceId !== plan.current.workspaceId
      || facts.workspace.revision !== plan.current.workspaceRevision) {
      return rejected('workspace_invalid', 'workspace_changed');
    }
    const continuation = evaluateFinalizationBatchContinuation(batch);
    if (!continuation.allowed) return rejected('batch_not_continuable', continuation.detail);
    if (occupancyUnresolved(facts)) return rejected('occupancy_unresolved');

    const nowMs = now();
    const budget = evaluateBatchBudgetReservation(
      batch.budgetSnapshot.batch,
      {
        runsCreated: batch.runsCreated,
        attemptsCreated: batch.attemptsCreated,
        runtimeStarts: batch.runtimeStarts,
        noProgressRuns: batch.noProgressRuns,
      },
      nowMs,
    );
    if (!budget.allowed) return rejected('budget_exhausted', budgetDetail(budget));

    const scopeDigest = batch.scopeSnapshot['previewDigest'];
    if (typeof scopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(scopeDigest)) {
      return rejected('authorization_invalid', 'batch_scope_digest_corrupt');
    }
    const inputs = readInputRefs(run.inputSnapshot);
    if (inputs === null) return rejected('work_key_mismatch', 'historical_inputs_invalid');
    const baseline = run.inputSnapshot['workspaceBaseline'];
    const workspaceBaseline = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline as Readonly<Record<string, unknown>>
      : null;
    const scope = computeFinalizationRetryScope(plan);
    let inputSnapshot: Record<string, unknown>;
    let configSnapshot: Record<string, unknown>;
    try {
      inputSnapshot = boundedSnapshot({
        schemaVersion: 1,
        previewDigest: scopeDigest,
        workKey: plan.workKey,
        planDigest: plan.current.planDigest,
        pendingTaskIds: [],
        inputs,
        workspaceBaseline,
        finalization: scope,
      }, { reason: 'finalization_scope_too_large', field: 'inputSnapshot' });
      configSnapshot = boundedSnapshot({
        schemaVersion: 1,
        runLimits: {
          maxAttemptsPerRun: batch.budgetSnapshot.run.maxAttemptsPerRun,
          runTimeLimitMs: batch.budgetSnapshot.run.runTimeLimitMs,
        },
        finalizationRetry: {
          schemaVersion: 1,
          historicalRunId: plan.historicalRunId,
          historicalBatchId: plan.historicalBatchId,
          retryPlanDigest: scope.retryPlanDigest,
        },
      }, { reason: 'finalization_scope_too_large', field: 'configSnapshot' });
    } catch (error) {
      if (error instanceof PublicError && error.code === 'invalid_input') {
        return rejected('authorization_stale', 'finalization_scope_too_large');
      }
      throw error;
    }

    const ready: PreparedFinalizationRetryReady = {
      kind: 'ready',
      projectId,
      featureId: plan.featureId,
      historicalRunId: plan.historicalRunId,
      historicalBatchId: plan.historicalBatchId,
      expectedBatchRevision: batch.revision,
      expectedBatchStatus: batch.status,
      plan,
      scope,
      scopeDigest,
      runLimits: {
        maxAttemptsPerRun: batch.budgetSnapshot.run.maxAttemptsPerRun,
        runTimeLimitMs: batch.budgetSnapshot.run.runTimeLimitMs,
      },
      inputSnapshot,
      configSnapshot,
    };
    return ready;
  }

  function submitExecutionRetryFinal(
    identity: FinalizationRetryCommandIdentity,
    envelope: FinalizationRetryEnvelopeFace,
    transaction: import('../ports/atomic-commands.js').CommandTransaction,
    prepared: PreparedFinalizationRetry,
  ): CommandReceipt {
    const projectId = envelope.scope.projectId;
    const completedAt = new Date(now()).toISOString();
    const receiptIdentity = {
      principalId: identity.principalId,
      commandId: identity.commandId,
      operation: OPERATION,
      scope: identity.scope,
      requestDigest: identity.requestDigest,
      issuedAt: identity.issuedAt,
      completedAt,
    };
    const reject = (reason: FinalizationRetryRejectedReason, detail: string | null = null): CommandReceipt => {
      const receipt = createRejectedReceipt({
        ...receiptIdentity,
        error: publicError(reason, detail),
      });
      transaction.saveReceipt(receipt);
      return receipt;
    };
    if (prepared.kind === 'rejected') return reject(prepared.reason, prepared.detail);
    if (prepared.projectId !== projectId
      || prepared.featureId !== envelope.payload.featureId
      || prepared.historicalRunId !== envelope.payload.historicalRunId
      || prepared.plan.workKey !== envelope.payload.workKey) {
      return reject('identity_mismatch');
    }

    const project = transaction.getProject(projectId);
    if (project.status !== 'active') return reject('project_not_active');

    let run: RunRecord;
    let batch: ExecutionBatchRecord;
    try {
      run = transaction.getExecutionRun(projectId, prepared.historicalRunId);
      batch = transaction.getExecutionBatch(projectId, prepared.historicalBatchId);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return reject('run_not_found');
      }
      throw error;
    }
    if (run.featureId !== prepared.featureId || run.batchId !== prepared.historicalBatchId
      || batch.featureId !== prepared.featureId) {
      return reject('identity_mismatch');
    }
    if (!isExecutionTerminalStatus(run.status)) return reject('run_not_terminal');
    if (run.purpose !== EXECUTION_RUN_PURPOSE) return reject('unsupported_run_purpose');
    if (run.workKey !== prepared.plan.workKey) return reject('work_key_mismatch');
    if (batch.revision !== prepared.expectedBatchRevision
      || batch.status !== prepared.expectedBatchStatus) {
      return reject('stale_revision');
    }
    if (batch.pauseRequestedAtUtcMs !== null) return reject('batch_not_continuable', 'pause_requested');
    const continuation = evaluateFinalizationBatchContinuation(batch);
    if (!continuation.allowed) return reject('batch_not_continuable', continuation.detail);

    const activeBatch = transaction.getActivePhaseExecutionBatch(projectId, batch.phaseId);
    if (activeBatch !== null && activeBatch.id !== batch.id) {
      return reject('batch_not_continuable', 'other_active_batch');
    }
    const activeRun = transaction.getActiveExecutionRun(projectId, prepared.featureId);
    if (activeRun !== null) return reject('active_run_conflict', activeRun.id);
    const baselineOccupancy = transaction.readBaselineOccupancy();
    if (baselineOccupancy.holderOperationId !== null) {
      return reject('occupancy_unresolved', 'baseline_in_progress');
    }

    // 计划/检查政策/审批身份重核：prepare 之外发生变化时受限 scope 已过期。
    let snapshot;
    try {
      snapshot = transaction.getFeaturePlan(projectId, prepared.featureId);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return reject('identity_mismatch');
      }
      throw error;
    }
    if (snapshot.feature.planDigest !== prepared.plan.current.planDigest) {
      return reject('authorization_stale', 'plan_changed');
    }
    if (snapshot.feature.status === 'completed') return reject('already_finalized');
    const decisions = transaction.listPlanApprovals(projectId, prepared.featureId);
    const globalSettings = transaction.getGlobalSettingsOrNull();
    const projectSettings = transaction.getProjectSettingsOrNull(projectId);
    const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
      globalSettings === null ? null : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
      projectSettings === null ? null : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
    );
    if (checkPolicyDigest !== prepared.plan.current.checkPolicyDigest) {
      return reject('authorization_stale', 'check_policy_changed');
    }
    const validity = evaluatePlanApprovalValidity({
      planDigest: snapshot.feature.planDigest,
      planStatus: snapshot.feature.planStatus,
      taskCount: snapshot.tasks.length,
      decisions,
      currentCheckPolicyDigest: checkPolicyDigest,
    });
    const phase = transaction.getPhase(projectId, snapshot.feature.phaseId);
    if (!validity.valid || phase.status !== 'open') return reject('authorization_invalid');

    const nowMs = now();
    const budget = evaluateBatchBudgetReservation(
      batch.budgetSnapshot.batch,
      {
        runsCreated: batch.runsCreated,
        attemptsCreated: batch.attemptsCreated,
        runtimeStarts: batch.runtimeStarts,
        noProgressRuns: batch.noProgressRuns,
      },
      nowMs,
    );
    if (!budget.allowed) return reject('budget_exhausted', budgetDetail(budget));

    let currentBatch = batch;
    if (batch.status === 'failed') {
      const reopened = transaction.reopenExecutionBatchForFinalizationRetry({
        projectId,
        batchId: batch.id,
        expectedRevision: batch.revision,
      });
      if (reopened.outcome === 'stale_revision') return reject('stale_revision');
      if (reopened.outcome !== 'reopened') {
        return reject('batch_not_continuable', 'batch_reopen_rejected');
      }
      currentBatch = reopened.batch;
    }

    const workRuns = transaction.listExecutionRunsForWorkKey(
      projectId,
      currentBatch.id,
      prepared.plan.workKey,
    );
    const dispatchOrdinal = workRuns.length === 0
      ? 1
      : Math.max(...workRuns.map(entry => entry.dispatchOrdinal)) + 1;
    const dispatched = transaction.recordExecutionRunDispatch(projectId, currentBatch.id);
    const runId = randomUUID();
    const created = transaction.insertExecutionRun({
      projectId,
      batchId: currentBatch.id,
      featureId: prepared.featureId,
      runId,
      purpose: EXECUTION_RUN_PURPOSE,
      inputSnapshot: prepared.inputSnapshot,
      configSnapshot: prepared.configSnapshot,
      status: 'queued',
      scopeDigest: prepared.scopeDigest,
      workKey: prepared.plan.workKey,
      dispatchOrdinal,
      maxAttemptsPerRun: prepared.runLimits.maxAttemptsPerRun,
      runTimeLimitMs: prepared.runLimits.runTimeLimitMs,
      reason: null,
    });
    transaction.appendExecutionEvent({
      projectId,
      eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
      aggregateType: 'run',
      aggregateId: created.id,
      aggregateRevision: created.revision,
      payload: { dispatched: true },
    });

    const receipt = createCompletedReceipt({
      ...receiptIdentity,
      resultRef: createResultRef(randomBytes(32)),
      result: {
        schemaVersion: 1,
        retryFinal: true,
        dispatched: true,
        batchId: currentBatch.id,
        runId: created.id,
        featureId: prepared.featureId,
        historicalRunId: prepared.historicalRunId,
        workKey: prepared.plan.workKey,
        dispatchOrdinal,
        runsCreated: dispatched.runsCreated,
        status: created.status,
        finalizationScopeDigest: prepared.scope.retryPlanDigest,
        missingSteps: [...prepared.scope.missingSteps],
        revalidateTaskIds: prepared.scope.revalidateTasks.map(task => task.taskId),
        finalCheckKeys: [...prepared.scope.finalVerification.checkKeys],
        runtimeStarts: 0,
        attemptsCreated: 0,
      },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }

  return { prepareExecutionRetryFinal, submitExecutionRetryFinal };
}

/** 提交后唤醒：仅新提交的 finalization Run 派发通知；失败不回滚已提交事务。 */
export function signalFinalizationRetryAfterCommit(
  signal: { signalRunDispatched(input: { projectId: string; batchId: string; runId: string; featureId: string }): void } | undefined,
  receipt: CommandReceipt,
): void {
  if (signal === undefined || receipt.replayed || receipt.status !== 'completed') return;
  if (receipt.operation !== OPERATION || receipt.scope.kind !== 'project') return;
  const result = receipt.result as Record<string, unknown> | null;
  if (result === null || typeof result !== 'object' || result.retryFinal !== true) return;
  const { batchId, runId, featureId } = result;
  if (typeof batchId !== 'string' || typeof runId !== 'string' || typeof featureId !== 'string') return;
  try {
    signal.signalRunDispatched({
      projectId: receipt.scope.projectId,
      batchId,
      runId,
      featureId,
    });
  } catch {
    // 唤醒丢失/失败：持久 queued Run 是权威，扫描可补偿。
  }
}
