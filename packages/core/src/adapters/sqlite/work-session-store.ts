/**
 * P03-6 / F-006：最小 Work Session 与 Attempt 执行诊断持久关联（SQLite 适配器，迁移 v20）。
 *
 * 复用现有状态事务（createSqliteAtomicCommandStore.transact）：Session 创建 +
 * Attempt session_id 绑定（CAS）+ 脱敏状态事件（aggregate_type='session'，携带
 * attempt/run/executionStage 关联）在同一短事务内原子提交；Session 推进 +
 * Attempt executionStage 推进 + 状态事件同样原子；调用方可在同一事务内追加适用
 * 回执。创建拒绝跨项目/缺失 Attempt、陈旧 owner/host/version、重复顶层 Session 与
 * 终态 Attempt；推进拒绝非法状态迁移、陈旧 expectedRevision/owner/version、错误
 * Attempt 关联、水位后退与未 ready 的结果制品引用。未知指标（结果/水位/缺口/
 * 原生引用/停止时间）保持 null；正文一律经 ready Artifact 引用。
 */
import { randomUUID } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import { ACTIVE_ATTEMPT_STATUSES } from '../../ports/attempt-store.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import {
  validateWorkSessionCreateInput,
  validateWorkSessionProgressInput,
  validateWorkSessionRecord,
  WORK_SESSION_EVENT_TYPE,
  WORK_SESSION_SCHEMA_VERSION,
  WORK_SESSION_TRANSITIONS,
  type WorkSessionCreateInput,
  type WorkSessionMutation,
  type WorkSessionProgressInput,
  type WorkSessionRecord,
  type WorkSessionStatus,
  type WorkSessionStore,
} from '../../ports/work-session.js';
import type { AttemptExecutionStage } from '../../ports/attempt-store.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';

interface SessionRow {
  id: string; created_at: number; updated_at: number; revision: number; project_id: string;
  attempt_id: string | null; parent_session_id: string | null; kind: string; title: string | null;
  purpose: string; runtime: string; adapter_version: string; provider_session_id: string | null;
  status: string; execution_stage: string; input_ref: string; result_ref: string | null;
  last_activity_at: number; started_at: number | null; ended_at: number | null; stopped_at: number | null;
  native_ref: string | null; recording_watermark: number | null; recording_gaps: string | null;
}

const SESSION_COLUMNS = `id, created_at, updated_at, revision, project_id, attempt_id, parent_session_id,
  kind, title, purpose, runtime, adapter_version, provider_session_id, status, execution_stage,
  input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at, native_ref,
  recording_watermark, recording_gaps`;

interface AttemptIdentityRow {
  project_id: string; run_id: string; status: string; revision: number;
  owner_id: string; host_instance_id: string; execution_version: number;
  session_id: string | null; input_ref: string; execution_stage: string;
}

