/**
 * F-002 P04-8 离线验收共用隔离夹具。
 *
 * 该夹具只组合测试资源：每个实例拥有一个全新的沙箱、隔离 HOME、真实 Git
 * 仓库变体和 SQLite 文件；工具进程使用 P02-3 的确定性 Node 样例。资源清单
 * 只公开沙箱内相对身份，便于报告引用而不会泄露开发仓库或真实 HOME。
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  openSqliteStorageSession,
  type SqliteStorageSession,
} from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineFixture, type BaselineFixture } from '../p02-3/baseline-fixture.ts';
import {
  COMMAND_SAMPLES,
  type CommandSampleKey,
} from '../p02-3/command-samples.ts';
import type { SampleProcess, SampleProcessExit } from '../p02-3/process-tools.ts';
import { safeRemoveTempRoot, type SafeCleanupError } from '../safe-cleanup.ts';

export interface P048FixtureOptions {
  readonly prefix?: string;
  readonly stepMs?: number;
  readonly extraSecrets?: readonly string[];
}

export type P048RepoVariant = 'cloneA' | 'cloneB' | 'withHead' | 'dirty';

export interface P048ResourceManifestEntry {
  readonly id: string;
  readonly kind: 'git' | 'sqlite' | 'project' | 'home' | 'tool';
  readonly relativePath: string;
  readonly owner: 'fixture';
}

export interface P048Scenario {
  readonly id: string;
  readonly repoVariant: P048RepoVariant;
  readonly gitRepositoryPath: string;
  readonly projectDirectory: string;
  readonly sqlitePath: string;
  readonly sqlite: SqliteStorageSession;
  readonly manifest: readonly P048ResourceManifestEntry[];
}

export interface P048CleanupEvidence {
  readonly status: 'passed' | 'failed' | 'unknown';
  readonly checkedResourceIds: readonly string[];
  readonly failureKind?: string;
}

export interface P048Fixture {
  readonly root: string;
  readonly homeDir: string;
  readonly inner: BaselineFixture;
  readonly scenarios: readonly P048Scenario[];
  readonly tools: readonly SampleProcess[];
  readonly cleanupEvidence: P048CleanupEvidence;
  createScenario(id: string, repoVariant?: P048RepoVariant): P048Scenario;
  spawnTool(key: CommandSampleKey, options?: { readonly args?: readonly string[]; readonly cwd?: string }): SampleProcess;
  manifest(): readonly P048ResourceManifestEntry[];
  /** 只允许删除当前夹具授权根内的目录；失败时现场保持不变。 */
  removeOwnedDirectory(target: string): void;
  dispose(): Promise<void>;
}

function relativeResourcePath(root: string, target: string): string {
  const value = relative(root, target).split('\\').join('/');
  return value === '' ? '.' : value;
}

