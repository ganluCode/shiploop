/**
 * P01-4 / F-004 真实 SQLite 回滚与当前配置 CAS 阶段负例（检查
 * `P01-FR1-ROLLBACK` / `P01-FR2-ROLLBACK` / `P01-FR2-CAS`，契约见
 * docs/p01-4-acceptance-contract.md §2.1 / §3.3）：复用前序事务故障注入端口
 * （真实 SQLite `CREATE TEMP TRIGGER … RAISE(ABORT)`，与 F-005/F-007/F-010
 * 同一注入面），在 F-002 夹具的隔离数据根与真实 Git 仓库上证明：
 *
 * - P01-FR1-ROLLBACK：组合创建（注册：项目+绑定；组合创建：项目+初始配置）
 *   在首个写入后注入确定性异常，本次参与行全部不存在；关闭全部连接后经
 *   **产品装配入口**重开同一数据根仍无残留，既有正常项目/绑定/配置逐字段
 *   不受影响；撤除注入后同一操作成功（失败只来自注入点，非状态污染）；
 * - P01-FR2-ROLLBACK：在当前配置 CAS 更新与其脱敏变更记录（state_events）
 *   提交之间注入失败，payload/revision/本次记录全部回滚；预期错误与副作用
 *   断言同时成立才计为通过；错误不回显合成凭据哨兵；
 * - P01-FR2-CAS：两个真实独立子进程经文件哨兵同步屏障，以同一旧 revision
 *   经应用服务 ConfigurationService 竞争更新项目当前配置，恰一成功一
 *   conflict，revision 仅递增一次，持久值等于胜者；竞争后过期更新不能
 *   改变胜者结果；父进程有界等待并核验子进程退出码；
 * - 既有跨项目写隔离、外键与有限 busy 回归在本文件有**实际测试入口与真实
 *   结果**：证据来自真实库的只读核对（rawRow/COUNT）与产品返回值，不以
 *   mock 次数或成功日志替代，也不手工改库制造通过结果。
 *
 * 所有证据（注入错误、前后行数/payload/revision、竞争结果、退出码）在删除
 * 临时业务资源之前序列化到独立报告目录；必需工具缺失由夹具显式失败而非 skip。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import type { ConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createProjectService } from '../packages/core/src/application/project-service.ts';
import type { ProjectService } from '../packages/core/src/application/project-service.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { openSqliteConnection } from '../packages/core/src/adapters/sqlite/connection.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { canonicalJson, sha256Hex, withP01AcceptanceFixture } from './helpers/p01-4-fixture.ts';
import type { P01EvidenceRef } from './helpers/p01-4-fixture.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = dirname(fileURLToPath(import.meta.url));
const SETTINGS_CHILD_SCRIPT = join(testDir, 'helpers', 'settings-race-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

/** 合成凭据哨兵：只以引用形式出现，任何错误/审计/证据文本都不得回显。 */
const SECRET_REF = 'keychain://shiploop/P01-4-TOP-SECRET-SENTINEL';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_800_100_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

/**
 * 与 helpers/settings-race-child.ts 完全一致的可信静态能力目录：runtime `pi`
 * 支持 anthropic（枚举两个模型）与 openai（不枚举模型，model 透传），保证
 * 父进程写入的初始配置在子进程装配复检下同样合法。
 */
function createRaceCatalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [
        { providerId: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
        { providerId: 'openai' },
      ],
    },
  ]);
}

function openAiPayload(model: string, credentialRef?: string): SettingsPayload {
  return {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: {
        runtime: 'pi',
        provider: 'openai',
        model,
        ...(credentialRef === undefined ? {} : { credentialRef }),
      },
    },
  };
}

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  readonly projectService: ProjectService;
  readonly configurationService: ConfigurationService;
  close(): void;
};

