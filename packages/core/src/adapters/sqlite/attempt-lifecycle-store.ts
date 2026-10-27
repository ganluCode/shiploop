import { createHash, randomUUID } from 'node:crypto';
import { evaluateTaskDag } from '../../application/task-dag.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import { validateTaskExecutionConfig } from '../../application/task-strategy-selection.js';
import { DEFAULT_TASK_MAX_CODE_ATTEMPTS } from '../../ports/execution-budget.js';
import { createSqliteWorkSessionStore } from './work-session-store.js';
import { ACTIVE_ATTEMPT_STATUSES, isPlanningAttemptSnapshot } from '../../ports/attempt-store.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId } from '../../ports/validation.js';
import {
  ATTEMPT_UPDATED_EVENT_TYPE, validateAttemptNotification, validateVerificationSubmission,
  type AttemptApplicationResult, type AttemptLifecycleStore, type VerificationSubmission,
} from '../../ports/attempt-lifecycle.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import type { WorkResourceIdentity, WorkResourceStopVerifier, WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { validateWorkResourceIdentity } from '../../ports/work-resources.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { createSqliteWorkResourceAccess } from './work-resources.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteAttemptLifecycleStore extends AttemptLifecycleStore {
  /** Trusted composition only: joins workspace/result CAS without opening a nested transaction. */
  recordWorkspaceRetentionInTransaction(transaction: CommandTransaction, identity: WorkResourceIdentity,
    expectedRevision: number, evidenceRef: string): void;
  applyPreparationFailureInTransaction(transaction: CommandTransaction, input: unknown,
    isolation: 'unstarted' | 'uncertain'): AttemptApplicationResult;
  /** F-012：同库短写事务内提交验证结论（供授权显式继续命令复用，不开嵌套事务）。 */
  submitVerificationInTransaction(transaction: CommandTransaction, input: unknown, verifierStopEvidence?: unknown): AttemptApplicationResult;
  /** F-012：验证汇总前记录 Attempt 代码现场制品引用（verifying CAS；不改变状态）。 */
  recordAttemptCode(input: unknown): { readonly attemptId: string; readonly revision: number; readonly codeRef: string };
}

