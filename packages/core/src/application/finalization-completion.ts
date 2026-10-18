/**
 * P03-9 / F-012 finalization-only Run 收尾完成编排。
 *
 * 顺序：
 * 1. 读取 finalization Run/Batch 现场与持久 scope，确认仍为受限收尾用途；
 * 2. 以 F-009 只读 planner 重算当前代码/HEAD/检查政策/工作区/Task 证据与
 *    最终审批；任何检查缺失都只返回 verification_required，不自动重跑；
 * 3. 审批缺失时把 Run/Batch/Feature 原子置为 awaiting_approval（Run paused），
 *    批准命令本身不提交；显式 resume 后再次进入本编排；
 * 4. 提交前再次核对预算、当前 HEAD/tree、审批和既有 Git operation：已成功
 *    提交只按真实 Git 事实复用，pending 只核对，明确失败才生成新 operation；
 * 5. 只有全部轴满足才通过既有 finalizeFeatureDelivery CAS 完成 Run/Batch/
 *    Feature；取消竞争与旧 revision 回执不得覆盖当前终态。
 *
 * 本模块不创建 Attempt/Run/Session，不启动 Runtime，不 push/PR，不 reset 代码。
 */
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import {
  evaluateBatchBudgetReservation,
  evaluateRunBudgetReservation,
} from '../ports/execution-budget.js';
import type { ExecutionResumeFactsReader } from '../ports/execution-resume-facts.js';
import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';
import { EXECUTION_RUN_PURPOSE } from '../ports/execution-start.js';
import {
  FINALIZATION_COMPLETION_OPERATION,
  computeFinalizationOperationId,
  isObject,
  type FinalizationCommitRequest,
  type FinalizationCompletionPort,
  type FinalizationCompletionResult,
  type FinalizationCompletionScope,
  type FinalizationCompletionStatus,
  type FinalizationDeliveryConfig,
  type FinalizationDeliveryPort,
  type FinalizationGitOperationView,
} from '../ports/finalization-completion.js';
import type { FinalizationRetryPlan } from '../ports/finalization-retry.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { FeatureRecord } from '../ports/plan-store.js';
import { isStorageError } from '../ports/errors.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);
const TERMINAL_FEATURE_STATUSES = new Set(['completed', 'partial', 'failed']);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return [...value];
}

function readScope(run: RunRecord): FinalizationCompletionScope | null {
  const raw = run.inputSnapshot['finalization'];
  if (!isObject(raw) || raw['schemaVersion'] !== 1 || raw['kind'] !== 'finalization-only') return null;
  const codingTaskIds = raw['codingTaskIds'];
  if (!Array.isArray(codingTaskIds) || codingTaskIds.length !== 0) return null;
  const retained = stringArray(raw['retainedTaskIds']);
  const commitRaw = raw['commit'];
  if (!isObject(commitRaw)
    || typeof commitRaw['required'] !== 'boolean'
    || typeof commitRaw['reconcileRequired'] !== 'boolean'
    || (commitRaw['operationId'] !== null && typeof commitRaw['operationId'] !== 'string')
    || typeof commitRaw['deliveryStatus'] !== 'string') {
    return null;
  }
  if (retained === null
    || typeof raw['retryPlanDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['retryPlanDigest'])
    || typeof raw['historicalRunId'] !== 'string'
    || typeof raw['historicalBatchId'] !== 'string'
    || typeof raw['planDigest'] !== 'string'
    || typeof raw['checkPolicyDigest'] !== 'string'
    || typeof raw['headCommit'] !== 'string'
    || typeof raw['codeDigest'] !== 'string'
    || typeof raw['workspaceId'] !== 'string'
    || !Number.isSafeInteger(raw['workspaceRevision'])
    || raw['runtimeStarts'] !== 0
    || raw['newAttempts'] !== 0) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: 'finalization-only',
    retryPlanDigest: raw['retryPlanDigest'],
    historicalRunId: raw['historicalRunId'],
    historicalBatchId: raw['historicalBatchId'],
    planDigest: raw['planDigest'],
    checkPolicyDigest: raw['checkPolicyDigest'],
    headCommit: raw['headCommit'],
    codeDigest: raw['codeDigest'],
    workspaceId: raw['workspaceId'],
    workspaceRevision: raw['workspaceRevision'] as number,
    commit: {
      required: commitRaw['required'],
      reconcileRequired: commitRaw['reconcileRequired'],
      operationId: commitRaw['operationId'],
      deliveryStatus: commitRaw['deliveryStatus'],
    },
    codingTaskIds: [],
    runtimeStarts: 0,
    newAttempts: 0,
  };
}