/** 打开真实临时库会话并执行版本化迁移，装配真实 StateStore 与应用服务（非 mock）。 */
async function openHarness(
  dbPath: string,
  clock: Clock,
  sessionOptions: { busyTimeoutMs?: number; busyRetryAttempts?: number } = {},
): Promise<Harness> {
  const session = openSqliteStorageSession({ path: dbPath, ...sessionOptions });
  try {
    await migrateSqliteStorage(session);
  } catch (error) {
    session.close();
    throw error;
  }
  const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
  const projectService = createProjectService({
    stateStore: store,
    repositoryInspector: createRepositoryInspector(),
  });
  const configurationService = createConfigurationService({
    stateStore: store,
    capabilityCatalog: createRaceCatalog(),
  });
  return {
    session,
    store,
    projectService,
    configurationService,
    close(): void {
      session.close();
    },
  };
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

/** 捕获预期注入失败：必须真实抛出，否则用例失败（不允许静默成功）。 */
async function catchExpectedError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('预期注入失败，但操作成功返回（不允许静默成功）');
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function rawRow(
  session: SqliteStorageSession,
  sql: string,
  ...params: unknown[]
): Record<string, unknown> {
  return session.database.prepare(sql).get(...params) as Record<string, unknown>;
}

/** 本次组合创建/配置写入的全部参与表行数快照（只读核对，不改库）。 */
function tableCounts(session: SqliteStorageSession): Record<string, number> {
  return {
    projects: countRows(session, 'projects'),
    repository_bindings: countRows(session, 'repository_bindings'),
    project_settings: countRows(session, 'project_settings'),
    global_settings: countRows(session, 'global_settings'),
    state_events: countRows(session, 'state_events'),
  };
}

interface StateEventRow {
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
      'SELECT project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at ' +
        'FROM state_events ORDER BY sequence',
    )
    .all();
}

/* ------------------------------------------------------------------ *
 * 跨进程 CAS 竞争（真实独立子进程 + 文件哨兵同步屏障 + 有界退出核验）
 * ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

type ChildResult =
  | { readonly outcome: 'success'; readonly revision: number; readonly model: string }
  | { readonly outcome: 'conflict'; readonly expectedRevision?: number; readonly actualRevision?: unknown }
  | { readonly outcome: 'error'; readonly name: string; readonly message: string };

type RacerOutcome = {
  readonly marker: string;
  readonly exit: { code: number | null; signal: NodeJS.Signals | null };
  readonly stderr: string;
  readonly result: ChildResult;
};

/**
 * 真实跨进程竞争：两个独立子进程（helpers/settings-race-child.ts，应用服务
 * ConfigurationService 层）连接同一真实库，经文件哨兵同步屏障后以同一旧
 * revision 竞争更新项目当前配置。父进程有界等待并核验子进程退出码。
 */
