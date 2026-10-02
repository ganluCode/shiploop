/**
 * P01-3 / F-006 项目身份查询与元数据 CAS 编辑应用服务验收（真实临时 Git 仓库 +
 * 真实临时 SQLite，非 mock）。
 *
 * 覆盖（F-006 验收点，全部为真实断言）：
 * - 应用服务按 projectId 查询返回持久化身份/名称/描述/labels/revision，并可按项目
 *   读取完整仓库绑定；未知 ID 返回结构化 not_found；
 * - 通过 F-002 校验的名称/描述/标签 CAS 编辑匹配 expectedRevision 后返回递增
 *   revision 并持久化；同一 revision 的并发编辑恰一成功一 conflict，不丢更新，
 *   实际存储回归断言胜者结果；
 * - 过期 revision、错误字段、非法标签返回明确错误，数据库值与 revision 不变，
 *   且不产生变更记录；
 * - 改名称/仅改标签不修改 projectId、canonicalPath、仓库绑定、当前配置、
 *   PathService 项目位置或已有制品，不借元数据编辑 rebind；
 * - 变更按 F-001 确认的 state_events 落点保存操作/项目/写后修订身份与**脱敏**
 *   字段摘要（只含字段名，不含字段值/凭据）；注入记录写入失败时元数据与 revision
 *   一并回滚（无半条记录）；sequence 数据库内单调递增；
 * - 关闭重开后经应用服务读取到更新值与持久变更记录。
 *
 * 只实现项目层元数据；不新增 Phase/Feature/Task 或执行表。
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { deriveProjectRelativeDir } from '../packages/core/src/ports/path-service.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createProjectService } from '../packages/core/src/application/project-service.ts';
import type { ProjectService } from '../packages/core/src/application/project-service.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { assertGitAvailable, commitAll, initGitRepo } from './helpers/git-repo.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_900_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  readonly service: ProjectService;
  close(): void;
};

function openHarness(dbPath: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: dbPath });
  const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
  const service = createProjectService({
    stateStore: store,
    repositoryInspector: createRepositoryInspector(),
  });
  return {
    session,
    store,
    service,
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(fn: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p013-f006-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    await fn(dbPath, sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

interface StateEventRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_revision: number;
  readonly payload: string;
  readonly occurred_at: number;
}

function readStateEvents(session: SqliteStorageSession): StateEventRow[] {
  return session.database
    .prepare<[], StateEventRow>(
      'SELECT id, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at ' +
        'FROM state_events ORDER BY sequence',
    )
    .all();
}

function rawProjectRow(session: SqliteStorageSession, id: string): Record<string, unknown> {
  return session.database
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as Record<string, unknown>;
}

async function registerRepo(
  harness: Harness,
  root: string,
  name: string,
  dirName: string,
  metadata: { displayName?: string; description?: string | null; labels?: readonly string[] } = {},
): Promise<{ projectId: string; bindingId: string; canonicalPath: string }> {
  const repoDir = join(root, dirName);
  initGitRepo(repoDir);
  writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
  commitAll(repoDir, 'initial');
  const result = await harness.service.registerRepository({
    repositoryPath: repoDir,
    displayName: metadata.displayName ?? name,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.labels !== undefined ? { labels: metadata.labels } : {}),
  });
  if (result.status !== 'registered') {
    throw new Error(`预期 registered，实际 ${result.status}`);
  }
  return {
    projectId: result.project.id,
    bindingId: result.binding.id,
    canonicalPath: result.binding.canonicalPath,
  };
}

const VALID_PAYLOAD = {
  schemaVersion: 1,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
} as const;

describe('F-006 project identity query', () => {
  it('returns persisted identity, metadata and binding by projectId; unknown ids are not_found', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const registered = await registerRepo(harness, root, '身份查询项目', 'repo-identity', {
          description: '# 说明\n\nMarkdown 与 Unicode 🚀',
          labels: [' Core ', 'CORE', '核心'],
        });

        const project = await harness.service.getProject(registered.projectId);
        expect(project.id).toBe(registered.projectId);
        expect(project.displayName).toBe('身份查询项目');
        expect(project.description).toBe('# 说明\n\nMarkdown 与 Unicode 🚀');
        expect(project.labels).toEqual(['core', '核心']);
        expect(project.revision).toBe(1);
        expect(project.repositoryBindingId).toBe(registered.bindingId);

        const binding = await harness.service.getRepositoryBinding(registered.projectId);
        expect(binding.id).toBe(registered.bindingId);
        expect(binding.projectId).toBe(registered.projectId);
        expect(binding.canonicalPath).toBe(registered.canonicalPath);

        // 未知 ID（合法形态）分别返回 not_found。
        const missingProject = await harness.service.getProject('p-does-not-exist').then(
          () => {
            throw new Error('expected not_found');
          },
          (caught: unknown) => caught,
        );
        expect(isStorageError(missingProject, 'not_found')).toBe(true);
        const missingBinding = await harness.service.getRepositoryBinding('p-does-not-exist').then(
          () => {
            throw new Error('expected not_found');
          },
          (caught: unknown) => caught,
        );
        expect(isStorageError(missingBinding, 'not_found')).toBe(true);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-006 metadata CAS editing with redacted audit record', () => {
  it('applies name/description/labels under expectedRevision, persists and records a redacted state event', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const secret = 'sk-live-TOP-SECRET-SENTINEL';
        const registered = await registerRepo(harness, root, '待改项目', 'repo-update', {
          description: `初始说明 ${secret}`,
          labels: ['初期'],
        });

        const updated = await harness.service.updateProjectMetadata(registered.projectId, {
          expectedRevision: 1,
          displayName: '  新名称  ',
          description: `更新后的说明 ${secret}`,
          labels: [' 新标签 ', '新标签', '新标签2'],
        });
        expect(updated.revision).toBe(2);
        expect(updated.displayName).toBe('新名称');
        expect(updated.description).toBe(`更新后的说明 ${secret}`);
        expect(updated.labels).toEqual(['新标签', '新标签2']);
        // 身份与绑定不因元数据编辑改变。
        expect(updated.id).toBe(registered.projectId);
        expect(updated.repositoryBindingId).toBe(registered.bindingId);
        expect(await harness.service.getProject(registered.projectId)).toEqual(updated);

        // 脱敏变更记录：操作/实体/写后修订身份 + 只含字段名的摘要。
        const events = readStateEvents(harness.session);
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.event_type).toBe('project.metadata_updated');
        expect(event.aggregate_type).toBe('project');
        expect(event.aggregate_id).toBe(registered.projectId);
        expect(event.aggregate_revision).toBe(2);
        expect(event.project_id).toBe(registered.projectId);
        expect(event.sequence).toBe(1);
        expect(event.occurred_at).toBe(updated.updatedAtUtcMs);
        const payload = JSON.parse(event.payload) as { changedFields?: string[] };
        expect(payload.changedFields).toEqual(['displayName', 'description', 'labels']);
        // 记录绝不包含字段值、凭据或绝对路径。
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('新名称');
        expect(serialized).not.toContain(registered.canonicalPath);

        // 第二次更新：sequence 数据库内单调递增，aggregate_revision 跟随新 revision。
        const second = await harness.service.updateProjectMetadata(registered.projectId, {
          expectedRevision: 2,
          labels: ['仅标签'],
        });
        expect(second.revision).toBe(3);
        const after = readStateEvents(harness.session);
        expect(after.map((row) => row.sequence)).toEqual([1, 2]);
        expect(after[1]!.aggregate_revision).toBe(3);
        expect(JSON.parse(after[1]!.payload)).toEqual({ changedFields: ['labels'] });
      } finally {
        harness.close();
      }
    });
  });

  it('rejects stale revisions, invalid labels and unknown fields without changing values or recording events', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const registered = await registerRepo(harness, root, 'CAS 目标', 'repo-cas', {
          description: '原始描述',
          labels: ['原始'],
        });
        const before = rawProjectRow(harness.session, registered.projectId);

        // 过期 revision → conflict，原值/revision 不变，无变更记录。
        const stale = await harness.service
          .updateProjectMetadata(registered.projectId, { expectedRevision: 5, displayName: '不应生效' })
          .then(
            () => {
              throw new Error('expected conflict');
            },
            (caught: unknown) => caught,
          );
        expect(isStorageError(stale, 'conflict')).toBe(true);

        // 非法标签 → validation，字段定位到 labels[0]。
        const invalidLabels = await harness.service
          .updateProjectMetadata(registered.projectId, { expectedRevision: 1, labels: ['   '] })
          .then(
            () => {
              throw new Error('expected validation');
            },
            (caught: unknown) => caught,
          );
        expect(isStorageError(invalidLabels, 'validation')).toBe(true);
        if (isStorageError(invalidLabels)) {
          expect(invalidLabels.operation).toBe('ProjectService.updateProjectMetadata');
          expect(invalidLabels.details?.['field']).toBe('labels[0]');
        }

        // 未知字段、缺字段、空白名称同样在任何 I/O 之前拒绝。
        await expect(
          harness.service.updateProjectMetadata(registered.projectId, {
            expectedRevision: 1,
            unexpectedKey: true,
          }),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        await expect(
          harness.service.updateProjectMetadata(registered.projectId, { expectedRevision: 1 }),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        await expect(
          harness.service.updateProjectMetadata(registered.projectId, {
            expectedRevision: 1,
            displayName: '   ',
          }),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));

        expect(rawProjectRow(harness.session, registered.projectId)).toEqual(before);
        expect(readStateEvents(harness.session)).toHaveLength(0);
      } finally {
        harness.close();
      }
    });
  });

  it('lets exactly one of two concurrent edits on the same revision win (no lost update)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const registered = await registerRepo(harness, root, '并发编辑', 'repo-race');
        const results = await Promise.allSettled([
          harness.service.updateProjectMetadata(registered.projectId, {
            expectedRevision: 1,
            displayName: '编辑者 A',
            labels: ['a'],
          }),
          harness.service.updateProjectMetadata(registered.projectId, {
            expectedRevision: 1,
            displayName: '编辑者 B',
            labels: ['b'],
          }),
        ]);
        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(isStorageError((rejected[0] as PromiseRejectedResult).reason, 'conflict')).toBe(true);

        // 实际存储回归断言胜者结果：revision 只递增一次，值为胜者。
        const winner = (fulfilled[0] as PromiseFulfilledResult<{ displayName: string; labels: readonly string[] }>)
          .value;
        const stored = await harness.service.getProject(registered.projectId);
        expect(stored.revision).toBe(2);
        expect(stored.displayName).toBe(winner.displayName);
        expect(stored.labels).toEqual([...winner.labels]);
        expect(readStateEvents(harness.session)).toHaveLength(1);
      } finally {
        harness.close();
      }
    });
  });

  it('rolls back metadata and revision when the audit record write fails (real trigger injection)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const registered = await registerRepo(harness, root, '注入目标', 'repo-rollback', {
          description: '事务前描述',
          labels: ['之前'],
        });
        const before = rawProjectRow(harness.session, registered.projectId);

        // 在 state_events 插入处注入真实失败：元数据已在同一事务内更新，失败必须整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f006_fail_event_insert BEFORE INSERT ON state_events ' +
            "BEGIN SELECT RAISE(ABORT, 'f-006 injected event failure'); END",
        );
        await expect(
          harness.service.updateProjectMetadata(registered.projectId, {
            expectedRevision: 1,
            displayName: '不应提交',
            labels: ['不应提交'],
          }),
        ).rejects.toThrow(/f-006 injected event failure/);

        // 元数据与 revision 一并回滚，无变更记录。
        expect(rawProjectRow(harness.session, registered.projectId)).toEqual(before);
        expect(countRows(harness.session, 'state_events')).toBe(0);

        // 撤除注入后同一操作成功，证明失败只来自注入点。
        harness.session.database.exec('DROP TRIGGER temp.f006_fail_event_insert');
        const updated = await harness.service.updateProjectMetadata(registered.projectId, {
          expectedRevision: 1,
          displayName: '注入后成功',
        });
        expect(updated.revision).toBe(2);
        expect(readStateEvents(harness.session)).toHaveLength(1);
      } finally {
        harness.close();
      }
    });
  });

  it('does not alter binding, path, settings or existing artifacts when metadata changes', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const registered = await registerRepo(harness, root, '边界项目', 'repo-boundary');
        await harness.store.createProjectSettings(registered.projectId, { payload: VALID_PAYLOAD });
        await harness.store.createProject({ displayName: '无关项目' });
        // 已存在的制品索引（正文由 F-010~F-012 管理；此处断言索引不被元数据编辑触碰）。
        const artifacts = createSqliteArtifactStore(harness.session);
        const artifact = await artifacts.registerArtifact({
          projectId: registered.projectId,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash: 'ab'.repeat(32),
          locator: 'reports/boundary.json',
        });

        const bindingBefore = await harness.service.getRepositoryBinding(registered.projectId);
        const settingsBefore = harness.session.database
          .prepare('SELECT * FROM project_settings WHERE project_id = ?')
          .get(registered.projectId) as Record<string, unknown>;
        const artifactBefore = harness.session.database
          .prepare('SELECT * FROM artifacts WHERE id = ?')
          .get(artifact.id) as Record<string, unknown>;
        const projectDirBefore = deriveProjectRelativeDir(registered.projectId);

        const updated = await harness.service.updateProjectMetadata(registered.projectId, {
          expectedRevision: 1,
          displayName: '仅改名',
          labels: ['仅标签'],
        });
        expect(updated.revision).toBe(2);
        expect(updated.id).toBe(registered.projectId);
        expect(updated.repositoryBindingId).toBe(registered.bindingId);

        // 绑定、canonicalPath、配置、PathService 位置均不变，不 rebind。
        expect(await harness.service.getRepositoryBinding(registered.projectId)).toEqual(bindingBefore);
        expect(
          harness.session.database.prepare('SELECT * FROM project_settings WHERE project_id = ?').get(registered.projectId),
        ).toEqual(settingsBefore);
        expect(harness.session.database.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact.id)).toEqual(
          artifactBefore,
        );
        expect(deriveProjectRelativeDir(registered.projectId)).toBe(projectDirBefore);
        expect(realpathSync(join(root, 'repo-boundary'))).toBe(bindingBefore.canonicalPath);
        // 只改了名称/标签，源仓库内容未被写入或迁移。
        expect(readFileSync(join(root, 'repo-boundary', 'README.md'), 'utf8')).toBe('# 边界项目\n');
        expect(existsSync(join(root, 'repo-boundary', '.git'))).toBe(true);
      } finally {
        harness.close();
      }
    });
  });

  it('reads updated values and the persisted change record after close and reopen', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const first = openHarness(dbPath, createClock());
      let projectId: string;
      try {
        const registered = await registerRepo(first, root, '重开项目', 'repo-reopen');
        projectId = registered.projectId;
        await first.service.updateProjectMetadata(projectId, {
          expectedRevision: 1,
          displayName: '重开后的名称',
          labels: ['持久'],
        });
      } finally {
        first.close();
      }

      const second = openHarness(dbPath, createClock(1_701_000_000_000));
      try {
        const project = await second.service.getProject(projectId);
        expect(project.displayName).toBe('重开后的名称');
        expect(project.labels).toEqual(['持久']);
        expect(project.revision).toBe(2);
        const events = readStateEvents(second.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.event_type).toBe('project.metadata_updated');
        expect(JSON.parse(events[0]!.payload)).toEqual({
          changedFields: ['displayName', 'labels'],
        });
      } finally {
        second.close();
      }
    });
  });
});
