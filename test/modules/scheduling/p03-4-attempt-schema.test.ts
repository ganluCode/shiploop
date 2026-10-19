import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { validateAttemptInputSnapshot, validateAttemptRecord, validateWorkspaceLeaseRecord } from '../../../packages/core/src/ports/attempt-store.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';

const HASH = 'ab'.repeat(32);
function prepared(projectId: string, featureId: string, taskId = 't-1') {
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
  const inputSnapshot = prepared(box.projectId, box.featureId);
  const db = box.session.database;
  for (const ref of Object.values(inputSnapshot.group)) {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, ?, ?, 'execution-input', 'ready', ?, ?, ?, ?, ?)`)
      .run(ref.artifactId, NOW, NOW, box.projectId, ref.mediaType, HASH, HASH, ref.sizeBytes, ref.locator);
  }
  function insert(overrides: Record<string, unknown> = {}) {
    const row = { id: 'attempt-1', created_at: NOW, updated_at: NOW, project_id: box.projectId,
      feature_id: box.featureId, run_id: ids.runId, task_id: ids.taskId, number: 1,
      owner_id: 'owner-1', host_instance_id: 'host-1', execution_version: 1,
      lease_until: NOW + 1000, input_snapshot: JSON.stringify(inputSnapshot), input_digest: HASH,
      input_ref: 'snapshot-1', ...overrides };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO attempts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row) as (string | number | null)[]);
  }
  function lease(overrides: Record<string, unknown> = {}) {
    const row = { id: 'lease-1', created_at: NOW, updated_at: NOW, project_id: box.projectId,
      resource_key: 'global:execution', resource_kind: 'global', owner_kind: 'attempt',
      owner_id: 'attempt-1', host_instance_id: 'host-1', execution_version: 1,
      lease_until: NOW + 1000, ...overrides };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO workspace_leases (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row) as (string | number | null)[]);
  }
  return { box, db, ids, inputSnapshot, insert, lease };
}

describe('P03-4 F-001 persistent execution model', () => {
  it('appends v14 without changing the delivered v1-v13 checksums', () => {
    expect(SQLITE_MIGRATIONS[13]?.version).toBe(14);
    // Frozen from the predecessor source, not recomputed from the new descriptors.
    const oldSql = SQLITE_MIGRATIONS.slice(0, 13).map(m => m.checksum).join('\n');
    expect(createHash('sha256').update(oldSql).digest('hex')).toBe('5b24e6221a7b22e44f52b645b58fe439597855c3bb69b4568b672ac2e5ef9e00');
  });

  it('keeps unknown results null and persists held/quarantined across reopen', async () => {
    const f = await fixture();
    try {
      f.insert(); f.lease();
      expect(f.db.prepare('SELECT status, execution_stage, duration_ms, exit_code, usage_summary FROM attempts').get())
        .toEqual({ status: 'preparing', execution_stage: 'preflight', duration_ms: null, exit_code: null, usage_summary: null });
      f.db.prepare("UPDATE workspace_leases SET state = 'quarantined', lease_until = ?").run(NOW - 1);
      f.box.reopen();
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').get()).toEqual({ state: 'quarantined' });
      expect(f.box.session.database.prepare('SELECT number FROM attempts').get()).toEqual({ number: 1 });
    } finally { f.box.close(); }
  });

  it('rejects duplicate active attempts, task numbers and resource keys even after lease expiry', async () => {
    const f = await fixture();
    try {
      f.insert({ lease_until: NOW - 1 }); f.lease({ lease_until: NOW - 1, state: 'quarantined' });
      expect(() => f.insert({ id: 'attempt-2', number: 2 })).toThrow();
      for (const status of ['executing', 'verifying']) {
        f.db.prepare('UPDATE attempts SET status = ? WHERE id = ?').run(status, 'attempt-1');
        expect(() => f.insert({ id: 'attempt-2', number: 2 })).toThrow();
      }
      f.db.prepare("UPDATE attempts SET status = 'interrupted'").run();
      expect(() => f.insert({ id: 'attempt-2' })).toThrow();
      f.insert({ id: 'attempt-2', number: 2 });
      expect(() => f.lease({ id: 'lease-2', owner_id: 'attempt-2' })).toThrow();
    } finally { f.box.close(); }
  });

  it('rejects cross-project/feature references, bad states, negative counters and malformed snapshots', async () => {
    const f = await fixture();
    try {
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      for (const bad of [{ project_id: 'other-project' }, { feature_id: 'other-feature' },
        { number: 0 }, { number: 1.5 }, { execution_version: -1 }, { status: 'passed' },
        { execution_stage: 'unknown' }, { duration_ms: -1 }, { input_snapshot: '{' },
        { input_snapshot: '{}' }, { input_snapshot: JSON.stringify({ ...f.inputSnapshot, schemaVersion: 9 }) },
        { input_digest: 'bad' }]) expect(() => f.insert(bad)).toThrow();
      f.insert();
      for (const bad of [{ project_id: 'other-project' }, { state: 'released' },
        { execution_version: 0 }, { resource_kind: 'unknown' }]) expect(() => f.lease(bad)).toThrow();
      expect(() => f.db.prepare('UPDATE tasks SET execution_version = -1').run()).toThrow();
      expect(() => f.db.prepare('UPDATE attempts SET input_digest = ?').run('cd'.repeat(32))).toThrow();
      expect(() => f.db.prepare('UPDATE attempts SET input_snapshot = ?').run(JSON.stringify({ ...f.inputSnapshot, promptBytes: 99 }))).toThrow();
    } finally { f.box.close(); }
  });

  it('rejects existing cross-project artifacts and same-project cross-feature Run/Task links', async () => {
    const f = await fixture();
    try {
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('other-project', ?, ?, 'Other', 'active', '[]')").run(NOW, NOW);
      f.db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
        expected_hash, content_hash, size_bytes, storage_locator) VALUES ('foreign-input', ?, ?, 'other-project', 'input', 'ready', 'application/json', ?, ?, 10, 'inputs/foreign-input')`)
        .run(NOW, NOW, HASH, HASH);
      const foreignRef = { ...f.inputSnapshot.group.manifest, artifactId: 'foreign-input', locator: 'inputs/foreign-input' };
      const foreignSnapshot = { ...f.inputSnapshot, group: { ...f.inputSnapshot.group, manifest: foreignRef } };
      expect(() => f.insert({ input_snapshot: JSON.stringify(foreignSnapshot) })).toThrow();
      expect(() => f.insert({ code_ref: 'foreign-input' })).toThrow();
      expect(() => f.insert({ diagnostic_ref: 'foreign-input' })).toThrow();
      f.db.prepare(`INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, status, plan_status)
        VALUES ('other-feature', ?, ?, ?, 'phase-1', 'Other feature', 'draft', 'draft')`).run(NOW, f.box.projectId, NOW);
      f.db.prepare(`INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, status, acceptance, execution_config, config_source)
        VALUES ('other-task', ?, ?, ?, 'other-feature', 'Other task', 'pending', '{"criteria":["test"]}', '{"schemaVersion":2}', 'user_override')`)
        .run(NOW, f.box.projectId, NOW);
      expect(() => f.insert({ task_id: 'other-task', input_snapshot: JSON.stringify({ ...f.inputSnapshot, taskId: 'other-task' }) })).toThrow();
      expect(() => f.insert({ feature_id: 'other-feature', task_id: 'other-task',
        input_snapshot: JSON.stringify({ ...f.inputSnapshot, featureId: 'other-feature', taskId: 'other-task' }) })).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      f.insert();
    } finally { f.box.close(); }
  });

  it('maps every field, preserves independent Core identities and orders task history', async () => {
    const f = await fixture();
    try {
      f.insert({ session_id: 'session-1', invocation_id: 'invoke-1', status: 'failed', execution_stage: 'cleanup',
        started_at: NOW, ended_at: NOW + 30, duration_ms: 30, exit_code: 2, code_ref: 'snapshot-1',
        error_kind: 'runtime-error', diagnostic_ref: 'manifest-1',
        usage_summary: JSON.stringify({ schemaVersion: 1, inputTokens: 20, outputTokens: null, costMicros: null, currency: null }) });
      f.insert({ id: 'attempt-2', number: 2, session_id: 'session-2', invocation_id: 'invoke-2' });
      f.lease({ state: 'quarantined', process_identity: JSON.stringify({ schemaVersion: 1, pid: 123, startedAtUtcMs: NOW, processGroupId: null }) });
      const access = createSqliteAttemptAccess(f.box.session);
      const record = access.getAttempt(f.box.projectId, 'attempt-1');
      expect(record).toEqual({ id: 'attempt-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1,
        projectId: f.box.projectId, featureId: f.box.featureId, runId: f.ids.runId, taskId: 't-1', number: 1,
        owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1, leaseUntilUtcMs: NOW + 1000,
        status: 'failed', executionStage: 'cleanup', inputSnapshot: f.inputSnapshot, inputDigest: HASH, inputRef: 'snapshot-1',
        sessionId: 'session-1', invocationId: 'invoke-1', codeRef: 'snapshot-1', errorKind: 'runtime-error', diagnosticRef: 'manifest-1',
        startedAtUtcMs: NOW, endedAtUtcMs: NOW + 30, durationMs: 30, exitCode: 2,
        usageSummary: { schemaVersion: 1, inputTokens: 20, outputTokens: null, costMicros: null, currency: null } });
      expect(access.listTaskAttempts(f.box.projectId, 't-1').map(a => a.id)).toEqual(['attempt-1', 'attempt-2']);
      expect(access.listWorkspaceLeases(f.box.projectId)).toEqual([{ id: 'lease-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW,
        revision: 1, projectId: f.box.projectId, resourceKey: 'global:execution', resourceKind: 'global', ownerKind: 'attempt',
        owner: 'attempt-1', hostInstanceId: 'host-1', executionVersion: 1, state: 'quarantined', leaseUntilUtcMs: NOW + 1000,
        processIdentity: { schemaVersion: 1, pid: 123, startedAtUtcMs: NOW, processGroupId: null } }]);
      expect(() => f.insert({ id: 'attempt-3', number: 3, status: 'failed', session_id: 'session-1' })).toThrow();
      expect(() => f.insert({ id: 'attempt-3', number: 3, status: 'failed', invocation_id: 'invoke-1' })).toThrow();
      expect(() => f.db.prepare("UPDATE attempts SET session_id = 'replacement' WHERE id = 'attempt-1'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE attempts SET invocation_id = 'replacement' WHERE id = 'attempt-1'").run()).toThrow();
      expect(() => f.db.prepare("UPDATE attempts SET execution_version = 2 WHERE id = 'attempt-1'").run()).toThrow();
      expect(() => validateAttemptRecord({ ...record, requestId: 'same-sdk-request' })).toThrow();
      expect(() => access.getAttempt('other-project', 'attempt-1')).toThrow(expect.objectContaining({ kind: 'ownership' }));
      expect(() => access.listTaskAttempts('other-project', 't-1')).toThrow(expect.objectContaining({ kind: 'ownership' }));
      expect(() => access.getAttempt(f.box.projectId, 'missing')).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => access.getAttempt({}, 'attempt-1')).toThrow(expect.objectContaining({ kind: 'validation' }));
      f.box.session.transactWrite('test.read', () => expect(access.getAttempt(f.box.projectId, 'attempt-1')).toEqual(record));
      f.box.reopen();
      expect(createSqliteAttemptAccess(f.box.session).getAttempt(f.box.projectId, 'attempt-1')).toEqual(record);
      expect(() => access.getAttempt(f.box.projectId, 'attempt-1')).toThrow();
    } finally { f.box.close(); }
  });

  it('rejects secret bodies, unknown versions, unsafe numbers and malformed external inputs without SQL writes', async () => {
    const f = await fixture();
    try {
      f.insert(); f.lease();
      const access = createSqliteAttemptAccess(f.box.session);
      const record = access.getAttempt(f.box.projectId, 'attempt-1');
      const lease = access.listWorkspaceLeases(f.box.projectId)[0]!;
      const before = f.db.prepare('SELECT * FROM attempts').all();
      for (const bad of [null, {}, { ...f.inputSnapshot, schemaVersion: 9 }, { ...f.inputSnapshot, secret: 'hidden-value' },
        { ...f.inputSnapshot, group: { ...f.inputSnapshot.group, snapshot: { ...f.inputSnapshot.group.snapshot, content: 'hidden-value' } } },
        { ...f.inputSnapshot, taskRevision: -1 }, { ...f.inputSnapshot, promptBytes: Number.MAX_SAFE_INTEGER + 1 },
        { ...f.inputSnapshot, group: { ...f.inputSnapshot.group, prompt: { ...f.inputSnapshot.group.prompt, locator: '/private/secret' } } }]) {
        expect(() => validateAttemptInputSnapshot(bad)).toThrow();
      }
      for (const bad of [{ ...record, number: 1.5 }, { ...record, executionVersion: 0 }, { ...record, owner: '' },
        { ...record, startedAtUtcMs: NOW, endedAtUtcMs: NOW - 1 }, { ...record, durationMs: -1 },
        { ...record, usageSummary: { schemaVersion: 2 } },
        { ...record, usageSummary: { schemaVersion: 1, inputTokens: -1, outputTokens: null, costMicros: null, currency: null } }]) {
        expect(() => validateAttemptRecord(bad)).toThrow();
      }
      expect(() => validateWorkspaceLeaseRecord({ ...lease, state: 'released' })).toThrow();
      expect(() => validateWorkspaceLeaseRecord({ ...lease, processIdentity: { secret: 'hidden-value' } })).toThrow();
      expect(f.db.prepare('SELECT * FROM attempts').all()).toEqual(before);
      expect(record.durationMs).toBeNull(); expect(record.exitCode).toBeNull(); expect(record.usageSummary).toBeNull();
    } finally { f.box.close(); }
  });

  it.each(['{', '{"schemaVersion":99}', '{"schemaVersion":1,"secret":"hidden-value"}'])('fails closed when stored usage JSON is corrupt: %s', async payload => {
    const f = await fixture();
    try {
      f.insert();
      f.db.exec('PRAGMA ignore_check_constraints = ON');
      f.db.prepare('UPDATE attempts SET usage_summary = ?').run(payload);
      f.db.exec('PRAGMA ignore_check_constraints = OFF');
      try { createSqliteAttemptAccess(f.box.session).getAttempt(f.box.projectId, 'attempt-1'); throw new Error('expected corrupt'); }
      catch (error) { expect(error).toMatchObject({ kind: 'corrupt' }); expect(String(error)).not.toContain('hidden-value'); }
    } finally { f.box.close(); }
  });

  it('rejects damaged input snapshots and process identity during reads', async () => {
    const f = await fixture();
    try {
      f.insert(); f.lease({ process_identity: '{"schemaVersion":99}' });
      const access = createSqliteAttemptAccess(f.box.session);
      expect(() => access.listWorkspaceLeases(f.box.projectId)).toThrow(expect.objectContaining({ kind: 'corrupt' }));
      f.db.exec('DROP TRIGGER attempts_input_immutable; PRAGMA ignore_check_constraints = ON');
      for (const payload of ['{', JSON.stringify({ ...f.inputSnapshot, schemaVersion: 99 }), JSON.stringify({ ...f.inputSnapshot, secret: 'hidden-value' })]) {
        f.db.prepare('UPDATE attempts SET input_snapshot = ?').run(payload);
        expect(() => access.getAttempt(f.box.projectId, 'attempt-1')).toThrow(expect.objectContaining({ kind: 'corrupt' }));
      }
    } finally { f.box.close(); }
  });

  it.each([0, 5, 13])('upgrades v%s, preserves data and migration evidence, and reruns idempotently', async version => {
    const sandbox = createTempSandbox('shiploop-p034-upgrade-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      if (version > 0) {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
        session.database.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('old-project', ?, ?, 'Preserved', 'active', '[]')").run(NOW, NOW);
      }
      const before = version > 0 ? session.database.prepare('SELECT * FROM schema_migrations').all() : [];
      expect((await migrateSqliteStorage(session)).toVersion).toBe(SQLITE_MIGRATIONS.length);
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= ?').all(version)).toEqual(before);
      if (version > 0) expect(session.database.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'Preserved' });
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      expect(session.database.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: SQLITE_MIGRATIONS.length });
    } finally { session.close(); sandbox.cleanup(); }
  });

  it('preserves the delivered v13 plan, approvals, snapshots and cumulative budget ledger', async () => {
    const f = await fixture();
    const sandbox = createTempSandbox('shiploop-p034-predecessor-');
    const predecessor = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      const budget = createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW });
      f.box.session.transactWrite('test.predecessor-budget', () => {
        budget.reserveTaskAttemptInTransaction({ ...f.ids, attemptKey: 'old-attempt' });
        budget.reserveRuntimeStartInTransaction({ projectId: f.ids.projectId, batchId: f.ids.batchId, runId: f.ids.runId, startKey: 'old-start' });
      });
      await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 13) });
      const tables = ['projects', 'repository_bindings', 'global_settings', 'project_settings', 'phases', 'features', 'tasks',
        'task_dependencies', 'approvals', 'artifacts', 'execution_batches', 'runs', 'task_attempt_reservations',
        'runtime_start_reservations', 'batch_budget_revisions', 'run_outcome_settlements', 'command_receipts', 'state_events'];
      predecessor.transactWrite('test.seed-v13', db => {
        for (const table of tables) {
          for (const original of f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]) {
            const row = { ...original };
            if (table === 'tasks') delete row.execution_version;
            if (table === 'projects') row.repository_binding_id = null;
            const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
            const writable = new Set(columns.filter(column => column.hidden === 0).map(column => column.name));
            for (const key of Object.keys(row)) if (!writable.has(key)) delete row[key];
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
          }
        }
        const binding = f.db.prepare('SELECT repository_binding_id FROM projects WHERE id = ?').get(f.box.projectId) as { repository_binding_id: string };
        db.prepare('UPDATE projects SET repository_binding_id = ? WHERE id = ?').run(binding.repository_binding_id, f.box.projectId);
      });
      const before = Object.fromEntries(tables.map(table => [table, predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
      expect((await migrateSqliteStorage(predecessor)).appliedVersions).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
      for (const table of tables) {
        const after = predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
        if (table === 'features') {
          for (const row of after) {
            expect(row.delivery_status).toBe('not_requested');
            delete row.delivery_status;
          }
        }
        if (table === 'tasks') {
          expect(after[0]?.execution_version).toBe(0);
          expect(after[0]?.kind).toBe('coding');
          expect(after[0]?.manual_block).toBe(0);
          for (const row of after) { delete row.execution_version; delete row.kind; delete row.manual_block; }
        }
        if (table === 'state_events') {
          for (const row of after) {
            for (const column of ['operation_id', 'run_id', 'attempt_id', 'execution_stage']) {
              expect(row[column]).toBeNull();
              delete row[column];
            }
          }
        }
        if (table === 'runs' || table === 'execution_batches') {
          for (const row of after) {
            expect(row.pause_requested_at).toBeNull();
            delete row.pause_requested_at;
          }
        }
        expect(after, table).toEqual(before[table]);
      }
      expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(predecessor.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches').get()).toEqual({ attempts_created: 1, runtime_starts: 1 });
      expect(predecessor.database.prepare('SELECT attempt_counter, code_attempts_used FROM tasks').get()).toEqual({ attempt_counter: 1, code_attempts_used: 1 });
    } finally { predecessor.close(); sandbox.cleanup(); f.box.close(); }
  });

  it('v24 widens the snapshot version gate while preserving populated attempts and child rows', async () => {
    const f = await fixture();
    const sandbox = createTempSandbox('shiploop-p034-v24-');
    const predecessor = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      // 最新库上造出真实 attempt + 子表行（workspace_leases 引用 attempts）。
      f.insert();
      f.lease();
      // 复制全部业务表到 v23 前序库（v23→v24 仅重建 attempts，列完全一致）。
      await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 23) });
      const tableNames = (predecessor.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name",
      ).all() as { name: string }[]).map((row) => row.name);
      predecessor.transactWrite('test.seed-v23', (db) => {
        // 表按名字序复制，父子外键在提交时统一核验（本事务内延迟外键）。
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const table of tableNames) {
          for (const original of f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]) {
            const row = { ...original };
            const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
            const writable = new Set(columns.filter((column) => column.hidden === 0).map((column) => column.name));
            for (const key of Object.keys(row)) if (!writable.has(key)) delete row[key];
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
          }
        }
      });
      const before = Object.fromEntries(
        tableNames.map((table) => [table, predecessor.database.prepare(`SELECT * FROM ${table}`).all()]),
      );
      // v24/v25 重建 attempts：历史行逐行保留，子表外键在提交时核验通过。
      expect((await migrateSqliteStorage(predecessor)).appliedVersions).toEqual([24, 25, 26, 27, 28, 29, 30]);
      for (const table of tableNames) {
        const after = predecessor.database.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        if (table === 'features') {
          for (const row of after) {
            expect(row.delivery_status).toBe('not_requested');
            delete row.delivery_status;
          }
        }
        if (table === 'runs' || table === 'execution_batches') {
          for (const row of after) {
            expect(row.pause_requested_at).toBeNull();
            delete row.pause_requested_at;
          }
        }
        expect(after, table).toEqual(before[table]);
      }
      expect(predecessor.database.prepare('SELECT COUNT(*) AS n FROM git_operations').get()).toEqual({ n: 0 });
      expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // 触发器与索引随重建恢复。
      const triggers = predecessor.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'attempts' ORDER BY name",
      ).all() as { name: string }[];
      expect(triggers.map((row) => row.name)).toEqual(['attempts_group_artifacts_check', 'attempts_input_immutable']);
      // v1 历史快照仍可插入，v2/v3 新快照（F-011/F-001 升版）现在合法，未知 v9 仍被 CHECK 拒绝。
      const v2Snapshot = JSON.stringify({ ...f.inputSnapshot, schemaVersion: 2 });
      predecessor.database.prepare(
        `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref, status) VALUES ('attempt-2', ?, ?, ?, ?, ?, '${f.ids.taskId}', 2, 'owner-1', 'host-1', 1, ?, ?, ?, 'snapshot-1', 'interrupted')`,
      ).run(NOW, NOW, f.box.projectId, f.box.featureId, f.ids.runId, NOW + 1000, v2Snapshot, HASH);
      predecessor.database.prepare(
        `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref, status) VALUES ('attempt-3', ?, ?, ?, ?, ?, '${f.ids.taskId}', 3, 'owner-1', 'host-1', 1, ?, ?, ?, 'snapshot-1', 'interrupted')`,
      ).run(NOW, NOW, f.box.projectId, f.box.featureId, f.ids.runId, NOW + 1000, JSON.stringify({ ...f.inputSnapshot, schemaVersion: 3 }), HASH);
      expect(() =>
        predecessor.database.prepare(
          `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref) VALUES ('attempt-4', ?, ?, ?, ?, ?, '${f.ids.taskId}', 4, 'owner-1', 'host-1', 1, ?, ?, ?, 'snapshot-1')`,
        ).run(NOW, NOW, f.box.projectId, f.box.featureId, f.ids.runId, NOW + 1000, JSON.stringify({ ...f.inputSnapshot, schemaVersion: 9 }), HASH),
      ).toThrow(/attempts_snapshot_check/);
      // 不可变触发器仍阻止改写历史快照。
      expect(() =>
        predecessor.database.prepare('UPDATE attempts SET input_snapshot = ? WHERE id = ?').run(v2Snapshot, 'attempt-1'),
      ).toThrow(/immutable/);
    } finally { predecessor.close(); sandbox.cleanup(); f.box.close(); }
  });

  it('rolls back a failed v14 DDL and its migration record, then upgrades cleanly', async () => {
    const sandbox = createTempSandbox('shiploop-p034-rollback-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 13) });
      const last = SQLITE_MIGRATIONS[13]!;
      const sql = `${last.sql}\nCREATE TABLE broken (id INTEGER); INSERT INTO absent VALUES (1);`;
      await expect(migrateSqliteStorage(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 13),
        { version: 14, sql, checksum: createHash('sha256').update(sql).digest('hex') }] })).rejects.toMatchObject({ step: 'apply', version: 14 });
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('attempts', 'workspace_leases', 'broken')").all()).toEqual([]);
      expect(session.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 13 });
      expect(session.database.prepare('PRAGMA table_info(tasks)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'execution_version' })]));
      expect((await migrateSqliteStorage(session, { backupPath: join(sandbox.path, 'retry.db') })).toVersion).toBe(SQLITE_MIGRATIONS.length);
    } finally { session.close(); sandbox.cleanup(); }
  });
});
