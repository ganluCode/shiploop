/** Todo demo planning/approval/start protocol. CLI is the sole product write boundary.
 * This module is also used with an in-memory transport for unit checks; those are
 * protocol checks, never evidence that a model generated a plan or delivered code.
 */
import { createHash } from 'node:crypto';
import { validateExecutionBudgetProposal } from '../../packages/core/src/ports/execution-budget.ts';
import { computeExecutionStrategyCopyDigest } from '../../packages/core/src/ports/execution-input-prepare.ts';
import { validateFeaturePlanInput as validateFeaturePlan } from '../../packages/core/src/ports/feature-plan.ts';
import { validateTodoDemoRequirements, validateTodoTaskPlan, findMachineDependencyHints } from './p08-todo-requirements.ts';

type JsonObject = Record<string, unknown>;
export class TodoPlanningError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function requireFact(fact: unknown, reason: string): asserts fact {
  if (!fact) throw new TodoPlanningError(reason);
}
function object(value: unknown): JsonObject {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_cli_shape');
  return value as JsonObject;
}
function text(value: unknown): string {
  requireFact(typeof value === 'string' && value.trim().length > 0, 'missing_identity');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function todoDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function digest(value: unknown): string {
  requireFact(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid_digest');
  return value;
}
function commandId(snapshotDigest: string, action: string): string {
  const hex = todoDigest({ snapshotDigest, action });
  // Stable UUID v4 shape; the identity is deterministic for an immutable demo.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export interface TodoPlanningOptions {
  readonly requirementsText: string;
  readonly requirementArtifactId: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly revision: number;
  readonly route: { readonly runtime: string; readonly provider: string; readonly model: string };
  readonly planningBudget: unknown;
  readonly executionBudget: unknown;
  readonly taskLimit: number;
}
export function createTodoPlanningSnapshot(options: TodoPlanningOptions) {
  const requirements = validateTodoDemoRequirements(JSON.parse(options.requirementsText));
  for (const id of [options.requirementArtifactId, options.phaseId, options.featureId]) {
    requireFact(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id), 'invalid_scope');
  }
  requireFact(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.projectId), 'invalid_project');
  requireFact(Number.isSafeInteger(options.revision) && options.revision >= 1, 'invalid_revision');
  requireFact(Number.isSafeInteger(options.taskLimit) && options.taskLimit >= 3 && options.taskLimit <= 100, 'invalid_task_limit');
  requireFact(options.route.runtime === 'pi', 'real_pi_required');
  const route = { runtime: 'pi', provider: text(options.route.provider), model: text(options.route.model) };
  const context = { operation: 'TodoPlanning.prepare' };
  const planningBudget = validateExecutionBudgetProposal(options.planningBudget, context);
  const executionBudget = validateExecutionBudgetProposal(options.executionBudget, context);
  requireFact(planningBudget.batch.maxRuns === 1 && executionBudget.batch.maxRuns === 1, 'single_run_required');
  const requirementsHash = createHash('sha256').update(options.requirementsText, 'utf8').digest('hex');
  const planningInput = {
    requirementRefs: [{ artifactId: options.requirementArtifactId, contentHash: requirementsHash }],
    constraints: [
      `仅规划 Feature ${options.featureId} 的 Todo CLI，不新增其他 Phase/Feature。`,
      '至少三个 Task 构成依赖链；所有 Task 和 Feature 来源只引用本次冻结需求及其 contentHash。',
      '覆盖新增、列表、完成、删除、跨进程持久化和全部失败行为；只在临时项目 data 目录存数据。',
      '不做发布、push/PR、Web/Electron、Chat、其他 Runtime；不能用模型 completed 替代检查。',
    ],
    acceptance: { criteria: requirements.behaviors.map(b => `${b.category}: ${b.summary}；${b.observable.join('；')}`) },
    strategy: { approvalMode: 'manual' as const, taskLimit: options.taskLimit },
    budget: planningBudget,
  };
  const content = {
    schemaVersion: 1 as const, projectId: options.projectId, phaseId: options.phaseId, featureId: options.featureId,
    revision: options.revision, requirementsText: options.requirementsText, requirementsHash,
    route, planningInput, executionBudget,
  };
  requireFact(findMachineDependencyHints(content).length === 0, 'unsafe_snapshot');
  const snapshotDigest = todoDigest(content);
  return { ...content, snapshotDigest, commandIds: {
    plan: commandId(snapshotDigest, 'plan'), approve: commandId(snapshotDigest, 'approve'),
    start: commandId(snapshotDigest, 'start'),
  } };
}
export type TodoPlanningSnapshot = ReturnType<typeof createTodoPlanningSnapshot>;

