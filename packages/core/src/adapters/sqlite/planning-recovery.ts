/**
 * P05-1 / F-010 规划启动恢复 SQLite 原语（adapters/sqlite 层）。
 *
 * 设计依据：ports/planning-recovery.ts（契约）、core-design/04 §5、core-design/15
 * §2（SQLite 是事实来源）。每个补完原语 = 一个自有 BEGIN IMMEDIATE 短同步写事务：
 * 事务内重核全部身份/状态/控制事实（fail-closed，任一失败整组回滚）；无进程/
 * Git/模型 I/O；不重开终态 Run；不改写已决策/已取消事实。
 *
 * 复用既有原语：planning_contexts 发布 CAS（窗口 A）、execution run 终态结算与
 * 预算结算（窗口 B）、work session 进度 CAS、workspace/派发归属释放（窗口 B/C）。
 */
import { randomUUID } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import { isPlanningAttemptSnapshot } from '../../ports/attempt-store.js';
import { EXECUTION_ACTIVE_STATUSES } from '../../ports/execution-store.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqlitePlanningContextStore } from './planning-context-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { WORK_SESSION_EVENT_TYPE } from '../../ports/work-session.js';
import type { SqliteStorageSession } from './session.js';
import type {
  PlanningCandidateRegistrationCompletionInput,
  PlanningObservationReleaseInput,
  PlanningOutcomeCompletionInput,
  PlanningRecoveryPrimitiveResult,
  PlanningRecoveryScanRow,
  PlanningRecoveryStore,
} from '../../ports/planning-recovery.js';

const OPERATION = 'PlanningRecovery';
const SCAN_LIMIT = 64;

type PlanningRow = {
  project_id: string; feature_id: string; run_id: string; planning_task_id: string;
  candidate_id: string; context_status: string; candidate_artifact_id: string | null;
};
type AttemptRow = {
  id: string; project_id: string; feature_id: string; run_id: string; task_id: string;
  owner_id: string; host_instance_id: string; execution_version: number; revision: number;
  status: string; started_at: number | null; created_at: number; invocation_id: string | null;
  input_snapshot: string;
};
type SessionRow = { id: string; status: string; recording_watermark: number | null; recording_gaps: string | null; revision: number };

function fail(reason: string): never {
  throw new StorageError('conflict', OPERATION, `Planning recovery rejected: ${reason}`, { details: { reason } });
}

function parseGaps(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((gap): gap is string => typeof gap === 'string') : [];
  } catch {
    return ['recording_gaps_unreadable'];
  }
}

