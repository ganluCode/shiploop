/**
 * P04-9 / F-001 迁移 v33：Run 级持久派发认领与单执行槽位（真实临时 SQLite）。
 *
 * 覆盖验收点：新库与 P04-8（v32）旧库升级、既有 Run/Attempt/预算/Git/工作区/批准
 * 证据逐行保持身份与内容、旧 queued Run 仍可补扫、旧活动/隔离占用不被迁移改写、
 * Drizzle 与迁移一致（由 sqlite-schema-migrations.test.ts 交叉核对）、同项目/同 Feature
 * 归属、有效认领唯一、版本/状态约束失败样例、迁移失败整组回滚与高版本拒写。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { NOW, openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';

const HASH = 'ab'.repeat(32);
const DIGEST_B = 'cd'.repeat(32);
const BINDING_DIGEST = 'ef'.repeat(32);
const OID = '1234567890abcdef1234567890abcdef12345678';
const TREE = 'fedcba0987654321fedcba0987654321fedcba09';
/** 迁移 v33 之后新增的表：升级前不存在，升级后为空（旧数据不自动认领）。 */
const DISPATCH_TABLES = ['run_dispatch_claims', 'execution_slot_claims', 'run_dispatch_intents'];

function preparedSnapshot(projectId: string, featureId: string, taskId: string) {
  const ref = (artifactId: string) => ({
    artifactId, version: 1, contentHash: HASH, sizeBytes: 10,
    locator: `inputs/${artifactId}`, mediaType: 'application/json',
  });
  return {
    schemaVersion: 1, projectId, featureId, taskId,
    group: { snapshot: ref('snapshot-1'), manifest: ref('manifest-1'), prompt: ref('prompt-1') },
    requiredInputs: [],
    digests: {
      snapshotDigest: HASH, manifestDigest: HASH, promptDigest: HASH,
      strategyCopyDigest: HASH, permissionsDigest: HASH,
    },
    approval: { planDigest: HASH, checkPolicyDigest: HASH, decisionId: null, featureRevision: 1 },
    taskRevision: 1, promptBytes: 10,
    tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' },
    preparedAtUtcMs: NOW,
  };
}

/**
 * 真实 P04-8 数据夹具：预算命令创建 Project/Phase/Feature/Task/Approval/Batch/Run，
 * 再补真实 Attempt、工作区租约（held + quarantined）与 Git operation 意图行。
 */
