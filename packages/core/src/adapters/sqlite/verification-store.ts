/**
 * P03-7 / F-002：VerificationBatch / CheckResult 与不可变验证证据身份（SQLite 适配器，迁移 v21）。
 *
 * 复用现有状态事务（createSqliteAtomicCommandStore.transact）：批次创建、逐项保存、
 * 定版与适用回执可在同一短事务内原子提交；事务故障不留下半组权威结果。
 *
 * 核验规则（端口语义的真实执行）：
 * - 批次创建核对 Attempt 归属链：同 projectId、Attempt 的 feature/run/task 与批次一致、
 *   executionVersion 与 attempts/tasks 当前代一致（陈旧身份 conflict）；同 batchId
 *   同内容重放幂等返回（created=false），任何内容差异 conflict；
 * - 逐项保存要求批次仍为 running；checkKey 必须存在于批次检查定义快照，argv/cwd/
 *   environment/timeout/required 由快照派生（调用方不能混用不同定义身份）；输出制品
 *   必须存在、同项目、ready，outputDigest 记录实测 content_hash；同 (batchId, checkKey)
 *   同内容重放幂等，冲突内容 conflict；
 * - 定版 CAS：仅 running 可定版一次；passed 要求至少一项结果且全部 passed（fail-closed）；
 * - 证据读取只做索引级身份核验：ready + 记录摘要一致才是 complete；pending/缺失/failed/
 *   摘要不匹配返回 incomplete（reason），无输出为 none；文件级完整性由 artifact-verify
 *   承担；
 * - 行读取 fail-closed：损坏 JSON 抛 StorageError corrupt，不把原始内容泄漏进错误。
 */
import { isDeepStrictEqual } from 'node:util';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import {
  validateCheckResultRecord,
  validateCheckResultSaveInput,
  validateVerificationBatchCreateInput,
  validateVerificationBatchFinalizeInput,
  validateVerificationBatchRecord,
  type CheckResultEvidence,
  type CheckResultMutation,
  type CheckResultRecord,
  type CheckResultSaveInput,
  type VerificationBatchCreateInput,
  type VerificationBatchFinalizeInput,
  type VerificationBatchMutation,
  type VerificationBatchRecord,
  type VerificationStore,
} from '../../ports/verification-store.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';

export interface VerificationBatchRow {
  id: string; created_at: number; updated_at: number; revision: number; project_id: string;
  feature_id: string; run_id: string; task_id: string; attempt_id: string;
  execution_version: number; operation: string; code_digest: string; policy_digest: string;
  environment_summary: string; check_snapshot: string; selection: string; status: string;
  started_at: number | null; ended_at: number | null;
}

export interface CheckResultRow {
  id: string; created_at: number; updated_at: number; revision: number; project_id: string;
  batch_id: string; check_key: string; argv_json: string; cwd_ref: string | null;
  environment_ref: string | null; timeout_ms: number; required: number; status: string;
  exit_code: number | null; signal: string | null; timed_out: number;
  output_artifact_id: string | null; output_digest: string | null; output_tail: string | null;
  started_at: number | null; ended_at: number | null;
}

export const VERIFICATION_BATCH_COLUMNS = `id, created_at, updated_at, revision, project_id,
  feature_id, run_id, task_id, attempt_id, execution_version, operation, code_digest,
  policy_digest, environment_summary, check_snapshot, selection, status, started_at, ended_at`;

export const CHECK_RESULT_COLUMNS = `id, created_at, updated_at, revision, project_id, batch_id,
  check_key, argv_json, cwd_ref, environment_ref, timeout_ms, required, status, exit_code,
  signal, timed_out, output_artifact_id, output_digest, output_tail, started_at, ended_at`;

/** 行 → VerificationBatchRecord（fail-closed：损坏行抛 corrupt，不泄漏原始内容）。 */
export function verificationBatchRecordFromRow(row: VerificationBatchRow): VerificationBatchRecord {
  try {
    return validateVerificationBatchRecord({
      id: row.id, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
      revision: row.revision, projectId: row.project_id, featureId: row.feature_id,
      runId: row.run_id, taskId: row.task_id, attemptId: row.attempt_id,
      executionVersion: row.execution_version, operation: row.operation,
      codeDigest: row.code_digest, policyDigest: row.policy_digest,
      environmentSummary: JSON.parse(row.environment_summary),
      checkSnapshot: JSON.parse(row.check_snapshot),
      selection: JSON.parse(row.selection),
      status: row.status, startedAtUtcMs: row.started_at, endedAtUtcMs: row.ended_at,
    });
  } catch {
    throw new StorageError('corrupt', 'VerificationStore.read', 'Invalid stored verification batch', {
      entity: { type: 'verification_batch', id: row.id, projectId: row.project_id },
    });
  }
}

