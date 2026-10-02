/**
 * F-013 全链路集成闭环与故障回归守护（P01-2 收尾集成）。
 *
 * 定位：F-001–F-012 已逐项交付并验收存储栈各层能力；本文件把它们在同一个
 * **独立临时数据根**（真实 SQLite 状态库 + 受控制品文件根）内组装成完整业务
 * 闭环回归，并守护「npm test 默认运行本 Feature 全部真实故障用例」的
 * fail-closed 前提。对应 PRD FR-1/FR-2/FR-3 的正常路径与关键失败分支映射：
 *
 * - FR-1 SQLite 原子存储：本文件的闭环组合创建/CAS/读取 + 组合事务失败注入
 *   （无半条项目/配置记录）+ 闭环内 CAS 过期冲突与跨项目归属拒绝；
 *   真实跨进程 CAS 竞争、busy、回滚、外键/归属矩阵由守护清单中的
 *   sqlite-cas-and-atomicity / sqlite-connection-lifecycle /
 *   sqlite-ownership-constraint-matrix 承担；
 * - FR-2 制品发布与核对：本文件的闭环发布→关闭重开→逐字段一致→批量核对；
 *   发布中断、损坏/孤立文件诊断由 artifact-verify 承担，路径逃逸拒绝由
 *   artifact-file-store 承担；
 * - FR-3 迁移与重开：本文件的闭环「先迁移后使用、关闭重开后数据一致且迁移
 *   记录仍在」；迁移拒写/失败回滚证据由 sqlite-migration-runner 承担。
 *
 * 断言对象是真实行、真实文件与真实返回值（经 withTempSandbox 保证临时资源
 * 收尾）；缺失原生驱动或必需测试工具时本套件失败而非跳过（run-tests
 * fail-closed 启动器 + deterministic-test-harness 真实子进程回归，均在
 * 守护清单内）。
 *
 * 本次不实现、也不冒充已实现：T24 Task 策略复制、T32 完整标签查询、
 * Host/CLI 命令、accept:p01 阶段验收、模型 Live；不修改 Harness 验证配置，
 * 不新增执行/Chat/知识等后续表。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import type { ArtifactStore } from '../packages/core/src/ports/artifact-store.ts';
import type { ArtifactFileStore } from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import type { ArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const encoder = new TextEncoder();

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

/** 确定性递增时钟：每次调用 +1ms；跨关闭重开的两个装配共享同一时钟。 */
function createClock(start = 1_700_200_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

const VALID_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: 'keyring://primary',
    },
  },
};

const UPDATED_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: 'keyring://integration',
    },
  },
};

type Harness = {
  readonly root: string;
  readonly dbPath: string;
  readonly session: SqliteStorageSession;
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly publisher: ArtifactPublisher;
  readonly verifier: ArtifactVerifier;
  close(): void;
};

function openHarness(root: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  const nowUtcMs = () => clock.next();
  let stagingCounter = 0;
  const files = createArtifactFileStore({
    dataRoot: root,
    stagingName: () => `t${(stagingCounter += 1)}`,
  });
  const artifacts = createSqliteArtifactStore(session, { nowUtcMs });
  return {
    root,
    dbPath: join(root, 'state.db'),
    session,
    state: createSqliteStateStore(session, { nowUtcMs }),
    artifacts,
    files,
    publisher: createArtifactPublisher({
      artifacts,
      files,
      limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
    }),
    verifier: createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_048_576 } }),
    close(): void {
      session.close();
    },
  };
}

/** 先在独立会话中执行迁移再交由测试装配使用（FR-3：先迁移后使用）。 */
async function withMigratedRoot(
  fn: (root: string, clock: Clock) => Promise<void>,
): Promise<void> {
  const clock = createClock();
  const sandbox = createTempSandbox('shiploop-f013-');
  try {
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    await fn(sandbox.path, clock);
  } finally {
    sandbox.cleanup();
  }
}

