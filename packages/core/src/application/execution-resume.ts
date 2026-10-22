/**
 * P03-9 / F-008 显式工作流 resume 编排（application 层）。
 *
 * 编排顺序：
 * 1. 事务外准备（只读）：读取目标 Run/Batch、同一 Batch 的 Run、受管工作区、
 *    活动/持租约 Attempt；拒绝终态/取消/仍活动/停止不确定目标；重核项目状态、
 *    计划批准与检查政策、当前 Task 策略/权限/必需输入身份、DAG 依赖与 passed
 *    证据、worktree 事实、父预算可继续与 deadline；
 * 2. 在解除暂停的只读 DAG 预演中决定本次进入的缺失步骤：coding（存在就绪
 *    Task）、final_verification（全部 Task 有效 passed，进入收尾）或 approval
 *    （仅人审/收尾缺失，不认领编码）；证据失效/依赖失败/预算耗尽一律拒绝；
 * 3. 短写事务内重核 revision、状态、占用、工作区身份、预算与授权/策略/输入
 *    摘要，原子写 queued/running、resume 事件与 completed 回执；
 * 4. 提交后只唤醒既有调度器（coding/final_verification）；resume 本身不创建
 *    Attempt、不持久化执行输入、不启动 Runtime、不重置预算或 deadline。
 *
 * 不实现 Pi SDK/native resume；新 Attempt/invocation/原生 Session 仍由既有
 * claim/执行链路生成，且与原 Session 来源分离。
 */
import { randomBytes } from 'node:crypto';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
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
  evaluateRunBudgetReservation,
} from '../ports/execution-budget.js';
import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';
import type {
  ExecutionResumeCommandIdentity,
  ExecutionResumeEnvelopeFace,
  ExecutionResumePort,
  ExecutionResumeRejectedReason,
  ExecutionResumeScope,
  PreparedExecutionResume,
  PreparedExecutionResumeReady,
} from '../ports/execution-resume.js';
import { EXECUTION_RESUME_OPERATION } from '../ports/execution-resume.js';
import type {
  ExecutionResumeFacts,
  ExecutionResumeFactsReader,
  ExecutionResumeWorkspaceFacts,
} from '../ports/execution-resume-facts.js';
import type { ExecutionPermissionsReader } from '../ports/execution-input-prepare.js';
import {
  computeExecutionPermissionsDigest,
  computeExecutionStrategyCopyDigest,
} from '../ports/execution-input-prepare.js';
import type { ExecutionPreviewInputRefSummary } from '../ports/execution-preview.js';
import { stableStringify } from '../ports/feature-plan.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import type { FeaturePlanSnapshot } from '../ports/plan-store.js';
import type { PlanArtifactRef } from '../ports/feature-plan.js';
import type { TaskDagResult, TaskDagStore, TaskDagView } from '../ports/task-dag.js';
import type { WorkspaceInspector } from '../ports/workspace-inspector.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import { evaluateTaskDagAfterResume } from './task-dag.js';
import { isFinalizationOnlyRun } from '../ports/finalization-execution.js';
import { enqueueAuthorizedRunInTransaction } from './execution-dispatch.js';

const OPERATION = EXECUTION_RESUME_OPERATION;