export function reviewTodoCandidate(snapshot: TodoPlanningSnapshot, value: unknown) {
  const view = object(value);
  requireFact(view.projectId === snapshot.projectId && view.featureId === snapshot.featureId, 'candidate_scope_mismatch');
  requireFact(view.runStatus === 'succeeded', 'planning_not_succeeded');
  const candidate = object(view.candidate);
  const rawPlan = object(candidate.plan);
  // CLI's validated plan has additional derived fields; validate its semantic fields again.
  let plan: ReturnType<typeof validateFeaturePlan>;
  try { plan = validateFeaturePlan({ schemaVersion: 1, feature: rawPlan.feature, tasks: rawPlan.tasks }); }
  catch { throw new TodoPlanningError('invalid_candidate_plan'); }
  requireFact(plan.taskCount <= snapshot.planningInput.strategy.taskLimit, 'task_limit_exceeded');
  let dag: ReturnType<typeof validateTodoTaskPlan>;
  try { dag = validateTodoTaskPlan(plan.tasks); }
  catch { throw new TodoPlanningError('invalid_candidate_dag'); }
  const ref = snapshot.planningInput.requirementRefs[0];
  const within = (refs: readonly { artifactId: string; contentHash?: string }[]) =>
    refs.length === 1 && refs[0].artifactId === ref.artifactId && refs[0].contentHash === ref.contentHash;
  requireFact(within(plan.feature.sourceRefs) && plan.tasks.every(task => within(task.requirementsRefs)), 'requirements_scope_mismatch');
  requireFact(findMachineDependencyHints(plan).length === 0, 'unsafe_candidate');
  return {
    candidateId: text(view.candidateId), candidateDigest: digest(candidate.candidateDigest),
    planDigest: plan.planDigest, taskIds: plan.tasks.map(task => task.id),
    longestChain: dag.longestChain, plan,
  };
}
export type TodoCandidateReview = ReturnType<typeof reviewTodoCandidate>;
export interface TodoPlanningState {
  readonly snapshotDigest: string;
  planning?: { candidateId: string; runId: string; batchId: string };
  review?: TodoCandidateReview;
  approval?: { candidateDigest: string; planDigest: string; decisionActor: string; commandId: string; approvalId: string; checkPolicyDigest: string };
  preview?: { previewDigest: string; approvalId: string };
  delivery?: { batchId: string; runId: string; status: 'accepted'; productVerified: false };
  /** Persisted BEFORE sending a write, reused after response loss/restart. */
  intents: Partial<Record<'plan' | 'approve' | 'start', string>>;
  failures: { action: string; reason: string; exitCode: number | null }[];
}
export type TodoPlanningAction =
  | { readonly kind: 'plan' }
  | { readonly kind: 'review' }
  | { readonly kind: 'approve'; readonly candidateDigest: string; readonly scopeConfirmed: true }
  | { readonly kind: 'preview' }
  | { readonly kind: 'start'; readonly previewDigest: string };
