import type {
  IntegrationPlanGenerationRequest,
  IntegrationPlanGenerationResult,
  IntegrationPlanGenerationService,
} from './integration-plan-generation.js';
import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';

const OPERATION = 'IntegrationPlanScheduler';
const DEFAULT_SCAN_LIMIT = 32;
const MAX_SCAN_LIMIT = 1_000;

type Trigger = 'event' | 'scan';

/** 由 FeatureFinalization 在成功事务提交后发出的最小唤醒封套。 */
export interface FeatureFinalizedWakeup {
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly outcome: 'completed' | 'partial' | 'failed' | 'awaiting_approval';
  readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed';
  /** 事件只用于降低延迟；序号不参与业务身份。 */
  readonly eventSequence?: number;
}

/** SQLite 中的获准 Batch 候选；排序/游标由持久读取端保证稳定。 */
export interface IntegrationPlanScheduleCandidate {
  readonly projectId: string;
  readonly batchId: string;
}

export interface IntegrationPlanScheduleCursor {
  readonly batchId: string;
}

export interface IntegrationPlanScheduleCandidatePage {
  readonly candidates: readonly IntegrationPlanScheduleCandidate[];
  readonly hasMore: boolean;
  readonly nextCursor: IntegrationPlanScheduleCursor | null;
}

export interface IntegrationPlanScheduleCandidateReader {
  list(input: { readonly after: IntegrationPlanScheduleCursor | null; readonly limit: number }): IntegrationPlanScheduleCandidatePage;
}

/**
 * 受控集成 operation 意图的持久入口。实现必须在短 SQLite 事务内按
 * (integrationId,inputDigest,planRevision) 做 CAS/幂等核对；它不能启动 Git、模型或
 * Runner。resource_busy 只表示当前准入事实，不改变 integration plan 本身。
 */
export interface IntegrationPlanDispatchIntent {
  readonly projectId: string;
  readonly batchId: string;
  readonly successorFeatureId: string;
  readonly integrationId: string;
  readonly inputDigest: string;
  readonly planRevision: number;
  readonly trigger: Trigger;
}

export interface IntegrationPlanDispatchReservation {
  readonly outcome: 'created' | 'reused' | 'resource_busy' | 'blocked';
  readonly operationId: string | null;
  readonly reason?: string;
}

export interface IntegrationPlanDispatchWriter {
  reserve(intent: IntegrationPlanDispatchIntent): IntegrationPlanDispatchReservation;
}

export const INTEGRATION_SCHEDULER_STATES = [
  'dependency_blocked',
  'integration_pending',
  'resource_busy',
  'stale',
  'integration_failed',
  'dispatchable',
  'integration_complete',
] as const;
export type IntegrationPlanSchedulerState = (typeof INTEGRATION_SCHEDULER_STATES)[number];

export interface IntegrationPlanSchedulerResult {
  readonly projectId: string;
  readonly batchId: string;
  readonly trigger: Trigger;
  readonly state: IntegrationPlanSchedulerState;
  readonly plan: PersistedIntegrationPlan | null;
  readonly integrationId: string | null;
  readonly inputDigest: string | null;
  readonly planRevision: number | null;
  readonly operationId: string | null;
  readonly reason: string | null;
  readonly reused: boolean;
}

export interface IntegrationPlanSchedulerScanResult {
  readonly pages: number;
  readonly processed: number;
  readonly bounded: boolean;
  readonly nextCursor: IntegrationPlanScheduleCursor | null;
  readonly results: readonly IntegrationPlanSchedulerResult[];
}

export interface IntegrationPlanSchedulerDeps {
  readonly generation: Pick<IntegrationPlanGenerationService, 'generate'>;
  readonly dispatch?: IntegrationPlanDispatchWriter;
  /** Trusted SQLite candidate scan; omitted only for event-only assembly. */
  readonly candidates?: IntegrationPlanScheduleCandidateReader;
}

export interface IntegrationPlanScheduler {
  /** 成功交付事件后的 best-effort 低延迟重评估；非成功事件不创建集成意图。 */
  onFeatureFinalized(event: FeatureFinalizedWakeup): Promise<IntegrationPlanSchedulerResult>;
  /** 从 SQLite 获准 Batch 候选做有界补偿扫描。 */
  scan(input?: { readonly candidates?: IntegrationPlanScheduleCandidateReader; readonly limit?: number; readonly after?: IntegrationPlanScheduleCursor | null }): Promise<IntegrationPlanSchedulerScanResult>;
  /** 事件和扫描共用的单 Batch 重评估入口。 */
  reevaluate(input: IntegrationPlanGenerationRequest & { readonly trigger: Trigger }): Promise<IntegrationPlanSchedulerResult>;
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_SCAN_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT) {
    throw new TypeError(`${OPERATION}.scan: limit must be an integer in [1, ${MAX_SCAN_LIMIT}]`);
  }
  return limit;
}

function errorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const details = (error as { readonly details?: unknown }).details;
    if (typeof details === 'object' && details !== null && typeof (details as { readonly reason?: unknown }).reason === 'string') {
      return (details as { readonly reason: string }).reason;
    }
  }
  return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 128) : 'plan_generation_failed';
}

function stateFor(plan: PersistedIntegrationPlan): IntegrationPlanSchedulerState {
  if (plan.status === 'stale' || plan.staleReasons.length > 0) return 'stale';
  if (plan.integrationResult?.operationStatus === 'failed') return 'integration_failed';
  if (plan.integrationResult?.operationStatus === 'pending' || plan.integrationResult?.operationStatus === 'unknown') return 'integration_pending';
  if (plan.status === 'integration_passed') return 'integration_complete';
  if (plan.status === 'blocked') {
    return plan.blockReasons.includes('verification_failed') ? 'integration_failed' : 'dependency_blocked';
  }
  return 'dispatchable';
}