/** Owns a short committing transaction; no Runtime, Git, filesystem or process I/O. */
export function createSqliteAttemptLifecycleStore(session: SqliteStorageSession, options: {
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly stopVerifier?: Pick<WorkResourceStopVerifier, 'inspect'>;
  readonly nowUtcMs?: () => number;
}): SqliteAttemptLifecycleStore {
  const operation = 'AttemptLifecycle.apply';
  const db = session.database;
  const attempts = createSqliteAttemptAccess(session);
  const executions = createSqliteExecutionAccess(session, options);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const resources = createSqliteWorkResourceAccess(session, options);
  const dag = createSqliteTaskDagStore(session);
  // F-012：占用感知隔离——占用可能已在 apply(runtime_completed) 按停止证据
  // 释放（0 租约）；仅当仍有租约行时才转为隔离，避免对空占用误抛 not_occupied。
  const quarantineIfOccupied = (identity: WorkResourceIdentity) => {
    if (resources.read(identity).leases.length > 0) resources.quarantineInTransaction(identity);
  };
  const sessions = createSqliteWorkSessionStore(session, options);
  /**
   * P03-9 / F-001：在 Attempt 收尾后落实已持久化的暂停意图。
   * 有活动 Attempt 时保持 pausing（当前 Attempt 可继续验证/必要收尾），全部
   * 活动 Attempt 消失后才转为 paused；只触及控制状态/reason/意图时刻，不改
   * 预算、deadline、累计计数或代码。无暂停意图时完全 no-op。
   */
  function finalizePauseIntentInTransaction(projectId: string, runId: string, now: number): void {
    const row = db.prepare<[string, string], {
      run_status: string; run_revision: number; run_pause: number | null;
      batch_id: string; batch_status: string; batch_revision: number; batch_pause: number | null;
    }>(`SELECT runs.status AS run_status, runs.revision AS run_revision,
        runs.pause_requested_at AS run_pause, execution_batches.id AS batch_id,
        execution_batches.status AS batch_status, execution_batches.revision AS batch_revision,
        execution_batches.pause_requested_at AS batch_pause
      FROM runs JOIN execution_batches ON execution_batches.id = runs.batch_id
      WHERE runs.project_id = ? AND runs.id = ?`).get(projectId, runId);
    if (row === undefined || (row.run_pause === null && row.batch_pause === null)) return;
    const pauseAt = row.run_pause ?? row.batch_pause!;
    if (['succeeded', 'failed', 'cancelled', 'cancelling', 'interrupted'].includes(row.run_status)) {
      // Terminal/uncertain Run remains authoritative; never rewrite it from a pause intent.
    } else {
      const active = db.prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM attempts WHERE project_id = ? AND run_id = ?
          AND status IN ('preparing', 'executing', 'verifying')`,
      ).get(projectId, runId)!.count;
      const status = active > 0 ? 'pausing' : 'paused';
      db.prepare(`UPDATE runs SET status = ?, reason = 'user_pause',
        pause_requested_at = COALESCE(pause_requested_at, ?), revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND revision = ?
          AND status IN ('queued', 'running', 'pausing', 'paused')
          AND (status <> ? OR reason IS NULL OR reason <> 'user_pause' OR pause_requested_at IS NULL)`)
        .run(status, pauseAt, now, projectId, runId, row.run_revision, status);
    }
    if (row.batch_pause === null) return;
    if (['succeeded', 'failed', 'cancelled', 'cancelling', 'interrupted'].includes(row.batch_status)) return;
    const activeBatch = db.prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count FROM attempts WHERE project_id = ? AND run_id IN
        (SELECT id FROM runs WHERE project_id = ? AND batch_id = ?)
        AND status IN ('preparing', 'executing', 'verifying')`,
    ).get(projectId, projectId, row.batch_id)!.count;
    const batchStatus = activeBatch > 0 ? 'pausing' : 'paused';
    db.prepare(`UPDATE execution_batches SET status = ?, reason = 'user_pause',
      pause_requested_at = COALESCE(pause_requested_at, ?), revision = revision + 1, updated_at = ?
      WHERE project_id = ? AND id = ? AND revision = ?
        AND status IN ('queued', 'running', 'pausing', 'paused')
        AND (status <> ? OR reason IS NULL OR reason <> 'user_pause' OR pause_requested_at IS NULL)`)
      .run(batchStatus, row.batch_pause, now, projectId, row.batch_id, row.batch_revision, batchStatus);
  }
  function applyInTransaction(transaction: CommandTransaction, input: unknown, stopEvidence?: unknown,
    preparationIsolated = false): AttemptApplicationResult {
      if (!db.inTransaction) throw new TypeError('Attempt lifecycle primitive requires a write transaction');
      const valid = validateAttemptNotification(input);
      const identity: WorkResourceIdentity = { projectId: valid.projectId, attemptId: valid.attemptId,
        owner: valid.owner, hostInstanceId: valid.hostInstanceId, executionVersion: valid.executionVersion };
      const digest = createHash('sha256').update(stableStringify(valid)).digest('hex');
      const runtime = valid.kind === 'runtime_settled' ? valid.runtime : null;
      const targetStatus = valid.kind === 'executing' ? 'executing'
        : runtime !== null ? runtime.control !== undefined && runtime.stopped?.confirmed !== true ? 'interrupted'
          : runtime.control?.reason === 'user_cancelled' || runtime.control?.reason === 'service_close' ? 'cancelled'
          : runtime.failure === null && runtime.result?.terminal === 'completed' ? 'verifying' : 'failed'
        : valid.kind === 'preparation_failed' || (valid.kind === 'runtime_completed' && valid.exitCode !== 0) ? 'failed' : 'verifying';
        const now = (options.nowUtcMs ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < 1) throw new StorageError('validation', operation, 'Invalid lifecycle clock');
        const row = db.prepare<[string], { project_id: string }>('SELECT project_id FROM attempts WHERE id = ?').get(valid.attemptId);
        const ignored = (reason: 'stale_execution_identity' | 'invalid_transition' | 'notification_id_reused'): AttemptApplicationResult => {
          // Never retain raw untrusted identifiers, messages, output, usage or credentials.
          if (row?.project_id === valid.projectId) db.prepare(`INSERT OR IGNORE INTO attempt_notification_diagnostics
            (id, project_id, attempt_id, notification_digest, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), valid.projectId, valid.attemptId, digest, reason, now);
          return { disposition: 'ignored', attemptId: valid.attemptId, status: null, reason,
            waitingFor: null, runtimeCompleted: false, resultSaved: false, stopConfirmed: false, eventId: null };
        };
        if (row?.project_id !== valid.projectId) return ignored('stale_execution_identity');
        const attempt = attempts.getAttempt(valid.projectId, valid.attemptId);
        const task = db.prepare<[string], { execution_version: number; status: string; manual_block: number }>(
          'SELECT execution_version, status, manual_block FROM tasks WHERE id = ?').get(attempt.taskId)!;
        if (attempt.owner !== valid.owner || attempt.hostInstanceId !== valid.hostInstanceId
          || attempt.executionVersion !== valid.executionVersion || task.execution_version !== valid.executionVersion
          || attempt.taskId !== valid.taskId || attempt.runId !== valid.runId) return ignored('stale_execution_identity');
        const previous = db.prepare<[string, string], { request_digest: string; receipt: string }>(
          'SELECT request_digest, receipt FROM attempt_notifications WHERE attempt_id = ? AND notification_id = ?')
          .get(valid.attemptId, valid.notificationId);
        if (previous) {
          if (previous.request_digest !== digest) return ignored('notification_id_reused');
          try {
            const context = { operation };
            const receipt = requirePlainObject(JSON.parse(previous.receipt), context, 'receipt');
            rejectUnknownKeys(receipt, ['disposition', 'attemptId', 'status', 'reason', 'waitingFor', 'runtimeCompleted', 'resultSaved', 'stopConfirmed', 'eventId'], context, 'receipt');
            validateStableId(receipt.eventId, context, 'eventId');
            // P05-1 / F-007：planning 结算回执无等待语义（无验证/审批等待），
            // 终态集合由 planning 分支定义（executing/succeeded/failed/cancelled/interrupted）。
            if (isPlanningAttemptSnapshot(attempt.inputSnapshot)) {
              if (receipt.disposition !== 'applied' || receipt.attemptId !== attempt.id || receipt.reason !== null
                || receipt.waitingFor !== null
                || !['succeeded', 'failed', 'cancelled', 'interrupted', 'executing'].includes(String(receipt.status))
                || ![receipt.runtimeCompleted, receipt.resultSaved, receipt.stopConfirmed].every(v => typeof v === 'boolean')
                || receipt.resultSaved !== (valid.kind !== 'executing')
                || receipt.runtimeCompleted !== (runtime !== null ? runtime.result?.terminal === 'completed' : false)
                || (valid.kind === 'executing' && (receipt.status !== 'executing' || receipt.stopConfirmed !== false))) throw new Error('invalid_receipt');
              return { ...receipt, disposition: 'replayed' } as unknown as AttemptApplicationResult;
            }
            if (receipt.disposition !== 'applied' || receipt.attemptId !== attempt.id || receipt.reason !== null
              || receipt.status !== targetStatus
              || (runtime !== null && targetStatus === 'verifying'
                ? !['approval', 'verification_not_assembled', 'recording_required', 'execution_uncertain'].includes(String(receipt.waitingFor))
                : valid.kind === 'runtime_completed' && valid.exitCode === 0
                  ? !['approval', 'verification_not_assembled'].includes(String(receipt.waitingFor)) : receipt.waitingFor !== null)
              || ![receipt.runtimeCompleted, receipt.resultSaved, receipt.stopConfirmed].every(v => typeof v === 'boolean')
              || receipt.runtimeCompleted !== (runtime !== null ? runtime.result?.terminal === 'completed' : valid.kind === 'runtime_completed')
              || receipt.resultSaved !== (valid.kind !== 'executing')
              || (valid.kind === 'executing' && receipt.stopConfirmed !== false)) throw new Error('invalid_receipt');
            return { ...receipt, disposition: 'replayed' } as unknown as AttemptApplicationResult;
          } catch { throw new StorageError('corrupt', operation, 'Invalid persisted Attempt notification receipt'); }
        }
        if (!ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number])
          || task.status !== 'running'
          || (valid.kind === 'executing' && (attempt.status !== 'preparing' || attempt.executionStage !== 'runtime'))
          || (valid.kind === 'preparation_failed' && attempt.status !== 'preparing')
          || (valid.kind === 'runtime_completed' && attempt.status !== 'executing')
          || (runtime !== null && !['preparing', 'executing'].includes(attempt.status))) return ignored('invalid_transition');
        if (now < (attempt.startedAtUtcMs ?? attempt.createdAtUtcMs)) throw new StorageError('validation', operation, 'Lifecycle clock precedes Attempt');
        const occupied = resources.read(identity);
        if (valid.kind === 'executing' && (occupied.leases.length !== 3 || occupied.leases.some(l => l.state !== 'held' || l.leaseUntilUtcMs <= now)
          || occupied.invocationId === null
          || (occupied.processIdentity === null && !isPlanningAttemptSnapshot(attempt.inputSnapshot)))) return ignored('invalid_transition');
        if (valid.kind !== 'executing') transaction.getArtifactInputRef(valid.projectId, valid.evidenceRef);
        let settlementRevision = attempt.revision;
        const workSession = runtime === null ? null : sessions.getWorkSession(valid.projectId, runtime.sessionId);
        if (runtime !== null) {
          if (workSession === null || workSession.attemptId !== attempt.id
            || !['reserved', 'started'].includes(workSession.status) || attempt.invocationId !== runtime.invocationId) return ignored('stale_execution_identity');
          if (runtime.recording.manifestRef !== null) transaction.getArtifactInputRef(valid.projectId, runtime.recording.manifestRef);
          const recordingGaps = [...new Set([
            ...(!runtime.recording.complete ? [runtime.recording.mode === 'best_effort' ? 'best_effort_partial' : 'recording_required'] : []),
            ...(!runtime.stopped?.confirmed ? ['stop_unconfirmed'] : []),
            ...(workSession.recordingGaps ?? []), ...(runtime.recording.gaps ?? []),
          ])];
          const ended = sessions.applyWorkSessionProgressInTransaction(transaction, { ...identity, sessionId: runtime.sessionId,
            expectedRevision: workSession.revision, kind: 'ended', executionStage: targetStatus === 'verifying' ? 'verification' : 'runtime',
            resultRef: valid.kind === 'runtime_settled' ? valid.evidenceRef : null,
            ...(runtime.result?.providerSessionId == null ? {} : { providerSessionId: runtime.result.providerSessionId }),
            recordingGaps: recordingGaps.length <= 32 ? recordingGaps : [...recordingGaps.slice(0, 31), 'gaps_overflow'] });
          if (runtime.stopped?.confirmed) sessions.applyWorkSessionProgressInTransaction(transaction, { ...identity,
            sessionId: runtime.sessionId, expectedRevision: ended.session.revision, kind: 'stopped' });
          settlementRevision = attempts.getAttempt(valid.projectId, valid.attemptId).revision;
        }
        // P05-1 / F-007：planning Attempt 走独立生命周期结算（executing/preparation_
        // failed/runtime_settled）；成功仅在本 Run 存在已发布候选且停止/记录/终态
        // 全部满足时成立，不进入编码验证/提交/审批路径。
        if (isPlanningAttemptSnapshot(attempt.inputSnapshot)) {
          return applyPlanningInTransaction(transaction, { valid, identity, attempt, runtime, targetStatus, now, digest, settlementRevision,
            preparationIsolated });
        }
        const approval = verifyFeaturePlanApprovalInTransaction(transaction, valid.projectId, attempt.featureId);
        const view = dag.readTaskDagView(valid.projectId, attempt.runId);
        const graph = evaluateTaskDag(view, now);
        const snapshot = attempt.inputSnapshot.approval;
        const approvalWaiting = task.manual_block === 1 || !approval.validity.valid
          || approval.planDigest !== snapshot.planDigest || approval.checkPolicyDigest !== snapshot.checkPolicyDigest
          || approval.currentDecision?.id !== snapshot.decisionId || graph.reason === 'invalid_graph';
        let stopConfirmed = false;
        if (runtime !== null) {
          stopConfirmed = runtime.stopped?.confirmed === true;
          // Runtime stop is an observation, not authorization to release a workspace before verification/retention.
          if (!stopConfirmed || targetStatus !== 'verifying') resources.quarantineInTransaction(identity);
          // Runtime failures are infrastructure observations, not deterministic code-check
          // failures. Refund only the provisional code slot; total Attempt/start debits remain.
          if (runtime.failure !== null) transaction.reclassifyTaskAttemptAsInfrastructure({
            projectId: valid.projectId, taskId: valid.taskId, attemptKey: valid.attemptId,
            reason: `runtime_failed:${runtime.failure.kind}`,
          });
        } else if (valid.kind === 'preparation_failed') {
          const unstarted = !preparationIsolated && attempt.invocationId === null && attempt.startedAtUtcMs === null
            && attempt.executionStage === 'preflight' && occupied.leases.every(l => l.processIdentity === null);
          if (unstarted) {
            resources.releaseUnstartedInTransaction(identity);
            stopConfirmed = true;
          } else resources.quarantineInTransaction(identity);
          transaction.reclassifyTaskAttemptAsInfrastructure({ projectId: valid.projectId, taskId: valid.taskId,
            attemptKey: valid.attemptId, reason: `preparation_failed:${valid.errorKind}` });
        } else if (valid.kind === 'runtime_completed') {
          if (stopEvidence !== undefined) {
            resources.releaseStoppedInTransaction(identity, stopEvidence);
            stopConfirmed = true;
          } else resources.quarantineInTransaction(identity);
        }
        const status = targetStatus;
        const stage = valid.kind === 'executing' ? 'runtime' : valid.kind === 'preparation_failed' ? attempt.executionStage
          : targetStatus === 'verifying' ? 'verification' : 'runtime';
        const errorKind = runtime !== null ? targetStatus === 'cancelled' ? null : runtime.failure?.kind ?? (targetStatus === 'failed' ? 'runtime' : null)
          : valid.kind === 'preparation_failed' ? valid.errorKind
            : valid.kind === 'runtime_completed' && valid.exitCode !== 0 ? 'runtime' : null;
        const startedAt = attempt.startedAtUtcMs ?? workSession?.startedAtUtcMs ?? null;
        const changed = db.prepare(`UPDATE attempts SET status = ?, execution_stage = ?, error_kind = ?, diagnostic_ref = ?,
          started_at = ?, ended_at = ?, exit_code = ?, duration_ms = ?, usage_summary = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?
          AND status IN ('preparing', 'executing', 'verifying')
          AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ? AND status = 'running')`)
          .run(status, stage, errorKind, valid.kind === 'executing' ? null : valid.evidenceRef,
            valid.kind === 'executing' ? now : startedAt, valid.kind === 'executing' ? null : now,
            runtime !== null ? runtime.result?.exitCode ?? null : valid.kind === 'runtime_completed' ? valid.exitCode : null,
            runtime !== null ? runtime.result?.durationMs ?? null : valid.kind === 'executing' || startedAt === null ? null : now - startedAt,
            // Preserve synthetic observations with their basis in the result Artifact; never book them as real usage.
            runtime?.result?.usage?.basis === 'reported' ? JSON.stringify({ schemaVersion: 1,
              inputTokens: runtime.result.usage.inputTokens, outputTokens: runtime.result.usage.outputTokens,
              costMicros: runtime.result.usage.costUsdMicros,
              currency: runtime.result.usage.costUsdMicros === null ? null : 'USD' }) : null,
            now, attempt.id, valid.owner, valid.hostInstanceId, valid.executionVersion, settlementRevision, valid.executionVersion);
        if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Attempt CAS failed');
        // Never clear manual_block, grant acceptance or reset budgets, even for exitCode 0.
        const taskChanged = db.prepare(`UPDATE tasks SET status = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`)
          .run(status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'running', now, valid.taskId, valid.executionVersion);
        if (taskChanged.changes !== 1) throw new StorageError('conflict', operation, 'Task execution CAS failed');
        const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
        const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
          aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
        const waitingFor: AttemptApplicationResult['waitingFor'] = runtime !== null && targetStatus === 'verifying'
          ? approvalWaiting ? 'approval' : !stopConfirmed ? 'execution_uncertain'
            : !runtime.recording.complete && runtime.recording.mode !== 'best_effort' ? 'recording_required' : 'verification_not_assembled'
          : valid.kind === 'runtime_completed' && valid.exitCode === 0
            ? approvalWaiting ? 'approval' : 'verification_not_assembled' : null;
        if (runtime !== null) {
          // A single transaction fences the result, Session, phase, pause, occupancy and notification event.
          db.prepare(`UPDATE runs SET status = 'paused', reason = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing')`)
            .run(waitingFor ?? runtime.control?.reason ?? runtime.failure?.reason ?? runtime.result?.reason ?? 'runtime_failed', now, valid.runId, valid.projectId);
        }
        finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
        const receipt: AttemptApplicationResult = { disposition: 'applied', attemptId: attempt.id, status, reason: null,
          waitingFor, runtimeCompleted: runtime !== null ? runtime.result?.terminal === 'completed' : valid.kind === 'runtime_completed',
          resultSaved: valid.kind !== 'executing', stopConfirmed, eventId };
        db.prepare(`INSERT INTO attempt_notifications (id, project_id, attempt_id, notification_id, request_digest, receipt)
          VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), valid.projectId, attempt.id, valid.notificationId, digest, JSON.stringify(receipt));
        return receipt;
  }
  /**
   * P05-1 / F-007 planning Attempt 生命周期结算（同一短写事务内完成）：
   * - executing：已认领启动（Runtime 会话已开始）→ Attempt executing + Run/Batch
   *   queued→running（工具通道准入依赖这些事实）；
   * - preparation_failed：启动前确定性失败 → Attempt/Task failed + Run failed（规划
   *   重试只能由新的 planning.start 授权；未真正启动时释放占用，否则隔离）；
   * - runtime_settled：成功仅当本 Run 已发布候选（上下文 candidate_published 且
   *   候选制品绑定）+ Runtime 正常完成 + 停止确认 + required 记录完整；否则按
   *   受控原因失败（候选缺失/记录不完整/停止未确认均不伪造成功）。P05-1 /
   *   F-009：取消/中断控制先获胜（Run 已 cancelling/interrupted）时，迟到成功
   *   降级为 cancelled、迟到结果不覆盖控制状态也不结算 Run 终态（由取消/停止
   *   核验路径收尾），Attempt/Task/预算事实仍在同一事务内落库。
   * 预算：成功 settle passed；确定性失败 settle non_code_failure（规划不消耗代码
   * 返工次数）；Run 终态经 settleExecutionRunOutcome（幂等 resultKey）。
   */
  function applyPlanningInTransaction(transaction: CommandTransaction, input: {
    readonly valid: ReturnType<typeof validateAttemptNotification>;
    readonly identity: WorkResourceIdentity;
    readonly attempt: import('../../ports/attempt-store.js').AttemptRecord;
    readonly runtime: import('../../ports/runtime-settlement.js').RuntimeSettlementFacts | null;
    readonly targetStatus: string;
    readonly now: number;
    readonly digest: string;
    readonly settlementRevision: number;
    readonly preparationIsolated: boolean;
  }): AttemptApplicationResult {
    if (!db.inTransaction) throw new TypeError('Planning lifecycle requires a write transaction');
    const { valid, identity, attempt, runtime, targetStatus, now, digest, settlementRevision } = input;
    const snapshot = attempt.inputSnapshot;
    if (!isPlanningAttemptSnapshot(snapshot)) throw new TypeError('Planning lifecycle requires a planning snapshot');
    const persist = (receipt: AttemptApplicationResult): AttemptApplicationResult => {
      db.prepare('INSERT INTO attempt_notifications (id, project_id, attempt_id, notification_id, request_digest, receipt)\n          VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), valid.projectId, attempt.id, valid.notificationId, digest, JSON.stringify(receipt));
      return receipt;
    };
    /* 规划上下文（按 Run 绑定；同事务权威读）。 */
    const contextRow = db.prepare<[string, string], {
      run_id: string; planning_task_id: string; candidate_id: string; status: string;
      candidate_artifact_id: string | null;
    }>('SELECT run_id, planning_task_id, candidate_id, status, candidate_artifact_id FROM planning_contexts WHERE project_id = ? AND run_id = ?')
      .get(valid.projectId, valid.runId);

    /* ---- executing：Runtime 会话已开始 → executing + Run/Batch running ---- */
    if (valid.kind === 'executing') {
      const changed = db.prepare(`UPDATE attempts SET status = 'executing', started_at = ?, updated_at = ?, revision = revision + 1\n        WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?\n        AND status = 'preparing' AND execution_stage = 'runtime' AND invocation_id IS NOT NULL`)
        .run(now, now, valid.attemptId, valid.owner, valid.hostInstanceId, valid.executionVersion, settlementRevision);
      if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Planning executing CAS failed');
      db.prepare(`UPDATE runs SET status = 'running', reason = NULL, revision = revision + 1, updated_at = ?\n        WHERE id = ? AND project_id = ? AND status = 'queued'`).run(now, valid.runId, valid.projectId);
      db.prepare(`UPDATE execution_batches SET status = 'running', reason = NULL, revision = revision + 1, updated_at = ?\n        WHERE id = (SELECT batch_id FROM runs WHERE project_id = ? AND id = ?) AND project_id = ? AND status = 'queued'`)
        .run(now, valid.projectId, valid.runId, valid.projectId);
      finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
      const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
      const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
        aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
      return persist({ disposition: 'applied', attemptId: valid.attemptId, status: 'executing', reason: null, waitingFor: null,
        runtimeCompleted: false, resultSaved: false, stopConfirmed: false, eventId });
    }

    /* ---- preparation_failed：启动前确定性失败（Attempt/Task/Run 全部 failed） ---- */
    if (valid.kind === 'preparation_failed') {
      const occupiedNow = resources.read(identity);
      const unstarted = !input.preparationIsolated && attempt.invocationId === null && attempt.startedAtUtcMs === null
        && attempt.executionStage === 'preflight' && occupiedNow.leases.every(l => l.processIdentity === null);
      let stopConfirmed = false;
      if (unstarted) {
        resources.releaseUnstartedInTransaction(identity);
        stopConfirmed = true;
      } else resources.quarantineInTransaction(identity);
      transaction.reclassifyTaskAttemptAsInfrastructure({ projectId: valid.projectId, taskId: valid.taskId,
        attemptKey: valid.attemptId, reason: `planning_preparation_failed:${valid.errorKind}` });
      const changed = db.prepare(`UPDATE attempts SET status = 'failed', execution_stage = ?, error_kind = ?, diagnostic_ref = ?,\n        ended_at = ?, updated_at = ?, revision = revision + 1\n        WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?\n        AND status = 'preparing' AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ? AND status = 'running')`)
        .run(attempt.executionStage, valid.errorKind, valid.evidenceRef, now, now, valid.attemptId, valid.owner,
          valid.hostInstanceId, valid.executionVersion, settlementRevision, valid.executionVersion);
      if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Planning preparation failure CAS failed');
      const taskChanged = db.prepare(`UPDATE tasks SET status = 'failed', revision = revision + 1, updated_at = ?\n        WHERE id = ? AND execution_version = ? AND status = 'running'`).run(now, valid.taskId, valid.executionVersion);
      if (taskChanged.changes !== 1) throw new StorageError('conflict', operation, 'Planning preparation Task CAS failed');
      settlePlanningRunOutcome(transaction, valid, 'failed', `planning_preparation_failed:${valid.errorKind}`, null);
      transaction.settleTaskAttemptBudget({ projectId: valid.projectId, batchId: batchIdOf(valid), runId: valid.runId,
        taskId: valid.taskId, attemptKey: valid.attemptId, outcome: 'non_code_failure', observationDigest: digest });
      finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
      const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
      const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
        aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
      return persist({ disposition: 'applied', attemptId: valid.attemptId, status: 'failed', reason: null, waitingFor: null,
        runtimeCompleted: false, resultSaved: true, stopConfirmed, eventId });
    }

    if (valid.kind !== 'runtime_settled' || runtime === null) {
      throw new StorageError('conflict', operation, 'Planning Attempt does not accept this notification kind', {
        details: { reason: 'planning_notification_unsupported', kind: valid.kind },
      });
    }

    /* ---- runtime_settled：候选绑定 + 停止/记录/终态全部满足才成功 ---- */
    const contextBound = contextRow !== undefined && contextRow.run_id === valid.runId
      && contextRow.planning_task_id === valid.taskId && contextRow.candidate_id === snapshot.candidateId
      && ['candidate_published', 'applied', 'rejected'].includes(contextRow.status)
      && contextRow.candidate_artifact_id !== null;
    const recordingOk = runtime.recording.mode === 'best_effort' || runtime.recording.complete;
    const stopConfirmed = runtime.stopped?.confirmed === true;
    /* P05-1 / F-009：持久控制版本裁决——取消意图先提交（Run 已 cancelling/
     * interrupted）时，迟到的成功/失败结果不覆盖控制状态，也不得成功收尾；
     * Run 收尾由取消/停止核验路径拥有，本事务只落 Attempt/Task/预算事实。 */
    const runStatusRow = db.prepare<[string, string], { status: string }>(
      'SELECT status FROM runs WHERE project_id = ? AND id = ?').get(valid.projectId, valid.runId);
    if (runStatusRow === undefined) throw new StorageError('not_found', operation, 'Planning settlement Run is missing');
    const controlWon = runStatusRow.status === 'cancelling' || runStatusRow.status === 'interrupted';
    const runOutcomeSettleable = ['queued', 'running', 'pausing', 'paused'].includes(runStatusRow.status);
    const success = !controlWon && targetStatus === 'verifying' && contextBound && recordingOk && stopConfirmed;
    // 成功保留占用由受信 retention 路径凭停止证据释放；其余一律隔离（不确定/失败现场不重分配）。
    if (!success) {
      resources.quarantineInTransaction(identity);
      // 规划失败不消耗代码返工次数（基础设施口径）。
      transaction.reclassifyTaskAttemptAsInfrastructure({ projectId: valid.projectId, taskId: valid.taskId,
        attemptKey: valid.attemptId, reason: `planning_failed:${targetStatus}` });
    }
    const startupFailure = !success && targetStatus === 'interrupted' && runtime.result === null
      && runtime.failure !== null && runtime.control?.reason === 'runtime_failed';
    const finalStatus: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' = success ? 'succeeded'
      : startupFailure ? 'failed'
      : controlWon && targetStatus === 'verifying' ? 'cancelled'
      : targetStatus === 'verifying' ? 'failed'
      : targetStatus === 'cancelled' ? 'cancelled' : 'interrupted';
    const failureReason = success ? null
      : targetStatus === 'verifying' ? (!contextBound ? 'planning_candidate_missing' : !recordingOk ? 'recording_required' : 'stop_unconfirmed')
      : runtime.control?.reason ?? runtime.failure?.reason ?? `runtime_${targetStatus}`;
    const errorKind = success ? null
      : finalStatus === 'cancelled' ? null : runtime.failure?.kind ?? (finalStatus === 'interrupted' ? 'process' : 'runtime');
    const startedAt = attempt.startedAtUtcMs ?? null;
    const changed = db.prepare(`UPDATE attempts SET status = ?, execution_stage = ?, error_kind = ?, diagnostic_ref = ?,\n      ended_at = ?, exit_code = ?, duration_ms = ?, usage_summary = ?, updated_at = ?, revision = revision + 1\n      WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?\n      AND status IN ('preparing', 'executing')\n      AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ? AND status = 'running')`)
      .run(finalStatus, success ? 'verification' : 'runtime', errorKind, valid.evidenceRef, now,
        runtime.result?.exitCode ?? null,
        startedAt === null ? null : now - startedAt,
        // 保留合成观察的用量事实；绝不把未知记为 0。
        runtime.result?.usage?.basis === 'reported' ? JSON.stringify({ schemaVersion: 1,
          inputTokens: runtime.result.usage.inputTokens, outputTokens: runtime.result.usage.outputTokens,
          costMicros: runtime.result.usage.costUsdMicros,
          currency: runtime.result.usage.costUsdMicros === null ? null : 'USD' }) : null,
        now, valid.attemptId, valid.owner, valid.hostInstanceId, valid.executionVersion, settlementRevision, valid.executionVersion);
    if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Planning settlement CAS failed');
    // Never clear manual_block, grant acceptance or reset budgets, even for a published candidate.
    const taskChanged = db.prepare(`UPDATE tasks SET status = ?, revision = revision + 1, updated_at = ?\n      WHERE id = ? AND execution_version = ? AND status = 'running'`)
      .run(finalStatus === 'succeeded' ? 'passed' : finalStatus === 'cancelled' ? 'cancelled'
        : finalStatus === 'failed' ? 'failed' : 'running', now, valid.taskId, valid.executionVersion);
    if (taskChanged.changes !== 1) throw new StorageError('conflict', operation, 'Planning settlement Task CAS failed');
    if (finalStatus === 'succeeded' || finalStatus === 'failed') {
      // P05-1 / F-009：Run 已处控制/终态时，结算原语会拒绝迟到结果并回滚
      // Attempt 事实；改为跳过 Run 收尾（由取消/停止核验路径拥有），预算仍结算。
      if (runOutcomeSettleable) {
        settlePlanningRunOutcome(transaction, valid, finalStatus,
          finalStatus === 'succeeded' ? 'planning_candidate_published' : failureReason!,
          finalStatus === 'succeeded' ? valid.taskId : null);
      }
      transaction.settleTaskAttemptBudget({ projectId: valid.projectId, batchId: batchIdOf(valid), runId: valid.runId,
        taskId: valid.taskId, attemptKey: valid.attemptId,
        outcome: finalStatus === 'succeeded' ? 'passed' : 'non_code_failure', observationDigest: digest });
    } else {
      // 取消/中断控制路径不终结 Run（cancelling/interrupted 不在 CAS 范围）；
      // 无控制意图时保留可查询原因的暂停事实，收尾由取消/停止核验路径承担。
      db.prepare(`UPDATE runs SET status = 'paused', reason = ?, revision = revision + 1, updated_at = ?\n        WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing')`)
        .run(failureReason ?? 'runtime_interrupted', now, valid.runId, valid.projectId);
    }
    finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
    const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
    const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
      aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
    return persist({ disposition: 'applied', attemptId: valid.attemptId, status: finalStatus, reason: null, waitingFor: null,
      runtimeCompleted: runtime.result?.terminal === 'completed', resultSaved: true, stopConfirmed, eventId });
  }

  function batchIdOf(valid: { readonly projectId: string; readonly runId: string }): string {
    const row = db.prepare<[string, string], { batch_id: string }>(
      'SELECT batch_id FROM runs WHERE project_id = ? AND id = ?').get(valid.projectId, valid.runId);
    if (row === undefined) throw new StorageError('not_found', operation, 'Planning settlement Run is missing');
    return row.batch_id;
  }

  /** planning Run 终态结算（幂等 resultKey；进展证据 = planning Task 首次 passed）。 */
  function settlePlanningRunOutcome(transaction: CommandTransaction,
    valid: { readonly projectId: string; readonly runId: string },
    outcome: 'succeeded' | 'failed', reason: string, progressTaskId: string | null): void {
    const row = db.prepare<[string, string], { batch_id: string; revision: number }>(
      'SELECT batch_id, revision FROM runs WHERE project_id = ? AND id = ?').get(valid.projectId, valid.runId);
    if (row === undefined) throw new StorageError('not_found', operation, 'Planning outcome Run is missing');
    executions.settleExecutionRunOutcomeInTransaction({
      projectId: valid.projectId, batchId: row.batch_id, runId: valid.runId,
      runRevision: row.revision, resultKey: `planning:${valid.runId}`,
      outcome, reason,
      ...(progressTaskId === null ? {} : { progressEvidence: { type: 'new_valid_task_passed' as const, taskId: progressTaskId } }),
    });
  }

  function submitVerificationInTransaction(transaction: CommandTransaction, input: unknown, verifierStopEvidence?: unknown): AttemptApplicationResult {
    if (!db.inTransaction) throw new TypeError('Verification submission requires a write transaction');
    const valid: VerificationSubmission = validateVerificationSubmission(input);
    const now = (options.nowUtcMs ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 1) throw new StorageError('validation', operation, 'Invalid lifecycle clock');
    const ignored = (reason: 'stale_execution_identity' | 'invalid_transition' | 'verification_not_ready'): AttemptApplicationResult =>
      ({ disposition: 'ignored', attemptId: valid.attemptId, status: null, reason, waitingFor: null,
        runtimeCompleted: false, resultSaved: false, stopConfirmed: false, eventId: null });
    const identity: WorkResourceIdentity = { projectId: valid.projectId, attemptId: valid.attemptId,
      owner: valid.owner, hostInstanceId: valid.hostInstanceId, executionVersion: valid.executionVersion };
    const attempt = db.prepare<[string], {
      project_id: string; feature_id: string; run_id: string; task_id: string; owner_id: string; host_instance_id: string;
      execution_version: number; revision: number; status: string; execution_stage: string; code_ref: string | null;
      diagnostic_ref: string | null; exit_code: number | null; input_snapshot: string;
    }>(`SELECT project_id, feature_id, run_id, task_id, owner_id, host_instance_id, execution_version, revision,
      status, execution_stage, code_ref, diagnostic_ref, exit_code, input_snapshot FROM attempts WHERE id = ?`).get(valid.attemptId);
    if (attempt === undefined || attempt.project_id !== valid.projectId || attempt.owner_id !== valid.owner
      || attempt.host_instance_id !== valid.hostInstanceId || attempt.execution_version !== valid.executionVersion
      || attempt.task_id !== valid.taskId || attempt.run_id !== valid.runId) return ignored('stale_execution_identity');
    const task = db.prepare<[string], { project_id: string; feature_id: string; execution_version: number; status: string; manual_block: number; execution_config: string }>(
      'SELECT project_id, feature_id, execution_version, status, manual_block, execution_config FROM tasks WHERE id = ?').get(valid.taskId);
    const run = db.prepare<[string], { project_id: string; feature_id: string; batch_id: string; status: string; reason: string | null }>(
      'SELECT project_id, feature_id, batch_id, status, reason FROM runs WHERE id = ?').get(valid.runId);
    if (task === undefined || run === undefined || task.project_id !== valid.projectId || run.project_id !== valid.projectId
      || task.feature_id !== attempt.feature_id || run.feature_id !== attempt.feature_id || task.execution_version !== valid.executionVersion) {
      return ignored('stale_execution_identity');
    }
    // F-012：Runtime 正常结束后 Run 处于 verification_not_assembled 暂停是常态
    //（apply 的 runtime_settled 分支写入）；验证汇总提交必须被接受。其余暂停
    // 原因仍拒绝，不额外放行。
    if (attempt.status !== 'verifying' || attempt.execution_stage !== 'verification' || task.status !== 'running'
      || !['queued', 'running', 'pausing', 'paused'].includes(run.status)
      || (run.status === 'paused' && !['approval', 'verification_not_assembled', 'user_pause'].includes(run.reason ?? ''))) return ignored('invalid_transition');
    let snapshot: { approval?: { planDigest?: string; checkPolicyDigest?: string; decisionId?: string } };
    try { snapshot = JSON.parse(attempt.input_snapshot) as typeof snapshot; } catch { return ignored('stale_execution_identity'); }
    const batch = db.prepare<[string], {
      project_id: string; feature_id: string; run_id: string; task_id: string; attempt_id: string; execution_version: number;
      code_digest: string; policy_digest: string; status: string;
    }>(`SELECT project_id, feature_id, run_id, task_id, attempt_id, execution_version, code_digest, policy_digest, status
      FROM verification_batches WHERE id = ?`).get(valid.verificationBatchId);
    if (batch === undefined || batch.project_id !== valid.projectId || batch.feature_id !== attempt.feature_id
      || batch.run_id !== valid.runId || batch.task_id !== valid.taskId || batch.attempt_id !== valid.attemptId
      || batch.execution_version !== valid.executionVersion || batch.code_digest !== valid.codeDigest
      || batch.policy_digest !== snapshot.approval?.checkPolicyDigest
      || (valid.outcome === 'passed' ? batch.status !== 'passed' : !['failed', 'error', 'inconclusive'].includes(batch.status))) return ignored('verification_not_ready');
    const checks = db.prepare<[string], { count: number; passed: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END), 0) AS passed FROM check_results WHERE batch_id = ?").get(valid.verificationBatchId)!;
    if (valid.outcome === 'passed' && (checks.count < 1 || checks.passed !== checks.count || attempt.exit_code !== 0 || attempt.diagnostic_ref === null)) {
      return ignored('verification_not_ready');
    }
    if (attempt.code_ref === null) return ignored('verification_not_ready');
    // F-012：代码身份锚点是已定版批次的 code_digest（上方已核对）；code_ref
    // 只要求指向同项目仍 ready 的不可变制品（关联现场证据），不要求其字节
    // 摘要等于业务 codeDigest——两者属于不同摘要域，受信准备路径已在批次定版
    // 前核验现场身份一致。
    const code = db.prepare<[string, string], { id: string }>(
      "SELECT id FROM artifacts WHERE project_id = ? AND id = ? AND status = 'ready'").get(valid.projectId, attempt.code_ref);
    if (code === undefined) return ignored('stale_execution_identity');
    const approval = verifyFeaturePlanApprovalInTransaction(transaction, valid.projectId, attempt.feature_id);
    const taskApprovalItems = transaction.listTaskApprovalItems(valid.projectId, valid.taskId);
    const humanApprovalWaiting = taskApprovalItems.some(item =>
      item.planDigest !== approval.planDigest
      || (item.codeDigest !== null && item.codeDigest !== valid.codeDigest)
      || (item.kind === 'approval' && (item.status !== 'approved' || item.decisionCodeDigest !== valid.codeDigest))
      || (item.kind === 'block' && item.status !== 'unblocked'));
    const approvalWaiting = task.manual_block === 1 || humanApprovalWaiting || !approval.validity.valid
      || approval.planDigest !== snapshot.approval?.planDigest
      || approval.checkPolicyDigest !== snapshot.approval?.checkPolicyDigest
      || approval.currentDecision?.id !== snapshot.approval?.decisionId;
    // A green verifier is not local delivery. Require an immutable, matching Git
    // receipt before releasing the workspace or making dependencies runnable.
    if (valid.outcome === 'passed' && !approvalWaiting) {
      const commit = db.prepare<unknown[], { id: string }>(`SELECT id FROM git_operations
        WHERE project_id = ? AND attempt_id = ? AND run_id = ? AND operation_type = 'task_commit'
          AND execution_version = ? AND owner_id = ? AND host_instance_id = ?
          AND code_digest = ? AND status IN ('succeeded', 'no_change')
          AND actual_commit IS NOT NULL AND actual_tree = candidate_tree
          AND EXISTS (SELECT 1 FROM json_each(verification_refs) ref
            WHERE json_extract(ref.value, '$.kind') = 'verification_batch'
              AND json_extract(ref.value, '$.id') = ? AND json_extract(ref.value, '$.digest') = ?)
        LIMIT 1`).get(valid.projectId, valid.attemptId, valid.runId, valid.executionVersion,
          valid.owner, valid.hostInstanceId, valid.codeDigest, valid.verificationBatchId, valid.codeDigest);
      if (!commit) return ignored('verification_not_ready');
    }
    // 机器绿色不等于停止已确认；仍有占用时必须提交与当前现场绑定的停止证据。
    if (valid.outcome === 'passed' && !approvalWaiting && resources.read(identity).leases.length > 0) {
      if (verifierStopEvidence === undefined) {
        quarantineIfOccupied(identity);
        return ignored('verification_not_ready');
      }
      try {
        resources.releaseStoppedInTransaction(identity, verifierStopEvidence);
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        quarantineIfOccupied(identity);
        return ignored('verification_not_ready');
      }
    }
    const budgetReservation = transaction.getTaskAttemptReservation(valid.projectId, valid.taskId, valid.attemptId);
    const alreadyObserved = budgetReservation?.reason?.includes(valid.observationDigest) === true;
    const budgetOutcome = valid.outcome === 'passed' ? 'passed' : valid.outcome;
    transaction.settleTaskAttemptBudget({ projectId: valid.projectId, batchId: run.batch_id, runId: valid.runId,
      taskId: valid.taskId, attemptKey: valid.attemptId, outcome: budgetOutcome, observationDigest: valid.observationDigest });
    if (valid.outcome !== 'passed') {
      const changed = db.prepare(`UPDATE attempts SET status = 'failed', execution_stage = 'verification', error_kind = ?, ended_at = ?,
        updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status = 'verifying'`).run(valid.outcome, now, now, valid.attemptId, attempt.revision);
      if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Verification Attempt CAS failed');
      const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
      const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
        aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
      if (valid.outcome === 'non_code_failure') {
        // F-012 / FR-3：基础设施（认证/配置/协议/超时/环境/证据）失败进入独立
        // 暂停分支：Task 回到 pending 但 Run 暂停（reason=infrastructure_error），
        // 不会自动进入代码返工循环；现场保留隔离占用，交由显式处理分支决策。
        const taskPending = db.prepare(`UPDATE tasks SET status = 'pending', revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`).run(now, valid.taskId, valid.executionVersion);
        if (taskPending.changes !== 1) throw new StorageError('conflict', operation, 'Verification Task CAS failed');
        db.prepare(`UPDATE runs SET status = 'paused', reason = 'infrastructure_error', revision = revision + 1, updated_at = ?
          WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing', 'paused')
          AND (reason IS NULL OR reason <> 'approval')`).run(now, valid.runId, valid.projectId);
        finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
        quarantineIfOccupied(identity);
        return { disposition: 'applied', attemptId: valid.attemptId, status: 'failed', reason: null, waitingFor: null,
          runtimeCompleted: true, resultSaved: true, stopConfirmed: false, eventId };
      }
      // 确定性代码检查失败：第三次含首次（code_attempts_used >= maxCodeAttempts）
      // 后 Task failed，依赖后继由 DAG blocked；仍有代码资格时 Task 回到 pending、
      // Run 回到 running，由既有调度重新认领并接返工快照。
      const config = validateTaskExecutionConfig(JSON.parse(task.execution_config), 'AttemptLifecycle.submitVerification');
      const exhausted = counters.codeAttemptsUsed >= (config.maxCodeAttempts ?? DEFAULT_TASK_MAX_CODE_ATTEMPTS);
      if (exhausted) {
        const taskFailed = db.prepare(`UPDATE tasks SET status = 'failed', revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`).run(now, valid.taskId, valid.executionVersion);
        if (taskFailed.changes !== 1) throw new StorageError('conflict', operation, 'Verification Task CAS failed');
        db.prepare(`UPDATE runs SET status = 'paused', reason = 'code_attempts_exhausted', revision = revision + 1, updated_at = ?
          WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing', 'paused')
          AND (reason IS NULL OR reason <> 'approval')`).run(now, valid.runId, valid.projectId);
      } else {
        const taskPending = db.prepare(`UPDATE tasks SET status = 'pending', revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`).run(now, valid.taskId, valid.executionVersion);
        if (taskPending.changes !== 1) throw new StorageError('conflict', operation, 'Verification Task CAS failed');
        db.prepare(`UPDATE runs SET status = 'running', reason = NULL, revision = revision + 1, updated_at = ?
          WHERE id = ? AND project_id = ? AND (status IN ('queued', 'running')
          OR (status = 'paused' AND reason = 'verification_not_assembled'))`).run(now, valid.runId, valid.projectId);
      }
      finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
      // 新认领与启动前必须再次核对旧 Runtime/Verifier 停止证据：停止已确认才
      // 释放占用供同 worktree 返工复用；未知则保留隔离占用并拒绝重跑。
      // 占用释放/隔离决策通常已在 apply(runtime_completed) 按停止证据作出
      // （确认→删除、未知→隔离）；此处仅对仍存占用补刀：
      // · 已释放（0 租约）视为停止已确认；
      // · 仍持有时凭受信 Verifier 停止证据再核对释放（含先隔离后补证场景）；
      // · 其余保持隔离，DAG resource_busy 拒绝重跑。
      let stopConfirmed = false;
      const occupancy = resources.read(identity);
      if (occupancy.leases.length === 0) {
        stopConfirmed = true;
      } else if (verifierStopEvidence !== undefined) {
        try {
          resources.releaseStoppedInTransaction(identity, verifierStopEvidence);
          stopConfirmed = true;
        } catch (error) {
          if (!(error instanceof StorageError)) throw error;
        }
      }
      if (!stopConfirmed) quarantineIfOccupied(identity);
      return { disposition: 'applied', attemptId: valid.attemptId, status: 'failed', reason: null,
        waitingFor: null, runtimeCompleted: true, resultSaved: true, stopConfirmed, eventId };
    }
    if (approvalWaiting) {
      if (alreadyObserved) return { disposition: 'replayed', attemptId: valid.attemptId, status: 'verifying', reason: null,
        waitingFor: 'approval', runtimeCompleted: true, resultSaved: true, stopConfirmed: true, eventId: null };
      const runChanged = db.prepare(`UPDATE runs SET status = 'paused', reason = 'approval', revision = revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing', 'paused') AND (reason IS NULL OR reason = 'approval')`)
        .run(now, valid.runId, valid.projectId);
      const featureChanged = db.prepare(`UPDATE features SET status = 'awaiting_approval', revision = revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND status <> 'awaiting_approval'`).run(now, attempt.feature_id, valid.projectId);
      finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
      const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
      const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
        aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
      return { disposition: 'applied', attemptId: valid.attemptId, status: 'verifying', reason: null, waitingFor: 'approval',
        runtimeCompleted: true, resultSaved: true, stopConfirmed: true, eventId };
    }
    const changed = db.prepare(`UPDATE attempts SET status = 'succeeded', execution_stage = 'commit', ended_at = COALESCE(ended_at, ?),
      updated_at = ?, revision = revision + 1 WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ?
      AND revision = ? AND status = 'verifying'`).run(now, now, valid.attemptId, valid.owner, valid.hostInstanceId, valid.executionVersion, attempt.revision);
    if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Verification Attempt CAS failed');
    const taskChanged = db.prepare(`UPDATE tasks SET status = 'passed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND execution_version = ? AND status = 'running'`).run(now, valid.taskId, valid.executionVersion);
    if (taskChanged.changes !== 1) throw new StorageError('conflict', operation, 'Verification Task CAS failed');
    const pendingApprovals = db.prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count FROM task_approval_items WHERE project_id = ? AND feature_id = ? AND status = 'pending'`)
      .get(valid.projectId, attempt.feature_id)!.count;
    db.prepare(`UPDATE features SET status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'awaiting_approval'`)
      .run(pendingApprovals > 0 ? 'awaiting_approval' : 'running', now, attempt.feature_id, valid.projectId);
    db.prepare(`UPDATE runs SET status = 'running', reason = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND (status = 'queued'
      OR (status = 'paused' AND reason IN ('approval', 'verification_not_assembled')))`)
      .run(now, valid.runId, valid.projectId);
    finalizePauseIntentInTransaction(valid.projectId, valid.runId, now);
    const view = dag.readTaskDagView(valid.projectId, valid.runId);
    evaluateTaskDag(view, now);
    const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
    const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
      aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
    return { disposition: 'applied', attemptId: valid.attemptId, status: 'succeeded', reason: null, waitingFor: null,
      runtimeCompleted: true, resultSaved: true, stopConfirmed: true, eventId };
  }

  return {
    apply(input, stopEvidence) {
      validateAttemptNotification(input);
      return atomic.transact(operation, transaction => applyInTransaction(transaction, input, stopEvidence));
    },
    submitVerification(input, verifierStopEvidence) {
      validateVerificationSubmission(input);
      return atomic.transact('AttemptLifecycle.submitVerification', transaction => submitVerificationInTransaction(transaction, input, verifierStopEvidence));
    },
    submitVerificationInTransaction(transaction, input, verifierStopEvidence) {
      return submitVerificationInTransaction(transaction, input, verifierStopEvidence);
    },
    recordWorkspaceRetentionInTransaction(transaction, identity, expectedRevision, evidenceRef) {
      if (!db.inTransaction) throw new TypeError('Attempt retention requires a write transaction');
      resources.read(identity);
      transaction.getArtifactInputRef(identity.projectId, evidenceRef);
      const changed = db.prepare(`UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ?)`)
        .run(evidenceRef, (options.nowUtcMs ?? Date.now)(), identity.projectId, identity.attemptId, identity.owner,
          identity.hostInstanceId, identity.executionVersion, expectedRevision, identity.executionVersion);
      if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Attempt retention CAS failed');
    },
    recordAttemptCode(input) {
      const context = { operation: `${operation}.recordCode` };
      const raw = requirePlainObject(input, context, 'input');
      rejectUnknownKeys(raw, ['identity', 'expectedRevision', 'codeRef'], context, 'input');
      const identity = validateWorkResourceIdentity(raw.identity);
      if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1) {
        throw new StorageError('validation', `${operation}.recordCode`, 'Invalid expected revision');
      }
      const codeRef = validateStableId(raw.codeRef, context, 'codeRef');
      return atomic.transact('AttemptLifecycle.recordCode', transaction => {
        resources.read(identity);
        transaction.getArtifactInputRef(identity.projectId, codeRef);
        const changed = db.prepare(`UPDATE attempts SET code_ref = ?, revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?
            AND status = 'verifying' AND execution_stage = 'verification'
            AND code_ref IS NULL
            AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ? AND status = 'running')`)
          .run(codeRef, (options.nowUtcMs ?? Date.now)(), identity.projectId, identity.attemptId, identity.owner,
            identity.hostInstanceId, identity.executionVersion, raw.expectedRevision as number, identity.executionVersion);
        if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Attempt code record CAS failed');
        const updated = attempts.getAttempt(identity.projectId, identity.attemptId);
        return { attemptId: updated.id, revision: updated.revision, codeRef: updated.codeRef! };
      });
    },
    applyPreparationFailureInTransaction(transaction, input, isolation) {
      if (validateAttemptNotification(input).kind !== 'preparation_failed'
        || !['unstarted', 'uncertain'].includes(isolation)) throw new TypeError('Expected trusted preparation failure');
      return applyInTransaction(transaction, input, undefined, isolation === 'uncertain');
    },
  };
}
