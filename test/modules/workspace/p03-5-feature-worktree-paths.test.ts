/**
 * P03-5 / F-001 PathService Feature 受控 worktree 路径定位测试（真实临时文件系统
 * 与真实 SQLite，非 mock）。
 *
 * 覆盖（F-001 验收点，全部为真实断言）：
 * - 路径仅由「已授权稳定数据根 + projectId + featureId」推导为项目隔离目录
 *   （projects/<projectId>/worktrees/<featureId>）；Feature 标题/描述/标签变化
 *   不改变路径；不引入第二套数据根（数据库与 worktree 同根）；错误不携带开发机
 *   绝对路径；
 * - 定位同时核验项目真实存在、Feature 同项目归属与稳定 ID：未知项目/未知 Feature
 *   not_found，跨项目 Feature ownership，目录穿越/NUL/绝对路径注入在任何文件
 *   副作用之前 validation 拒绝；
 * - 真实临时文件系统验证叶节点符号链接、悬空链接与祖先 realpath 越界一律 escape
 *   拒绝；合法 macOS 临时根别名（符号链接给出的根）可规范化；
 * - 定位不创建 worktree、不修改源仓库；既有 Artifact 定位行为不变。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import type { StorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  deriveFeatureWorktreeRelativeDir,
  isPathResolutionError,
} from '../../../packages/core/src/ports/path-service.ts';
import type { PathResolutionError } from '../../../packages/core/src/ports/path-service.ts';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import type { FsPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import type { StateStore } from '../../../packages/core/src/ports/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import type { SqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import type { TempSandbox } from '../../helpers/temp-sandbox.ts';

const SENTINEL_CONTENT = 'SENTINEL-OUTSIDE-DO-NOT-TOUCH';
const FEATURE_A = 'feat-a01';
const FEATURE_B = 'feat-b02';

type Fixture = {
  readonly sandbox: TempSandbox;
  readonly sandboxReal: string;
  readonly dataRoot: string;
  readonly outsideDir: string;
  readonly sentinelFile: string;
  readonly repoDir: string;
};

function createFixture(): Fixture {
  const sandbox = createTempSandbox('shiploop-f001-worktree-paths-');
  const sandboxReal = realpathSync(sandbox.path);
  const dataRoot = join(sandbox.path, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const outsideDir = join(sandbox.path, 'outside');
  mkdirSync(outsideDir, { recursive: true });
  const sentinelFile = join(outsideDir, 'sentinel.txt');
  writeFileSync(sentinelFile, SENTINEL_CONTENT);
  const repoDir = join(sandbox.path, 'repo');
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'README.md'), '# source repo\n');
  return { sandbox, sandboxReal, dataRoot, outsideDir, sentinelFile, repoDir };
}

function readRepoSnapshot(repoDir: string): Record<string, string> {
  return { 'README.md': readFileSync(join(repoDir, 'README.md'), 'utf-8') };
}

async function openStoreAt(
  paths: FsPathService,
): Promise<{ session: SqliteStorageSession; store: StateStore; queryStore: SqliteQueryStore }> {
  const session = openSqliteStorageSession({ path: paths.databaseFilePath() });
  await migrateSqliteStorage(session);
  return {
    session,
    store: createSqliteStateStore(session),
    queryStore: createSqliteQueryStore(session),
  };
}

/** 受信夹具：以真实 SQLite 行播种 Phase + Feature（后续任务由命令面创建）。 */
function seedFeature(
  session: SqliteStorageSession,
  projectId: string,
  featureId: string,
  fields: { title?: string; description?: string | null; labels?: readonly string[] } = {},
): void {
  const db = session.database;
  const now = 1_900_000_100_000;
  db.prepare(
    'INSERT INTO phases (id, created_at, updated_at, project_id, revision, title, status, description, labels) ' +
      "VALUES (?, ?, ?, ?, 1, ?, 'open', NULL, '[]')",
  ).run(`${featureId}-phase`, now, now, projectId, `${featureId} 阶段`);
  db.prepare(
    'INSERT INTO features (id, created_at, updated_at, project_id, revision, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) ' +
      "VALUES (?, ?, ?, ?, 1, ?, ?, 'draft', 'draft', ?, ?, '[]', NULL)",
  ).run(
    featureId,
    now,
    now,
    projectId,
    `${featureId}-phase`,
    fields.title ?? `${featureId} 标题`,
    fields.description === undefined ? '原始描述' : fields.description,
    JSON.stringify(fields.labels ?? ['alpha']),
  );
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

describe('P03-5 / F-001 Feature worktree 路径推导', () => {
  it('路径仅由稳定数据根、projectId、featureId 推导；标题/描述/标签变化不改变路径', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: 'Worktree 项目', labels: ['x'] });
        seedFeature(session, project.id, FEATURE_A);
        seedFeature(session, project.id, FEATURE_B);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);

        const located = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_A },
        );
        expect(deriveFeatureWorktreeRelativeDir(project.id, FEATURE_A)).toBe(
          `projects/${project.id}/worktrees/${FEATURE_A}`,
        );
        expect(located).toMatchObject({
          projectId: project.id,
          resourceType: 'feature_worktree_directory',
          relativePath: `projects/${project.id}/worktrees/${FEATURE_A}`,
        });
        expect(located.absolutePath).toBe(
          join(paths.dataRoot(), 'projects', project.id, 'worktrees', FEATURE_A),
        );

        // 标题/描述/标签变化不改变路径（路径不含不可信展示字段）。
        session.database
          .prepare('UPDATE features SET title = ?, description = ?, labels = ? WHERE id = ?')
          .run('全新标题', '全新描述', JSON.stringify(['beta', 'gamma']), FEATURE_A);
        const again = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_A },
        );
        expect(again.absolutePath).toBe(located.absolutePath);

        // 不同 Feature 不同目录；不引入第二套数据根（与数据库同根）。
        const other = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_B },
        );
        expect(other.absolutePath).not.toBe(located.absolutePath);
        expect(located.absolutePath.startsWith(paths.dataRoot() + sep)).toBe(true);
        expect(paths.databaseFilePath().startsWith(paths.dataRoot() + sep)).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('定位不创建 worktree、不修改源仓库', async () => {
    const fixture = createFixture();
    try {
      const repoBefore = readRepoSnapshot(fixture.repoDir);
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '零副作用' });
        seedFeature(session, project.id, FEATURE_A);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);
        const located = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_A },
        );
        // 定位 ≠ 创建：worktree 目录与其父目录均不出现。
        expect(existsSync(located.absolutePath)).toBe(false);
        expect(existsSync(join(paths.dataRoot(), 'projects', project.id, 'worktrees'))).toBe(false);
        // 源仓库字节不变。
        expect(readRepoSnapshot(fixture.repoDir)).toEqual(repoBefore);
        expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

