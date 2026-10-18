/**
 * P03-9 / F-011 finalization-only Run 应用编排。
 *
 * 顺序：
 * 1. 读取 finalization Run/Batch 现场，校验 `input_snapshot.finalization` 受限
 *    scope，确认 Run/Batch 仍活动、无暂停/取消意图且未过 deadline；
 * 2. 以 F-009 只读 planner 重算当前资格/scope，要求 retryPlanDigest、代码、
 *    检查政策与工作区身份仍与创建新 Run 时一致；不一致只使本次结果失效；
 * 3. 只执行 scope 列出的 Task 重验与 Feature 全量检查；每一步都要求真实
 *    VerificationBatch/CheckResult/Artifact 证据完整，缺检查、not_run、error、
 *    inconclusive、零测试或证据缺口均不得通过；
 * 4. 检查后再次重算 scope，要求代码/检查政策/工作区未漂移且重验与最终检查
 *    不再缺失；成功只表示「可进入审批/提交」，不完成 Feature/Run；
 * 5. 失败/失效通过既有 Run outcome 结算原子写入终态，不创建新 Run/Attempt，
 *    不启动 Runtime，不覆盖取消/暂停边界。
 */
import type { ArtifactVerifyReport } from './artifact-verify.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import { isStorageError } from '../ports/errors.js';
import type { ExecutionResumeFactsReader } from '../ports/execution-resume-facts.js';
import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';
import { EXECUTION_RUN_PURPOSE } from '../ports/execution-start.js';
import { FEATURE_VERIFICATION_OPERATION } from '../ports/feature-verification.js';
import {
  FINALIZATION_EXECUTION_OPERATION,
  FINALIZATION_ONLY_RUN_KIND,
  type FinalizationExecutionPort,
  type FinalizationExecutionResult,
  type FinalizationExecutionStatus,
  type FinalizationFeatureVerificationInput,
  type FinalizationScopeSnapshot,
  type FinalizationTaskRevalidationInput,
  type FinalizationVerifier,
  type FinalizationVerificationEvidence,
} from '../ports/finalization-execution.js';
import type { FinalizationRetryPlan } from '../ports/finalization-retry.js';
import type { VerificationStore } from '../ports/verification-store.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return [...value];
}

