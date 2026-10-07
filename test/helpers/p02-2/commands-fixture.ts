/**
 * F-004 P02-2 命令/事件测试组合夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 组合既有积木（不重写资源管理）：
 * - helpers/temp-sandbox：系统临时目录全新沙箱，拒绝落在受测仓库/HOME 内；
 * - helpers/git-repo：真实 Git 仓库 A/B（Unicode/空格路径、一次性注入身份、
 *   GIT_CONFIG_GLOBAL=/dev/null），git 缺失显式失败不 skip；
 * - helpers/safe-cleanup：cleanup 只删本次持有的临时根，符号链接逃逸 fail-closed；
 * - helpers/host/evidence：脱敏证据日志（受测仓库/真实 HOME 自动登记为受保护串）；
 * - 公开 Core 装配 openCoreApplication：真实临时 SQLite + 版本化迁移；
 * - openTransactionalHarness：同一 dbPath 上的真实适配器会话（迁移 + StateStore +
 *   P01 应用服务），TEMP TRIGGER 故障注入必须安装在该连接上（F-007 注入面）；
 * - openStorageProbe：另一条只读连接从事务外部核对真实行/revision/事件计数。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openSqliteConnection } from '../../../packages/core/src/adapters/sqlite/connection.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import type { ConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createProjectService } from '../../../packages/core/src/application/project-service.ts';
import type { ProjectService } from '../../../packages/core/src/application/project-service.ts';
import { DATABASE_FILE_NAME } from '../../../packages/core/src/ports/path-service.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { StateStore } from '../../../packages/core/src/ports/state-store.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from '../git-repo.ts';
import { createEvidenceLog, type EvidenceLog } from '../host/evidence.ts';
import { safeRemoveTempRoot } from '../safe-cleanup.ts';
import { createTempSandbox } from '../temp-sandbox.ts';
import { installWriteFault, type InstalledWriteFault, type WriteFaultPoint } from './fault-injection.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  scopeAllowlist,
  type CreateRestrictedPrincipalOptions,
  type TestPrincipalScope,
  type TestTrustedPrincipal,
} from './principals.ts';
import { openStorageProbe, type StorageProbe } from './storage-probe.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const REPO_A = {
  directoryName: '仓库 A 🚢',
  files: {
    'README.md': '# 项目 A\n\nF-004 真实 Git 仓库 A。\n',
    'src/a.ts': 'export const project = "A";\n',
  } as const,
  commitMessage: 'F-004 fixture project A initial commit',
};

const REPO_B = {
  directoryName: '仓库 B',
  files: {
    'README.md': '# 项目 B\n\nF-004 真实 Git 仓库 B。\n',
    'src/b.ts': 'export const project = "B";\n',
  } as const,
  commitMessage: 'F-004 fixture project B initial commit',
};

export interface CommandsTransactionalHarness {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  readonly projectService: ProjectService;
  readonly configurationService: ConfigurationService;
  /** 在本连接安装 TEMP 故障触发器（连接关闭即消亡）。 */
  installFault(target: WriteFaultPoint, message?: string): InstalledWriteFault;
  close(): void;
}

export interface CommandsTestFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly repoDirA: string;
  readonly repoDirB: string;
  readonly tools: { readonly gitVersion: string; readonly sqliteVersion: string };
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly evidence: EvidenceLog;
  /** 经公开 Core 装配入口打开同一数据根（确定性时钟），受管关闭。 */
  openApplication(overrides?: Record<string, unknown>): Promise<CoreApplication>;
  /** 在同一 dbPath 打开真实适配器会话 + P01 服务（故障注入连接），受管关闭。 */
  openTransactionalHarness(
    options?: { readonly busyTimeoutMs?: number; readonly busyRetryAttempts?: number },
  ): Promise<CommandsTransactionalHarness>;
  /** 另开一条只读探针连接，受管关闭。 */
  openProbe(): StorageProbe;
  localOwner(): TestTrustedPrincipal;
  restrictedPrincipal(options: CreateRestrictedPrincipalOptions): TestTrustedPrincipal;
  scopeAllowlist(projectIds: readonly string[]): TestPrincipalScope;
  gitHead(which: 'A' | 'B'): string;
  cleanup(): void;
  readonly cleaned: boolean;
}

export interface CommandsTestFixtureOptions {
  readonly prefix?: string;
  readonly outside?: readonly string[];
}

