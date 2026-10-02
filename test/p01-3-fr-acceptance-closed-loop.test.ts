/**
 * P01-3 / F-013 集成验收矩阵：FR-1/FR-2/FR-3 真实 SQLite + 真实 Git + 真实文件
 * 闭环与关键失败分支（非 mock，不调用真实模型，不读取真实用户目录/凭据）。
 *
 * 定位：F-002 ~ F-012 已逐项交付并验收应用服务各层能力；本文件把它们组装成
 * PRD §3.2 的 FR 正常路径与关键失败分支的**集成**回归，并守护「npm test 默认
 * 运行本 Feature 全部真实故障用例」的 fail-closed 前提。映射：
 *
 * - FR-1 仓库注册：用例一的 registerRepository（稳定 projectId/绑定/规范标签）
 *   与用例二的非法标签/无效仓库零业务行；重复路径/符号链接别名、同 remote 多
 *   clone、跨进程屏障竞争注册由守护清单中的 project-registration 承担；
 * - FR-2 当前配置：用例一的全局/项目创建、CAS 更新、有效配置来源、脱敏导出；
 *   用例二的明文秘密/旧版本/未知 runtime/强隔离/过期 revision 拒绝与审计回滚；
 *   跨进程全局/项目 CAS 竞争由 configuration-service（settings-race-child）承担；
 * - FR-3 数据根身份：用例一的数据根内定位与关闭重开逐字段一致（含制品
 *   hash/size 与源仓库内容不变）；用例二的跨项目 ownership 拒绝；稳定
 *   namespace/路径逃逸由 path-service 承担。
 *
 * T03/T26（当前配置原子性）、T32（项目标签）、T24（默认/来源基础）在本 Feature
 * 只为子集；不冒充认领、活动执行锁或 Task 策略复制的完整验收；accept:p01 与
 * 阶段最终报告由 P01-4 交付。断言对象为真实行、真实文件与真实返回值；必需
 * 驱动/Git 缺失时失败而非 skip（assertGitAvailable + deterministic-test-harness
 * 真实子进程回归）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { isRepositoryInspectionError } from '../packages/core/src/ports/repository-inspector.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createProjectService } from '../packages/core/src/application/project-service.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from './helpers/git-repo.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const encoder = new TextEncoder();

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_800_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

/** 可信装配注入的静态能力目录（与 F-010 一致）：anthropic 枚举模型、openai 透传。 */
function createCatalog(): RuntimeCapabilityCatalog {
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

const GLOBAL_CREDENTIAL_REF = 'keyring://global-primary';
const PROJECT_CREDENTIAL_REF = 'keyring://project-primary';
const GLOBAL_LOW_CREDENTIAL_REF_V2 = 'keyring://global-low-v2';
const SYNTHETIC_SECRET = 'sk-synthetic-f013-do-not-leak';

/** 全局默认：完整策略 + 本阶段确认的政策子集（F-008 v2）。 */
const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: GLOBAL_CREDENTIAL_REF,
    },
    modelMap: {
      low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
    },
  },
  policies: {
    executionLimits: {
      maxConcurrentWorks: 1,
      workTimeoutMs: 600_000,
      maxAttemptsPerTask: 3,
      envAllowlist: ['HOME', 'LANG'],
    },
    verification: { requireChecksBeforeDone: true },
    securityPolicy: { isolation: 'trusted_project' },
  },
};

/** 项目覆盖：完整条目整体替换 defaultStrategy，政策段级整体覆盖 executionLimits。 */
const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-opus',
      credentialRef: PROJECT_CREDENTIAL_REF,
    },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 2 },
  },
};

function bytes(...texts: readonly string[]): Uint8Array[] {
  return texts.map((text) => encoder.encode(text));
}

function sha256Hex(parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest('hex');
}