function publicError(
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'resource_busy' | 'corrupt_state' | 'internal',
  reason: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PublicError {
  return new PublicError(code, OPERATION, undefined, {
    details: { reason, ...(details ?? {}) },
    ...(cause !== undefined ? { cause } : {}),
  });
}

export interface ExecutionResumeServiceDeps {
  readonly facts: ExecutionResumeFactsReader;
  readonly dag: Pick<TaskDagStore, 'readTaskDagView'>;
  readonly attempts: Pick<AttemptStore, 'listTaskAttempts' | 'listWorkspaceLeases' | 'getAttempt'>;
  /** Trusted, bounded worktree inspection. Required when a managed workspace exists. */
  readonly inspectorFor?: (projectId: string) => Promise<WorkspaceInspector>;
  /** Trusted synchronous permissions face reader (same assembly as claim/start). */
  readonly permissions: ExecutionPermissionsReader;
  /** Trusted startup gate, invoked in the committing transaction. */
  readonly assertCanResume?: () => void;
  readonly nowMs?: () => number;
}

function asRun(facts: ExecutionResumeFacts): RunRecord {
  return facts.target as RunRecord;
}
function asBatch(facts: ExecutionResumeFacts): ExecutionBatchRecord {
  return facts.target as ExecutionBatchRecord;
}

function isTerminalStatus(status: string): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function rejectReasonForDag(result: TaskDagResult, view: TaskDagView): ExecutionResumeRejectedReason | null {
  const passedWithoutEvidence = view.plan.tasks
    .filter(task => task.status === 'passed')
    .some(task => result.tasks.find(entry => entry.taskId === task.id)?.reason !== 'all_passed');
  if (passedWithoutEvidence) return 'evidence_invalid';
  switch (result.reason) {
    case 'ready':
    case 'all_passed':
    case 'waiting_approval':
      return null;
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'resource_busy':
      return 'occupancy_unresolved';
    case 'dependency_failed':
      return 'dependency_blocked';
    case 'dependency_pending':
      return 'dependency_blocked';
    case 'invalid_graph':
      return 'resume_stale';
    case 'project_not_active':
      return 'authorization_invalid';
    case 'phase_not_executable':
      return 'resume_stale';
    case 'run_not_active':
    case 'run_control_blocked':
    case 'batch_not_active':
    case 'batch_control_blocked':
      return 'not_resumable';
    default:
      return 'resume_stale';
  }
}

function scopeForDag(result: TaskDagResult): { scope: ExecutionResumeScope; nextTaskIds: readonly string[] } {
  if (result.reason === 'all_passed') return { scope: 'final_verification', nextTaskIds: [] };
  if (result.reason === 'waiting_approval') return { scope: 'approval', nextTaskIds: [] };
  return { scope: 'coding', nextTaskIds: [...result.readyTaskIds] };
}

function sortedTaskDigests(view: TaskDagView): { taskId: string; digest: string }[] {
  return [...view.plan.tasks]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(task => ({
      taskId: task.id,
      digest: computeExecutionStrategyCopyDigest({
        executionConfig: task.executionConfig,
        configSource: task.configSource,
        configSourceKey: task.configSourceKey,
      }),
    }));
}

function permissionDigests(
  reader: ExecutionPermissionsReader,
  projectId: string,
  view: TaskDagView,
): { taskId: string; digest: string }[] {
  return [...view.plan.tasks]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(task => ({
      taskId: task.id,
      digest: computeExecutionPermissionsDigest(
        reader({ projectId, featureId: task.featureId, taskId: task.id }).grants,
      ),
    }));
}

function inputSummaries(view: TaskDagView): ExecutionPreviewInputRefSummary[] {
  return [...view.inputs]
    .map(ref => ({
      artifactId: ref.artifactId,
      version: ref.version,
      contentHash: ref.contentHash,
      sizeBytes: 0,
    }))
    .sort((left, right) => (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0));
}

function resumeDigest(view: TaskDagView, decisions: TaskDagView['approvals'], checkPolicyDigest: string,
  tasks: readonly { taskId: string; digest: string }[], permissions: readonly { taskId: string; digest: string }[],
  inputs: readonly ExecutionPreviewInputRefSummary[]): string {
  const validity = evaluatePlanApprovalValidity({
    planDigest: view.plan.feature.planDigest,
    planStatus: view.plan.feature.planStatus,
    taskCount: view.plan.tasks.length,
    decisions,
    currentCheckPolicyDigest: checkPolicyDigest,
  });
  return stableStringify({
    planDigest: view.plan.feature.planDigest,
    checkPolicyDigest,
    decisionId: validity.currentDecisionId,
    planStatus: view.plan.feature.planStatus,
    tasks,
    permissions,
    inputs: inputs.map(ref => ({ artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash })),
  });
}

function workspaceBase(facts: ExecutionResumeWorkspaceFacts) {
  return {
    repositoryBindingId: facts.repositoryBindingId,
    repositoryBindingRevision: facts.repositoryBindingRevision,
    repoIdentity: facts.repoIdentity,
    canonicalPath: facts.canonicalPath,
    gitCommonDir: facts.gitCommonDir,
    branch: facts.branch,
    baseCommit: facts.baseCommit,
  };
}

export function createExecutionResumeService(deps: ExecutionResumeServiceDeps): ExecutionResumePort {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('ExecutionResume dependencies are required');
  }
  for (const name of ['facts', 'dag', 'attempts', 'permissions'] as const) {
    if (deps[name] === null || typeof deps[name] !== 'object' && typeof deps[name] !== 'function') {
      throw new TypeError(`ExecutionResume dependency ${name} is required`);
    }
  }
  const now = deps.nowMs ?? Date.now;

  async function prepareExecutionResume(
    projectId: string,
    payload: ExecutionResumeEnvelopeFace['payload'],
  ): Promise<PreparedExecutionResume> {
    const targetKind = payload.runId !== null ? 'run' : 'batch';
    const targetId = payload.runId ?? payload.batchId!;
    const notResumable = (reason: ExecutionResumeRejectedReason): PreparedExecutionResume => ({
      kind: 'not_resumable', reason, targetKind, targetId,
    });
    let facts: ExecutionResumeFacts;
    try {
      facts = deps.facts.readFacts({ projectId, targetKind, targetId });
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) return notResumable('not_resumable');
      throw error;
    }
    if (facts.projectStatus !== 'active') return notResumable('authorization_invalid');
    const batch = facts.batch;
    if (isTerminalStatus(batch.status)) return notResumable('already_terminal');
    if (batch.status === 'cancelling') return notResumable('cancelled_not_resumable');
    if (batch.status === 'interrupted') return notResumable('recovery_unsafe');
    if (batch.status === 'pausing') return notResumable('occupancy_unresolved');

    let run: RunRecord;
    if (targetKind === 'run') {
      run = asRun(facts);
      if (isTerminalStatus(run.status)) return notResumable('already_terminal');
      if (run.status === 'cancelling') return notResumable('cancelled_not_resumable');
      if (run.status === 'interrupted') return notResumable('recovery_unsafe');
      if (run.status === 'pausing') return notResumable('occupancy_unresolved');
      if (run.status !== 'paused') return notResumable('not_resumable');
      // Run 级 resume 允许父 Batch 仍 queued/running；若 Batch 本身已暂停，
      // 同一事务一并解除，避免出现 Batch 暂停但 Run 可调度的矛盾状态。
      if (!['queued', 'running', 'paused'].includes(batch.status)) return notResumable('not_resumable');
    } else {
      if (batch.status !== 'paused') return notResumable('not_resumable');
      const paused = facts.runs.filter(candidate => candidate.status !== 'succeeded'
        && candidate.status !== 'failed' && candidate.status !== 'cancelled');
      if (paused.length !== 1 || paused[0]!.status !== 'paused') return notResumable('not_resumable');
      run = paused[0]!;
    }

    if (facts.activeAttempts.length > 0 || facts.attemptsWithLeases.length > 0 ||
        facts.leases.some(lease => lease.state === 'held' || lease.state === 'quarantined')) {
      return notResumable('occupancy_unresolved');
    }
    const nowMs = now();
    const batchBudget = evaluateBatchBudgetReservation(
      batch.budgetSnapshot.batch,
      {
        runsCreated: batch.runsCreated,
        attemptsCreated: batch.attemptsCreated,
        runtimeStarts: batch.runtimeStarts,
        noProgressRuns: batch.noProgressRuns,
      },
      nowMs,
    );
    const runBudget = evaluateRunBudgetReservation(run, run, nowMs);
    if (!batchBudget.allowed || !runBudget.allowed) return notResumable('budget_exhausted');

    let view: TaskDagView;
    try {
      view = deps.dag.readTaskDagView(projectId, run.id);
    } catch (error) {
      if (isStorageError(error)) return notResumable('resume_stale');
      throw error;
    }
    const checkPolicyDigest = resolveCurrentCheckPolicyDigest(view.settings.global, view.settings.project);
    const validity = evaluatePlanApprovalValidity({
      planDigest: view.plan.feature.planDigest,
      planStatus: view.plan.feature.planStatus,
      taskCount: view.plan.tasks.length,
      decisions: view.approvals,
      currentCheckPolicyDigest: checkPolicyDigest,
    });
    if (!validity.valid || view.phase.status !== 'open') return notResumable('authorization_invalid');
    // P03-9 / F-012：finalization-only Run 的 input/config scope 刻意不含编码
    // Task，不能走编码 DAG 预演。它只重新核对全 Task passed、计划授权、检查
    // 政策、工作区与预算；审批/代码/Git operation 仍由 F-012 完成编排重核。
    const finalizationOnly = isFinalizationOnlyRun(run);
    if (finalizationOnly
      && (view.plan.tasks.length === 0 || view.plan.tasks.some(task => task.status !== 'passed'))) {
      return notResumable('evidence_invalid');
    }
    const dag = finalizationOnly ? null : evaluateTaskDagAfterResume(view, nowMs);
    if (dag !== null) {
      const rejected = rejectReasonForDag(dag, view);
      if (rejected !== null) return notResumable(rejected);
    }

    const strategies = sortedTaskDigests(view);
    const permissions = permissionDigests(deps.permissions, projectId, view);
    const inputs = inputSummaries(view);

    let workspace: PreparedExecutionResumeReady['workspace'] = null;
    let observedHeadCommit: string | null = null;
    if (facts.workspace !== null) {
      const managed = facts.workspace;
      if (!['ready', 'retained'].includes(managed.status)) return notResumable('workspace_invalid');
      if (deps.inspectorFor === undefined) return notResumable('workspace_invalid');
      let inspection;
      try {
        const inspector = await deps.inspectorFor(projectId);
        inspection = await inspector.inspect(workspaceBase(managed));
      } catch {
        return notResumable('workspace_invalid');
      }
      if (!inspection.complete || inspection.repository.repoIdentity !== managed.repoIdentity
        || inspection.repository.branch !== managed.branch
        || inspection.repository.canonicalPath !== managed.canonicalPath) {
        return notResumable('workspace_invalid');
      }
      workspace = {
        workspaceId: managed.workspaceId,
        revision: managed.revision,
        codeDigest: inspection.codeDigest,
      };
      observedHeadCommit = inspection.repository.headCommit;
    } else {
      // 从未启动的首次执行没有工作区是合法的；已有历史 Attempt 却没有工作区
      // 说明原现场丢失，不能用新 Session 绕过。
      const hasHistory = view.plan.tasks.some(task => deps.attempts.listTaskAttempts(projectId, task.id).length > 0);
      if (hasHistory) return notResumable('workspace_invalid');
    }

    const digest = resumeDigest(view, view.approvals, checkPolicyDigest, strategies, permissions, inputs);
    const scope = dag === null ? { scope: 'approval' as const, nextTaskIds: [] } : scopeForDag(dag);
    return {
      kind: 'ready',
      projectId,
      targetKind,
      targetId,
      expectedRevision: targetKind === 'run' ? run.revision : batch.revision,
      batchId: batch.id,
      featureId: batch.featureId,
      runId: run.id,
      resumeScope: scope.scope,
      nextTaskIds: scope.nextTaskIds,
      resumeDigest: digest,
      workspace,
      observedHeadCommit,
    };
  }

  function transactionResumeDigest(
    projectId: string,
    prepared: PreparedExecutionResumeReady,
    snapshot: FeaturePlanSnapshot,
    decisions: TaskDagView['approvals'],
    checkPolicyDigest: string,
    transaction: CommandTransaction,
  ): { digest: string; taskStrategies: readonly { taskId: string; digest: string }[]; permissions: readonly { taskId: string; digest: string }[]; inputs: readonly ExecutionPreviewInputRefSummary[] } {
    const taskStrategies = [...snapshot.tasks]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(task => ({
        taskId: task.id,
        digest: computeExecutionStrategyCopyDigest({
          executionConfig: task.executionConfig,
          configSource: task.configSource,
          configSourceKey: task.configSourceKey,
        }),
      }));
    const permissions = [...snapshot.tasks]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(task => ({
        taskId: task.id,
        digest: computeExecutionPermissionsDigest(
          deps.permissions({ projectId, featureId: task.featureId, taskId: task.id }).grants,
        ),
      }));
    const declaredRefs = new Map<string, PlanArtifactRef>();
    for (const ref of [...snapshot.feature.sourceRefs, ...snapshot.tasks.flatMap(task => [...task.requirementsRefs])]) {
      declaredRefs.set(`${ref.artifactId}\u0000${ref.contentHash ?? ''}`, ref);
    }
    const inputs: ExecutionPreviewInputRefSummary[] = [];
    for (const ref of Array.from(declaredRefs.values()).sort((left, right) =>
      left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
    )) {
      const inputRef = transaction.getArtifactInputRef(projectId, ref.artifactId);
      if (ref.contentHash !== null && ref.contentHash !== undefined && ref.contentHash !== inputRef.contentHash) {
        return { digest: 'stale', taskStrategies, permissions, inputs };
      }
      inputs.push({
        artifactId: inputRef.artifactId,
        version: inputRef.version,
        contentHash: inputRef.contentHash,
        sizeBytes: inputRef.sizeBytes,
      });
    }
    return {
      digest: resumeDigest(
        { plan: snapshot } as unknown as TaskDagView,
        decisions,
        checkPolicyDigest,
        taskStrategies,
        permissions,
        inputs,
      ),
      taskStrategies,
      permissions,
      inputs,
    };
  }

  function targetStatus(transaction: CommandTransaction, prepared: PreparedExecutionResumeReady): string {
    if (prepared.targetKind === 'run') return transaction.getExecutionRun(prepared.projectId, prepared.targetId).status;
    return transaction.getExecutionBatch(prepared.projectId, prepared.targetId).status;
  }

  function targetRevision(transaction: CommandTransaction, prepared: PreparedExecutionResumeReady): number {
    if (prepared.targetKind === 'run') return transaction.getExecutionRun(prepared.projectId, prepared.targetId).revision;
    return transaction.getExecutionBatch(prepared.projectId, prepared.targetId).revision;
  }

  return {
    prepareExecutionResume,

    submitExecutionResume(
      identity: ExecutionResumeCommandIdentity,
      envelope: ExecutionResumeEnvelopeFace,
      transaction: CommandTransaction,
      prepared: PreparedExecutionResume,
    ): CommandReceipt {
      deps.assertCanResume?.();
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
      const rejected = (reason: ExecutionResumeRejectedReason): CommandReceipt => {
        const receipt = createRejectedReceipt({
          ...receiptIdentity,
          error: new PublicError('conflict', OPERATION, undefined, { details: { reason } }),
        });
        transaction.saveReceipt(receipt);
        return receipt;
      };
      if (prepared.kind === 'not_resumable') return rejected(prepared.reason);
      deps.assertCanResume?.();
      if (prepared.targetKind === 'run' && envelope.payload.runId !== prepared.targetId) return rejected('not_resumable');
      if (prepared.targetKind === 'batch' && envelope.payload.batchId !== prepared.targetId) return rejected('not_resumable');
      const project = transaction.getProject(projectId);
      if (project.status !== 'active') return rejected('authorization_invalid');
      let currentRevision: number;
      let currentStatus: string;
      try {
        currentRevision = targetRevision(transaction, prepared);
        currentStatus = targetStatus(transaction, prepared);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) return rejected('not_resumable');
        throw error;
      }
      if (currentRevision !== prepared.expectedRevision || envelope.expectedRevision !== prepared.expectedRevision) {
        return rejected('stale_revision');
      }
      if (isTerminalStatus(currentStatus)) return rejected('already_terminal');
      if (currentStatus === 'cancelling') return rejected('cancelled_not_resumable');
      if (currentStatus === 'interrupted') return rejected('recovery_unsafe');
      if (currentStatus !== 'paused') return rejected('not_resumable');

      const batch = transaction.getExecutionBatch(projectId, prepared.batchId);
      if (!['queued', 'running', 'paused'].includes(batch.status)) return rejected('not_resumable');
      if (prepared.targetKind === 'batch' && batch.status !== 'paused') return rejected('not_resumable');
      const run = transaction.getExecutionRun(projectId, prepared.runId);
      const nowMs = now();
      if (!evaluateBatchBudgetReservation(batch.budgetSnapshot.batch, {
        runsCreated: batch.runsCreated,
        attemptsCreated: batch.attemptsCreated,
        runtimeStarts: batch.runtimeStarts,
        noProgressRuns: batch.noProgressRuns,
      }, nowMs).allowed || !evaluateRunBudgetReservation(run, run, nowMs).allowed) {
        return rejected('budget_exhausted');
      }

      const snapshot = transaction.getFeaturePlan(projectId, prepared.featureId);
      const decisions = transaction.listPlanApprovals(projectId, prepared.featureId);
      const globalSettings = transaction.getGlobalSettingsOrNull();
      const projectSettings = transaction.getProjectSettingsOrNull(projectId);
      const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
        globalSettings === null ? null : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
        projectSettings === null ? null : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
      );
      const validity = evaluatePlanApprovalValidity({
        planDigest: snapshot.feature.planDigest,
        planStatus: snapshot.feature.planStatus,
        taskCount: snapshot.tasks.length,
        decisions,
        currentCheckPolicyDigest: checkPolicyDigest,
      });
      const phase = transaction.getPhase(projectId, snapshot.feature.phaseId);
      if (!validity.valid || snapshot.feature.planDigest === null || phase.status !== 'open') {
        return rejected('authorization_invalid');
      }
      const identityCheck = transactionResumeDigest(projectId, prepared, snapshot, decisions, checkPolicyDigest, transaction);
      if (identityCheck.digest !== prepared.resumeDigest) return rejected('resume_stale');

      let result;
      try {
        result = transaction.resumeExecution({
          projectId,
          targetKind: prepared.targetKind,
          targetId: prepared.targetId,
          expectedRevision: prepared.expectedRevision,
          workspace: prepared.workspace === null
            ? null
            : { workspaceId: prepared.workspace.workspaceId, revision: prepared.workspace.revision },
        });
      } catch (error) {
        if (isStorageError(error, 'conflict')) {
          const reason = typeof error.details?.reason === 'string' ? error.details.reason : '';
          if (reason === 'stale_revision') return rejected('stale_revision');
          if (reason === 'occupancy_unresolved') return rejected('occupancy_unresolved');
          if (reason === 'resume_workspace_changed') return rejected('workspace_invalid');
          if (reason === 'not_resumable') return rejected('not_resumable');
        }
        throw error;
      }
      if (result.outcome === 'already_terminal') return rejected('already_terminal');

      /* P04-9 / F-002：解除暂停即恢复执行意图。同一短写事务内为每个被恢复的
       * Run 登记/复用入队意图（已有意图复用原身份，不新增 Run/Attempt/预算/
       * 事件）；入队本身不启动 Runtime，唤醒仍在提交后由窄端口 best-effort。 */
      const dispatchIntents = result.runIds.map((runId) =>
        enqueueAuthorizedRunInTransaction(transaction, {
          projectId,
          runId,
          source: 'resume',
          reason: null,
        }),
      );

      const receipt = createCompletedReceipt({
        ...receiptIdentity,
        resultRef: createResultRef(randomBytes(32)),
        result: {
          schemaVersion: 1,
          resumed: true,
          targetKind: result.targetKind,
          targetId: result.targetId,
          batchId: result.batchId,
          featureId: result.featureId,
          runIds: [...result.runIds],
          status: result.status,
          revision: result.revision,
          resumeScope: prepared.resumeScope,
          nextTaskIds: [...prepared.nextTaskIds],
          observedHeadCommit: prepared.observedHeadCommit,
          runtimeStarts: 0,
          attemptsCreated: 0,
          dispatchIntentIds: dispatchIntents.map((entry) => entry.intent.id),
        },
      });
      transaction.saveReceipt(receipt);
      return receipt;
    },
  };
}

/** 提交后唤醒：仅新提交且缺失步骤仍在调度范围时通知；resume 不启动 Runtime。 */
export function signalExecutionResumeAfterCommit(
  signal: { signalRunDispatched(input: { projectId: string; batchId: string; runId: string; featureId: string }): void } | undefined,
  receipt: CommandReceipt,
): void {
  if (signal === undefined || receipt.replayed || receipt.status !== 'completed' || !('result' in receipt)) return;
  if (receipt.operation !== OPERATION || receipt.scope.kind !== 'project') return;
  const result = receipt.result as Record<string, unknown>;
  if (result.resumeScope !== 'coding' && result.resumeScope !== 'final_verification') return;
  const projectId = receipt.scope.projectId;
  const batchId = result.batchId;
  const featureId = result.featureId;
  const runIds = result.runIds;
  if (typeof batchId !== 'string' || typeof featureId !== 'string' || !Array.isArray(runIds)) return;
  for (const value of runIds) {
    if (typeof value !== 'string') continue;
    try {
      signal.signalRunDispatched({ projectId, batchId, runId: value, featureId });
    } catch {
      // 唤醒丢失/失败：持久 queued/active 状态可由扫描补偿，不回滚已提交事务。
    }
  }
}
