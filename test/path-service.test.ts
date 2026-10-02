/**
 * P01-3 / F-003 统一 PathService 测试（真实临时文件系统与真实 SQLite，非 mock）。
 *
 * 覆盖（F-003 验收点，全部为真实断言）：
 * - 默认根由稳定 dataNamespace（"shiploop"）与注入的 macOS 用户目录解析；显式根经
 *   校验与 realpath 规范化；StateStore（SQLite）与 ArtifactStore 制品文件共用同一
 *   授权数据根；测试只使用临时 home/dataRoot，实现代码不引用 os.homedir；
 * - 项目目录按稳定 projectId 定位：displayName/description/labels 改变后位置不变；
 *   数据库与项目制品位置与源仓库分离，源仓库内容不被迁移、复制或写入；
 * - 非法 ID、未知资源类型、父目录穿越、目录/文件符号链接逃逸明确拒绝；真实根外
 *   哨兵文件内容不变；校验失败零文件系统副作用；
 * - 受权定位核验项目真实存在（StateStore.getProject）且属于调用绑定的项目范围：
 *   项目 A 范围不能定位项目 B 的资源，未知项目 not_found，未装配核验端口时
 *   fail-closed（不仅凭传入 projectId 授权）；
 * - 关闭重开后 dataRoot/projectDirectory/locate 结果逐字段一致；只支持当前已实现
 *   目录类型（project/artifacts/staging/artifact_content），Run/Session/Worktree
 *   等未知类型一律拒绝。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import {
  DATA_NAMESPACE,
  DATABASE_FILE_NAME,
  isPathResolutionError,
  PROJECT_RESOURCE_TYPES,
  deriveDefaultDataRoot,
  validateProjectResourceRequest,
} from '../packages/core/src/ports/path-service.ts';
import type {
  LocatedPath,
  PathResolutionError,
} from '../packages/core/src/ports/path-service.ts';
import { deriveArtifactFinalRelativePath } from '../packages/core/src/ports/artifact-files.ts';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import type { FsPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import type { TempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolveRepoRoot();
function resolveRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

const SENTINEL_CONTENT = 'SENTINEL-OUTSIDE-DO-NOT-TOUCH';
const PROJECT_A = 'proj-a01';
const PROJECT_B = 'proj-b02';
const ARTIFACT_1 = 'art-0001';

type Fixture = {
  readonly sandbox: TempSandbox;
  readonly sandboxReal: string;
  /** 显式授权数据根（已存在目录）。 */
  readonly dataRoot: string;
  /** 注入用的假用户目录（内含 Library/Application Support/shiploop）。 */
  readonly fakeHome: string;
  readonly defaultRoot: string;
  /** 根外哨兵。 */
  readonly outsideDir: string;
  readonly sentinelFile: string;
  /** 假源仓库（PathService 绝不触碰）。 */
  readonly repoDir: string;
};

function createFixture(): Fixture {
  const sandbox = createTempSandbox('shiploop-f003-paths-');
  const sandboxReal = realpathSync(sandbox.path);
  const dataRoot = join(sandbox.path, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const fakeHome = join(sandbox.path, 'home');
  const defaultRoot = join(fakeHome, 'Library', 'Application Support', DATA_NAMESPACE);
  mkdirSync(defaultRoot, { recursive: true });
  const outsideDir = join(sandbox.path, 'outside');
  mkdirSync(outsideDir, { recursive: true });
  const sentinelFile = join(outsideDir, 'sentinel.txt');
  writeFileSync(sentinelFile, SENTINEL_CONTENT);
  const repoDir = join(sandbox.path, 'repo');
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'README.md'), '# source repo\n');
  writeFileSync(join(repoDir, 'package.json'), '{"name":"source-repo"}\n');
  return { sandbox, sandboxReal, dataRoot, fakeHome, defaultRoot, outsideDir, sentinelFile, repoDir };
}

function readRepoSnapshot(repoDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of readdirSync(repoDir).sort()) {
    snapshot[name] = readFileSync(join(repoDir, name), 'utf-8');
  }
  return snapshot;
}

