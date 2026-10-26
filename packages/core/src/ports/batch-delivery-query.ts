import type { FeatureDeliveryDetailResult } from './feature-delivery-query.js';
import type { FeatureStatus, TaskStatus } from './plan-store.js';
import type { ExecutionBatchStatus, ExecutionRunStatus } from './execution-store.js';
import type { FeatureDeliveryStatus } from './git-operations.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';

/** P05-9 / F-001 Batch 收尾查询操作。 */
export const EXECUTION_BATCH_DELIVERY_GET_OPERATION = 'execution.batch.delivery.get' as const;
export const BATCH_DELIVERY_GET_OPERATION = EXECUTION_BATCH_DELIVERY_GET_OPERATION;
export const BATCH_DELIVERY_QUERY_OPERATIONS = [EXECUTION_BATCH_DELIVERY_GET_OPERATION] as const;
export type BatchDeliveryQueryOperation = (typeof BATCH_DELIVERY_QUERY_OPERATIONS)[number];

export const BATCH_DELIVERY_STATUSES = [
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'awaiting_approval',
  'in_progress',
  'budget_exhausted',
] as const;
export type BatchDeliveryStatus = (typeof BATCH_DELIVERY_STATUSES)[number];

export interface BatchDeliveryQueryRequest {
  readonly afterId: string | null;
  readonly limit: number;
}

export interface BatchDeliveryStopRecord {
  readonly operationId: string;
  readonly targetKind: 'run' | 'batch' | 'feature';
  readonly targetId: string;
  readonly status: 'stopping' | 'stopped' | 'uncertain';
  readonly reason: string;
  readonly stopConfirmed: boolean | null;
  readonly forced: boolean | null;
  readonly evidenceRef: string | null;
  readonly requestedAtUtcMs: number;
  readonly settledAtUtcMs: number | null;
}

export interface BatchDeliveryIntegrationRecord {
  readonly integrationId: string;
  readonly successorFeatureId: string;
  readonly status: 'dependency_passed' | 'integration_passed' | 'stale' | 'blocked';
  readonly blockReasons: readonly string[];
  readonly staleReasons: readonly string[];
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly evidenceRef: string | null;
}

export interface BatchDeliveryBudgetView {
  readonly status: 'available' | 'exhausted' | 'unknown';
  readonly blockingReasons: readonly string[];
  readonly runsCreated: number | null;
  readonly attemptsCreated: number | null;
  readonly runtimeStarts: number | null;
  readonly deadlineAtUtcMs: number | null;
  readonly tokenUsed: number | null;
  readonly costUsed: number | null;
}

export interface BatchDeliveryRunView {
  readonly runId: string;
  readonly featureId: string;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly durationMs: number | null;
}

export interface BatchDeliveryFeatureRecord {
  readonly featureId: string;
  readonly featureStatus: FeatureStatus;
  readonly deliveryStatus: FeatureDeliveryStatus;
  readonly status: BatchDeliveryStatus;
  readonly reason: string;
  readonly failurePredecessors: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly delivery: FeatureDeliveryDetailResult;
  readonly runs: readonly BatchDeliveryRunView[];
  readonly integrations: readonly BatchDeliveryIntegrationRecord[];
  readonly stopOperations: readonly BatchDeliveryStopRecord[];
  readonly budget: BatchDeliveryBudgetView;
  /** Stable identity references only; no paths, output bodies, credentials or logs. */
  readonly evidenceRefs: readonly string[];
}

export interface BatchDeliveryBatchView {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly status: ExecutionBatchStatus;
  readonly revision: number;
  readonly featureIds: readonly string[];
  readonly maxConcurrentFeatures: number | null;
  readonly concurrencySource: string | null;
  readonly deadlineAtUtcMs: number | null;
  readonly budget: BatchDeliveryBudgetView;
}

export interface BatchDeliveryView {
  readonly batch: BatchDeliveryBatchView;
  readonly records: readonly BatchDeliveryFeatureRecord[];
  readonly nextId: string | null;
  readonly summary: Readonly<Record<BatchDeliveryStatus, number>>;
  readonly currentRunningCount: number;
  readonly readyCount: number;
  readonly resourceWaitingCount: number;
  readonly stopOperations: readonly BatchDeliveryStopRecord[];
  readonly integrations: readonly BatchDeliveryIntegrationRecord[];
}

export interface BatchDeliveryQueryReadStore {
  readBatchDeliveryView(
    projectId: unknown,
    batchId: unknown,
    request: BatchDeliveryQueryRequest,
  ): BatchDeliveryView | undefined;
}

export interface PublicBatchDeliveryBudgetView {
  readonly status: BatchDeliveryBudgetView['status'];
  readonly blockingReasons: readonly string[];
  readonly runsCreated: number | null;
  readonly attemptsCreated: number | null;
  readonly runtimeStarts: number | null;
  readonly deadlineAt: string | null;
  readonly tokenUsed: number | null;
  readonly costUsed: number | null;
}

