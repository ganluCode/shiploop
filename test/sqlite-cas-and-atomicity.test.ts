/**
 * F-007 expectedRevision CAS 与原子组合写入深度回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-007 验收点，全部为真实断言）：
 * - 成功 CAS 只匹配当前 revision 并返回递增后的 revision；过期值返回结构化
 *   conflict 且原 payload/revision 不变；真实跨进程竞争证明实现是单语句
 *   条件 UPDATE，而不是先读后无条件覆盖（后者会让两个进程都“成功”）；
 * - 两个独立真实子进程连接同一临时库并以同一旧 revision 竞争更新配置
 *   （文件哨兵同步屏障），恰有一个成功、一个 conflict，revision 只增加一次，
 *   payload 与胜者一致；父进程有界等待并核验子进程退出码；
 * - 项目与初始配置组合创建是业务原子操作：第二步注入失败（真实 SQLite 临时
 *   触发器 RAISE(ABORT)）时没有残留项目或配置；在第一行更新后注入异常时
 *   全部相关行与 revision 回滚；
 * - CAS 冲突、外键失败及 busy 失败都不提交相关写入；项目 A 的更新请求不能
 *   修改项目 B 的配置行，错误携带适用的 projectId/实体/操作且不泄漏凭据哨兵；
 * - 标签等元数据更新走同一 CAS 规则且不动配置行；提交后关闭重开真实库
 *   逐字段一致，不依赖内存缓存。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteConnection } from '../packages/core/src/adapters/sqlite/connection.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_300_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

function payloadWithProvider(provider: string, credentialRef?: string): SettingsPayload {
  return {
    schemaVersion: 1,
    strategies: {
      defaultStrategy: {
        runtime: 'pi',
        provider,
        model: 'claude-sonnet',
        ...(credentialRef === undefined ? {} : { credentialRef }),
      },
    },
  };
}

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  close(): void;
};

function openHarness(
  dbPath: string,
  clock: Clock,
  sessionOptions: { busyTimeoutMs?: number; busyRetryAttempts?: number } = {},
): Harness {
  const session = openSqliteStorageSession({ path: dbPath, ...sessionOptions });
  const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
  return {
    session,
    store,
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(fn: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f007-');
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

async function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function rawRow(session: SqliteStorageSession, sql: string, ...params: unknown[]): Record<string, unknown> {
  return session.database.prepare(sql).get(...params) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 有界等待一组哨兵文件全部出现；超时即失败（不无限等待子进程）。 */
async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`有界等待哨兵文件超时（${timeoutMs}ms）`);
}

/** 有界等待子进程退出；超时先 SIGKILL 再失败，绝不悬挂测试进程。 */
function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`子进程退出超时（${timeoutMs}ms），已 SIGKILL`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