describe('P03-5 / F-001 项目归属与路径负例', () => {
  it('未知项目/未知 Feature not_found，跨项目 Feature ownership，均在文件副作用前拒绝', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const projectA = await store.createProject({ displayName: '项目 A' });
        const projectB = await store.createProject({ displayName: '项目 B' });
        seedFeature(session, projectB.id, FEATURE_B);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);

        // 未知项目 not_found（先于 Feature 核验）。
        const unknownProject = await expectStorageErr('not_found', () =>
          authed.locateProjectResource(
            { projectId: 'proj-unknown' },
            { type: 'feature_worktree_directory', featureId: FEATURE_B },
          ),
        );
        expect(unknownProject.entity).toMatchObject({ type: 'project', id: 'proj-unknown' });

        // 未知 Feature not_found（项目真实存在）。
        const unknownFeature = await expectStorageErr('not_found', () =>
          authed.locateProjectResource(
            { projectId: projectA.id },
            { type: 'feature_worktree_directory', featureId: 'feat-unknown' },
          ),
        );
        expect(unknownFeature.entity).toMatchObject({ type: 'feature', id: 'feat-unknown' });

        // 跨项目 Feature：scope 绑定 A，Feature 归属 B → ownership。
        const cross = await expectStorageErr('ownership', () =>
          authed.locateProjectResource(
            { projectId: projectA.id },
            { type: 'feature_worktree_directory', featureId: FEATURE_B },
          ),
        );
        expect(cross.entity).toMatchObject({ type: 'project', id: projectA.id });

        // 非法 featureId（穿越/NUL/绝对路径/空/带分隔符）validation 拒绝。
        for (const featureId of ['', '..', 'a/b', '/abs', 'a\\b', 'a\0b', 'bad id', '.hidden']) {
          await expectStorageErr('validation', () =>
            authed.locateProjectResource(
              { projectId: projectA.id },
              { type: 'feature_worktree_directory', featureId },
            ),
          );
        }
        // 形态错误：缺 featureId / 携带 artifactId / 非对象。
        await expectStorageErr('validation', () =>
          authed.locateProjectResource({ projectId: projectA.id }, { type: 'feature_worktree_directory' }),
        );
        await expectStorageErr('validation', () =>
          authed.locateProjectResource(
            { projectId: projectA.id },
            { type: 'feature_worktree_directory', featureId: FEATURE_B, artifactId: 'art-1' },
          ),
        );
        await expectStorageErr('validation', () =>
          authed.locateProjectResource({ projectId: projectA.id }, null),
        );

        // 全部负例零文件副作用：worktree/project 目录均未创建。
        expect(existsSync(join(fixture.dataRoot, 'projects'))).toBe(false);
        expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('错误消息与 details 不携带开发机绝对路径', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '脱敏' });
        seedFeature(session, project.id, FEATURE_A);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);
        const errors: Error[] = [];
        errors.push(
          await expectStorageErr('validation', () =>
            authed.locateProjectResource(
              { projectId: project.id },
              { type: 'feature_worktree_directory', featureId: '/abs' },
            ),
          ),
        );
        errors.push(
          await expectStorageErr('not_found', () =>
            authed.locateProjectResource(
              { projectId: project.id },
              { type: 'feature_worktree_directory', featureId: 'feat-unknown' },
            ),
          ),
        );
        // 目标叶是符号链接时的运行期错误同样脱敏。
        mkdirSync(join(fixture.dataRoot, 'projects', project.id, 'worktrees'), { recursive: true });
        symlinkSync(
          fixture.sentinelFile,
          join(fixture.dataRoot, 'projects', project.id, 'worktrees', FEATURE_A),
        );
        errors.push(
          await expectPathError('escape', () =>
            authed.locateProjectResource(
              { projectId: project.id },
              { type: 'feature_worktree_directory', featureId: FEATURE_A },
            ),
          ),
        );
        for (const error of errors) {
          expect(error.message).not.toContain(fixture.sandboxReal);
          const details = JSON.stringify((error as { details?: unknown }).details ?? {});
          expect(details).not.toContain(fixture.sandboxReal);
        }
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