export function createP048Fixture(options: P048FixtureOptions = {}): P048Fixture {
  const inner = createBaselineFixture({
    prefix: options.prefix ?? 'shiploop-p04-8-',
    ...(options.stepMs === undefined ? {} : { stepMs: options.stepMs }),
    ...(options.extraSecrets === undefined ? {} : { extraSecrets: options.extraSecrets }),
  });
  const root = realpathSync(inner.root);
  const homeDir = realpathSync(inner.homeDir);
  const scenarios: P048Scenario[] = [];
  const tools: SampleProcess[] = [];
  const sessions = new Set<SqliteStorageSession>();
  let cleanupState: P048CleanupEvidence = { status: 'passed', checkedResourceIds: [] };
  let disposed = false;

  const createScenario = (id: string, repoVariant: P048RepoVariant = 'cloneA'): P048Scenario => {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      throw new TypeError('P04-8 场景 id 必须是小写字母、数字、下划线或短横线');
    }
    if (scenarios.some((scenario) => scenario.id === id)) {
      throw new Error(`P04-8 场景 id 重复：${id}`);
    }
    const dataRoot = inner.dataRoot(`p04-8-${id}`);
    const sqlitePath = join(dataRoot, 'state.db');
    const sqlite = openSqliteStorageSession({ path: sqlitePath, busyTimeoutMs: 100, busyRetryAttempts: 2 });
    sqlite.transactWrite('fixture.seed', (database) => {
      database.exec('CREATE TABLE IF NOT EXISTS fixture_records (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL)');
      database.prepare('INSERT INTO fixture_records (id, scenario_id) VALUES (?, ?)').run(`${id}-record`, id);
    });
    sessions.add(sqlite);

    const gitRepositoryPath = inner.repos[repoVariant];
    const projectDirectory = join(root, 'projects', id);
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectDirectory, 'scenario.json'), JSON.stringify({ id, repoVariant }), 'utf8');
    const manifest: P048ResourceManifestEntry[] = [
      { id: `${id}:git`, kind: 'git', relativePath: relativeResourcePath(root, gitRepositoryPath), owner: 'fixture' },
      { id: `${id}:project`, kind: 'project', relativePath: relativeResourcePath(root, projectDirectory), owner: 'fixture' },
      { id: `${id}:sqlite`, kind: 'sqlite', relativePath: relativeResourcePath(root, sqlitePath), owner: 'fixture' },
      { id: `${id}:home`, kind: 'home', relativePath: relativeResourcePath(root, homeDir), owner: 'fixture' },
    ];
    const scenario: P048Scenario = Object.freeze({
      id,
      repoVariant,
      gitRepositoryPath,
      projectDirectory,
      sqlitePath,
      sqlite,
      manifest: Object.freeze(manifest),
    });
    scenarios.push(scenario);
    inner.evidence.record('p04_8.scenario.created', {
      scenarioId: id,
      resources: manifest.map(({ id: resourceId, kind, relativePath }) => ({ id: resourceId, kind, relativePath })),
    });
    return scenario;
  };

  const spawnTool = (key: CommandSampleKey, spawnOptions: { readonly args?: readonly string[]; readonly cwd?: string } = {}): SampleProcess => {
    const descriptor = COMMAND_SAMPLES[key];
    const process_ = inner.spawnSample(key, {
      argv: descriptor.argv(spawnOptions.args),
      cwd: spawnOptions.cwd ?? root,
      label: `p04-8-tool-${key}`,
    });
    tools.push(process_);
    inner.evidence.record('p04_8.tool.started', {
      toolId: `tool-${tools.length}`,
      kind: key,
    });
    return process_;
  };

  const manifest = (): readonly P048ResourceManifestEntry[] => Object.freeze([
    { id: 'fixture:home', kind: 'home', relativePath: relativeResourcePath(root, homeDir), owner: 'fixture' },
    ...scenarios.flatMap((scenario) => scenario.manifest),
    ...tools.map((_, index) => ({
      id: `tool-${index + 1}`,
      kind: 'tool' as const,
      relativePath: 'processes/owned',
      owner: 'fixture' as const,
    })),
  ]);

  const removeOwnedDirectory = (target: string): void => {
    try {
      safeRemoveTempRoot(target, { authorizedRoot: root });
      cleanupState = {
        status: 'passed',
        checkedResourceIds: [...cleanupState.checkedResourceIds, 'explicit-directory'],
      };
      inner.evidence.record('p04_8.cleanup.checked', { status: 'passed', resourceId: 'explicit-directory' });
    } catch (error) {
      const kind = (error as Partial<SafeCleanupError>).kind;
      cleanupState = {
        status: kind === 'symlink_escape' || kind === 'not_authorized' ? 'unknown' : 'failed',
        checkedResourceIds: [...cleanupState.checkedResourceIds, 'explicit-directory'],
        ...(typeof kind === 'string' ? { failureKind: kind } : {}),
      };
      inner.evidence.record('p04_8.cleanup.checked', {
        status: cleanupState.status,
        resourceId: 'explicit-directory',
        failureKind: typeof kind === 'string' ? kind : 'unknown',
      });
      throw error;
    }
  };

  return {
    root,
    homeDir,
    inner,
    scenarios,
    tools,
    get cleanupEvidence() { return cleanupState; },
    createScenario,
    spawnTool,
    manifest,
    removeOwnedDirectory,
    async dispose(): Promise<void> {
      if (disposed) return;
      const failures: unknown[] = [];
      for (const session of sessions) {
        try { session.close(); } catch (error) { failures.push(error); }
      }
      try { await inner.dispose(); } catch (error) { failures.push(error); }
      if (failures.length > 0) {
        cleanupState = { status: 'failed', checkedResourceIds: [...cleanupState.checkedResourceIds], failureKind: 'cleanup_failed' };
        throw new AggregateError(failures, 'P04-8 夹具清理失败，现场已保留或存在未确认资源');
      }
      disposed = true;
      cleanupState = {
        status: 'passed',
        checkedResourceIds: [...cleanupState.checkedResourceIds, 'fixture-root'],
      };
    },
  };
}

export type P048ToolExit = SampleProcessExit;