export interface PublicBatchDeliveryResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'batch-delivery';
  readonly batch: Omit<BatchDeliveryBatchView, 'deadlineAtUtcMs' | 'budget'> & {
    readonly deadlineAt: string | null;
    readonly budget: PublicBatchDeliveryBudgetView;
  };
  readonly records: readonly (Omit<BatchDeliveryFeatureRecord, 'delivery' | 'runs' | 'stopOperations' | 'budget'> & {
    readonly delivery: FeatureDeliveryDetailResult;
    readonly runs: readonly (Omit<BatchDeliveryRunView, 'startedAtUtcMs' | 'endedAtUtcMs'> & {
      readonly startedAt: string | null;
      readonly endedAt: string | null;
    })[];
    readonly stopOperations: readonly (Omit<BatchDeliveryStopRecord, 'requestedAtUtcMs' | 'settledAtUtcMs'> & {
      readonly requestedAt: string;
      readonly settledAt: string | null;
    })[];
    readonly budget: PublicBatchDeliveryBudgetView;
  })[];
  readonly summary: Readonly<Record<BatchDeliveryStatus, number>>;
  readonly currentRunningCount: number;
  readonly readyCount: number;
  readonly resourceWaitingCount: number;
  readonly stopOperations: readonly (Omit<BatchDeliveryStopRecord, 'requestedAtUtcMs' | 'settledAtUtcMs'> & {
    readonly requestedAt: string;
    readonly settledAt: string | null;
  })[];
  readonly integrations: readonly BatchDeliveryIntegrationRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface BatchDeliveryStatusFacts {
  readonly featureStatus: FeatureStatus;
  readonly deliveryStatus: FeatureDeliveryStatus;
  readonly taskStatuses: readonly TaskStatus[];
  readonly runStatus: ExecutionRunStatus | null;
  readonly approvalStatus: string;
  readonly integrationBlocked: boolean;
  readonly stopStatus: BatchDeliveryStopRecord['status'] | null;
  readonly budgetExhausted: boolean;
  readonly manualBlock: boolean;
}

/** Deterministic status precedence shared by SQLite and non-SQLite projections. */
export function deriveBatchDeliveryItemStatus(facts: BatchDeliveryStatusFacts): BatchDeliveryStatus {
  if (facts.stopStatus === 'stopped' && facts.runStatus === 'cancelled') return 'cancelled';
  if (facts.runStatus === 'cancelled' || facts.taskStatuses.some(status => status === 'cancelled')) return 'cancelled';
  if (facts.featureStatus === 'completed' && facts.deliveryStatus === 'succeeded') return 'completed';
  if (facts.featureStatus === 'failed' || facts.featureStatus === 'partial' || facts.deliveryStatus === 'failed' || facts.taskStatuses.some(status => status === 'failed')) return 'failed';
  if (facts.stopStatus === 'stopping' || facts.stopStatus === 'uncertain' || facts.integrationBlocked || facts.manualBlock) return 'blocked';
  if (facts.featureStatus === 'awaiting_approval' || facts.approvalStatus === 'pending') return 'awaiting_approval';
  if (facts.budgetExhausted) return 'budget_exhausted';
  return 'in_progress';
}

function isoOr(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function publicStop(stop: BatchDeliveryStopRecord) {
  return {
    operationId: stop.operationId,
    targetKind: stop.targetKind,
    targetId: stop.targetId,
    status: stop.status,
    reason: stop.reason,
    stopConfirmed: stop.stopConfirmed,
    forced: stop.forced,
    evidenceRef: stop.evidenceRef,
    requestedAt: new Date(stop.requestedAtUtcMs).toISOString(),
    settledAt: isoOr(stop.settledAtUtcMs),
  };
}

function publicBudget(budget: BatchDeliveryBudgetView): PublicBatchDeliveryBudgetView {
  return {
    status: budget.status,
    blockingReasons: [...budget.blockingReasons],
    runsCreated: budget.runsCreated,
    attemptsCreated: budget.attemptsCreated,
    runtimeStarts: budget.runtimeStarts,
    deadlineAt: isoOr(budget.deadlineAtUtcMs),
    tokenUsed: budget.tokenUsed,
    costUsed: budget.costUsed,
  };
}

export function buildBatchDeliveryResult(
  view: BatchDeliveryView,
  cursor: string | null,
  limit: number,
): PublicBatchDeliveryResult {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'batch-delivery',
    batch: {
      id: view.batch.id,
      projectId: view.batch.projectId,
      phaseId: view.batch.phaseId,
      status: view.batch.status,
      revision: view.batch.revision,
      featureIds: [...view.batch.featureIds],
      maxConcurrentFeatures: view.batch.maxConcurrentFeatures,
      concurrencySource: view.batch.concurrencySource,
      deadlineAt: isoOr(view.batch.deadlineAtUtcMs),
      budget: publicBudget(view.batch.budget),
    },
    records: view.records.map(record => ({
      featureId: record.featureId,
      featureStatus: record.featureStatus,
      deliveryStatus: record.deliveryStatus,
      status: record.status,
      reason: record.reason,
      failurePredecessors: [...record.failurePredecessors],
      blockingReasons: [...record.blockingReasons],
      delivery: record.delivery,
      runs: record.runs.map(run => ({
        runId: run.runId,
        featureId: run.featureId,
        status: run.status,
        reason: run.reason,
        durationMs: run.durationMs,
        startedAt: isoOr(run.startedAtUtcMs),
        endedAt: isoOr(run.endedAtUtcMs),
      })),
      integrations: record.integrations,
      stopOperations: record.stopOperations.map(publicStop),
      budget: publicBudget(record.budget),
      evidenceRefs: [...record.evidenceRefs],
    })),
    summary: { ...view.summary },
    currentRunningCount: view.currentRunningCount,
    readyCount: view.readyCount,
    resourceWaitingCount: view.resourceWaitingCount,
    stopOperations: view.stopOperations.map(publicStop),
    integrations: view.integrations,
    nextCursor: cursor,
    limit,
  };
}