async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const db = box.session.database;
  const projectId = box.projectId;
  const featureId = box.featureId;
  const snapshot = preparedSnapshot(projectId, featureId, ids.taskId);
  for (const ref of Object.values(snapshot.group)) {
    db.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator)
      VALUES (?, ?, ?, ?, 'execution-input', 'ready', ?, ?, ?, ?, ?)`)
      .run(ref.artifactId, NOW, NOW, projectId, ref.mediaType, HASH, HASH, ref.sizeBytes, ref.locator);
  }
  const binding = db.prepare('SELECT repository_binding_id AS id FROM projects WHERE id = ?')
    .get(projectId) as { id: string };
  // Task commit 要求 Task 与 Attempt 的 executionVersion 一致（真实认领后的身份）。
  db.prepare('UPDATE tasks SET execution_version = 4 WHERE id = ?').run(ids.taskId);
  db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number,
    owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
    VALUES ('attempt-1', ?, ?, ?, ?, ?, ?, 1, 'owner-1', 'host-1', 4, ?, ?, ?, 'snapshot-1')`)
    .run(NOW, NOW, projectId, featureId, ids.runId, ids.taskId, NOW + 60_000,
      JSON.stringify(snapshot), HASH);
  db.prepare(`INSERT INTO workspace_leases (id, created_at, updated_at, project_id, resource_key, resource_kind,
    owner_kind, owner_id, host_instance_id, execution_version, state, lease_until)
    VALUES ('lease-held', ?, ?, ?, 'global:execution', 'global', 'attempt', 'attempt-1', 'host-1', 4, 'held', ?)`)
    .run(NOW, NOW, projectId, NOW + 60_000);
  db.prepare(`INSERT INTO workspace_leases (id, created_at, updated_at, project_id, resource_key, resource_kind,
    owner_kind, owner_id, host_instance_id, execution_version, state, lease_until)
    VALUES ('lease-quarantined', ?, ?, ?, ?, 'project', 'attempt', 'attempt-1', 'host-1', 4, 'quarantined', ?)`)
    .run(NOW, NOW, projectId, `project:${projectId}`, NOW - 1);
  db.prepare(`INSERT INTO git_operations (id, created_at, updated_at, project_id, feature_id, run_id, attempt_id,
    execution_version, operation_type, repository_binding_id, repo_identity, worktree_path, expected_head,
    candidate_tree, code_digest, verification_refs, approval_refs, message, identity_name, identity_email,
    delivery_policy_digest, owner_id, host_instance_id, intent_digest)
    VALUES ('git-op-1', ?, ?, ?, ?, ?, 'attempt-1', 4, 'task_commit', ?, 'repo-identity', '/tmp/worktree',
      ?, ?, ?, '[]', '[]', 'F-001: fixture', 'Test', 'test@example.com', ?, 'owner-1', 'host-1', ?)`)
    .run(NOW, NOW, projectId, featureId, ids.runId, binding.id, OID, TREE, HASH, BINDING_DIGEST, DIGEST_B);

  function insertClaim(overrides: Record<string, unknown> = {}) {
    const row = {
      id: 'claim-1', created_at: NOW, project_id: projectId, updated_at: NOW,
      feature_id: featureId, run_id: ids.runId, claim_version: 1, origin: 'dispatch',
      owner_id: 'owner-1', host_instance_id: 'host-1', acquired_at: NOW, lease_until: NOW + 60_000,
      state: 'held', ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO run_dispatch_claims (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  }
  function insertSlot(overrides: Record<string, unknown> = {}) {
    const row = {
      id: 'slot-1', created_at: NOW, project_id: projectId, updated_at: NOW, slot_index: 0,
      feature_id: featureId, run_id: ids.runId, claim_id: 'claim-1', claim_version: 1,
      owner_id: 'owner-1', host_instance_id: 'host-1', acquired_at: NOW, lease_until: NOW + 60_000,
      state: 'held', ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO execution_slot_claims (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  }
  return { box, db, ids, projectId, featureId, insertClaim, insertSlot };
}

function hashOfChecksums(count: number): string {
  return createHash('sha256')
    .update(SQLITE_MIGRATIONS.slice(0, count).map((migration) => migration.checksum).join('\n'))
    .digest('hex');
}

describe('P04-9 F-001 migration v33 dispatch and slot schema', () => {
  it('[case:migration-appends-v33] v33 只追加派发/槽位结构，历史迁移与校验摘要冻结', () => {
    expect(SQLITE_MIGRATIONS).toHaveLength(34);
    expect(SQLITE_MIGRATIONS[32]?.version).toBe(33);
    // Frozen from the predecessor source, not recomputed from the new descriptors.
    expect(hashOfChecksums(32)).toBe('a221e2a99963b0166285b7ad6ac607a6abf9b7bd3874f2b93c5cfdb29913b3b2');
    const sql = SQLITE_MIGRATIONS[32]?.sql ?? '';
    expect(sql).toContain('CREATE TABLE run_dispatch_claims');
    expect(sql).toContain('CREATE TABLE execution_slot_claims');
    // workKey 表示可跨重试的逻辑工作，绝不是派发队列唯一键/列。
    expect(sql).not.toMatch(/work_key/);
    // 不新建 Task/预算状态机，也不改动既有执行表。
    expect(sql).not.toMatch(/CREATE TABLE (tasks|task_attempt_reservations|runs|attempts)/);
  });

  it('[case:claim-constraints] 有效认领唯一、版本/来源/结算形状与终态 Run 有真实失败样例', async () => {
    const f = await fixture();
    try {
      f.insertClaim();
      expect(f.db.prepare('SELECT count(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 1 });
      // 同 Run 第二个活动认领（held/quarantined）被拒绝。
      expect(() => f.insertClaim({ id: 'claim-2', owner_id: 'owner-2', host_instance_id: 'host-2' })).toThrow();
      // 已释放仍是同一代次身份，不能重复占用版本。
      expect(() => f.insertClaim({ id: 'claim-3', state: 'released', settled_at: NOW + 1 })).toThrow();
      // 版本/来源/结算形状。
      expect(() => f.insertClaim({ id: 'claim-4', claim_version: 0 })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-5', claim_version: 2 })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-6', origin: 'manual' })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-7', state: 'released' })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-8', state: 'quarantined', settled_at: NOW + 1 })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-9', state: 'held', settled_at: NOW + 1 })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-10', resume_from_claim_id: 'claim-1' })).toThrow(/未知|no column/);
      // 同项目/同 Feature 归属：跨项目或换 Feature 的 Run 都拒绝。
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES ('other-project', ?, ?, 'Other')")
        .run(NOW, NOW);
      expect(() => f.insertClaim({ id: 'claim-11', project_id: 'other-project' })).toThrow();
      expect(() => f.insertClaim({ id: 'claim-12', feature_id: 'other-feature' })).toThrow();
      // 终态 Run 不得再产生新认领（不重开已结束工作）。
      f.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(f.ids.runId);
      expect(() => f.insertClaim({ id: 'claim-13' })).toThrow(/scope or run state mismatch/);
      // 既有活动认领不因 Run 终态被迁移/触发器自动释放。
      expect(f.db.prepare("SELECT state FROM run_dispatch_claims WHERE id = 'claim-1'").get()).toEqual({ state: 'held' });
    } finally {
      f.box.close();
    }
  }, 60_000);

  it('[case:slot-constraints] 一槽一持有者、一 Run 一活动槽位，身份与租约必须匹配认领', async () => {
    const f = await fixture();
    try {
      f.insertClaim();
      f.insertSlot();
      expect(f.db.prepare('SELECT count(*) AS n FROM execution_slot_claims').get()).toEqual({ n: 1 });
      // 同一 slot_index 不能被第二个 owner 抢占。
      expect(() => f.insertSlot({ id: 'slot-2', slot_index: 0 })).toThrow();
      // 旧 owner/版本或超出认领租约的槽位认领被拒绝。
      expect(() => f.insertSlot({ id: 'slot-3', slot_index: 1, owner_id: 'owner-2', host_instance_id: 'host-2' })).toThrow();
      expect(() => f.insertSlot({ id: 'slot-4', slot_index: 1, claim_version: 2 })).toThrow();
      expect(() => f.insertSlot({ id: 'slot-5', slot_index: 1, lease_until: NOW + 120_000 })).toThrow();
      expect(() => f.insertSlot({ id: 'slot-6', slot_index: 1, claim_id: 'missing-claim' })).toThrow();
      // 同一 Run 只有一个活动槽位（不按 Task 数量重复分配）。
      expect(() => f.insertSlot({ id: 'slot-7', slot_index: 1 })).toThrow(/UNIQUE|constraint/);
      // 第二个 Run（显式重试身份）可拿其他槽位，但同一槽位仍唯一。
      f.db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(f.ids.runId);
      f.db.prepare(`INSERT INTO runs (id, created_at, updated_at, project_id, batch_id, feature_id, purpose,
        input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal,
        max_attempts_per_run, run_time_limit_ms)
        SELECT 'run-2', created_at, updated_at, project_id, batch_id, feature_id, purpose, input_snapshot,
          config_snapshot, 'queued', scope_digest, work_key, 2, max_attempts_per_run, run_time_limit_ms
        FROM runs WHERE id = ?`).run(f.ids.runId);
      f.insertClaim({ id: 'claim-run-2', run_id: 'run-2', owner_id: 'owner-2', host_instance_id: 'host-2' });
      expect(() =>
        f.insertSlot({ id: 'slot-8', run_id: 'run-2', claim_id: 'claim-run-2', owner_id: 'owner-2', host_instance_id: 'host-2' }),
      ).toThrow(/UNIQUE|constraint/);
      f.insertSlot({
        id: 'slot-9', slot_index: 1, run_id: 'run-2', claim_id: 'claim-run-2',
        owner_id: 'owner-2', host_instance_id: 'host-2',
      });
      expect(f.db.prepare('SELECT count(*) AS n FROM execution_slot_claims').get()).toEqual({ n: 2 });
      // 终态 Run 保留的活动槽位不被自动回收或改写。
      expect(f.db.prepare("SELECT state FROM execution_slot_claims WHERE id = 'slot-1'").get()).toEqual({ state: 'held' });
    } finally {
      f.box.close();
    }
  }, 60_000);

  it('[case:claim-slot-transitions] 旧 owner/version 不能释放当前槽位，恢复只追加受控代次', async () => {
    const f = await fixture();
    try {
      f.insertClaim();
      f.insertSlot();
      // 槽位仍活动时不能把认领标成已释放（停止证据必须先行）。
      expect(() =>
        f.db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?, revision = revision + 1 WHERE id = 'claim-1'")
          .run(NOW + 1),
      ).toThrow(/release requires released slot/);
      // 身份列不可变：旧 owner 不能改写或释放新持有者。
      expect(() => f.db.prepare("UPDATE run_dispatch_claims SET owner_id = 'owner-2' WHERE id = 'claim-1'").run())
        .toThrow(/identity is immutable/);
      expect(() => f.db.prepare("UPDATE execution_slot_claims SET slot_index = 1 WHERE id = 'slot-1'").run())
        .toThrow(/identity is immutable/);
      expect(() => f.db.prepare("UPDATE execution_slot_claims SET state = 'released', released_at = ? WHERE id = 'slot-1'").run(NOW + 1))
        .not.toThrow();
      expect(() => f.db.prepare("UPDATE execution_slot_claims SET state = 'held' WHERE id = 'slot-1'").run())
        .toThrow(/illegal execution slot/);
      // 隔离后不能直接回到 held，必须先核对停止后释放；released 是终态。
      f.db.prepare("UPDATE run_dispatch_claims SET state = 'quarantined', settled_at = ?, reason = 'lease_expired_unverified' WHERE id = 'claim-1'")
        .run(NOW + 2);
      expect(() => f.db.prepare("UPDATE run_dispatch_claims SET state = 'held', settled_at = NULL, reason = NULL WHERE id = 'claim-1'").run())
        .toThrow(/illegal run dispatch claim/);
      f.db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?, reason = NULL WHERE id = 'claim-1'").run(NOW + 3);
      expect(() => f.db.prepare("UPDATE run_dispatch_claims SET state = 'held', settled_at = NULL WHERE id = 'claim-1'").run())
        .toThrow(/illegal run dispatch claim/);
      // 恢复：只追加 v2 resume 代次并引用已释放的上一代。
      f.insertClaim({
        id: 'claim-2', claim_version: 2, origin: 'resume', resumed_from_claim_id: 'claim-1',
        resumed_from_claim_version: 1, acquired_at: NOW + 4, lease_until: NOW + 60_004,
      });
      expect(f.db.prepare("SELECT claim_version, origin FROM run_dispatch_claims WHERE id = 'claim-2'").get())
        .toEqual({ claim_version: 2, origin: 'resume' });
      // 上一代仍 held 时不能直接生成下一代；血缘版本也必须精确。
      expect(() =>
        f.insertClaim({
          id: 'claim-3', claim_version: 3, origin: 'resume', resumed_from_claim_id: 'claim-2',
          resumed_from_claim_version: 2, acquired_at: NOW + 5, lease_until: NOW + 60_005,
        }),
      ).toThrow(/lineage mismatch|not released/);
      expect(() =>
        f.insertClaim({
          id: 'claim-4', claim_version: 3, origin: 'resume', resumed_from_claim_id: 'claim-1',
          resumed_from_claim_version: 1, acquired_at: NOW + 6, lease_until: NOW + 60_006,
        }),
      ).toThrow();
      // 终态 Attempt/既有预算与证据行不被认领转换改写。
      expect(f.db.prepare('SELECT execution_version FROM attempts WHERE id = ?').get('attempt-1')).toEqual({ execution_version: 4 });
    } finally {
      f.box.close();
    }
  }, 60_000);
});