export function createIntegrationPlanScheduler(deps: IntegrationPlanSchedulerDeps): IntegrationPlanScheduler {
  if (deps === null || typeof deps !== 'object' || typeof deps.generation?.generate !== 'function') {
    throw new TypeError(`${OPERATION}.create: generation.generate dependency is required`);
  }
  const inFlight = new Map<string, Promise<IntegrationPlanSchedulerResult>>();
  const dispatched = new Map<string, IntegrationPlanSchedulerResult>();

  function key(projectId: string, batchId: string): string {
    return `${projectId}\u0000${batchId}`;
  }

  function resultBase(projectId: string, batchId: string, trigger: Trigger, extra: Partial<IntegrationPlanSchedulerResult> = {}): IntegrationPlanSchedulerResult {
    return {
      projectId, batchId, trigger, state: 'dependency_blocked', plan: null,
      integrationId: null, inputDigest: null, planRevision: null, operationId: null,
      reason: null, reused: false, ...extra,
    };
  }

  async function run(request: IntegrationPlanGenerationRequest & { readonly trigger: Trigger }): Promise<IntegrationPlanSchedulerResult> {
    let generated: IntegrationPlanGenerationResult;
    try {
      generated = deps.generation.generate(request);
    } catch (error) {
      return resultBase(request.projectId, request.batchId, request.trigger, {
        state: 'integration_failed', reason: errorReason(error),
      });
    }
    const plan = generated.plan;
    const base = {
      projectId: request.projectId,
      batchId: request.batchId,
      trigger: request.trigger,
      plan,
      integrationId: plan.integrationId,
      inputDigest: plan.inputDigest,
      planRevision: plan.revision,
      operationId: null,
      reused: generated.reused,
    } as const;
    const state = stateFor(plan);
    if (state !== 'dispatchable') return { ...base, state, reason: state === 'integration_complete' ? null : state };
    if (deps.dispatch === undefined) return { ...base, state: 'integration_pending', reason: 'dispatch_not_assembled' };
    const dispatchKey = `${plan.integrationId}\u0000${plan.inputDigest}\u0000${plan.revision}`;
    const previousDispatch = dispatched.get(dispatchKey);
    if (previousDispatch !== undefined) {
      return { ...previousDispatch, trigger: request.trigger, reused: true };
    }

    const reservation = deps.dispatch.reserve({
      projectId: plan.projectId,
      batchId: plan.batchId,
      successorFeatureId: plan.successorFeatureId,
      integrationId: plan.integrationId,
      inputDigest: plan.inputDigest,
      planRevision: plan.revision,
      trigger: request.trigger,
    });
    if (reservation.outcome === 'resource_busy') return { ...base, state: 'resource_busy', reason: reservation.reason ?? 'resource_busy' };
    if (reservation.outcome === 'blocked') return { ...base, state: 'integration_pending', reason: reservation.reason ?? 'dispatch_blocked' };
    const dispatchedResult = { ...base, state: 'dispatchable' as const, operationId: reservation.operationId, reason: null };
    dispatched.set(dispatchKey, dispatchedResult);
    return dispatchedResult;
  }

  function reevaluate(request: IntegrationPlanGenerationRequest & { readonly trigger: Trigger }): Promise<IntegrationPlanSchedulerResult> {
    const identity = key(request.projectId, request.batchId);
    const previous = inFlight.get(identity);
    if (previous !== undefined) return previous;
    const promise = run(request);
    inFlight.set(identity, promise);
    return promise.finally(() => {
      if (inFlight.get(identity) === promise) inFlight.delete(identity);
    });
  }

  return {
    onFeatureFinalized(event) {
      if (event.outcome !== 'completed' || event.deliveryStatus !== 'succeeded') {
        return Promise.resolve(resultBase(event.projectId, event.batchId, 'event', { reason: 'feature_delivery_not_succeeded' }));
      }
      return reevaluate({ projectId: event.projectId, batchId: event.batchId, trigger: 'event' });
    },
    reevaluate,
    async scan(input) {
      const candidates = input?.candidates ?? deps.candidates;
      if (candidates === undefined) throw new TypeError(`${OPERATION}.scan: SQLite candidate reader is not assembled`);
      const limit = validateLimit(input?.limit);
      let cursor = input?.after ?? null;
      let pages = 0;
      let processed = 0;
      let bounded = false;
      const results: IntegrationPlanSchedulerResult[] = [];
      const seen = new Set<string>();
      while (pages < 1_000) {
        const page = candidates.list({ after: cursor, limit });
        pages += 1;
        for (const candidate of page.candidates) {
          const identity = key(candidate.projectId, candidate.batchId);
          if (seen.has(identity)) continue;
          seen.add(identity);
          processed += 1;
          results.push(await reevaluate({ projectId: candidate.projectId, batchId: candidate.batchId, trigger: 'scan' }));
        }
        if (!page.hasMore) return { pages, processed, bounded: false, nextCursor: null, results };
        if (page.nextCursor === null) throw new Error(`${OPERATION}.scan: hasMore requires nextCursor`);
        cursor = page.nextCursor;
        bounded = true;
        // A scan is deliberately one page bounded by the caller's limit. The cursor
        // is returned for the next wakeup; it never loops over an unbounded SQLite set.
        return { pages, processed, bounded, nextCursor: cursor, results };
      }
      return { pages, processed, bounded: true, nextCursor: cursor, results };
    },
  };
}
