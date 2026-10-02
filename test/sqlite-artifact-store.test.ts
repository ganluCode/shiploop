/**
 * F-009 SQLite ArtifactStore 适配器回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-009 验收点，全部为真实断言；语义基线为 F-002 契约测试
 * test/storage-contracts.test.ts 的制品组断言 + in-memory-store.ts 行为）：
 * - 有效输入登记为 pending 并保存项目、kind、mediaType、预期 hash、受控
 *   locator、version 和 revision；大正文不进入 SQLite（行内只有索引字段），
 *   缺失项目返回 not_found、非法元数据在校验阶段拒绝且真实库行数不变；
 * - 只有核验结果携带匹配 hash 与实际 size 才可从 pending 条件转换 ready
 *   （返回新 revision）；failed 保留原因；过期 revision 或终态重复转换
 *   返回 conflict 且不能覆盖既有状态；
 * - pending/failed 与损坏诊断的制品不能取得有效输入引用；项目 A 请求
 *   项目 B 的制品即使 ready 也返回 ownership，不能仅凭全局 artifactId 放行；
 * - ready 内容 hash、size、version 和 locator 不接受普通更新覆盖；重复读取
 *   返回同一内容身份；状态前置条件、并发 revision 冲突（真实第二连接）与
 *   关闭重开后状态一致。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import type { ArtifactStore, StateStore } from '../packages/core/src/index.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
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

const VALID_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

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

type Harness = {
  readonly session: SqliteStorageSession;
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly dbPath: string;
  close(): void;
};

function openHarness(dbPath: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: dbPath });
  const nowUtcMs = () => clock.next();
  return {
    session,
    state: createSqliteStateStore(session, { nowUtcMs }),
    artifacts: createSqliteArtifactStore(session, { nowUtcMs }),
    dbPath,
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(fn: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f009-');
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

function countArtifacts(session: SqliteStorageSession): number {
  const row = session.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number };
  return row.n;
}

function rawArtifactRow(session: SqliteStorageSession, artifactId: string): Record<string, unknown> {
  return session.database
    .prepare('SELECT * FROM artifacts WHERE id = ?')
    .get(artifactId) as Record<string, unknown>;
}

async function createProject(harness: Harness, displayName = '项目'): Promise<{ id: string }> {
  return harness.state.createProject({ displayName });
}

async function registerPending(
  harness: Harness,
  projectId: string,
  overrides: Record<string, unknown> = {},
) {
  return harness.artifacts.registerArtifact({
    projectId,
    kind: 'verification-report',
    mediaType: 'application/json',
    expectedHash: VALID_HASH,
    locator: `artifacts/${projectId}/report-1`,
    ...overrides,
  });
}

async function makeReady(harness: Harness, projectId: string, artifactId: string, sizeBytes = 5) {
  return harness.artifacts.transitionArtifact(projectId, artifactId, {
    expectedRevision: 1,
    outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes },
  });
}

describe('F-009 pending registration via real SQLite port', () => {
  it('registers a pending artifact with the full index fields and no content body in SQLite', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await harness.artifacts.registerArtifact({
          projectId: project.id,
          kind: '验证报告/中文-kind',
          mediaType: 'application/json; charset=utf-8',
          expectedHash: VALID_HASH,
          locator: `artifacts/${project.id}/reports/r-1`,
          version: 3,
        });
        expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(artifact.projectId).toBe(project.id);
        expect(artifact.kind).toBe('验证报告/中文-kind');
        expect(artifact.mediaType).toBe('application/json; charset=utf-8');
        expect(artifact.status).toBe('pending');
        expect(artifact.expectedHash).toBe(VALID_HASH);
        expect(artifact.contentHash).toBeNull();
        expect(artifact.sizeBytes).toBeNull();
        expect(artifact.locator).toBe(`artifacts/${project.id}/reports/r-1`);
        expect(artifact.version).toBe(3);
        expect(artifact.revision).toBe(1);
        expect(artifact.failureReason).toBeNull();
        expect(Number.isInteger(artifact.createdAtUtcMs)).toBe(true);
        expect(artifact.updatedAtUtcMs).toBe(artifact.createdAtUtcMs);

        // 真实库中的持久化形态：索引行没有正文/大对象列，只有元数据。
        const raw = rawArtifactRow(harness.session, artifact.id);
        expect(raw['project_id']).toBe(project.id);
        expect(raw['kind']).toBe('验证报告/中文-kind');
        expect(raw['status']).toBe('pending');
        expect(raw['expected_hash']).toBe(VALID_HASH);
        expect(raw['content_hash']).toBeNull();
        expect(raw['size_bytes']).toBeNull();
        expect(raw['storage_locator']).toBe(`artifacts/${project.id}/reports/r-1`);
        expect(raw['version']).toBe(3);
        expect(raw['revision']).toBe(1);
        expect(raw['failure_reason']).toBeNull();
        expect(Object.keys(raw).sort()).toEqual(
          [
            'id', 'created_at', 'project_id', 'revision', 'updated_at', 'kind', 'status',
            'media_type', 'expected_hash', 'content_hash', 'size_bytes', 'version',
            'storage_locator', 'failure_reason',
          ].sort(),
        );

        // 读取与登记结果一致；再次读取返回同一身份。
        expect(await harness.artifacts.getArtifact(project.id, artifact.id)).toEqual(artifact);
        expect(await harness.artifacts.getArtifact(project.id, artifact.id)).toEqual(artifact);
      } finally {
        harness.close();
      }
    });
  });

  it('defaults version to 1 and accepts multi-byte locators within the controlled form', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await registerPending(harness, project.id, {
          locator: `artifacts/${project.id}/中文目录/报告`,
        });
        expect(artifact.version).toBe(1);
        expect(artifact.locator).toBe(`artifacts/${project.id}/中文目录/报告`);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects registration for a missing project with not_found and zero rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const error = await expectStorageError('not_found', () =>
          registerPending(harness, 'p-missing'),
        );
        expect(error.operation).toBe('ArtifactStore.registerArtifact');
        expect(error.entity).toEqual({ type: 'project', id: 'p-missing' });
        expect(countArtifacts(harness.session)).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects illegal metadata at validation with zero persisted rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const cases: unknown[] = [
          {},
          { projectId: project.id },
          { projectId: project.id, kind: '', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/b' },
          { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: 'not-a-hash', locator: 'a/b' },
          { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: '/abs/path' },
          { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/../b' },
          { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/b', version: 0 },
          { projectId: project.id, kind: 'k', mediaType: 'm', expectedHash: VALID_HASH, locator: 'a/b', extra: true },
          'not-an-object',
        ];
        for (const input of cases) {
          const error = await expectStorageError('validation', () =>
            harness.artifacts.registerArtifact(input),
          );
          expect(error.operation).toBe('ArtifactStore.registerArtifact');
          expect(error.entity?.type).toBe('artifact');
        }
        expect(countArtifacts(harness.session)).toBe(0);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-009 CAS transitions (pending → ready / failed)', () => {
  it('transitions pending to ready only with a matching hash and an actual size, bumping revision', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await registerPending(harness, project.id);

        // 实测 hash 与登记的预期摘要不一致：不能标记 ready，索引保持 pending。
        const mismatch = await expectStorageError('validation', () =>
          harness.artifacts.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 1,
            outcome: { status: 'ready', actualHash: OTHER_HASH, sizeBytes: 10 },
          }),
        );
        expect(mismatch.details).toMatchObject({ field: 'outcome.actualHash' });
        expect(mismatch.entity).toEqual({ type: 'artifact', id: artifact.id, projectId: project.id });
        expect((await harness.artifacts.getArtifact(project.id, artifact.id)).status).toBe('pending');

        const ready = await harness.artifacts.transitionArtifact(project.id, artifact.id, {
          expectedRevision: 1,
          outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 0 },
        });
        expect(ready.status).toBe('ready');
        expect(ready.contentHash).toBe(VALID_HASH);
        expect(ready.sizeBytes).toBe(0);
        expect(ready.revision).toBe(2);
        expect(ready.createdAtUtcMs).toBe(artifact.createdAtUtcMs);
        expect(ready.updatedAtUtcMs).toBeGreaterThan(artifact.updatedAtUtcMs);
        expect(ready.locator).toBe(artifact.locator);
        expect(ready.version).toBe(artifact.version);
        expect(ready.failureReason).toBeNull();

        const raw = rawArtifactRow(harness.session, artifact.id);
        expect(raw['status']).toBe('ready');
        expect(raw['content_hash']).toBe(VALID_HASH);
        expect(raw['size_bytes']).toBe(0);
        expect(raw['revision']).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('keeps the failure reason on failed transitions and treats failed as terminal', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await registerPending(harness, project.id);
        const failed = await harness.artifacts.transitionArtifact(project.id, artifact.id, {
          expectedRevision: 1,
          outcome: { status: 'failed', reason: 'staging 写入 I/O 失败（注入）' },
        });
        expect(failed.status).toBe('failed');
        expect(failed.failureReason).toContain('staging');
        expect(failed.contentHash).toBeNull();
        expect(failed.sizeBytes).toBeNull();
        expect(failed.revision).toBe(2);

        // failed 为索引级终态：重复转换（即使 revision 匹配）返回 conflict，原因保留。
        const again = await expectStorageError('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 2,
            outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 5 },
          }),
        );
        expect(again.details).toMatchObject({ status: 'failed' });
        const after = await harness.artifacts.getArtifact(project.id, artifact.id);
        expect(after.status).toBe('failed');
        expect(after.failureReason).toContain('staging');
        expect(after.revision).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects stale revisions without side effects and refuses to overwrite a ready identity', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await registerPending(harness, project.id);

        const stale = await expectStorageError('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 7,
            outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 1 },
          }),
        );
        expect(stale.details).toMatchObject({ expectedRevision: 7, actualRevision: 1 });
        expect((await harness.artifacts.getArtifact(project.id, artifact.id)).status).toBe('pending');

        await makeReady(harness, project.id, artifact.id, 5);

        // ready 为终态：过期或匹配 revision 的重复转换都返回 conflict。
        const staleAfterReady = await expectStorageError('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 1,
            outcome: { status: 'ready', actualHash: OTHER_HASH, sizeBytes: 99 },
          }),
        );
        expect(staleAfterReady.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
        const retransition = await expectStorageError('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 2,
            outcome: { status: 'failed', reason: 'late failure' },
          }),
        );
        expect(retransition.details).toMatchObject({ status: 'ready' });

        const after = await harness.artifacts.getArtifact(project.id, artifact.id);
        expect(after.contentHash).toBe(VALID_HASH);
        expect(after.sizeBytes).toBe(5);
        expect(after.locator).toBe(artifact.locator);
        expect(after.version).toBe(artifact.version);
        expect(after.revision).toBe(2);
        expect(after.failureReason).toBeNull();
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid transition input at the boundary before touching stored state', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const artifact = await registerPending(harness, project.id);
        const cases: unknown[] = [
          { expectedRevision: 0, outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 1 } },
          { expectedRevision: 1, outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: -1 } },
          { expectedRevision: 1, outcome: { status: 'ready', actualHash: VALID_HASH } },
          { expectedRevision: 1, outcome: { status: 'ready', actualHash: 'zz', sizeBytes: 1 } },
          { expectedRevision: 1, outcome: { status: 'failed' } },
          { expectedRevision: 1, outcome: { status: 'archived' } },
          { expectedRevision: 1 },
          { expectedRevision: 1, outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 1 }, extra: 1 },
          'not-an-object',
        ];
        for (const input of cases) {
          await expectStorageError('validation', () =>
            harness.artifacts.transitionArtifact(project.id, artifact.id, input),
          );
        }
        const after = await harness.artifacts.getArtifact(project.id, artifact.id);
        expect(after.status).toBe('pending');
        expect(after.revision).toBe(1);
        const raw = rawArtifactRow(harness.session, artifact.id);
        expect(raw['updated_at']).toBe(raw['created_at']);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found / ownership for transitions on missing or foreign artifacts', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await createProject(harness, '项目A');
        const projectB = await createProject(harness, '项目B');
        const artifact = await registerPending(harness, projectA.id);

        const missing = await expectStorageError('not_found', () =>
          harness.artifacts.transitionArtifact(projectA.id, 'a-missing', {
            expectedRevision: 1,
            outcome: { status: 'failed', reason: 'x' },
          }),
        );
        expect(missing.entity).toEqual({ type: 'artifact', id: 'a-missing', projectId: projectA.id });

        const cross = await expectStorageError('ownership', () =>
          harness.artifacts.transitionArtifact(projectB.id, artifact.id, {
            expectedRevision: 1,
            outcome: { status: 'failed', reason: 'x' },
          }),
        );
        expect(cross.entity).toEqual({ type: 'artifact', id: artifact.id, projectId: projectB.id });
        expect((await harness.artifacts.getArtifact(projectA.id, artifact.id)).status).toBe('pending');

        await expectStorageError('validation', () =>
          harness.artifacts.transitionArtifact(projectA.id, '../escape', {
            expectedRevision: 1,
            outcome: { status: 'failed', reason: 'x' },
          }),
        );
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-009 valid input references and ownership', () => {
  it('issues an input reference only for same-project ready artifacts', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await createProject(harness, '项目A');
        const projectB = await createProject(harness, '项目B');
        const pending = await registerPending(harness, projectA.id);

        // pending 不能取得有效输入引用。
        const notReady = await expectStorageError('conflict', () =>
          harness.artifacts.getArtifactInputRef(projectA.id, pending.id),
        );
        expect(notReady.details).toMatchObject({ status: 'pending' });

        await makeReady(harness, projectA.id, pending.id, 12);
        const reference = await harness.artifacts.getArtifactInputRef(projectA.id, pending.id);
        expect(reference).toEqual({
          artifactId: pending.id,
          projectId: projectA.id,
          contentHash: VALID_HASH,
          sizeBytes: 12,
          locator: pending.locator,
          version: 1,
        });
        // 重复读取返回同一内容身份。
        expect(await harness.artifacts.getArtifactInputRef(projectA.id, pending.id)).toEqual(reference);

        // 项目 B 请求项目 A 的 ready 制品：归属错误，不能仅凭全局 artifactId 放行。
        const crossRef = await expectStorageError('ownership', () =>
          harness.artifacts.getArtifactInputRef(projectB.id, pending.id),
        );
        expect(crossRef.operation).toBe('ArtifactStore.getArtifactInputRef');
        expect(crossRef.entity).toEqual({ type: 'artifact', id: pending.id, projectId: projectB.id });

        const crossGet = await expectStorageError('ownership', () =>
          harness.artifacts.getArtifact(projectB.id, pending.id),
        );
        expect(crossGet.entity).toEqual({ type: 'artifact', id: pending.id, projectId: projectB.id });

        const missing = await expectStorageError('not_found', () =>
          harness.artifacts.getArtifact(projectA.id, 'a-missing'),
        );
        expect(missing.entity).toEqual({ type: 'artifact', id: 'a-missing', projectId: projectA.id });
      } finally {
        harness.close();
      }
    });
  });

  it('refuses input references for failed artifacts and corrupted ready rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        const failedArtifact = await registerPending(harness, project.id, { locator: `artifacts/${project.id}/failed-1` });
        await harness.artifacts.transitionArtifact(project.id, failedArtifact.id, {
          expectedRevision: 1,
          outcome: { status: 'failed', reason: '校验失败' },
        });
        const failedRef = await expectStorageError('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, failedArtifact.id),
        );
        expect(failedRef.details).toMatchObject({ status: 'failed' });

        // 损坏诊断的制品不能取得有效输入引用：直接 SQL 注入 ready 但缺 hash/size
        // 的行（绕过端口与 DDL 底线，模拟历史损坏），读取端口必须拒绝放行。
        const artifact = await registerPending(harness, project.id, { locator: `artifacts/${project.id}/corrupt-1` });
        harness.session.database.pragma('ignore_check_constraints = ON');
        try {
          harness.session.database
            .prepare("UPDATE artifacts SET status = 'ready' WHERE id = ?")
            .run(artifact.id);
        } finally {
          harness.session.database.pragma('ignore_check_constraints = OFF');
        }
        await expectStorageError('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, artifact.id),
        );
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-009 concurrent revision conflicts across real connections', () => {
  it('lets exactly one same-revision transition win and keeps the winner identity', async () => {
    await withMigratedDb(async (dbPath) => {
      const clock = createClock();
      const first = openHarness(dbPath, clock);
      const project = await createProject(first);
      const artifact = await registerPending(first, project.id);
      first.close();

      const winnerSession = openSqliteStorageSession({ path: dbPath });
      const loserSession = openSqliteStorageSession({ path: dbPath });
      try {
        const winner = createSqliteArtifactStore(winnerSession, { nowUtcMs: () => clock.next() });
        const loser = createSqliteArtifactStore(loserSession, { nowUtcMs: () => clock.next() });
        const winnerView = await winner.getArtifact(project.id, artifact.id);
        const loserView = await loser.getArtifact(project.id, artifact.id);
        expect(winnerView.revision).toBe(1);
        expect(loserView.revision).toBe(1);

        const won = await winner.transitionArtifact(project.id, artifact.id, {
          expectedRevision: 1,
          outcome: { status: 'ready', actualHash: VALID_HASH, sizeBytes: 42 },
        });
        expect(won.status).toBe('ready');

        // 第二个连接持有过期视图（expectedRevision 1）：CAS 冲突，不覆盖胜者身份。
        const lost = await expectStorageError('conflict', () =>
          loser.transitionArtifact(project.id, artifact.id, {
            expectedRevision: 1,
            outcome: { status: 'failed', reason: 'loser' },
          }),
        );
        expect(lost.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });

        const after = await winner.getArtifact(project.id, artifact.id);
        expect(after.status).toBe('ready');
        expect(after.contentHash).toBe(VALID_HASH);
        expect(after.sizeBytes).toBe(42);
        expect(after.failureReason).toBeNull();
      } finally {
        winnerSession.close();
        loserSession.close();
      }
    });
  });
});

describe('F-009 durability across close and reopen', () => {
  it('keeps artifact state and references field-by-field identical after reopening', async () => {
    await withMigratedDb(async (dbPath) => {
      const first = openHarness(dbPath, createClock());
      let readySnapshot: Awaited<ReturnType<ArtifactStore['getArtifact']>>;
      let readyRef: Awaited<ReturnType<ArtifactStore['getArtifactInputRef']>>;
      let failedSnapshot: Awaited<ReturnType<ArtifactStore['getArtifact']>>;
      try {
        const project = await createProject(first, '中文项目');
        const readyArtifact = await registerPending(first, project.id);
        await makeReady(first, project.id, readyArtifact.id, 7);
        readySnapshot = await first.artifacts.getArtifact(project.id, readyArtifact.id);
        readyRef = await first.artifacts.getArtifactInputRef(project.id, readyArtifact.id);

        const failedArtifact = await registerPending(first, project.id, {
          locator: `artifacts/${project.id}/failed-1`,
        });
        await first.artifacts.transitionArtifact(project.id, failedArtifact.id, {
          expectedRevision: 1,
          outcome: { status: 'failed', reason: '发布失败原因（中文）' },
        });
        failedSnapshot = await first.artifacts.getArtifact(project.id, failedArtifact.id);
      } finally {
        first.close();
      }

      const second = openHarness(dbPath, createClock(1_700_400_000_000));
      try {
        expect(await second.artifacts.getArtifact(readySnapshot!.projectId, readySnapshot!.id)).toEqual(readySnapshot);
        expect(
          await second.artifacts.getArtifactInputRef(readySnapshot!.projectId, readySnapshot!.id),
        ).toEqual(readyRef);
        expect(await second.artifacts.getArtifact(failedSnapshot!.projectId, failedSnapshot!.id)).toEqual(failedSnapshot);
        // 迁移记录仍在，库未被重建。
        const row = second.session.database.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
        expect(row.n).toBe(1);
      } finally {
        second.close();
      }
    });
  });
});

describe('F-009 session lifecycle', () => {
  it('rejects store operations on a closed session and does not leak driver handles', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const project = await createProject(harness);
      const artifact = await registerPending(harness, project.id);
      harness.close();
      harness.close(); // 重复 close 安全。
      await expect(harness.artifacts.getArtifact(project.id, artifact.id)).rejects.toThrow(/已关闭/);
      await expect(registerPending(harness, project.id)).rejects.toThrow(/已关闭/);
      await expect(
        harness.artifacts.transitionArtifact(project.id, artifact.id, {
          expectedRevision: 1,
          outcome: { status: 'failed', reason: 'x' },
        }),
      ).rejects.toThrow(/已关闭/);
      await expect(harness.artifacts.getArtifactInputRef(project.id, artifact.id)).rejects.toThrow(/已关闭/);

      const store = harness.artifacts as unknown as Record<string, unknown>;
      for (const key of Object.keys(store)) {
        expect(String(key)).not.toMatch(/database|db/i);
        expect(store[key]).not.toBe(harness.session.database);
      }
    });
  });
});

describe('F-012 listArtifacts bounded pagination via real SQLite port', () => {
  it('lists project artifacts page by page ordered by id, isolated per project', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await createProject(harness, '项目A');
        const projectB = await createProject(harness, '项目B');
        const ids: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          const artifact = await registerPending(harness, projectA.id, {
            locator: `artifacts/${projectA.id}/report-${index}`,
          });
          ids.push(artifact.id);
        }
        await registerPending(harness, projectB.id, { locator: 'logs/b-1' });

        const collected: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await harness.artifacts.listArtifacts(projectA.id, {
            limit: 2,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          collected.push(...page.records.map((record) => record.id));
          if (page.nextCursor === null) {
            break;
          }
          cursor = page.nextCursor;
        }
        expect(collected).toEqual([...ids].sort());
        // 记录字段逐项完整（与 getArtifact 相同的行映射）。
        const first = await harness.artifacts.getArtifact(projectA.id, collected[0]!);
        const page = await harness.artifacts.listArtifacts(projectA.id, { limit: 1 });
        expect(page.records[0]).toEqual(first);
        // 项目隔离：B 只有自己的制品。
        const pageB = await harness.artifacts.listArtifacts(projectB.id);
        expect(pageB.records.length).toBe(1);
        expect(pageB.records[0]?.projectId).toBe(projectB.id);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects missing projects and illegal pagination options with zero persisted side effects', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness);
        await registerPending(harness, project.id);
        expect(countArtifacts(harness.session)).toBe(1);
        await expectStorageError('not_found', () =>
          harness.artifacts.listArtifacts('11111111-2222-3333-4444-555555555555'),
        );
        await expectStorageError('validation', () =>
          harness.artifacts.listArtifacts(project.id, { limit: 0 }),
        );
        await expectStorageError('validation', () =>
          harness.artifacts.listArtifacts(project.id, { cursor: 'a/b' }),
        );
        await expectStorageError('validation', () =>
          harness.artifacts.listArtifacts(project.id, { unknown: 1 }),
        );
        expect(countArtifacts(harness.session)).toBe(1);
      } finally {
        harness.close();
      }
    });
  });
});
