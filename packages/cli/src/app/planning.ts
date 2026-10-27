import type { HostClient } from 'shiploop-host';
import { AppCliParseError, type AppCliCommandId } from './args.js';
import { EXECUTION_BOUNDARY_VIEW, type ExecutionBoundaryView } from './decisions.js';

type PlanningCandidateDetailResult = Awaited<ReturnType<HostClient['getPlanningCandidate']>>;
type PlanningContextDetailResult = Awaited<ReturnType<HostClient['getPlanningContext']>>;
type PlanningContextListResult = Awaited<ReturnType<HostClient['listPlanningContexts']>>;


const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_STRING = 2_000;

export interface PlanningStartInputDocument {
  readonly requirementRefs: readonly { readonly artifactId: string; readonly contentHash?: string | null }[];
  readonly constraints: readonly string[];
  readonly acceptance: { readonly criteria: readonly string[] };
  readonly strategy: { readonly approvalMode: 'manual'; readonly taskLimit: number | null };
  readonly budget: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_JSON_STRING && !value.includes('\0');
}

/** 规划启动输入的 CLI 边界校验；深层预算/业务规则仍由 Core 复核。 */
export function parsePlanningStartInput(
  value: Record<string, unknown>,
  context: { readonly commandId: AppCliCommandId; readonly json: boolean },
): PlanningStartInputDocument {
  const fail = (field?: string): never => {
    throw new AppCliParseError('invalid_input', 'invalid_planning_input', {
      command: 'planning', commandId: context.commandId, json: context.json,
    }, field);
  };
  const allowed = ['requirementRefs', 'constraints', 'acceptance', 'strategy', 'budget'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('input');
  const requirementRefsValue = value.requirementRefs;
  if (!Array.isArray(requirementRefsValue) || requirementRefsValue.length > 16) fail('requirementRefs');
  const requirementRefs = (requirementRefsValue as unknown[]).map((entry: unknown) => {
    const entryObject = isObject(entry) ? entry : fail('requirementRefs');
    if (Object.keys(entryObject).some((key) => !['artifactId', 'contentHash'].includes(key))) fail('requirementRefs');
    if (typeof entryObject.artifactId !== 'string' || !STABLE_ID.test(entryObject.artifactId)) fail('requirementRefs');
    if (entryObject.contentHash !== undefined && entryObject.contentHash !== null && (typeof entryObject.contentHash !== 'string' || !SHA256.test(entryObject.contentHash))) fail('requirementRefs');
    return {
      artifactId: entryObject.artifactId as string,
      ...(entryObject.contentHash === undefined ? {} : { contentHash: entryObject.contentHash as string | null }),
    };
  });
  const constraintsValue = value.constraints;
  const constraints = Array.isArray(constraintsValue) ? constraintsValue : fail('constraints');
  if (constraints.length > 16 || !constraints.every(boundedString)) fail('constraints');
  const acceptanceValue = value.acceptance;
  const acceptanceObject = isObject(acceptanceValue) ? acceptanceValue : fail('acceptance');
  const criteria = Array.isArray(acceptanceObject.criteria) ? acceptanceObject.criteria : fail('acceptance');
  if (Object.keys(acceptanceObject).some((key) => key !== 'criteria') || criteria.length > 256 || !criteria.every(boundedString)) fail('acceptance');
  const strategyValue = value.strategy;
  const strategyObject = isObject(strategyValue) ? strategyValue : fail('strategy');
  if (Object.keys(strategyObject).some((key) => !['approvalMode', 'taskLimit'].includes(key)) || strategyObject.approvalMode !== 'manual') fail('strategy');
  if (strategyObject.taskLimit !== null && (!Number.isSafeInteger(strategyObject.taskLimit) || (strategyObject.taskLimit as number) < 1 || (strategyObject.taskLimit as number) > 10_000)) fail('strategy.taskLimit');
  const budgetObject = isObject(value.budget) ? value.budget : fail('budget');
  if (Object.keys(budgetObject).length === 0) fail('budget');
  return {
    requirementRefs,
    constraints: [...constraints] as string[],
    acceptance: { criteria: [...criteria] as string[] },
    strategy: { approvalMode: 'manual', taskLimit: strategyObject.taskLimit as number | null },
    budget: { ...budgetObject },
  };
}

export interface PlanningStartCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly status: 'accepted';
  readonly batchId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly planning: {
    readonly candidateState: 'pending_generation';
    readonly executionStarted: false;
    readonly encodingAuthorized: false;
  };
}

export function buildPlanningStartView(
  receipt: {
    readonly commandId: string;
    readonly replayed: boolean;
    readonly batchId: string;
    readonly runId: string;
    readonly planningTaskId: string;
    readonly candidateId: string;
  },
): PlanningStartCliView {
  return {
    commandId: receipt.commandId,
    replayed: receipt.replayed,
    status: 'accepted',
    batchId: receipt.batchId,
    runId: receipt.runId,
    planningTaskId: receipt.planningTaskId,
    candidateId: receipt.candidateId,
    planning: { candidateState: 'pending_generation', executionStarted: false, encodingAuthorized: false },
  };
}