export function createSqliteWorkSessionStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): WorkSessionStore {
  const db = session.database;
  const now = options.nowUtcMs ?? (() => Date.now());
  const atomic = createSqliteAtomicCommandStore(session, options);

  function fail(kind: 'validation' | 'not_found' | 'conflict' | 'ownership' | 'corrupt', operation: string,
    message: string, sessionId?: string, projectId?: string): never {
    throw new StorageError(kind, operation, message, sessionId === undefined ? undefined
      : { entity: { type: 'work_session', id: sessionId, projectId } });
  }

  function sessionFromRow(row: SessionRow): WorkSessionRecord {
    try {
      return validateWorkSessionRecord({
        id: row.id, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at, revision: row.revision,
        projectId: row.project_id, attemptId: row.attempt_id, parentSessionId: row.parent_session_id,
        kind: row.kind, title: row.title, purpose: row.purpose, runtime: row.runtime,
        adapterVersion: row.adapter_version, providerSessionId: row.provider_session_id,
        status: row.status, executionStage: row.execution_stage, inputRef: row.input_ref,
        resultRef: row.result_ref, lastActivityAtUtcMs: row.last_activity_at, startedAtUtcMs: row.started_at,
        endedAtUtcMs: row.ended_at, stoppedAtUtcMs: row.stopped_at,
        nativeRef: row.native_ref === null ? null : JSON.parse(row.native_ref),
        recordingWatermark: row.recording_watermark,
        recordingGaps: row.recording_gaps === null ? null : JSON.parse(row.recording_gaps),
      });
    } catch {
      // fail-closed：损坏行读取失败，不把原始内容泄漏进错误。
      fail('corrupt', 'WorkSessionStore.read', 'Invalid stored work session', row.id, row.project_id);
    }
  }

  function readSessionRow(sessionId: string): SessionRow | undefined {
    return db.prepare<[string], SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId);
  }

  function readAttempt(attemptId: string): AttemptIdentityRow | undefined {
    return db.prepare<[string], AttemptIdentityRow>(
      `SELECT project_id, run_id, status, revision, owner_id, host_instance_id, execution_version,
        session_id, input_ref, execution_stage FROM attempts WHERE id = ?`).get(attemptId);
  }

  function assertIdentity(operation: string, input: { projectId: string; attemptId: string; owner: string;
    hostInstanceId: string; executionVersion: number }, attempt: AttemptIdentityRow | undefined, sessionId?: string): AttemptIdentityRow {
    if (!attempt) fail('not_found', operation, 'Attempt not found', sessionId, input.projectId);
    const row = attempt!;
    if (row.project_id !== input.projectId) fail('ownership', operation, 'Attempt belongs to another project', sessionId, input.projectId);
    if (row.owner_id !== input.owner || row.host_instance_id !== input.hostInstanceId
      || row.execution_version !== input.executionVersion) {
      fail('conflict', operation, 'Stale execution identity (owner/host/version)', sessionId, input.projectId);
    }
    return row;
  }

  function appendSessionEvent(input: { projectId: string; attemptId: string }, attempt: AttemptIdentityRow,
    sessionId: string, revision: number, status: WorkSessionStatus, stage: AttemptExecutionStage, timestamp: number): string {
    const eventId = randomUUID();
    const sequence = db.prepare<[], { next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()!.next;
    db.prepare(`INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence,
      event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, operation_id,
      run_id, attempt_id, execution_stage) VALUES (?, ?, 1, ?, ?, ?, ?, 'session', ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(eventId, timestamp, timestamp, input.projectId, sequence, WORK_SESSION_EVENT_TYPE, sessionId,
        revision, JSON.stringify({ schemaVersion: WORK_SESSION_SCHEMA_VERSION, status, executionStage: stage }),
        timestamp, attempt.run_id, input.attemptId, stage);
    return eventId;
  }

  function createInTransaction(raw: unknown): WorkSessionMutation {
    const operation = 'WorkSessionStore.create';
    if (!db.inTransaction) throw new TypeError('Work session creation requires a write transaction');
    const input = validateWorkSessionCreateInput(raw);
    const timestamp = now();
    const attempt = assertIdentity(operation, input, readAttempt(input.attemptId), input.sessionId);
    if (!(ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) {
      fail('conflict', operation, 'Attempt is not active', input.sessionId, input.projectId);
    }
    if (attempt.session_id !== null) {
      fail('conflict', operation, 'Attempt already has a top-level work session', input.sessionId, input.projectId);
    }
    db.prepare(`INSERT INTO sessions (id, created_at, updated_at, revision, project_id, attempt_id,
      parent_session_id, kind, title, purpose, runtime, adapter_version, provider_session_id, status,
      execution_stage, input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at,
      native_ref, recording_watermark, recording_gaps)
      VALUES (?, ?, ?, 1, ?, ?, NULL, 'work', NULL, ?, ?, ?, ?, 'reserved', ?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL)`)
      .run(input.sessionId, timestamp, timestamp, input.projectId, input.attemptId, input.purpose,
        input.runtime, input.adapterVersion, input.providerSessionId ?? null, attempt.execution_stage,
        attempt.input_ref, timestamp,
        input.nativeRef == null ? null : JSON.stringify(input.nativeRef));
    // 同一事务内 CAS 绑定 Attempt（session_id 仅可从 NULL 写一次，触发器兜底）。
    const bound = db.prepare(`UPDATE attempts SET session_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ?
      AND session_id IS NULL`)
      .run(input.sessionId, timestamp, input.attemptId, input.projectId, input.owner,
        input.hostInstanceId, input.executionVersion);
    if (bound.changes !== 1) fail('conflict', operation, 'Attempt session binding conflict', input.sessionId, input.projectId);
    const eventId = appendSessionEvent(input, attempt, input.sessionId, 1, 'reserved',
      attempt.execution_stage as AttemptExecutionStage, timestamp);
    const row = readSessionRow(input.sessionId);
    if (!row) fail('corrupt', operation, 'Work session missing after insert', input.sessionId, input.projectId);
    return { session: sessionFromRow(row!), eventId };
  }

  function progressInTransaction(raw: unknown): WorkSessionMutation {
    const operation = 'WorkSessionStore.progress';
    if (!db.inTransaction) throw new TypeError('Work session progress requires a write transaction');
    const input = validateWorkSessionProgressInput(raw);
    const timestamp = now();
    const row = readSessionRow(input.sessionId);
    if (!row) fail('not_found', operation, 'Work session not found', input.sessionId, input.projectId);
    if (row!.project_id !== input.projectId) fail('ownership', operation, 'Work session belongs to another project', input.sessionId);
    const record = sessionFromRow(row!);
    if (record.attemptId !== input.attemptId) {
      fail('conflict', operation, 'Work session attempt mismatch', input.sessionId, input.projectId);
    }
    const attempt = assertIdentity(operation, input, readAttempt(input.attemptId), input.sessionId);
    if (input.expectedRevision !== record.revision) {
      fail('conflict', operation, 'Work session revision conflict', input.sessionId, input.projectId);
    }
    if (timestamp < record.lastActivityAtUtcMs) {
      fail('conflict', operation, 'Activity clock regression', input.sessionId, input.projectId);
    }
    if (input.recordingWatermark != null && record.recordingWatermark !== null
      && input.recordingWatermark < record.recordingWatermark) {
      fail('conflict', operation, 'Recording watermark regression', input.sessionId, input.projectId);
    }
    if (input.kind === 'activity') {
      if (record.status === 'stopped') fail('conflict', operation, 'Stopped work session is terminal', input.sessionId, input.projectId);
    } else {
      const allowed = WORK_SESSION_TRANSITIONS[record.status];
      if (!allowed.includes(input.kind)) {
        fail('conflict', operation, `Invalid work session transition ${record.status} -> ${input.kind}`, input.sessionId, input.projectId);
      }
    }
    // 结果/诊断制品引用必须指向同项目 ready Artifact（正文不落 sessions 表）。
    if (input.resultRef != null) {
      const artifact = db.prepare<[string], { project_id: string; status: string }>(
        'SELECT project_id, status FROM artifacts WHERE id = ?').get(input.resultRef);
      if (!artifact) fail('conflict', operation, 'Result artifact is missing', input.sessionId, input.projectId);
      if (artifact!.project_id !== input.projectId) fail('ownership', operation, 'Result artifact belongs to another project', input.sessionId);
      if (artifact!.status !== 'ready') fail('conflict', operation, 'Result artifact is not ready', input.sessionId, input.projectId);
    }
    const nextStatus: WorkSessionStatus = input.kind === 'activity' ? record.status : input.kind;
    const nextStage: AttemptExecutionStage = input.executionStage ?? record.executionStage;
    const nextRevision = record.revision + 1;
    const changed = db.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = ?, status = ?,
      execution_stage = ?, result_ref = ?, last_activity_at = ?, started_at = ?, ended_at = ?, stopped_at = ?,
      provider_session_id = ?, native_ref = ?, recording_watermark = ?, recording_gaps = ?
      WHERE id = ? AND project_id = ? AND revision = ?`)
      .run(timestamp, nextStatus, nextStage,
        input.resultRef ?? record.resultRef, timestamp,
        input.kind === 'started' ? timestamp : record.startedAtUtcMs,
        input.kind === 'ended' ? timestamp : record.endedAtUtcMs,
        input.kind === 'stopped' ? timestamp : record.stoppedAtUtcMs,
        input.providerSessionId ?? record.providerSessionId,
        input.nativeRef != null ? JSON.stringify(input.nativeRef)
          : (record.nativeRef === null ? null : JSON.stringify(record.nativeRef)),
        input.recordingWatermark ?? record.recordingWatermark,
        input.recordingGaps == null
          ? (record.recordingGaps === null ? null : JSON.stringify(record.recordingGaps))
          : JSON.stringify(input.recordingGaps),
        input.sessionId, input.projectId, record.revision);
    if (changed.changes !== 1) fail('conflict', operation, 'Work session revision conflict', input.sessionId, input.projectId);
    // Attempt executionStage 在同一事务内一致推进（身份 + revision CAS，旧 owner/version 拒绝）。
    if (input.executionStage != null && input.executionStage !== attempt.execution_stage) {
      const stageChanged = db.prepare(`UPDATE attempts SET execution_stage = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?`)
        .run(input.executionStage, timestamp, input.attemptId, input.projectId, input.owner,
          input.hostInstanceId, input.executionVersion, attempt.revision);
      if (stageChanged.changes !== 1) fail('conflict', operation, 'Stale attempt execution stage', input.sessionId, input.projectId);
    }
    // activity 推进只刷新最后活动/水位元数据，不写状态事件。
    const eventId = input.kind === 'activity' ? null
      : appendSessionEvent(input, attempt, input.sessionId, nextRevision, nextStatus, nextStage, timestamp);
    const next = readSessionRow(input.sessionId);
    if (!next) fail('corrupt', operation, 'Work session missing after update', input.sessionId, input.projectId);
    return { session: sessionFromRow(next!), eventId };
  }

  function assertOpen(operation: string): void {
    if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
  }

  return {
    getWorkSession(projectId: string, sessionId: string): WorkSessionRecord {
      const operation = 'WorkSessionStore.read';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validSessionId = validateStableId(sessionId, { operation }, 'sessionId');
      assertOpen(operation);
      const read = (): WorkSessionRecord => {
        const row = readSessionRow(validSessionId);
        if (!row) fail('not_found', operation, 'Work session not found', validSessionId, validProjectId);
        if (row!.project_id !== validProjectId) fail('ownership', operation, 'Work session belongs to another project', validSessionId);
        return sessionFromRow(row!);
      };
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    getAttemptWorkSession(projectId: string, attemptId: string): WorkSessionRecord | null {
      const operation = 'WorkSessionStore.read';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validAttemptId = validateStableId(attemptId, { operation }, 'attemptId');
      assertOpen(operation);
      const read = (): WorkSessionRecord | null => {
        const row = db.prepare<[string], SessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE attempt_id = ?`).get(validAttemptId);
        if (!row) return null;
        if (row.project_id !== validProjectId) fail('ownership', operation, 'Work session belongs to another project', row.id);
        return sessionFromRow(row);
      };
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    createWorkSession(input: WorkSessionCreateInput): WorkSessionMutation {
      assertOpen('WorkSessionStore.create');
      return atomic.transact('WorkSessionStore.create', () => createInTransaction(input));
    },
    applyWorkSessionProgress(input: WorkSessionProgressInput): WorkSessionMutation {
      assertOpen('WorkSessionStore.progress');
      return atomic.transact('WorkSessionStore.progress', () => progressInTransaction(input));
    },
    createWorkSessionInTransaction(transaction: CommandTransaction, input: WorkSessionCreateInput): WorkSessionMutation {
      void transaction;
      assertOpen('WorkSessionStore.create');
      return createInTransaction(input);
    },
    applyWorkSessionProgressInTransaction(transaction: CommandTransaction, input: WorkSessionProgressInput): WorkSessionMutation {
      void transaction;
      assertOpen('WorkSessionStore.progress');
      return progressInTransaction(input);
    },
  };
}
