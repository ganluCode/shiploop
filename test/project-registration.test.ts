/**
 * P01-3 / F-005 ProjectService 仓库注册用例验收（真实临时 Git 仓库 + 真实临时
 * SQLite，非 mock）。
 *
 * 覆盖（F-005 验收点，全部为真实断言）：
 * - 注册真实临时仓库返回稳定 projectId（应用侧 UUID，不由名称/remote/目录标题
 *   生成）、完整 repositoryBinding 与 registered；持久化 displayName（trim）、
 *   description（原样保留）、规范 labels、revision 与 UTC 时间；
 * - 同路径重复注册与符号链接别名注册返回同一 projectId/绑定及 already_exists，
 *   不新增行、不覆盖原名称/描述/标签；关闭重开后仍返回同一项目与绑定；
 * - 同一临时 origin 的两个 clone 分别注册得到不同 projectId 与 canonicalPath，
 *   remote 相同不合并；直接断言数据库行数与返回绑定；
 * - 两个独立真实子进程经文件哨兵同步屏障竞争注册同一真实路径，最终恰有一个
 *   项目与一个有效绑定，另一请求复用胜者（already_exists），不覆盖胜者元数据；
 * - 项目与绑定在同一短事务保存：注入绑定写入失败（真实 SQLite 临时触发器
 *   RAISE(ABORT)）后项目和绑定均回滚，无孤立行；
 * - 非法标签、无效仓库及路径检查错误不产生业务行；元数据校验先于仓库检查
 *   （检查端口未被调用），Git/文件检查发生在数据库写事务之外（检查失败时
 *   写入端口未被调用）；
 * - 端口级绑定输入校验（相对路径/空 identity/NUL/未知键）在任何 SQL 之前拒绝。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  deriveRepoIdentity,
  isRepositoryInspectionError,
  REPO_IDENTITY_PREFIX,
} from '../packages/core/src/ports/repository-inspector.ts';
import type { RepositoryInspection } from '../packages/core/src/ports/repository-inspector.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createProjectService } from '../packages/core/src/application/project-service.ts';
import type { ProjectService } from '../packages/core/src/application/project-service.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from './helpers/git-repo.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_600_000_000) {
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
  const sandbox = createTempSandbox('shiploop-p013-f005-');
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

const UUID_PATTERN = /^[0-9a-f-]{36}$/;

describe('F-005 registerRepository persists stable identity, metadata and binding atomically', () => {
  it('registers a real temp repository with stable projectId, full binding and persisted metadata', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, '仓库 alpha');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'README.md'), '# alpha\n');
      const head = commitAll(repoDir, 'initial');

      const harness = openHarness(dbPath, createClock());
      try {
        const result = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '  我的项目  ',
          description: '# 说明\n\n**Markdown** 与 Unicode 🚀 原样保留',
          labels: [' Core ', 'CORE', '核心'],
        });

        expect(result.status).toBe('registered');
        const { project, binding } = result;
        // 稳定 projectId：应用侧 UUID，非名称/remote/目录标题推导。
        expect(project.id).toMatch(UUID_PATTERN);
        expect(project.displayName).toBe('我的项目');
        expect(project.description).toBe('# 说明\n\n**Markdown** 与 Unicode 🚀 原样保留');
        expect(project.labels).toEqual(['core', '核心']);
        expect(project.status).toBe('active');
        expect(project.revision).toBe(1);
        expect(Number.isInteger(project.createdAtUtcMs)).toBe(true);
        expect(project.createdAtUtcMs).toBe(project.updatedAtUtcMs);
        expect(project.repositoryBindingId).toBe(binding.id);

        // 完整 repositoryBinding：realpath 规范路径、Git 公共目录与派生身份。
        expect(binding.id).toMatch(UUID_PATTERN);
        expect(binding.projectId).toBe(project.id);
        expect(binding.canonicalPath).toBe(realpathSync(repoDir));
        const expectedGitCommonDir = realpathSync(join(repoDir, '.git'));
        expect(binding.gitCommonDir).toBe(expectedGitCommonDir);
        expect(binding.repoIdentity).toBe(deriveRepoIdentity(expectedGitCommonDir));
        expect(binding.repoIdentity.startsWith(REPO_IDENTITY_PREFIX)).toBe(true);
        expect(binding.revision).toBe(1);
        expect(binding.bindingRevision).toBe(1);
        expect(binding.createdAtUtcMs).toBe(project.createdAtUtcMs);

        // 持久化核验：按端口读回逐字段一致；HEAD 等瞬时事实不持久化。
        expect(await harness.store.getProject(project.id)).toEqual(project);
        expect(await harness.store.getRepositoryBinding(project.id)).toEqual(binding);
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'repository_bindings')).toBe(1);
        expect(head).toMatch(/^[0-9a-f]{40}$/);

        // projectId 不由 displayName 生成：同名另一个仓库得到不同身份。
        const otherRepo = join(root, 'repo-beta');
        initGitRepo(otherRepo);
        writeFileSync(join(otherRepo, 'f.txt'), 'beta\n');
        commitAll(otherRepo, 'initial');
        const second = await harness.service.registerRepository({
          repositoryPath: otherRepo,
          displayName: '我的项目',
          labels: ['core'],
        });
        expect(second.status).toBe('registered');
        expect(second.project.id).not.toBe(project.id);
        expect(second.project.id).toMatch(UUID_PATTERN);
        expect(countRows(harness.session, 'projects')).toBe(2);
        expect(countRows(harness.session, 'repository_bindings')).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('registers a repository without initial commit and with uncommitted changes (read-only facts not persisted)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, 'repo-no-commit');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'untracked.txt'), 'dirty\n');

      const harness = openHarness(dbPath, createClock());
      try {
        const result = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '无初始提交项目',
        });
        expect(result.status).toBe('registered');
        expect(result.binding.canonicalPath).toBe(realpathSync(repoDir));
        // 只读性：无初始 commit 的仓库不被自动 commit；工作文件不变。
        expect(existsSync(join(repoDir, '.git', 'refs', 'heads', 'main'))).toBe(false);
        expect(readFileSync(join(repoDir, 'untracked.txt'), 'utf8')).toBe('dirty\n');
        expect(countRows(harness.session, 'projects')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-005 idempotent reuse by canonical path (duplicates and symlink aliases)', () => {
  it('returns the same project/binding with already_exists for same-path and symlink alias registration, without overwriting metadata', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, 'repo-canonical');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'f.txt'), 'canonical\n');
      commitAll(repoDir, 'initial');
      const aliasPath = join(root, 'repo-alias-link');
      symlinkSync(repoDir, aliasPath, 'dir');

      const harness = openHarness(dbPath, createClock());
      let first: Awaited<ReturnType<ProjectService['registerRepository']>>;
      try {
        first = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '原始名称',
          description: '原始描述',
          labels: ['original'],
        });
        expect(first.status).toBe('registered');

        // 同路径重复注册：already_exists，不新增行，不覆盖名称/描述/标签。
        const duplicate = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '试图覆盖的名称',
          description: '试图覆盖的描述',
          labels: ['overwrite'],
        });
        expect(duplicate.status).toBe('already_exists');
        expect(duplicate.project.id).toBe(first.project.id);
        expect(duplicate.binding.id).toBe(first.binding.id);
        expect(duplicate.project.displayName).toBe('原始名称');
        expect(duplicate.project.description).toBe('原始描述');
        expect(duplicate.project.labels).toEqual(['original']);
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'repository_bindings')).toBe(1);

        // 符号链接别名注册：解析到同一 canonicalPath，同一 projectId/绑定。
        const viaAlias = await harness.service.registerRepository({
          repositoryPath: aliasPath,
          displayName: '别名注册',
        });
        expect(viaAlias.status).toBe('already_exists');
        expect(viaAlias.project.id).toBe(first.project.id);
        expect(viaAlias.binding.id).toBe(first.binding.id);
        expect(viaAlias.binding.canonicalPath).toBe(realpathSync(repoDir));
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'repository_bindings')).toBe(1);
      } finally {
        harness.close();
      }

      // 关闭重开后仍返回同一项目与绑定（逐字段一致）。
      const reopened = openHarness(dbPath, createClock(1_700_700_000_000));
      try {
        expect(await reopened.store.getProject(first.project.id)).toEqual(first.project);
        expect(await reopened.store.getRepositoryBinding(first.project.id)).toEqual(first.binding);
      } finally {
        reopened.close();
      }
    });
  });

  it('reuses a binding written outside the port (bounded reconciliation, no overwrite, no orphan rows)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, 'repo-preseeded');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'f.txt'), 'preseeded\n');
      commitAll(repoDir, 'initial');
      const canonicalPath = realpathSync(repoDir);
      const gitCommonDir = realpathSync(join(repoDir, '.git'));

      const harness = openHarness(dbPath, createClock());
      try {
        // 模拟端口外写入者（如并发进程/修复脚本）直接落库的项目 + 绑定。
        harness.session.transactWrite('test.preseed_binding', (db) => {
          db.prepare(
            'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels, repository_binding_id) ' +
              "VALUES ('p-preseeded', 1000, 1, 1000, '预置项目', 'active', NULL, '[]', NULL)",
          ).run();
          db.prepare(
            'INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity, binding_revision) ' +
              "VALUES ('b-preseeded', 1000, 'p-preseeded', 1, 1000, ?, ?, ?, 1)",
          ).run(canonicalPath, gitCommonDir, deriveRepoIdentity(gitCommonDir));
          db.prepare("UPDATE projects SET repository_binding_id = 'b-preseeded' WHERE id = 'p-preseeded'").run();
        });

        const result = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '重复注册不覆盖',
          labels: ['ignored'],
        });
        expect(result.status).toBe('already_exists');
        expect(result.project.id).toBe('p-preseeded');
        expect(result.project.displayName).toBe('预置项目');
        expect(result.binding.id).toBe('b-preseeded');
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'repository_bindings')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-005 same remote, different clones register separately', () => {
  it('registers two clones of the same origin as distinct projects with distinct canonical paths', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const originDir = join(root, 'origin-repo');
      initGitRepo(originDir);
      writeFileSync(join(originDir, 'f.txt'), 'origin\n');
      commitAll(originDir, 'initial');
      const cloneA = join(root, 'clone-a');
      const cloneB = join(root, 'clone-b');
      git(['clone', originDir, cloneA], root);
      git(['clone', originDir, cloneB], root);

      // remote 相同（同一 origin 路径），但身份与路径必须分离。
      const remoteA = git(['config', '--get', 'remote.origin.url'], cloneA).trim();
      const remoteB = git(['config', '--get', 'remote.origin.url'], cloneB).trim();
      expect(remoteA).toBe(remoteB);

      const harness = openHarness(dbPath, createClock());
      try {
        const resultA = await harness.service.registerRepository({
          repositoryPath: cloneA,
          displayName: '克隆 A',
        });
        const resultB = await harness.service.registerRepository({
          repositoryPath: cloneB,
          displayName: '克隆 B',
        });
        expect(resultA.status).toBe('registered');
        expect(resultB.status).toBe('registered');
        // remote 相同不合并：不同 projectId、不同 canonicalPath、不同本地身份。
        expect(resultA.project.id).not.toBe(resultB.project.id);
        expect(resultA.binding.canonicalPath).toBe(realpathSync(cloneA));
        expect(resultB.binding.canonicalPath).toBe(realpathSync(cloneB));
        expect(resultA.binding.repoIdentity).not.toBe(resultB.binding.repoIdentity);
        // 直接断言数据库行数与返回绑定。
        expect(countRows(harness.session, 'projects')).toBe(2);
        expect(countRows(harness.session, 'repository_bindings')).toBe(2);
        expect(await harness.store.getRepositoryBinding(resultA.project.id)).toEqual(resultA.binding);
        expect(await harness.store.getRepositoryBinding(resultB.project.id)).toEqual(resultB.binding);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-005 cross-process registration race on the same real path', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const CHILD_SCRIPT = join(testDir, 'helpers', 'register-race-child.ts');
  const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

  type ChildResult =
    | {
        readonly outcome: 'registered' | 'already_exists';
        readonly projectId: string;
        readonly bindingId: string;
        readonly canonicalPath: string;
        readonly displayName: string;
        readonly labels: readonly string[];
      }
    | { readonly outcome: 'error'; readonly name: string; readonly message: string };

  type RacerOutcome = {
    readonly marker: string;
    readonly exit: { code: number | null; signal: NodeJS.Signals | null };
    readonly stderr: string;
    readonly result: ChildResult;
  };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  it('lets exactly one of two barrier-synchronized processes register; the other reuses the winner without overwriting', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, 'race-repo');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'f.txt'), 'race\n');
      commitAll(repoDir, 'initial');

      const goFile = join(root, 'race.go');
      const racers = (['A', 'B'] as const).map((marker) => ({
        marker,
        config: {
          dbPath,
          repositoryPath: repoDir,
          displayName: `竞争者-${marker}`,
          labels: [`marker-${marker}`],
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

      let outcomes: RacerOutcome[];
      try {
        // 同步屏障：两个子进程都就绪后才放行，尽量让写事务真实重叠。
        await waitForFiles(racers.map(({ config }) => config.readyFile), 20_000);
        writeFileSync(goFile, 'go');

        outcomes = await Promise.all(
          racers.map(async ({ marker, config }, index) => {
            const exit = await waitForExit(children[index]!.child, 60_000);
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

      // 父进程核验子进程退出：两个进程都正常结束（退出码 0、无信号）。
      for (const outcome of outcomes) {
        expect(outcome.exit.signal, outcome.stderr).toBeNull();
        expect(outcome.exit.code, outcome.stderr).toBe(0);
      }

      const winners = outcomes.filter((outcome) => outcome.result.outcome === 'registered');
      const losers = outcomes.filter((outcome) => outcome.result.outcome === 'already_exists');
      // 恰有一个注册成功、一个复用胜者：证明检查+插入被串行化，无双写。
      expect(winners, JSON.stringify(outcomes.map((o) => o.result))).toHaveLength(1);
      expect(losers, JSON.stringify(outcomes.map((o) => o.result))).toHaveLength(1);
      const winner = winners[0]!;
      const loser = losers[0]!;
      if (winner.result.outcome !== 'registered' || loser.result.outcome !== 'already_exists') {
        throw new Error('unreachable');
      }
      // 同一 projectId/绑定/canonicalPath；败者看到的是胜者元数据（未被覆盖）。
      expect(loser.result.projectId).toBe(winner.result.projectId);
      expect(loser.result.bindingId).toBe(winner.result.bindingId);
      expect(loser.result.canonicalPath).toBe(realpathSync(repoDir));
      expect(loser.result.displayName).toBe(`竞争者-${winner.marker}`);
      expect(loser.result.labels).toEqual([`marker-${winner.marker.toLowerCase()}`]);

      // 关闭重开真实库：最终仅一项目和一有效绑定，元数据为胜者。
      const verify = openHarness(dbPath, createClock(1_700_800_000_000));
      try {
        expect(countRows(verify.session, 'projects')).toBe(1);
        expect(countRows(verify.session, 'repository_bindings')).toBe(1);
        const project = await verify.store.getProject(winner.result.projectId);
        expect(project.displayName).toBe(`竞争者-${winner.marker}`);
        expect(project.labels).toEqual([`marker-${winner.marker.toLowerCase()}`]);
        expect(project.repositoryBindingId).toBe(winner.result.bindingId);
        const binding = await verify.store.getRepositoryBinding(winner.result.projectId);
        expect(binding.id).toBe(winner.result.bindingId);
        expect(binding.canonicalPath).toBe(realpathSync(repoDir));
      } finally {
        verify.close();
      }
    });
  }, 90_000);
});

describe('F-005 atomicity and failure branches produce zero business rows', () => {
  it('rolls back both project and binding when the binding write fails (real temp trigger injection)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const repoDir = join(root, 'repo-rollback');
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'f.txt'), 'rollback\n');
      commitAll(repoDir, 'initial');

      const harness = openHarness(dbPath, createClock());
      try {
        // 通过真实 SQLite 临时触发器在第二步（repository_bindings 插入）注入失败：
        // 此刻第一步（projects 插入）已在同一事务内完成，失败必须整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f005_fail_binding_insert BEFORE INSERT ON repository_bindings ' +
            "BEGIN SELECT RAISE(ABORT, 'f-005 injected binding failure'); END",
        );
        await expect(
          harness.service.registerRepository({
            repositoryPath: repoDir,
            displayName: '触发器注入目标',
          }),
        ).rejects.toThrow(/f-005 injected binding failure/);
        // 绑定写入失败：没有残留项目或绑定（无孤立业务行）。
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'repository_bindings')).toBe(0);

        // 撤除注入后同一操作成功，证明失败只来自注入点而非状态污染。
        harness.session.database.exec('DROP TRIGGER temp.f005_fail_binding_insert');
        const result = await harness.service.registerRepository({
          repositoryPath: repoDir,
          displayName: '触发器注入目标',
        });
        expect(result.status).toBe('registered');
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'repository_bindings')).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid metadata before any inspection or write port call', async () => {
    await withMigratedDb(async (dbPath) => {
      const session = openSqliteStorageSession({ path: dbPath });
      try {
        const store = createSqliteStateStore(session);
        const writeSpy = vi.fn(store.createProjectWithRepositoryBinding);
        const inspectSpy = vi.fn<(path: unknown) => Promise<RepositoryInspection>>();
        const service = createProjectService({
          stateStore: { ...store, createProjectWithRepositoryBinding: writeSpy },
          repositoryInspector: { inspect: inspectSpy },
        });

        // 非法标签：StorageError(validation) 且字段定位到 labels[0]。
        const error = await service
          .registerRepository({
            repositoryPath: '/tmp/whatever',
            displayName: '合法名称',
            labels: ['   '],
          })
          .then(
            () => {
              throw new Error('expected validation error');
            },
            (caught: unknown) => caught,
          );
        expect(isStorageError(error, 'validation')).toBe(true);
        if (isStorageError(error)) {
          expect(error.operation).toBe('ProjectService.registerRepository');
          expect(error.details?.['field']).toBe('labels[0]');
        }
        // 元数据校验先于一切 I/O：检查端口与写入端口都未被调用，零业务行。
        expect(inspectSpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
        expect(countRows(session, 'projects')).toBe(0);
        expect(countRows(session, 'repository_bindings')).toBe(0);

        // 空白名称与未知键同样在任何 I/O 之前拒绝。
        await expect(
          service.registerRepository({ repositoryPath: '/tmp/x', displayName: '  ' }),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        await expect(
          service.registerRepository({
            repositoryPath: '/tmp/x',
            displayName: 'x',
            unexpectedKey: true,
          }),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        await expect(service.registerRepository('not-an-object')).rejects.toSatisfy((caught) =>
          isStorageError(caught, 'validation'),
        );
        expect(inspectSpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
        expect(countRows(session, 'projects')).toBe(0);
      } finally {
        session.close();
      }
    });
  });

  it('propagates inspection errors with zero business rows; the write port is never reached (checks run outside the write transaction)', async () => {
    assertGitAvailable();
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      const writeSpy = vi.fn(harness.store.createProjectWithRepositoryBinding);
      const spiedService = createProjectService({
        stateStore: { ...harness.store, createProjectWithRepositoryBinding: writeSpy },
        repositoryInspector: createRepositoryInspector(),
      });
      try {
        // 不存在路径。
        const missing = await spiedService
          .registerRepository({
            repositoryPath: join(root, 'does-not-exist'),
            displayName: '不存在',
          })
          .then(
            () => {
              throw new Error('expected inspection error');
            },
            (caught: unknown) => caught,
          );
        expect(isRepositoryInspectionError(missing, 'not_found')).toBe(true);

        // 非 Git 目录。
        const plainDir = join(root, 'plain-dir');
        writeFileSync(join(root, 'placeholder.txt'), 'x\n');
        mkdirSync(plainDir);
        const notRepo = await spiedService
          .registerRepository({ repositoryPath: plainDir, displayName: '非仓库' })
          .then(
            () => {
              throw new Error('expected inspection error');
            },
            (caught: unknown) => caught,
          );
        expect(isRepositoryInspectionError(notRepo, 'not_a_repository')).toBe(true);

        // 相对路径（Core 无 cwd 语义）。
        const relative = await spiedService
          .registerRepository({ repositoryPath: 'relative/path', displayName: '相对路径' })
          .then(
            () => {
              throw new Error('expected inspection error');
            },
            (caught: unknown) => caught,
          );
        expect(isRepositoryInspectionError(relative, 'invalid_input')).toBe(true);

        // 检查失败时写入端口未被调用（Git/文件检查在写事务之外），零业务行。
        expect(writeSpy).not.toHaveBeenCalled();
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'repository_bindings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid binding input at the port before any SQL', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const validProject = { displayName: '端口校验目标' };
        const validBinding = {
          canonicalPath: '/tmp/repo',
          gitCommonDir: '/tmp/repo/.git',
          repoIdentity: `${REPO_IDENTITY_PREFIX}${'0'.repeat(64)}`,
        };
        for (const binding of [
          { ...validBinding, canonicalPath: 'relative/path' },
          { ...validBinding, canonicalPath: '/tmp/with\0nul' },
          { ...validBinding, repoIdentity: '  ' },
          { ...validBinding, gitCommonDir: 'relative' },
          { ...validBinding, unknownKey: 1 },
          'not-an-object',
        ]) {
          await expect(
            harness.store.createProjectWithRepositoryBinding(validProject, binding),
          ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        }
        // 非法项目输入同样在任何 SQL 之前拒绝。
        await expect(
          harness.store.createProjectWithRepositoryBinding(
            { displayName: '  ' },
            validBinding,
          ),
        ).rejects.toSatisfy((caught) => isStorageError(caught, 'validation'));
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'repository_bindings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('getRepositoryBinding distinguishes unknown project from project without binding (both not_found)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '无绑定项目' });
        const noBinding = await harness.store.getRepositoryBinding(project.id).then(
          () => {
            throw new Error('expected not_found');
          },
          (caught: unknown) => caught,
        );
        expect(isStorageError(noBinding, 'not_found')).toBe(true);
        if (isStorageError(noBinding)) {
          expect(noBinding.entity).toEqual({ type: 'repository_binding', projectId: project.id });
        }

        const unknown = await harness.store.getRepositoryBinding('p-does-not-exist').then(
          () => {
            throw new Error('expected not_found');
          },
          (caught: unknown) => caught,
        );
        expect(isStorageError(unknown, 'not_found')).toBe(true);
        if (isStorageError(unknown)) {
          expect(unknown.entity).toEqual({ type: 'project', id: 'p-does-not-exist' });
        }

        // 非法 ID 形态为 validation。
        await expect(harness.store.getRepositoryBinding('../escape')).rejects.toSatisfy((caught) =>
          isStorageError(caught, 'validation'),
        );
      } finally {
        harness.close();
      }
    });
  });
});
