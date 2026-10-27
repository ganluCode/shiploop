/**
 * P05-6 / F-005 集成计划只读查询投影。
 *
 * 这个端口只消费已经冻结的 SQLite 事实。它不检查 branch HEAD、不执行 Git
 * 或 Runtime，也不暴露 owner/lock/native path 等内部控制细节。
 */
import type { IntegrationPlan, IntegrationResult, IntegrationPlanStatus } from './integration-plan.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';

export const INTEGRATION_PLAN_GET_OPERATION = 'integration.plan.get' as const;
export const INTEGRATION_PLAN_QUERY_OPERATIONS = [INTEGRATION_PLAN_GET_OPERATION] as const;
export type IntegrationPlanQueryOperation = (typeof INTEGRATION_PLAN_QUERY_OPERATIONS)[number];

export const INTEGRATION_PLAN_NEXT_STEPS = [
  'none',
  'await_integration',
  'reconcile_integration',
  'refresh_plan',
  'manual_review',
] as const;
export type IntegrationPlanNextStep = (typeof INTEGRATION_PLAN_NEXT_STEPS)[number];

export interface IntegrationPlanQueryPredecessor {
  readonly featureId: string;
  readonly dependencyPassed: boolean;
  readonly commitSha: string | null;
  readonly evidenceId: string | null;
  readonly evidenceDigest: string | null;
  readonly coveredInputIds: readonly string[];
  readonly ancestorVerified: boolean;
}

export interface IntegrationPlanQueryResultValue {
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly verificationEvidence: IntegrationResult['verificationEvidence'];
  readonly operationStatus: IntegrationResult['operationStatus'] | null;
}

export interface IntegrationPlanQueryView {
  readonly plan: Omit<IntegrationPlan, 'predecessors' | 'approvedInputs' | 'integrationResult'> & {
    readonly revision: number;
    readonly createdAtUtcMs: number;
    readonly updatedAtUtcMs: number;
    readonly frozenAtUtcMs: number | null;
  };
  readonly predecessors: readonly IntegrationPlanQueryPredecessor[];
  readonly integrationResult: IntegrationPlanQueryResultValue | null;
}

export interface PublicIntegrationPlanPredecessor extends IntegrationPlanQueryPredecessor {}

export interface PublicIntegrationPlan {
  readonly integrationId: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly successorFeatureId: string;
  readonly mode: IntegrationPlan['mode'];
  readonly status: IntegrationPlanStatus;
  readonly inputDigest: string;
  readonly targetBaseline: string;
  readonly mergeOrder: readonly string[];
  readonly verificationScope: readonly string[];
  readonly strategySummary: Readonly<Record<string, unknown>>;
  readonly coverage: IntegrationPlan['coverage'];
  readonly blockReasons: IntegrationPlan['blockReasons'];
  readonly staleReasons: IntegrationPlan['staleReasons'];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly frozenAt: string | null;
}

export interface PublicIntegrationPlanOutcome {
  readonly status: IntegrationPlanStatus;
  readonly reason: string;
  readonly blockReasons: IntegrationPlan['blockReasons'];
  readonly staleReasons: IntegrationPlan['staleReasons'];
  readonly nextStep: IntegrationPlanNextStep;
}

export interface IntegrationPlanQueryResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'integration-plan';
  readonly integration: PublicIntegrationPlan;
  readonly predecessors: readonly PublicIntegrationPlanPredecessor[];
  readonly integrationResult: IntegrationPlanQueryResultValue | null;
  readonly outcome: PublicIntegrationPlanOutcome;
}

export interface IntegrationPlanQueryReadStore {
  /** 不存在或跨项目目标返回 undefined；损坏持久行必须抛 corrupt。 */
  readIntegrationPlanView(projectId: unknown, integrationId: unknown): IntegrationPlanQueryView | undefined;
}

const SECRET_KEY = /(token|secret|password|credential|private.?key|api.?key|access.?key|authorization|cookie)/i;
const PATH_KEY = /(path|locator|worktree|homedir|directory|filename)/i;
const MAX_PUBLIC_STRATEGY_KEYS = 64;
const MAX_PUBLIC_STRATEGY_DEPTH = 6;
const MAX_PUBLIC_STRATEGY_ITEMS = 128;
const MAX_PUBLIC_STRATEGY_TEXT = 512;