export function createCommandsTestFixture(
  options: CommandsTestFixtureOptions = {},
): CommandsTestFixture {
  const protectedPaths = [REPO_ROOT, homedir(), ...(options.outside ?? [])];
  const sandbox = createTempSandbox(options.prefix ?? 'shiploop-p02-2-', {
    outside: protectedPaths,
  });
  const root = realpathSync(sandbox.path);
  const homeDir = join(root, 'home');
  const dataRoot = join(root, 'data-root');
  const repoDirA = join(root, REPO_A.directoryName);
  const repoDirB = join(root, REPO_B.directoryName);
  const dbPath = join(dataRoot, DATABASE_FILE_NAME);

  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  const realHome = realpathSync(homedir());
  const evidence = createEvidenceLog({ protectedStrings: [REPO_ROOT, realHome] });

  const apps = new Set<CoreApplication>();
  const harnesses = new Set<CommandsTransactionalHarness>();
  const probes = new Set<StorageProbe>();
  let cleaned = false;

  // 确定性单调时钟（同夹具所有装配共享，毫秒级递增）。
  let clockValue = 1_900_000_000_000;
  const nowUtcMs = (): number => {
    clockValue += 1;
    return clockValue;
  };

  const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }],
    },
  ]);
  let fixturesGit: { gitVersion: string; sqliteVersion: string };

  try {
    const gitVersion = assertGitAvailable();
    const probePath = join(root, 'sqlite-version-probe.sqlite');
    const probeConnection = openSqliteConnection(probePath);
    let sqliteVersion: string;
    try {
      const row = probeConnection.database
        .prepare<[], { version: string }>('SELECT sqlite_version() AS version')
        .get();
      sqliteVersion = String(row?.version ?? '');
    } finally {
      probeConnection.close();
    }
    rmSync(probePath, { force: true });
    if (!/^\d+\.\d+\.\d+$/.test(sqliteVersion)) {
      throw new Error(`SQLite 探测返回非法版本：${sqliteVersion}`);
    }
    fixturesGit = { gitVersion, sqliteVersion };

    const gitOptions = { home: homeDir } as const;
    initGitRepo(repoDirA);
    for (const [relativePath, content] of Object.entries(REPO_A.files)) {
      const absolute = join(repoDirA, ...relativePath.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf-8');
    }
    commitAll(repoDirA, REPO_A.commitMessage, gitOptions);

    initGitRepo(repoDirB);
    for (const [relativePath, content] of Object.entries(REPO_B.files)) {
      const absolute = join(repoDirB, ...relativePath.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf-8');
    }
    commitAll(repoDirB, REPO_B.commitMessage, gitOptions);
  } catch (error) {
    cleanupResources();
    try {
      safeRemoveTempRoot(root, { authorizedRoot: realpathSync(tmpdir()), protectedPaths });
    } catch {
      // 准备失败尽力收尾。
    }
    throw error;
  }

  function cleanupResources(): void {
    for (const harness of harnesses) {
      try {
        harness.close();
      } catch {
        // 继续回收其余资源。
      }
    }
    harnesses.clear();
    for (const app of apps) {
      try {
        app.close();
      } catch {
        // 继续回收其余资源。
      }
    }
    apps.clear();
    for (const probe of probes) {
      try {
        probe.close();
      } catch {
        // 继续回收其余资源。
      }
    }
    probes.clear();
  }

  return {
    root,
    homeDir,
    dataRoot,
    dbPath,
    repoDirA,
    repoDirB,
    get tools() {
      return fixturesGit;
    },
    capabilityCatalog,
    evidence,

    async openApplication(overrides: Record<string, unknown> = {}): Promise<CoreApplication> {
      const app = await openCoreApplication({
        dataRoot,
        capabilityCatalog,
        nowUtcMs,
        ...overrides,
      });
      apps.add(app);
      return app;
    },

    async openTransactionalHarness(
      sessionOptions: { readonly busyTimeoutMs?: number; readonly busyRetryAttempts?: number } = {},
    ): Promise<CommandsTransactionalHarness> {
      const session = openSqliteStorageSession({ path: dbPath, ...sessionOptions });
      try {
        await migrateSqliteStorage(session);
      } catch (error) {
        session.close();
        throw error;
      }
      const store = createSqliteStateStore(session, { nowUtcMs });
      const projectService = createProjectService({
        stateStore: store,
        repositoryInspector: createRepositoryInspector(),
      });
      const configurationService = createConfigurationService({
        stateStore: store,
        capabilityCatalog,
      });
      const harness: CommandsTransactionalHarness = {
        session,
        store,
        projectService,
        configurationService,
        installFault(target: WriteFaultPoint, message?: string): InstalledWriteFault {
          return installWriteFault(session.database, { target, ...(message ? { message } : {}) });
        },
        close(): void {
          harnesses.delete(harness);
          session.close();
        },
      };
      harnesses.add(harness);
      return harness;
    },

    openProbe(): StorageProbe {
      const probe = openStorageProbe(dbPath);
      probes.add(probe);
      const originalClose = probe.close.bind(probe);
      return {
        ...probe,
        close(): void {
          probes.delete(probe);
          originalClose();
        },
      };
    },

    localOwner(): TestTrustedPrincipal {
      return createLocalOwnerPrincipal();
    },

    restrictedPrincipal(restrictedOptions: CreateRestrictedPrincipalOptions): TestTrustedPrincipal {
      return createRestrictedPrincipal(restrictedOptions);
    },

    scopeAllowlist(projectIds: readonly string[]): TestPrincipalScope {
      return scopeAllowlist(projectIds);
    },

    gitHead(which: 'A' | 'B'): string {
      return git(['rev-parse', 'HEAD'], which === 'A' ? repoDirA : repoDirB, {
        home: homeDir,
      }).trim();
    },

    cleanup(): void {
      if (cleaned) {
        return;
      }
      cleanupResources();
      safeRemoveTempRoot(root, { authorizedRoot: realpathSync(tmpdir()), protectedPaths });
      cleaned = true;
    },

    get cleaned(): boolean {
      return cleaned;
    },
  };
}
