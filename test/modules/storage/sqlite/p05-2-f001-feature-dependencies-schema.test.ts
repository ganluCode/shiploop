import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_700_001_000_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedPlanGraph(session: ReturnType<typeof openSqliteStorageSession>): void {
  const db = session.database;
  db.prepare(
    "INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES (?, ?, ?, ?, 'active', '[]')",
  ).run('project-a', NOW, NOW, '项目 A');
  db.prepare(
    "INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES (?, ?, ?, ?, 'active', '[]')",
  ).run('project-b', NOW, NOW, '项目 B');
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES (?, ?, ?, ?, ?, 'open', '[]')",
  ).run('phase-a', NOW, 'project-a', NOW, 'Phase A');
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES (?, ?, ?, ?, ?, 'open', '[]')",
  ).run('phase-b', NOW, 'project-a', NOW, 'Phase B');
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES (?, ?, ?, ?, ?, 'open', '[]')",
  ).run('phase-other-project', NOW, 'project-b', NOW, 'Phase B');

  const insertFeature = db.prepare(
    "INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'draft', '[]', '[]', 'not_requested')",
  );
  insertFeature.run('feature-a', NOW, 'project-a', NOW, 'phase-a', 'Feature A');
  insertFeature.run('feature-b', NOW, 'project-a', NOW, 'phase-a', 'Feature B');
  insertFeature.run('feature-c', NOW, 'project-a', NOW, 'phase-b', 'Feature C');
  insertFeature.run('feature-other-project', NOW, 'project-b', NOW, 'phase-other-project', 'Feature Other');
}

function insertEdge(
  session: ReturnType<typeof openSqliteStorageSession>,
  values: { id: string; projectId: string; phaseId: string; featureId: string; dependsOnId: string },
): void {
  session.database
    .prepare(
      'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
    )
    .run(values.id, NOW, values.projectId, NOW, values.phaseId, values.featureId, values.dependsOnId, null);
}

async function withSandbox(fn: (root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p052-f001-');
  try {
    await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

describe('P05-2 F-001 Feature DAG SQLite schema', () => {
  it('[case:dag-migration-upgrade] v37 追加迁移保留旧计划数据并只创建 Feature DAG 表', async () => {
    await withSandbox(async (root) => {
      const path = join(root, 'state.db');
      const legacy = openSqliteStorageSession({ path });
      try {
        await migrateSqliteStorage(legacy, {
          migrations: SQLITE_MIGRATIONS.slice(0, 36),
          nowUtcMs: () => NOW,
        });
        seedPlanGraph(legacy);
        const before = legacy.database.prepare('SELECT COUNT(*) AS count FROM features').get() as { count: number };
        expect(before.count).toBe(4);
        const upgraded = await migrateSqliteStorage(legacy, { migrations: SQLITE_MIGRATIONS.slice(0, 37), nowUtcMs: () => NOW + 1 });
        expect(upgraded.appliedVersions).toEqual([37]);
        expect(legacy.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_dependencies'").get()).toBeTruthy();
        expect((legacy.database.prepare('SELECT COUNT(*) AS count FROM features').get() as { count: number }).count).toBe(4);
        expect(legacy.database.prepare('SELECT COUNT(*) AS count FROM feature_dependencies').get()).toEqual({ count: 0 });
        expect(legacy.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('execution_batches', 'runs', 'attempts')").all()).toHaveLength(3);
      } finally {
        legacy.close();
      }
    });
  });

  it('[case:dag-ownership-constraints] 依赖边拒绝跨项目、跨 Phase、自依赖、重复和缺失引用', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
        seedPlanGraph(session);
        insertEdge(session, { id: 'edge-a', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependsOnId: 'feature-a' });
        expect(() => insertEdge(session, { id: 'edge-self', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependsOnId: 'feature-a' })).toThrow(/constraint/i);
        expect(() => insertEdge(session, { id: 'edge-duplicate', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependsOnId: 'feature-a' })).toThrow(/constraint/i);
        expect(() => insertEdge(session, { id: 'edge-cross-phase', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependsOnId: 'feature-c' })).toThrow(/constraint/i);
        expect(() => insertEdge(session, { id: 'edge-cross-project', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependsOnId: 'feature-other-project' })).toThrow(/constraint/i);
        expect(() => insertEdge(session, { id: 'edge-missing', projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependsOnId: 'missing' })).toThrow(/constraint/i);
        expect((session.database.prepare('SELECT COUNT(*) AS count FROM feature_dependencies').get() as { count: number }).count).toBe(1);
        expect(() => session.database.prepare('DELETE FROM features WHERE id = ?').run('feature-a')).toThrow(/constraint/i);
        expect(() => session.database.prepare('DELETE FROM phases WHERE id = ?').run('phase-a')).toThrow(/constraint/i);
        expect(() => session.database.prepare('DELETE FROM projects WHERE id = ?').run('project-a')).toThrow(/constraint/i);
      } finally {
        session.close();
      }
    });
  });

  it('[case:dag-migration-rollback] v37 失败时回滚整张边表及迁移记录', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 36), nowUtcMs: () => NOW });
        const migration = SQLITE_MIGRATIONS[36];
        expect(migration?.version).toBe(37);
        const badSql = `${migration?.sql}\nINSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id) VALUES ('bad-edge', 1, 'missing', 1, 1, 'missing', 'missing', 'missing');`;
        await expect(
          migrateSqliteStorage(session, {
            migrations: [...SQLITE_MIGRATIONS.slice(0, 36), { version: 37, sql: badSql, checksum: sha256(badSql) }],
            nowUtcMs: () => NOW,
          }),
        ).rejects.toThrow(/整组回滚/);
        expect(session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_dependencies'").get()).toBeUndefined();
        expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 36 });
      } finally {
        session.close();
      }
    });
  });
});
