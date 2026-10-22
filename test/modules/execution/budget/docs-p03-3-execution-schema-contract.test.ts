import { currentMigrationVersions } from '../../../helpers/current-schema.ts';
/**
 * P03-3 / F-002 文档核验：`docs/p03-3-execution-schema-contract.md` 记录的执行域
 * Schema 契约必须与仓库实现事实一致（迁移接续、表与约束词汇、条件唯一活动集、
 * 不可变内容承载、相对设计 11 的登记决策与范围边界），避免「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT_DOC_PATH = 'docs/p03-3-execution-schema-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-3 / F-002 执行域 Schema 契约文档', () => {
  it('迁移接续与仓库事实一致：v1..v8 不变、v9 追加单 Feature 执行三表', () => {
    const doc = readContractDoc();
    const versions = SQLITE_MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(currentMigrationVersions);
    const v9 = SQLITE_MIGRATIONS[8]!;
    for (const table of ['execution_batches', 'runs', 'batch_budget_revisions']) {
      expect(v9.sql, `v9 必须建立 ${table}`).toContain(`CREATE TABLE ${table} (`);
      expect(doc, `文档必须记录 ${table}`).toContain(table);
    }
    expect(doc).toContain('v1..v8');
    expect(doc).toContain('v9');
    expect(doc).toContain('packages/core/src/adapters/sqlite/migrations.ts');
    expect(doc).toContain('packages/core/src/adapters/sqlite/schema.ts');
  });

  it('活动集与条件唯一谓词和迁移 DDL 一致：paused/interrupted 不是可绕过的终态', () => {
    const doc = readContractDoc();
    const v9 = SQLITE_MIGRATIONS[8]!;
    expect(doc).toContain('queued/running/pausing/paused/cancelling/interrupted');
    expect(doc).toContain('paused（暂停）与');
    expect(doc).toContain('interrupted（归属待核对）');
    // 文档声称的活动集必须逐字出现在两个条件唯一部分索引谓词中。
    const predicate = "status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted')";
    expect(v9.sql).toContain(`ON execution_batches (phase_id) WHERE ${predicate}`);
    expect(v9.sql).toContain(`ON runs (feature_id) WHERE ${predicate}`);
    expect(v9.sql).toContain('runs_dispatch_identity_unique');
    expect(v9.sql).toContain('batch_budget_revisions_batch_version_unique');
    expect(doc).toContain('UNIQUE(batch_id, work_key, dispatch_ordinal)');
    expect(doc).toContain('UNIQUE(batch_id, version)');
  });

  it('不可变内容承载与登记决策和迁移 DDL 一致', () => {
    const doc = readContractDoc();
    const v9 = SQLITE_MIGRATIONS[8]!;
    for (const trigger of [
      'execution_batches_immutable_columns_update',
      'runs_immutable_columns_update',
      'batch_budget_revisions_immutable_update',
      'batch_budget_revisions_immutable_delete',
    ]) {
      expect(v9.sql, `v9 必须建立触发器 ${trigger}`).toContain(`CREATE TRIGGER ${trigger}`);
      expect(doc).toContain(trigger);
    }
    // 初始与历史快照不可被当前预算更新覆盖（文档语义 = 触发器语义）。
    expect(doc).toContain('初始（version=1）与历史');
    expect(doc).toContain('不可被当前预算更新覆盖');
    // 相对设计 11 的登记决策（请求核对）：phase_id NOT NULL、Run 上限列、单成员范围。
    expect(doc).toContain('请求核对');
    expect(doc).toContain('phase_id');
    expect(doc).toContain('max_attempts_per_run');
    expect(doc).toContain('featureIds');
  });

  it('范围边界：不建完整 Attempt/Session/Worktree/通知表与计划/配置业务版本表', () => {
    const doc = readContractDoc();
    const v9 = SQLITE_MIGRATIONS[8]!;
    expect(doc).toContain('不建计划/配置业务版本表');
    for (const forbidden of [
      'attempts',
      'sessions',
      'workspace_leases',
      'notification_channels',
      'configuration_revisions',
    ]) {
      expect(doc, `文档必须声明不建 ${forbidden}`).toContain(forbidden);
      expect(v9.sql, `v9 不得建立 ${forbidden}`).not.toContain(`CREATE TABLE ${forbidden}`);
    }
    // 守护测试清单与验证记录指向真实文件。
    for (const testFile of [
      'test/modules/execution/budget/p03-3-execution-schema.test.ts',
      'test/modules/storage/sqlite/sqlite-schema-migrations.test.ts',
      'test/modules/storage/sqlite/sqlite-migration-runner.test.ts',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, testFile)), `守护测试缺失：${testFile}`).toBe(true);
      expect(doc).toContain(testFile);
    }
  });
});
