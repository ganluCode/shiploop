/**
 * P03-9 / F-009 显式 retryFinal 资格与受限 finalization scope 计算（application 层）。
 *
 * 编排全部只读：
 * 1. 通过既有 resume facts 读取明确历史 Run/Batch、受管 worktree 与旧占用；
 * 2. 通过 Task DAG 快照重核项目/Phase/计划批准、当前 workKey、检查政策与
 *    全局占用；通过受界 WorkspaceInspector 取得当前 HEAD/codeDigest；
 * 3. 通过 TaskEvidence/FeatureDelivery 一致读视图与 ArtifactVerifier 判定
 *    Task/最终检查/审批证据是否仍绑定当前代码、需求、策略、检查定义、环境与
 *    Artifact 完整性；
 * 4. 输出仅含最终检查/审批/提交的受限 scope。历史 passed、Run/Attempt/策略
 *    快照零改写；编码 Task、Runtime 启动与新 Attempt 恒为零。
 *
 * 关键边界：证据失效只让「相关当前证据」待重验；不会自动创建编码 Attempt。
 * 已发生或结果未知的提交只要求 reconcile，不重新提交。最终审批只认可绑定
 * 当前 planDigest + 当前代码摘要的决定，历史批准/解除阻塞不自动重跑。
 */
import type { ArtifactVerifyReport } from './artifact-verify.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import type { ExecutionResumeFactsReader } from '../ports/execution-resume-facts.js';
import {
  EXECUTION_RUN_PURPOSE,
  computeExecutionWorkKey,
} from '../ports/execution-start.js';
import {
  FINALIZATION_RETRY_OPERATION,
  type FinalizationEvidenceReason,
  type FinalizationPendingStep,
  type FinalizationRetryCheckDecision,
  type FinalizationRetryPlan,
  type FinalizationRetryRejectedReason,
  type FinalizationRetryRequest,
  type FinalizationRetryResult,
  type FinalizationRetryTaskDecision,
} from '../ports/finalization-retry.js';
import { isStorageError } from '../ports/errors.js';
import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';
import type { FeatureDeliveryQueryReadStore, FeatureDeliveryView } from '../ports/feature-delivery-query.js';
import { FEATURE_VERIFICATION_OPERATION } from '../ports/feature-verification.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';
import type { TaskApprovalItemRecord } from '../ports/plan-store.js';
import type { TaskDagStore, TaskDagView } from '../ports/task-dag.js';
import type { TaskEvidenceQueryReadStore, TaskVerificationBatchView } from '../ports/task-evidence-query.js';
import type { CheckDefinition } from '../ports/task-verification-policy.js';
import { stableStringify } from '../ports/feature-plan.js';
import { computeExecutionStrategyCopyDigest } from '../ports/execution-input-prepare.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspection, WorkspaceInspector } from '../ports/workspace-inspector.js';

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ARTIFACT_CHECK_LIMIT = 256;

function validateRequest(raw: unknown): FinalizationRetryRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('FinalizationRetry.prepare: request must be an object');
  }
  const request = raw as Record<string, unknown>;
  const allowed = new Set(['projectId', 'featureId', 'historicalRunId', 'workKey']);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) {
      throw new TypeError(`FinalizationRetry.prepare: unknown request field ${key}`);
    }
  }
  const context: ValidationContext = { operation: FINALIZATION_RETRY_OPERATION };
  return {
    projectId: validateStableId(request.projectId, context, 'projectId'),
    featureId: validateStableId(request.featureId, context, 'featureId'),
    historicalRunId: validateStableId(request.historicalRunId, context, 'historicalRunId'),
    // Shape is validated below as a retry-eligibility decision so a malformed
    // workKey is a deterministic rejection rather than an uncaught boundary error.
    workKey: typeof request.workKey === 'string' ? request.workKey : '',
  };
}

function rejected(reason: FinalizationRetryRejectedReason, detail: string | null = null): FinalizationRetryResult {
  return { status: 'rejected', reason, detail };
}

function addReason(target: Set<FinalizationEvidenceReason>, reason: FinalizationEvidenceReason): void {
  target.add(reason);
}

