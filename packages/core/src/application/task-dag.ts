import { StorageError } from '../ports/errors.js';
import type { TaskDagStore, TaskDagView, TaskDagReason, TaskDagResult } from '../ports/task-dag.js';
import { stableStringify, validateFeaturePlanInput } from '../ports/feature-plan.js';
import { computeExecutionWorkKey } from '../ports/execution-start.js';
import { DEFAULT_TASK_MAX_CODE_ATTEMPTS, evaluateRunBudgetReservation } from '../ports/execution-budget.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { computeExecutionStrategyCopyDigest } from '../ports/execution-input-prepare.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import { validateTaskExecutionConfig } from './task-strategy-selection.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_snapshot');
  return value as ObjectValue;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !id.length)
    || new Set(value).size !== value.length) throw new Error('invalid_scope');
  return [...value] as string[];
}
function equal(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }
function sorted(values: readonly string[]): string[] { return [...values].sort(); }

/** Stable Kahn traversal: ASCII/code-unit Task ID is the tie-breaker at every frontier. */
export function evaluateTaskDag(view: TaskDagView, nowMs: number): TaskDagResult {
  const { run, batch, plan } = view;
  const { feature } = plan;
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  const facts = new Map(view.facts.map(fact => [fact.taskId, fact]));
  let scope: string[] = [];
  const order: string[] = [];
  const dependencies = new Map<string, string[]>();
  const result = (reason: TaskDagReason, diagnostic: string | null = null,
    taskReasons?: ReadonlyMap<string, TaskDagReason>): TaskDagResult => {
    const taskIds = reason === 'invalid_graph' ? sorted(scope) : order.length ? order : sorted(scope);
    const tasks = taskIds.map(taskId => ({ taskId, reason: taskReasons?.get(taskId) ?? reason,
      dependencyIds: sorted(dependencies.get(taskId) ?? []) }));
    return { projectId: run.projectId, runId: run.id, featureId: feature.id, reason, diagnostic,
      tasks, readyTaskIds: reason === 'ready' ? tasks.filter(t => t.reason === 'ready').map(t => t.taskId) : [],
      handoff: reason === 'all_passed' ? 'feature_final_verification' : null };
  };
  let approval: ObjectValue;
  let configTasks: ObjectValue[];
  let input: ObjectValue;
  try {
    const batchScope = object(batch.scopeSnapshot);
    const config = object(batch.configSnapshot);
    input = object(run.inputSnapshot);
    approval = object(config.approval);
    if (input.schemaVersion !== 1 || batchScope.schemaVersion !== 1 || config.schemaVersion !== 1
      || !equal(ids(batchScope.featureIds), [feature.id])
      || run.scopeDigest !== batchScope.previewDigest || input.previewDigest !== run.scopeDigest
      || run.featureId !== feature.id || batch.featureId !== feature.id || batch.phaseId !== feature.phaseId
      || batch.projectId !== run.projectId || run.purpose !== 'execute') throw new Error('snapshot_mismatch');
    if (!Array.isArray(config.tasks)) throw new Error('invalid_scope');
    configTasks = config.tasks.map(object);
    scope = ids(configTasks.map(t => t.taskId));
    const codingIds = plan.tasks.filter(t => facts.get(t.id)?.kind === 'coding').map(t => t.id);
    if (!equal(sorted(scope), sorted(codingIds))) throw new Error('scope_membership_mismatch');
    if (!Array.isArray(config.permissions) || config.permissions.some(p => !/^[0-9a-f]{64}$/.test(String(object(p).digest)))
      || !equal(sorted(ids(config.permissions.map(p => object(p).taskId))), sorted(scope))) {
      throw new Error('permissions_scope_mismatch');
    }
    if (!/^[0-9a-f]{64}$/.test(String(approval.checkPolicyDigest)) || typeof approval.decisionId !== 'string') {
      throw new Error('invalid_approval_snapshot');
    }
    const pending = ids(input.pendingTaskIds);
    if (pending.some(id => !scope.includes(id)) || input.workKey !== run.workKey || input.planDigest !== approval.planDigest) {
      throw new Error('input_scope_mismatch');
    }
    for (const id of scope) {
      const task = byId.get(id);
      if (!task || task.featureId !== feature.id || task.projectId !== run.projectId) throw new Error('missing_or_cross_feature_node');
      dependencies.set(id, []);
    }
    const seenEdges = new Set<string>();
    for (const edge of plan.dependencies) {
      if (facts.get(edge.taskId)?.kind === 'planning' && facts.get(edge.dependsOnId)?.kind === 'planning') continue;
      if (!dependencies.has(edge.taskId) || !dependencies.has(edge.dependsOnId) || edge.featureId !== feature.id
        || edge.projectId !== run.projectId) throw new Error('missing_or_cross_feature_dependency');
      if (edge.taskId === edge.dependsOnId) throw new Error('self_dependency');
      const key = `${edge.taskId}\u0000${edge.dependsOnId}`;
      if (seenEdges.has(key)) throw new Error('duplicate_dependency');
      seenEdges.add(key);
      dependencies.get(edge.taskId)!.push(edge.dependsOnId);
    }
    const remaining = new Set(scope);
    while (remaining.size) {
      const next = sorted([...remaining].filter(id => dependencies.get(id)!.every(dep => !remaining.has(dep))))[0];
      if (next === undefined) throw new Error('cycle');
      order.push(next);
      remaining.delete(next);
    }
    // Recompute business identity, not just trust the mutable Feature digest column.
    const currentPlan = validateFeaturePlanInput({ schemaVersion: 1,
      feature: { title: feature.title, description: feature.description, labels: feature.labels, sourceRefs: feature.sourceRefs },
      tasks: scope.map(id => { const task = byId.get(id)!; return {
        id, title: task.title, description: task.description, labels: task.labels, complexity: task.complexity,
        acceptance: task.acceptance, requirementsRefs: task.requirementsRefs, dependsOn: dependencies.get(id),
      }; }),
    });
    if (currentPlan.planDigest !== feature.planDigest || feature.planDigest !== approval.planDigest) throw new Error('plan_snapshot_mismatch');
    const currentStrategies = scope.map(id => ({ taskId: id,
      digest: computeExecutionStrategyCopyDigest(byId.get(id)!) }));
    if (!equal([...configTasks].sort((a, b) => String(a.taskId) < String(b.taskId) ? -1 : 1),
      currentStrategies.sort((a, b) => a.taskId < b.taskId ? -1 : 1))) throw new Error('strategy_snapshot_mismatch');
    if (run.workKey !== computeExecutionWorkKey({ featureId: feature.id, purpose: run.purpose,
      planDigest: String(approval.planDigest), inputs: view.inputs.map(ref => ({ ...ref, sizeBytes: 0 })) })) {
      throw new Error('work_key_mismatch');
    }
    if (!view.inputsAvailable || !equal(input.inputs, [...view.inputs].sort((a, b) => a.artifactId < b.artifactId ? -1 : 1))) {
      throw new Error('input_snapshot_mismatch');
    }
  } catch (error) {
    return result('invalid_graph', error instanceof StorageError ? 'invalid_plan' : error instanceof Error ? error.message : 'invalid_snapshot');
  }
  if (!['queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'].includes(run.status)) return result('run_not_active');
  // P03-9 / F-001：持久暂停意图独立于当前 status/reason；意图存在即停止新认领，
  // 不因某次状态收尾（如 approval）被绕过。
  if (run.pauseRequestedAtUtcMs !== null) return result('run_control_blocked');
  if (!['queued', 'running'].includes(run.status)
    && !(run.status === 'paused' && run.reason === 'approval')) return result('run_control_blocked');
  if (!['queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'].includes(batch.status)) return result('batch_not_active');
  if (batch.pauseRequestedAtUtcMs !== null) return result('batch_control_blocked');
  if (!['queued', 'running'].includes(batch.status)) return result('batch_control_blocked');
  if (view.projectStatus !== 'active') return result('project_not_active');
  if (view.phase.status !== 'open') return result('phase_not_executable');
  const checkPolicyDigest = resolveCurrentCheckPolicyDigest(view.settings.global, view.settings.project);
  const validity = evaluatePlanApprovalValidity({ planDigest: feature.planDigest, planStatus: feature.planStatus,
    taskCount: scope.length, decisions: view.approvals, currentCheckPolicyDigest: checkPolicyDigest });
  if (!validity.valid || validity.currentDecisionId !== approval.decisionId || checkPolicyDigest !== approval.checkPolicyDigest) {
    return result('waiting_approval', !validity.valid ? validity.reason
      : validity.currentDecisionId !== approval.decisionId ? 'approval_decision_changed' : 'check_policy_changed');
  }
  const validPass = new Set(scope.filter(id => {
    const task = byId.get(id)!, fact = facts.get(id)!;
    if (task.status !== 'passed' || fact.manualBlock) return false;
    return fact.attempts.some(attempt => {
      const snapshot = attempt.inputSnapshot;
      const taskConfig = configTasks.find(t => t.taskId === id)!;
      const permissions = (object(batch.configSnapshot).permissions as unknown[]).map(object).find(p => p.taskId === id)!;
      const requiredIds = new Set([...feature.sourceRefs, ...task.requirementsRefs].map(ref => ref.artifactId));
      return attempt.status === 'succeeded' && ['verification', 'commit', 'cleanup'].includes(attempt.executionStage) && attempt.exitCode === 0
        && attempt.endedAtUtcMs !== null && attempt.codeRef !== null && attempt.executionVersion === fact.executionVersion
        && attempt.projectId === run.projectId && attempt.featureId === feature.id && attempt.taskId === id
        && snapshot.approval.planDigest === approval.planDigest && snapshot.approval.checkPolicyDigest === checkPolicyDigest
        && snapshot.approval.decisionId === approval.decisionId
        && snapshot.digests.strategyCopyDigest === taskConfig.digest && snapshot.digests.permissionsDigest === permissions.digest
        && equal(snapshot.requiredInputs.map(ref => ({ artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash }))
          .sort((a, b) => a.artifactId < b.artifactId ? -1 : 1), view.inputs.filter(ref => requiredIds.has(ref.artifactId)).sort((a, b) => a.artifactId < b.artifactId ? -1 : 1));
    });
  }));
  const reasons = new Map<string, TaskDagReason>();
  const limits = batch.budgetSnapshot.batch;
  const runBudget = evaluateRunBudgetReservation(run, run, nowMs);
  const exhausted = nowMs >= batch.deadlineAtUtcMs || batch.attemptsCreated >= limits.maxTotalAttempts
    || batch.runtimeStarts >= limits.maxRuntimeStarts || batch.noProgressRuns >= limits.maxNoProgressRuns
    || !runBudget.allowed || limits.maxCostTotal !== undefined || limits.maxTokenTotal !== undefined;
  const maxTotal = mergeEffectiveSettings({ global: view.settings.global, project: view.settings.project })
    .policies.executionLimits?.value.maxAttemptsPerTask;
  for (const id of order) {
    const task = byId.get(id)!, fact = facts.get(id)!, deps = dependencies.get(id)!;
    let reason: TaskDagReason;
    if (fact.manualBlock) reason = 'waiting_approval';
    else if (validPass.has(id)) reason = 'all_passed';
    else if (['passed', 'failed', 'skipped', 'cancelled'].includes(task.status)
      || !(input.pendingTaskIds as string[]).includes(id)) reason = 'dependency_failed';
    else if (deps.some(dep => facts.get(dep)!.manualBlock)) reason = 'waiting_approval';
    else if (deps.some(dep => !validPass.has(dep) && ['passed', 'failed', 'skipped', 'cancelled'].includes(byId.get(dep)!.status))) reason = 'dependency_failed';
    else if (deps.some(dep => !validPass.has(dep))) reason = 'dependency_pending';
    else if (view.resourceBusy || task.status === 'running') reason = 'resource_busy';
    else if (exhausted || (maxTotal !== undefined && fact.attemptCounter >= maxTotal)
      || fact.codeAttemptsUsed >= (validateTaskExecutionConfig(task.executionConfig, 'TaskDag.evaluate').maxCodeAttempts ?? DEFAULT_TASK_MAX_CODE_ATTEMPTS)) reason = 'budget_exhausted';
    else reason = 'ready';
    reasons.set(id, reason);
  }
  if ([...reasons.values()].includes('ready')) return result('ready', null, reasons);
  if (validPass.size === scope.length && !view.resourceBusy) return result('all_passed', null, reasons);
  // Stable precedence when multiple independent blockers exist.
  for (const reason of ['dependency_failed', 'waiting_approval', 'resource_busy', 'budget_exhausted', 'dependency_pending'] as const) {
    if ([...reasons.values()].includes(reason) || (reason === 'resource_busy' && view.resourceBusy)) return result(reason, null, reasons);
  }
  return result('invalid_graph', 'no_classifiable_work', reasons);
}

