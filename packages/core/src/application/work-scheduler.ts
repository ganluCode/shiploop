import { StorageError } from '../ports/errors.js';
import type {
  SchedulerCandidate,
  SchedulerClaimContext,
  SchedulerHandoff,
  SchedulerRunRef,
  SchedulerRunResult,
  SchedulerScanResult,
  SchedulerStore,
  SchedulerTimers,
  WorkSchedulerOptions,
} from '../ports/work-scheduler.js';
import type { TaskClaimResult } from '../ports/task-claim.js';
import { isFinalizationOnlyRun } from '../ports/finalization-execution.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_PAGE_SIZE = 32;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_WAKEUPS = 256;
const HANDOFF_REASON = 'feature_final_verification_handed_off';

function validateBound(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function claimErrorReason(error: unknown): string {
  if (error instanceof StorageError && typeof error.details?.reason === 'string') {
    return error.details.reason;
  }
  return 'claim_rejected';
}

/**
 * 有界 Work 调度协调器。它只读取 SQLite 权威状态、调用 DAG 评估和 claimTask；
 * 工作区准备、Runtime 启动以及回执后的执行均由注入的窄端口负责。
 */
export function createWorkScheduler(options: WorkSchedulerOptions) {
  const intervalMs = validateBound('intervalMs', options.intervalMs ?? DEFAULT_INTERVAL_MS, 1, 86_400_000);
  const pageSize = validateBound('pageSize', options.pageSize ?? DEFAULT_PAGE_SIZE, 1, 1_000);
  const maxPages = validateBound('maxPages', options.maxPages ?? DEFAULT_MAX_PAGES, 1, 1_000);
  const maxWakeups = validateBound('maxWakeups', options.maxWakeups ?? DEFAULT_MAX_WAKEUPS, 1, 100_000);
  const timers: SchedulerTimers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const pendingWakes = new Set<string>();
  const handedOff = new Set<string>();
  const diagnostics = new Map<string, SchedulerRunResult>();
  let scanPromise: Promise<SchedulerScanResult> | null = null;
  let closePromise: Promise<void> | null = null;
  let compensationCursor: SchedulerRunRef | null = null;
  let timer: unknown = null;
  let started = false;
  let closed = false;
  let lastError: unknown = null;

  function key(projectId: string, runId: string): string {
    return `${projectId}\u0000${runId}`;
  }

  function capabilityGaps(): string[] {
    const gaps: string[] = [];
    if (options.prepareClaim === undefined) gaps.push('workspace_input_preparation');
    if (options.claims === undefined || options.consumeClaim === undefined) gaps.push('committed_claim_consumer');
    return gaps;
  }

  function scheduleTimer(): void {
    if (!started || closed || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (closed) return;
      void scan().catch(error => { lastError = error; }).finally(scheduleTimer);
    }, intervalMs);
  }

  async function processRun(projectId: string, runId: string): Promise<SchedulerRunResult> {
    const run = options.store.readRun(projectId, runId);
    // finalization-only Run 必须在任何 DAG/认领路径之前分流：不得创建编码
    // Attempt、准备 worktree 或启动 Runtime。
    if (isFinalizationOnlyRun(run)) {
      const handoff: SchedulerHandoff = {
        handoffKey: `${runId}:feature_final_verification`, projectId, runId, featureId: run.featureId,
      };
      if (options.store.isFinalVerificationHandoffClaimed(projectId, runId)) {
        if (options.finalizationCompletion !== undefined
          && (run.status === 'queued' || run.status === 'running')) {
          try {
            await options.finalizationCompletion.execute(handoff);
            const result: SchedulerRunResult = { projectId, runId, reason: 'all_passed',
              capabilityGaps: [], claimed: false, handoff: null };
            diagnostics.set(key(projectId, runId), result);
            return result;
          } catch {
            options.store.recordRunReason(projectId, runId, 'finalization_completion_failed');
            const result: SchedulerRunResult = { projectId, runId, reason: 'handoff_delivery_failed',
              capabilityGaps: [], claimed: false, handoff: null };
            diagnostics.set(key(projectId, runId), result);
            return result;
          }
        }
        const result: SchedulerRunResult = { projectId, runId, reason: 'all_passed',
          capabilityGaps: [], claimed: false, handoff: null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
      if (options.finalization === undefined) {
        const result: SchedulerRunResult = { projectId, runId, reason: 'scheduler_capability_missing',
          capabilityGaps: ['feature_finalization_consumer'], claimed: false, handoff: null };
        options.store.recordRunReason(projectId, runId, result.reason);
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
      try {
        const outcome = await options.finalization.execute(handoff);
        const recorded = outcome.recordHandoff ? options.store.recordFinalVerificationHandoff(projectId, runId) : false;
        const result: SchedulerRunResult = { projectId, runId, reason: 'all_passed',
          capabilityGaps: [], claimed: false, handoff: recorded ? handoff : null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      } catch {
        options.store.recordRunReason(projectId, runId, 'handoff_delivery_failed');
        const result: SchedulerRunResult = { projectId, runId, reason: 'handoff_delivery_failed',
          capabilityGaps: [], claimed: false, handoff: null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
    }
    const dag = options.dag.evaluate(projectId, runId);
    const candidate: SchedulerCandidate = { run, dag };
    if (dag.reason === 'all_passed') {
      const handoffKey = `${runId}:feature_final_verification`;
      const handoff: SchedulerHandoff = { handoffKey, projectId, runId, featureId: run.featureId };
      if (options.store.isFinalVerificationHandoffClaimed(projectId, runId)) {
        const result: SchedulerRunResult = { projectId, runId, reason: dag.reason,
          capabilityGaps: [], claimed: false, handoff: null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
      if (options.onHandoff === undefined) {
        const result: SchedulerRunResult = { projectId, runId, reason: 'scheduler_capability_missing',
          capabilityGaps: ['feature_final_verification_consumer'], claimed: false, handoff: null };
        options.store.recordRunReason(projectId, runId, result.reason);
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
      try {
        await options.onHandoff(handoff);
        const recorded = options.store.recordFinalVerificationHandoff(projectId, runId);
        if (recorded) handedOff.add(handoffKey);
        const result: SchedulerRunResult = { projectId, runId, reason: dag.reason,
          capabilityGaps: [], claimed: false, handoff: recorded ? handoff : null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      } catch (error) {
        options.store.recordRunReason(projectId, runId, 'handoff_delivery_failed');
        const result: SchedulerRunResult = { projectId, runId, reason: 'handoff_delivery_failed',
          capabilityGaps: [], claimed: false, handoff: null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
    }
    const gaps = capabilityGaps();
    if (gaps.length > 0 && dag.reason === 'ready') {
      const result: SchedulerRunResult = { projectId, runId, reason: 'scheduler_capability_missing',
        capabilityGaps: gaps, claimed: false, handoff: null };
      options.store.recordRunReason(projectId, runId, result.reason);
      diagnostics.set(key(projectId, runId), result);
      return result;
    }

    if (dag.reason !== 'ready' || dag.readyTaskIds.length === 0) {
      const result: SchedulerRunResult = { projectId, runId, reason: dag.reason,
        capabilityGaps: [], claimed: false, handoff: null };
      options.store.recordRunReason(projectId, runId, dag.reason);
      diagnostics.set(key(projectId, runId), result);
      return result;
    }

    // DAG order is authoritative; only its first candidate may be claimed per scan.
    const taskId = dag.readyTaskIds[0]!;
    const context: SchedulerClaimContext = { candidate, taskId };
    try {
      const input = await options.prepareClaim!(context);
      if (closed) {
        return { projectId, runId, reason: 'run_control_blocked', capabilityGaps: [], claimed: false, handoff: null };
      }
      const prepared = input as { readonly projectId?: unknown; readonly runId?: unknown; readonly taskId?: unknown };
      if (prepared.projectId !== projectId || prepared.runId !== runId || prepared.taskId !== taskId) {
        throw new StorageError('validation', 'WorkScheduler.claim', 'Prepared claim identity does not match DAG candidate');
      }
      const claimed: TaskClaimResult = options.claims!.claimTask(input);
      // claimTask owns and commits its transaction before this callback is reachable.
      if (claimed.replayed) {
        const result: SchedulerRunResult = { projectId, runId, reason: 'ready',
          capabilityGaps: [], claimed: false, handoff: null };
        diagnostics.set(key(projectId, runId), result);
        return result;
      }
      await options.consumeClaim!(claimed.receipt, context);
      const result: SchedulerRunResult = { projectId, runId, reason: 'ready',
        capabilityGaps: [], claimed: !claimed.replayed, handoff: null };
      diagnostics.set(key(projectId, runId), result);
      return result;
    } catch (error) {
      const reason = claimErrorReason(error);
      options.store.recordRunReason(projectId, runId, reason);
      const result: SchedulerRunResult = { projectId, runId, reason: 'claim_rejected',
        capabilityGaps: [], claimed: false, handoff: null };
      diagnostics.set(key(projectId, runId), result);
      return result;
    }
  }

  async function runScan(): Promise<SchedulerScanResult> {
    if (closed) return { closed: true, pages: 0, bounded: false, runs: [] };
    const runs: SchedulerRunResult[] = [];
    let cursor: SchedulerRunRef | null = compensationCursor;
    let pages = 0;
    let hasMore = true;
    pendingWakes.clear();
    while (hasMore && pages < maxPages) {
      const page = options.store.listActiveRuns({ after: cursor, limit: pageSize });
      pages += 1;
      for (const ref of page.runs) runs.push(await processRun(ref.projectId, ref.runId));
      hasMore = page.hasMore;
      const last = page.runs[page.runs.length - 1];
      cursor = last === undefined ? cursor : last;
      compensationCursor = hasMore ? cursor : null;
      if (last === undefined) break;
    }
    if (closed) return { closed: true, pages, bounded: false, runs };
    return { closed: false, pages, bounded: hasMore, runs };
  }

  function scan(): Promise<SchedulerScanResult> {
    if (scanPromise !== null) return scanPromise;
    if (closed) return Promise.resolve({ closed: true, pages: 0, bounded: false, runs: [] });
    const run = runScan();
    // scanPromise 与待处理唤醒统一在结算后清理：runScan 对空页面可能同步
    // 完成，若在扫描内先清空会被外层赋值覆盖，导致后续扫描永久复用已结算
    // Promise，或让扫描期间到达的唤醒丢失。
    scanPromise = run.finally(() => {
      scanPromise = null;
      if (!closed && pendingWakes.size > 0) {
        queueMicrotask(() => { void scan().catch(error => { lastError = error; }); });
      }
    });
    return scanPromise;
  }

  return {
    wake(projectId: string, runId: string): boolean {
      if (closed) return false;
      if (pendingWakes.size < maxWakeups) pendingWakes.add(key(projectId, runId));
      queueMicrotask(() => { if (!closed) void scan().catch(error => { lastError = error; }); });
      return true;
    },
    scan,
    start(): void { if (started || closed) return; started = true; scheduleTimer(); },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closed = true;
      started = false;
      pendingWakes.clear();
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
      closePromise = (async () => {
        if (scanPromise !== null) await scanPromise;
      })();
      return closePromise;
    },
    inspect(projectId: string, runId: string): SchedulerRunResult | null {
      return diagnostics.get(key(projectId, runId)) ?? null;
    },
    lastError(): unknown { return lastError; },
    handoffReason: HANDOFF_REASON,
    handedOffCount(): number { return handedOff.size; },
  };
}