describe('P04-9 F-001 v32 to v33 upgrade on real SQLite', () => {
  it('[case:upgrade-preserves-p04-8-data] 旧库升级保留既有身份/内容，旧 queued Run 可补扫且不自动认领', async () => {
    const f = await fixture();
    const sandbox = createTempSandbox('shiploop-p049-upgrade-');
    const predecessor = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 32) });
      const tableNames = (predecessor.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name",
      ).all() as { name: string }[]).map((row) => row.name)
        .filter((name) => !DISPATCH_TABLES.includes(name));
      predecessor.transactWrite('test.seed-v32', (db) => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        // 既有表存在依赖前序行的 INSERT trigger（如 git_operations 需要 Task/Attempt
        // 执行版本一致）：按可进展顺序重试，单表失败用 SAVEPOINT 回滚后再试。
        const pending = new Set(tableNames);
        const copyTable = (table: string) => {
          for (const original of f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]) {
            const row = { ...original };
            const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
            const writable = new Set(columns.filter((column) => column.hidden === 0).map((column) => column.name));
            for (const key of Object.keys(row)) if (!writable.has(key)) delete row[key];
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
              .run(...Object.values(row));
          }
        };
        while (pending.size > 0) {
          let progressed = false;
          for (const table of [...pending]) {
            db.exec('SAVEPOINT copy_table');
            try {
              copyTable(table);
              db.exec('RELEASE copy_table');
              pending.delete(table);
              progressed = true;
            } catch {
              db.exec('ROLLBACK TO copy_table');
              db.exec('RELEASE copy_table');
            }
          }
          if (!progressed) throw new Error(`unable to copy fixture tables: ${[...pending].join(',')}`);
        }
      });
      const before = Object.fromEntries(
        tableNames.map((table) => [table, predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
      );
      const migration = await migrateSqliteStorage(predecessor);
      expect(migration.appliedVersions).toEqual([33, 34]);
      for (const table of tableNames) {
        // v33 不改变任何既有列：升级前后逐表逐行必须完全一致。
        expect(predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), table)
          .toEqual(before[table]);
      }
      // 旧 queued Run 保持事实且没有被迁移偷偷认领，可由后续有界补扫发现。
      expect(predecessor.database.prepare('SELECT status FROM runs WHERE id = ?').get(f.ids.runId))
        .toEqual({ status: 'queued' });
      expect(predecessor.database.prepare('SELECT count(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 0 });
      expect(predecessor.database.prepare('SELECT count(*) AS n FROM execution_slot_claims').get()).toEqual({ n: 0 });
      const sweep = predecessor.database.prepare(`SELECT r.id AS id FROM runs r
        WHERE r.status = 'queued' AND NOT EXISTS (
          SELECT 1 FROM run_dispatch_claims c
          WHERE c.project_id = r.project_id AND c.run_id = r.id AND c.state IN ('held', 'quarantined')
        ) ORDER BY r.project_id, r.id LIMIT 16`).all() as { id: string }[];
      expect(sweep.map((row) => row.id)).toContain(f.ids.runId);
      // 旧活动/隔离占用保持原状态与租约，不被迁移当作已停止、清空或自动恢复。
      const leases = predecessor.database.prepare('SELECT id, state, lease_until FROM workspace_leases ORDER BY id').all();
      expect(leases).toEqual([
        { id: 'lease-held', state: 'held', lease_until: NOW + 60_000 },
        { id: 'lease-quarantined', state: 'quarantined', lease_until: NOW - 1 },
      ]);
      expect(predecessor.database.prepare('SELECT owner_id, execution_version FROM attempts').get())
        .toEqual({ owner_id: 'owner-1', execution_version: 4 });
      expect(predecessor.database.prepare('SELECT status, attempt_id FROM git_operations').get())
        .toEqual({ status: 'pending', attempt_id: 'attempt-1' });
      expect(predecessor.database.prepare('SELECT count(*) AS n FROM approvals WHERE status = ?').get('approved'))
        .toEqual({ n: 1 });
      expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // 关闭重开后迁移幂等，旧数据逐行不变。
      predecessor.close();
      const reopened = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        expect((await migrateSqliteStorage(reopened)).appliedVersions).toEqual([]);
        expect(reopened.database.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(before['runs']);
        expect(reopened.database.prepare('SELECT count(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      predecessor.isOpen() && predecessor.close();
      sandbox.cleanup();
      f.box.close();
    }
  }, 120_000);

  it('[case:migration-rollback-and-version-guard] 迁移失败整组回滚，高版本拒绝写入', async () => {
    const sandbox = createTempSandbox('shiploop-p049-rollback-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 32) });
      const brokenSql = `${SQLITE_MIGRATIONS[32]!.sql}\nCREATE TABLE broken_v33 (id INTEGER);\nINSERT INTO absent_table VALUES (1);`;
      await expect(migrateSqliteStorage(session, {
        migrations: [
          ...SQLITE_MIGRATIONS.slice(0, 32),
          { version: 33, sql: brokenSql, checksum: createHash('sha256').update(brokenSql).digest('hex') },
        ],
      })).rejects.toMatchObject({ step: 'apply', version: 33 });
      const tables = (session.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as { name: string }[]).map((row) => row.name);
      expect(tables).not.toContain('run_dispatch_claims');
      expect(tables).not.toContain('execution_slot_claims');
      expect(tables).not.toContain('broken_v33');
      expect(session.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 32 });
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([33, 34]);
      // 高版本库拒写，且不产生任何 DDL/DML 变更。
      session.database.prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, 35, ?, ?)')
        .run('migration-v35', NOW, HASH, NOW);
      await expect(migrateSqliteStorage(session)).rejects.toMatchObject({ kind: 'unsupported_version' });
      expect(session.database.prepare('SELECT count(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 0 });
      expect(session.database.prepare('SELECT count(*) AS n FROM run_dispatch_intents').get()).toEqual({ n: 0 });
    } finally {
      session.close();
      sandbox.cleanup();
    }
  }, 60_000);
});