export function createSqlitePlanningRecoveryStore(session: SqliteStorageSession, options: {
  readonly nowUtcMs?: () => number;
} = {}): PlanningRecoveryStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const attempts = createSqliteAttemptAccess(session);

  function event(phase: string, projectId: string, runId: string, payload: object,
    attemptId: string | null = null): void {
    const timestamp = now();
    const revision = db.prepare<[string], { revision: number }>('SELECT revision FROM runs WHERE id = ?').get(runId)?.revision ?? 1;
    db.prepare(`INSERT INTO state_events (id, created_at, updated_at, revision, project_id, sequence,
      event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, run_id, attempt_id, execution_stage)
      VALUES (?, ?, ?, 1, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM state_events), 'work.recovery.updated',
        'run', ?, ?, ?, ?, ?, ?, NULL)`)
      .run(randomUUID(), timestamp, timestamp, projectId, runId, revision,
        JSON.stringify({ schemaVersion: 1, kind: 'planning-startup-recovery', phase, ...payload }),
        timestamp, runId, attemptId);
  }

  function appendSessionEvent(projectId: string, sessionId: string, revision: number,
    status: string, timestamp: number): void {
    const eventId = randomUUID();
    const sequence = db.prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()!.next;
    db.prepare(`INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence,
      event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, operation_id,
      run_id, attempt_id, execution_stage) VALUES (?, ?, 1, ?, ?, ?, ?, 'session', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
      .run(eventId, timestamp, timestamp, projectId, sequence, WORK_SESSION_EVENT_TYPE, sessionId,
        revision, JSON.stringify({ status }), timestamp);
  }

  function planningAttemptRow(attemptId: string): AttemptRow {
    const row = db.prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (row === undefined) fail('attempt_missing');
    if (!isPlanningAttemptSnapshot(JSON.parse(row.input_snapshot) as never)) fail('attempt_not_planning');
    return row;
  }

  /** 全部 Run 均已终态且全部成功时收尾 Batch（唤醒丢失的观察补完；
 * 混合终态或仍有活动 Run 时留给既有路径，不伪造成功）。 */
  function closeBatchIfAllRunsSucceeded(projectId: string, batchId: string, timestamp: number): void {
    const active = EXECUTION_ACTIVE_STATUSES.map(() => '?').join(', ');
    const open = db.prepare<unknown[], { n: number }>(
      `SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND batch_id = ? AND status IN (${active})`,
    ).get(projectId, batchId, ...EXECUTION_ACTIVE_STATUSES)!.n;
    if (Number(open) !== 0) return;
    const notSucceeded = db.prepare<[string, string], { n: number }>(
      "SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND batch_id = ? AND status <> 'succeeded'",
    ).get(projectId, batchId)!.n;
    if (Number(notSucceeded) !== 0) return;
    db.prepare<unknown[]>(`UPDATE execution_batches SET status = 'succeeded', reason = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND status IN (${active})`)
      .run(timestamp, batchId, projectId, ...EXECUTION_ACTIVE_STATUSES);
  }

  function releaseDispatchForRun(runId: string, timestamp: number, reason: string): void {
    db.prepare(`UPDATE execution_slot_claims SET state = 'released', reason = ?, released_at = MAX(?, acquired_at, updated_at),
      revision = revision + 1, updated_at = MAX(?, acquired_at, updated_at) WHERE claim_id IN
      (SELECT id FROM run_dispatch_claims WHERE run_id = ?) AND state IN ('held', 'quarantined')`)
      .run(reason, timestamp, timestamp, runId);
    db.prepare(`UPDATE run_dispatch_claims SET state = 'released', reason = ?, settled_at = MAX(?, acquired_at, updated_at),
      revision = revision + 1, updated_at = MAX(?, acquired_at, updated_at) WHERE run_id = ? AND state IN ('held', 'quarantined')`)
      .run(reason, timestamp, timestamp, runId);
  }

  return {
    scan() {
      return transactSqliteConsistentRead(session, `${OPERATION}.scan`, () => {
        const rows = db.prepare<[], PlanningRow>(`SELECT pc.project_id, pc.feature_id, pc.run_id, pc.planning_task_id,
          pc.candidate_id, pc.status AS context_status FROM planning_contexts pc
          JOIN runs r ON r.project_id = pc.project_id AND r.id = pc.run_id
          ORDER BY pc.id LIMIT ${SCAN_LIMIT + 1}`).all();
        if (rows.length > SCAN_LIMIT) fail('planning_recovery_scan_limit');
        const results: PlanningRecoveryScanRow[] = [];
        for (const row of rows) {
          const attempt = db.prepare<[string, string], AttemptRow>(
            'SELECT * FROM attempts WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          ).get(row.project_id, row.planning_task_id) ?? null;
          const runStatus = String(db.prepare<[string, string], { status: string }>(
            'SELECT status FROM runs WHERE project_id = ? AND id = ?').get(row.project_id, row.run_id)!.status);
          const sessionRow: SessionRow | null = attempt === null ? null
            : db.prepare<[string], SessionRow>('SELECT id, status, recording_watermark, recording_gaps, revision FROM sessions WHERE attempt_id = ?')
              .get(attempt.id) ?? null;
          const claim = db.prepare<[string], { state: string }>(
            "SELECT state FROM run_dispatch_claims WHERE run_id = ? AND state <> 'released' ORDER BY claim_version DESC LIMIT 1",
          ).get(row.run_id) ?? null;
          const leaseCount = attempt === null ? 0 : Number(db.prepare<[string], { n: number }>(
            'SELECT COUNT(*) AS n FROM workspace_leases WHERE owner_id = ?').get(attempt.id)!.n);
          const candidatePrefix = `planning/candidates/${row.run_id}/${row.candidate_id}/`.replace(/([%_\\])/g, '\\$1');
          const candidateArtifacts = db.prepare<[string, string], { artifactId: string; contentHash: string | null; locator: string; status: string }>(
            `SELECT id AS artifactId, content_hash AS contentHash, storage_locator AS locator, status FROM artifacts
            WHERE project_id = ? AND kind = 'planning-candidate' AND storage_locator LIKE ? ESCAPE '\\' ORDER BY id`,
          ).all(row.project_id, `${candidatePrefix}%`);
          const settlementArtifact = sessionRow === null ? null
            : db.prepare<[string, string], { artifactId: string; contentHash: string | null; locator: string; status: string }>(
              `SELECT id AS artifactId, content_hash AS contentHash, storage_locator AS locator, status FROM artifacts
              WHERE project_id = ? AND kind = 'runtime-settlement' AND storage_locator = ? LIMIT 1`,
            ).get(row.project_id, `sessions/${sessionRow.id}/runtime-settlement.json`) ?? null;
          const runTerminal = ['succeeded', 'failed', 'cancelled'].includes(runStatus);
          const runOpen = ['queued', 'running', 'paused', 'interrupted'].includes(runStatus);
          let window: PlanningRecoveryScanRow['window'];
          if (row.context_status === 'open' && runOpen && candidateArtifacts.length > 0) {
            window = 'candidate_publication_incomplete';
          } else if (row.context_status === 'candidate_published' && runOpen
            && (attempt === null || ['interrupted', 'preparing', 'executing', 'verifying'].includes(attempt.status))) {
            window = 'candidate_registered_run_open';
          } else if (runTerminal && runStatus === 'succeeded' && ['candidate_published', 'applied', 'rejected'].includes(row.context_status)
            && ((claim !== null && claim.state !== 'released') || leaseCount > 0)) {
            window = 'run_finished_observation_lost';
          } else if (row.context_status === 'applied') {
            window = 'decision_receipt_lost';
          } else {
            window = 'none';
          }
          results.push({
            projectId: row.project_id, runId: row.run_id, featureId: row.feature_id, taskId: row.planning_task_id,
            attemptId: attempt === null ? null : attempt.id, candidateId: row.candidate_id,
            contextStatus: row.context_status, runStatus,
            attemptStatus: attempt === null ? null : attempt.status,
            sessionId: sessionRow === null ? null : sessionRow.id,
            sessionStatus: sessionRow === null ? null : sessionRow.status,
            recordingWatermark: sessionRow === null ? null : sessionRow.recording_watermark,
            recordingGaps: sessionRow === null ? [] : parseGaps(sessionRow.recording_gaps),
            claimState: claim === null ? null : claim.state,
            leaseCount, candidateArtifacts, settlementArtifact, window,
          });
        }
        return results;
      });
    },

    completeRegistration(input: PlanningCandidateRegistrationCompletionInput): PlanningRecoveryPrimitiveResult {
      return session.transactWrite(`${OPERATION}.register`, () => {
        const contexts = createSqlitePlanningContextStore(session, { nowUtcMs: now });
        const context = contexts.getPlanningContextByCandidate(input.projectId, input.candidateId);
        if (context === null || context.runId !== input.runId) fail('planning_context_missing');
        if (context.status === 'candidate_published'
          && context.candidateDigest === input.candidateDigest
          && context.candidateArtifactRef?.artifactId === input.artifactId) {
          event('candidate_registration', input.projectId, input.runId,
            { outcome: 'replayed', candidateId: input.candidateId }, null);
          return { outcome: 'replayed', reason: null };
        }
        if (context.status !== 'open') fail('planning_context_not_open');
        const published = contexts.publishPlanningCandidateInTransaction({
          projectId: input.projectId, candidateId: input.candidateId, candidateDigest: input.candidateDigest,
          artifactId: input.artifactId, contentHash: input.contentHash, summary: input.summary,
        });
        event('candidate_registration', input.projectId, input.runId,
          { outcome: published.outcome, candidateId: input.candidateId }, null);
        return { outcome: published.outcome === 'reused' ? 'replayed' : 'completed', reason: null };
      });
    },

    completeOutcome(input: PlanningOutcomeCompletionInput): PlanningRecoveryPrimitiveResult {
      /* 单一原子命令事务：预核与补完同事务（无嵌套事务）。 */
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: now });
      return atomic.transact(`${OPERATION}.outcome`, transaction => {
        const attempt = planningAttemptRow(input.attemptId);
        if (attempt.project_id !== input.projectId || attempt.run_id !== input.runId) fail('attempt_identity_mismatch');
        const run = db.prepare<[string, string], { status: string; revision: number; batch_id: string }>(
          'SELECT status, revision, batch_id FROM runs WHERE project_id = ? AND id = ?').get(input.projectId, input.runId);
        if (run === undefined) fail('run_missing');
        const context = db.prepare<[string, string], PlanningRow>(
          'SELECT *, status AS context_status FROM planning_contexts WHERE project_id = ? AND run_id = ?').get(input.projectId, input.runId);
        if (context === undefined || context.candidate_id !== JSON.parse(attempt.input_snapshot).candidateId
          || !['candidate_published', 'applied'].includes(context.context_status)
          || context.candidate_artifact_id === null) fail('planning_candidate_unbound');
        if (attempt.status === 'succeeded' && run.status === 'succeeded') {
          event('planning_outcome', input.projectId, input.runId, { outcome: 'replayed' }, attempt.id);
          return { outcome: 'replayed', reason: null };
        }
        if (attempt.status !== 'interrupted') fail('attempt_not_interrupted');
        if (run.status === 'cancelling' || ['succeeded', 'failed', 'cancelled'].includes(run.status)) fail('run_control_won');
        if (!['queued', 'running', 'paused', 'interrupted'].includes(run.status)) fail('run_not_recoverable');
        if (attempt.invocation_id === null || attempt.invocation_id !== input.invocationId) fail('settlement_identity_mismatch');
        const artifact = db.prepare<[string], { project_id: string; status: string; content_hash: string | null }>(
          'SELECT project_id, status, content_hash FROM artifacts WHERE id = ?').get(input.settlementArtifactId);
        if (artifact === undefined || artifact.project_id !== input.projectId || artifact.status !== 'ready'
          || artifact.content_hash !== input.settlementContentHash) fail('settlement_artifact_not_ready');
        const workSession = db.prepare<[string], SessionRow & { attempt_id: string }>(
          'SELECT id, attempt_id, status, recording_watermark, recording_gaps, revision FROM sessions WHERE id = ?').get(input.sessionId);
        if (workSession === undefined || workSession.attempt_id !== attempt.id
          || !['started', 'ended', 'stopped'].includes(workSession.status)) fail('session_not_stopped_conflict');

        const executions = createSqliteExecutionAccess(session, { nowUtcMs: now });
        const timestamp = now();
        /* Session 停止/水位补完（fence 后 Task 版本已推进，通用 Session 存储
         * 的 owner/version CAS 无法接受该历史身份；这里以同等纪律直接 CAS：
 * 状态机 ended→stopped、revision 递增、水位不回退，并追加同构事件）。 */
        if (workSession.status !== 'stopped') {
          let sessionRevision = workSession.revision;
          const ended = db.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = ?, status = 'ended',
            execution_stage = 'verification', result_ref = ?, ended_at = ?,
            recording_watermark = CASE WHEN ? IS NOT NULL AND (recording_watermark IS NULL OR recording_watermark <= ?)
              THEN ? ELSE recording_watermark END
            WHERE id = ? AND revision = ? AND status IN ('started', 'ended')`)
            .run(timestamp, input.settlementArtifactId, timestamp,
              input.watermark, input.watermark, input.watermark, workSession.id, sessionRevision);
          if (ended.changes !== 1) fail('session_settlement_race');
          sessionRevision += 1;
          appendSessionEvent(input.projectId, workSession.id, sessionRevision, 'ended', timestamp);
          const stopped = db.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = ?, status = 'stopped',
            stopped_at = ? WHERE id = ? AND revision = ? AND status = 'ended'`)
            .run(timestamp, timestamp, workSession.id, sessionRevision);
          if (stopped.changes !== 1) fail('session_settlement_race');
          sessionRevision += 1;
          appendSessionEvent(input.projectId, workSession.id, sessionRevision, 'stopped', timestamp);
        }
        /* Attempt/Task 终态（行级 CAS；保留原 owner/version 身份与历史候选）。 */
        const changed = db.prepare(`UPDATE attempts SET status = 'succeeded', execution_stage = 'verification',
          diagnostic_ref = ?, ended_at = ?, exit_code = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'interrupted'`)
          .run(input.settlementArtifactId, timestamp, input.exitCode, timestamp, attempt.id);
        if (changed.changes !== 1) fail('attempt_settlement_race');
        const taskRow = db.prepare<[string], { execution_version: number; status: string }>(
          'SELECT execution_version, status FROM tasks WHERE id = ?').get(attempt.task_id);
        /* fence 已推进 Task 版本（+1）；非重启路径结算则未推进。两者都可核对。 */
        if (taskRow === undefined || taskRow.status !== 'running'
          || (taskRow.execution_version !== attempt.execution_version
            && taskRow.execution_version !== attempt.execution_version + 1)) fail('task_settlement_race');
        const taskChanged = db.prepare(`UPDATE tasks SET status = 'passed', revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`)
          .run(timestamp, attempt.task_id, taskRow.execution_version);
        if (taskChanged.changes !== 1) fail('task_settlement_race');
        /* Run/Batch 终态与预算（幂等 resultKey；进展证据 = planning Task 首次 passed）。
         * fence 将 Run 置为 interrupted；结算原语不接受控制中状态，先以恢复依据
         * CAS 解除为 paused（不是重开终态 Run，也不改写取消/终态控制状态）。 */
        let runRevision = run.revision;
        if (run.status === 'interrupted') {
          const unblocked = db.prepare(`UPDATE runs SET status = 'paused', reason = 'planning_recovery',
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'interrupted'`)
            .run(timestamp, input.runId, run.revision);
          if (unblocked.changes !== 1) fail('run_settlement_race');
          runRevision += 1;
        }
        transaction.settleExecutionRunOutcome({
          projectId: input.projectId, batchId: run.batch_id, runId: input.runId, runRevision,
          resultKey: `planning:${input.runId}`, outcome: 'succeeded', reason: 'planning_candidate_published',
          progressEvidence: { type: 'new_valid_task_passed', taskId: attempt.task_id },
        });
        transaction.settleTaskAttemptBudget({ projectId: input.projectId, batchId: run.batch_id, runId: input.runId,
          taskId: attempt.task_id, attemptKey: attempt.id, outcome: 'passed',
          observationDigest: input.settlementContentHash });
        /* 占用释放（隔离现场凭已核验停止证据收口）与工作区 retained。 */
        db.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
        db.prepare(`UPDATE managed_workspaces SET status = 'retained', revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND attempt_id = ? AND status <> 'cleaned'`).run(timestamp, attempt.project_id, attempt.id);
        releaseDispatchForRun(input.runId, timestamp, 'planning_recovery_terminal_stopped');
        closeBatchIfAllRunsSucceeded(input.projectId, run.batch_id, timestamp);
        const counters = transaction.getTaskExecutionCounters(input.projectId, attempt.task_id);
        executions.appendExecutionEventInTransaction({ projectId: input.projectId, eventType: 'task.attempt.updated',
          aggregateType: 'task', aggregateId: attempt.task_id, aggregateRevision: counters.revision,
          payload: { updated: true, planningRecovery: true } });
        event('planning_outcome', input.projectId, input.runId,
          { outcome: 'completed', attemptId: attempt.id, settlementArtifactId: input.settlementArtifactId }, attempt.id);
        return { outcome: 'completed', reason: null };
      });
    },

    releaseObservation(input: PlanningObservationReleaseInput): PlanningRecoveryPrimitiveResult {
      return session.transactWrite(`${OPERATION}.observation`, () => {
        const attempt = planningAttemptRow(input.attemptId);
        if (attempt.project_id !== input.projectId || attempt.run_id !== input.runId) fail('attempt_identity_mismatch');
        const run = db.prepare<[string, string], { status: string }>(
          'SELECT status FROM runs WHERE project_id = ? AND id = ?').get(input.projectId, input.runId);
        if (run === undefined) fail('run_missing');
        if (run.status !== 'succeeded' || !['succeeded', 'failed', 'cancelled'].includes(attempt.status)) fail('run_not_terminal');
        const leases = db.prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM workspace_leases WHERE owner_id = ?').get(attempt.id)!.n;
        const claim = db.prepare<[string], { state: string }>(
          "SELECT state FROM run_dispatch_claims WHERE run_id = ? AND state IN ('held', 'quarantined') LIMIT 1",
        ).get(input.runId);
        if (leases === 0 && claim === undefined) {
          event('observation_release', input.projectId, input.runId, { outcome: 'replayed' }, attempt.id);
          return { outcome: 'replayed', reason: null };
        }
        /* 活动占用/未停止会话不得经此释放（fail-closed；由 scan 层先核对）。 */
        const active = db.prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND status IN ('preparing', 'executing', 'verifying')",
        ).get(input.runId)!.n;
        if (active > 0) fail('active_attempt_present');
        const sessionRow = db.prepare<[string], SessionRow>(
          'SELECT id, status, recording_watermark, recording_gaps, revision FROM sessions WHERE attempt_id = ?').get(attempt.id);
        if (sessionRow === undefined || sessionRow.status !== 'stopped' || sessionRow.recording_watermark === null) fail('session_not_stopped');
        const timestamp = now();
        db.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
        db.prepare(`UPDATE managed_workspaces SET status = 'retained', revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND attempt_id = ? AND status <> 'cleaned'`).run(timestamp, attempt.project_id, attempt.id);
        releaseDispatchForRun(input.runId, timestamp, 'planning_recovery_terminal_stopped');
        event('observation_release', input.projectId, input.runId, { outcome: 'completed' }, attempt.id);
        return { outcome: 'completed', reason: null };
      });
    },

    recordDiagnostic(input: {
      readonly projectId: string; readonly runId: string; readonly attemptId: string | null;
      readonly window: string; readonly status: string; readonly gaps: readonly string[];
    }): void {
      session.transactWrite(`${OPERATION}.diagnostic`, () => {
        event('diagnostic', input.projectId, input.runId,
          { window: input.window, status: input.status, gaps: input.gaps.slice(0, 32) }, input.attemptId);
      });
    },
  };
}