export interface TodoPlanningPorts {
  /** Must atomically persist the demo journal, never Core/Nezha metadata. */
  save(state: TodoPlanningState): Promise<void>;
  input(name: 'planning-input.json' | 'execution-budget.json', value: unknown): Promise<string>;
  invoke(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
}
export function initialTodoPlanningState(snapshot: TodoPlanningSnapshot): TodoPlanningState {
  return { snapshotDigest: snapshot.snapshotDigest, intents: {}, failures: [] };
}

function sameSet(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && new Set(left).size === right.length
    && left.every(id => right.includes(id));
}
function checkRoute(value: unknown, snapshot: TodoPlanningSnapshot): void {
  const route = object(value);
  requireFact(['runtime', 'provider', 'model'].every(key => route[key] === snapshot.route[key as keyof typeof snapshot.route]), 'route_mismatch');
}

/** One explicit stage per call; approve and start are never inferred from review.
 * The caller serializes access to the journal. No polling, model calls or Core
 * writes occur outside the CLI. A successful return never asserts product pass.
 */
export async function runTodoPlanningStep(
  snapshot: TodoPlanningSnapshot, state: TodoPlanningState, action: TodoPlanningAction, ports: TodoPlanningPorts,
): Promise<TodoPlanningState> {
  let exitCode: number | null = null;
  const validateSnapshot = () => {
    const expectedSnapshot = createTodoPlanningSnapshot({
      requirementsText: snapshot.requirementsText, requirementArtifactId: snapshot.planningInput.requirementRefs[0].artifactId,
      projectId: snapshot.projectId, phaseId: snapshot.phaseId, featureId: snapshot.featureId, revision: snapshot.revision,
      route: snapshot.route, planningBudget: snapshot.planningInput.budget, executionBudget: snapshot.executionBudget,
      taskLimit: snapshot.planningInput.strategy.taskLimit,
    });
    requireFact(todoDigest(expectedSnapshot) === todoDigest(snapshot) && state.snapshotDigest === snapshot.snapshotDigest, 'snapshot_drift');
  };
  const project = ['--project', snapshot.projectId];
  const invoke = async (argv: string[]): Promise<JsonObject> => {
    exitCode = null;
    const response = await ports.invoke([...argv, '--json']);
    exitCode = response.exitCode;
    let envelope: JsonObject;
    try { envelope = object(JSON.parse(response.stdout)); } catch { throw new TodoPlanningError('cli_response_malformed'); }
    requireFact(envelope.command === `${argv[0]}.${argv[1]}`, 'cli_command_mismatch');
    if (response.exitCode !== 0 || envelope.ok !== true) {
      const failure = object(envelope.error);
      const code = failure.code;
      // Do not copy untrusted error messages, paths or credentials to evidence.
      const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'cli_failed';
      const reason = failure.details && object(failure.details).reason;
      throw new TodoPlanningError(typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : safeCode);
    }
    return object(envelope.result);
  };
  const intent = async (kind: 'plan' | 'approve' | 'start', payload: unknown) => {
    const identity = todoDigest(payload);
    requireFact(state.intents[kind] === undefined || state.intents[kind] === identity, 'intent_drift');
    state.intents[kind] = identity;
    await ports.save(state);
  };
  const readCandidate = async () => {
    requireFact(state.planning, 'planning_required');
    const view = await invoke(['planning', 'candidate', state.planning.candidateId, ...project]);
    const reviewed = reviewTodoCandidate(snapshot, view);
    requireFact(reviewed.candidateId === state.planning.candidateId, 'candidate_identity_mismatch');
    return reviewed;
  };
  try {
    validateSnapshot();
    if (action.kind === 'plan') {
      if (state.planning) return state;
      const effective = await invoke(['config', 'effective', ...project]);
      const strategies = object(effective.strategies);
      const purposes = object(strategies.purposeStrategies ?? {});
      checkRoute(object(purposes.planner ?? strategies.defaultStrategy).strategy, snapshot);
      const inputFile = await ports.input('planning-input.json', snapshot.planningInput);
      await intent('plan', { snapshot: snapshot.snapshotDigest, commandId: snapshot.commandIds.plan });
      const result = await invoke(['planning', 'start', snapshot.featureId, ...project, '--phase', snapshot.phaseId,
        '--revision', String(snapshot.revision), '--input', inputFile, '--command-id', snapshot.commandIds.plan]);
      requireFact(result.status === 'accepted' && result.commandId === snapshot.commandIds.plan, 'planning_receipt_invalid');
      state.planning = { candidateId: text(result.candidateId), runId: text(result.runId), batchId: text(result.batchId) };
    } else if (action.kind === 'review') {
      const reviewed = await readCandidate();
      requireFact(!state.approval || (state.approval.candidateDigest === reviewed.candidateDigest
        && state.approval.planDigest === reviewed.planDigest), 'approved_candidate_drift');
      state.review = reviewed;
    } else if (action.kind === 'approve') {
      requireFact(state.review && action.scopeConfirmed === true && action.candidateDigest === state.review.candidateDigest, 'human_scope_review_required');
      if (state.approval) return state;
      const current = await readCandidate();
      requireFact(todoDigest(current) === todoDigest(state.review), 'candidate_drift');
      const detail = await invoke(['feature', 'get', snapshot.featureId]);
      const feature = object(detail.feature);
      requireFact(feature.id === snapshot.featureId && feature.projectId === snapshot.projectId
        && feature.phaseId === snapshot.phaseId
        && (feature.revision === snapshot.revision || state.intents.approve !== undefined), 'feature_revision_drift');
      await intent('approve', { candidateDigest: action.candidateDigest, commandId: snapshot.commandIds.approve });
      const result = await invoke(['planning', 'approve', current.candidateId, ...project, '--digest', current.candidateDigest,
        '--revision', String(snapshot.revision), '--reason', 'Todo frozen scope reviewed by owner', '--command-id', snapshot.commandIds.approve]);
      const decision = object(result.result);
      const approvedFeature = object(decision.feature);
      requireFact(result.decision === 'approve' && result.commandId === snapshot.commandIds.approve
        && decision.candidateId === current.candidateId && decision.candidateDigest === current.candidateDigest
        && approvedFeature.id === snapshot.featureId && approvedFeature.planStatus === 'approved'
        && approvedFeature.planDigest === current.planDigest, 'approval_receipt_invalid');
      const approval = object(decision.approval);
      requireFact(approval.status === 'approved' && approval.subjectDigest === current.planDigest, 'approval_receipt_invalid');
      state.approval = { candidateDigest: current.candidateDigest, planDigest: current.planDigest,
        decisionActor: text(result.decisionActor), commandId: snapshot.commandIds.approve,
        approvalId: text(approval.id), checkPolicyDigest: digest(approval.checkPolicyDigest) };
    } else if (action.kind === 'preview') {
      requireFact(state.approval && state.review, 'human_approval_required');
      // Once a start may have been accepted, only replay that original envelope.
      if (state.intents.start !== undefined) return state;
      const detail = await invoke(['feature', 'get', snapshot.featureId]);
      const feature = object(detail.feature);
      requireFact(feature.projectId === snapshot.projectId && feature.phaseId === snapshot.phaseId
        && feature.id === snapshot.featureId && feature.planStatus === 'approved'
        && feature.planDigest === state.review.planDigest, 'approved_plan_drift');
      requireFact(Array.isArray(detail.tasks) && Array.isArray(detail.dependencies), 'invalid_cli_shape');
      const tasks = detail.tasks.map(object);
      requireFact(sameSet(tasks.map(task => task.id), state.review.taskIds), 'task_scope_mismatch');
      for (const task of tasks) {
        requireFact(task.projectId === snapshot.projectId && task.featureId === snapshot.featureId, 'task_scope_mismatch');
        checkRoute(task.executionConfig, snapshot);
      }
      const dependencies = detail.dependencies.map(object);
      validateTodoTaskPlan(tasks.map(task => ({ id: task.id, dependsOn: dependencies.filter(edge => edge.taskId === task.id).map(edge => edge.dependsOnId) })));
      const inputFile = await ports.input('execution-budget.json', snapshot.executionBudget);
      const preview = await invoke(['execution', 'preview', snapshot.featureId, ...project, '--input', inputFile]);
      requireFact(preview.status === 'ready' && preview.projectId === snapshot.projectId
        && sameSet(preview.featureIds, [snapshot.featureId]), 'preview_scope_blocked');
      const scope = object(preview.scope);
      requireFact(sameSet(scope.featureIds, [snapshot.featureId])
        && (scope.memberFeatureIds === undefined || sameSet(scope.memberFeatureIds, [snapshot.featureId])), 'preview_scope_expanded');
      const summary = object(preview.summary);
      requireFact(Array.isArray(summary.tasks) && sameSet(summary.tasks.map(task => object(task).taskId), state.review.taskIds), 'preview_task_scope_mismatch');
      for (const value of summary.tasks) {
        const entry = object(value);
        const task = tasks.find(task => task.id === entry.taskId)!;
        requireFact(entry.strategyCopyDigest === computeExecutionStrategyCopyDigest({
          executionConfig: object(task.executionConfig), configSource: text(task.configSource),
          configSourceKey: task.configSourceKey === null ? null : text(task.configSourceKey),
        }), 'preview_strategy_drift');
      }
      requireFact(todoDigest(summary.budget) === todoDigest(snapshot.executionBudget), 'budget_drift');
      const plan = object(summary.plan);
      requireFact(plan.planDigest === state.review.planDigest && plan.taskCount === state.review.taskIds.length, 'preview_plan_drift');
      const approval = object(summary.approval);
      requireFact(approval.planDigest === state.approval.planDigest && approval.planDigest === state.review.planDigest
        && approval.decisionId === state.approval.approvalId && approval.checkPolicyDigest === state.approval.checkPolicyDigest, 'preview_approval_drift');
      requireFact(Array.isArray(object(summary.inputs).refs) && (object(summary.inputs).refs as unknown[]).some(value => {
        const ref = object(value);
        return ref.artifactId === snapshot.planningInput.requirementRefs[0].artifactId && ref.contentHash === snapshot.requirementsHash;
      }), 'input_snapshot_missing');
      state.preview = { previewDigest: digest(preview.previewDigest), approvalId: text(approval.decisionId) };
    } else {
      requireFact(state.approval && state.review && state.preview, 'human_approval_required');
      requireFact(action.previewDigest === state.preview.previewDigest, 'start_confirmation_required');
      if (state.delivery) return state;
      const inputFile = await ports.input('execution-budget.json', snapshot.executionBudget);
      await intent('start', { preview: state.preview, commandId: snapshot.commandIds.start });
      const result = await invoke(['execution', 'start', snapshot.featureId, ...project, '--input', inputFile,
        '--preview-digest', action.previewDigest, '--confirm', '--command-id', snapshot.commandIds.start]);
      requireFact(result.status === 'accepted' && result.commandId === snapshot.commandIds.start
        && sameSet(result.featureIds, [snapshot.featureId]) && sameSet(result.runIds, [text(result.runId)]), 'start_receipt_invalid');
      state.delivery = { batchId: text(result.batchId), runId: text(result.runId), status: 'accepted', productVerified: false };
    }
    await ports.save(state);
    return state;
  } catch (error) {
    const reason = error instanceof TodoPlanningError ? error.reason : 'local_or_transport_failure';
    state.failures.push({ action: action.kind, reason, exitCode });
    await ports.save(state);
    throw new TodoPlanningError(reason);
  }
}