/**
 * P03-9 / F-008：显式 resume 的只读 DAG 预演。解除暂停意图、把可继续的
 * paused Run/Batch 视为 queued/running 后复用同一 DAG 规则；不写数据库，
 * 不创建 Attempt，也不把 paused 的 `approval`/`verification_not_assembled`
 * 特例变成绕过预算或依赖的通道。
 */
export function evaluateTaskDagAfterResume(view: TaskDagView, nowMs: number): TaskDagResult {
  return evaluateTaskDag({
    ...view,
    run: { ...view.run, status: 'queued', reason: null, pauseRequestedAtUtcMs: null },
    batch: { ...view.batch, status: 'running', reason: null, pauseRequestedAtUtcMs: null },
  }, nowMs);
}

export function createTaskDagService(options: { readonly store: TaskDagStore; readonly nowMs?: () => number }) {
  return { evaluate(projectId: unknown, runId: unknown): TaskDagResult {
    const now = (options.nowMs ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError('Invalid Task DAG clock');
    try { return evaluateTaskDag(options.store.readTaskDagView(projectId, runId), now); }
    catch (error) {
      if (error instanceof StorageError && error.operation === 'TaskDagStore.read' && error.details?.reason === 'invalid_graph'
        && error.entity?.projectId && error.entity.id && typeof error.details.featureId === 'string') {
        return { projectId: error.entity.projectId, runId: error.entity.id, featureId: error.details.featureId,
          reason: 'invalid_graph', diagnostic: 'corrupt_persisted_view', readyTaskIds: [], tasks: [], handoff: null };
      }
      throw error;
    }
  } };
}
