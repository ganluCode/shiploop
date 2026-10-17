/**
 * P03-7 / F-002 VerificationBatch / CheckResult 与不可变验证证据身份持久化（真实 SQLite，非 mock）。
 *
 * 覆盖（F-002 验收标准）：
 * - 迁移 v21 从前序实际最新迁移（v20）追加 verification_batches / check_results 两表，
 *   仅新增本项结构；真实空库、P02 v5 库与前序 v20 库均可升级，v1–v20 checksum 冻结不变；
 *   关闭重开后批次与逐项结果逐字段读回；失败 v21 DDL 回滚后可干净重试；
 * - 批次关联 Project/Feature/Run/Task/Attempt/executionVersion/operation，保存代码身份
 *   （code_digest）、检查定义快照、策略与环境身份、选择/回退理由；逐项保存状态、argv、
 *   cwd、timeout、时间、exitCode、signal、输出 Artifact 引用与有界 tail；未知指标为 null；
 * - 跨项目或混用不同 Attempt/代码身份被拒绝；重复保存同一结果幂等，冲突结果拒绝；
 *   非法引用与事务故障不留下半组权威结果（批次+结果+回执同事务回滚）；
 * - 大输出正文仅引用既有 ready Artifact；pending/缺失/失败/摘要不匹配的证据不能作为
 *   完整证据读取；历史失败批次与逐项结果不被新批次覆盖（逐项结果不可变触发器）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import {
  validateCheckResultRecord,
  validateCheckResultSaveInput,
  validateVerificationBatchCreateInput,
  validateVerificationBatchFinalizeInput,
  validateVerificationBatchRecord,
} from '../packages/core/src/ports/verification-store.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { openBudgetFixture, NOW } from './helpers/p03-3/budget-fixture.ts';

const HASH = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const HASH_C = 'ef'.repeat(32);

function preparedInput(projectId: string, featureId: string, taskId = 't-1') {
  const ref = (artifactId: string) => ({ artifactId, version: 1, contentHash: HASH,
    sizeBytes: 10, locator: `inputs/${artifactId}`, mediaType: 'application/json' });
  return { schemaVersion: 1, projectId, featureId, taskId,
    group: { snapshot: ref('snapshot-1'), manifest: ref('manifest-1'), prompt: ref('prompt-1') },
    requiredInputs: [], digests: { snapshotDigest: HASH, manifestDigest: HASH, promptDigest: HASH,
      strategyCopyDigest: HASH, permissionsDigest: HASH },
    approval: { planDigest: HASH, checkPolicyDigest: HASH, decisionId: null, featureRevision: 1 },
    taskRevision: 1, promptBytes: 10,
    tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' }, preparedAtUtcMs: NOW };
}

const CHECK_UNIT = {
  checkKey: 'unit-tests', scope: 'project', kind: 'command',
  argv: ['node', 'scripts/run-tests.ts'], cwdRef: null, environmentRef: null,
  timeout: 600_000, required: true, requirementRefs: ['T39'],
} as const;
const CHECK_LINT = {
  checkKey: 'lint', scope: 'module', kind: 'command',
  argv: ['npm', 'run', 'lint'], cwdRef: 'packages/core', environmentRef: 'minimal',
  timeout: 300_000, required: false, requirementRefs: [],
} as const;

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const inputSnapshot = preparedInput(box.projectId, box.featureId, ids.taskId);
  const db = box.session.database;
  db.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run(ids.taskId);
  const insertArtifact = (id: string, status: 'ready' | 'pending' | 'failed' = 'ready', contentHash: string | null = HASH) => {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'verification-output', ?, 'text/plain', ?, ?, ?, ?)`)
      .run(id, NOW, NOW, box.projectId, status, HASH, status === 'ready' ? contentHash : null, status === 'ready' ? 128 : null, `outputs/${id}.log`);
  };
  // Attempt 输入组制品：身份必须与 input_snapshot.group 引用逐字段一致（触发器核验）。
  const insertInputArtifact = (id: string) => {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', 'ready', 'application/json', ?, ?, 10, ?)`)
      .run(id, NOW, NOW, box.projectId, HASH, HASH, `inputs/${id}`);
  };
  for (const ref of Object.values(inputSnapshot.group)) insertInputArtifact(ref.artifactId);
  insertArtifact('output-1');
  insertArtifact('output-2');
  insertArtifact('pending-1', 'pending');
  const insertAttempt = (overrides: Record<string, unknown> = {}) => {
    const row = { id: 'attempt-1', created_at: NOW, updated_at: NOW, project_id: box.projectId,
      feature_id: box.featureId, run_id: ids.runId, task_id: ids.taskId, number: 1,
      owner_id: 'owner-1', host_instance_id: 'host-1', execution_version: 1,
      lease_until: NOW + 1000, input_snapshot: JSON.stringify(inputSnapshot), input_digest: HASH,
      input_ref: 'snapshot-1', ...overrides };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO attempts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row) as (string | number | null)[]);
  };
  const store = (clock: () => number = () => NOW) => createSqliteVerificationStore(box.session, { nowUtcMs: clock });
  const batchInput = (overrides: Record<string, unknown> = {}) => ({
    batchId: 'vbatch-1', projectId: box.projectId, featureId: box.featureId, runId: ids.runId,
    taskId: ids.taskId, attemptId: 'attempt-1', executionVersion: 1,
    operation: 'task.verify.checks', codeDigest: HASH, policyDigest: HASH_B,
    environmentSummary: { runner: 'node', nodeVersion: 'v22.19.0', platform: 'darwin' },
    checkSnapshot: [CHECK_UNIT, CHECK_LINT],
    selection: { schemaVersion: 1, mode: 'full_fallback', reason: '候选缺失，安全回退全量', selectedCheckKeys: ['unit-tests', 'lint'] },
    startedAtUtcMs: NOW,
    ...overrides,
  });
  const resultInput = (overrides: Record<string, unknown> = {}) => ({
    resultId: 'vres-1', projectId: box.projectId, batchId: 'vbatch-1', checkKey: 'unit-tests',
    status: 'passed', exitCode: 0, signal: null, timedOut: false,
    outputArtifactId: 'output-1', outputTail: '12 passed\n0 failed',
    startedAtUtcMs: NOW, endedAtUtcMs: NOW + 1_000,
    ...overrides,
  });
  return { box, db, ids, inputSnapshot, insertArtifact, insertAttempt, store, batchInput, resultInput };
}

describe('P03-7 F-002 migration v21 verification schema', () => {
  it('appends v21 without changing the delivered v1-v20 checksums', () => {
    expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(25);
    expect(SQLITE_MIGRATIONS).toHaveLength(25);
    // Frozen from the predecessor source, not recomputed from the new descriptors.
    const oldChecksums = SQLITE_MIGRATIONS.slice(0, 20).map((m) => m.checksum).join('\n');
    expect(createHash('sha256').update(oldChecksums).digest('hex'))
      .toBe('9cb2aec8429b81b932fbaffc5e50c1f5632cc997ae9f0fe1621f9198fcc89744');
    const v21 = SQLITE_MIGRATIONS[20]!;
    expect(v21.checksum).toBe(createHash('sha256').update(v21.sql).digest('hex'));
    expect(v21.sql).toContain('CREATE TABLE verification_batches');
    expect(v21.sql).toContain('CREATE TABLE check_results');
    // 不建 check_definitions 表（定义存 settings，批次保存快照）或配置/计划版本表。
    expect(v21.sql).not.toMatch(/CREATE TABLE (check_definitions|configuration_revisions|plan_revisions)/);
  });

  it('creates both tables with expected columns, indexes, foreign keys and immutability triggers', async () => {
    const f = await fixture();
    try {
      const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
      expect(tables).toContain('verification_batches');
      expect(tables).toContain('check_results');
      expect(tables).not.toContain('check_definitions');
      const batchColumns = f.db.prepare('PRAGMA table_xinfo(verification_batches)').all().map((r) => (r as { name: string }).name);
      for (const column of ['id', 'created_at', 'updated_at', 'revision', 'project_id', 'feature_id',
        'run_id', 'task_id', 'attempt_id', 'execution_version', 'operation', 'code_digest',
        'policy_digest', 'environment_summary', 'check_snapshot', 'selection', 'status',
        'started_at', 'ended_at']) {
        expect(batchColumns).toContain(column);
      }
      const resultColumns = f.db.prepare('PRAGMA table_xinfo(check_results)').all().map((r) => (r as { name: string }).name);
      for (const column of ['id', 'created_at', 'updated_at', 'revision', 'project_id', 'batch_id',
        'check_key', 'argv_json', 'cwd_ref', 'environment_ref', 'timeout_ms', 'required', 'status',
        'exit_code', 'signal', 'timed_out', 'output_artifact_id', 'output_digest', 'output_tail',
        'started_at', 'ended_at']) {
        expect(resultColumns).toContain(column);
      }
      const batchIndexes = f.db.prepare('PRAGMA index_list(verification_batches)').all().map((r) => (r as { name: string }).name);
      expect(batchIndexes).toEqual(expect.arrayContaining([
        'verification_batches_project_id_id_unique', 'verification_batches_project_attempt_index']));
      const resultIndexes = f.db.prepare('PRAGMA index_list(check_results)').all().map((r) => (r as { name: string }).name);
      expect(resultIndexes).toEqual(expect.arrayContaining([
        'check_results_project_id_id_unique', 'check_results_batch_check_unique']));
      const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => (r as { name: string }).name);
      expect(triggers).toEqual(expect.arrayContaining([
        'verification_batches_attempt_identity_check',
        'verification_batches_identity_immutable',
        'verification_batches_terminal_immutable',
        'check_results_output_ready_insert',
        'check_results_immutable_update',
      ]));
    } finally { f.box.close(); }
  });
});

describe('P03-7 F-002 verification port validators', () => {
  const validBatchRecord = {
    id: 'vbatch-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1, projectId: 'proj-1',
    featureId: 'feature-1', runId: 'run-1', taskId: 't-1', attemptId: 'attempt-1',
    executionVersion: 1, operation: 'task.verify.checks', codeDigest: HASH, policyDigest: HASH_B,
    environmentSummary: { runner: 'node' }, checkSnapshot: [CHECK_UNIT],
    selection: { schemaVersion: 1, mode: 'candidates', reason: '候选有效', selectedCheckKeys: ['unit-tests'] },
    status: 'running', startedAtUtcMs: NOW, endedAtUtcMs: null,
  };
  const validResultRecord = {
    id: 'vres-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1, projectId: 'proj-1',
    batchId: 'vbatch-1', checkKey: 'unit-tests',
    argv: ['node', 'scripts/run-tests.ts'], cwdRef: null, environmentRef: null,
    timeoutMs: 600_000, required: true, status: 'passed',
    exitCode: 0, signal: null, timedOut: false,
    outputArtifactId: 'output-1', outputDigest: HASH, outputTail: '12 passed',
    startedAtUtcMs: NOW, endedAtUtcMs: NOW + 1_000,
  };

  it('accepts lawful batch/result records with unknown metrics null', () => {
    expect(validateVerificationBatchRecord(validBatchRecord)).toEqual(validBatchRecord);
    expect(validateVerificationBatchRecord({
      ...validBatchRecord, status: 'failed', endedAtUtcMs: NOW + 5_000,
    }).status).toBe('failed');
    // error 状态允许未知指标为 null（不填 0）。
    expect(validateCheckResultRecord({
      ...validResultRecord, status: 'error', exitCode: null, signal: null,
      outputArtifactId: null, outputDigest: null, outputTail: null,
      startedAtUtcMs: null, endedAtUtcMs: null,
    })).toMatchObject({ status: 'error', exitCode: null, outputDigest: null });
    expect(validateCheckResultRecord({
      ...validResultRecord, status: 'not_run', exitCode: null, signal: null, timedOut: false,
      outputArtifactId: null, outputDigest: null, outputTail: null,
      startedAtUtcMs: null, endedAtUtcMs: null,
    }).status).toBe('not_run');
    expect(validateCheckResultRecord({
      ...validResultRecord, status: 'failed', exitCode: null, signal: 'SIGTERM', timedOut: true,
      outputArtifactId: null, outputDigest: null,
    })).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
  });

  it('rejects unknown keys, bad enums, digest, lifecycle and evidence identity shapes', () => {
    for (const bad of [
      { ...validBatchRecord, unexpected: true },
      { ...validBatchRecord, status: 'passed' }, // passed 必须有 endedAtUtcMs
      { ...validBatchRecord, status: 'done' },
      { ...validBatchRecord, status: 'running', endedAtUtcMs: NOW },
      { ...validBatchRecord, status: 'failed', endedAtUtcMs: NOW - 1 },
      { ...validBatchRecord, executionVersion: 0 },
      { ...validBatchRecord, codeDigest: 'AB'.repeat(32) },
      { ...validBatchRecord, policyDigest: 'short' },
      { ...validBatchRecord, operation: '' },
      { ...validBatchRecord, environmentSummary: ['node'] },
      { ...validBatchRecord, checkSnapshot: [] },
      { ...validBatchRecord, checkSnapshot: [{ ...CHECK_UNIT, checkKey: 'Bad Key' }] },
      { ...validBatchRecord, checkSnapshot: [{ ...CHECK_UNIT, argv: [] }] },
      { ...validBatchRecord, selection: { schemaVersion: 2, mode: 'candidates', reason: 'x', selectedCheckKeys: ['unit-tests'] } },
      { ...validBatchRecord, selection: { schemaVersion: 1, mode: 'partial', reason: 'x', selectedCheckKeys: ['unit-tests'] } },
      { ...validBatchRecord, selection: { schemaVersion: 1, mode: 'candidates', reason: 'x', selectedCheckKeys: ['unknown-check'] } },
      { ...validBatchRecord, selection: { schemaVersion: 1, mode: 'candidates', reason: 'x', selectedCheckKeys: ['unit-tests', 'unit-tests'] } },
    ]) expect(() => validateVerificationBatchRecord(bad)).toThrow();

    for (const bad of [
      { ...validResultRecord, unexpected: 1 },
      { ...validResultRecord, status: 'skipped' },
      { ...validResultRecord, checkKey: 'Bad Key' },
      { ...validResultRecord, argv: [] },
      { ...validResultRecord, timeoutMs: 0 },
      { ...validResultRecord, exitCode: 0.5 },
      { ...validResultRecord, status: 'passed', exitCode: 1 },
      { ...validResultRecord, status: 'passed', timedOut: true },
      { ...validResultRecord, status: 'not_run' },
      { ...validResultRecord, status: 'not_run', exitCode: null, signal: null, startedAtUtcMs: NOW },
      { ...validResultRecord, timedOut: true, status: 'inconclusive' },
      { ...validResultRecord, outputArtifactId: null },
      { ...validResultRecord, outputDigest: null },
      { ...validResultRecord, outputDigest: 'zz'.repeat(32) },
      { ...validResultRecord, outputTail: 'x'.repeat(8193) },
      { ...validResultRecord, outputTail: 'bad\u0001control' },
      { ...validResultRecord, endedAtUtcMs: NOW - 1 },
      { ...validResultRecord, signal: 'SIG\nTERM' },
    ]) expect(() => validateCheckResultRecord(bad)).toThrow();
  });

  it('validates create/save/finalize inputs without touching storage', () => {
    const create = {
      batchId: 'vbatch-1', projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1',
      taskId: 't-1', attemptId: 'attempt-1', executionVersion: 1,
      operation: 'task.verify.checks', codeDigest: HASH, policyDigest: HASH_B,
      environmentSummary: { runner: 'node' }, checkSnapshot: [CHECK_UNIT],
      selection: { schemaVersion: 1, mode: 'full_fallback', reason: '无候选', selectedCheckKeys: ['unit-tests'] },
    };
    expect(validateVerificationBatchCreateInput(create)).toEqual({ ...create, startedAtUtcMs: null });
    for (const bad of [
      { ...create, extra: 1 },
      { ...create, executionVersion: 1.5 },
      { ...create, codeDigest: HASH.toUpperCase() },
      { ...create, operation: 'op'.repeat(200) },
      { ...create, startedAtUtcMs: -1 },
    ]) expect(() => validateVerificationBatchCreateInput(bad)).toThrow();

    const save = {
      resultId: 'vres-1', projectId: 'proj-1', batchId: 'vbatch-1', checkKey: 'unit-tests',
      status: 'failed', exitCode: 1, signal: null, timedOut: false,
      outputArtifactId: null, outputTail: '1 failed', startedAtUtcMs: NOW, endedAtUtcMs: NOW + 10,
    };
    expect(validateCheckResultSaveInput(save)).toEqual(save);
    for (const bad of [
      { ...save, argv: ['node'] }, // 定义快照来自批次，不允许调用方携带 argv
      { ...save, extra: true },
      { ...save, checkKey: 'BAD' },
      { ...save, status: 'passed', exitCode: 2 },
      { ...save, outputArtifactId: 'output 1' },
    ]) expect(() => validateCheckResultSaveInput(bad)).toThrow();

    const finalize = { projectId: 'proj-1', batchId: 'vbatch-1', expectedRevision: 1, status: 'failed' };
    expect(validateVerificationBatchFinalizeInput(finalize)).toEqual({ ...finalize, endedAtUtcMs: null });
    for (const bad of [
      { ...finalize, status: 'running' },
      { ...finalize, expectedRevision: 0 },
      { ...finalize, extra: 1 },
    ]) expect(() => validateVerificationBatchFinalizeInput(bad)).toThrow();
  });
});

describe('P03-7 F-002 verification store on real SQLite', () => {
  it('creates a batch with full associations and reads it back with unknown metrics null', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      const created = store.createVerificationBatch(f.batchInput({ startedAtUtcMs: null }));
      expect(created.created).toBe(true);
      expect(created.batch).toEqual({
        id: 'vbatch-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1,
        projectId: f.box.projectId, featureId: f.box.featureId, runId: f.ids.runId,
        taskId: f.ids.taskId, attemptId: 'attempt-1', executionVersion: 1,
        operation: 'task.verify.checks', codeDigest: HASH, policyDigest: HASH_B,
        environmentSummary: { runner: 'node', nodeVersion: 'v22.19.0', platform: 'darwin' },
        checkSnapshot: [CHECK_UNIT, CHECK_LINT],
        selection: { schemaVersion: 1, mode: 'full_fallback', reason: '候选缺失，安全回退全量', selectedCheckKeys: ['unit-tests', 'lint'] },
        status: 'running', startedAtUtcMs: null, endedAtUtcMs: null,
      });
      expect(store.getVerificationBatch(f.box.projectId, 'vbatch-1')).toEqual(created.batch);
      expect(store.listAttemptVerificationBatches(f.box.projectId, 'attempt-1')).toEqual([created.batch]);
      expect(store.listCheckResults(f.box.projectId, 'vbatch-1')).toEqual([]);
    } finally { f.box.close(); }
  });

  it('rejects cross-project, missing-attempt and mismatched identity batch creation without partial writes', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      expect(() => store.createVerificationBatch(f.batchInput({ projectId: 'other-project' }))).toThrow(expect.objectContaining({ kind: 'ownership' }));
      expect(() => store.createVerificationBatch(f.batchInput({ attemptId: 'missing-attempt' }))).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => store.createVerificationBatch(f.batchInput({ featureId: 'feature-other' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ runId: 'run-other' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ taskId: 'task-other' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ executionVersion: 2 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.db.prepare('SELECT count(*) AS n FROM verification_batches').get()).toEqual({ n: 0 });
    } finally { f.box.close(); }
  });

  it('saves per-check results derived from the batch snapshot with bounded tail and null unknown metrics', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createVerificationBatch(f.batchInput());
      const saved = store.saveCheckResult(f.resultInput());
      expect(saved.created).toBe(true);
      expect(saved.result).toEqual({
        id: 'vres-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1,
        projectId: f.box.projectId, batchId: 'vbatch-1', checkKey: 'unit-tests',
        argv: ['node', 'scripts/run-tests.ts'], cwdRef: null, environmentRef: null,
        timeoutMs: 600_000, required: true, status: 'passed',
        exitCode: 0, signal: null, timedOut: false,
        outputArtifactId: 'output-1', outputDigest: HASH, outputTail: '12 passed\n0 failed',
        startedAtUtcMs: NOW, endedAtUtcMs: NOW + 1_000,
      });
      // error 结果：未知退出码/信号/输出保持 null；lint 定义来自批次快照（module scope）。
      const errored = store.saveCheckResult(f.resultInput({
        resultId: 'vres-2', checkKey: 'lint', status: 'error', exitCode: null,
        outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: null,
      }));
      expect(errored.result).toMatchObject({
        checkKey: 'lint', argv: ['npm', 'run', 'lint'], cwdRef: 'packages/core',
        environmentRef: 'minimal', timeoutMs: 300_000, required: false,
        status: 'error', exitCode: null, signal: null, outputArtifactId: null, outputDigest: null,
      });
      expect(store.listCheckResults(f.box.projectId, 'vbatch-1')).toEqual([saved.result, errored.result]);
    } finally { f.box.close(); }
  });

  it('rejects results for unknown checks, finalized batches and invalid artifact references', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createVerificationBatch(f.batchInput());
      expect(() => store.saveCheckResult(f.resultInput({ checkKey: 'unknown-check' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.saveCheckResult(f.resultInput({ outputArtifactId: 'missing-artifact' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.saveCheckResult(f.resultInput({ outputArtifactId: 'pending-1' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 跨项目输出制品：同 id 存在于其他项目也不得引用。
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      f.db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
        expected_hash, content_hash, size_bytes, storage_locator) VALUES ('foreign-output', ?, ?, 'other-project', 'verification-output', 'ready', 'text/plain', ?, ?, 10, 'outputs/f.log')`)
        .run(NOW, NOW, HASH, HASH);
      expect(() => store.saveCheckResult(f.resultInput({ outputArtifactId: 'foreign-output' }))).toThrow(expect.objectContaining({ kind: 'ownership' }));
      // 定版后的批次不再接受新结果。
      store.saveCheckResult(f.resultInput());
      store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'passed' });
      expect(() => store.saveCheckResult(f.resultInput({ resultId: 'vres-late', checkKey: 'lint', status: 'error', exitCode: null, outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: null })))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 1 });
    } finally { f.box.close(); }
  });

  it('is idempotent for identical replays and rejects conflicting batch/result content', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      const first = store.createVerificationBatch(f.batchInput());
      const replay = store.createVerificationBatch(f.batchInput());
      expect(replay.created).toBe(false);
      expect(replay.batch).toEqual(first.batch);
      // 冲突内容：同 batchId 不同代码身份/策略/定义快照一律拒绝。
      expect(() => store.createVerificationBatch(f.batchInput({ codeDigest: HASH_C }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ policyDigest: HASH_C }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ checkSnapshot: [CHECK_UNIT],
        selection: { schemaVersion: 1, mode: 'candidates', reason: '候选有效', selectedCheckKeys: ['unit-tests'] } }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createVerificationBatch(f.batchInput({ operation: 'task.verify.other' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.db.prepare('SELECT count(*) AS n FROM verification_batches').get()).toEqual({ n: 1 });

      const saved = store.saveCheckResult(f.resultInput());
      const resultReplay = store.saveCheckResult(f.resultInput());
      expect(resultReplay.created).toBe(false);
      expect(resultReplay.result).toEqual(saved.result);
      expect(() => store.saveCheckResult(f.resultInput({ status: 'failed', exitCode: 1 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.saveCheckResult(f.resultInput({ outputTail: 'different tail' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 同 resultId 不同检查身份同样冲突。
      expect(() => store.saveCheckResult(f.resultInput({ checkKey: 'lint' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 1 });
    } finally { f.box.close(); }
  });

  it('finalizes batches with CAS and fail-closed passed semantics; terminal batches are immutable', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createVerificationBatch(f.batchInput());
      // 零结果不能判 passed（空检查 fail-closed）。
      expect(() => store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'passed' }))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      store.saveCheckResult(f.resultInput({ status: 'failed', exitCode: 1 }));
      // 存在 failed 结果时不能判 passed。
      expect(() => store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'passed' }))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 旧 revision 拒绝。
      expect(() => store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 9, status: 'failed' }))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      const finalized = store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'failed' });
      expect(finalized).toMatchObject({ status: 'failed', revision: 2, endedAtUtcMs: NOW });
      // 重复定版与 running 回退均拒绝。
      expect(() => store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 2, status: 'failed' }))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.getVerificationBatch(f.box.projectId, 'missing-batch')).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => store.getVerificationBatch('other-project', 'vbatch-1')).toThrow(expect.objectContaining({ kind: 'ownership' }));
    } finally { f.box.close(); }
  });

  it('keeps batch, results and receipt atomic in one short transaction', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      const atomic = createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW });
      const receipt = () => createCompletedReceipt({
        commandId: randomUUID(), principalId: 'local-owner', operation: 'project.register',
        scope: { kind: 'registration' }, requestDigest: 'ef'.repeat(32),
        issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
        resultRef: createResultRef(randomBytes(32)), result: { batch: { id: 'vbatch-1' } },
      });
      const countReceipts = () => (f.db.prepare('SELECT count(*) AS n FROM command_receipts').get() as { n: number }).n;
      const receiptsBefore = countReceipts();
      // 失败路径：批次+结果+回执已写后抛错，整组回滚，不留半组权威结果。
      expect(() => atomic.transact('test.verification-rollback', (transaction) => {
        store.createVerificationBatchInTransaction(transaction, f.batchInput());
        store.saveCheckResultInTransaction(transaction, f.resultInput());
        transaction.saveReceipt(receipt());
        throw new Error('forced failure after receipt');
      })).toThrow('forced failure');
      expect(f.db.prepare('SELECT count(*) AS n FROM verification_batches').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 0 });
      expect(countReceipts()).toBe(receiptsBefore);
      // 成功路径：批次+两项结果+定版+回执同一事务原子提交。
      atomic.transact('test.verification-commit', (transaction) => {
        store.createVerificationBatchInTransaction(transaction, f.batchInput());
        store.saveCheckResultInTransaction(transaction, f.resultInput());
        store.saveCheckResultInTransaction(transaction, f.resultInput({
          resultId: 'vres-2', checkKey: 'lint', status: 'error', exitCode: null,
          outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: null,
        }));
        store.finalizeVerificationBatchInTransaction(transaction,
          { projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'failed' });
        transaction.saveReceipt(receipt());
      });
      expect(f.db.prepare('SELECT count(*) AS n FROM verification_batches').get()).toEqual({ n: 1 });
      expect(f.db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 2 });
      expect(countReceipts()).toBe(receiptsBefore + 1);
      expect(store.getVerificationBatch(f.box.projectId, 'vbatch-1')).toMatchObject({ status: 'failed', revision: 2 });
    } finally { f.box.close(); }
  });

  it('reads evidence only when the artifact is ready with matching digest; incomplete evidence is never complete', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createVerificationBatch(f.batchInput());
      store.saveCheckResult(f.resultInput());
      const complete = store.readCheckResultEvidence(f.box.projectId, 'vres-1');
      expect(complete).toEqual({
        status: 'complete', artifactId: 'output-1', contentHash: HASH, sizeBytes: 128,
        locator: 'outputs/output-1.log', version: 1, outputTail: '12 passed\n0 failed',
      });
      // 摘要不匹配：直接篡改制品实测摘要（模拟损坏诊断后的索引状态）。
      f.db.prepare("UPDATE artifacts SET content_hash = ? WHERE id = 'output-1'").run(HASH_C);
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-1'))
        .toEqual({ status: 'incomplete', reason: 'digest_mismatch', artifactId: 'output-1' });
      // pending / failed 索引状态不能作为完整证据。
      f.db.prepare("UPDATE artifacts SET content_hash = ?, status = 'pending' WHERE id = 'output-1'").run(HASH);
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-1'))
        .toEqual({ status: 'incomplete', reason: 'artifact_pending', artifactId: 'output-1' });
      f.db.prepare("UPDATE artifacts SET status = 'failed' WHERE id = 'output-1'").run();
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-1'))
        .toEqual({ status: 'incomplete', reason: 'artifact_failed', artifactId: 'output-1' });
      f.db.prepare("UPDATE artifacts SET status = 'ready' WHERE id = 'output-1'").run();
      // 缺失：绕过外键删除制品行。
      f.db.exec('PRAGMA foreign_keys = OFF');
      f.db.prepare("DELETE FROM artifacts WHERE id = 'output-1'").run();
      f.db.exec('PRAGMA foreign_keys = ON');
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-1'))
        .toEqual({ status: 'incomplete', reason: 'artifact_missing', artifactId: 'output-1' });
      // 无输出制品的结果：证据为 none，而不是伪造 complete。
      store.saveCheckResult(f.resultInput({
        resultId: 'vres-2', checkKey: 'lint', status: 'not_run', exitCode: null,
        outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: null,
      }));
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-2'))
        .toEqual({ status: 'none', outputTail: null });
      expect(() => store.readCheckResultEvidence(f.box.projectId, 'missing-result')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    } finally { f.box.close(); }
  });

  it('preserves historical failed batches and results when a new batch is recorded', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      // 第一批：失败并定版。
      store.createVerificationBatch(f.batchInput());
      store.saveCheckResult(f.resultInput({ status: 'failed', exitCode: 1, outputTail: '1 failed' }));
      store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'failed' });
      const historical = store.getVerificationBatch(f.box.projectId, 'vbatch-1');
      const historicalResults = store.listCheckResults(f.box.projectId, 'vbatch-1');
      // 新批次（同 Attempt 修复后重验）：不覆盖历史失败记录。
      const second = store.createVerificationBatch(f.batchInput({ batchId: 'vbatch-2', codeDigest: HASH_C }));
      expect(second.created).toBe(true);
      store.saveCheckResult(f.resultInput({ resultId: 'vres-3', batchId: 'vbatch-2', outputArtifactId: 'output-2', outputTail: '12 passed' }));
      store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-2', expectedRevision: 1, status: 'passed' });
      expect(store.getVerificationBatch(f.box.projectId, 'vbatch-1')).toEqual(historical);
      expect(store.listCheckResults(f.box.projectId, 'vbatch-1')).toEqual(historicalResults);
      expect(store.listAttemptVerificationBatches(f.box.projectId, 'attempt-1').map((batch) => batch.id))
        .toEqual(['vbatch-1', 'vbatch-2']);
      // 逐项结果不可变：直接 SQL 更新/删除被拒绝。
      expect(() => f.db.prepare("UPDATE check_results SET status = 'passed' WHERE id = 'vres-1'").run()).toThrow(/immutable/);
      expect(() => f.db.prepare("UPDATE verification_batches SET status = 'passed' WHERE id = 'vbatch-1'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE verification_batches SET code_digest = ? WHERE id = 'vbatch-1'").run(HASH_C)).toThrow(/immutable/);
      expect(store.listCheckResults(f.box.projectId, 'vbatch-1')).toEqual(historicalResults);
    } finally { f.box.close(); }
  });

  it('enforces DDL-level integrity for direct SQL writes', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      const snapshotJson = JSON.stringify([CHECK_UNIT]);
      const selectionJson = JSON.stringify({ schemaVersion: 1, mode: 'full_fallback', reason: '无候选', selectedCheckKeys: ['unit-tests'] });
      const insertBatch = (overrides: Record<string, unknown> = {}) => {
        const row = { id: 'vbatch-x', created_at: NOW, updated_at: NOW, project_id: f.box.projectId,
          feature_id: f.box.featureId, run_id: f.ids.runId, task_id: f.ids.taskId,
          attempt_id: 'attempt-1', execution_version: 1, operation: 'task.verify.checks',
          code_digest: HASH, policy_digest: HASH_B, environment_summary: '{"runner":"node"}',
          check_snapshot: snapshotJson, selection: selectionJson, status: 'running',
          started_at: NOW, ended_at: null, ...overrides };
        const keys = Object.keys(row);
        f.db.prepare(`INSERT INTO verification_batches (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...Object.values(row) as (string | number | null)[]);
      };
      // 跨项目/错误 Attempt 关联、过期 executionVersion、非法摘要/状态/JSON 均被 DDL 拒绝。
      expect(() => insertBatch({ project_id: 'other-project' })).toThrow();
      expect(() => insertBatch({ attempt_id: 'missing-attempt' })).toThrow();
      expect(() => insertBatch({ execution_version: 2 })).toThrow();
      expect(() => insertBatch({ feature_id: 'feature-other' })).toThrow();
      expect(() => insertBatch({ code_digest: 'AB'.repeat(32) })).toThrow();
      expect(() => insertBatch({ status: 'done' })).toThrow();
      expect(() => insertBatch({ status: 'passed' })).toThrow(); // 终态必须带 ended_at
      expect(() => insertBatch({ check_snapshot: '[]' })).toThrow();
      expect(() => insertBatch({ check_snapshot: 'broken' })).toThrow();
      expect(() => insertBatch({ environment_summary: '["node"]' })).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM verification_batches').get()).toEqual({ n: 0 });
      insertBatch();
      // 身份列不可变；running 不可回退；ended_at 只写一次。
      expect(() => f.db.prepare("UPDATE verification_batches SET attempt_id = 'attempt-1' WHERE id = 'vbatch-x'").run()).not.toThrow();
      expect(() => f.db.prepare("UPDATE verification_batches SET code_digest = ? WHERE id = 'vbatch-x'").run(HASH_C)).toThrow(/immutable/);
      f.db.prepare("UPDATE verification_batches SET status = 'failed', ended_at = ? WHERE id = 'vbatch-x'").run(NOW + 10);
      expect(() => f.db.prepare("UPDATE verification_batches SET status = 'running', ended_at = NULL WHERE id = 'vbatch-x'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE verification_batches SET status = 'passed' WHERE id = 'vbatch-x'").run()).toThrow();

      const insertResult = (overrides: Record<string, unknown> = {}) => {
        const row = { id: 'vres-x', created_at: NOW, updated_at: NOW, project_id: f.box.projectId,
          batch_id: 'vbatch-x', check_key: 'unit-tests', argv_json: '["node","scripts/run-tests.ts"]',
          cwd_ref: null, environment_ref: null, timeout_ms: 600_000, required: 1, status: 'passed',
          exit_code: 0, signal: null, timed_out: 0, output_artifact_id: 'output-1',
          output_digest: HASH, output_tail: 'ok', started_at: NOW, ended_at: NOW + 5, ...overrides };
        const keys = Object.keys(row);
        f.db.prepare(`INSERT INTO check_results (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...Object.values(row) as (string | number | null)[]);
      };
      // 跨项目批次/输出制品、未 ready 或摘要不匹配的证据引用、非法状态/形状均被 DDL 拒绝。
      expect(() => insertResult({ project_id: 'other-project' })).toThrow();
      expect(() => insertResult({ batch_id: 'missing-batch' })).toThrow();
      expect(() => insertResult({ output_artifact_id: 'pending-1' })).toThrow();
      expect(() => insertResult({ output_digest: HASH_C })).toThrow();
      expect(() => insertResult({ output_artifact_id: null })).toThrow();
      expect(() => insertResult({ status: 'skipped' })).toThrow();
      expect(() => insertResult({ status: 'passed', exit_code: 1 })).toThrow();
      expect(() => insertResult({ argv_json: 'not-json' })).toThrow();
      expect(() => insertResult({ timeout_ms: 0 })).toThrow();
      expect(() => insertResult({ output_tail: 'x'.repeat(8193) })).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({ n: 0 });
      insertResult();
      // 同批次同检查唯一；逐项结果不可变。
      expect(() => insertResult({ id: 'vres-y' })).toThrow(/UNIQUE/);
      expect(() => f.db.prepare("UPDATE check_results SET status = 'failed' WHERE id = 'vres-x'").run()).toThrow(/immutable/);
      expect(() => f.db.prepare("UPDATE check_results SET output_tail = 'edited' WHERE id = 'vres-x'").run()).toThrow(/immutable/);
    } finally { f.box.close(); }
  });

  it('does not change task, run or budget semantics when recording verification results', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const before = {
        task: f.db.prepare('SELECT * FROM tasks WHERE id = ?').get(f.ids.taskId),
        batches: f.db.prepare('SELECT * FROM execution_batches').all(),
        runs: f.db.prepare('SELECT * FROM runs').all(),
        attempt: f.db.prepare('SELECT status, revision, execution_version FROM attempts WHERE id = ?').get('attempt-1'),
      };
      const store = f.store();
      store.createVerificationBatch(f.batchInput());
      store.saveCheckResult(f.resultInput());
      store.finalizeVerificationBatch({ projectId: f.box.projectId, batchId: 'vbatch-1', expectedRevision: 1, status: 'passed' });
      expect(f.db.prepare('SELECT * FROM tasks WHERE id = ?').get(f.ids.taskId)).toEqual(before.task);
      expect(f.db.prepare('SELECT * FROM execution_batches').all()).toEqual(before.batches);
      expect(f.db.prepare('SELECT * FROM runs').all()).toEqual(before.runs);
      expect(f.db.prepare('SELECT status, revision, execution_version FROM attempts WHERE id = ?').get('attempt-1')).toEqual(before.attempt);
    } finally { f.box.close(); }
  });

  it('keeps batch and results consistent across close and reopen', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.store().createVerificationBatch(f.batchInput());
      f.store().saveCheckResult(f.resultInput());
      f.box.reopen();
      const store = createSqliteVerificationStore(f.box.session, { nowUtcMs: () => NOW });
      expect(store.getVerificationBatch(f.box.projectId, 'vbatch-1')).toMatchObject({
        status: 'running', codeDigest: HASH, attemptId: 'attempt-1', operation: 'task.verify.checks',
      });
      expect(store.listCheckResults(f.box.projectId, 'vbatch-1')).toHaveLength(1);
      expect(store.readCheckResultEvidence(f.box.projectId, 'vres-1')).toMatchObject({ status: 'complete', artifactId: 'output-1' });
      const stale = f.store();
      f.box.session.close();
      expect(() => stale.getVerificationBatch(f.box.projectId, 'vbatch-1')).toThrow();
    } finally { f.box.close(); }
  });

  it('fails closed on corrupt persisted JSON without leaking content', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.store().createVerificationBatch(f.batchInput());
      f.store().saveCheckResult(f.resultInput());
      // 直接 SQL 写入损坏行（ignore_check_constraints 跳过 JSON CHECK；合法 Attempt 关联）。
      f.db.exec('PRAGMA ignore_check_constraints = ON');
      f.db.prepare(`INSERT INTO verification_batches (id, created_at, updated_at, project_id, feature_id,
        run_id, task_id, attempt_id, execution_version, operation, code_digest, policy_digest,
        environment_summary, check_snapshot, selection, status, started_at)
        VALUES ('vbatch-corrupt', ?, ?, ?, ?, ?, ?, 'attempt-1', 1, 'task.verify.checks', ?, ?, '{}', ?, ?, 'running', ?)`)
        .run(NOW, NOW, f.box.projectId, f.box.featureId, f.ids.runId, f.ids.taskId, HASH, HASH_B,
          JSON.stringify([CHECK_UNIT]), '{"schemaVersion":1,"secret":"hidden-value"', NOW);
      f.db.exec('PRAGMA ignore_check_constraints = OFF');
      try {
        f.store().getVerificationBatch(f.box.projectId, 'vbatch-corrupt');
        throw new Error('expected corrupt');
      } catch (error) {
        expect(error).toMatchObject({ kind: 'corrupt' });
        expect(String(error)).not.toContain('hidden-value');
      }
      // 既有合法行不受影响。
      expect(f.store().getVerificationBatch(f.box.projectId, 'vbatch-1')).toMatchObject({ status: 'running' });
    } finally { f.box.close(); }
  });

  it.each([0, 5, 20])('upgrades v%s, preserves data and migration evidence, and reruns idempotently', async (version) => {
    const sandbox = createTempSandbox('shiploop-p037-f002-upgrade-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      if (version > 0) {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
        session.database.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('old-project', ?, ?, 'Preserved', 'active', '[]')").run(NOW, NOW);
        session.database.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
          expected_hash, content_hash, size_bytes, storage_locator) VALUES ('old-artifact', ?, ?, 'old-project', 'report', 'ready', 'application/json', ?, ?, 10, 'artifacts/old/v1/report.json')`)
          .run(NOW, NOW, HASH, HASH);
      }
      const before = version > 0 ? session.database.prepare('SELECT * FROM schema_migrations').all() : [];
      const result = await migrateSqliteStorage(session);
      expect(result.toVersion).toBe(25);
      expect(result.appliedVersions).toEqual(version === 0
        ? Array.from({ length: 25 }, (_, i) => i + 1)
        : Array.from({ length: 25 - version }, (_, i) => version + 1 + i));
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= ?').all(version)).toEqual(before);
      if (version > 0) {
        expect(session.database.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'Preserved' });
        expect(session.database.prepare("SELECT status FROM artifacts WHERE id = 'old-artifact'").get()).toEqual({ status: 'ready' });
      }
      const tables = session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
      expect(tables).toContain('verification_batches');
      expect(tables).toContain('check_results');
      expect(tables).not.toContain('check_definitions');
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      expect(session.database.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 25 });
      // 关闭重开后关联结构仍在。
      session.close();
      const reopened = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        expect(reopened.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'check_results'").all()).toHaveLength(1);
        if (version > 0) expect(reopened.database.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'Preserved' });
      } finally { reopened.close(); }
    } finally { session.isOpen() && session.close(); sandbox.cleanup(); }
  });

  it('rolls back a failed v21 DDL and its migration record, then upgrades cleanly', async () => {
    const sandbox = createTempSandbox('shiploop-p037-f002-rollback-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 20) });
      const broken = `${SQLITE_MIGRATIONS[20]!.sql}\nINSERT INTO absent_table VALUES (1);`;
      await expect(migrateSqliteStorage(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 20),
        { version: 21, sql: broken, checksum: createHash('sha256').update(broken).digest('hex') }] }))
        .rejects.toMatchObject({ step: 'apply', version: 21 });
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name = 'check_results'").all()).toEqual([]);
      expect(session.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 20 });
      expect((await migrateSqliteStorage(session, { backupPath: join(sandbox.path, 'retry.db') })).toVersion).toBe(25);
    } finally { session.close(); sandbox.cleanup(); }
  });
});