export interface PlanningContextListCliView {
  readonly records: PlanningContextListResult['records'];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export function buildPlanningContextListView(result: PlanningContextListResult): PlanningContextListCliView {
  return { records: result.records, nextCursor: result.nextCursor, limit: result.limit };
}

export interface PlanningContextDetailCliView {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly planningTaskId: string;
  readonly status: string;
  readonly executionState: string;
  readonly outcomeAxes: PlanningContextDetailResult['outcomeAxes'];
  readonly decision: PlanningContextDetailResult['context']['decision'];
  readonly attempts: PlanningContextDetailResult['attempts'];
  readonly budget: PlanningContextDetailResult['budget'];
  readonly execution: ExecutionBoundaryView;
}

export function buildPlanningContextDetailView(result: PlanningContextDetailResult): PlanningContextDetailCliView {
  return {
    id: result.context.id,
    projectId: result.context.projectId,
    phaseId: result.context.phaseId,
    featureId: result.context.featureId,
    candidateId: result.context.candidateId,
    runId: result.run.id,
    batchId: result.run.batchId ?? (result.budget.batch.id as string),
    planningTaskId: result.context.planningTaskId,
    status: result.context.status,
    executionState: result.executionState,
    outcomeAxes: result.outcomeAxes,
    decision: result.context.decision,
    attempts: result.attempts,
    budget: result.budget,
    execution: EXECUTION_BOUNDARY_VIEW,
  };
}

type PublishedPlanningCandidate = Extract<PlanningCandidateDetailResult['candidate'], { readonly state: 'published' }>;

export interface PlanningCandidateCliView {
  readonly projectId: string;
  readonly featureId: string;
  readonly candidateId: string;
  readonly status: string;
  readonly runStatus: string;
  readonly summary: string | null;
  readonly candidate: {
    readonly summary: string;
    readonly artifact: PublishedPlanningCandidate['artifact'];
    readonly candidateDigest: string;
    readonly plan: PublishedPlanningCandidate['plan'];
    readonly taskVerification: PublishedPlanningCandidate['taskVerification'];
    readonly tasks: readonly unknown[];
  } | null;
  readonly execution: ExecutionBoundaryView;
}

export function buildPlanningCandidateView(result: PlanningCandidateDetailResult): PlanningCandidateCliView {
  const candidate = result.candidate;
  if (candidate.state === 'pending_generation') {
    return {
      projectId: result.context.projectId, featureId: result.context.featureId,
      candidateId: result.context.candidateId, status: result.context.status,
      runStatus: result.runStatus, summary: null, candidate: null, execution: EXECUTION_BOUNDARY_VIEW,
    };
  }
  return {
    projectId: result.context.projectId, featureId: result.context.featureId,
    candidateId: result.context.candidateId, status: result.context.status,
    runStatus: result.runStatus, summary: candidate.summary,
    candidate: { summary: candidate.summary, artifact: candidate.artifact, candidateDigest: candidate.candidateDigest, plan: candidate.plan, taskVerification: candidate.taskVerification, tasks: candidate.plan.tasks },
    execution: EXECUTION_BOUNDARY_VIEW,
  };
}

export interface PlanningDecisionCliView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly decision: 'approve' | 'reject';
  readonly result: Record<string, unknown>;
  readonly execution: ExecutionBoundaryView;
}

export function buildPlanningDecisionView(commandId: string, replayed: boolean, decision: 'approve' | 'reject', result: unknown): PlanningDecisionCliView {
  return { commandId, replayed, decision, result: { ...(isObject(result) ? result : {}) }, execution: EXECUTION_BOUNDARY_VIEW };
}

export function formatPlanningStartView(view: PlanningStartCliView): string {
  return `shiploop planning start: accepted batchId=${view.batchId} runId=${view.runId} candidateId=${view.candidateId} planningTaskId=${view.planningTaskId}（候选尚未生成；未授权编码）\n`;
}

export function formatPlanningContextListView(view: PlanningContextListCliView): string {
  return `shiploop planning list: ${view.records.length} record(s)${view.nextCursor === null ? '' : ` nextCursor=${view.nextCursor}`}\n`;
}

export function formatPlanningContextDetailView(view: PlanningContextDetailCliView): string {
  return `shiploop planning get: candidateId=${view.candidateId} status=${view.status} runId=${view.runId} batchId=${view.batchId} executionState=${view.executionState}（规划状态不等于 Feature 交付或编码授权）\n`;
}

export function formatPlanningCandidateView(view: PlanningCandidateCliView): string {
  if (view.candidate === null) return `shiploop planning candidate: candidateId=${view.candidateId} state=pending_generation runStatus=${view.runStatus}\n`;
  return `shiploop planning candidate: candidateId=${view.candidateId} candidateDigest=${view.candidate.candidateDigest} summary=${view.summary ?? ''} tasks=${view.candidate.tasks.length}（仅审阅候选；未授权编码）\n`;
}

export function formatPlanningDecisionView(view: PlanningDecisionCliView): string {
  const status = typeof view.result.planningContextStatus === 'string' ? view.result.planningContextStatus : view.decision;
  return `shiploop planning ${view.decision}: completed candidateId=${String(view.result.candidateId)} status=${status}${view.replayed ? '（replayed）' : ''}（不自动开始编码）\n`;
}

export function buildPlanningClientInput(
  command: { readonly projectId: string; readonly phaseId: string; readonly featureId: string; readonly revision: number },
  input: PlanningStartInputDocument,
): Parameters<HostClient['startPlanning']>[0] {
  return {
    projectId: command.projectId,
    phaseId: command.phaseId,
    featureId: command.featureId,
    ...input,
    expectedRevision: command.revision,
  };
}