/** 在沙箱内初始化含真实 commit 与哨兵文件的仓库。 */
function createCommittedRepo(sandbox: string, name: string): string {
  const repo = join(sandbox, name);
  initGitRepo(repo);
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`, 'utf-8');
  writeFileSync(join(repo, 'sentinel.txt'), '哨兵内容·勿改\n', 'utf-8');
  commitAll(repo, 'init');
  return repo;
}

/**
 * 源仓库指纹：工作树全部文件（排除 .git）的相对路径与内容哈希 + HEAD +
 * status --porcelain。闭环前后逐字段比对，证明注册/配置/制品流程未触碰源仓库。
 */
function fingerprintRepo(repo: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.git') {
        continue;
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(relative(repo, full));
      }
    }
  };
  walk(repo);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(repo, file)));
    hash.update('\0');
  }
  hash.update(git(['rev-parse', 'HEAD'], repo).trim());
  hash.update('\0');
  hash.update(git(['status', '--porcelain', '--untracked-files=normal'], repo));
  return hash.digest('hex');
}

async function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(
      true,
    );
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

function countRows(session: SqliteStorageSession, table: string): number {
  return (session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

interface StateEventRow {
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_revision: number;
  readonly project_id: string | null;
  readonly payload: string;
}

function readStateEvents(session: SqliteStorageSession): StateEventRow[] {
  return session.database
    .prepare<[], StateEventRow>(
      'SELECT sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, project_id, payload ' +
        'FROM state_events ORDER BY sequence',
    )
    .all();
}

describe('F-013 FR-1/FR-2/FR-3 集成闭环（真实 SQLite + 真实 Git + 真实文件）', () => {
  it('闭环：注册 → 全局/项目配置 → CAS 更新 → 制品发布 → 有效配置来源 → 脱敏导出 → 关闭重开逐字段一致，源仓库不变', async () => {
    expect(assertGitAvailable()).toContain('git version');
    const sandbox = createTempSandbox('shiploop-p013-f013-loop-', { outside: [repoRoot] });
    try {
      const repositoryPath = createCommittedRepo(sandbox.path, 'closed-loop-repo');
      const fingerprintBefore = fingerprintRepo(repositoryPath);
      const dataRoot = join(sandbox.path, 'data');
      const clock = createClock();

      // —— 第一阶段：打开装配，写入全部业务事实 ——
      const app = await openCoreApplication({
        dataRoot,
        capabilityCatalog: createCatalog(),
        nowUtcMs: () => clock.next(),
      });
      let expectedProjectId = '';
      let expectedBinding: unknown = null;
      let expectedArtifactId = '';
      let expectedArtifact: unknown = null;
      let expectedArtifactHash = '';
      let expectedArtifactSize = 0;
      let publishedRelativePath = '';
      let effectiveJson = '';
      try {
        // FR-1：注册真实仓库（标签含前后空格/大小写重复，走共用规范化）。
        const registration = await app.projectService.registerRepository({
          repositoryPath,
          displayName: '闭环项目',
          description: 'FR 闭环 **验证** 🚀',
          labels: [' Fr1 ', '集成', 'fr1'],
        });
        expect(registration.status).toBe('registered');
        const project = registration.project;
        expectedProjectId = project.id;
        expectedBinding = registration.binding;
        expect(project.labels).toEqual(['fr1', '集成']);
        expect(project.revision).toBe(1);
        expect(registration.binding.canonicalPath).toBe(realpathSync(repositoryPath));
        expect(registration.binding.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);

        // FR-2：全局默认（insert-only）→ CAS 更新（revision 1→2，改 modelMap.low 的
        // 模型与引用），项目覆盖创建 → CAS 更新（revision 1→2，补 modelMap.high）。
        await app.configurationService.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        const globalUpdated = await app.configurationService.updateSettings(
          { kind: 'global' },
          {
            expectedRevision: 1,
            payload: {
              ...GLOBAL_PAYLOAD,
              strategies: {
                ...GLOBAL_PAYLOAD.strategies,
                modelMap: {
                  low: {
                    runtime: 'pi',
                    provider: 'anthropic',
                    model: 'claude-opus',
                    credentialRef: GLOBAL_LOW_CREDENTIAL_REF_V2,
                  },
                },
              },
            },
          },
        );
        expect(globalUpdated.revision).toBe(2);
        await app.configurationService.createSettings(
          { kind: 'project', projectId: project.id },
          { payload: PROJECT_PAYLOAD },
        );
        const projectUpdated = await app.configurationService.updateSettings(
          { kind: 'project', projectId: project.id },
          {
            expectedRevision: 1,
            payload: {
              ...PROJECT_PAYLOAD,
              strategies: {
                ...PROJECT_PAYLOAD.strategies,
                modelMap: {
                  high: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' },
                },
              },
            },
          },
        );
        expect(projectUpdated.revision).toBe(2);

        // FR-2（制品由前序 ArtifactStore 承担）：多块正文发布，hash/size 入库。
        const publisher = createArtifactPublisher({
          artifacts: app.artifactStore,
          files: app.artifactFileStore,
          limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
        });
        const contentParts = bytes('ShipLoop ', 'P01-3 集成闭环', '正文块·三 🚀');
        const expectedHash = sha256Hex(contentParts);
        const published = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/markdown',
          expectedHash,
          locator: 'reports/集成-验收.md',
          content: contentParts,
        });
        expectedArtifactId = published.artifact.id;
        expectedArtifact = published.artifact;
        expect(published.artifact.contentHash).toBe(expectedHash);
        expect(published.artifact.sizeBytes).toBe(
          contentParts.reduce((sum, part) => sum + part.byteLength, 0),
        );
        if (published.artifact.contentHash === null || published.artifact.sizeBytes === null) {
          throw new Error('ready 制品必须携带 contentHash/sizeBytes');
        }
        expectedArtifactHash = published.artifact.contentHash;
        expectedArtifactSize = published.artifact.sizeBytes;
        publishedRelativePath = published.finalRelativePath;

        // FR-1：元数据 CAS 编辑（revision 1→2；不改绑定/配置/路径）。
        const edited = await app.projectService.updateProjectMetadata(project.id, {
          expectedRevision: 1,
          displayName: '闭环项目·改',
          labels: ['fr1', '集成', 'fr2'],
        });
        expect(edited.revision).toBe(2);
        expect(edited.repositoryBindingId).toBe(project.repositoryBindingId);

        // FR-2：有效配置精确值与逐项来源（完整条目整体替换、政策段级整体覆盖）。
        const effective = await app.configurationService.getEffectiveSettings(project.id);
        expect(effective.configured).toBe(true);
        expect(effective.strategies.defaultStrategy?.strategy.model).toBe('claude-opus');
        expect(effective.strategies.defaultStrategy?.strategy.credentialRef).toBe(
          PROJECT_CREDENTIAL_REF,
        );
        expect(effective.strategies.defaultStrategy?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 2,
          sourceKey: 'defaultStrategy',
        });
        expect(effective.strategies.modelMap.low?.strategy.model).toBe('claude-opus');
        expect(effective.strategies.modelMap.low?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 2,
          sourceKey: 'modelMap.low',
        });
        expect(effective.strategies.modelMap.high?.source.kind).toBe('project_default');
        // 政策段级整体覆盖：项目段只给 maxConcurrentWorks，全局段的其余字段不进入有效配置。
        expect(effective.policies.executionLimits?.value).toEqual({ maxConcurrentWorks: 2 });
        expect(effective.policies.executionLimits?.source.kind).toBe('project_default');
        expect(effective.policies.verification?.value).toEqual({ requireChecksBeforeDone: true });
        expect(effective.policies.verification?.source.kind).toBe('global_default');
        expect(effective.policies.securityPolicy?.value).toEqual({ isolation: 'trusted_project' });
        effectiveJson = JSON.stringify(effective);

        // FR-2：普通脱敏导出——引用原样保留、不含执行就绪标记、不含合成秘密。
        const exported = await app.configurationService.exportSettings(project.id);
        expect(exported.exportFormatVersion).toBe(1);
        expect(exported.scope).toBe('project');
        expect(exported.projectId).toBe(project.id);
        expect(exported.current.revision).toBe(2);
        expect(exported.current.strategies?.defaultStrategy?.credentialRef).toBe(
          PROJECT_CREDENTIAL_REF,
        );
        const exportJson = JSON.stringify(exported);
        expect(exportJson).toContain(PROJECT_CREDENTIAL_REF);
        expect(exportJson).not.toContain(SYNTHETIC_SECRET);
        expect(exportJson).not.toContain('"executable"');
        expect(exportJson).not.toContain('"ready"');

        // FR-3：受权定位在数据根内（项目目录类型）。
        const located = await app.pathService.locateProjectResource(
          { projectId: project.id },
          { type: 'project_directory' },
        );
        expect(located.absolutePath.startsWith(app.dataRoot + '/')).toBe(true);
        expect(located.relativePath).toBe(`projects/${project.id}`);

        // 项目层标签计数（T32 子集）在闭环内即时反映持久状态。
        const labelCounts = await app.projectService.countProjectLabels();
        expect(labelCounts).toEqual([
          { label: 'fr1', projectCount: 1 },
          { label: 'fr2', projectCount: 1 },
          { label: '集成', projectCount: 1 },
        ]);
      } finally {
        app.close();
      }

      // —— 第二阶段：关闭重开同一数据根，全部经端口读取逐字段比对 ——
      const reopened = await openCoreApplication({
        dataRoot,
        capabilityCatalog: createCatalog(),
        nowUtcMs: () => clock.next(),
      });
      try {
        const projectAfter = await reopened.projectService.getProject(expectedProjectId);
        expect(projectAfter.id).toBe(expectedProjectId);
        expect(projectAfter.revision).toBe(2);
        expect(projectAfter.displayName).toBe('闭环项目·改');
        expect(projectAfter.labels).toEqual(['fr1', '集成', 'fr2']);

        const bindingAfter = await reopened.projectService.getRepositoryBinding(expectedProjectId);
        expect(bindingAfter).toEqual(expectedBinding);

        const globalAfter = await reopened.configurationService.getCurrentSettings({
          kind: 'global',
        });
        expect(globalAfter.revision).toBe(2);
        const projectSettingsAfter = await reopened.configurationService.getCurrentSettings({
          kind: 'project',
          projectId: expectedProjectId,
        });
        expect(projectSettingsAfter.revision).toBe(2);

        // 有效配置（值与来源）关闭重开后与关闭前逐字段一致。
        const effectiveAfter = await reopened.configurationService.getEffectiveSettings(
          expectedProjectId,
        );
        expect(JSON.stringify(effectiveAfter)).toBe(effectiveJson);
        expect(effectiveAfter.strategies.defaultStrategy?.source.kind).toBe('project_default');
        expect(effectiveAfter.strategies.modelMap.low?.source.scopeRevision).toBe(2);

        // 制品索引与正文关闭重开后逐字段一致（hash/size/内容）。
        const artifactAfter = await reopened.artifactStore.getArtifact(
          expectedProjectId,
          expectedArtifactId,
        );
        expect(artifactAfter).toEqual(expectedArtifact);
        const verifier = createArtifactVerifier({
          artifacts: reopened.artifactStore,
          files: reopened.artifactFileStore,
          limits: { maxReadBytes: 1_048_576 },
        });
        const verified = await verifier.readVerifiedContent(expectedProjectId, expectedArtifactId);
        expect(verified.contentHash).toBe(expectedArtifactHash);
        expect(verified.sizeBytes).toBe(expectedArtifactSize);
        expect(verified.relativePath).toBe(publishedRelativePath);
        expect(Buffer.from(verified.content)).toEqual(
          Buffer.concat(bytes('ShipLoop ', 'P01-3 集成闭环', '正文块·三 🚀').map(Buffer.from)),
        );

        // FR-3：受权定位关闭重开后相同；数据库位于同一数据根。
        const locatedAfter = await reopened.pathService.locateProjectResource(
          { projectId: expectedProjectId },
          { type: 'project_directory' },
        );
        expect(locatedAfter.relativePath).toBe(`projects/${expectedProjectId}`);
        expect(existsSync(join(reopened.dataRoot, 'core.sqlite'))).toBe(true);
      } finally {
        reopened.close();
      }

      // —— 第三阶段：真实行级证据与脱敏审计（关闭后只读核对） ——
      const session = openSqliteStorageSession({ path: join(dataRoot, 'core.sqlite') });
      try {
        expect(countRows(session, 'projects')).toBe(1);
        expect(countRows(session, 'repository_bindings')).toBe(1);
        expect(countRows(session, 'global_settings')).toBe(1);
        expect(countRows(session, 'project_settings')).toBe(1);
        expect(countRows(session, 'artifacts')).toBe(1);

        // 恰三条脱敏审计：元数据编辑 + 全局配置更新 + 项目配置更新（创建不写审计）。
        const events = readStateEvents(session);
        expect(events.map((event) => event.event_type)).toEqual([
          'settings.global_updated',
          'settings.project_updated',
          'project.metadata_updated',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
        const eventsJson = JSON.stringify(events);
        for (const event of events) {
          const payload = JSON.parse(event.payload) as Record<string, unknown>;
          expect(typeof payload).toBe('object');
        }
        // 脱敏：审计不含凭据引用值、模型名、绝对路径或合成秘密。
        expect(eventsJson).not.toContain('keyring://');
        expect(eventsJson).not.toContain('claude-');
        expect(eventsJson).not.toContain(dataRoot);
        expect(eventsJson).not.toContain(SYNTHETIC_SECRET);
        // 全局事件 project_id 为空（CHECK 限定仅 global_settings 可为空）。
        const globalEvent = events.find((event) => event.event_type === 'settings.global_updated');
        expect(globalEvent?.project_id).toBeNull();
        expect(globalEvent?.aggregate_revision).toBe(2);
        const metadataEvent = events.find((event) => event.event_type === 'project.metadata_updated');
        expect(metadataEvent?.project_id).toBe(expectedProjectId);
        expect(metadataEvent?.aggregate_revision).toBe(2);
      } finally {
        session.close();
      }

      // —— 第四阶段：源仓库指纹逐字节不变（不迁入、不改写、不执行脚本） ——
      expect(fingerprintRepo(repositoryPath)).toBe(fingerprintBefore);
    } finally {
      sandbox.cleanup();
    }
  });

  it('关键失败分支：非法输入/旧版本/秘密/未知 runtime/强隔离/过期 revision/审计注入失败均零副作用，跨项目拒绝', async () => {
    const sandbox = createTempSandbox('shiploop-p013-f013-fail-', { outside: [repoRoot] });
    try {
      const repoA = createCommittedRepo(sandbox.path, 'repo-a');
      const repoB = createCommittedRepo(sandbox.path, 'repo-b');
      const dataRoot = join(sandbox.path, 'data');
      mkdirSync(dataRoot, { recursive: true });
      const dbPath = join(dataRoot, 'core.sqlite');
      const clock = createClock();

      // 手动装配（需要同一连接注入 TEMP TRIGGER，组合根不暴露会话句柄）。
      const basePaths = createPathService({ dataRoot });
      const session = openSqliteStorageSession({ path: dbPath });
      try {
        await migrateSqliteStorage(session);
        const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
        const projectService = createProjectService({
          stateStore: store,
          repositoryInspector: createRepositoryInspector(),
        });
        const configService = createConfigurationService({
          stateStore: store,
          capabilityCatalog: createCatalog(),
        });
        const paths = basePaths.withProjectLookup(store);

        const regA = await projectService.registerRepository({
          repositoryPath: repoA,
          displayName: '项目 A',
        });
        const regB = await projectService.registerRepository({
          repositoryPath: repoB,
          displayName: '项目 B',
        });
        const projectA = regA.project;
        const projectB = regB.project;
        await configService.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });

        // FR-1 失败分支：非法标签先于任何 I/O 拒绝，项目/绑定零新增。
        await expectStorageError('validation', () =>
          projectService.registerRepository({
            repositoryPath: repoA,
            displayName: '非法标签项目',
            labels: ['   '],
          }),
        );
        // FR-1 失败分支：无效仓库路径检查失败，不伪装成有效绑定、零业务行。
        const invalidRepo = await projectService
          .registerRepository({
            repositoryPath: join(sandbox.path, 'no-such-repo'),
            displayName: '无效仓库',
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(isRepositoryInspectionError(invalidRepo)).toBe(true);
        expect(countRows(session, 'projects')).toBe(2);
        expect(countRows(session, 'repository_bindings')).toBe(2);

        // FR-2 失败分支：明文秘密字段拒绝，错误不回显合成秘密，零配置行。
        const secretError = await expectStorageError('validation', () =>
          configService.createSettings(
            { kind: 'project', projectId: projectA.id },
            {
              payload: {
                schemaVersion: 2,
                strategies: {
                  defaultStrategy: {
                    runtime: 'pi',
                    provider: 'anthropic',
                    model: 'claude-sonnet',
                    apiKey: SYNTHETIC_SECRET,
                  },
                },
              },
            },
          ),
        );
        expect(JSON.stringify({ message: secretError.message, details: secretError.details })).not.toContain(
          SYNTHETIC_SECRET,
        );
        // FR-2 失败分支：旧 schemaVersion 不被静默误读。
        await expectStorageError('validation', () =>
          configService.createSettings(
            { kind: 'project', projectId: projectA.id },
            { payload: { schemaVersion: 1, strategies: {} } },
          ),
        );
        // FR-2 失败分支：未知 runtime 带字段定位拒绝（能力目录 fail-closed）。
        const unknownRuntime = await expectStorageError('validation', () =>
          configService.createSettings(
            { kind: 'project', projectId: projectA.id },
            {
              payload: {
                schemaVersion: 2,
                strategies: {
                  defaultStrategy: { runtime: 'not-a-runtime', provider: 'anthropic', model: 'x' },
                },
              },
            },
          ),
        );
        expect(JSON.stringify(unknownRuntime.details)).toContain('unknown_runtime');
        // FR-2 失败分支：强隔离等未支持能力明确拒绝，不降级为可信项目。
        const isolation = await expectStorageError('validation', () =>
          configService.createSettings(
            { kind: 'project', projectId: projectA.id },
            {
              payload: {
                schemaVersion: 2,
                strategies: {},
                policies: { securityPolicy: { isolation: 'strong_sandbox' } },
              },
            },
          ),
        );
        expect(JSON.stringify(isolation.details)).toContain('unsupported_isolation');
        // FR-2 失败分支：未知项目 scope 为 not_found（scope 是唯一身份渠道）。
        await expectStorageError('not_found', () =>
          configService.createSettings(
            { kind: 'project', projectId: 'proj-missing' },
            { payload: PROJECT_PAYLOAD },
          ),
        );
        expect(countRows(session, 'project_settings')).toBe(0);

        // FR-2 失败分支：过期 revision CAS 冲突，payload/revision 不变、无审计记录。
        await expectStorageError('conflict', () =>
          configService.updateSettings(
            { kind: 'global' },
            { expectedRevision: 99, payload: GLOBAL_PAYLOAD },
          ),
        );
        expect(countRows(session, 'state_events')).toBe(0);
        const globalUnchanged = await configService.getCurrentSettings({ kind: 'global' });
        expect(globalUnchanged.revision).toBe(1);

        // FR-2 失败分支：审计记录写入注入失败 → 元数据与 revision 一并回滚。
        session.database.exec(
          'CREATE TEMP TRIGGER f013_fail_event BEFORE INSERT ON state_events ' +
            "BEGIN SELECT RAISE(ABORT, 'f-013 injected audit failure'); END",
        );
        await expect(
          projectService.updateProjectMetadata(projectA.id, {
            expectedRevision: 1,
            displayName: '不应生效',
          }),
        ).rejects.toThrow(/f-013 injected audit failure/);
        const projectAfterInject = await projectService.getProject(projectA.id);
        expect(projectAfterInject.revision).toBe(1);
        expect(projectAfterInject.displayName).toBe('项目 A');
        expect(countRows(session, 'state_events')).toBe(0);
        session.database.exec('DROP TRIGGER f013_fail_event');

        // 修复后同一操作可继续（失败现场不阻碍后续一致写入）。
        const recovered = await projectService.updateProjectMetadata(projectA.id, {
          expectedRevision: 1,
          displayName: '项目 A·改',
        });
        expect(recovered.revision).toBe(2);
        expect(countRows(session, 'state_events')).toBe(1);

        // FR-2 跨项目隔离：写项目 B scope 不触碰项目 A 的任何行。
        await configService.createSettings(
          { kind: 'project', projectId: projectB.id },
          { payload: PROJECT_PAYLOAD },
        );
        expect(countRows(session, 'project_settings')).toBe(1);
        const projectASettings = await configService
          .getCurrentSettings({ kind: 'project', projectId: projectA.id })
          .then(
            () => 'unexpected',
            (error: unknown) => error,
          );
        expect(isStorageError(projectASettings, 'not_found')).toBe(true);

        // FR-3 跨项目拒绝：项目 A 范围不能定位项目 B 的制品内容。
        const publisher = createArtifactPublisher({
          artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => clock.next() }),
          files: createArtifactFileStore({ dataRoot }),
          limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
        });
        const bContent = bytes('项目 B 制品');
        const bArtifact = await publisher.publishArtifact({
          projectId: projectB.id,
          kind: 'report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex(bContent),
          locator: 'reports/b.txt',
          content: bContent,
        });
        await expectStorageError('ownership', () =>
          paths.locateProjectResource(
            { projectId: projectA.id },
            { type: 'artifact_content', projectId: projectB.id, artifactId: bArtifact.artifact.id },
          ),
        );

        // 故障与失败分支之后，已有值与引用完整保留。
        const finalGlobal = await configService.getCurrentSettings({ kind: 'global' });
        expect(finalGlobal.payload).toEqual(GLOBAL_PAYLOAD);
        expect(finalGlobal.revision).toBe(1);
        expect(countRows(session, 'projects')).toBe(2);
        expect(countRows(session, 'repository_bindings')).toBe(2);
        expect(countRows(session, 'global_settings')).toBe(1);
        expect(countRows(session, 'artifacts')).toBe(1);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('FR 失败分支回归清单守护：映射的测试文件在位、被 npm test 默认收集且未被跳过', () => {
    // F-013 验收点 2/5 的 fail-closed 守护：把「默认 npm test 必须运行的 FR 关键
    // 失败分支」固定为可执行清单。vitest include 收集 test/** 下的 *.test.ts
    // 且排除 helpers/fixtures——清单文件缺失、移入 helpers 或被 .skip/.only/.todo
    // 静默跳过时本守护失败，而不是让故障回归悄悄消失。
    const requiredCases: readonly { readonly file: string; readonly guards: string }[] = [
      {
        file: 'project-registration.test.ts',
        guards:
          'FR-1：重复路径/符号链接别名 already_exists 不覆盖、同 remote 两 clone 分别注册、' +
          '跨进程屏障竞争恰一胜者（helpers/register-race-child.ts）、绑定写失败整组回滚、非法标签零业务行',
      },
      {
        file: 'repository-inspector.test.ts',
        guards: 'FR-1：不存在/普通文件/非 Git/子目录/裸仓库拒绝、只读性、超时与不可用不伪装有效绑定',
      },
      {
        file: 'project-metadata-validation.test.ts',
        guards: 'FR-1：非法标签/名称/描述字段定位拒绝且未调用写入端口',
      },
      {
        file: 'project-metadata-service.test.ts',
        guards: 'FR-1：元数据 CAS 编辑、过期 revision 零副作用、审计注入失败整组回滚',
      },
      {
        file: 'project-tag-filter.test.ts',
        guards: 'T32 子集：任一/全部标签筛选、有限分页、项目层去重计数、绑定参数防注入',
      },
      {
        file: 'settings-schema-v2.test.ts',
        guards: 'FR-2：未知 schemaVersion/未知键/不完整策略/非法政策数值/凭据 URL/明文秘密拒绝',
      },
      {
        file: 'runtime-capabilities.test.ts',
        guards: 'FR-2：未知 runtime/不兼容 provider/未枚举 model 拒绝、空目录 fail-closed、合法≠可执行',
      },
      {
        file: 'configuration-service.test.ts',
        guards:
          'FR-2 / T03/T26 子集：insert-only 首次创建、CAS 条件写入、跨进程屏障竞争全局/项目配置恰一胜者' +
          '（helpers/settings-race-child.ts）、stale_dependency 陈旧依赖拒绝、审计注入失败整组回滚',
      },
      {
        file: 'effective-settings-merge.test.ts',
        guards: 'FR-2 / T24 子集：完整条目整体替换、政策段级覆盖、来源解释、无效覆盖不降级',
      },
      {
        file: 'settings-query-service.test.ts',
        guards: 'FR-2：当前值/有效配置/脱敏导出只读、秘密不泄漏、持久损坏 corrupt 不回落',
      },
      {
        file: 'path-service.test.ts',
        guards: 'FR-3：稳定 namespace、显式/默认根、路径逃逸拒绝、跨项目 ownership、未知项目 not_found',
      },
      {
        file: 'core-assembly.test.ts',
        guards: '装配闭环：组合根选项 fail-closed、示例全流程、./assembly 导出面不含 ORM/会话类型',
      },
      {
        file: 'sqlite-cas-and-atomicity.test.ts',
        guards: 'T03/T26 子集：真实跨进程 CAS 竞争（helpers/cas-race-child.ts）与失败注入回滚',
      },
      {
        file: 'deterministic-test-harness.test.ts',
        guards: '必需测试工具缺失/失败断言在真实子进程中失败而非跳过',
      },
      {
        file: 'sqlite-storage-fixture.test.ts',
        guards: '原生驱动真实加载与依赖精确固定（缺失即失败，非 skip）',
      },
    ];

    // 令牌以拼接构造，避免本守护文件自身被扫描时自匹配。
    const forbiddenMarkers = [
      ['it', '.skip('],
      ['describe', '.skip('],
      ['test', '.skip('],
      ['it', '.only('],
      ['describe', '.only('],
      ['test', '.only('],
      ['it', '.todo('],
      ['test', '.todo('],
    ].map(([owner, marker]) => owner + marker) as readonly string[];

    for (const required of requiredCases) {
      const path = join(repoRoot, 'test', required.file);
      expect(
        existsSync(path),
        `npm test 默认收集的 FR 失败分支用例缺失：${required.file}（${required.guards}）`,
      ).toBe(true);
      expect(required.file.endsWith('.test.ts')).toBe(true);
      const code = readFileSync(path, 'utf-8');
      for (const marker of forbiddenMarkers) {
        expect(
          code.includes(marker),
          `${required.file} 含静默跳过/独占标记 "${marker}"，故障回归不得被跳过`,
        ).toBe(false);
      }
    }

    // 跨进程竞争子进程夹具：同步屏障、有限外层超时与退出核验的真实进程入口在位。
    for (const helper of [
      'register-race-child.ts',
      'settings-race-child.ts',
      'cas-race-child.ts',
    ]) {
      const helperPath = join(repoRoot, 'test', 'helpers', helper);
      expect(existsSync(helperPath), `跨进程竞争子进程夹具缺失：test/helpers/${helper}`).toBe(true);
    }
  });
});
