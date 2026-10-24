import { StorageError } from '../ports/errors.js';
import type {
  SchedulerCandidate,
  SchedulerClaimContext,
  SchedulerHandoff,
  SchedulerRunRef,
  SchedulerRunResult,
  SchedulerScanCursor,
  SchedulerScanResult,
  SchedulerStore,
  SchedulerTimers,
  WorkSchedulerOptions,
} from '../ports/work-scheduler.js';
import type { TaskClaimResult } from '../ports/task-claim.js';
import type { RunRecord } from '../ports/execution-store.js';
import { isFinalizationOnlyRun } from '../ports/finalization-execution.js';
import { PLANNING_RUN_PURPOSE } from '../ports/planning-candidates.js';
import { resolveApprovedBatchConcurrency } from '../ports/feature-dispatch.js';

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
  let compensationCursor: SchedulerScanCursor | null = null;
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

  function featureAdmission(run: SchedulerRunRef & { readonly batchId?: string; readonly featureId?: string }): SchedulerRunResult | null {
    if (options.featureDag === undefined) return null;
    if (options.store.readBatch === undefined || run.batchId === undefined || run.featureId === undefined) {
      const result: SchedulerRunResult = { projectId: run.projectId, runId: run.runId,
        reason: 'scheduler_capability_missing', capabilityGaps: ['feature_dag_admission'], claimed: false, handoff: null };
      options.store.recordRunReason(run.projectId, run.runId, result.reason);
      diagnostics.set(key(run.projectId, run.runId), result);
      return result;
    }
    try {
      const batch = options.store.readBatch(run.projectId, run.batchId);
      const evaluation = options.featureDag.evaluate(run.projectId, batch.phaseId);
      const readiness = evaluation.readiness.find(item => item.featureId === run.featureId);
      if (readiness?.ready === true) return null;
      const reason = readiness?.reason ?? 'invalid_graph';
      const result: SchedulerRunResult = { projectId: run.projectId, runId: run.runId,
        reason, capabilityGaps: [], claimed: false, handoff: null };
      options.store.recordRunReason(run.projectId, run.runId, reason);
      diagnostics.set(key(run.projectId, run.runId), result);
      return result;
    } catch {
      const result: SchedulerRunResult = { projectId: run.projectId, runId: run.runId,
        reason: 'scheduler_capability_missing', capabilityGaps: ['feature_dag_admission'], claimed: false, handoff: null };
      options.store.recordRunReason(run.projectId, run.runId, result.reason);
      diagnostics.set(key(run.projectId, run.runId), result);
      return result;
    }
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
    // F-006：先结算已无活动执行的派发归属/槽位（暂停/取消/终态），再评估 DAG。
    // 结算失败不影响补扫：保留当前占槽，原因由调用方记录并可查询。
    if (options.beforeRun !== undefined) {
      try { await options.beforeRun({ projectId, runId }); } catch { /* caller owns diagnostics */ }
    }
    const run = options.store.readRun(projectId, runId);
    // P05-1 / F-005：planning Run（purpose=plan）在编码 DAG 之前分流——
    // 规划 readiness 依据已授权规划输入和上下文，不要求业务计划批准；
    // planning Task 不进入 coding DAG 调度。
    if (run.purpose === PLANNING_RUN_PURPOSE) {
      return processPlanningRun(projectId, runId, run);
    }
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
      // 仅收尾 Run 不创建编码 Attempt，但同样受槽位/资源准入控制：忙时只持久化
      // 可查询原因并等待后续补扫，不调用 finalization、不启动 Runtime。
      const admitted = options.admission?.check({ projectId, runId }) ?? null;
      if (admitted !== null) {
        options.store.recordRunReason(projectId, runId, admitted);
        const result: SchedulerRunResult = { projectId, runId, reason: 'resource_busy',
          capabilityGaps: [], claimed: false, handoff: null };
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
    const featureBlocked = featureAdmission({ projectId, runId, batchId: run.batchId, featureId: run.featureId });
    if (featureBlocked !== null) return featureBlocked;
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
      // Control diagnostics must not replace the persisted pause reason: verifier
      // completion uses that reason to authorize the pending transition.
      if (dag.reason !== 'run_control_blocked') options.store.recordRunReason(projectId, runId, dag.reason);
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

  /**
   * P05-1 / F-005 planning Run 消费：能力缺口→持久可查询原因；控制中/终态
   * 不认领；准入（槽位/资源）忙时只记录原因；准备/认领/消费全部经注入端口
   * （准备与重核在事务外；认领自有短事务；消费只在回执提交后）。重复投递/
   * 丢失唤醒补扫不会重复创建 Attempt/占槽/扣额（幂等由认领回执与 Task CAS
   * 承担）；租约到期不在这里重新分配写入者（只保留可查询阻塞事实）。
   */
  async function processPlanningRun(projectId: string, runId: string,
    run: { readonly status: string; readonly pauseRequestedAtUtcMs: number | null }): Promise<SchedulerRunResult> {
    const record = (result: SchedulerRunResult, reason: string | null): SchedulerRunResult => {
      // 控制诊断不得覆盖持久暂停原因（与编码分支同一纪律）。
      if (reason !== null && reason !== 'run_control_blocked') options.store.recordRunReason(projectId, runId, reason);
      diagnostics.set(key(projectId, runId), result);
      return result;
    };
    if (options.planning === undefined) {
      return record({ projectId, runId, reason: 'scheduler_capability_missing',
        capabilityGaps: ['planning_consumer'], claimed: false, handoff: null }, 'scheduler_capability_missing');
    }
    if (run.pauseRequestedAtUtcMs !== null || !['queued', 'running'].includes(run.status)) {
      return record({ projectId, runId, reason: 'run_control_blocked',
        capabilityGaps: [], claimed: false, handoff: null }, null);
    }
    const admitted = options.admission?.check({ projectId, runId }) ?? null;
    if (admitted !== null) {
      return record({ projectId, runId, reason: 'resource_busy',
        capabilityGaps: [], claimed: false, handoff: null }, admitted);
    }
    try {
      const input = await options.planning.prepare({ projectId, runId });
      if (closed) {
        return { projectId, runId, reason: 'run_control_blocked', capabilityGaps: [], claimed: false, handoff: null };
      }
      const prepared = input as { readonly projectId?: unknown; readonly runId?: unknown };
      if (prepared.projectId !== projectId || prepared.runId !== runId) {
        throw new StorageError('validation', 'WorkScheduler.planning', 'Prepared planning claim identity does not match the routed Run');
      }
      const claimed: TaskClaimResult = options.planning.claims.claimPlanningTask(input);
      // claimPlanningTask owns and commits its transaction before this callback is reachable.
      if (claimed.replayed) {
        return record({ projectId, runId, reason: 'ready',
          capabilityGaps: [], claimed: false, handoff: null }, null);
      }
      await options.planning.consume(claimed.receipt, { projectId, runId });
      return record({ projectId, runId, reason: 'ready',
        capabilityGaps: [], claimed: true, handoff: null }, null);
    } catch (error) {
      const reason = claimErrorReason(error);
      return record({ projectId, runId, reason: 'claim_rejected',
        capabilityGaps: [], claimed: false, handoff: null }, reason);
    }
  }

  function concurrencyFor(run: RunRecord): number {
    const configured = options.featureConcurrency === undefined
      ? (options.store.readBatch === undefined ? 1 : resolveApprovedBatchConcurrency(options.store.readBatch(run.projectId, run.batchId).configSnapshot))
      : options.featureConcurrency(run);
    return validateBound('featureConcurrency', configured, 1, 16);
  }

  async function runScan(): Promise<SchedulerScanResult> {
    if (closed) return { closed: true, pages: 0, bounded: false, runs: [] };
    const refs: SchedulerRunRef[] = [];
    const processed = new Set<string>();
    let cursor: SchedulerScanCursor | null = compensationCursor;
    let pages = 0;
    let hasMore = true;
    pendingWakes.clear();
    while (hasMore && pages < maxPages) {
      const page = options.store.listActiveRuns({ after: cursor, limit: pageSize });
      pages += 1;
      for (const ref of page.runs) {
        // 分页来源在扫描期间可能因状态推进而重叠；同一 Run 只消费一次。
        const runKey = key(ref.projectId, ref.runId);
        if (processed.has(runKey)) continue;
        processed.add(runKey);
        refs.push(ref);
      }
      // `hasMore` 必须同时具备稳定游标；否则不重复读取同一页。
      hasMore = page.hasMore && (page.nextCursor ?? null) !== null;
      cursor = page.nextCursor ?? null;
      compensationCursor = hasMore ? cursor : null;
    }
    if (closed) return { closed: true, pages, bounded: false, runs: [] };

    // 每个 Batch 使用自己的批准容量；同一 Feature 仍只有一个活动 Run，因而
    // worker 只会并发不同 Feature。claimTask 仍是最终 SQLite 原子准入，worker
    // 并发只是让已批准的不同 Feature 能在同一扫描中越过屏障。
    const results = new Array<SchedulerRunResult | undefined>(refs.length);
    const groups = new Map<string, Array<{ readonly index: number; readonly ref: SchedulerRunRef; readonly run: RunRecord }>>();
    refs.forEach((ref, index) => {
      const run = options.store.readRun(ref.projectId, ref.runId);
      const groupKey = `${run.projectId}\u0000${run.batchId}`;
      const group = groups.get(groupKey) ?? [];
      group.push({ index, ref, run });
      groups.set(groupKey, group);
    });
    await Promise.all([...groups.values()].map(async group => {
      let limit: number;
      try {
        limit = Math.min(concurrencyFor(group[0]!.run), group.length);
      } catch {
        for (const item of group) {
          options.store.recordRunReason(item.ref.projectId, item.ref.runId, 'scheduler_exception');
          results[item.index] = { projectId: item.ref.projectId, runId: item.ref.runId,
            reason: 'scheduler_exception', capabilityGaps: [], claimed: false, handoff: null };
        }
        return;
      }
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const item = group[next++];
          if (item === undefined) return;
          try {
            results[item.index] = await processRun(item.ref.projectId, item.ref.runId);
          } catch {
            // 扫描异常只留下有界诊断；Run/Attempt/槽位事实由已有事务保留，
            // 不在调度器异常路径清理或重置任何持久状态。
            options.store.recordRunReason(item.ref.projectId, item.ref.runId, 'scheduler_exception');
            results[item.index] = { projectId: item.ref.projectId, runId: item.ref.runId,
              reason: 'scheduler_exception', capabilityGaps: [], claimed: false, handoff: null };
          }
        }
      };
      await Promise.all(Array.from({ length: limit }, () => worker()));
    }));
    return { closed: false, pages, bounded: hasMore, runs: results.filter((result): result is SchedulerRunResult => result !== undefined) };
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
