/**
 * P03-6 / F-006 最小 Work Session 与 Attempt 执行诊断持久关联（真实 SQLite，非 mock）。
 *
 * 覆盖（F-006 验收标准）：
 * - 迁移 v20 从前序实际最新迁移（v19）追加 sessions 表；v1–v19 checksum 冻结不变；
 *   顶层 Work Session 唯一关联同项目 Attempt；可读取实际 runtime、适配版本、输入引用、
 *   executionStage、结果/诊断制品引用与最后活动；不建 ChatTurn/session_messages/
 *   recording_manifests 表组；
 * - 真实 SQLite 拒绝跨项目/错误 Attempt 关联、重复顶层 Session、非法状态/JSON/版本
 *   与旧 owner/version 更新；Session、Attempt 阶段、状态事件及适用回执在短事务原子
 *   一致；未知指标（结果/水位/缺口/原生引用/停止时间）保持 null；
 * - 保存 Runtime 结果（ready Artifact 引用）、停止确认（stopped_at/status）、可见记录
 *   范围（recording_watermark）与缺口（recording_gaps）的最小元数据；区分启动预占
 *   （reserved）/实际已启动（started）/执行已结束（ended）/已停止（stopped）；
 *   正文一律经 ready Artifact 引用，不写大事件或秘密正文；
 * - 空库、P02 v5 与实际前序最新（v19）库升级：原数据保留、重复迁移幂等、历史
 *   checksum 不变、新增迁移故障回滚；关闭重开后关联与状态一致；
 * - Runtime/Fake 无数据库维护能力（源码结构断言）；迁移与映射不改变 Task passed /
 *   Feature completed 或既有预算语义；不引入配置/计划版本表。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage, SqliteMigrationError } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../packages/core/src/adapters/sqlite/work-session-store.ts';
import {
  validateWorkSessionCreateInput,
  validateWorkSessionNativeRef,
  validateWorkSessionProgressInput,
  validateWorkSessionRecord,
  WORK_SESSION_EVENT_TYPE,
} from '../packages/core/src/ports/work-session.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { openBudgetFixture, NOW } from './helpers/p03-3/budget-fixture.ts';

const HASH = 'ab'.repeat(32);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const inputSnapshot = preparedInput(box.projectId, box.featureId);
  const db = box.session.database;
  // Match claimTask's durable Task/Attempt generation when seeding rows directly.
  db.prepare('UPDATE tasks SET execution_version = 1 WHERE id = ?').run(ids.taskId);
  const insertArtifact = (id: string, status: 'ready' | 'pending', locator = `inputs/${id}`) => {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', ?, 'application/json', ?, ?, ?, ?)`)
      .run(id, NOW, NOW, box.projectId, status, HASH, status === 'ready' ? HASH : null, status === 'ready' ? 10 : null, locator);
  };
  for (const ref of Object.values(inputSnapshot.group)) insertArtifact(ref.artifactId, 'ready', ref.locator);
  insertArtifact('result-1', 'ready');
  insertArtifact('pending-1', 'pending');
  function insertAttempt(overrides: Record<string, unknown> = {}) {
    const row = { id: 'attempt-1', created_at: NOW, updated_at: NOW, project_id: box.projectId,
      feature_id: box.featureId, run_id: ids.runId, task_id: ids.taskId, number: 1,
      owner_id: 'owner-1', host_instance_id: 'host-1', execution_version: 1,
      lease_until: NOW + 1000, input_snapshot: JSON.stringify(inputSnapshot), input_digest: HASH,
      input_ref: 'snapshot-1', ...overrides };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO attempts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row) as (string | number | null)[]);
  }
  const store = (clock: () => number = () => NOW) => createSqliteWorkSessionStore(box.session, { nowUtcMs: clock });
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'session-1', projectId: box.projectId, attemptId: 'attempt-1',
    owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
    purpose: 'execution', runtime: 'fake', adapterVersion: '1.0.0', ...overrides });
  const progressInput = (overrides: Record<string, unknown> & { kind: 'started' | 'ended' | 'stopped' | 'activity' }) => ({
    sessionId: 'session-1', projectId: box.projectId, attemptId: 'attempt-1',
    owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1, expectedRevision: 1, ...overrides });
  return { box, db, ids, inputSnapshot, insertAttempt, insertArtifact, store, createInput, progressInput };
}

describe('P03-6 F-006 migration v20 work session schema', () => {
  it('appends v20 without changing the delivered v1-v19 checksums', () => {
    // P03-7 / F-002 起最新迁移为 v21；本用例冻结 v20 交付时的位置与历史摘要。
    expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(21);
    expect(SQLITE_MIGRATIONS).toHaveLength(21);
    // Frozen from the predecessor source, not recomputed from the new descriptors.
    const oldSql = SQLITE_MIGRATIONS.slice(0, 19).map(m => m.checksum).join('\n');
    expect(createHash('sha256').update(oldSql).digest('hex')).toBe('42c01408a11c7dbddecea600bb1cd41f3e4899a3f5dab475262779ef0995bca1');
    const v20 = SQLITE_MIGRATIONS[19]!;
    expect(v20.checksum).toBe(createHash('sha256').update(v20.sql).digest('hex'));
    expect(v20.sql).toContain('CREATE TABLE sessions');
    // 不建 ChatTurn、完整 session_messages 或 SessionRecorder 表组。
    expect(v20.sql).not.toMatch(/CREATE TABLE (chat_turns|session_messages|recording_manifests)/);
  });

  it('creates sessions with lifecycle/status/check indexes and no recorder table group', async () => {
    const f = await fixture();
    try {
      const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => (r as { name: string }).name);
      expect(tables).toContain('sessions');
      expect(tables).not.toContain('chat_turns');
      expect(tables).not.toContain('session_messages');
      expect(tables).not.toContain('recording_manifests');
      const columns = f.db.prepare('PRAGMA table_xinfo(sessions)').all().map(r => (r as { name: string }).name);
      for (const column of ['id', 'created_at', 'updated_at', 'revision', 'project_id', 'attempt_id',
        'parent_session_id', 'kind', 'purpose', 'runtime', 'adapter_version', 'provider_session_id',
        'status', 'execution_stage', 'input_ref', 'result_ref', 'last_activity_at',
        'started_at', 'ended_at', 'stopped_at', 'native_ref', 'recording_watermark', 'recording_gaps']) {
        expect(columns).toContain(column);
      }
      const indexes = f.db.prepare("PRAGMA index_list(sessions)").all().map(r => (r as { name: string }).name);
      expect(indexes).toEqual(expect.arrayContaining(['sessions_project_id_id_unique', 'sessions_attempt_unique', 'sessions_project_kind_activity_index']));
    } finally { f.box.close(); }
  });
});

describe('P03-6 F-006 work session port validators', () => {
  const validRecord = {
    id: 'session-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1, projectId: 'proj-1',
    attemptId: 'attempt-1', parentSessionId: null, kind: 'work', title: null,
    purpose: 'execution', runtime: 'fake', adapterVersion: '1.0.0', providerSessionId: null,
    status: 'reserved', executionStage: 'preflight', inputRef: 'snapshot-1', resultRef: null,
    lastActivityAtUtcMs: NOW, startedAtUtcMs: null, endedAtUtcMs: null, stoppedAtUtcMs: null,
    nativeRef: null, recordingWatermark: null, recordingGaps: null,
  };

  it('accepts a minimal reserved record with unknown metrics null', () => {
    expect(validateWorkSessionRecord(validRecord)).toEqual(validRecord);
  });

  it('rejects unknown keys, bad enums, illegal lifecycle shapes and unknown native versions', () => {
    for (const bad of [
      { ...validRecord, unexpected: true },
      { ...validRecord, kind: 'daemon' },
      { ...validRecord, status: 'active' },
      { ...validRecord, executionStage: 'deploy' },
      { ...validRecord, status: 'reserved', startedAtUtcMs: NOW },
      { ...validRecord, status: 'reserved', resultRef: 'result-1' },
      { ...validRecord, status: 'started', startedAtUtcMs: null },
      { ...validRecord, status: 'ended', startedAtUtcMs: NOW + 5, endedAtUtcMs: NOW },
      { ...validRecord, status: 'stopped', startedAtUtcMs: NOW, endedAtUtcMs: NOW, stoppedAtUtcMs: null },
      { ...validRecord, status: 'stopped', startedAtUtcMs: NOW, endedAtUtcMs: NOW, stoppedAtUtcMs: NOW - 1 },
      { ...validRecord, kind: 'chat', attemptId: 'attempt-1' },
      { ...validRecord, kind: 'work', attemptId: null },
      { ...validRecord, kind: 'work', parentSessionId: 'parent-1' },
      { ...validRecord, nativeRef: { schemaVersion: 2, storageKind: 'sqlite', formatVersion: '1.0' } },
      { ...validRecord, nativeRef: { schemaVersion: 1, storageKind: 'sqlite' } },
      { ...validRecord, nativeRef: { schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.0', path: '/tmp/native.db' } },
      { ...validRecord, recordingWatermark: -1 },
      { ...validRecord, recordingWatermark: 1.5 },
      { ...validRecord, recordingGaps: 'gap' },
      { ...validRecord, recordingGaps: [''] },
      { ...validRecord, recordingGaps: ['ok', 'x'.repeat(300)] },
      { ...validRecord, recordingGaps: Array.from({ length: 33 }, (_, i) => `gap-${i}`) },
      { ...validRecord, runtime: '' },
      { ...validRecord, adapterVersion: '' },
      { ...validRecord, lastActivityAtUtcMs: -1 },
    ]) expect(() => validateWorkSessionRecord(bad)).toThrow();
  });

  it('accepts native references, bounded gaps and lawful chat/ended shapes', () => {
    expect(validateWorkSessionNativeRef({ schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.2.0' }))
      .toEqual({ schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.2.0' });
    for (const bad of [
      { schemaVersion: 1, storageKind: 'sessions/s1/native/state.db', formatVersion: '1.0' },
      { schemaVersion: 1, storageKind: '..\\native', formatVersion: '1.0' },
      { schemaVersion: 1, storageKind: 'sqlite', formatVersion: '/abs/path' },
      { schemaVersion: 1, storageKind: 'sqlite', formatVersion: 'v'.repeat(100) },
      null, 'sqlite', { storageKind: 'sqlite', formatVersion: '1.0' },
    ]) expect(() => validateWorkSessionNativeRef(bad)).toThrow();
    // chat 行不关联 Attempt；执行已结束可无实际启动（启动失败）；缺口/水位已知时可持久化。
    expect(validateWorkSessionRecord({ ...validRecord, kind: 'chat', attemptId: null }).kind).toBe('chat');
    expect(validateWorkSessionRecord({ ...validRecord, status: 'ended', startedAtUtcMs: null, endedAtUtcMs: NOW, resultRef: 'result-1' }).status).toBe('ended');
    expect(validateWorkSessionRecord({ ...validRecord, status: 'stopped', startedAtUtcMs: null, endedAtUtcMs: NOW, stoppedAtUtcMs: NOW,
      resultRef: 'result-1', recordingWatermark: 8, recordingGaps: ['events_gap:4-5'],
      nativeRef: { schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.0' } }).stoppedAtUtcMs).toBe(NOW);
  });

  it('validates create/progress inputs without touching storage', () => {
    const create = { sessionId: 'session-1', projectId: 'proj-1', attemptId: 'attempt-1',
      owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
      purpose: 'execution', runtime: 'fake', adapterVersion: '1.0.0' };
    expect(validateWorkSessionCreateInput(create)).toEqual({ ...create, providerSessionId: null, nativeRef: null });
    for (const bad of [
      { ...create, extra: 1 }, { ...create, executionVersion: 0 }, { ...create, runtime: 'pi', purpose: '' },
      { ...create, providerSessionId: 42 }, { ...create, nativeRef: { schemaVersion: 9 } },
    ]) expect(() => validateWorkSessionCreateInput(bad)).toThrow();

    const base = { sessionId: 'session-1', projectId: 'proj-1', attemptId: 'attempt-1',
      owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1, expectedRevision: 1 };
    expect(validateWorkSessionProgressInput({ ...base, kind: 'started' }).kind).toBe('started');
    expect(validateWorkSessionProgressInput({ ...base, kind: 'ended', resultRef: 'result-1', recordingWatermark: 4, recordingGaps: ['events_gap'] }).kind).toBe('ended');
    expect(validateWorkSessionProgressInput({ ...base, kind: 'stopped', recordingWatermark: 5 }).kind).toBe('stopped');
    expect(validateWorkSessionProgressInput({ ...base, kind: 'activity', executionStage: 'runtime' }).kind).toBe('activity');
    for (const bad of [
      { ...base, kind: 'resumed' },
      { ...base, kind: 'started', resultRef: 'result-1' },
      { ...base, kind: 'stopped', providerSessionId: 'native-1' },
      { ...base, kind: 'activity', resultRef: 'result-1' },
      { ...base, kind: 'ended', resultRef: 'pending 1' },
      { ...base, kind: 'activity', executionStage: 'deploy' },
      { ...base, kind: 'ended', recordingWatermark: -1 },
      { ...base, kind: 'ended', expectedRevision: 0 },
      { ...base, kind: 'ended', recordingGaps: ['has\ncontrol'] },
    ]) expect(() => validateWorkSessionProgressInput(bad)).toThrow();
  });
});

describe('P03-6 F-006 work session store on real SQLite', () => {
  it('creates a reserved top-level session bound to the attempt with event and attempt link in one transaction', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      expect(store.getAttemptWorkSession(f.box.projectId, 'attempt-1')).toBeNull();
      const created = store.createWorkSession(f.createInput());
      expect(created.eventId).not.toBeNull();
      expect(created.session).toEqual({
        id: 'session-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1, projectId: f.box.projectId,
        attemptId: 'attempt-1', parentSessionId: null, kind: 'work', title: null,
        purpose: 'execution', runtime: 'fake', adapterVersion: '1.0.0', providerSessionId: null,
        status: 'reserved', executionStage: 'preflight', inputRef: 'snapshot-1', resultRef: null,
        lastActivityAtUtcMs: NOW, startedAtUtcMs: null, endedAtUtcMs: null, stoppedAtUtcMs: null,
        nativeRef: null, recordingWatermark: null, recordingGaps: null,
      });
      // 同事务写回 Attempt 的 Session 绑定。
      expect(f.db.prepare('SELECT session_id FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ session_id: 'session-1' });
      // 同事务追加脱敏状态事件（聚合为 Session，携带 Attempt/Run/阶段关联）。
      const event = f.db.prepare('SELECT * FROM state_events WHERE id = ?').get(created.eventId!) as Record<string, unknown>;
      expect(event).toMatchObject({ event_type: WORK_SESSION_EVENT_TYPE, aggregate_type: 'session',
        aggregate_id: 'session-1', aggregate_revision: 1, project_id: f.box.projectId,
        attempt_id: 'attempt-1', run_id: f.ids.runId, execution_stage: 'preflight' });
      expect(JSON.parse(String(event.payload))).toEqual({ schemaVersion: 1, status: 'reserved', executionStage: 'preflight' });
      // 读取面：按 ID / 按 Attempt 关联读取同一记录；未绑定前为 null。
      expect(store.getWorkSession(f.box.projectId, 'session-1')).toEqual(created.session);
      expect(store.getAttemptWorkSession(f.box.projectId, 'attempt-1')).toEqual(created.session);
    } finally { f.box.close(); }
  });

  it('rejects cross-project, missing, stale-identity, duplicate and terminal-attempt creation', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      expect(() => store.createWorkSession(f.createInput({ projectId: 'other-project' }))).toThrow(expect.objectContaining({ kind: 'ownership' }));
      expect(() => store.createWorkSession(f.createInput({ attemptId: 'missing-attempt' }))).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => store.createWorkSession(f.createInput({ owner: 'owner-2' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createWorkSession(f.createInput({ hostInstanceId: 'host-2' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.createWorkSession(f.createInput({ executionVersion: 2 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      store.createWorkSession(f.createInput());
      // 重复顶层 Session：同 Attempt 再绑定与同 Session ID 均拒绝。
      expect(() => store.createWorkSession(f.createInput({ sessionId: 'session-2' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      f.insertAttempt({ id: 'attempt-2', number: 2, status: 'failed' });
      expect(() => store.createWorkSession(f.createInput({ sessionId: 'session-3', attemptId: 'attempt-2' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    } finally { f.box.close(); }
  });

  it('drives reserved→started→ended→stopped with atomic attempt stage, events and bounded metadata', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createWorkSession(f.createInput());

      const started = store.applyWorkSessionProgress(f.progressInput({ kind: 'started',
        providerSessionId: 'native-session-1', nativeRef: { schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.0' },
        executionStage: 'runtime' }));
      expect(started.session.status).toBe('started');
      expect(started.session).toMatchObject({ startedAtUtcMs: NOW, providerSessionId: 'native-session-1',
        nativeRef: { schemaVersion: 1, storageKind: 'sqlite', formatVersion: '1.0' }, executionStage: 'runtime', revision: 2 });
      // Attempt 阶段在同一事务内一致推进。
      expect(f.db.prepare('SELECT execution_stage FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ execution_stage: 'runtime' });

      // 记录进度：水位与缺口元数据推进，activity 不写状态事件。
      const eventCount = () => (f.db.prepare('SELECT count(*) AS n FROM state_events').get() as { n: number }).n;
      const beforeActivity = eventCount();
      const activity = store.applyWorkSessionProgress(f.progressInput({ kind: 'activity', expectedRevision: 2, recordingWatermark: 3, recordingGaps: ['events_gap:4-5'] }));
      expect(activity.eventId).toBeNull();
      expect(activity.session).toMatchObject({ status: 'started', recordingWatermark: 3, recordingGaps: ['events_gap:4-5'], revision: 3 });
      expect(eventCount()).toBe(beforeActivity);

      const ended = store.applyWorkSessionProgress(f.progressInput({ kind: 'ended', expectedRevision: 3,
        resultRef: 'result-1', recordingWatermark: 8, executionStage: 'verification' }));
      expect(ended.session).toMatchObject({ status: 'ended', endedAtUtcMs: NOW, resultRef: 'result-1', recordingWatermark: 8, executionStage: 'verification' });
      expect(f.db.prepare('SELECT execution_stage FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ execution_stage: 'verification' });

      const stopped = store.applyWorkSessionProgress(f.progressInput({ kind: 'stopped', expectedRevision: 4, recordingGaps: [] }));
      expect(stopped.session).toMatchObject({ status: 'stopped', stoppedAtUtcMs: NOW, recordingGaps: [], revision: 5 });
      // 每次状态推进都留下脱敏事件；payload 不含正文。
      const events = f.db.prepare("SELECT aggregate_revision, payload FROM state_events WHERE aggregate_type = 'session' ORDER BY sequence").all() as { aggregate_revision: number; payload: string }[];
      expect(events.map(e => e.aggregate_revision)).toEqual([1, 2, 4, 5]);
      expect(events.map(e => JSON.parse(e.payload).status)).toEqual(['reserved', 'started', 'ended', 'stopped']);
    } finally { f.box.close(); }
  });

  it('rejects invalid transitions, stale revisions, stale owner/version and regressed watermarks', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      store.createWorkSession(f.createInput());
      // 非法迁移：stopped 必须先 ended；activity 不改变 reserved 语义但允许；started 不可重复。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'stopped' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 旧 revision / 旧 owner / 旧版本一律拒绝。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', expectedRevision: 9 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', owner: 'owner-old' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', executionVersion: 99 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 错误 Attempt 关联：Session 绑定的 Attempt 与请求不符。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', attemptId: 'attempt-other' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', sessionId: 'missing-session' }))).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', projectId: 'other-project' }))).toThrow(expect.objectContaining({ kind: 'ownership' }));

      store.applyWorkSessionProgress(f.progressInput({ kind: 'started' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'started', expectedRevision: 2 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      store.applyWorkSessionProgress(f.progressInput({ kind: 'activity', expectedRevision: 2, recordingWatermark: 4 }));
      // 水位只前进不后退。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'activity', expectedRevision: 3, recordingWatermark: 2 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      // 未 ready 的制品不能冒充结果正文引用。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'ended', expectedRevision: 3, resultRef: 'pending-1' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'ended', expectedRevision: 3, resultRef: 'missing-artifact' }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      store.applyWorkSessionProgress(f.progressInput({ kind: 'ended', expectedRevision: 3 }));
      store.applyWorkSessionProgress(f.progressInput({ kind: 'stopped', expectedRevision: 4 }));
      // 已停止是 Session 终态：不再接受任何推进。
      expect(() => store.applyWorkSessionProgress(f.progressInput({ kind: 'activity', expectedRevision: 5 }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      const row = f.db.prepare('SELECT status, revision FROM sessions WHERE id = ?').get('session-1');
      expect(row).toEqual({ status: 'stopped', revision: 5 });
    } finally { f.box.close(); }
  });

  it('enforces DDL-level integrity for direct SQL writes', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      const insert = (overrides: Record<string, unknown> = {}) => {
        const row = { id: 'session-x', created_at: NOW, updated_at: NOW, project_id: f.box.projectId,
          attempt_id: 'attempt-1', parent_session_id: null, kind: 'work', title: null,
          purpose: 'execution', runtime: 'fake', adapter_version: '1.0.0', provider_session_id: null,
          status: 'reserved', execution_stage: 'preflight', input_ref: 'snapshot-1', result_ref: null,
          last_activity_at: NOW, started_at: null, ended_at: null, stopped_at: null,
          native_ref: null, recording_watermark: null, recording_gaps: null, ...overrides };
        const keys = Object.keys(row);
        f.db.prepare(`INSERT INTO sessions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...Object.values(row) as (string | number | null)[]);
      };
      // 跨项目 Attempt 关联、错误输入引用（非该 Attempt 的输入）、缺 Attempt 的顶层 Work Session、
      // chat 关联 Attempt、非法状态/阶段/JSON/原生格式版本、非法水位均被 DDL 拒绝。
      expect(() => insert({ project_id: 'other-project' })).toThrow();
      expect(() => insert({ input_ref: 'manifest-1' })).toThrow();
      expect(() => insert({ attempt_id: null })).toThrow();
      expect(() => insert({ kind: 'chat' })).toThrow();
      expect(() => insert({ status: 'active' })).toThrow();
      expect(() => insert({ execution_stage: 'deploy' })).toThrow();
      expect(() => insert({ status: 'started', started_at: null })).toThrow();
      expect(() => insert({ status: 'ended', started_at: NOW, ended_at: NOW - 1 })).toThrow();
      expect(() => insert({ native_ref: '{' })).toThrow();
      expect(() => insert({ native_ref: JSON.stringify({ schemaVersion: 2, storageKind: 'sqlite', formatVersion: '1.0' }) })).toThrow();
      expect(() => insert({ native_ref: JSON.stringify({ schemaVersion: 1, storageKind: '', formatVersion: '1.0' }) })).toThrow();
      expect(() => insert({ recording_watermark: -1 })).toThrow();
      expect(() => insert({ recording_gaps: '{"a":1}' })).toThrow();
      expect(() => insert({ status: 'ended', ended_at: NOW, result_ref: 'pending-1' })).toThrow();
      expect(() => insert({ status: 'ended', ended_at: NOW, result_ref: 'missing-artifact' })).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      // 合法行可插入；重复顶层 Session（同 Attempt）被唯一索引拒绝。
      insert();
      expect(() => insert({ id: 'session-y' })).toThrow();
      // 身份/运行时/输入不可变；已绑定事实只可写一次；水位与最后活动只前进。
      expect(() => f.db.prepare("UPDATE sessions SET runtime = 'pi' WHERE id = 'session-x'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE sessions SET attempt_id = 'attempt-1', input_ref = 'snapshot-1' WHERE id = 'session-x'").run()).not.toThrow();
      expect(() => f.db.prepare("UPDATE sessions SET input_ref = 'manifest-1' WHERE id = 'session-x'").run()).toThrow();
      f.db.prepare("UPDATE sessions SET provider_session_id = 'native-1' WHERE id = 'session-x'").run();
      expect(() => f.db.prepare("UPDATE sessions SET provider_session_id = 'native-2' WHERE id = 'session-x'").run()).toThrow();
      f.db.prepare("UPDATE sessions SET recording_watermark = 5 WHERE id = 'session-x'").run();
      expect(() => f.db.prepare("UPDATE sessions SET recording_watermark = 4 WHERE id = 'session-x'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE sessions SET recording_watermark = NULL WHERE id = 'session-x'").run()).toThrow();
      expect(() => f.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(NOW - 1, 'session-x')).toThrow();
      // 结果引用只能写一次且必须 ready。
      expect(() => f.db.prepare("UPDATE sessions SET result_ref = 'pending-1' WHERE id = 'session-x'").run()).toThrow();
      f.db.prepare("UPDATE sessions SET status = 'ended', started_at = ?, ended_at = ?, result_ref = 'result-1' WHERE id = 'session-x'").run(NOW, NOW);
      expect(() => f.db.prepare("UPDATE sessions SET result_ref = 'snapshot-1' WHERE id = 'session-x'").run()).toThrow();
    } finally { f.box.close(); }
  });

  it('keeps session, attempt stage, state event and applicable receipt atomic in one short transaction', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const store = f.store();
      const atomic = createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW });
      const receipt = () => createCompletedReceipt({
        commandId: randomUUID(), principalId: 'local-owner', operation: 'project.register',
        scope: { kind: 'registration' }, requestDigest: 'ef'.repeat(32),
        issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
        resultRef: createResultRef(randomBytes(32)), result: { session: { id: 'session-1' } },
      });
      const countReceipts = () => (f.db.prepare('SELECT count(*) AS n FROM command_receipts').get() as { n: number }).n;
      const receiptsBefore = countReceipts();
      // 失败路径：回执已写但后续步骤抛错，整组回滚（无 Session、无事件、无回执、Attempt 未绑定）。
      expect(() => atomic.transact('test.session-rollback', (transaction) => {
        store.createWorkSessionInTransaction(transaction, f.createInput());
        transaction.saveReceipt(receipt());
        throw new Error('forced failure after receipt');
      })).toThrow('forced failure');
      expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      expect(f.db.prepare("SELECT count(*) AS n FROM state_events WHERE aggregate_type = 'session'").get()).toEqual({ n: 0 });
      expect(countReceipts()).toBe(receiptsBefore);
      expect(f.db.prepare('SELECT session_id FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ session_id: null });
      // 成功路径：Session 创建与适用回执在同一事务内原子提交。
      atomic.transact('test.session-commit', (transaction) => {
        store.createWorkSessionInTransaction(transaction, f.createInput());
        transaction.saveReceipt(receipt());
      });
      expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
      expect(countReceipts()).toBe(receiptsBefore + 1);
      expect(store.getWorkSession(f.box.projectId, 'session-1').status).toBe('reserved');
    } finally { f.box.close(); }
  });

  it('does not change task, feature or budget semantics when recording session progress', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      const before = {
        task: f.db.prepare('SELECT * FROM tasks WHERE id = ?').get('t-1'),
        batch: f.db.prepare('SELECT * FROM execution_batches').all(),
        runs: f.db.prepare('SELECT * FROM runs').all(),
      };
      const store = f.store();
      store.createWorkSession(f.createInput());
      store.applyWorkSessionProgress(f.progressInput({ kind: 'started', executionStage: 'runtime' }));
      store.applyWorkSessionProgress(f.progressInput({ kind: 'ended', expectedRevision: 2, resultRef: 'result-1' }));
      store.applyWorkSessionProgress(f.progressInput({ kind: 'stopped', expectedRevision: 3 }));
      expect(f.db.prepare('SELECT * FROM tasks WHERE id = ?').get('t-1')).toEqual(before.task);
      expect(f.db.prepare('SELECT * FROM execution_batches').all()).toEqual(before.batch);
      expect(f.db.prepare('SELECT * FROM runs').all()).toEqual(before.runs);
      // Attempt 的业务状态/预算身份不变，仅阶段随执行推进。
      const attempt = f.db.prepare('SELECT status, number, execution_version, owner_id FROM attempts WHERE id = ?').get('attempt-1');
      expect(attempt).toMatchObject({ status: 'preparing', number: 1, execution_version: 1, owner_id: 'owner-1' });
    } finally { f.box.close(); }
  });

  it('keeps association and state consistent across close and reopen', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.store().createWorkSession(f.createInput({ providerSessionId: 'native-1' }));
      f.store().applyWorkSessionProgress(f.progressInput({ kind: 'started' }));
      f.box.reopen();
      const store = createSqliteWorkSessionStore(f.box.session, { nowUtcMs: () => NOW });
      const session = store.getWorkSession(f.box.projectId, 'session-1');
      expect(session).toMatchObject({ status: 'started', startedAtUtcMs: NOW, providerSessionId: 'native-1',
        runtime: 'fake', adapterVersion: '1.0.0', inputRef: 'snapshot-1', attemptId: 'attempt-1' });
      expect(f.box.session.database.prepare('SELECT session_id FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ session_id: 'session-1' });
      // 关闭后的旧 store 拒绝继续读写。
      const stale = f.store();
      f.box.session.close();
      expect(() => stale.getWorkSession(f.box.projectId, 'session-1')).toThrow();
    } finally { f.box.close(); }
  });

  it('fails closed on corrupt persisted JSON without leaking content', async () => {
    const f = await fixture();
    try {
      f.insertAttempt();
      f.store().createWorkSession(f.createInput());
      f.db.exec('PRAGMA ignore_check_constraints = ON');
      f.db.prepare('UPDATE sessions SET native_ref = ? WHERE id = ?').run('{"schemaVersion":1,"storageKind":"hidden-native-path","formatVersion":"1.0","secret":"hidden-value"}', 'session-1');
      f.db.exec('PRAGMA ignore_check_constraints = OFF');
      try {
        f.store().getWorkSession(f.box.projectId, 'session-1');
        throw new Error('expected corrupt');
      } catch (error) {
        expect(error).toMatchObject({ kind: 'corrupt' });
        expect(String(error)).not.toContain('hidden-value');
      }
    } finally { f.box.close(); }
  });

  it.each([0, 5, 19])('upgrades v%s, preserves data and migration evidence, and reruns idempotently', async (version) => {
    const sandbox = createTempSandbox('shiploop-p036-session-upgrade-');
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
      expect(result.toVersion).toBe(21);
      expect(result.appliedVersions).toEqual(version === 0
        ? Array.from({ length: 21 }, (_, i) => i + 1)
        : Array.from({ length: 21 - version }, (_, i) => version + 1 + i));
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= ?').all(version)).toEqual(before);
      if (version > 0) {
        expect(session.database.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'Preserved' });
        expect(session.database.prepare("SELECT status FROM artifacts WHERE id = 'old-artifact'").get()).toEqual({ status: 'ready' });
      }
      const tables = session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => (r as { name: string }).name);
      expect(tables).toContain('sessions');
      expect(tables).not.toContain('session_messages');
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      expect(session.database.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 21 });
      // 关闭重开后关联结构仍在。
      session.close();
      const reopened = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        expect(reopened.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all()).toHaveLength(1);
        if (version > 0) expect(reopened.database.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'Preserved' });
      } finally { reopened.close(); }
    } finally { session.isOpen() && session.close(); sandbox.cleanup(); }
  });

  it('rolls back a failed v20 DDL and its migration record, then upgrades cleanly', async () => {
    const sandbox = createTempSandbox('shiploop-p036-session-rollback-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 19) });
      const broken = `${SQLITE_MIGRATIONS[19]!.sql}\nINSERT INTO absent_table VALUES (1);`;
      await expect(migrateSqliteStorage(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 19),
        { version: 20, sql: broken, checksum: createHash('sha256').update(broken).digest('hex') }] }))
        .rejects.toMatchObject({ step: 'apply', version: 20 });
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").all()).toEqual([]);
      expect(session.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 19 });
      expect((await migrateSqliteStorage(session, { backupPath: join(sandbox.path, 'retry.db') })).toVersion).toBe(21);
    } finally { session.close(); sandbox.cleanup(); }
  });

  it('keeps Runtime adapters and ports free of database maintenance capability', () => {
    for (const file of ['packages/core/src/adapters/fake-runtime.ts', 'packages/core/src/ports/runtime-execution.ts',
      'packages/core/src/ports/runtime-registry.ts', 'packages/core/src/ports/fake-runtime-script.ts']) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(source, file).not.toMatch(/better-sqlite3|drizzle|adapters\/sqlite|migrateSqliteStorage|work-session-store/);
    }
  });
});