async function runProjectSettingsRace(
  raceDir: string,
  dbPath: string,
  projectId: string,
  expectedRevision: number,
): Promise<RacerOutcome[]> {
  mkdirSync(raceDir, { recursive: true });
  const goFile = join(raceDir, 'race.go');
  const racers = (['A', 'B'] as const).map((marker) => ({
    marker,
    config: {
      dbPath,
      mode: 'project' as const,
      projectId,
      expectedRevision,
      marker,
      readyFile: join(raceDir, `race.ready.${marker}`),
      goFile,
      resultFile: join(raceDir, `race.result.${marker}.json`),
    },
  }));

  const children = racers.map(({ config }) => {
    const child = spawn(
      process.execPath,
      ['--import', CHILD_REGISTER, SETTINGS_CHILD_SCRIPT, JSON.stringify(config)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return { child, stderr: () => stderr };
  });

  try {
    // 同步屏障：两个子进程都就绪后才放行，尽量让写事务真实重叠。
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

describe('F-004 P01-FR1-ROLLBACK 组合创建回滚（真实 TEMP TRIGGER 故障注入）', () => {
  it('首个写入后注入确定性异常：项目/绑定/初始配置全部不存在，重开无残留，既有正常项目/配置不受影响', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const repoBefore = fixture.snapshotSourceRepo();
      const dbPath = join(fixture.dataRoot, DATABASE_FILE_NAME);
      const gitOptions = { home: fixture.homeDir } as const;
      const rollbackRepo = join(fixture.root, '回滚目标 仓库 🚀');

      const globalV1 = openAiPayload('p01-4-fr1-global');
      const projectV1 = openAiPayload('p01-4-fr1-project');
      const compositePayload = openAiPayload('p01-4-fr1-composite');

      let baselineProjectId = '';
      let countsBefore: Record<string, number> = {};
      let bindingError: Error | undefined;
      let settingsError: Error | undefined;

      const harness = await openHarness(dbPath, createClock());
      try {
        // 既有正常基线：真实注册 + 全局/项目配置（不受后续失败影响的对照组）。
        const baseline = await harness.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: '基线项目',
          description: 'F-004 回滚对照组',
          labels: ['Core'],
        });
        expect(baseline.status).toBe('registered');
        baselineProjectId = baseline.project.id;
        await harness.configurationService.createSettings({ kind: 'global' }, { payload: globalV1 });
        await harness.configurationService.createSettings(
          { kind: 'project', projectId: baselineProjectId },
          { payload: projectV1 },
        );

        // 回滚目标：第二个真实 Git 仓库（Unicode/空格路径）。
        initGitRepo(rollbackRepo);
        writeFileSync(join(rollbackRepo, 'f.txt'), 'rollback target\n', 'utf-8');
        commitAll(rollbackRepo, 'rollback target initial', gitOptions);
        countsBefore = tableCounts(harness.session);
        expect(countsBefore).toEqual({
          projects: 1,
          repository_bindings: 1,
          project_settings: 1,
          global_settings: 1,
          state_events: 0,
        });

        // 注入点 1（复用 F-005 注入面）：绑定写入在首个写入（projects 插入）
        // 之后确定性失败 → 项目与绑定整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER p014_fail_binding_insert BEFORE INSERT ON repository_bindings ' +
            "BEGIN SELECT RAISE(ABORT, 'p01-4 injected binding failure'); END",
        );
        bindingError = await catchExpectedError(() =>
          harness.projectService.registerRepository({
            repositoryPath: rollbackRepo,
            displayName: '回滚目标项目',
            labels: ['不应残留'],
          }),
        );
        expect(bindingError.message).toContain('p01-4 injected binding failure');
        // 副作用断言（与错误断言同时成立才计为通过）：全部参与表保持基线行数。
        expect(tableCounts(harness.session)).toEqual(countsBefore);
        // 目标规范路径没有任何绑定残留（只读核对）。
        expect(
          harness.session.database
            .prepare('SELECT COUNT(*) AS n FROM repository_bindings WHERE canonical_path = ?')
            .get(realpathSync(rollbackRepo)),
        ).toEqual({ n: 0 });

        // 注入点 2（复用 F-007 注入面）：组合创建（项目+初始配置）在首个写入
        // （projects 插入）之后确定性失败 → 两行整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER p014_fail_settings_insert BEFORE INSERT ON project_settings ' +
            "BEGIN SELECT RAISE(ABORT, 'p01-4 injected settings failure'); END",
        );
        settingsError = await catchExpectedError(() =>
          harness.store.createProjectWithInitialSettings(
            { displayName: '组合回滚目标', labels: ['不应残留'] },
            { payload: compositePayload },
          ),
        );
        expect(settingsError.message).toContain('p01-4 injected settings failure');
        expect(tableCounts(harness.session)).toEqual(countsBefore);
      } finally {
        // TEMP TRIGGER 随连接关闭消亡；失败路径同样关闭句柄。
        harness.close();
      }

      // 关闭全部连接后经**产品装配入口**重开同一数据根：无残留，基线逐字段不受影响。
      const reopenedApp = await fixture.openApplication();
      try {
        const page = await reopenedApp.projectService.listProjects();
        expect(page.records.map((record) => record.id)).toEqual([baselineProjectId]);
        const project = await reopenedApp.projectService.getProject(baselineProjectId);
        expect(project.displayName).toBe('基线项目');
        expect(project.labels).toEqual(['core']);
        expect(project.revision).toBe(1);
        const binding = await reopenedApp.projectService.getRepositoryBinding(baselineProjectId);
        expect(binding.canonicalPath).toBe(realpathSync(fixture.repoDir));
        const globalAfter = await reopenedApp.configurationService.getCurrentSettings({
          kind: 'global',
        });
        expect(globalAfter.revision).toBe(1);
        expect(globalAfter.payload).toEqual(globalV1);
        const projectSettingsAfter = await reopenedApp.configurationService.getCurrentSettings({
          kind: 'project',
          projectId: baselineProjectId,
        });
        expect(projectSettingsAfter.revision).toBe(1);
        expect(projectSettingsAfter.payload).toEqual(projectV1);
      } finally {
        reopenedApp.close();
      }

      // 无注入的新连接上同一操作成功：证明失败只来自注入点而非状态污染。
      const recovery = await openHarness(dbPath, createClock(1_800_200_000_000));
      let recoveryCounts: Record<string, number> = {};
      try {
        const reRegistered = await recovery.projectService.registerRepository({
          repositoryPath: rollbackRepo,
          displayName: '回滚目标项目',
          labels: ['恢复'],
        });
        expect(reRegistered.status).toBe('registered');
        const composite = await recovery.store.createProjectWithInitialSettings(
          { displayName: '组合回滚目标', labels: ['恢复'] },
          { payload: compositePayload },
        );
        expect(composite.settings.projectId).toBe(composite.project.id);
        expect(composite.settings.revision).toBe(1);
        recoveryCounts = tableCounts(recovery.session);
        expect(recoveryCounts).toEqual({
          projects: 3,
          repository_bindings: 2,
          project_settings: 2,
          global_settings: 1,
          state_events: 0,
        });
      } finally {
        recovery.close();
      }

      // 源仓库与根外哨兵逐字节不变（故障注入不触碰业务仓库）。
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      // 证据先于业务清理落盘（契约 §2.1 证据字段）。
      const evidence: P01EvidenceRef = fixture.writeEvidence(
        'rollback/fr1-rollback.json',
        JSON.stringify(
          {
            checkId: 'P01-FR1-ROLLBACK',
            status: 'pass',
            businessInputDigest: fixture.businessInputDigest,
            injected_errors: [
              { injection: 'repository_bindings.before_insert', message: bindingError!.message },
              { injection: 'project_settings.before_insert', message: settingsError!.message },
            ],
            participating_tables: ['projects', 'repository_bindings', 'project_settings'],
            counts_before: countsBefore,
            counts_after_injected_failure: countsBefore,
            zero_residue_after_failure: true,
            baseline: {
              project_id: baselineProjectId,
              unaffected_after_reopen: true,
              global_settings_revision: 1,
              project_settings_revision: 1,
            },
            reopen: {
              via: 'openCoreApplication（新装配实例）',
              project_ids: [baselineProjectId],
              residue_after_reopen: false,
            },
            recovery_after_injection_removed: {
              registration: 'registered',
              composite_create: 'registered',
              counts: recoveryCounts,
            },
            outside_sentinel_sha256: outsideBefore,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      expect(evidence.relativePath).toBe('rollback/fr1-rollback.json');

      fixture.cleanup();
      expect(fixture.cleaned).toBe(true);
      const saved = JSON.parse(
        readFileSync(join(fixture.reportDir, evidence.relativePath), 'utf-8'),
      ) as Record<string, unknown>;
      expect(saved['checkId']).toBe('P01-FR1-ROLLBACK');
      expect(saved['status']).toBe('pass');
      expect(JSON.stringify(saved)).not.toContain(REPO_ROOT);
    });
  });
});