const testDir = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(testDir, 'helpers', 'cas-race-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

type ChildResult =
  | { readonly outcome: 'success'; readonly revision: number; readonly provider: string }
  | {
      readonly outcome: 'conflict';
      readonly expectedRevision?: number;
      readonly actualRevision?: unknown;
      readonly entity?: unknown;
    }
  | { readonly outcome: 'error'; readonly name: string; readonly message: string };

type RacerOutcome = {
  readonly marker: string;
  readonly exit: { code: number | null; signal: NodeJS.Signals | null };
  readonly stderr: string;
  readonly result: ChildResult;
};

/**
 * 真实跨进程竞争：两个独立子进程连接同一临时库，经文件哨兵同步屏障后以
 * 同一旧 revision 竞争更新同一项目配置。父进程有界等待并核验子进程退出。
 */
async function runCrossProcessCasRace(
  root: string,
  dbPath: string,
  projectId: string,
  expectedRevision: number,
): Promise<RacerOutcome[]> {
  const goFile = join(root, 'race.go');
  const racers = (['A', 'B'] as const).map((marker) => ({
    marker,
    config: {
      dbPath,
      projectId,
      expectedRevision,
      marker,
      readyFile: join(root, `race.ready.${marker}`),
      goFile,
      resultFile: join(root, `race.result.${marker}.json`),
    },
  }));

  const children = racers.map(({ config }) => {
    const child = spawn(
      process.execPath,
      ['--import', CHILD_REGISTER, CHILD_SCRIPT, JSON.stringify(config)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return { child, stderr: () => stderr };
  });

  try {
    // 同步屏障：两个子进程都就绪后才放行，尽量让 BEGIN IMMEDIATE 真实重叠。
    await waitForFiles(racers.map(({ config }) => config.readyFile), 20_000);
    writeFileSync(goFile, 'go');

    return await Promise.all(
      racers.map(async ({ marker, config }, index) => {
        const exit = await waitForExit(children[index]!.child, 30_000);
        if (!existsSync(config.resultFile)) {
          throw new Error(
            `子进程 ${marker} 未写结果文件（exit=${String(exit.code)}）：${children[index]!.stderr()}`,
          );
        }
        const result = JSON.parse(readFileSync(config.resultFile, 'utf8')) as ChildResult;
        return { marker, exit, stderr: children[index]!.stderr(), result };
      }),
    );
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }
}

describe('F-007 cross-process CAS race on the same real database', () => {
  it('lets exactly one of two barrier-synchronized processes win; revision increments once and payload matches the winner', async () => {
    await withMigratedDb(async (dbPath, root) => {
      const setup = openHarness(dbPath, createClock());
      let projectId: string;
      try {
        const { project } = await setup.store.createProjectWithInitialSettings(
          { displayName: '竞争目标项目' },
          { payload: payloadWithProvider('provider-initial') },
        );
        projectId = project.id;
      } finally {
        setup.close();
      }

      const outcomes = await runCrossProcessCasRace(root, dbPath, projectId, 1);

      // 父进程核验子进程退出：两个进程都正常结束（退出码 0、无信号）。
      for (const outcome of outcomes) {
        expect(outcome.exit.signal, outcome.stderr).toBeNull();
        expect(outcome.exit.code, outcome.stderr).toBe(0);
      }

      const winners = outcomes.filter((outcome) => outcome.result.outcome === 'success');
      const losers = outcomes.filter((outcome) => outcome.result.outcome === 'conflict');
      // 恰有一个成功、一个 conflict：证明不是先读后无条件覆盖。
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winner = winners[0]!;
      const loser = losers[0]!;
      expect(winner.result.outcome === 'success' && winner.result.revision).toBe(2);
      if (loser.result.outcome === 'conflict') {
        expect(loser.result.expectedRevision).toBe(1);
        expect(loser.result.actualRevision).toBe(2);
        expect(loser.result.entity).toEqual({ type: 'project_settings', projectId });
      }

      // 关闭重开真实库：revision 只增加一次，payload 与胜者一致。
      const verify = openHarness(dbPath, createClock(1_700_400_000_000));
      try {
        const settings = await verify.store.getProjectSettings(projectId);
        expect(settings.revision).toBe(2);
        expect(settings.payload.strategies?.defaultStrategy?.provider).toBe(
          `provider-${winner.marker}`,
        );
        expect(countRows(verify.session, 'project_settings')).toBe(1);
        expect(countRows(verify.session, 'projects')).toBe(1);
      } finally {
        verify.close();
      }
    });
  }, 90_000);
});

describe('F-007 atomic composite create (project + initial settings)', () => {
  it('creates the project and its initial settings in one atomic operation', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const { project, settings } = await harness.store.createProjectWithInitialSettings(
          { displayName: '组合创建项目', description: '原子创建', labels: ['Core'] },
          { payload: payloadWithProvider('provider-composite') },
        );
        expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(project.revision).toBe(1);
        expect(project.labels).toEqual(['core']);
        expect(settings.projectId).toBe(project.id);
        expect(settings.revision).toBe(1);
        expect(settings.schemaVersion).toBe(1);
        expect(settings.createdAtUtcMs).toBe(project.createdAtUtcMs);

        expect(await harness.store.getProject(project.id)).toEqual(project);
        expect(await harness.store.getProjectSettings(project.id)).toEqual(settings);
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'project_settings')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('validates both inputs before any persistence: an invalid settings payload leaves zero rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const error = await expectStorageError('validation', () =>
          harness.store.createProjectWithInitialSettings(
            { displayName: '不应残留的项目' },
            { payload: { schemaVersion: 99 } },
          ),
        );
        expect(error.operation).toBe('StateStore.createProjectWithInitialSettings');
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);

        const invalidProject = await expectStorageError('validation', () =>
          harness.store.createProjectWithInitialSettings(
            { displayName: '  ' },
            { payload: payloadWithProvider('provider-x') },
          ),
        );
        expect(invalidProject.operation).toBe('StateStore.createProjectWithInitialSettings');
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rolls back the project row when the second step fails (real temp trigger injection)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        // 通过真实 SQLite 临时触发器在第二步（project_settings 插入）注入失败：
        // 此刻第一步（projects 插入）已在同一事务内完成，失败必须整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f007_fail_settings_insert BEFORE INSERT ON project_settings ' +
            "BEGIN SELECT RAISE(ABORT, 'f-007 injected second-step failure'); END",
        );
        await expect(
          harness.store.createProjectWithInitialSettings(
            { displayName: '触发器注入目标' },
            { payload: payloadWithProvider('provider-injected') },
          ),
        ).rejects.toThrow(/f-007 injected second-step failure/);
        // 第二步失败：没有残留项目或配置（无半条业务记录）。
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);

        // 撤除注入后同一操作成功，证明失败只来自注入点而非状态污染。
        harness.session.database.exec('DROP TRIGGER temp.f007_fail_settings_insert');
        const { project, settings } = await harness.store.createProjectWithInitialSettings(
          { displayName: '触发器注入目标' },
          { payload: payloadWithProvider('provider-injected') },
        );
        expect(settings.projectId).toBe(project.id);
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'project_settings')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('rolls back every related row and revision when an exception is injected after the first row write', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const { project } = await harness.store.createProjectWithInitialSettings(
          { displayName: '回滚目标' },
          { payload: payloadWithProvider('provider-rollback') },
        );
        // 在第一行 UPDATE 完成之后、第二行 UPDATE 处注入真实失败。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f007_fail_settings_update BEFORE UPDATE ON project_settings ' +
            "BEGIN SELECT RAISE(ABORT, 'f-007 injected update failure'); END",
        );
        expect(() =>
          harness.session.transactWrite('test.atomic_pair_update', (db) => {
            db.prepare("UPDATE projects SET revision = revision + 1, display_name = '第一行已改' WHERE id = ?").run(
              project.id,
            );
            db.prepare('UPDATE project_settings SET revision = revision + 1 WHERE project_id = ?').run(project.id);
          }),
        ).toThrow(/f-007 injected update failure/);

        // 两行及其 revision 都回滚到事务前状态。
        const projectRow = rawRow(harness.session, 'SELECT revision, display_name FROM projects WHERE id = ?', project.id);
        expect(projectRow['revision']).toBe(1);
        expect(projectRow['display_name']).toBe('回滚目标');
        const settingsRow = rawRow(
          harness.session,
          'SELECT revision FROM project_settings WHERE project_id = ?',
          project.id,
        );
        expect(settingsRow['revision']).toBe(1);

        // 撤除注入后端口恢复正常写入。
        harness.session.database.exec('DROP TRIGGER temp.f007_fail_settings_update');
        const updated = await harness.store.updateProject(project.id, { expectedRevision: 1, labels: ['恢复'] });
        expect(updated.revision).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('does not commit related writes when a foreign key fails mid-transaction', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        expect(() =>
          harness.session.transactWrite('test.fk_failure_rollback', (db) => {
            db.prepare(
              'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels, repository_binding_id) ' +
                "VALUES ('p-fk-first', 1, 1, 1, '第一行', 'active', NULL, '[]', NULL)",
            ).run();
            // 第二步引用不存在的项目：外键失败必须让第一行也回滚。
            db.prepare(
              'INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) ' +
                "VALUES ('s-fk-orphan', 1, 'p-does-not-exist', 1, 1, 1, '{\"schemaVersion\":1}')",
            ).run();
          }),
        ).toThrow(/FOREIGN KEY/);
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('does not commit the composite write when the busy budget is exhausted under a real write lock', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock(), { busyTimeoutMs: 20, busyRetryAttempts: 2 });
      const locker = openSqliteConnection(dbPath);
      try {
        locker.database.exec('BEGIN IMMEDIATE');
        const startedAt = Date.now();
        const error = await expectStorageError('busy', () =>
          harness.store.createProjectWithInitialSettings(
            { displayName: 'busy 目标' },
            { payload: payloadWithProvider('provider-busy') },
          ),
        );
        const elapsed = Date.now() - startedAt;
        expect(error.details).toMatchObject({ attempts: 2, busyTimeoutMs: 20 });
        expect(elapsed).toBeLessThan(10_000);
        // busy 失败未提交任何相关写入。
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);
      } finally {
        locker.database.exec('ROLLBACK');
        locker.close();
      }
      // 锁释放后同一组合写入成功。
      const { project, settings } = await harness.store.createProjectWithInitialSettings(
        { displayName: 'busy 目标' },
        { payload: payloadWithProvider('provider-busy') },
      );
      expect(settings.projectId).toBe(project.id);
      expect(countRows(harness.session, 'projects')).toBe(1);
      harness.close();
    });
  });
});