describe('P03-5 / F-001 真实文件系统符号链接防线', () => {
  it('叶节点符号链接、悬空链接与祖先 realpath 越界一律 escape 拒绝；根外哨兵不变', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '链接防线' });
        seedFeature(session, project.id, FEATURE_A);
        seedFeature(session, project.id, FEATURE_B);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);
        const locateA = () =>
          authed.locateProjectResource(
            { projectId: project.id },
            { type: 'feature_worktree_directory', featureId: FEATURE_A },
          );
        const locateB = () =>
          authed.locateProjectResource(
            { projectId: project.id },
            { type: 'feature_worktree_directory', featureId: FEATURE_B },
          );

        // 1) 叶节点是指向根外哨兵的符号链接 → escape（不跟随）。
        const worktrees = join(fixture.dataRoot, 'projects', project.id, 'worktrees');
        mkdirSync(worktrees, { recursive: true });
        symlinkSync(fixture.sentinelFile, join(worktrees, FEATURE_A));
        const leaf = await expectPathError('escape', locateA);
        expect(leaf.details?.['relativePath']).toBe(`projects/${project.id}/worktrees/${FEATURE_A}`);
        rmSafe(join(worktrees, FEATURE_A));

        // 2) 叶节点悬空符号链接 → escape。
        symlinkSync(join(fixture.outsideDir, 'missing-target'), join(worktrees, FEATURE_A));
        await expectPathError('escape', locateA);
        rmSafe(join(worktrees, FEATURE_A));

        // 3) 祖先目录是指向根外的符号链接 → escape（祖先 realpath 越界）。
        const escapeDir = join(fixture.dataRoot, 'projects', project.id, 'worktrees');
        rmSafe(escapeDir);
        symlinkSync(fixture.outsideDir, escapeDir, 'dir');
        await expectPathError('escape', locateA);
        rmSafe(escapeDir);

        // 4) 祖先是悬空符号链接 → escape。
        symlinkSync(join(fixture.outsideDir, 'missing-dir'), escapeDir, 'dir');
        await expectPathError('escape', locateA);
        rmSafe(escapeDir);

        // 5) Feature B 未受链接污染仍可定位；哨兵与根外目录内容不变。
        const okB = await locateB();
        expect(okB.relativePath).toBe(`projects/${project.id}/worktrees/${FEATURE_B}`);
        expect(readFileSync(fixture.sentinelFile, 'utf-8')).toBe(SENTINEL_CONTENT);
        expect(lstatSync(fixture.sentinelFile).isFile()).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('合法 macOS 临时根别名可规范化；定位结果始终位于已 realpath 的授权根内', async () => {
    const fixture = createFixture();
    try {
      // macOS 临时目录常见别名形态：经符号链接给出的合法根（如 /tmp → /private/tmp）。
      const alias = join(fixture.sandbox.path, 'data-alias');
      symlinkSync(fixture.dataRoot, alias, 'dir');
      const paths = createPathService({ dataRoot: alias });
      expect(paths.dataRoot()).toBe(realpathSync(fixture.dataRoot));
      // 沙箱自身可能位于 macOS /var/... 别名之下：realpath 规范化后仍在授权根内。
      expect(paths.dataRoot().startsWith(fixture.sandboxReal + sep)).toBe(true);
      expect(paths.dataRoot()).not.toBe(alias);

      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '别名根' });
        seedFeature(session, project.id, FEATURE_A);
        const authed = paths.withProjectLookup(store).withFeatureLookup(queryStore);
        const located = await authed.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_A },
        );
        expect(located.absolutePath).toBe(
          join(realpathSync(fixture.dataRoot), 'projects', project.id, 'worktrees', FEATURE_A),
        );
        expect(located.absolutePath.startsWith(paths.dataRoot() + sep)).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