describe('F-004 P01-FR2-ROLLBACK 当前配置更新与脱敏变更记录回滚', () => {
  it('在配置更新与 state_events 提交之间注入失败：payload/revision/记录全部回滚，错误与副作用断言同时成立', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const dbPath = join(fixture.dataRoot, DATABASE_FILE_NAME);
      const globalV1 = openAiPayload('p01-4-fr2-global-1');
      const globalV2 = openAiPayload('p01-4-fr2-global-2');
      const projectV1 = openAiPayload('p01-4-fr2-project-1', SECRET_REF);
      const projectV2 = openAiPayload('p01-4-fr2-project-2', SECRET_REF);

      let projectId = '';
      let globalRowBefore: Record<string, unknown> = {};
      let projectRowBefore: Record<string, unknown> = {};
      let projectError: Error | undefined;
      let globalError: Error | undefined;

      const harness = await openHarness(dbPath, createClock());
      try {
        const registration = await harness.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: '配置回滚项目',
          labels: ['Core'],
        });
        projectId = registration.project.id;
        await harness.configurationService.createSettings({ kind: 'global' }, { payload: globalV1 });
        await harness.configurationService.createSettings(
          { kind: 'project', projectId },
          { payload: projectV1 },
        );
        globalRowBefore = rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global');
        projectRowBefore = rawRow(
          harness.session,
          'SELECT * FROM project_settings WHERE project_id = ?',
          projectId,
        );
        expect(countRows(harness.session, 'state_events')).toBe(0);

        // 注入（复用 F-010 注入面）：配置行 UPDATE 已在同一事务内完成，
        // state_events 插入处确定性失败 → payload/revision/记录整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER p014_fail_event_insert BEFORE INSERT ON state_events ' +
            "BEGIN SELECT RAISE(ABORT, 'p01-4 injected event failure'); END",
        );

        // 项目 scope：预期错误必须真实抛出。
        projectError = await catchExpectedError(() =>
          harness.configurationService.updateSettings(
            { kind: 'project', projectId },
            { expectedRevision: 1, payload: projectV2 },
          ),
        );
        expect(projectError.message).toContain('p01-4 injected event failure');
        // 错误不回显合成凭据哨兵。
        expect(`${projectError.name} ${projectError.message}`).not.toContain(SECRET_REF);
        // 全局 scope 同样整组回滚。
        globalError = await catchExpectedError(() =>
          harness.configurationService.updateSettings(
            { kind: 'global' },
            { expectedRevision: 1, payload: globalV2 },
          ),
        );
        expect(globalError.message).toContain('p01-4 injected event failure');

        // 副作用断言（与错误断言同时成立才计为通过）：
        // payload/revision 逐字节回滚到注入前，本次脱敏记录不存在。
        expect(
          rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global'),
        ).toEqual(globalRowBefore);
        expect(
          rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectId),
        ).toEqual(projectRowBefore);
        expect(countRows(harness.session, 'state_events')).toBe(0);
        const currentProject = await harness.store.getProjectSettings(projectId);
        expect(currentProject.revision).toBe(1);
        expect(currentProject.payload).toEqual(projectV1);

        // 撤除注入后同一更新成功：revision 仅递增一次，恰一条脱敏记录。
        harness.session.database.exec('DROP TRIGGER temp.p014_fail_event_insert');
        const recovered = await harness.configurationService.updateSettings(
          { kind: 'project', projectId },
          { expectedRevision: 1, payload: projectV2 },
        );
        expect(recovered.revision).toBe(2);
        const events = readStateEvents(harness.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.event_type).toBe('settings.project_updated');
        expect(events[0]!.project_id).toBe(projectId);
        expect(events[0]!.aggregate_revision).toBe(2);
        // 脱敏记录不含 payload 值/合成凭据/模型标记。
        expect(events[0]!.payload).not.toContain(SECRET_REF);
        expect(events[0]!.payload).not.toContain('p01-4-fr2-project-2');
      } finally {
        harness.close();
      }

      // 关闭重开（产品装配入口）：恢复后的值/revision 与恰一条记录持久一致；
      // 失败的全局更新无任何痕迹（仍 revision 1 / 原 payload）。
      const reopenedApp = await fixture.openApplication();
      try {
        const projectAfter = await reopenedApp.configurationService.getCurrentSettings({
          kind: 'project',
          projectId,
        });
        expect(projectAfter.revision).toBe(2);
        expect(projectAfter.payload).toEqual(projectV2);
        const globalAfter = await reopenedApp.configurationService.getCurrentSettings({
          kind: 'global',
        });
        expect(globalAfter.revision).toBe(1);
        expect(globalAfter.payload).toEqual(globalV1);
      } finally {
        reopenedApp.close();
      }

      // 只读核对真实库：恰一条审计记录，无失败尝试残留。
      const verify = await openHarness(dbPath, createClock(1_800_300_000_000));
      let eventsAfter: readonly StateEventRow[] = [];
      try {
        eventsAfter = readStateEvents(verify.session);
        expect(eventsAfter).toHaveLength(1);
        expect(eventsAfter.map((event) => event.sequence)).toEqual([1]);
      } finally {
        verify.close();
      }

      const evidence = fixture.writeEvidence(
        'rollback/fr2-rollback.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-ROLLBACK',
            status: 'pass',
            businessInputDigest: fixture.businessInputDigest,
            injected_error: {
              injection: 'state_events.before_insert',
              message: projectError!.message,
              error_name: projectError!.name,
              contains_secret_sentinel: false,
            },
            operation_identity: {
              operation: 'ConfigurationService.updateSettings',
              scopes: [
                { kind: 'project', project_id: projectId },
                { kind: 'global' },
              ],
            },
            before: {
              project_payload_digest: sha256Hex(canonicalJson(projectV1)),
              global_payload_digest: sha256Hex(canonicalJson(globalV1)),
              revision: 1,
              state_events: 0,
            },
            after_injected_failure: {
              project_payload_digest: sha256Hex(canonicalJson(projectV1)),
              global_payload_digest: sha256Hex(canonicalJson(globalV1)),
              revision: 1,
              state_events: 0,
              payload_rolled_back: true,
              revision_rolled_back: true,
              event_record_rolled_back: true,
            },
            recovery_after_injection_removed: {
              revision: 2,
              state_events: eventsAfter.length,
              event_type: eventsAfter[0]?.event_type ?? null,
              event_redacted: true,
            },
            reopen: {
              via: 'openCoreApplication（新装配实例）',
              project_revision: 2,
              global_revision_unchanged: 1,
            },
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      expect(evidence.relativePath).toBe('rollback/fr2-rollback.json');

      fixture.cleanup();
      const saved = JSON.parse(
        readFileSync(join(fixture.reportDir, evidence.relativePath), 'utf-8'),
      ) as Record<string, unknown>;
      expect(saved['checkId']).toBe('P01-FR2-ROLLBACK');
      expect(saved['status']).toBe('pass');
      expect(JSON.stringify(saved)).not.toContain(SECRET_REF);
      expect(JSON.stringify(saved)).not.toContain(REPO_ROOT);
    });
  });
});

