/**
 * P06-6 / F-008：真实迁移后的旧库兼容（P06-6 元数据路径）。
 *
 * 验收面（真实临时 SQLite，非 mock）：
 * - 以真实 v52 旧库（runs 尚无 labels 列）承载从真实命令流产生的完整事实
 *   （项目/Phase/Feature/Task/授权 Batch/Run/活动 Attempt/设置/事件）；
 * - 升级到最新迁移后：历史 Run 统一获得空数组标签，既有行其余字段逐列保留；
 * - 升级后的旧库继续支持 P06-6 全部元数据路径：四层标签窄查询（runs.list
 *   投影与去重计数）、plan.labels.update 的 Run CAS 编辑（只改 labels/revision/
 *   updated_at，Batch 范围与输入快照原值）、task.strategy.reapply.preview 的
 *   就绪候选与快照保护（活动 Attempt / 已授权 Batch 范围照常阻塞）。
 *
 * 不调用模型；不修改历史迁移 SQL 或 checksum；失败不手改 SQLite 放行。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteEntityLabelQueryStore } from '../../../../packages/core/src/adapters/sqlite/entity-label-query-store.ts';
import { createSqliteQueryStore } from '../../../../packages/core/src/adapters/sqlite/query-store.ts';
import { previewTaskStrategyReapplication } from '../../../../packages/core/src/application/task-strategy-preview.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { budgetServices } from '../../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../../helpers/p03-4/task-claim-fixture.ts';

const NOW = 1_900_000_100_000;
const PROJECT_SETTINGS = {
  schemaVersion: 2,
  strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } },
} as const;
const RUN_EXECUTION_COLUMNS = 'status, input_snapshot, config_snapshot, scope_digest, work_key, '
  + 'dispatch_ordinal, attempts_created, reason, started_at, ended_at';
const BATCH_EXECUTION_COLUMNS = 'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, '
  + 'runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at';

describe('P06-6 / F-008 v52 旧库升级后的策略与标签路径兼容', () => {
  it('[case:v52-metadata-upgrade-compat] 历史迁移升级保留执行事实并接通四层标签与策略预览', async () => {
    const fixture = await openClaimFixture([[], []]);
    try {
      // 真实事实：认领 t-1（活动 Attempt）+ 未启动第二 Feature Task + 项目设置。
      const claimed = fixture.store().claimTask(fixture.input(0));
      expect(claimed.replayed).toBe(false);
      const imported = await fixture.box.submit('feature.plan.import', {
        phaseId: 'phase-1',
        plan: {
          schemaVersion: 1,
          feature: { title: 'F-008 compat feature', description: null, labels: [], sourceRefs: [] },
          tasks: [{ id: 'task-fresh-low', title: 'Fresh low', complexity: 'low', acceptance: { criteria: ['compat'] } }],
        },
      }, { scope: fixture.box.scope, expectedRevision: 1 });
      expect(imported.status).toBe('completed');
      const settings = await fixture.box.submit('settings.project.create', PROJECT_SETTINGS, { scope: fixture.box.scope });
      expect(settings.status).toBe('completed');

      const predecessor = openSqliteStorageSession({ path: join(fixture.box.box.root, 'predecessor-v52.db') });
      try {
        await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 52) });
        // v52 旧库 runs 表确实没有 labels 列（真实旧形态）。
        const v52RunColumns = (predecessor.database.prepare('PRAGMA table_info(runs)').all() as { name: string }[])
          .map(column => column.name);
        expect(v52RunColumns).not.toContain('labels');

        // 拷贝真实事实（按 v52 列集；源库多出的 labels 列自然丢弃）。
        const source = fixture.box.session.database;
        const tables = (predecessor.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')")
          .all() as { name: string }[]).map(row => row.name);
        // runs 在 v38 经重建改名，位于 sqlite_master 顺序末尾；而派发认领/意图
        // 的 scope 触发器要求 runs（及其父级）已就位。按依赖顺序前置拷贝。
        // execution_batch_members 由 execution_batches 的 INSERT 触发器从
        // scope_snapshot 自动派生（与源库同一派生规则），显式拷贝会触发唯一冲突。
        const skipTables = new Set(['execution_batch_members']);
        const copyOrder = ['projects', 'phases', 'features', 'tasks', 'execution_batches', 'runs'];
        const orderedTables = [
          ...copyOrder.filter(table => tables.includes(table)),
          ...tables.filter(table => !copyOrder.includes(table) && !skipTables.has(table)),
        ];
        predecessor.transactWrite('test.copy-v52-facts', () => {
          predecessor.database.pragma('defer_foreign_keys = ON');
          for (const table of orderedTables) {
            const columns = (predecessor.database.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[])
              .filter(column => column.hidden === 0).map(column => column.name);
            for (const row of source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Record<string, unknown>[]) {
              predecessor.database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
                .run(...columns.map(column => row[column]));
            }
          }
        });

        // 升级到最新：只应用 v53，历史 Run 统一得到空数组标签。
        const upgrade = await migrateSqliteStorage(predecessor);
        expect(upgrade.appliedVersions).toEqual([53]);
        const runId = fixture.ids.runId;
        const batchId = fixture.ids.batchId;
        const projectId = fixture.box.projectId;
        const runBefore = predecessor.database.prepare(
          `SELECT labels, ${RUN_EXECUTION_COLUMNS} FROM runs WHERE id = ?`,
        ).get(runId) as Record<string, unknown>;
        const batchBefore = predecessor.database.prepare(
          `SELECT ${BATCH_EXECUTION_COLUMNS} FROM execution_batches WHERE id = ?`,
        ).get(batchId) as Record<string, unknown>;
        expect(runBefore.labels).toBe('[]');
        expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        // 触发器派生的 Batch 成员行与源库一致（范围快照同一派生规则）。
        expect(predecessor.database.prepare(
          'SELECT project_id, batch_id, phase_id, feature_id, member_ordinal FROM execution_batch_members ORDER BY id',
        ).all()).toEqual(source.prepare(
          'SELECT project_id, batch_id, phase_id, feature_id, member_ordinal FROM execution_batch_members ORDER BY id',
        ).all());

        // 升级后四层标签窄查询：runs.list 投影与去重计数可用（空标签=无约束）。
        const labelStore = createSqliteEntityLabelQueryStore(predecessor);
        const visibility = { kind: 'all' } as const;
        const runPage = labelStore.listLabelRunRecords(visibility, { entity: 'run', projectId }, { labels: [], match: 'any', afterId: null, limit: 10 });
        expect(runPage.records.map(record => record.id)).toEqual([runId]);
        expect(runPage.records[0]).toMatchObject({ labels: [], status: 'queued', purpose: 'execute' });
        expect(labelStore.countEntityLabels(visibility, { entity: 'run', projectId }, { labels: [], match: 'any' }))
          .toEqual([]);

        // 升级后 Run 标签 CAS 编辑可用：只改 labels/revision/updated_at
        // （认领已将 Run revision 推至 2，以升级后实际 revision 为准）。
        const runRevision = (predecessor.database.prepare(
          'SELECT revision FROM runs WHERE id = ?',
        ).get(runId) as { revision: number }).revision;
        const services = budgetServices(predecessor);
        const owner = createLocalOwnerPrincipal();
        const receipt = await services.commands.submit(owner, {
          schemaVersion: 5,
          commandId: randomUUID(),
          issuedAt: new Date(NOW).toISOString(),
          operation: 'plan.labels.update',
          scope: { kind: 'project', projectId },
          expectedRevision: runRevision,
          payload: { entityType: 'run', id: runId, labels: [' Migrated ', 'migrated'] },
        });
        expect(receipt).toMatchObject({ status: 'completed', operation: 'plan.labels.update' });
        if (receipt.status !== 'completed') throw new Error('升级库上的 Run 标签编辑未完成');
        expect(receipt.result).toMatchObject({ entityType: 'run', id: runId, labels: ['migrated'], revision: runRevision + 1 });
        const runAfter = predecessor.database.prepare(
          `SELECT labels, ${RUN_EXECUTION_COLUMNS} FROM runs WHERE id = ?`,
        ).get(runId) as Record<string, unknown>;
        expect(runAfter.labels).toBe(JSON.stringify(['migrated']));
        expect({ ...runAfter, labels: undefined }).toEqual({ ...runBefore, labels: undefined });
        expect(predecessor.database.prepare(`SELECT ${BATCH_EXECUTION_COLUMNS} FROM execution_batches WHERE id = ?`).get(batchId))
          .toEqual(batchBefore);
        // 编辑后的标签进入四层查询。
        expect(labelStore.countEntityLabels(visibility, { entity: 'run', projectId }, { labels: [], match: 'any' }))
          .toEqual([{ label: 'migrated', count: 1 }]);

        // 升级后策略预览：未启动 Task 就绪（modelMap.low 候选），受保护 Task 照常阻塞。
        const reads = createSqliteQueryStore(predecessor);
        const ready = previewTaskStrategyReapplication(
          { projectId, taskIds: ['task-fresh-low'] },
          { reads, capabilityCatalog: fixture.box.box.capabilityCatalog },
        );
        expect(ready.status).toBe('ready');
        expect(ready.items[0]).toMatchObject({
          eligible: true,
          candidate: { configSource: 'project_default', configSourceKey: 'modelMap.low' },
          diff: { changed: true, fields: ['model'] },
        });
        for (const [taskId, expectedReason] of [
          ['t-1', 'task_started'],
          ['t-2', 'authorized_batch_scope'],
        ] as const) {
          const blocked = previewTaskStrategyReapplication(
            { projectId, taskIds: [taskId] },
            { reads, capabilityCatalog: fixture.box.box.capabilityCatalog },
          );
          expect(blocked.status).toBe('blocked');
          expect(blocked.blockedReasons).toContain(expectedReason);
        }
        // 预览零写入：Run 标签编辑结果保持。
        expect((predecessor.database.prepare('SELECT labels FROM runs WHERE id = ?').get(runId) as { labels: string }).labels)
          .toBe(JSON.stringify(['migrated']));
      } finally {
        predecessor.close();
      }
    } finally {
      fixture.box.close();
    }
  });
});
