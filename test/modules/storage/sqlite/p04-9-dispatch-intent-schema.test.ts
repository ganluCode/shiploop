/**
 * P04-9 / F-002 迁移 v34：Run 持久入队意图（真实临时 SQLite）。
 *
 * 覆盖：v33→v34 只追加表且既有 Run/预算/回执/事件逐行保持；旧库升级不自动入队
 * （旧 Run 仍保持 queued 事实），入队意图的同项目/同 Feature 归属、一 Run 一意图、
 * 来源/摘要/原因形状、Run 状态门禁、身份不可变与真实失败样例；Drizzle 与迁移
 * 的逐列/索引/外键对齐由 sqlite-schema-migrations.test.ts 交叉核对。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import {
  computeRunDispatchAuthorizationDigest,
  RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT,
} from '../../../../packages/core/src/ports/execution-dispatch.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { NOW, openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';

const HASH = 'ab'.repeat(32);
/** v33 之前的迁移摘要摘要（由前序 Task 冻结，不因新增 v34 重算）。 */
const FROZEN_V33_CHECKSUM_HASH = 'dbfbfb6ce2032e58eb02f22ae03e277939c71bfda4741d186d2e9b4344bf8b94';

function hashOfChecksums(migrations: readonly { checksum: string }[]): string {
  return createHash('sha256').update(migrations.map((migration) => migration.checksum).join('\n')).digest('hex');
}

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const db = box.session.database;
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(ids.runId) as Record<string, unknown>;
  const digest = computeRunDispatchAuthorizationDigest({
    projectId: String(run.project_id),
    featureId: String(run.feature_id),
    batchId: String(run.batch_id),
    runId: String(run.id),
    purpose: String(run.purpose),
    scopeDigest: String(run.scope_digest),
    workKey: String(run.work_key),
    dispatchOrdinal: Number(run.dispatch_ordinal),
  });

  /** 同一 Batch 里第二个 queued Run（显式重试身份）：先让首个 Run 终态。 */
  function seedRetryRun(runId = 'run-retry-1', status = 'queued'): void {
    // 同 Feature 只允许一个活动 Run：先让既有 queued Run 终态，再插入重试身份。
    db.prepare("UPDATE runs SET status = 'failed' WHERE project_id = ? AND status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted')").run(box.projectId);
    const columns = db.prepare('PRAGMA table_xinfo(runs)').all() as { name: string; hidden: number }[];
    const writable = new Set(columns.filter((column) => column.hidden === 0).map((column) => column.name));
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(run)) if (writable.has(key)) copy[key] = run[key];
    const maxOrdinal = (db.prepare('SELECT MAX(dispatch_ordinal) AS m FROM runs WHERE batch_id = ?')
      .get(ids.batchId) as { m: number }).m;
    const next = {
      ...copy,
      id: runId,
      status,
      dispatch_ordinal: maxOrdinal + 1,
      revision: 1,
    };
    const keys = Object.keys(next);
    db.prepare(`INSERT INTO runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...(Object.values(next) as (string | number | null)[]));
  }

  function insertIntent(overrides: Record<string, unknown> = {}, runId = 'run-retry-1'): void {
    const row = {
      id: randomUUID(),
      created_at: NOW,
      project_id: box.projectId,
      updated_at: NOW,
      feature_id: box.featureId,
      batch_id: ids.batchId,
      run_id: runId,
      source: 'retry',
      authorization_digest: digest,
      enqueued_at: NOW,
      reason: null,
      ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO run_dispatch_intents (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  }

  return { box, db, ids, run, digest, seedRetryRun, insertIntent };
}

describe('P04-9 F-002 migration v34 dispatch intents', () => {
  it('[case:migration-appends-v34] v34 只追加入队意图结构，历史迁移与校验摘要冻结', () => {
    expect(SQLITE_MIGRATIONS).toHaveLength(35);
    expect(SQLITE_MIGRATIONS[34]?.version).toBe(35);
    expect(SQLITE_MIGRATIONS[33]?.version).toBe(34);
    expect(hashOfChecksums(SQLITE_MIGRATIONS.slice(0, 33))).toBe(FROZEN_V33_CHECKSUM_HASH);
    const sql = SQLITE_MIGRATIONS[33]?.sql ?? '';
    expect(sql).toContain('CREATE TABLE run_dispatch_intents');
    expect(sql).toContain('run_dispatch_intents_run_unique');
    // workKey 是跨重试的逻辑工作，不是队列唯一键/列。
    expect(sql).not.toMatch(/work_key/);
    // 不新建 Task/预算状态机，也不改动既有执行表。
    expect(sql).not.toMatch(/CREATE TABLE (tasks|task_attempt_reservations|runs|attempts|batch_budget_revisions)/);
  });

  it('[case:intent-constraints] 一 Run 一意图、来源/摘要/原因形状与归属/状态门禁有真实失败样例', async () => {
    const f = await fixture();
    try {
      f.seedRetryRun();
      // 来源/摘要/原因是受控枚举/形状。
      expect(() => f.insertIntent({ run_id: 'missing-run' })).toThrow();
      expect(() => f.insertIntent({ source: 'manual' })).toThrow();
      expect(() => f.insertIntent({ authorization_digest: 'AB'.repeat(32) })).toThrow();
      expect(() => f.insertIntent({ authorization_digest: 'ab' })).toThrow();
      expect(() => f.insertIntent({ reason: '' })).toThrow();
      expect(() => f.insertIntent({ reason: 'x'.repeat(513) })).toThrow();
      expect(() => f.insertIntent({ enqueued_at: 0 })).toThrow();
      // 首个 Run 已有启动意图（来自真实命令路径）；同一 Run 只能有一个意图。
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_intents').get()).toEqual({ n: 1 });
      f.insertIntent();
      expect(() => f.insertIntent()).toThrow(/UNIQUE|constraint/);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_intents').get()).toEqual({ n: 2 });
      // 同项目/同 Feature/同 Batch 归属：跨项目、换 Feature、换 Batch 都拒绝。
      f.db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES ('other-project', ?, ?, 'Other')")
        .run(NOW, NOW);
      expect(() => f.insertIntent({ project_id: 'other-project' })).toThrow();
      expect(() => f.insertIntent({ feature_id: 'other-feature' })).toThrow();
      expect(() => f.insertIntent({ batch_id: 'other-batch' })).toThrow(/scope or state mismatch/);
      // Run 状态门禁：终态/控制中/运行中的 Run 不接受新的入队意图。
      f.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = 'run-retry-1'").run();
      expect(() => f.insertIntent({ id: 'intent-terminal' })).toThrow(/scope or state mismatch/);
      f.db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = 'run-retry-1'").run();
      expect(() => f.insertIntent({ id: 'intent-cancelled' })).toThrow(/scope or state mismatch/);
      f.db.prepare("UPDATE runs SET status = 'paused' WHERE id = 'run-retry-1'").run();
      expect(() => f.insertIntent({ id: 'intent-paused' })).toThrow(/scope or state mismatch/);
      // 项目非 active 同样拒绝。
      f.seedRetryRun('run-retry-2');
      f.db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(f.box.projectId);
      expect(() => f.insertIntent({ id: 'intent-project-archived' }, 'run-retry-2'))
        .toThrow(/scope or state mismatch/);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_intents').get()).toEqual({ n: 2 });
      // 身份列不可变：来源/摘要/入队时间/原因不能被事后改写。
      expect(() =>
        f.db.prepare("UPDATE run_dispatch_intents SET source = 'resume' WHERE run_id = 'run-retry-1'").run(),
      ).toThrow(/identity is immutable/);
      expect(() =>
        f.db.prepare("UPDATE run_dispatch_intents SET authorization_digest = ? WHERE run_id = 'run-retry-1'")
          .run('cd'.repeat(32)),
      ).toThrow(/identity is immutable/);
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      f.box.close();
    }
  }, 120_000);

  it('[case:bounded-scan] 补扫只返回 queued Run 的意图并有界', async () => {
    const f = await fixture();
    try {
      const scan = f.box.atomic.transact('p04-9-scan', (transaction) =>
        transaction.listRunDispatchIntents({ projectId: f.box.projectId, limit: 10 }));
      expect(scan).toHaveLength(1);
      expect(scan[0]).toMatchObject({ runId: f.ids.runId, runStatus: 'queued', activeClaimId: null });
      // 控制中的 Run 不是补扫候选（补扫不自动恢复暂停/取消现场）。
      f.db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(f.ids.runId);
      expect(f.box.atomic.transact('p04-9-scan', (transaction) =>
        transaction.listRunDispatchIntents({ projectId: f.box.projectId, limit: 10 }))).toEqual([]);
      expect(() => f.box.atomic.transact('p04-9-scan', (transaction) =>
        transaction.listRunDispatchIntents({ projectId: f.box.projectId, limit: RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT + 1 })))
        .toThrow();
    } finally {
      f.box.close();
    }
  }, 120_000);
});

describe('P04-9 F-002 v33 to v34 upgrade on real SQLite', () => {
  it('[case:upgrade-preserves-v33-data] 旧库升级保留既有内容且不自动入队旧 queued Run', async () => {
    const f = await fixture();
    const sandbox = createTempSandbox('shiploop-p049-f002-upgrade-');
    const predecessor = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 33) });
      const tableNames = (predecessor.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name",
      ).all() as { name: string }[]).map((row) => row.name);
      expect(tableNames).not.toContain('run_dispatch_intents');
      predecessor.transactWrite('test.seed-v33', (db) => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        // 依赖前序行的触发器（如验证/Git 身份一致）按可进展顺序重试，单表失败回滚重试。
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
      expect(migration.appliedVersions).toEqual([34, 35]);
      for (const table of tableNames) {
        // v34 不改变任何既有列：升级前后逐表逐行完全一致。
        expect(predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), table)
          .toEqual(before[table]);
      }
      // 旧 queued Run 保持原有事实，但迁移不替它伪造入队意图。
      expect(predecessor.database.prepare('SELECT status FROM runs WHERE id = ?').get(f.ids.runId))
        .toEqual({ status: 'queued' });
      expect(predecessor.database.prepare('SELECT COUNT(*) AS n FROM run_dispatch_intents').get()).toEqual({ n: 0 });
      expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // 升级后可正常登记意图，且关闭重开后逐行不变。
      const intentId = randomUUID();
      predecessor.transactWrite('test.seed-intent', (db) => {
        db.prepare(`INSERT INTO run_dispatch_intents (id, created_at, project_id, updated_at, feature_id,
          batch_id, run_id, source, authorization_digest, enqueued_at, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'start', ?, ?, NULL)`).run(
          intentId, NOW, f.box.projectId, NOW, f.box.featureId, f.ids.batchId, f.ids.runId, f.digest, NOW,
        );
      });
      predecessor.close();
      const reopened = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        expect((await migrateSqliteStorage(reopened)).appliedVersions).toEqual([]);
        expect(reopened.database.prepare('SELECT id, source FROM run_dispatch_intents').all())
          .toEqual([{ id: intentId, source: 'start' }]);
      } finally {
        reopened.close();
      }
    } finally {
      predecessor.isOpen() && predecessor.close();
      sandbox.cleanup();
      f.box.close();
    }
  }, 180_000);
});