describe('F-004 P01-FR2-CAS 跨进程当前配置 CAS 竞争', () => {
  it('两个屏障同步的真实独立进程以同一旧 revision 竞争：恰一成功一 conflict，revision 仅增一次，过期更新不改变胜者', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const dbPath = join(fixture.dataRoot, DATABASE_FILE_NAME);
      const raceDir = join(fixture.root, 'cas-race');
      const expectedRevision = 1;

      // 初始事实：真实注册 + 项目配置 revision 1；关闭后交给子进程竞争。
      let projectId = '';
      const setup = await openHarness(dbPath, createClock());
      try {
        const registration = await setup.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: 'CAS 竞争目标',
          labels: ['Core'],
        });
        projectId = registration.project.id;
        const created = await setup.configurationService.createSettings(
          { kind: 'project', projectId },
          { payload: openAiPayload('p01-4-cas-initial') },
        );
        expect(created.revision).toBe(expectedRevision);
      } finally {
        setup.close();
      }

      const outcomes = await runProjectSettingsRace(raceDir, dbPath, projectId, expectedRevision);

      // 父进程核验子进程退出：两个进程都正常结束（退出码 0、无信号）。
      for (const outcome of outcomes) {
        expect(outcome.exit.signal, outcome.stderr).toBeNull();
        expect(outcome.exit.code, outcome.stderr).toBe(0);
      }
      const winners = outcomes.filter((outcome) => outcome.result.outcome === 'success');
      const losers = outcomes.filter((outcome) => outcome.result.outcome === 'conflict');
      // 恰有一个成功、一个 conflict：证明是条件写入，不是先读后无条件覆盖。
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winner = winners[0]!;
      const loser = losers[0]!;
      const winnerModel = winner.result.outcome === 'success' ? winner.result.model : '';
      expect(winner.result.outcome === 'success' && winner.result.revision).toBe(
        expectedRevision + 1,
      );
      expect(winnerModel).toBe(`model-${winner.marker}`);
      if (loser.result.outcome === 'conflict') {
        expect(loser.result.expectedRevision).toBe(expectedRevision);
        expect(loser.result.actualRevision).toBe(expectedRevision + 1);
      }

      // 关闭重开真实库（只读核对）：revision 只增加一次，payload 与胜者一致，
      // 恰一条脱敏审计记录。
      const verify = await openHarness(dbPath, createClock(1_800_400_000_000));
      let staleError: StorageError | undefined;
      try {
        const settings = await verify.store.getProjectSettings(projectId);
        expect(settings.revision).toBe(expectedRevision + 1);
        expect(settings.payload.strategies?.defaultStrategy?.model).toBe(winnerModel);
        expect(countRows(verify.session, 'project_settings')).toBe(1);
        const events = readStateEvents(verify.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.event_type).toBe('settings.project_updated');
        expect(events[0]!.project_id).toBe(projectId);
        expect(events[0]!.aggregate_revision).toBe(expectedRevision + 1);
        expect(events[0]!.payload).not.toContain(winnerModel);

        // 过期更新不能改变胜者结果：同一旧 revision 再次被 conflict 拒绝，
        // 持久值与 revision 保持胜者结果。
        staleError = await expectStorageError('conflict', () =>
          verify.configurationService.updateSettings(
            { kind: 'project', projectId },
            { expectedRevision, payload: openAiPayload('p01-4-cas-stale') },
          ),
        );
        expect(staleError.details).toMatchObject({
          expectedRevision,
          actualRevision: expectedRevision + 1,
        });
        const afterStale = await verify.store.getProjectSettings(projectId);
        expect(afterStale.revision).toBe(expectedRevision + 1);
        expect(afterStale.payload.strategies?.defaultStrategy?.model).toBe(winnerModel);
        expect(readStateEvents(verify.session)).toHaveLength(1);
      } finally {
        verify.close();
      }

      // 产品装配入口重开：持久值等于胜者。
      const reopenedApp = await fixture.openApplication();
      try {
        const current = await reopenedApp.configurationService.getCurrentSettings({
          kind: 'project',
          projectId,
        });
        expect(current.revision).toBe(expectedRevision + 1);
        expect(current.payload.strategies?.defaultStrategy?.model).toBe(winnerModel);
      } finally {
        reopenedApp.close();
      }

      const evidence = fixture.writeEvidence(
        'rollback/fr2-cas.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-CAS',
            status: 'pass',
            businessInputDigest: fixture.businessInputDigest,
            expected_revision: expectedRevision,
            success_count: winners.length,
            conflict_count: losers.length,
            winner: {
              marker: winner.marker,
              model: winnerModel,
              revision: expectedRevision + 1,
            },
            loser: {
              marker: loser.marker,
              outcome: loser.result.outcome,
              expectedRevision:
                loser.result.outcome === 'conflict' ? loser.result.expectedRevision : null,
              actualRevision:
                loser.result.outcome === 'conflict' ? loser.result.actualRevision : null,
            },
            revision_delta: 1,
            child_exits: outcomes.map((outcome) => ({
              marker: outcome.marker,
              code: outcome.exit.code,
              signal: outcome.exit.signal,
            })),
            stale_update_after_race: {
              rejected: staleError!.kind,
              expectedRevision,
              actualRevision: expectedRevision + 1,
              winner_unchanged: true,
            },
            persisted: {
              revision: expectedRevision + 1,
              model: winnerModel,
              audit_events: 1,
            },
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      expect(evidence.relativePath).toBe('rollback/fr2-cas.json');

      fixture.cleanup();
      const saved = JSON.parse(
        readFileSync(join(fixture.reportDir, evidence.relativePath), 'utf-8'),
      ) as Record<string, unknown>;
      expect(saved['checkId']).toBe('P01-FR2-CAS');
      expect(saved['status']).toBe('pass');
      expect(saved['success_count']).toBe(1);
      expect(saved['conflict_count']).toBe(1);
      expect(JSON.stringify(saved)).not.toContain(REPO_ROOT);
    });
  }, 90_000);
});