async function expectPathError(
  kind: PathResolutionError['kind'],
  fn: () => unknown,
): Promise<PathResolutionError> {
  try {
    await fn();
  } catch (error) {
    expect(isPathResolutionError(error, kind), `expected PathResolutionError(${kind}), got ${String(error)}`).toBe(
      true,
    );
    return error as PathResolutionError;
  }
  throw new Error(`expected PathResolutionError(${kind})`);
}

async function expectStorageErr(
  kind: StorageError['kind'],
  fn: () => unknown,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

/** 真实 SQLite + StateStore 装配：数据库文件位于 PathService 推导的同一数据根。 */
async function openStoreAt(paths: FsPathService): Promise<{ session: SqliteStorageSession; store: StateStore }> {
  const session = openSqliteStorageSession({ path: paths.databaseFilePath() });
  await migrateSqliteStorage(session);
  return { session, store: createSqliteStateStore(session) };
}

describe('F-003 PathService 数据根解析', () => {
  it('默认根由稳定 namespace 与注入的 macOS 用户目录解析，不读取真实用户目录', () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ userHomeDir: fixture.fakeHome });
      expect(DATA_NAMESPACE).toBe('shiploop');
      expect(paths.dataRoot()).toBe(realpathSync(fixture.defaultRoot));
      expect(paths.dataRoot().startsWith(fixture.sandboxReal + sep)).toBe(true);
      expect(paths.dataRoot().startsWith(realpathSync(homedir()))).toBe(false);
      expect(basename(paths.databaseFilePath())).toBe(DATABASE_FILE_NAME);
      expect(paths.databaseFilePath()).toBe(join(paths.dataRoot(), DATABASE_FILE_NAME));
      // 适配器实现不引用 os.homedir：默认根只可能来自注入的用户目录。
      const source = readFileSync(
        join(REPO_ROOT, 'packages/core/src/adapters/fs/path-service.ts'),
        'utf-8',
      );
      expect(source).not.toContain('homedir');
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('deriveDefaultDataRoot 是纯推导：相对路径、根目录、NUL 与空输入拒绝（StorageError validation）', async () => {
    for (const bad of ['', 'relative/dir', '/', '///', 'bad\0dir']) {
      await expectStorageErr('validation', () => deriveDefaultDataRoot(bad));
    }
    expect(deriveDefaultDataRoot('/Users/dev')).toBe(
      `/Users/dev/Library/Application Support/${DATA_NAMESPACE}`,
    );
    // 尾部斜杠规范化，结果仍是同一位置。
    expect(deriveDefaultDataRoot('/Users/dev/')).toBe(
      `/Users/dev/Library/Application Support/${DATA_NAMESPACE}`,
    );
  });

  it('默认根不存在时 not_found，且不隐式创建目录', async () => {
    const fixture = createFixture();
    try {
      const emptyHome = join(fixture.sandbox.path, 'empty-home');
      mkdirSync(emptyHome, { recursive: true });
      const error = await expectPathError('not_found', () => createPathService({ userHomeDir: emptyHome }));
      expect(error.message).not.toContain(fixture.sandboxReal);
      const wouldBe = join(emptyHome, 'Library', 'Application Support', DATA_NAMESPACE);
      expect(existsSync(wouldBe)).toBe(false);
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('显式根：相对路径/不存在/普通文件/文件系统根拒绝；符号链接根经 realpath 规范化', async () => {
    const fixture = createFixture();
    try {
      await expectPathError('invalid_input', () => createPathService({ dataRoot: 'relative/root' }));
      await expectPathError('not_found', () =>
        createPathService({ dataRoot: join(fixture.sandbox.path, 'missing') }),
      );
      await expectPathError('invalid_input', () => createPathService({ dataRoot: fixture.sentinelFile }));
      await expectPathError('invalid_input', () => createPathService({ dataRoot: '/' }));
      await expectPathError('invalid_input', () => createPathService({}));
      await expectPathError('invalid_input', () =>
        createPathService({ dataRoot: fixture.dataRoot, userHomeDir: fixture.fakeHome }),
      );
      // 符号链接给出的根是合法的（如 macOS /tmp），构造时 realpath 固定。
      const alias = join(fixture.sandbox.path, 'data-alias');
      symlinkSync(fixture.dataRoot, alias, 'dir');
      const paths = createPathService({ dataRoot: alias });
      expect(paths.dataRoot()).toBe(realpathSync(fixture.dataRoot));
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

describe('F-003 PathService 共享数据根与源仓库分离', () => {
  it('StateStore 数据库与 ArtifactStore 制品共用同一授权数据根；源仓库内容不变', async () => {
    const fixture = createFixture();
    try {
      const repoBefore = readRepoSnapshot(fixture.repoDir);
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '共享根项目', labels: ['Core'] });
        const files = createArtifactFileStore({ dataRoot: paths.dataRoot() });
        const write = await files.openStagingWrite({
          projectId: project.id,
          artifactId: ARTIFACT_1,
          locator: 'notes/说明.txt',
        });
        write.stream.end('hello');
        const staged = await files.finishStaging(write);
        expect(staged.sizeBytes).toBe(5);

        // 数据库与制品都位于同一授权数据根之下。
        expect(existsSync(paths.databaseFilePath())).toBe(true);
        expect(paths.databaseFilePath().startsWith(paths.dataRoot() + sep)).toBe(true);
        const absStaging = join(paths.dataRoot(), ...staged.relativePath.split('/'));
        expect(existsSync(absStaging)).toBe(true);
        expect(absStaging.startsWith(paths.dataRoot() + sep)).toBe(true);
        // 数据根在临时沙箱内：整个测试不访问真实用户目录。
        expect(paths.dataRoot().startsWith(fixture.sandboxReal + sep)).toBe(true);
        // 数据库和项目制品位置与源仓库分离：源仓库内容未被迁移、复制或写入。
        expect(readRepoSnapshot(fixture.repoDir)).toEqual(repoBefore);
        expect(paths.projectDirectory(project.id).startsWith(realpathSync(fixture.repoDir))).toBe(false);
        // 根外哨兵不变。
        expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('项目目录按稳定 projectId 定位：displayName/description/labels 改变后位置不变', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({
          displayName: '原始名称',
          description: '原始描述',
          labels: ['alpha'],
        });
        const before = paths.projectDirectory(project.id);
        expect(before).toBe(join(paths.dataRoot(), 'projects', project.id));
        expect(basename(before)).toBe(project.id);
        // 改名、改描述、改标签不移动项目目录。
        await store.updateProject(project.id, {
          expectedRevision: project.revision,
          displayName: '全新名称',
          description: '全新描述',
          labels: ['beta'],
        });
        expect(paths.projectDirectory(project.id)).toBe(before);
        // 受权定位同样稳定。
        const authed = paths.withProjectLookup(store);
        const located = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'project_directory' },
        );
        expect(located.absolutePath).toBe(before);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('非法 projectId 在派生入口拒绝（StorageError validation），零文件系统副作用', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      for (const bad of ['', 'bad id', '..', 'a/b', '/abs', 'a\\b', 'a\0b']) {
        await expectStorageErr('validation', () => paths.projectDirectory(bad));
      }
      // 校验失败不产生任何目录或文件。
      expect(readdirSync(fixture.dataRoot)).toEqual([]);
      expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

describe('F-003 PathService 受权定位', () => {
  it('已实现资源类型返回范围内位置；artifact_content 与制品文件推导一致', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '受权定位' });
        const authed = paths.withProjectLookup(store);
        const scope = { projectId: project.id };

        const dir = await authed.locateProjectResource(scope, { type: 'project_directory' });
        expect(dir).toMatchObject({
          projectId: project.id,
          resourceType: 'project_directory',
          relativePath: `projects/${project.id}`,
        });
        expect(dir.absolutePath).toBe(join(paths.dataRoot(), 'projects', project.id));

        const artifacts = await authed.locateProjectResource(scope, { type: 'artifacts_directory' });
        expect(artifacts.relativePath).toBe(`projects/${project.id}/artifacts`);

        const staging = await authed.locateProjectResource(scope, { type: 'staging_directory' });
        expect(staging.relativePath).toBe(`staging/${project.id}`);

        const content = await authed.locateProjectResource(scope, {
          type: 'artifact_content',
          artifactId: ARTIFACT_1,
        });
        expect(content.relativePath).toBe(
          deriveArtifactFinalRelativePath({ projectId: project.id, artifactId: ARTIFACT_1 }),
        );
        expect(content.absolutePath).toBe(join(paths.dataRoot(), ...content.relativePath.split('/')));
        expect(content.absolutePath.startsWith(paths.dataRoot() + sep)).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('未知资源类型（Run/Session/Worktree 等）与字段形态错误一律 validation 拒绝', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '类型拒绝' });
        const authed = paths.withProjectLookup(store);
        const scope = { projectId: project.id };
        expect(PROJECT_RESOURCE_TYPES).toEqual([
          'project_directory',
          'artifacts_directory',
          'staging_directory',
          'artifact_content',
        ]);
        for (const type of ['worktree', 'session_directory', 'run_directory', 'documents', '']) {
          await expectStorageErr('validation', () => authed.locateProjectResource(scope, { type }));
        }
        // artifact_content 缺 artifactId / 其他类型携带 artifactId / 非对象输入。
        await expectStorageErr('validation', () =>
          authed.locateProjectResource(scope, { type: 'artifact_content' }),
        );
        await expectStorageErr('validation', () =>
          authed.locateProjectResource(scope, { type: 'project_directory', artifactId: ARTIFACT_1 }),
        );
        await expectStorageErr('validation', () => authed.locateProjectResource(scope, null));
        await expectStorageErr('validation', () =>
          authed.locateProjectResource(scope, { type: 'project_directory', extra: 1 }),
        );
        // 纯校验函数同样拒绝。
        await expectStorageErr('validation', () =>
          validateProjectResourceRequest({ type: 'session_directory' }, 'probe'),
        );
        // 校验失败不产生任何项目/暂存目录（数据库文件除外）。
        expect(existsSync(join(fixture.dataRoot, 'projects'))).toBe(false);
        expect(existsSync(join(fixture.dataRoot, 'staging'))).toBe(false);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('未知项目 not_found；项目 A 范围不能定位项目 B 的资源（ownership）', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const projectA = await store.createProject({ displayName: '项目 A' });
        const projectB = await store.createProject({ displayName: '项目 B' });
        const authed = paths.withProjectLookup(store);

        // 存在性核验针对真实存储：形态合法但未注册的 ID 返回 not_found（不仅凭传入 ID 授权）。
        const unknown = await expectStorageErr('not_found', () =>
          authed.locateProjectResource({ projectId: 'proj-unknown' }, { type: 'project_directory' }),
        );
        expect(unknown.entity).toMatchObject({ type: 'project', id: 'proj-unknown' });

        // 跨项目归属：scope 绑定 A，资源声明属于 B（B 真实存在）→ ownership。
        const cross = await expectStorageErr('ownership', () =>
          authed.locateProjectResource(
            { projectId: projectA.id },
            { type: 'artifact_content', projectId: projectB.id, artifactId: ARTIFACT_1 },
          ),
        );
        expect(cross.entity).toMatchObject({ type: 'project', id: projectA.id });

        // 资源 projectId 与 scope 一致时合法（显式声明不破坏授权）。
        const ok = await authed.locateProjectResource(
          { projectId: projectA.id },
          { type: 'artifacts_directory', projectId: projectA.id },
        );
        expect(ok.projectId).toBe(projectA.id);

        // scope 形态校验。
        await expectStorageErr('validation', () =>
          authed.locateProjectResource({ projectId: 'bad id' }, { type: 'project_directory' }),
        );
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('未装配项目存在性核验端口时受权定位 fail-closed（invalid_input）', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '无核验端口' });
        // paths 未装配 lookup：即使项目真实存在也拒绝授权定位。
        const error = await expectPathError('invalid_input', () =>
          paths.locateProjectResource({ projectId: project.id }, { type: 'project_directory' }),
        );
        expect(error.details).toMatchObject({ reason: 'project_lookup_not_configured' });
        // 非法 lookup 形态在装配期拒绝。
        await expectPathError('invalid_input', () =>
          paths.withProjectLookup({} as never),
        );
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('目录祖先符号链接逃逸与文件叶符号链接逃逸拒绝；根外哨兵不变', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '逃逸核对' });
        const authed = paths.withProjectLookup(store);

        // 目录祖先逃逸：projects/<pid> 是指向根外的符号链接。
        mkdirSync(join(fixture.dataRoot, 'projects'), { recursive: true });
        symlinkSync(fixture.outsideDir, join(fixture.dataRoot, 'projects', project.id), 'dir');
        const dirEscape = await expectPathError('escape', () =>
          authed.locateProjectResource({ projectId: project.id }, { type: 'artifact_content', artifactId: ARTIFACT_1 }),
        );
        expect(dirEscape.message).not.toContain(fixture.sandboxReal);
        expect(dirEscape.details?.['relativePath']).toBe(
          deriveArtifactFinalRelativePath({ projectId: project.id, artifactId: ARTIFACT_1 }),
        );

        // 文件叶逃逸：真实目录内 content 是指向哨兵的符号链接。
        const leafDir = join(fixture.dataRoot, 'projects', PROJECT_A, 'artifacts', ARTIFACT_1);
        mkdirSync(join(fixture.dataRoot, 'projects', PROJECT_A), { recursive: true });
        mkdirSync(leafDir, { recursive: true });
        symlinkSync(fixture.sentinelFile, join(leafDir, 'content'));
        // PROJECT_A 未注册：先验证 not_found 优先（存在性核验在文件检查之前）。
        await expectStorageErr('not_found', () =>
          authed.locateProjectResource({ projectId: PROJECT_A }, { type: 'artifact_content', artifactId: ARTIFACT_1 }),
        );
        const registeredA = await store.createProject({ displayName: 'A' });
        const leafDirA = join(fixture.dataRoot, 'projects', registeredA.id, 'artifacts', ARTIFACT_1);
        mkdirSync(leafDirA, { recursive: true });
        symlinkSync(fixture.sentinelFile, join(leafDirA, 'content'));
        await expectPathError('escape', () =>
          authed.locateProjectResource(
            { projectId: registeredA.id },
            { type: 'artifact_content', artifactId: ARTIFACT_1 },
          ),
        );

        // 哨兵与根外目录内容不变，不跟随逃逸链接。
        expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
        expect(lstatSync(fixture.sentinelFile).isFile()).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('关闭重开后 dataRoot/projectDirectory/locate 结果逐字段一致', async () => {
    const fixture = createFixture();
    try {
      const paths1 = createPathService({ dataRoot: fixture.dataRoot });
      const opened1 = await openStoreAt(paths1);
      const project = await opened1.store.createProject({ displayName: '重开稳定', labels: ['x'] });
      const authed1 = paths1.withProjectLookup(opened1.store);
      const located1 = await authed1.locateProjectResource(
        { projectId: project.id },
        { type: 'artifact_content', artifactId: ARTIFACT_1 },
      );
      const dirBefore = paths1.projectDirectory(project.id);
      opened1.session.close();

      // 重开：新 PathService 实例 + 新会话（同一数据根），迁移幂等。
      const paths2 = createPathService({ dataRoot: fixture.dataRoot });
      const opened2 = await openStoreAt(paths2);
      try {
        expect(paths2.dataRoot()).toBe(paths1.dataRoot());
        expect(paths2.databaseFilePath()).toBe(paths1.databaseFilePath());
        expect(paths2.projectDirectory(project.id)).toBe(dirBefore);
        const persisted = await opened2.store.getProject(project.id);
        expect(persisted.displayName).toBe('重开稳定');
        expect(persisted.labels).toEqual(['x']);
        const authed2 = paths2.withProjectLookup(opened2.store);
        const located2: LocatedPath = await authed2.locateProjectResource(
          { projectId: project.id },
          { type: 'artifact_content', artifactId: ARTIFACT_1 },
        );
        expect(located2).toEqual(located1);
      } finally {
        opened2.session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});