function sameIdentity(plan: FinalizationRetryPlan, scope: FinalizationCompletionScope): boolean {
  return sameIdentityExceptHead(plan, scope) && plan.current.headCommit === scope.headCommit;
}

function sameIdentityExceptHead(plan: FinalizationRetryPlan, scope: FinalizationCompletionScope): boolean {
  return plan.current.planDigest === scope.planDigest
    && plan.current.codeDigest === scope.codeDigest
    && plan.current.checkPolicyDigest === scope.checkPolicyDigest
    && plan.current.workspaceId === scope.workspaceId
    && plan.current.workspaceRevision === scope.workspaceRevision;
}

function budgetReasons(decision: { readonly allowed: boolean; readonly reasons: readonly { dimension: string; reason: string }[] }): string {
  if (decision.allowed) return '';
  return decision.reasons.map(reason => `${reason.dimension}:${reason.reason}`).sort().join(',');
}

function controlReason(run: RunRecord, batch: ExecutionBatchRecord, nowMs: number): string | null {
  if (run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null) return 'pause_requested';
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return `run_${run.status}`;
  if (batch.status !== 'queued' && batch.status !== 'running') return `batch_${batch.status}`;
  if (nowMs >= batch.deadlineAtUtcMs) return 'batch_deadline_exceeded';
  const runDeadline = run.startedAtUtcMs === null ? null : run.startedAtUtcMs + run.runTimeLimitMs;
  if (runDeadline !== null && nowMs >= runDeadline) return 'run_deadline_exceeded';
  return null;
}

function workspaceBaseline(facts: ReturnType<ExecutionResumeFactsReader['readFacts']>): WorkspaceBaseline | null {
  const workspace = facts.workspace;
  if (workspace === null) return null;
  return {
    repositoryBindingId: workspace.repositoryBindingId,
    repositoryBindingRevision: workspace.repositoryBindingRevision,
    repoIdentity: workspace.repoIdentity,
    canonicalPath: workspace.canonicalPath,
    gitCommonDir: workspace.gitCommonDir,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
  };
}

function errorReason(error: unknown): string {
  if (isStorageError(error)) {
    const reason = error.details?.['reason'];
    if (typeof reason === 'string') return reason;
  }
  if (error !== null && typeof error === 'object' && 'reason' in error
    && typeof (error as { reason?: unknown }).reason === 'string') {
    return (error as { reason: string }).reason;
  }
  return 'commit_unavailable';
}

function operationView(operation: GitOperationRecord): FinalizationGitOperationView {
  return {
    operationId: operation.intent.operationId,
    status: operation.status,
    expectedHead: operation.intent.expectedHead,
    candidateTree: operation.intent.candidateTree,
    actualCommit: operation.actualCommit,
    actualTree: operation.actualTree,
    deliveryStatus: operation.deliveryStatus,
    reasonCode: operation.reasonCode,
  };
}

export interface FinalizationCompletionDeps {
  readonly facts: ExecutionResumeFactsReader;
  readonly planner: {
    prepare(request: unknown): Promise<
      | { readonly status: 'eligible'; readonly plan: FinalizationRetryPlan }
      | { readonly status: 'rejected'; readonly reason: string; readonly detail: string | null }
    >;
  };
  readonly atomic: Pick<AtomicCommandStore, 'transact'>;
  readonly delivery: FinalizationDeliveryPort;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  /** 可信交付政策/身份读取；缺失时提交轴不可用（返回 commit_failed）。 */
  readonly readDeliveryConfig?: (projectId: string, featureId: string) => FinalizationDeliveryConfig | null;
  readonly nowMs?: () => number;
  readonly newOperationId?: (seed: string) => string;
}