describe('P03-5 / F-001 核验端口装配与既有定位行为', () => {
  it('未装配 Feature 归属核验端口时 fail-closed；非法端口形态在装配期拒绝', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '无核验端口' });
        seedFeature(session, project.id, FEATURE_A);
        // 项目核验端口已装配、Feature 核验端口缺失：fail-closed。
        const authed = paths.withProjectLookup(store);
        const error = await expectPathError('invalid_input', () =>
          authed.locateProjectResource(
            { projectId: project.id },
            { type: 'feature_worktree_directory', featureId: FEATURE_A },
          ),
        );
        expect(error.details).toMatchObject({ reason: 'feature_lookup_not_configured' });
        // 非法 Feature 核验端口形态在装配期拒绝。
        await expectPathError('invalid_input', () =>
          paths.withFeatureLookup({} as never),
        );
        // 装配真实核验端口后定位成功（fail-closed 可被正确装配解除）。
        const wired = authed.withFeatureLookup(queryStore);
        const located = await wired.locateProjectResource(
          { projectId: project.id },
          { type: 'feature_worktree_directory', featureId: FEATURE_A },
        );
        expect(located.relativePath).toBe(`projects/${project.id}/worktrees/${FEATURE_A}`);
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });

  it('既有 Artifact/项目定位行为不变：不要求 Feature 核验端口，推导逐字段一致', async () => {
    const fixture = createFixture();
    try {
      const paths = createPathService({ dataRoot: fixture.dataRoot });
      const { session, store, queryStore } = await openStoreAt(paths);
      try {
        const project = await store.createProject({ displayName: '既有行为' });
        const authed = paths.withProjectLookup(store);
        const scope = { projectId: project.id };

        // 未装配 Feature 核验端口时，既有类型定位不受影响。
        const dir = await authed.locateProjectResource(scope, { type: 'project_directory' });
        expect(dir.relativePath).toBe(`projects/${project.id}`);
        const artifacts = await authed.locateProjectResource(scope, { type: 'artifacts_directory' });
        expect(artifacts.relativePath).toBe(`projects/${project.id}/artifacts`);
        const staging = await authed.locateProjectResource(scope, { type: 'staging_directory' });
        expect(staging.relativePath).toBe(`staging/${project.id}`);
        const content = await authed.locateProjectResource(scope, {
          type: 'artifact_content',
          artifactId: 'art-0001',
        });
        expect(content.relativePath).toBe(`projects/${project.id}/artifacts/art-0001/content`);
        expect(content.resourceType).toBe('artifact_content');

        // 装配 Feature 核验端口后既有定位逐字段一致。
        const wired = authed.withFeatureLookup(queryStore);
        const contentAgain = await wired.locateProjectResource(scope, {
          type: 'artifact_content',
          artifactId: 'art-0001',
        });
        expect(contentAgain).toEqual(content);

        // 既有类型不接受 featureId（严格形态）。
        await expectStorageErr('validation', () =>
          wired.locateProjectResource(scope, {
            type: 'artifact_content',
            artifactId: 'art-0001',
            featureId: FEATURE_A,
          }),
        );
        await expectStorageErr('validation', () =>
          wired.locateProjectResource(scope, { type: 'project_directory', featureId: FEATURE_A }),
        );
      } finally {
        session.close();
      }
    } finally {
      fixture.sandbox.cleanup();
    }
  });
});

/** 移除测试自建符号链接/目录（仅测试夹具清理，不触碰被测产品逻辑）。 */
function rmSafe(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