function publicStrategyValue(value: unknown, depth: number, count: { value: number }): unknown {
  if (count.value >= MAX_PUBLIC_STRATEGY_ITEMS || depth > MAX_PUBLIC_STRATEGY_DEPTH) return '[omitted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_PUBLIC_STRATEGY_TEXT ? `${value.slice(0, MAX_PUBLIC_STRATEGY_TEXT)}…` : value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PUBLIC_STRATEGY_ITEMS).map(item => publicStrategyValue(item, depth + 1, count));
  }
  if (typeof value !== 'object') return '[omitted]';
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (Object.keys(output).length >= MAX_PUBLIC_STRATEGY_KEYS) break;
    count.value += 1;
    if (SECRET_KEY.test(key) || PATH_KEY.test(key)) continue;
    output[key] = publicStrategyValue((value as Record<string, unknown>)[key], depth + 1, count);
  }
  return output;
}

function publicStrategySummary(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return publicStrategyValue(value, 0, { value: 0 }) as Readonly<Record<string, unknown>>;
}

function nextStep(plan: IntegrationPlanQueryView['plan']): IntegrationPlanNextStep {
  if (plan.status === 'integration_passed') return 'none';
  if (plan.status === 'stale') return 'refresh_plan';
  if (plan.status === 'dependency_passed') return 'await_integration';
  if (plan.blockReasons.includes('integration_evidence_incomplete')) return 'reconcile_integration';
  if (plan.blockReasons.includes('ancestor_not_verified')) return 'manual_review';
  return 'await_integration';
}

function outcomeReason(plan: IntegrationPlanQueryView['plan']): string {
  if (plan.status === 'integration_passed') return 'fixed integration commit and verification evidence are complete';
  if (plan.status === 'stale') return plan.staleReasons.join(',') || 'frozen integration inputs are stale';
  if (plan.status === 'dependency_passed') return 'dependencies passed; waiting for integration';
  return plan.blockReasons.join(',') || 'integration plan is blocked';
}

export function buildIntegrationPlanQueryResult(view: IntegrationPlanQueryView): IntegrationPlanQueryResult {
  const plan = view.plan;
  const integration: PublicIntegrationPlan = {
    integrationId: plan.integrationId,
    projectId: plan.projectId,
    phaseId: plan.phaseId,
    batchId: plan.batchId,
    successorFeatureId: plan.successorFeatureId,
    mode: plan.mode,
    status: plan.status,
    inputDigest: plan.inputDigest,
    targetBaseline: plan.targetBaseline,
    mergeOrder: [...plan.mergeOrder],
    verificationScope: [...plan.verificationScope],
    strategySummary: publicStrategySummary(plan.strategySummary),
    coverage: { ...plan.coverage, missingInputIds: [...plan.coverage.missingInputIds] },
    blockReasons: [...plan.blockReasons],
    staleReasons: [...plan.staleReasons],
    revision: plan.revision,
    createdAt: new Date(plan.createdAtUtcMs).toISOString(),
    updatedAt: new Date(plan.updatedAtUtcMs).toISOString(),
    frozenAt: plan.frozenAtUtcMs === null ? null : new Date(plan.frozenAtUtcMs).toISOString(),
  };
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'integration-plan',
    integration,
    predecessors: view.predecessors.map(predecessor => ({ ...predecessor, coveredInputIds: [...predecessor.coveredInputIds] })),
    integrationResult: view.integrationResult === null ? null : {
      commitSha: view.integrationResult.commitSha,
      treeSha: view.integrationResult.treeSha,
      verificationEvidence: view.integrationResult.verificationEvidence === null ? null : { ...view.integrationResult.verificationEvidence },
      operationStatus: view.integrationResult.operationStatus ?? null,
    },
    outcome: {
      status: plan.status,
      reason: outcomeReason(plan),
      blockReasons: [...plan.blockReasons],
      staleReasons: [...plan.staleReasons],
      nextStep: nextStep(plan),
    },
  };
}