export function createFinalizationCompletionService(deps: FinalizationCompletionDeps): FinalizationCompletionPort {
  if (deps === null || typeof deps !== 'object') throw new TypeError('FinalizationCompletion dependencies are required');
  for (const name of ['facts', 'planner', 'atomic', 'delivery', 'attempts'] as const) {
    if (deps[name] === undefined || deps[name] === null) {
      throw new TypeError(`FinalizationCompletion dependency ${name} is required`);
    }
  }
  const now = deps.nowMs ?? Date.now;
  const newOperationId = deps.newOperationId ?? computeFinalizationOperationId;

  function readFacts(projectId: string, runId: string) {
    const facts = deps.facts.readFacts({ projectId, targetKind: 'run', targetId: runId });
    return { facts, run: facts.target as RunRecord, batch: facts.batch };
  }

  function readFeature(projectId: string, featureId: string): FeatureRecord {
    return deps.atomic.transact(`${FINALIZATION_COMPLETION_OPERATION}.readFeature`, transaction =>
      transaction.getFeaturePlan(projectId, featureId).feature);
  }

  function result(
    status: FinalizationCompletionStatus,
    run: RunRecord,
    feature: { readonly status: string; readonly deliveryStatus: string | null },
    reason: string,
    extras: Partial<Pick<FinalizationCompletionResult,
      'missingSteps' | 'approval' | 'commit'>> = {},
  ): FinalizationCompletionResult {
    return {
      schemaVersion: 1,
      status,
      projectId: run.projectId,
      featureId: run.featureId,
      runId: run.id,
      batchId: run.batchId,
      reason,
      runStatus: run.status,
      featureStatus: feature.status,
      deliveryStatus: feature.deliveryStatus ?? null,
      missingSteps: extras.missingSteps ?? [],
      approval: extras.approval ?? { required: true, valid: false, approvalItemId: null, reason },
      commit: extras.commit ?? { required: false, operationId: null, status: null, deliveryStatus: null, reused: false, reason: null },
      runtimeStarts: 0,
      newAttempts: 0,
    };
  }

  function approvalAxis(plan: FinalizationRetryPlan) {
    return {
      required: true as const,
      valid: plan.approval.valid,
      approvalItemId: plan.approval.approvalItemId,
      reason: plan.approval.reason,
    };
  }

  function commitAxis(
    plan: FinalizationRetryPlan,
    operation: FinalizationGitOperationView | null,
    reused: boolean,
  ) {
    return {
      required: plan.commit.required,
      operationId: operation?.operationId ?? plan.commit.operationId,
      status: operation?.status ?? null,
      deliveryStatus: operation?.deliveryStatus ?? null,
      reused,
      reason: operation?.reasonCode ?? plan.commit.reason,
    };
  }

  function settle(
    run: RunRecord,
    featureId: string,
    outcome: 'completed' | 'partial' | 'failed' | 'awaiting_approval',
    deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed',
    reason: string,
    operationId: string | null,
  ): { readonly ok: true; readonly run: RunRecord; readonly feature: FeatureRecord } | { readonly ok: false; readonly reason: string } {
    let current: { run: RunRecord; batch: ExecutionBatchRecord; feature: FeatureRecord };
    try {
      current = deps.atomic.transact(`${FINALIZATION_COMPLETION_OPERATION}.readSettle`, transaction => {
        const plan = transaction.getFeaturePlan(run.projectId, featureId);
        return {
          run: transaction.getExecutionRun(run.projectId, run.id),
          batch: transaction.getExecutionBatch(run.projectId, run.batchId),
          feature: plan.feature,
        };
      });
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return { ok: false, reason: 'run_not_found' };
      }
      throw error;
    }
    if (TERMINAL_FEATURE_STATUSES.has(current.feature.status)
      && TERMINAL_RUN_STATUSES.has(current.run.status)
      && TERMINAL_RUN_STATUSES.has(current.batch.status)) {
      return { ok: true, run: current.run, feature: current.feature };
    }
    if (!ACTIVE_RUN_STATUSES.has(current.run.status)
      && !(outcome === 'awaiting_approval' && current.run.status === 'paused')) {
      return { ok: false, reason: `run_${current.run.status}` };
    }
    try {
      const settled = deps.atomic.transact(`${FINALIZATION_COMPLETION_OPERATION}.settle`, transaction =>
        transaction.finalizeFeatureDelivery({
          projectId: run.projectId,
          featureId,
          batchId: run.batchId,
          runId: run.id,
          expectedFeatureRevision: current.feature.revision,
          expectedRunRevision: current.run.revision,
          expectedBatchRevision: current.batch.revision,
          outcome,
          reason,
          deliveryStatus,
          operationId,
        }));
      return { ok: true, run: settled.run, feature: settled.feature };
    } catch (error) {
      if (isStorageError(error, 'conflict')) {
        return { ok: false, reason: 'control_interrupted' };
      }
      throw error;
    }
  }

  function commitRequest(
    run: RunRecord,
    plan: FinalizationRetryPlan,
    facts: ReturnType<ExecutionResumeFactsReader['readFacts']>,
    operationId: string,
  ): FinalizationCommitRequest | { readonly error: string } {
    const baseline = workspaceBaseline(facts);
    if (baseline === null) return { error: 'workspace_invalid' };
    const config = deps.readDeliveryConfig?.(run.projectId, run.featureId) ?? null;
    if (config === null) return { error: 'commit_authority_missing' };
    const attemptId = plan.tasks.map(task => task.latestAttemptId).find((id): id is string => id !== null);
    if (attemptId === undefined) return { error: 'commit_attempt_missing' };
    let attempt;
    try {
      attempt = deps.attempts.getAttempt(run.projectId, attemptId);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return { error: 'commit_attempt_missing' };
      }
      throw error;
    }
    const verificationIds = [...new Set([
      ...plan.tasks.map(task => task.latestVerificationBatchId),
      plan.finalVerification.latestBatchId,
    ].filter((id): id is string => id !== null))];
    if (verificationIds.length === 0) return { error: 'verification_evidence_missing' };
    return {
      projectId: run.projectId,
      featureId: run.featureId,
      // Git operation identity belongs to the historical Attempt/Run that owns the
      // verified evidence; the finalization Run is the control envelope, not the
      // Git operation's attempt owner.
      runId: plan.historicalRunId,
      operationId,
      expectedHead: plan.current.headCommit,
      codeDigest: plan.current.codeDigest,
      planDigest: plan.current.planDigest,
      checkPolicyDigest: plan.current.checkPolicyDigest,
      workspaceId: plan.current.workspaceId,
      workspaceRevision: plan.current.workspaceRevision,
      verificationRefs: verificationIds.map(id => ({ kind: 'verification_batch', id, digest: plan.current.codeDigest })),
      approvalRefs: plan.approval.approvalItemId === null
        ? []
        : [{ kind: 'human_approval', id: plan.approval.approvalItemId, digest: plan.current.codeDigest }],
      baseline,
      attempt: {
        attemptId: attempt.id,
        executionVersion: attempt.executionVersion,
        owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId,
      },
      message: config.message,
      gitIdentity: config.gitIdentity,
      deliveryPolicyDigest: config.deliveryPolicyDigest,
    };
  }

  async function completeFrom(
    run: RunRecord,
    plan: FinalizationRetryPlan,
    operation: FinalizationGitOperationView | null,
    reused: boolean,
    featureBefore: FeatureRecord,
  ): Promise<FinalizationCompletionResult> {
    const settled = settle(run, run.featureId, 'completed', 'succeeded', 'feature_finalized', operation?.operationId ?? null);
    if (!settled.ok) {
      return result('control_interrupted', run, featureBefore, settled.reason,
        { missingSteps: ['finalize'], approval: approvalAxis(plan), commit: commitAxis(plan, operation, reused) });
    }
    return result(operation?.status === 'no_change' ? 'no_change' : 'completed', settled.run, settled.feature,
      operation?.status === 'no_change' ? 'delivery_no_change' : 'feature_finalized', {
        missingSteps: [],
        approval: approvalAxis(plan),
        commit: commitAxis(plan, operation, reused),
      });
  }

  async function failCommit(
    run: RunRecord,
    plan: FinalizationRetryPlan,
    operation: FinalizationGitOperationView | null,
    reason: string,
    deliveryStatus: 'failed' | 'pending',
    featureBefore: FeatureRecord,
    status: FinalizationCompletionStatus = 'commit_failed',
  ): Promise<FinalizationCompletionResult> {
    const settled = settle(run, run.featureId, 'partial', deliveryStatus, reason, operation?.operationId ?? null);
    if (!settled.ok) {
      return result('control_interrupted', run, featureBefore, settled.reason,
        { missingSteps: ['commit'], approval: approvalAxis(plan), commit: commitAxis(plan, operation, false) });
    }
    return result(status, settled.run, settled.feature, reason, {
      missingSteps: ['commit'],
      approval: approvalAxis(plan),
      commit: commitAxis(plan, operation, false),
    });
  }

  return {
    async execute(raw: unknown): Promise<FinalizationCompletionResult> {
      if (!isObject(raw)) throw new TypeError('FinalizationCompletion.execute input is invalid');
      const context: ValidationContext = { operation: FINALIZATION_COMPLETION_OPERATION };
      const projectId = validateStableId(raw['projectId'], context, 'projectId');
      const runId = validateStableId(raw['runId'], context, 'runId');
      const signal = raw['signal'];
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError('FinalizationCompletion.execute signal must be an AbortSignal');
      }

      let fresh;
      try {
        fresh = readFacts(projectId, runId);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
          throw new TypeError('FinalizationCompletion.execute run not found');
        }
        throw error;
      }
      const run = fresh.run;
      const scope = readScope(run);
      const featureBefore = readFeature(projectId, run.featureId);
      if (scope === null) return result('not_finalization_run', run, featureBefore, 'not_finalization_run');
      if (run.featureId !== fresh.batch.featureId || run.batchId !== fresh.batch.id
        || scope.historicalBatchId !== run.batchId || run.purpose !== EXECUTION_RUN_PURPOSE) {
        return result('not_finalization_run', run, featureBefore, 'finalization_identity_mismatch');
      }
      if (featureBefore.status === 'completed' && run.status === 'succeeded') {
        return result('already_completed', run, featureBefore, 'already_completed');
      }
      if (signal?.aborted) {
        return result('control_interrupted', run, featureBefore, 'cancelled', { missingSteps: ['finalize'] });
      }
      if (run.status === 'paused' && !TERMINAL_FEATURE_STATUSES.has(featureBefore.status)) {
        // A paused Run only continues through explicit execution.resume; the
        // approval command itself must not trigger a commit.
        if (featureBefore.status === 'awaiting_approval') {
          return result('awaiting_approval', run, featureBefore, run.reason ?? 'approval_pending', {
            missingSteps: ['approval'],
            approval: { required: true, valid: false, approvalItemId: null, reason: run.reason ?? 'approval_pending' },
          });
        }
        return result('awaiting_resume', run, featureBefore, 'explicit_resume_required', { missingSteps: ['finalize'] });
      }
      const control = controlReason(run, fresh.batch, now());
      if (control !== null) {
        return result('control_interrupted', run, featureBefore, control, { missingSteps: ['finalize'] });
      }

      const batchBudget = evaluateBatchBudgetReservation(
        fresh.batch.budgetSnapshot.batch,
        {
          runsCreated: fresh.batch.runsCreated,
          attemptsCreated: fresh.batch.attemptsCreated,
          runtimeStarts: fresh.batch.runtimeStarts,
          noProgressRuns: fresh.batch.noProgressRuns,
        },
        now(),
      );
      const runBudget = evaluateRunBudgetReservation(run, run, now());
      if (!batchBudget.allowed || !runBudget.allowed) {
        return result('budget_exhausted', run, featureBefore, budgetReasons(batchBudget) || budgetReasons(runBudget),
          { missingSteps: ['finalize'] });
      }

      if (fresh.facts.workspace === null
        || fresh.facts.workspace.workspaceId !== scope.workspaceId
        || fresh.facts.workspace.revision !== scope.workspaceRevision) {
        return result('invalidated', run, featureBefore, 'finalization_workspace_changed', { missingSteps: ['finalize'] });
      }

      // Resolve the deterministic operation candidate before planning so a lost
      // receipt or a previously successful final commit can explain HEAD advance.
      let candidateOperationId: string;
      if (scope.commit.operationId !== null) {
        const prior = deps.delivery.readOperation(projectId, scope.commit.operationId);
        candidateOperationId = prior !== null && prior.status === 'failed'
          ? newOperationId(prior.operationId)
          : scope.commit.operationId;
      } else {
        candidateOperationId = newOperationId(run.id);
      }
      const candidateOperation = deps.delivery.readOperation(projectId, candidateOperationId);

      const plannerRequest = {
        projectId,
        featureId: run.featureId,
        historicalRunId: scope.historicalRunId,
        workKey: run.workKey,
      };
      const prepared = await deps.planner.prepare(plannerRequest);
      if (prepared.status !== 'eligible') {
        const settled = settle(run, run.featureId, 'failed', 'failed', `finalization_scope_rejected_${prepared.reason}`, null);
        if (!settled.ok) return result('control_interrupted', run, featureBefore, settled.reason);
        return result('invalidated', settled.run, settled.feature, `finalization_scope_rejected_${prepared.reason}`,
          { missingSteps: ['finalize'] });
      }
      const plan = prepared.plan;
      const expectedHead = plan.current.headCommit;
      const explainedHead = candidateOperation !== null && (
        (candidateOperation.status === 'succeeded'
          && candidateOperation.expectedHead === scope.headCommit
          && candidateOperation.actualCommit === expectedHead)
        || (candidateOperation.status === 'no_change' && candidateOperation.expectedHead === expectedHead)
        || (candidateOperation.status === 'pending' && expectedHead !== scope.headCommit)
      );
      if (!sameIdentityExceptHead(plan, scope) || (!sameIdentity(plan, scope) && !explainedHead)) {
        const settled = settle(run, run.featureId, 'failed', 'failed', 'finalization_scope_changed', plan.commit.operationId);
        if (!settled.ok) return result('control_interrupted', run, featureBefore, settled.reason);
        return result('invalidated', settled.run, settled.feature, 'finalization_scope_changed',
          { missingSteps: ['finalize'], approval: approvalAxis(plan), commit: commitAxis(plan, null, false) });
      }
      if (plan.revalidateTasks.length > 0 || plan.finalVerification.required) {
        return result('verification_required', run, featureBefore, 'finalization_verification_incomplete',
          { missingSteps: [...plan.missingSteps], approval: approvalAxis(plan), commit: commitAxis(plan, null, false) });
      }

      if (!plan.approval.valid) {
        if (run.status === 'paused') {
          return result('awaiting_approval', run, featureBefore, plan.approval.reason ?? 'approval_required',
            { missingSteps: ['approval'], approval: approvalAxis(plan), commit: commitAxis(plan, null, false) });
        }
        const settled = settle(run, run.featureId, 'awaiting_approval', 'not_requested',
          `approval_${plan.approval.reason ?? 'required'}`, null);
        if (!settled.ok) return result('control_interrupted', run, featureBefore, settled.reason);
        return result('awaiting_approval', settled.run, settled.feature, plan.approval.reason ?? 'approval_required', {
          missingSteps: ['approval'],
          approval: approvalAxis(plan),
          commit: commitAxis(plan, null, false),
        });
      }

      let existing: FinalizationGitOperationView | null = null;
      if (plan.commit.operationId !== null) {
        existing = deps.delivery.readOperation(projectId, plan.commit.operationId);
      }
      if (existing === null) existing = candidateOperation;

      if (existing !== null && (existing.status === 'succeeded' || existing.status === 'no_change')) {
        const request = commitRequest(run, plan, fresh.facts, existing.operationId);
        if ('error' in request) {
          return failCommit(run, plan, existing, request.error, 'failed', featureBefore);
        }
        let verified;
        try {
          verified = await deps.delivery.verifyOperation(request, existing.operationId);
        } catch (error) {
          return failCommit(run, plan, existing, errorReason(error), 'pending', featureBefore, 'invalidated');
        }
        if (!verified.matched) {
          return failCommit(run, plan, existing,
            verified.reasonCode ?? 'commit_facts_mismatch', 'failed', featureBefore, 'invalidated');
        }
        return completeFrom(run, plan, existing, true, featureBefore);
      }

      if (existing !== null && existing.status === 'pending') {
        const request = commitRequest(run, plan, fresh.facts, existing.operationId);
        if ('error' in request) {
          return failCommit(run, plan, existing, request.error, 'pending', featureBefore);
        }
        const reconciled = await deps.delivery.reconcile(request, existing.operationId);
        if (reconciled.outcome === 'matched') {
          return completeFrom(run, plan, operationView(reconciled.operation), true, featureBefore);
        }
        if (reconciled.outcome === 'not_executed') {
          return failCommit(run, plan, existing, 'commit_not_observed', 'pending', featureBefore, 'reconcile_required');
        }
        return failCommit(run, plan, operationView(reconciled.operation),
          reconciled.reasonCode ?? 'commit_outcome_unknown', 'pending', featureBefore, 'reconcile_required');
      }

      if (existing !== null && existing.status === 'unknown') {
        return failCommit(run, plan, existing, existing.reasonCode ?? 'commit_outcome_unknown', 'pending', featureBefore,
          'reconcile_required');
      }

      if (!plan.commit.required && plan.current.deliveryStatus === 'succeeded') {
        if (featureBefore.status === 'completed') {
          return result('already_completed', run, featureBefore, 'already_completed');
        }
        return completeFrom(run, plan, existing, existing !== null, featureBefore);
      }

      const operationId = existing !== null ? newOperationId(existing.operationId) : candidateOperationId;
      const request = commitRequest(run, plan, fresh.facts, operationId);
      if ('error' in request) {
        return failCommit(run, plan, existing, request.error, 'failed', featureBefore);
      }
      let committed: FinalizationGitOperationView;
      try {
        committed = await deps.delivery.commit(request);
      } catch (error) {
        const reason = errorReason(error);
        // A thrown commit is an unknown side effect unless the adapter proved a
        // pre-commit source/HEAD drift. Never retry it here; reconcile first.
        if (/source_changed|head_drift|index_changed|authorization_changed/.test(reason)) {
          return failCommit(run, plan, existing, reason, 'failed', featureBefore, 'invalidated');
        }
        return failCommit(run, plan, existing, reason, 'pending', featureBefore, 'reconcile_required');
      }

      if (committed.status === 'succeeded' || committed.status === 'no_change') {
        return completeFrom(run, plan, committed, false, featureBefore);
      }
      if (committed.status === 'failed') {
        return failCommit(run, plan, committed, committed.reasonCode ?? 'commit_failed', 'failed', featureBefore);
      }
      return failCommit(run, plan, committed, committed.reasonCode ?? 'commit_outcome_unknown', 'pending', featureBefore,
        'reconcile_required');
    },
  };
}