describe('F-007 cross-project write isolation and error diagnostics', () => {
  it('never lets an update request for project A touch project B rows; conflict errors carry identity without secrets', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const secretA = 'keyring://TOP-SECRET-SENTINEL-A';
        const secretB = 'keyring://TOP-SECRET-SENTINEL-B';
        const compositeA = await harness.store.createProjectWithInitialSettings(
          { displayName: '项目A' },
          { payload: payloadWithProvider('provider-a', secretA) },
        );
        const compositeB = await harness.store.createProjectWithInitialSettings(
          { displayName: '项目B' },
          { payload: payloadWithProvider('provider-b', secretB) },
        );
        const projectA = compositeA.project.id;
        const projectB = compositeB.project.id;

        const bProjectBefore = rawRow(harness.session, 'SELECT * FROM projects WHERE id = ?', projectB);
        const bSettingsBefore = rawRow(
          harness.session,
          'SELECT * FROM project_settings WHERE project_id = ?',
          projectB,
        );

        // A 的合法 CAS 更新（配置 + 标签元数据）：B 的所有行逐字段不变。
        await harness.store.updateProjectSettings(projectA, {
          expectedRevision: 1,
          payload: payloadWithProvider('provider-a2'),
        });
        await harness.store.updateProject(projectA, { expectedRevision: 1, labels: ['仅A'] });
        expect(rawRow(harness.session, 'SELECT * FROM projects WHERE id = ?', projectB)).toEqual(bProjectBefore);
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectB)).toEqual(
          bSettingsBefore,
        );

        // A 上的过期 CAS：错误携带适用的 projectId/实体/操作，且不泄漏双方凭据哨兵。
        const stale = await expectStorageError('conflict', () =>
          harness.store.updateProjectSettings(projectA, {
            expectedRevision: 99,
            payload: payloadWithProvider('provider-stale'),
          }),
        );
        expect(stale.operation).toBe('StateStore.updateProjectSettings');
        expect(stale.entity).toEqual({ type: 'project_settings', projectId: projectA });
        const diagnosticText = `${stale.message} ${JSON.stringify(stale.entity)} ${JSON.stringify(stale.details)}`;
        expect(diagnosticText).not.toContain('TOP-SECRET-SENTINEL-A');
        expect(diagnosticText).not.toContain('TOP-SECRET-SENTINEL-B');
        expect(diagnosticText).not.toContain(projectB);

        // 冲突后 A/B 行均未被修改。
        const aSettings = await harness.store.getProjectSettings(projectA);
        expect(aSettings.revision).toBe(2);
        expect(aSettings.payload.strategies?.defaultStrategy?.provider).toBe('provider-a2');
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectB)).toEqual(
          bSettingsBefore,
        );
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-007 CAS durability across close and reopen', () => {
  it('keeps CAS-updated rows field-by-field identical after reopening the real database', async () => {
    await withMigratedDb(async (dbPath) => {
      const first = openHarness(dbPath, createClock());
      let expectedProject: Awaited<ReturnType<StateStore['getProject']>>;
      let expectedSettings: Awaited<ReturnType<StateStore['getProjectSettings']>>;
      try {
        const { project, settings } = await first.store.createProjectWithInitialSettings(
          { displayName: '耐久目标', labels: ['初始'] },
          { payload: payloadWithProvider('provider-durable') },
        );
        expect(settings.revision).toBe(1);
        expectedProject = await first.store.updateProject(project.id, {
          expectedRevision: 1,
          labels: ['已更新'],
        });
        expectedSettings = await first.store.updateProjectSettings(project.id, {
          expectedRevision: 1,
          payload: payloadWithProvider('provider-durable-2'),
        });
        expect(expectedProject.revision).toBe(2);
        expect(expectedSettings.revision).toBe(2);
        // 标签元数据更新未触碰配置行（revision 仍为配置自己 CAS 后的 2，不是 3）。
      } finally {
        first.close();
      }

      const second = openHarness(dbPath, createClock(1_700_500_000_000));
      try {
        expect(await second.store.getProject(expectedProject.id)).toEqual(expectedProject);
        expect(await second.store.getProjectSettings(expectedProject.id)).toEqual(expectedSettings);
        expect(countRows(second.session, 'projects')).toBe(1);
        expect(countRows(second.session, 'project_settings')).toBe(1);
      } finally {
        second.close();
      }
    });
  });
});