function countRows(session: SqliteStorageSession, table: string): number {
  return (
    session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function migrationRows(session: SqliteStorageSession): { version: number }[] {
  return session.database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[];
}

async function expectStorageErrorKind(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(
      isStorageError(error, kind),
      `expected StorageError(${kind}), got ${String(error)}`,
    ).toBe(true);
    return;
  }
  throw new Error(`expected StorageError(${kind})`);
}

describe('F-013 SQLite/制品全链路集成闭环（独立临时数据根）', () => {
  it('闭环：组合创建项目+配置 → 全局配置 → 发布制品 → CAS 更新 → 关闭重开逐字段一致且迁移记录仍在', async () => {
    await withMigratedRoot(async (root, clock) => {
      const harness = openHarness(root, clock);

      // FR-1 正常路径：项目与初始项目当前配置的原子组合创建（含中文/emoji 多字节）。
      const created = await harness.state.createProjectWithInitialSettings(
        { displayName: '集成项目·甲', description: '全链路闭环验证 🚀', labels: [' P01 ', '集成', 'p01'] },
        { payload: VALID_PAYLOAD },
      );
      const projectBefore = created.project;
      const settingsBefore = created.settings;

      // FR-1 正常路径：全局当前配置单例创建。
      const globalBefore = await harness.state.createGlobalSettings({ payload: VALID_PAYLOAD });

      // FR-2 正常路径：多块中文正文流式发布 + 空正文发布。
      const contentParts = bytes('ShipLoop ', '集成闭环', '正文块·三');
      const expectedHash = sha256Hex(contentParts);
      const published = await harness.publisher.publishArtifact({
        projectId: projectBefore.id,
        kind: 'verification-report',
        mediaType: 'text/markdown',
        expectedHash,
        locator: 'reports/集成-验收.md',
        content: contentParts,
      });
      const emptyPublished = await harness.publisher.publishArtifact({
        projectId: projectBefore.id,
        kind: 'empty-probe',
        mediaType: 'application/octet-stream',
        expectedHash: sha256Hex([]),
        locator: 'probes/empty.bin',
        content: [],
      });

      // FR-1 正常路径：配置与项目元数据的 CAS 更新（revision 1→2）。
      const settingsUpdated = await harness.state.updateProjectSettings(projectBefore.id, {
        expectedRevision: 1,
        payload: UPDATED_PAYLOAD,
      });
      const projectUpdated = await harness.state.updateProject(projectBefore.id, {
        expectedRevision: 1,
        labels: ['集成', 'p01', '更新后'],
      });

      const refBefore = await harness.artifacts.getArtifactInputRef(projectBefore.id, published.artifact.id);
      const contentBefore = await harness.verifier.readVerifiedContent(projectBefore.id, published.artifact.id);

      harness.close();

      // FR-3 正常路径：关闭后重新打开同一数据根，全部经端口读取比对。
      const reopened = openHarness(root, clock);
      try {
        const projectAfter = await reopened.state.getProject(projectBefore.id);
        const settingsAfter = await reopened.state.getProjectSettings(projectBefore.id);
        const globalAfter = await reopened.state.getGlobalSettings();
        const artifactAfter = await reopened.artifacts.getArtifact(projectBefore.id, published.artifact.id);
        const emptyAfter = await reopened.artifacts.getArtifact(projectBefore.id, emptyPublished.artifact.id);
        const refAfter = await reopened.artifacts.getArtifactInputRef(projectBefore.id, published.artifact.id);
        const contentAfter = await reopened.verifier.readVerifiedContent(projectBefore.id, published.artifact.id);

        // ID、revision、JSON 与正文 hash/size 关闭重开后逐字段一致（不依赖内存缓存）。
        expect(projectAfter).toEqual({ ...projectUpdated, revision: projectUpdated.revision });
        expect(projectAfter.id).toBe(projectBefore.id);
        expect(projectAfter.revision).toBe(2);
        expect(projectAfter.labels).toEqual(['集成', 'p01', '更新后']);
        expect(settingsAfter).toEqual(settingsUpdated);
        expect(settingsAfter.revision).toBe(2);
        expect(settingsAfter.payload).toEqual(UPDATED_PAYLOAD);
        expect(globalAfter).toEqual(globalBefore);
        expect(artifactAfter).toEqual(published.artifact);
        expect(artifactAfter.contentHash).toBe(expectedHash);
        expect(artifactAfter.sizeBytes).toBe(
          contentParts.reduce((sum, part) => sum + part.byteLength, 0),
        );
        expect(emptyAfter).toEqual(emptyPublished.artifact);
        expect(emptyAfter.sizeBytes).toBe(0);
        expect(refAfter).toEqual(refBefore);
        expect(contentAfter.contentHash).toBe(contentBefore.contentHash);
        expect(contentAfter.sizeBytes).toBe(contentBefore.sizeBytes);
        expect(Buffer.from(contentAfter.content)).toEqual(Buffer.concat(contentParts.map(Buffer.from)));
        expect(contentAfter.relativePath).toBe(contentBefore.relativePath);

        // FR-3：迁移记录仍在（库未被重建，先迁移后使用的一致性证据；v1 六表 + v2 状态事件）。
        expect(migrationRows(reopened.session)).toEqual([{ version: 1 }, { version: 2 }]);

        // FR-2：项目级批量核对——两制品均 verified_ready，无孤儿，未截断。
        const report = await reopened.verifier.verifyProject(projectBefore.id);
        expect(report.orphanPolicy).toBe('kept_in_place');
        expect(report.truncated).toBe(false);
        expect(report.orphans).toEqual([]);
        expect(report.artifactReports.map((entry) => entry.kind).sort()).toEqual([
          'verified_ready',
          'verified_ready',
        ]);
        for (const entry of report.artifactReports) {
          expect(entry.corruption).toBeNull();
          expect(entry.interruption).toBeNull();
        }
      } finally {
        reopened.close();
      }
    });
  });

  it('闭环组合事务失败注入：第二步中止后没有半条项目/配置记录，修复后同一操作可继续', async () => {
    await withMigratedRoot(async (root) => {
      const harness = openHarness(root, createClock());
      try {
        // 通过真实 SQLite 临时触发器在第二步（project_settings 插入）注入失败：
        // 此刻第一步（projects 插入）已在同一事务内完成，失败必须整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f013_fail_settings_insert BEFORE INSERT ON project_settings ' +
            "BEGIN SELECT RAISE(ABORT, 'f-013 injected second-step failure'); END",
        );
        await expect(
          harness.state.createProjectWithInitialSettings(
            { displayName: '注入目标项目' },
            { payload: VALID_PAYLOAD },
          ),
        ).rejects.toThrow(/f-013 injected second-step failure/);

        // 无半条业务记录：项目与配置（以及全局配置、制品）均零残留。
        expect(countRows(harness.session, 'projects')).toBe(0);
        expect(countRows(harness.session, 'project_settings')).toBe(0);
        expect(countRows(harness.session, 'global_settings')).toBe(0);
        expect(countRows(harness.session, 'artifacts')).toBe(0);

        // 撤除注入后同一组合创建成功——失败现场不阻碍后续一致写入。
        harness.session.database.exec('DROP TRIGGER f013_fail_settings_insert');
        const recovered = await harness.state.createProjectWithInitialSettings(
          { displayName: '注入目标项目' },
          { payload: VALID_PAYLOAD },
        );
        expect(countRows(harness.session, 'projects')).toBe(1);
        expect(countRows(harness.session, 'project_settings')).toBe(1);

        harness.close();
        const reopened = openHarness(root, createClock(1_700_300_000_000));
        try {
          const projectAfter = await reopened.state.getProject(recovered.project.id);
          const settingsAfter = await reopened.state.getProjectSettings(recovered.project.id);
          expect(projectAfter).toEqual(recovered.project);
          expect(settingsAfter).toEqual(recovered.settings);
          expect(migrationRows(reopened.session)).toEqual([{ version: 1 }, { version: 2 }]);
        } finally {
          reopened.close();
        }
      } finally {
        harness.close();
      }
    });
  });

  it('闭环关键失败分支：CAS 过期冲突、跨项目归属拒绝与 pending 引用拒绝均零持久化副作用', async () => {
    await withMigratedRoot(async (root) => {
      const harness = openHarness(root, createClock());
      try {
        const projectA = await harness.state.createProject({ displayName: '项目 A' });
        const projectB = await harness.state.createProject({ displayName: '项目 B' });
        await harness.state.createProjectSettings(projectA.id, { payload: VALID_PAYLOAD });

        const contentParts = bytes('A 项目制品正文');
        const published = await harness.publisher.publishArtifact({
          projectId: projectA.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex(contentParts),
          locator: 'reports/a.txt',
          content: contentParts,
        });
        // pending 索引：登记但未发布正文（ready 前不能作为有效输入）。
        const pending = await harness.artifacts.registerArtifact({
          projectId: projectA.id,
          kind: 'session-log',
          mediaType: 'application/json',
          expectedHash: sha256Hex(bytes('{}')),
          locator: 'logs/pending.json',
        });

        // FR-1 失败分支：过期 revision 的 CAS 更新返回 conflict，原 payload 与 revision 不变。
        await expectStorageErrorKind('conflict', () =>
          harness.state.updateProjectSettings(projectA.id, {
            expectedRevision: 99,
            payload: UPDATED_PAYLOAD,
          }),
        );
        const settingsAfterConflict = await harness.state.getProjectSettings(projectA.id);
        expect(settingsAfterConflict.revision).toBe(1);
        expect(settingsAfterConflict.payload).toEqual(VALID_PAYLOAD);

        // FR-2 失败分支：跨项目归属拒绝——B 即使面对 A 的 ready 制品也取不到记录与引用。
        await expectStorageErrorKind('ownership', () =>
          harness.artifacts.getArtifact(projectB.id, published.artifact.id),
        );
        await expectStorageErrorKind('ownership', () =>
          harness.artifacts.getArtifactInputRef(projectB.id, published.artifact.id),
        );

        // FR-2 失败分支：pending 制品不能取得有效输入引用（ready 前不可用）。
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(projectA.id, pending.id),
        );

        // 全部失败分支零持久化副作用：行数与关键行逐字段保持不变。
        expect(countRows(harness.session, 'projects')).toBe(2);
        expect(countRows(harness.session, 'project_settings')).toBe(1);
        expect(countRows(harness.session, 'artifacts')).toBe(2);
        const artifactRow = await harness.artifacts.getArtifact(projectA.id, published.artifact.id);
        expect(artifactRow).toEqual(published.artifact);
        const pendingRow = await harness.artifacts.getArtifact(projectA.id, pending.id);
        expect(pendingRow.status).toBe('pending');
      } finally {
        harness.close();
      }
    });
  });

  it('故障回归清单守护：本 Feature 的真实故障用例在位、被 npm test 默认收集且未被跳过', () => {
    // F-013 验收点 2 的 fail-closed 守护：下表把「npm test 默认运行的真实故障
    // 用例」固定为可执行清单。vitest 配置 include 为 test/** 下的 *.test.ts 且
    // 只排除 node_modules/dist/coverage/helpers/fixtures——因此清单文件存在于
    // test/ 根即被默认收集；文件被删除、移入 helpers 或被 .skip/.only/.todo
    // 静默跳过时本守护失败，而不是让故障回归悄悄消失。
    const requiredCases: readonly { readonly file: string; readonly guards: string }[] = [
      { file: 'sqlite-cas-and-atomicity.test.ts', guards: 'FR-1：真实跨进程 CAS 竞争与失败注入回滚、组合写入原子性' },
      { file: 'sqlite-connection-lifecycle.test.ts', guards: 'FR-1：busy 有限等待、短同步事务回滚与连接生命周期' },
      { file: 'sqlite-ownership-constraint-matrix.test.ts', guards: 'FR-1：跨项目归属与外键/DDL 约束矩阵（绕过端口亦拒绝）' },
      { file: 'sqlite-migration-runner.test.ts', guards: 'FR-3：迁移拒写（高版本/checksum 漂移）、失败回滚与一致性备份' },
      { file: 'artifact-file-store.test.ts', guards: 'FR-2：路径逃逸/穿越拒绝与受控定位、staging 冲突保留' },
      { file: 'artifact-publish.test.ts', guards: 'FR-2：流式发布失败分支（超限/取消/hash 不匹配/commit busy 保留现场）' },
      { file: 'artifact-verify.test.ts', guards: 'FR-2：发布中断恢复、ready 损坏诊断与孤立文件 kept_in_place 证据' },
      { file: 'sqlite-storage-fixture.test.ts', guards: 'F-001：原生驱动真实加载与依赖精确固定（缺失即失败，非 skip）' },
      { file: 'deterministic-test-harness.test.ts', guards: '测试工具缺失/失败断言在真实子进程中失败而非跳过' },
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
      expect(existsSync(path), `npm test 默认收集的真实故障用例缺失：${required.file}（${required.guards}）`).toBe(
        true,
      );
      expect(required.file.endsWith('.test.ts')).toBe(true);
      const code = readFileSync(path, 'utf-8');
      for (const marker of forbiddenMarkers) {
        expect(
          code.includes(marker),
          `${required.file} 含静默跳过/独占标记 "${marker}"，故障回归不得被跳过`,
        ).toBe(false);
      }
    }
  });
});