function sortedReasons(values: Iterable<FinalizationEvidenceReason>): FinalizationEvidenceReason[] {
  return [...values].sort();
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

function sameCheckDefinition(
  snapshot: TaskVerificationBatchView['batch']['checkSnapshot'][number],
  definition: CheckDefinition,
): boolean {
  return stableStringify({
    checkKey: snapshot.checkKey,
    scope: snapshot.scope,
    kind: snapshot.kind,
    argv: [...snapshot.argv],
    cwdRef: snapshot.cwdRef,
    environmentRef: snapshot.environmentRef,
    timeout: snapshot.timeout,
    required: snapshot.required,
    requirementRefs: [...snapshot.requirementRefs],
  }) === stableStringify({
    checkKey: definition.checkKey,
    scope: definition.scope,
    kind: definition.kind,
    argv: [...definition.argv],
    cwdRef: definition.cwdRef,
    environmentRef: definition.environmentRef,
    timeout: definition.timeout,
    required: definition.required,
    requirementRefs: [...definition.requirementRefs],
  });
}

function environmentMatches(
  summary: Readonly<Record<string, unknown>>,
  inspection: WorkspaceInspection,
  allowedHeadCommit: string | null = null,
  allowCodeDigestChange = false,
): boolean {
  const workspace = summary['workspace'];
  if (workspace === null || workspace === undefined || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return true;
  }
  const record = workspace as Record<string, unknown>;
  if (typeof record['headCommit'] === 'string' && record['headCommit'] !== inspection.repository.headCommit
    && record['headCommit'] !== allowedHeadCommit) {
    return false;
  }
  if (typeof record['codeDigest'] === 'string' && record['codeDigest'] !== inspection.codeDigest
    && !allowCodeDigestChange) {
    return false;
  }
  return true;
}

function plannedCheckKeys(definitions: readonly CheckDefinition[], fullFallbackRefs: readonly string[]): string[] {
  if (fullFallbackRefs.length > 0) return [...new Set(fullFallbackRefs)];
  return [...new Set(definitions.filter(definition => definition.required).map(definition => definition.checkKey))];
}

function latestTaskBatch(view: ReturnType<TaskEvidenceQueryReadStore['readTaskVerificationView']>): TaskVerificationBatchView | null {
  if (view === undefined) return null;
  return view.batches.find(entry => entry.batch.operation !== FEATURE_VERIFICATION_OPERATION) ?? null;
}

function approvalRefs(item: TaskApprovalItemRecord) {
  return item.decisionArtifactRefs.length > 0 ? item.decisionArtifactRefs : item.artifactRefs;
}

export interface FinalizationRetryPlannerDeps {
  readonly facts: ExecutionResumeFactsReader;
  readonly dag: TaskDagStore;
  readonly taskEvidence: TaskEvidenceQueryReadStore;
  readonly featureDelivery: FeatureDeliveryQueryReadStore;
  /** Trusted ArtifactVerifier: file-level integrity, never index-only trust. */
  readonly artifacts: {
    verifyArtifact(projectId: string, artifactId: string): Promise<ArtifactVerifyReport>;
  };
  /** Trusted bounded worktree inspector; required for every eligible retry. */
  readonly inspectorFor?: (projectId: string) => Promise<WorkspaceInspector>;
}

export interface FinalizationRetryPlanner {
  prepare(request: unknown): Promise<FinalizationRetryResult>;
}

function evidenceCheckReasons(
  checks: readonly { readonly checkKey: string; readonly status: 'valid' | 'revalidate';
    readonly reasons: readonly FinalizationEvidenceReason[] }[],
): FinalizationRetryCheckDecision[] {
  return checks.map(check => ({ checkKey: check.checkKey, status: check.status, reasons: [...check.reasons] }));
}

export function createFinalizationRetryPlanner(deps: FinalizationRetryPlannerDeps): FinalizationRetryPlanner {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('FinalizationRetryPlanner dependencies are required');
  }
  for (const name of ['facts', 'dag', 'taskEvidence', 'featureDelivery', 'artifacts'] as const) {
    if (deps[name] === null || typeof deps[name] !== 'object') {
      throw new TypeError(`FinalizationRetryPlanner dependency ${name} is required`);
    }
  }

  return {
    async prepare(raw): Promise<FinalizationRetryResult> {
      let request: FinalizationRetryRequest;
      try {
        request = validateRequest(raw);
      } catch (error) {
        if (isStorageError(error, 'validation')) return rejected('identity_mismatch');
        throw error;
      }
      if (!/^[0-9a-f]{64}$/.test(request.workKey)) return rejected('work_key_mismatch');

      let facts: ReturnType<ExecutionResumeFactsReader['readFacts']>;
      try {
        facts = deps.facts.readFacts({
          projectId: request.projectId,
          targetKind: 'run',
          targetId: request.historicalRunId,
        });
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
          return rejected('run_not_found');
        }
        throw error;
      }
      if (facts.targetKind !== 'run') return rejected('identity_mismatch');
      const run = facts.target as RunRecord;
      const batch = facts.batch as ExecutionBatchRecord;
      if (run.projectId !== request.projectId || batch.projectId !== request.projectId) {
        return rejected('run_not_found');
      }
      if (run.featureId !== request.featureId || batch.featureId !== request.featureId || run.batchId !== batch.id) {
        return rejected('identity_mismatch');
      }
      if (run.workKey !== request.workKey) return rejected('work_key_mismatch');
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return rejected('run_not_terminal');
      if (run.purpose !== EXECUTION_RUN_PURPOSE) return rejected('unsupported_run_purpose');
      if (facts.projectStatus !== 'active') return rejected('project_not_active');
      if (facts.activeAttempts.length > 0 || facts.attemptsWithLeases.length > 0
        || facts.leases.some(lease => lease.state === 'held' || lease.state === 'quarantined')) {
        return rejected('occupancy_unresolved');
      }

      let view: TaskDagView;
      try {
        view = deps.dag.readTaskDagView(request.projectId, request.historicalRunId);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
          return rejected('identity_mismatch');
        }
        throw error;
      }
      if (view.plan.feature.id !== request.featureId || view.plan.feature.projectId !== request.projectId
        || view.run.id !== request.historicalRunId) {
        return rejected('identity_mismatch');
      }
      if (view.projectStatus !== 'active') return rejected('project_not_active');
      if (view.resourceBusy) return rejected('occupancy_unresolved');
      if (view.plan.feature.planDigest === null) return rejected('authorization_invalid');

      const historicalPlanDigest = run.inputSnapshot['planDigest'];
      if (typeof historicalPlanDigest === 'string' && historicalPlanDigest !== view.plan.feature.planDigest) {
        return rejected('work_key_mismatch');
      }
      if (!view.inputsAvailable) return rejected('work_key_mismatch');
      const inputs = [...view.inputs]
        .map(ref => ({
          artifactId: ref.artifactId,
          version: ref.version,
          contentHash: ref.contentHash,
          sizeBytes: 0,
        }))
        .sort((left, right) => (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0));
      const currentWorkKey = computeExecutionWorkKey({
        featureId: request.featureId,
        purpose: run.purpose,
        planDigest: view.plan.feature.planDigest,
        inputs,
      });
      if (currentWorkKey !== request.workKey || currentWorkKey !== run.workKey) {
        return rejected('work_key_mismatch');
      }

      const checkPolicyDigest = resolveCurrentCheckPolicyDigest(view.settings.global, view.settings.project);
      const validity = evaluatePlanApprovalValidity({
        planDigest: view.plan.feature.planDigest,
        planStatus: view.plan.feature.planStatus,
        taskCount: view.plan.tasks.length,
        decisions: view.approvals,
        currentCheckPolicyDigest: checkPolicyDigest,
      });
      if (!validity.valid || view.phase.status !== 'open') return rejected('authorization_invalid');

      const managed = facts.workspace;
      if (managed === null || !['ready', 'retained'].includes(managed.status) || deps.inspectorFor === undefined) {
        return rejected('workspace_invalid');
      }
      const baseline = workspaceBaseline(facts);
      if (baseline === null) return rejected('workspace_invalid');
      let inspection: WorkspaceInspection;
      try {
        const inspector = await deps.inspectorFor(request.projectId);
        inspection = await inspector.inspect(baseline);
      } catch {
        return rejected('workspace_invalid');
      }
      if (!inspection.complete || inspection.repository.repoIdentity !== managed.repoIdentity
        || inspection.repository.canonicalPath !== managed.canonicalPath
        || inspection.repository.branch !== managed.branch) {
        return rejected('workspace_invalid');
      }
      const currentHeadCommit = inspection.repository.headCommit;
      const currentCodeDigest = inspection.codeDigest;

      let delivery: FeatureDeliveryView | undefined;
      try {
        delivery = deps.featureDelivery.readFeatureDeliveryView(request.projectId, request.featureId);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
          return rejected('identity_mismatch');
        }
        throw error;
      }
      if (delivery === undefined) return rejected('identity_mismatch');

      // F-012：已成功/待核对的交付提交会推进 HEAD，但已验证的代码摘要未变。
      // 旧检查批次的 environmentSummary 仍绑定提交前 HEAD；只有该旧 HEAD 与
      // 当前 operation 的 expectedHead 一致时才允许这条受控推进。
      const deliveryHead = delivery.gitOperation;
      const currentContentDigest = verificationCodeIdentity(inspection).codeDigest;
      const explainedHeadCommit = deliveryHead !== null && (
        (deliveryHead.status === 'succeeded' && deliveryHead.actualCommit === currentHeadCommit)
        || (deliveryHead.status === 'no_change' && deliveryHead.intent.expectedHead === currentHeadCommit)
        || (deliveryHead.status === 'pending' && deliveryHead.intent.expectedHead !== currentHeadCommit)
      ) ? deliveryHead.intent.expectedHead : null;
      // A real final commit changes Git status/HEAD but not the delivered bytes.
      // When the operation's immutable content identity still matches the current
      // workspace, pre-commit evidence and approvals remain recoverable.
      const sourceExplainedByDelivery = deliveryHead !== null
        && deliveryHead.intent.codeDigest === currentContentDigest
        && (explainedHeadCommit !== null
          || (deliveryHead.status === 'failed' && deliveryHead.intent.expectedHead === currentHeadCommit));

      const effective = mergeEffectiveSettings({
        global: view.settings.global,
        project: view.settings.project,
      });
      const verificationPolicy = effective.policies.verification?.value as
        | { readonly checkDefinitions?: readonly CheckDefinition[]; readonly fullFallback?: { readonly checkRefs: readonly string[] } }
        | undefined;
      const definitions = verificationPolicy?.checkDefinitions ?? [];
      const definitionByKey = new Map(definitions.map(definition => [definition.checkKey, definition]));
      const fullFallbackRefs = verificationPolicy?.fullFallback?.checkRefs ?? [];
      const plannedKeys = plannedCheckKeys(definitions, fullFallbackRefs);

      const verifyReady = async (artifactId: string): Promise<boolean> => {
        try {
          const report = await deps.artifacts.verifyArtifact(request.projectId, artifactId);
          return report.kind === 'verified_ready' || report.kind === 'recovered_ready';
        } catch {
          return false;
        }
      };

      const taskDecisions: FinalizationRetryTaskDecision[] = [];
      const revalidateTasks: { taskId: string; checkKeys: readonly string[]; reasons: readonly FinalizationEvidenceReason[] }[] = [];
      let artifactChecks = 0;

      for (const task of view.plan.tasks) {
        if (task.status !== 'passed') return rejected('tasks_not_passed');
        const evidenceView = deps.taskEvidence.readTaskVerificationView(request.projectId, task.id);
        if (evidenceView === undefined) return rejected('identity_mismatch');
        const latestBatch = latestTaskBatch(evidenceView);
        const latestAttempt = evidenceView.latestAttempt;
        const snapshotKeys = latestBatch === null ? [] : latestBatch.batch.checkSnapshot.map(entry => entry.checkKey);
        const candidateKeys = snapshotKeys.length > 0 ? snapshotKeys : plannedKeys;
        const globalReasons = new Set<FinalizationEvidenceReason>();
        const checkReasons = new Map<string, Set<FinalizationEvidenceReason>>();
        const addCheckReason = (checkKey: string, reason: FinalizationEvidenceReason): void => {
          const existing = checkReasons.get(checkKey) ?? new Set<FinalizationEvidenceReason>();
          existing.add(reason);
          checkReasons.set(checkKey, existing);
        };

        if (latestBatch === null) {
          addReason(globalReasons, 'verification_missing');
        } else {
          if (latestBatch.batch.status !== 'passed') addReason(globalReasons, 'verification_not_passed');
          if (latestBatch.batch.codeDigest !== currentCodeDigest && !sourceExplainedByDelivery) addReason(globalReasons, 'source_changed');
          if (!environmentMatches(latestBatch.batch.environmentSummary, inspection, explainedHeadCommit, sourceExplainedByDelivery)) {
            addReason(globalReasons, 'environment_changed');
          }
        }

        if (latestAttempt === null) {
          addReason(globalReasons, 'code_evidence_missing');
        } else {
          // P05-1 / F-005：编码批准身份只在编码快照上存在；planning 快照无批准身份，
          // 视为证据不匹配（fail-closed，不伪造比较基准）。
          if (latestAttempt.inputSnapshot.approval?.planDigest !== view.plan.feature.planDigest) {
            addReason(globalReasons, 'requirements_changed');
          }
          const currentStrategyDigest = computeExecutionStrategyCopyDigest({
            executionConfig: task.executionConfig,
            configSource: task.configSource,
            configSourceKey: task.configSourceKey,
          });
          if (currentStrategyDigest !== latestAttempt.inputSnapshot.digests.strategyCopyDigest) {
            addReason(globalReasons, 'config_changed');
          }
          const currentInputs = new Map(view.inputs.map(ref => [ref.artifactId, ref]));
          for (const ref of task.requirementsRefs) {
            const current = currentInputs.get(ref.artifactId);
            if (current === undefined
              || (ref.contentHash !== null && ref.contentHash !== undefined && ref.contentHash !== current.contentHash)) {
              addReason(globalReasons, 'requirements_changed');
            }
          }
          if (latestAttempt.codeRef === null) {
            addReason(globalReasons, 'code_evidence_missing');
          } else if (artifactChecks >= ARTIFACT_CHECK_LIMIT) {
            addReason(globalReasons, 'artifact_corrupt');
          } else {
            artifactChecks += 1;
            if (!(await verifyReady(latestAttempt.codeRef))) addReason(globalReasons, 'artifact_corrupt');
          }
        }

        for (const checkKey of candidateKeys) {
          const snapshot = latestBatch?.batch.checkSnapshot.find(entry => entry.checkKey === checkKey);
          const definition = definitionByKey.get(checkKey);
          if (snapshot === undefined
            || (definition !== undefined && !sameCheckDefinition(snapshot, definition))
            || (definition === undefined && definitions.length > 0)) {
            addCheckReason(checkKey, 'check_definition_changed');
          }
          const result = latestBatch?.checks.find(entry => entry.checkKey === checkKey);
          if (result === undefined || result.outputArtifactId === null) {
            addCheckReason(checkKey, 'artifact_missing');
          } else if (artifactChecks >= ARTIFACT_CHECK_LIMIT) {
            addCheckReason(checkKey, 'artifact_corrupt');
          } else {
            artifactChecks += 1;
            if (!(await verifyReady(result.outputArtifactId))) addCheckReason(checkKey, 'artifact_corrupt');
          }
        }

        const checks: FinalizationRetryCheckDecision[] = [];
        const retainedCheckKeys: string[] = [];
        const taskReasons = new Set<FinalizationEvidenceReason>(globalReasons);
        for (const checkKey of candidateKeys) {
          const reasons = new Set<FinalizationEvidenceReason>();
          for (const reason of globalReasons) reasons.add(reason);
          for (const reason of checkReasons.get(checkKey) ?? []) reasons.add(reason);
          const status = reasons.size === 0 ? 'valid' : 'revalidate';
          if (status === 'valid') retainedCheckKeys.push(checkKey);
          for (const reason of reasons) taskReasons.add(reason);
          checks.push({ checkKey, status, reasons: sortedReasons(reasons) });
        }
        for (const reason of checkReasons.values()) {
          for (const item of reason) taskReasons.add(item);
        }
        const evidence = taskReasons.size === 0 ? 'valid' : 'revalidate';
        const decision: FinalizationRetryTaskDecision = {
          taskId: task.id,
          taskStatus: task.status,
          evidence,
          retainedCheckKeys,
          checks: evidenceCheckReasons(checks),
          reasons: sortedReasons(taskReasons),
          latestAttemptId: latestAttempt?.id ?? null,
          latestVerificationBatchId: latestBatch?.batch.id ?? null,
        };
        taskDecisions.push(decision);
        if (evidence === 'revalidate') {
          revalidateTasks.push({
            taskId: task.id,
            checkKeys: checks.filter(check => check.status === 'revalidate').map(check => check.checkKey),
            reasons: sortedReasons(taskReasons),
          });
        }
      }

      if (taskDecisions.length === 0) return rejected('tasks_not_passed');

      const finalReasons = new Set<FinalizationEvidenceReason>();
      let finalCheckKeys = plannedKeys;
      const finalBatch = delivery.verification;
      if (finalBatch === null) {
        addReason(finalReasons, 'verification_missing');
      } else {
        finalCheckKeys = finalBatch.batch.checkSnapshot.map(entry => entry.checkKey);
        if (finalBatch.batch.status !== 'passed') addReason(finalReasons, 'verification_not_passed');
        if (finalBatch.batch.codeDigest !== currentCodeDigest && !sourceExplainedByDelivery) addReason(finalReasons, 'source_changed');
        if (!environmentMatches(finalBatch.batch.environmentSummary, inspection, explainedHeadCommit, sourceExplainedByDelivery)) {
          addReason(finalReasons, 'environment_changed');
        }
        for (const snapshot of finalBatch.batch.checkSnapshot) {
          const definition = definitionByKey.get(snapshot.checkKey);
          if ((definition !== undefined && !sameCheckDefinition(snapshot, definition))
            || (definition === undefined && definitions.length > 0)) {
            addReason(finalReasons, 'check_definition_changed');
          }
          const result = finalBatch.checks.find(entry => entry.checkKey === snapshot.checkKey);
          if (result === undefined || result.outputArtifactId === null) {
            addReason(finalReasons, 'artifact_missing');
          } else if (artifactChecks >= ARTIFACT_CHECK_LIMIT) {
            addReason(finalReasons, 'artifact_corrupt');
          } else {
            artifactChecks += 1;
            if (!(await verifyReady(result.outputArtifactId))) addReason(finalReasons, 'artifact_corrupt');
          }
        }
      }
      if (revalidateTasks.length > 0) addReason(finalReasons, 'tasks_changed');
      const finalVerificationRequired = finalReasons.size > 0;
      if (finalVerificationRequired && plannedKeys.length > 0) finalCheckKeys = plannedKeys;

      const approvalReasons = new Set<string>();
      let approvedItem: TaskApprovalItemRecord | null = null;
      let blocked = false;
      let pending = false;
      let rejectedApproval = false;
      let stale = false;
      for (const item of delivery.approvalItems) {
        const planCurrent = item.planDigest === view.plan.feature.planDigest;
        const codeCurrent = item.codeDigest === null || item.codeDigest === currentCodeDigest
          || (sourceExplainedByDelivery && item.decisionCodeDigest === item.codeDigest);
        if (!planCurrent || !codeCurrent) {
          if (item.kind === 'approval' || item.status === 'pending') stale = true;
          continue;
        }
        if (item.kind === 'block' && item.status === 'pending') {
          blocked = true;
          continue;
        }
        if (item.kind !== 'approval') continue;
        if (item.status === 'pending') {
          pending = true;
          continue;
        }
        if (item.status === 'rejected') {
          rejectedApproval = true;
          continue;
        }
        if (item.status !== 'approved'
          || (item.decisionCodeDigest !== currentCodeDigest
            && !(sourceExplainedByDelivery && item.decisionCodeDigest === item.codeDigest))) {
          stale = true;
          continue;
        }
        let refsCurrent = true;
        for (const ref of approvalRefs(item)) {
          if (artifactChecks >= ARTIFACT_CHECK_LIMIT) {
            refsCurrent = false;
            break;
          }
          artifactChecks += 1;
          if (!(await verifyReady(ref.artifactId))) {
            refsCurrent = false;
            break;
          }
        }
        if (!refsCurrent) {
          stale = true;
          continue;
        }
        if (approvedItem === null) approvedItem = item;
      }
      if (blocked) approvalReasons.add('manual_block');
      if (rejectedApproval) approvalReasons.add('approval_rejected');
      if (pending) approvalReasons.add('approval_pending');
      if (approvedItem === null && !blocked && !rejectedApproval && !pending) {
        approvalReasons.add(stale ? 'approval_identity_stale' : 'approval_required');
      }
      const approvalValid = blocked === false && rejectedApproval === false && pending === false && approvedItem !== null;
      const approvalReason = approvalValid ? null : ([...approvalReasons][0] ?? 'approval_required');

      const deliveryStatus = delivery.feature.deliveryStatus;
      const operation = delivery.gitOperation;
      let commitRequired = false;
      let reconcileRequired = false;
      let commitReason: string | null = null;
      if (deliveryStatus === 'succeeded') {
        if (operation === null || operation.status === 'succeeded') {
          commitRequired = false;
        } else {
          commitRequired = true;
          reconcileRequired = true;
          commitReason = 'delivery_state_inconsistent';
        }
      } else if (deliveryStatus === 'pending' || operation?.status === 'pending') {
        commitRequired = true;
        reconcileRequired = true;
        commitReason = 'commit_outcome_unknown';
      } else if (operation?.status === 'succeeded') {
        commitRequired = true;
        reconcileRequired = true;
        commitReason = 'delivery_state_inconsistent';
      } else {
        commitRequired = true;
        commitReason = deliveryStatus === 'failed'
          ? operation?.reasonCode ?? 'delivery_failed'
          : 'delivery_not_requested';
      }

      const missingSteps: FinalizationPendingStep[] = [];
      if (revalidateTasks.length > 0) missingSteps.push('task_revalidation');
      if (finalVerificationRequired) missingSteps.push('feature_verification');
      if (!approvalValid) missingSteps.push('approval');
      if (commitRequired) missingSteps.push(reconcileRequired ? 'reconcile_commit' : 'commit');
      if (missingSteps.length === 0 && view.plan.feature.status !== 'completed') missingSteps.push('finalize');

      if (view.plan.feature.status === 'completed' && deliveryStatus === 'succeeded' && missingSteps.length === 0) {
        return rejected('already_finalized');
      }

      const plan: FinalizationRetryPlan = {
        schemaVersion: 1,
        kind: 'finalization-retry-plan',
        projectId: request.projectId,
        featureId: request.featureId,
        historicalRunId: run.id,
        historicalBatchId: batch.id,
        workKey: request.workKey,
        historicalRunStatus: run.status,
        historicalRunDispatchOrdinal: run.dispatchOrdinal,
        current: {
          featureRevision: view.plan.feature.revision,
          featureStatus: view.plan.feature.status,
          deliveryStatus,
          planDigest: view.plan.feature.planDigest,
          checkPolicyDigest,
          headCommit: currentHeadCommit,
          codeDigest: currentCodeDigest,
          workspaceId: managed.workspaceId,
          workspaceRevision: managed.revision,
        },
        tasks: taskDecisions,
        retainedTaskIds: taskDecisions.filter(task => task.evidence === 'valid').map(task => task.taskId),
        revalidateTasks,
        finalVerification: {
          required: finalVerificationRequired,
          checkKeys: finalVerificationRequired ? [...new Set(finalCheckKeys)] : [],
          reasons: sortedReasons(finalReasons),
          latestBatchId: finalBatch?.batch.id ?? null,
        },
        approval: {
          required: true,
          valid: approvalValid,
          approvalItemId: approvedItem?.id ?? null,
          reason: approvalReason,
        },
        commit: {
          required: commitRequired,
          reconcileRequired,
          deliveryStatus,
          operationId: operation?.intent.operationId ?? null,
          reason: commitReason,
        },
        missingSteps,
        coding: { taskIds: [], runtimeStarts: 0, newAttempts: 0 },
        historicalRecordsMutated: false,
      };
      return { status: 'eligible', plan };
    },
  };
}
