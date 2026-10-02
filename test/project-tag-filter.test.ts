/**
 * P01-3 / F-007 项目标签任一/全部筛选、有限分页与项目层标签计数验收
 * （真实临时 SQLite，非 mock）。
 *
 * 覆盖（F-007 验收点，全部为真实断言）：
 * - 真实 SQLite 夹具含重叠标签、重复规范化输入与空标签项目；`match='any'` 与
 *   `match='all'` 返回准确项目 ID；空过滤返回全部、无命中返回空页、未知 match
 *   返回结构化 validation；
 * - 有限分页：有限默认值、上限、稳定排序与游标；非法分页参数在任何 SQL 之前拒绝；
 *   跨页遍历静态夹具不重复不遗漏；
 * - 项目层标签计数按项目去重（同项目同标签只计一次）、与筛选共用可见范围；编辑标签
 *   后筛选与计数立即反映持久状态，关闭重开后一致；只统计项目层，不与其他层级相加；
 * - 标签作为绑定参数传入（含 SQL 元字符不触发注入，不返回全表、不破坏表）；
 * - `ProjectService` 查询入口复用同一端口语义；不实现按标签启动 Batch 或
 *   Phase/Feature/Task 标签查询。
 *
 * 公共入口不导入 ORM / better-sqlite3 / Pi SDK；断言基于真实查询结果，不依赖日志。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createProjectService } from '../packages/core/src/application/project-service.ts';
import type { ProjectService } from '../packages/core/src/application/project-service.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_950_000_000) {
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

async function withMigratedDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p013-f007-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    await fn(dbPath);
  } finally {
    sandbox.cleanup();
  }
}

async function createProject(
  store: StateStore,
  displayName: string,
  labels?: readonly string[],
): Promise<string> {
  const record = await store.createProject({
    displayName,
    ...(labels !== undefined ? { labels } : {}),
  });
  return record.id;
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('F-007 project label filtering (any / all)', () => {
  it('returns accurate project ids for any/all matches, empty filter, and no match', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        // 重叠标签 + 重复规范化输入（空格/大小写/Unicode）+ 空标签项目。
        const backendApi = await createProject(harness.store, '后端 API', [' Backend ', 'API', 'backend']);
        const backendUi = await createProject(harness.store, '后端 UI', ['backend', 'ui']);
        const uiOnly = await createProject(harness.store, '仅 UI', ['UI']);
        const noLabels = await createProject(harness.store, '无标签项目');
        const all = [backendApi, backendUi, uiOnly, noLabels].sort();

        const anyBackend = await harness.store.listProjects({ match: 'any', labels: ['backend'] });
        expect(anyBackend.records.map((record) => record.id).sort()).toEqual(
          [backendApi, backendUi].sort(),
        );
        expect(anyBackend.nextCursor).toBeNull();

        // 重复规范化输入与等价 Unicode 折叠为同一查询标签。
        const anyNormalized = await harness.store.listProjects({
          match: 'any',
          labels: [' BACKEND ', 'Backend'],
        });
        expect(anyNormalized.records.map((record) => record.id).sort()).toEqual(
          [backendApi, backendUi].sort(),
        );

        const anyBackendUi = await harness.store.listProjects({
          match: 'any',
          labels: ['backend', 'ui'],
        });
        expect(anyBackendUi.records.map((record) => record.id).sort()).toEqual(
          [backendApi, backendUi, uiOnly].sort(),
        );

        const allBackendUi = await harness.store.listProjects({
          match: 'all',
          labels: ['backend', 'ui'],
        });
        expect(allBackendUi.records.map((record) => record.id)).toEqual([backendUi]);

        const allBackendApi = await harness.store.listProjects({
          match: 'all',
          labels: ['backend', 'api'],
        });
        expect(allBackendApi.records.map((record) => record.id)).toEqual([backendApi]);

        // 无命中：空页且无下一页。
        const noMatch = await harness.store.listProjects({
          match: 'all',
          labels: ['backend', 'nope'],
        });
        expect(noMatch.records).toEqual([]);
        expect(noMatch.nextCursor).toBeNull();

        // 空过滤（省略/空数组/任一模式空数组）返回全部可见项目。
        for (const filter of [undefined, {}, { labels: [] }, { match: 'all', labels: [] }]) {
          const page = await harness.store.listProjects(filter);
          expect(page.records.map((record) => record.id).sort()).toEqual(all);
          expect(page.nextCursor).toBeNull();
        }

        // 项目服务入口复用同一端口语义。
        const viaService = await harness.service.listProjects({ match: 'all', labels: ['backend', 'api'] });
        expect(viaService.records.map((record) => record.id)).toEqual([backendApi]);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects unknown match modes and malformed filter input before any SQL', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        await createProject(harness.store, '校验项目', ['core']);
        const invalidFilters: unknown[] = [
          { match: 'some', labels: ['core'] },
          { match: 'ANY', labels: ['core'] },
          { labels: 'core' },
          { labels: [42] },
          { labels: ['   '] },
          { unexpected: true },
          'not-an-object',
        ];
        for (const filter of invalidFilters) {
          const error = await harness.store.listProjects(filter).then(
            () => {
              throw new Error(`expected validation for ${JSON.stringify(filter)}`);
            },
            (caught: unknown) => caught,
          );
          expect(isStorageError(error, 'validation'), `filter=${JSON.stringify(filter)}`).toBe(true);
          if (isStorageError(error)) {
            expect(error.operation).toBe('StateStore.listProjects');
          }
        }
        // 非法筛选没有副作用。
        expect(countRows(harness.session, 'projects')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('binds labels as parameters so SQL metacharacters cannot inject queries', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const needle = await createProject(harness.store, '普通项目', ['needle']);
        await createProject(harness.store, '另一项目', ['other']);

        const injected = await harness.store.listProjects({
          match: 'any',
          labels: ["needle' OR '1'='1"],
        });
        // 元字符被当作字面标签：没有项目命中，绝不放行全表。
        expect(injected.records).toEqual([]);

        const dropAttempt = await harness.store.listProjects({
          match: 'any',
          labels: ["'; DROP TABLE projects; --"],
        });
        expect(dropAttempt.records).toEqual([]);

        const allInjected = await harness.store.listProjects({
          match: 'all',
          labels: ['needle', "' OR 1=1 --"],
        });
        expect(allInjected.records).toEqual([]);

        // 表与数据完好，合法查询仍命中。
        expect(countRows(harness.session, 'projects')).toBe(2);
        const legit = await harness.store.listProjects({ match: 'all', labels: ['needle'] });
        expect(legit.records.map((record) => record.id)).toEqual([needle]);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-007 bounded stable pagination', () => {
  it('traverses pages by stable id without duplicates or omissions and honours default/max limits', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const ids: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          ids.push(await createProject(harness.store, `分页项目 ${index}`, ['paged']));
        }
        const expected = [...ids].sort();

        const collected: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await harness.store.listProjects({
            match: 'all',
            labels: ['paged'],
            limit: 2,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          expect(page.records.length).toBeLessThanOrEqual(2);
          collected.push(...page.records.map((record) => record.id));
          if (page.nextCursor === null) {
            break;
          }
          cursor = page.nextCursor;
        }
        expect(collected).toEqual(expected);
        expect(new Set(collected).size).toBe(expected.length);

        // 默认值（有限）与显式上限均被接受；夹具小于默认值时一页读完。
        const defaultPage = await harness.store.listProjects({ labels: ['paged'] });
        expect(defaultPage.records.map((record) => record.id)).toEqual(expected);
        expect(defaultPage.nextCursor).toBeNull();
        const maxPage = await harness.store.listProjects({ limit: 200, labels: ['paged'] });
        expect(maxPage.records.map((record) => record.id)).toEqual(expected);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects illegal pagination parameters and cursors without side effects', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        await createProject(harness.store, '分页校验', ['paged']);
        const invalidFilters: unknown[] = [
          { limit: 0 },
          { limit: -1 },
          { limit: 201 },
          { limit: 1.5 },
          { limit: '2' },
          { cursor: '' },
          { cursor: 'a/b' },
          { cursor: 'has space' },
          { cursor: 123 },
        ];
        for (const filter of invalidFilters) {
          const error = await harness.store.listProjects(filter).then(
            () => {
              throw new Error(`expected validation for ${JSON.stringify(filter)}`);
            },
            (caught: unknown) => caught,
          );
          expect(isStorageError(error, 'validation'), `filter=${JSON.stringify(filter)}`).toBe(true);
        }
        expect(countRows(harness.session, 'projects')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-007 project-level label counts (deduplicated per project)', () => {
  it('counts each label once per project, reflects edits immediately, and survives close/reopen', async () => {
    await withMigratedDb(async (dbPath) => {
      const first = openHarness(dbPath, createClock());
      let coreProjectId: string;
      let uiProjectId: string;
      let duplicateUiProjectId: string;
      try {
        coreProjectId = await createProject(first.store, '核心项目', ['core', 'api']);
        uiProjectId = await createProject(first.store, '界面项目', ['core', 'ui']);
        duplicateUiProjectId = await createProject(first.store, '重复标签项目', ['ui']);
        await createProject(first.store, '无标签项目');

        // 直接注入同一项目内的重复标签，验证计数按项目去重（同标签只计一次）。
        first.session.database
          .prepare("UPDATE projects SET labels = '[\"ui\",\"ui\"]' WHERE id = ?")
          .run(duplicateUiProjectId);

        const counts = await first.service.countProjectLabels();
        expect([...counts].sort((a, b) => a.label.localeCompare(b.label))).toEqual([
          { label: 'api', projectCount: 1 },
          { label: 'core', projectCount: 2 },
          { label: 'ui', projectCount: 2 },
        ]);
        // 只统计项目层：不含其他层级字段，也不做跨层级求和。
        for (const entry of counts) {
          expect(Object.keys(entry).sort()).toEqual(['label', 'projectCount']);
        }

        // 编辑标签后筛选与计数立即反映持久状态。
        await first.store.updateProject(coreProjectId, {
          expectedRevision: 1,
          labels: ['backend'],
        });
        const afterEdit = await first.service.countProjectLabels();
        expect([...afterEdit].sort((a, b) => a.label.localeCompare(b.label))).toEqual([
          { label: 'backend', projectCount: 1 },
          { label: 'core', projectCount: 1 },
          { label: 'ui', projectCount: 2 },
        ]);
        const backendPage = await first.service.listProjects({ match: 'all', labels: ['backend'] });
        expect(backendPage.records.map((record) => record.id)).toEqual([coreProjectId]);
        const corePage = await first.service.listProjects({ match: 'any', labels: ['core'] });
        expect(corePage.records.map((record) => record.id)).toEqual([uiProjectId]);
      } finally {
        first.close();
      }

      const second = openHarness(dbPath, createClock(1_701_050_000_000));
      try {
        const reopened = await second.service.countProjectLabels();
        expect([...reopened].sort((a, b) => a.label.localeCompare(b.label))).toEqual([
          { label: 'backend', projectCount: 1 },
          { label: 'core', projectCount: 1 },
          { label: 'ui', projectCount: 2 },
        ]);
        const reopenedPage = await second.service.listProjects({ match: 'any', labels: ['ui'] });
        expect(reopenedPage.records.map((record) => record.id).sort()).toEqual(
          [uiProjectId, duplicateUiProjectId].sort(),
        );
      } finally {
        second.close();
      }
    });
  });
});