function readScope(run: RunRecord): FinalizationScopeSnapshot | null {
  const raw = run.inputSnapshot['finalization'];
  if (!isObject(raw) || raw['schemaVersion'] !== 1 || raw['kind'] !== FINALIZATION_ONLY_RUN_KIND) return null;
  const revalidateTasks = raw['revalidateTasks'];
  const finalVerification = raw['finalVerification'];
  const codingTaskIds = raw['codingTaskIds'];
  if (!Array.isArray(revalidateTasks) || !Array.isArray(codingTaskIds) || codingTaskIds.length !== 0) return null;
  if (!isObject(finalVerification) || typeof finalVerification['required'] !== 'boolean') return null;
  const finalCheckKeys = stringArray(finalVerification['checkKeys']);
  if (finalCheckKeys === null) return null;
  const tasks: FinalizationScopeSnapshot['revalidateTasks'][number][] = [];
  for (const item of revalidateTasks) {
    if (!isObject(item) || typeof item['taskId'] !== 'string') return null;
    const checkKeys = stringArray(item['checkKeys']);
    const reasons = stringArray(item['reasons']);
    if (checkKeys === null || reasons === null) return null;
    tasks.push({ taskId: item['taskId'], checkKeys, reasons });
  }
  const retained = stringArray(raw['retainedTaskIds']);
  if (retained === null
    || typeof raw['retryPlanDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['retryPlanDigest'])
    || typeof raw['historicalRunId'] !== 'string'
    || typeof raw['historicalBatchId'] !== 'string'
    || typeof raw['historicalRunStatus'] !== 'string'
    || !Number.isSafeInteger(raw['historicalRunDispatchOrdinal'])
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
    kind: FINALIZATION_ONLY_RUN_KIND,
    retryPlanDigest: raw['retryPlanDigest'],
    historicalRunId: raw['historicalRunId'],
    historicalBatchId: raw['historicalBatchId'],
    historicalRunStatus: raw['historicalRunStatus'],
    historicalRunDispatchOrdinal: raw['historicalRunDispatchOrdinal'] as number,
    planDigest: raw['planDigest'],
    checkPolicyDigest: raw['checkPolicyDigest'],
    headCommit: raw['headCommit'],
    codeDigest: raw['codeDigest'],
    workspaceId: raw['workspaceId'],
    workspaceRevision: raw['workspaceRevision'] as number,
    retainedTaskIds: retained,
    revalidateTasks: tasks,
    finalVerification: { required: finalVerification['required'], checkKeys: finalCheckKeys },
    codingTaskIds: [],
    runtimeStarts: 0,
    newAttempts: 0,
  };
}

export interface FinalizationExecutionDeps {
  readonly facts: ExecutionResumeFactsReader;
  readonly planner: { prepare(request: unknown): Promise<
    | { readonly status: 'eligible'; readonly plan: FinalizationRetryPlan }
    | { readonly status: 'rejected'; readonly reason: string; readonly detail: string | null }
  > };
  readonly atomic: Pick<AtomicCommandStore, 'transact'>;
  readonly verification: Pick<VerificationStore, 'getVerificationBatch' | 'listCheckResults'>;
  readonly artifacts: { verifyArtifact(projectId: string, artifactId: string): Promise<ArtifactVerifyReport> };
  readonly verifier: FinalizationVerifier;
  readonly nowMs?: () => number;
}

interface Evaluation {
  readonly ok: boolean;
  readonly invalidated: boolean;
  readonly reason: string;
}

function passed(): Evaluation {
  return { ok: true, invalidated: false, reason: 'verification_passed' };
}

function failed(reason: string, invalidated = false): Evaluation {
  return { ok: false, invalidated, reason };
}

function sameIdentity(plan: FinalizationRetryPlan, scope: FinalizationScopeSnapshot): boolean {
  return plan.current.planDigest === scope.planDigest
    && plan.current.codeDigest === scope.codeDigest
    && plan.current.headCommit === scope.headCommit
    && plan.current.checkPolicyDigest === scope.checkPolicyDigest
    && plan.current.workspaceId === scope.workspaceId
    && plan.current.workspaceRevision === scope.workspaceRevision;
}

/** 只比较会扩大/改变检查范围的字段；审批/提交轴变化留给 F-012。 */
function sameVerificationScope(plan: FinalizationRetryPlan, scope: FinalizationScopeSnapshot): boolean {
  if (plan.finalVerification.required !== scope.finalVerification.required) return false;
  if (JSON.stringify(plan.finalVerification.checkKeys) !== JSON.stringify(scope.finalVerification.checkKeys)) return false;
  if (plan.revalidateTasks.length !== scope.revalidateTasks.length) return false;
  return plan.revalidateTasks.every((task, index) => {
    const stored = scope.revalidateTasks[index]!;
    return task.taskId === stored.taskId
      && JSON.stringify(task.checkKeys) === JSON.stringify(stored.checkKeys);
  });
}

export function createFinalizationExecutionService(deps: FinalizationExecutionDeps): FinalizationExecutionPort {
  if (deps === null || typeof deps !== 'object') throw new TypeError('FinalizationExecution dependencies are required');
  for (const name of ['facts', 'planner', 'atomic', 'verification', 'artifacts', 'verifier'] as const) {
    if (deps[name] === undefined || deps[name] === null) throw new TypeError(`FinalizationExecution dependency ${name} is required`);
  }
  const now = deps.nowMs ?? Date.now;

  function result(
    status: FinalizationExecutionStatus,
    run: RunRecord,
    scope: FinalizationScopeSnapshot | null,
    reason: string,
    extras: Partial<Pick<FinalizationExecutionResult,
      'missingSteps' | 'revalidatedTaskIds' | 'verification'>> = {},
  ): FinalizationExecutionResult {
    return {
      schemaVersion: 1,
      status,
      projectId: run.projectId,
      featureId: run.featureId,
      runId: run.id,
      batchId: run.batchId,
      reason,
      runStatus: run.status,
      missingSteps: extras.missingSteps ?? scope?.revalidateTasks.map(task => task.taskId) ?? [],
      revalidatedTaskIds: extras.revalidatedTaskIds ?? [],
      verification: extras.verification ?? { required: scope?.finalVerification.required ?? false, performed: false, batchId: null, status: null },
      runtimeStarts: 0,
      newAttempts: 0,
    };
  }

  function readFacts(projectId: string, runId: string) {
    const facts = deps.facts.readFacts({ projectId, targetKind: 'run', targetId: runId });
    const run = facts.target as RunRecord;
    return { facts, run, batch: facts.batch };
  }

  function controlReason(run: RunRecord, batch: ExecutionBatchRecord): string | null {
    if (run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null) return 'pause_requested';
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return `run_${run.status}`;
    if (batch.status !== 'queued' && batch.status !== 'running') return `batch_${batch.status}`;
    if (now() >= batch.deadlineAtUtcMs) return 'batch_deadline_exceeded';
    const runDeadline = run.startedAtUtcMs === null ? null : run.startedAtUtcMs + run.runTimeLimitMs;
    if (runDeadline !== null && now() >= runDeadline) return 'run_deadline_exceeded';
    return null;
  }

  function markRunFailed(
    run: RunRecord,
    code: string,
    reason: string,
    status: 'verification_failed' | 'invalidated' = 'verification_failed',
  ): FinalizationExecutionResult {
    let fresh;
    try {
      fresh = readFacts(run.projectId, run.id);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        return result('control_interrupted', run, null, 'run_not_found');
      }
      throw error;
    }
    const control = controlReason(fresh.run, fresh.batch);
    if (control !== null) {
      return result('control_interrupted', fresh.run, null, control);
    }
    const resultKey = `${FINALIZATION_EXECUTION_OPERATION}:${run.id}:${code}`.slice(0, 128);
    try {
      deps.atomic.transact(FINALIZATION_EXECUTION_OPERATION, transaction => transaction.settleExecutionRunOutcome({
        projectId: run.projectId,
        batchId: run.batchId,
        runId: run.id,
        resultKey,
        runRevision: fresh.run.revision,
        outcome: 'failed',
        reason,
        progressEvidence: null,
      }));
    } catch (error) {
      if (isStorageError(error, 'conflict')) {
        const current = readFacts(run.projectId, run.id);
        if (!ACTIVE_RUN_STATUSES.has(current.run.status)) {
          return result('control_interrupted', current.run, null, `run_${current.run.status}`);
        }
      }
      throw error;
    }
    const settled = readFacts(run.projectId, run.id).run;
    return result(status, settled, null, reason);
  }

  async function evaluateEvidence(
    projectId: string,
    featureId: string,
    scope: FinalizationScopeSnapshot,
    kind: 'task' | 'feature',
    expectedKeys: readonly string[],
    evidence: FinalizationVerificationEvidence,
  ): Promise<Evaluation> {
    if (evidence.invalidated) return failed(evidence.reason ?? 'source_changed', true);
    if (evidence.status !== 'passed') return failed(`${kind}_verification_${evidence.status}`);
    if (expectedKeys.length === 0) return failed(`${kind}_verification_plan_empty`);
    let batch;
    try {
      batch = deps.verification.getVerificationBatch(projectId, evidence.batchId);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) return failed(`${kind}_verification_batch_missing`);
      throw error;
    }
    if (batch.projectId !== projectId || batch.featureId !== featureId
      || batch.runId !== scope.historicalRunId || batch.operation !== evidence.operation) {
      return failed(`${kind}_verification_identity_mismatch`);
    }
    if (kind === 'feature' ? batch.operation !== FEATURE_VERIFICATION_OPERATION
      : batch.operation === FEATURE_VERIFICATION_OPERATION) {
      return failed(`${kind}_verification_operation_mismatch`);
    }
    if (batch.codeDigest !== scope.codeDigest || batch.policyDigest !== scope.checkPolicyDigest) {
      return failed(`${kind}_verification_identity_changed`, true);
    }
    if (batch.status !== 'passed') return failed(`${kind}_verification_${batch.status}`);
    const checks = deps.verification.listCheckResults(projectId, batch.id);
    if (checks.length !== expectedKeys.length) return failed(`${kind}_verification_evidence_incomplete`);
    const returned = new Map(evidence.checks.map(check => [check.checkKey, check]));
    if (returned.size !== evidence.checks.length) return failed(`${kind}_verification_evidence_duplicate`);
    for (const checkKey of expectedKeys) {
      const matching = checks.filter(check => check.checkKey === checkKey);
      if (matching.length !== 1) return failed(`${kind}_verification_check_missing`);
      const check = matching[0]!;
      if (check.status !== 'passed') return failed(`${kind}_verification_check_${check.status}`);
      if (check.id.length === 0 || check.outputArtifactId === null) return failed(`${kind}_verification_evidence_incomplete`);
      const observed = returned.get(checkKey);
      if (observed === undefined || observed.status !== 'passed' || observed.resultId !== check.id
        || observed.outputArtifactId !== check.outputArtifactId
        || observed.testCount === null || !Number.isSafeInteger(observed.testCount) || observed.testCount < 1) {
        return failed(`${kind}_verification_zero_tests`);
      }
      let report: ArtifactVerifyReport;
      try {
        report = await deps.artifacts.verifyArtifact(projectId, check.outputArtifactId);
      } catch {
        return failed(`${kind}_verification_artifact_unavailable`);
      }
      if (report.kind !== 'verified_ready' && report.kind !== 'recovered_ready') {
        return failed(`${kind}_verification_artifact_invalid`);
      }
    }
    return passed();
  }

  return {
    async execute(raw: unknown): Promise<FinalizationExecutionResult> {
      if (!isObject(raw)) throw new TypeError('FinalizationExecution.execute input is invalid');
      const context: ValidationContext = { operation: FINALIZATION_EXECUTION_OPERATION };
      const projectId = validateStableId(raw['projectId'], context, 'projectId');
      const runId = validateStableId(raw['runId'], context, 'runId');
      const signal = raw['signal'];
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError('FinalizationExecution.execute signal must be an AbortSignal');
      }
      let fresh;
      try {
        fresh = readFacts(projectId, runId);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
          throw new TypeError('FinalizationExecution.execute run not found');
        }
        throw error;
      }
      const run = fresh.run;
      const scope = readScope(run);
      if (scope === null) return result('not_finalization_run', run, null, 'not_finalization_run');
      if (run.featureId !== fresh.batch.featureId || run.batchId !== fresh.batch.id
        || scope.historicalBatchId !== run.batchId || run.purpose !== EXECUTION_RUN_PURPOSE) {
        return result('not_finalization_run', run, null, 'finalization_identity_mismatch');
      }
      if (scope.codingTaskIds.length !== 0 || scope.runtimeStarts !== 0 || scope.newAttempts !== 0) {
        return markRunFailed(run, 'scope_invalid', 'finalization_scope_coding_forbidden');
      }
      if (signal?.aborted) return result('control_interrupted', run, scope, 'cancelled');
      const control = controlReason(run, fresh.batch);
      if (control !== null) return result('control_interrupted', run, scope, control);
      if (fresh.facts.workspace === null
        || fresh.facts.workspace.workspaceId !== scope.workspaceId
        || fresh.facts.workspace.revision !== scope.workspaceRevision) {
        return markRunFailed(run, 'workspace_changed', 'finalization_workspace_changed', 'invalidated');
      }

      const plannerRequest = {
        projectId,
        featureId: run.featureId,
        historicalRunId: scope.historicalRunId,
        workKey: run.workKey,
      };
      const prepared = await deps.planner.prepare(plannerRequest);
      if (prepared.status !== 'eligible') {
        return markRunFailed(run, `plan_${prepared.reason}`, `finalization_scope_rejected_${prepared.reason}`);
      }
      const plan = prepared.plan;
      if (!sameIdentity(plan, scope) || !sameVerificationScope(plan, scope)) {
        return markRunFailed(run, 'scope_changed', 'finalization_scope_changed', 'invalidated');
      }
      const workspaceBaseline = isObject(run.inputSnapshot['workspaceBaseline'])
        ? run.inputSnapshot['workspaceBaseline'] as Readonly<Record<string, unknown>>
        : {};
      const deadlineUtcMs = Math.min(
        fresh.batch.deadlineAtUtcMs,
        run.startedAtUtcMs === null ? Number.MAX_SAFE_INTEGER : run.startedAtUtcMs + run.runTimeLimitMs,
      );
      const revalidatedTaskIds: string[] = [];
      let featureEvidence: FinalizationVerificationEvidence | null = null;

      for (const task of plan.revalidateTasks) {
        if (signal?.aborted) return result('control_interrupted', run, scope, 'cancelled');
        const current = readFacts(projectId, runId);
        const changed = controlReason(current.run, current.batch);
        if (changed !== null) return result('control_interrupted', current.run, scope, changed);
        const input: FinalizationTaskRevalidationInput = {
          projectId,
          featureId: run.featureId,
          finalizationRunId: run.id,
          historicalRunId: scope.historicalRunId,
          planDigest: scope.planDigest,
          checkPolicyDigest: scope.checkPolicyDigest,
          codeDigest: scope.codeDigest,
          headCommit: scope.headCommit,
          workspaceBaseline,
          checkKeys: [...task.checkKeys],
          deadlineUtcMs,
          taskId: task.taskId,
          reasons: [...task.reasons],
          ...(signal === undefined ? {} : { signal }),
        };
        let evidence: FinalizationVerificationEvidence;
        try {
          evidence = await deps.verifier.revalidateTask(input);
        } catch {
          return markRunFailed(run, 'task_verifier_error', 'finalization_task_verifier_error');
        }
        const evaluation = await evaluateEvidence(projectId, run.featureId, scope, 'task', task.checkKeys, evidence);
        if (!evaluation.ok) {
          return evaluation.invalidated
            ? markRunFailed(run, 'task_invalidated', evaluation.reason, 'invalidated')
            : markRunFailed(run, 'task_verification_failed', evaluation.reason);
        }
        revalidatedTaskIds.push(task.taskId);
      }

      if (plan.finalVerification.required) {
        if (signal?.aborted) return result('control_interrupted', run, scope, 'cancelled');
        const current = readFacts(projectId, runId);
        const changed = controlReason(current.run, current.batch);
        if (changed !== null) return result('control_interrupted', current.run, scope, changed);
        if (plan.finalVerification.checkKeys.length === 0) {
          return markRunFailed(run, 'feature_plan_empty', 'finalization_feature_verification_plan_empty');
        }
        const input: FinalizationFeatureVerificationInput = {
          projectId,
          featureId: run.featureId,
          finalizationRunId: run.id,
          historicalRunId: scope.historicalRunId,
          planDigest: scope.planDigest,
          checkPolicyDigest: scope.checkPolicyDigest,
          codeDigest: scope.codeDigest,
          headCommit: scope.headCommit,
          workspaceBaseline,
          checkKeys: [...plan.finalVerification.checkKeys],
          deadlineUtcMs,
          reasons: [...plan.finalVerification.reasons],
          ...(signal === undefined ? {} : { signal }),
        };
        try {
          featureEvidence = await deps.verifier.verifyFeature(input);
        } catch {
          return markRunFailed(run, 'feature_verifier_error', 'finalization_feature_verifier_error');
        }
        const evaluation = await evaluateEvidence(
          projectId, run.featureId, scope, 'feature', plan.finalVerification.checkKeys, featureEvidence,
        );
        if (!evaluation.ok) {
          return evaluation.invalidated
            ? markRunFailed(run, 'feature_invalidated', evaluation.reason, 'invalidated')
            : markRunFailed(run, 'feature_verification_failed', evaluation.reason);
        }
      }

      if (signal?.aborted) return result('control_interrupted', run, scope, 'cancelled');
      const after = readFacts(projectId, runId);
      const afterControl = controlReason(after.run, after.batch);
      if (afterControl !== null) return result('control_interrupted', after.run, scope, afterControl);
      const postPrepared = await deps.planner.prepare(plannerRequest);
      if (postPrepared.status !== 'eligible') {
        return markRunFailed(run, 'post_scope_rejected', `finalization_post_scope_rejected_${postPrepared.reason}`);
      }
      const postPlan = postPrepared.plan;
      if (!sameIdentity(postPlan, scope)) {
        return markRunFailed(run, 'source_changed', 'finalization_source_changed', 'invalidated');
      }
      if (postPlan.revalidateTasks.length > 0 || postPlan.finalVerification.required) {
        return markRunFailed(run, 'verification_incomplete', 'finalization_verification_incomplete');
      }
      return result('verification_passed', after.run, scope, 'finalization_verification_passed', {
        missingSteps: [...postPlan.missingSteps],
        revalidatedTaskIds,
        verification: {
          required: plan.finalVerification.required,
          performed: plan.finalVerification.required,
          batchId: featureEvidence?.batchId ?? null,
          status: featureEvidence?.status ?? null,
        },
      });
    },
  };
}