/** 行 → CheckResultRecord（fail-closed，同上）。 */
export function checkResultRecordFromRow(row: CheckResultRow): CheckResultRecord {
  try {
    return validateCheckResultRecord({
      id: row.id, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
      revision: row.revision, projectId: row.project_id, batchId: row.batch_id,
      checkKey: row.check_key, argv: JSON.parse(row.argv_json),
      cwdRef: row.cwd_ref, environmentRef: row.environment_ref,
      timeoutMs: row.timeout_ms, required: row.required === 1, status: row.status,
      exitCode: row.exit_code, signal: row.signal, timedOut: row.timed_out === 1,
      outputArtifactId: row.output_artifact_id, outputDigest: row.output_digest,
      outputTail: row.output_tail, startedAtUtcMs: row.started_at, endedAtUtcMs: row.ended_at,
    });
  } catch {
    throw new StorageError('corrupt', 'VerificationStore.read', 'Invalid stored check result', {
      entity: { type: 'check_result', id: row.id, projectId: row.project_id },
    });
  }
}

interface AttemptIdentityRow {
  project_id: string; feature_id: string; run_id: string; task_id: string;
  execution_version: number; task_execution_version: number;
}

export function createSqliteVerificationStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): VerificationStore {
  const db = session.database;
  const now = options.nowUtcMs ?? (() => Date.now());
  const atomic = createSqliteAtomicCommandStore(session, options);

  function fail(kind: 'validation' | 'not_found' | 'conflict' | 'ownership' | 'corrupt', operation: string,
    message: string, entity?: { readonly type: 'verification_batch' | 'check_result'; readonly id?: string; readonly projectId?: string }): never {
    throw new StorageError(kind, operation, message, entity === undefined ? undefined : { entity });
  }

  function readBatchRow(batchId: string): VerificationBatchRow | undefined {
    return db.prepare<[string], VerificationBatchRow>(
      `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches WHERE id = ?`).get(batchId);
  }

  function readResultRow(resultId: string): CheckResultRow | undefined {
    return db.prepare<[string], CheckResultRow>(
      `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE id = ?`).get(resultId);
  }

  function listResultRows(batchId: string): CheckResultRow[] {
    return db.prepare<[string], CheckResultRow>(
      `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE batch_id = ? ORDER BY created_at, id`).all(batchId);
  }

  function readAttemptIdentity(attemptId: string): AttemptIdentityRow | undefined {
    return db.prepare<[string], AttemptIdentityRow>(
      `SELECT a.project_id, a.feature_id, a.run_id, a.task_id, a.execution_version,
        t.execution_version AS task_execution_version
        FROM attempts a JOIN tasks t ON t.id = a.task_id AND t.project_id = a.project_id
        WHERE a.id = ?`).get(attemptId);
  }

  /** 批次内容与已存记录逐字段一致（幂等重放判定；时间戳/revision 不参与比较）。 */
  function sameBatchContent(record: VerificationBatchRecord, input: VerificationBatchCreateInput): boolean {
    return record.projectId === input.projectId && record.featureId === input.featureId
      && record.runId === input.runId && record.taskId === input.taskId
      && record.attemptId === input.attemptId && record.executionVersion === input.executionVersion
      && record.operation === input.operation && record.codeDigest === input.codeDigest
      && record.policyDigest === input.policyDigest
      && JSON.stringify(record.environmentSummary) === JSON.stringify(input.environmentSummary)
      && JSON.stringify(record.checkSnapshot) === JSON.stringify(input.checkSnapshot)
      && JSON.stringify(record.selection) === JSON.stringify(input.selection)
      && record.status === 'running' && record.startedAtUtcMs === input.startedAtUtcMs;
  }

  function sameResultContent(record: CheckResultRecord, input: CheckResultSaveInput,
    derived: { readonly argv: readonly string[]; readonly cwdRef: string | null; readonly environmentRef: string | null;
      readonly timeoutMs: number; readonly required: boolean; readonly outputDigest: string | null }): boolean {
    return record.projectId === input.projectId && record.batchId === input.batchId
      && record.checkKey === input.checkKey && record.status === input.status
      && record.exitCode === input.exitCode && record.signal === input.signal
      && record.timedOut === input.timedOut && record.outputArtifactId === input.outputArtifactId
      && record.outputDigest === derived.outputDigest && record.outputTail === input.outputTail
      && record.startedAtUtcMs === input.startedAtUtcMs && record.endedAtUtcMs === input.endedAtUtcMs
      && JSON.stringify(record.argv) === JSON.stringify(derived.argv)
      && record.cwdRef === derived.cwdRef && record.environmentRef === derived.environmentRef
      && record.timeoutMs === derived.timeoutMs && record.required === derived.required;
  }

  function insertBatch(input: VerificationBatchCreateInput, timestamp: number): void {
    db.prepare(`INSERT INTO verification_batches (id, created_at, updated_at, revision, project_id,
      feature_id, run_id, task_id, attempt_id, execution_version, operation, code_digest,
      policy_digest, environment_summary, check_snapshot, selection, status, started_at, ended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL)`)
      .run(input.batchId, timestamp, timestamp, input.projectId, input.featureId, input.runId,
        input.taskId, input.attemptId, input.executionVersion, input.operation, input.codeDigest,
        input.policyDigest, JSON.stringify(input.environmentSummary),
        JSON.stringify(input.checkSnapshot), JSON.stringify(input.selection), input.startedAtUtcMs);
  }

  function createBatchInTransaction(raw: unknown): VerificationBatchMutation {
    const operation = 'VerificationStore.createBatch';
    if (!db.inTransaction) throw new TypeError('Verification batch creation requires a write transaction');
    const input = validateVerificationBatchCreateInput(raw);
    const entity = { type: 'verification_batch' as const, id: input.batchId, projectId: input.projectId };
    const existing = readBatchRow(input.batchId);
    if (existing) {
      const record = verificationBatchRecordFromRow(existing);
      if (sameBatchContent(record, input)) return { batch: record, created: false };
      fail('conflict', operation, 'Verification batch id replay with conflicting content', entity);
    }
    const attempt = readAttemptIdentity(input.attemptId);
    if (!attempt) fail('not_found', operation, 'Attempt not found', entity);
    if (attempt!.project_id !== input.projectId) {
      fail('ownership', operation, 'Attempt belongs to another project', entity);
    }
    if (attempt!.feature_id !== input.featureId || attempt!.run_id !== input.runId
      || attempt!.task_id !== input.taskId || attempt!.execution_version !== input.executionVersion
      || attempt!.task_execution_version !== input.executionVersion) {
      fail('conflict', operation, 'Stale or mismatched attempt identity (feature/run/task/version)', entity);
    }
    try {
      insertBatch(input, now());
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: verification_batches\./.test(error.message)) {
        fail('conflict', operation, 'Verification batch id conflict', entity);
      }
      throw error;
    }
    const row = readBatchRow(input.batchId);
    if (!row) fail('corrupt', operation, 'Verification batch missing after insert', entity);
    return { batch: verificationBatchRecordFromRow(row!), created: true };
  }

  function assertCurrentBatch(batch: VerificationBatchRecord): void {
    const attempt = readAttemptIdentity(batch.attemptId);
    if (!attempt || attempt.project_id !== batch.projectId || attempt.feature_id !== batch.featureId
      || attempt.run_id !== batch.runId || attempt.task_id !== batch.taskId
      || attempt.execution_version !== batch.executionVersion || attempt.task_execution_version !== batch.executionVersion) {
      fail('conflict', 'VerificationStore.write', 'Stale verification execution identity');
    }
  }

  function saveResultInTransaction(raw: unknown): CheckResultMutation {
    const operation = 'VerificationStore.saveResult';
    if (!db.inTransaction) throw new TypeError('Check result save requires a write transaction');
    const input = validateCheckResultSaveInput(raw);
    const entity = { type: 'check_result' as const, id: input.resultId, projectId: input.projectId };
    const batchRow = readBatchRow(input.batchId);
    if (!batchRow) fail('not_found', operation, 'Verification batch not found', entity);
    if (batchRow!.project_id !== input.projectId) {
      fail('ownership', operation, 'Verification batch belongs to another project', entity);
    }
    const batch = verificationBatchRecordFromRow(batchRow!);
    assertCurrentBatch(batch);
    const definition = batch.checkSnapshot.find((entry) => entry.checkKey === input.checkKey);
    if (!definition) {
      fail('conflict', operation, 'Check is not part of the batch snapshot', entity);
    }
    // 输出证据：仅同项目 ready Artifact；记录其摘要身份，供读取时核对篡改。
    let outputDigest: string | null = null;
    if (input.outputArtifactId !== null) {
      const artifact = db.prepare<[string], { project_id: string; status: string; content_hash: string | null }>(
        'SELECT project_id, status, content_hash FROM artifacts WHERE id = ?').get(input.outputArtifactId);
      if (!artifact) fail('conflict', operation, 'Output artifact is missing', entity);
      if (artifact!.project_id !== input.projectId) {
        fail('ownership', operation, 'Output artifact belongs to another project', entity);
      }
      if (artifact!.status !== 'ready' || artifact!.content_hash === null) {
        fail('conflict', operation, 'Output artifact is not ready', entity);
      }
      outputDigest = artifact!.content_hash;
    }
    const derived = {
      argv: definition!.argv, cwdRef: definition!.cwdRef, environmentRef: definition!.environmentRef,
      timeoutMs: definition!.timeout, required: definition!.required, outputDigest,
    };
    const existingRow = db.prepare<[string, string], CheckResultRow>(
      `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE batch_id = ? AND check_key = ?`)
      .get(input.batchId, input.checkKey);
    if (existingRow) {
      const record = checkResultRecordFromRow(existingRow);
      if (record.id === input.resultId && sameResultContent(record, input, derived)) {
        return { result: record, created: false };
      }
      fail('conflict', operation, 'Check result replay with conflicting content', entity);
    }
    if (batch.status !== 'running') {
      fail('conflict', operation, 'Verification batch is already finalized', entity);
    }
    const timestamp = now();
    try {
      db.prepare(`INSERT INTO check_results (id, created_at, updated_at, revision, project_id, batch_id,
        check_key, argv_json, cwd_ref, environment_ref, timeout_ms, required, status, exit_code,
        signal, timed_out, output_artifact_id, output_digest, output_tail, started_at, ended_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.resultId, timestamp, timestamp, input.projectId, input.batchId, input.checkKey,
          JSON.stringify(definition!.argv), definition!.cwdRef, definition!.environmentRef,
          definition!.timeout, definition!.required ? 1 : 0, input.status, input.exitCode,
          input.signal, input.timedOut ? 1 : 0, input.outputArtifactId, outputDigest,
          input.outputTail, input.startedAtUtcMs, input.endedAtUtcMs);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: check_results\./.test(error.message)) {
        fail('conflict', operation, 'Check result id conflict', entity);
      }
      throw error;
    }
    const row = readResultRow(input.resultId);
    if (!row) fail('corrupt', operation, 'Check result missing after insert', entity);
    return { result: checkResultRecordFromRow(row!), created: true };
  }

  function finalizeBatchInTransaction(raw: unknown): VerificationBatchRecord {
    const operation = 'VerificationStore.finalizeBatch';
    if (!db.inTransaction) throw new TypeError('Verification batch finalize requires a write transaction');
    const input = validateVerificationBatchFinalizeInput(raw);
    const entity = { type: 'verification_batch' as const, id: input.batchId, projectId: input.projectId };
    const row = readBatchRow(input.batchId);
    if (!row) fail('not_found', operation, 'Verification batch not found', entity);
    if (row!.project_id !== input.projectId) {
      fail('ownership', operation, 'Verification batch belongs to another project', entity);
    }
    const batch = verificationBatchRecordFromRow(row!);
    assertCurrentBatch(batch);
    if (batch.status !== 'running') {
      fail('conflict', operation, 'Verification batch is already finalized', entity);
    }
    if (input.expectedRevision !== batch.revision) {
      fail('conflict', operation, 'Verification batch revision conflict', entity);
    }
    const results = listResultRows(input.batchId).map((resultRow) => checkResultRecordFromRow(resultRow));
    // fail-closed：空检查或任何非 passed 结果都不能定版 passed（更严格的选择/必需性
    // 聚合由上层 Verifier 判定）。
    if (input.status === 'passed'
      && (results.length === 0 || results.some((result) => result.status !== 'passed')
        || batch.checkSnapshot.some(check => (check.required || batch.selection.selectedCheckKeys.includes(check.checkKey))
          && !results.some(result => result.checkKey === check.checkKey && result.status === 'passed')))) {
      fail('conflict', operation, 'Zero or non-passed checks cannot finalize as passed', entity);
    }
    const endedAt = input.endedAtUtcMs ?? now();
    if (batch.startedAtUtcMs !== null && endedAt < batch.startedAtUtcMs) {
      fail('conflict', operation, 'Batch end time precedes start time', entity);
    }
    const changed = db.prepare(`UPDATE verification_batches SET revision = revision + 1, updated_at = ?,
      status = ?, ended_at = ? WHERE id = ? AND project_id = ? AND revision = ? AND status = 'running'`)
      .run(now(), input.status, endedAt, input.batchId, input.projectId, batch.revision);
    if (changed.changes !== 1) {
      fail('conflict', operation, 'Verification batch revision conflict', entity);
    }
    const next = readBatchRow(input.batchId);
    if (!next) fail('corrupt', operation, 'Verification batch missing after finalize', entity);
    return verificationBatchRecordFromRow(next!);
  }

  function assertOpen(operation: string): void {
    if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
  }

  function readEvidence(projectId: string, resultId: string): CheckResultEvidence {
    const operation = 'VerificationStore.readEvidence';
    const entity = { type: 'check_result' as const, id: resultId, projectId };
    const row = readResultRow(resultId);
    if (!row) fail('not_found', operation, 'Check result not found', entity);
    if (row!.project_id !== projectId) {
      fail('ownership', operation, 'Check result belongs to another project', entity);
    }
    const record = checkResultRecordFromRow(row!);
    if (record.outputArtifactId === null || record.outputDigest === null) {
      return { status: 'none', outputTail: record.outputTail };
    }
    const artifact = db.prepare<[string], {
      project_id: string; status: string; content_hash: string | null; size_bytes: number | null;
      storage_locator: string; version: number;
    }>('SELECT project_id, status, content_hash, size_bytes, storage_locator, version FROM artifacts WHERE id = ?')
      .get(record.outputArtifactId);
    const artifactId = record.outputArtifactId;
    if (!artifact) return { status: 'incomplete', reason: 'artifact_missing', artifactId };
    if (artifact.project_id !== projectId) {
      fail('ownership', operation, 'Evidence artifact belongs to another project', entity);
    }
    if (artifact.status === 'pending') return { status: 'incomplete', reason: 'artifact_pending', artifactId };
    if (artifact.status === 'failed') return { status: 'incomplete', reason: 'artifact_failed', artifactId };
    if (artifact.content_hash === null || artifact.content_hash !== record.outputDigest
      || artifact.size_bytes === null) {
      return { status: 'incomplete', reason: 'digest_mismatch', artifactId };
    }
    return {
      status: 'complete', artifactId, contentHash: artifact.content_hash,
      sizeBytes: artifact.size_bytes, locator: artifact.storage_locator,
      version: artifact.version, outputTail: record.outputTail,
    };
  }

  return {
    confirmCheckProcessInTransaction(_transaction, input) {
      if (!db.inTransaction) throw new TypeError('Verifier confirmation requires a write transaction');
      const batch = this.getVerificationBatch(input.projectId, input.batchId);
      assertCurrentBatch(batch);
      if (batch.status !== 'running' || !batch.selection.selectedCheckKeys.includes(input.checkKey)) {
        fail('conflict', 'VerificationStore.confirmProcess', 'Check is not running in this batch');
      }
      const processIdentity = validateWorkProcessIdentity(input.processIdentity);
      const existing = db.prepare<[string, string], { process_identity: string }>(
        'SELECT process_identity FROM verification_processes WHERE batch_id = ? AND check_key = ?').get(batch.id, input.checkKey);
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(existing.process_identity), processIdentity)) {
          fail('conflict', 'VerificationStore.confirmProcess', 'Check process identity is immutable');
        }
        return;
      }
      db.prepare('INSERT INTO verification_processes (batch_id, check_key, process_identity) VALUES (?, ?, ?)')
        .run(batch.id, input.checkKey, JSON.stringify(processIdentity));
    },
    getVerificationBatch(projectId: string, batchId: string): VerificationBatchRecord {
      const operation = 'VerificationStore.read';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validBatchId = validateStableId(batchId, { operation }, 'batchId');
      assertOpen(operation);
      const read = (): VerificationBatchRecord => {
        const row = readBatchRow(validBatchId);
        if (!row) fail('not_found', operation, 'Verification batch not found',
          { type: 'verification_batch', id: validBatchId, projectId: validProjectId });
        if (row!.project_id !== validProjectId) {
          fail('ownership', operation, 'Verification batch belongs to another project',
            { type: 'verification_batch', id: validBatchId });
        }
        return verificationBatchRecordFromRow(row!);
      };
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    listAttemptVerificationBatches(projectId: string, attemptId: string): readonly VerificationBatchRecord[] {
      const operation = 'VerificationStore.read';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validAttemptId = validateStableId(attemptId, { operation }, 'attemptId');
      assertOpen(operation);
      const read = (): readonly VerificationBatchRecord[] =>
        db.prepare<[string, string], VerificationBatchRow>(
          `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches
            WHERE project_id = ? AND attempt_id = ? ORDER BY created_at, id`)
          .all(validProjectId, validAttemptId)
          .map((row) => verificationBatchRecordFromRow(row));
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    listCheckResults(projectId: string, batchId: string): readonly CheckResultRecord[] {
      const operation = 'VerificationStore.read';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validBatchId = validateStableId(batchId, { operation }, 'batchId');
      assertOpen(operation);
      const read = (): readonly CheckResultRecord[] => {
        const batch = readBatchRow(validBatchId);
        if (!batch) fail('not_found', operation, 'Verification batch not found',
          { type: 'verification_batch', id: validBatchId, projectId: validProjectId });
        if (batch!.project_id !== validProjectId) {
          fail('ownership', operation, 'Verification batch belongs to another project',
            { type: 'verification_batch', id: validBatchId });
        }
        return listResultRows(validBatchId).map((row) => checkResultRecordFromRow(row));
      };
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    createVerificationBatch(input: unknown): VerificationBatchMutation {
      assertOpen('VerificationStore.createBatch');
      return atomic.transact('VerificationStore.createBatch', () => createBatchInTransaction(input));
    },
    saveCheckResult(input: unknown): CheckResultMutation {
      assertOpen('VerificationStore.saveResult');
      return atomic.transact('VerificationStore.saveResult', () => saveResultInTransaction(input));
    },
    finalizeVerificationBatch(input: unknown): VerificationBatchRecord {
      assertOpen('VerificationStore.finalizeBatch');
      return atomic.transact('VerificationStore.finalizeBatch', () => finalizeBatchInTransaction(input));
    },
    readCheckResultEvidence(projectId: string, resultId: string): CheckResultEvidence {
      const operation = 'VerificationStore.readEvidence';
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validResultId = validateStableId(resultId, { operation }, 'resultId');
      assertOpen(operation);
      const read = (): CheckResultEvidence => readEvidence(validProjectId, validResultId);
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, operation, read);
    },
    createVerificationBatchInTransaction(transaction: CommandTransaction, input: unknown): VerificationBatchMutation {
      void transaction;
      assertOpen('VerificationStore.createBatch');
      return createBatchInTransaction(input);
    },
    saveCheckResultInTransaction(transaction: CommandTransaction, input: unknown): CheckResultMutation {
      void transaction;
      assertOpen('VerificationStore.saveResult');
      return saveResultInTransaction(input);
    },
    finalizeVerificationBatchInTransaction(transaction: CommandTransaction, input: unknown): VerificationBatchRecord {
      void transaction;
      assertOpen('VerificationStore.finalizeBatch');
      return finalizeBatchInTransaction(input);
    },
  };
}