describe('F-004 既有跨项目写隔离、外键与有限 busy 回归（实际入口 + 真实结果）', () => {
  it('阶段核对：前序回归入口实际存在，跨项目隔离/外键回滚/有限 busy 在真实库上复验并留存证据', async () => {
    // 必需检查清单承接的前序回归实际入口（§2.3）必须在库且可运行。
    const regressionEntries = [
      'test/project-registration.test.ts',
      'test/configuration-service.test.ts',
      'test/sqlite-cas-and-atomicity.test.ts',
      'test/helpers/register-race-child.ts',
      'test/helpers/settings-race-child.ts',
      'test/helpers/cas-race-child.ts',
    ] as const;
    for (const entry of regressionEntries) {
      expect(existsSync(join(REPO_ROOT, entry)), `前序回归入口缺失：${entry}`).toBe(true);
    }

    await withP01AcceptanceFixture(async (fixture) => {
      const dbPath = join(fixture.dataRoot, DATABASE_FILE_NAME);

      // —— 跨项目写隔离：A 的过期/合法写入都不得触碰 B 的行（只读核对真实库） ——
      let crossProject: Record<string, unknown> = {};
      {
        const harness = await openHarness(dbPath, createClock());
        try {
          const projectA = await harness.store.createProject({ displayName: '阶段核对项目A' });
          const projectB = await harness.store.createProject({ displayName: '阶段核对项目B' });
          await harness.configurationService.createSettings(
            { kind: 'project', projectId: projectA.id },
            { payload: openAiPayload('p01-4-iso-a') },
          );
          await harness.configurationService.createSettings(
            { kind: 'project', projectId: projectB.id },
            { payload: openAiPayload('p01-4-iso-b') },
          );
          const aBefore = rawRow(
            harness.session,
            'SELECT * FROM project_settings WHERE project_id = ?',
            projectA.id,
          );
          const bBefore = rawRow(
            harness.session,
            'SELECT * FROM project_settings WHERE project_id = ?',
            projectB.id,
          );

          // A 的过期 CAS：conflict 且 A/B 行逐字段不变。
          const stale = await expectStorageError('conflict', () =>
            harness.configurationService.updateSettings(
              { kind: 'project', projectId: projectA.id },
              { expectedRevision: 99, payload: openAiPayload('p01-4-iso-stale') },
            ),
          );
          expect(stale.entity).toEqual({ type: 'project_settings', projectId: projectA.id });
          expect(
            rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectA.id),
          ).toEqual(aBefore);
          expect(
            rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectB.id),
          ).toEqual(bBefore);

          // B 的合法更新：A 的行仍逐字段不变，审计记录只携带 B 的身份。
          await harness.configurationService.updateSettings(
            { kind: 'project', projectId: projectB.id },
            { expectedRevision: 1, payload: openAiPayload('p01-4-iso-b2') },
          );
          expect(
            rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectA.id),
          ).toEqual(aBefore);
          const events = readStateEvents(harness.session);
          expect(events).toHaveLength(1);
          expect(events[0]!.project_id).toBe(projectB.id);

          crossProject = {
            stale_conflict_kind: stale.kind,
            entity: stale.entity,
            project_a_row_unchanged: true,
            project_b_row_untouched_by_a: true,
            audit_event_project: 'B',
          };
        } finally {
          harness.close();
        }
      }

      // —— 外键失败：事务内第二步引用缺失项目，第一行一并回滚（零残留） ——
      let fkResult: Record<string, unknown> = {};
      {
        const harness = await openHarness(dbPath, createClock(1_800_500_000_000));
        try {
          const countsBeforeFk = tableCounts(harness.session);
          expect(() =>
            harness.session.transactWrite('p01-4.fk_rollback', (db) => {
              db.prepare(
                'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels, repository_binding_id) ' +
                  "VALUES ('p014-fk-first', 1, 1, 1, '外键第一行', 'active', NULL, '[]', NULL)",
              ).run();
              db.prepare(
                'INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) ' +
                  'VALUES (\'s014-fk-orphan\', 1, \'p014-missing\', 1, 1, 1, \'{"schemaVersion":1}\')',
              ).run();
            }),
          ).toThrow(/FOREIGN KEY/);
          // 外键失败未提交任何相关写入。
          expect(tableCounts(harness.session)).toEqual(countsBeforeFk);
          fkResult = {
            error_matched: 'FOREIGN KEY',
            first_row_rolled_back: true,
            counts_unchanged: true,
          };
        } finally {
          harness.close();
        }
      }

      // —— 有限 busy：真实写锁持有时组合写入在有限预算内失败且零残留；锁释放后成功 ——
      let busyResult: Record<string, unknown> = {};
      {
        const busyHarness = await openHarness(dbPath, createClock(1_800_600_000_000), {
          busyTimeoutMs: 20,
          busyRetryAttempts: 2,
        });
        const locker = openSqliteConnection(dbPath);
        let busyError: StorageError;
        let elapsedMs = 0;
        try {
          locker.database.exec('BEGIN IMMEDIATE');
          const startedAt = Date.now();
          busyError = await expectStorageError('busy', () =>
            busyHarness.store.createProjectWithInitialSettings(
              { displayName: 'busy 阶段核对目标' },
              { payload: openAiPayload('p01-4-busy') },
            ),
          );
          elapsedMs = Date.now() - startedAt;
          expect(busyError.details).toMatchObject({ attempts: 2, busyTimeoutMs: 20 });
          // 有限预算：远小于外层测试超时，绝不悬挂。
          expect(elapsedMs).toBeLessThan(10_000);
          expect(countRows(busyHarness.session, 'projects')).toBe(2);
          expect(countRows(busyHarness.session, 'project_settings')).toBe(2);
        } finally {
          locker.database.exec('ROLLBACK');
          locker.close();
        }
        // 锁释放后同一组合写入成功（busy 不是状态污染）。
        const recovered = await busyHarness.store.createProjectWithInitialSettings(
          { displayName: 'busy 阶段核对目标' },
          { payload: openAiPayload('p01-4-busy') },
        );
        expect(recovered.settings.projectId).toBe(recovered.project.id);
        expect(countRows(busyHarness.session, 'projects')).toBe(3);
        busyHarness.close();
        busyResult = {
          kind: busyError!.kind,
          attempts: 2,
          busy_timeout_ms: 20,
          elapsed_ms: elapsedMs,
          zero_rows_committed: true,
          recovered_after_lock_release: true,
        };
      }

      const evidence = fixture.writeEvidence(
        'rollback/regression-entries.json',
        JSON.stringify(
          {
            checkId: 'P01-FR1-ROLLBACK/P01-FR2-ROLLBACK/P01-FR2-CAS（既有回归支撑）',
            status: 'pass',
            businessInputDigest: fixture.businessInputDigest,
            regression_entries: regressionEntries.map((entry) => ({ entry, exists: true })),
            real_db_reverification: {
              cross_project_isolation: crossProject,
              foreign_key_rollback: fkResult,
              bounded_busy: busyResult,
            },
            evidence_source: '真实库只读核对（rawRow/COUNT）+ 产品返回值（StorageError.kind/entity/details）',
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      expect(evidence.relativePath).toBe('rollback/regression-entries.json');

      fixture.cleanup();
      const saved = JSON.parse(
        readFileSync(join(fixture.reportDir, evidence.relativePath), 'utf-8'),
      ) as Record<string, unknown>;
      expect(saved['status']).toBe('pass');
      expect(JSON.stringify(saved)).not.toContain(REPO_ROOT);
    });
  });
});
