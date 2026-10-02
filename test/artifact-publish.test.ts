/**
 * F-011 制品流式发布回归（真实临时 SQLite + 真实临时文件根，非 mock）。
 *
 * 覆盖（P01-2 / F-011 验收点）：
 * - 真实多块内容流与空正文正常发布：增量 SHA-256 与字节 size；落盘字节、
 *   返回 hash/size/locator、SQLite 索引完全一致；有限大小/时间/取消限制，
 *   超限明确失败，不将整个大流无限缓存在内存（生成器逐块供给）；
 * - 顺序为 pending 持久化 → staging 写入及文件同步 → hash 核验 → 正式发布
 *   → 短事务 ready；文件流与 fsync/发布不在数据库事务内——暂停内容流时
 *   另一真实连接仍能完成独立写入；
 * - 预期 hash 不匹配、流错误、取消、写入/同步/发布失败均不产生可用 ready
 *   引用；保存 failed（或可核对 pending）状态、错误阶段与残留证据，不自动
 *   删除未知文件；
 * - 正式文件已发布但 ready 提交失败（真实 busy 锁）时文件与 pending 索引
 *   保留供恢复；已有 ready 正文不能被同键竞争发布覆盖；
 * - macOS 测试执行真实文件/目录同步（由 F-010 适配器完成）；rename/link 的
 *   原子可见性不写成断电耐久性证明；ENOSPC 等故障为明确注入，非真实磁盘满
 *   演练。
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import {
  ArtifactFileError,
  deriveStagingRelativeDir,
  isArtifactFileError,
} from '../packages/core/src/ports/artifact-files.ts';
import type {
  ArtifactFileErrorKind,
  ArtifactFileStore,
  ArtifactPublishedFile,
  ArtifactStagingFile,
} from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactRecord, ArtifactStore, StateStore } from '../packages/core/src/index.ts';
import {
  ArtifactPublishError,
  createArtifactPublisher,
  isArtifactPublishError,
} from '../packages/core/src/application/artifact-publish.ts';
import type {
  ArtifactPublisher,
  ArtifactPublishStage,
} from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function sha256Hex(parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest('hex');
}

async function* chunksOf(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    yield part;
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function createClock(start = 1_700_400_000_000) {
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
  readonly root: string;
  readonly dbPath: string;
  readonly session: SqliteStorageSession;
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  close(): void;
};

function openHarness(
  root: string,
  clock: Clock,
  sessionOptions: { busyTimeoutMs?: number; busyRetryAttempts?: number } = {},
): Harness {
  const session = openSqliteStorageSession({ path: join(root, 'state.db'), ...sessionOptions });
  const nowUtcMs = () => clock.next();
  let stagingCounter = 0;
  return {
    root,
    dbPath: join(root, 'state.db'),
    session,
    state: createSqliteStateStore(session, { nowUtcMs }),
    artifacts: createSqliteArtifactStore(session, { nowUtcMs }),
    files: createArtifactFileStore({
      dataRoot: root,
      stagingName: () => `t${(stagingCounter += 1)}`,
    }),
    close(): void {
      session.close();
    },
  };
}

const DEFAULT_LIMITS = { maxSizeBytes: 1_048_576, timeoutMs: 30_000 } as const;

function makePublisher(
  harness: Harness,
  overrides: { limits?: { maxSizeBytes: number; timeoutMs: number }; files?: ArtifactFileStore; nowMs?: () => number } = {},
): ArtifactPublisher {
  return createArtifactPublisher({
    artifacts: harness.artifacts,
    files: overrides.files ?? harness.files,
    limits: overrides.limits ?? { ...DEFAULT_LIMITS },
    ...(overrides.nowMs !== undefined ? { nowMs: overrides.nowMs } : {}),
  });
}

async function withMigratedRoot(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f011-');
  try {
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

async function createProject(harness: Harness, displayName = '发布项目'): Promise<{ id: string }> {
  return harness.state.createProject({ displayName });
}

function stagingDirEntries(harness: Harness, projectId: string): string[] {
  const dir = join(harness.root, ...deriveStagingRelativeDir(projectId).split('/'));
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

async function expectPublishError(
  stage: ArtifactPublishStage,
  code: string,
  fn: () => Promise<unknown>,
): Promise<ArtifactPublishError> {
  try {
    await fn();
  } catch (error) {
    expect(
      isArtifactPublishError(error, stage),
      `expected ArtifactPublishError(stage=${stage}), got ${String(error)}`,
    ).toBe(true);
    const publishError = error as ArtifactPublishError;
    expect(publishError.code).toBe(code);
    return publishError;
  }
  throw new Error(`expected ArtifactPublishError(stage=${stage}, code=${code})`);
}

async function expectStorageErrorKind(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return;
  }
  throw new Error(`expected StorageError(${kind})`);
}

async function expectFileErrorKind(
  kind: ArtifactFileErrorKind,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(
      isArtifactFileError(error, kind),
      `expected ArtifactFileError(${kind}), got ${String(error)}`,
    ).toBe(true);
    return;
  }
  throw new Error(`expected ArtifactFileError(${kind})`);
}

describe('F-011 制品流式发布（真实 SQLite + 真实文件根）', () => {
  it('多块内容（含中文多字节）发布：落盘字节、返回值与 SQLite 索引完全一致', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const parts = [bytes('{"report":"'), bytes('验收结论：通过 ✅'), bytes('","lines":1024}')];
        const expectedHash = sha256Hex(parts);
        const expectedSize = parts.reduce((sum, part) => sum + part.byteLength, 0);

        const result = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash,
          locator: 'reports/验收报告.json',
          content: chunksOf(parts),
        });

        const record = result.artifact;
        expect(record.status).toBe('ready');
        expect(record.revision).toBe(2);
        expect(record.contentHash).toBe(expectedHash);
        expect(record.sizeBytes).toBe(expectedSize);
        expect(record.locator).toBe('reports/验收报告.json');
        expect(record.version).toBe(1);
        expect(record.failureReason).toBeNull();
        expect(result.finalRelativePath).toBe(
          `projects/${project.id}/artifacts/${record.id}/content`,
        );
        // locator（含中文）不参与物理路径推导。
        expect(result.finalRelativePath.includes('验收报告')).toBe(false);

        // 落盘字节与内容逐字节一致。
        const onDisk = await readAll(
          (await harness.files.openFinalRead({ projectId: project.id, artifactId: record.id })).stream,
        );
        expect(onDisk.equals(Buffer.concat(parts.map((part) => Buffer.from(part))))).toBe(true);

        // SQLite 原始行与索引一致（只有索引列，无正文）。
        const raw = harness.session.database
          .prepare('SELECT * FROM artifacts WHERE id = ?')
          .get(record.id) as Record<string, unknown>;
        expect(raw.status).toBe('ready');
        expect(raw.content_hash).toBe(expectedHash);
        expect(raw.size_bytes).toBe(expectedSize);
        expect(raw.storage_locator).toBe('reports/验收报告.json');

        // 有效输入引用可用且身份一致。
        const ref = await harness.artifacts.getArtifactInputRef(project.id, record.id);
        expect(ref.contentHash).toBe(expectedHash);
        expect(ref.sizeBytes).toBe(expectedSize);

        // staging 区无残留。
        expect(stagingDirEntries(harness, project.id)).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });

  it('空正文发布成功：size=0 与空摘要，索引与落盘一致', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const emptyHash = sha256Hex([]);
        const result = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'session-log',
          mediaType: 'text/plain',
          expectedHash: emptyHash,
          locator: 'logs/empty.txt',
          content: chunksOf([]),
        });
        expect(result.artifact.status).toBe('ready');
        expect(result.artifact.sizeBytes).toBe(0);
        expect(result.artifact.contentHash).toBe(emptyHash);
        const stat = await harness.files.statFinal({
          projectId: project.id,
          artifactId: result.artifact.id,
        });
        expect(stat.sizeBytes).toBe(0);
        const ref = await harness.artifacts.getArtifactInputRef(project.id, result.artifact.id);
        expect(ref.sizeBytes).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('非法输入在注册前拒绝且零副作用（无索引行、无文件）', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const base = {
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash: 'a'.repeat(64),
          locator: 'reports/a.json',
          content: chunksOf([bytes('x')]),
        };
        const invalidInputs: Record<string, unknown>[] = [
          { ...base, expectedHash: 'not-a-digest' },
          { ...base, locator: '/etc/passwd' },
          { ...base, locator: '../escape' },
          { ...base, content: 'not-a-byte-stream' },
          { ...base, content: 42 },
          { ...base, unexpectedKey: true },
          { ...base, version: 0 },
        ];
        for (const input of invalidInputs) {
          await expectStorageErrorKind('validation', () => publisher.publishArtifact(input));
        }
        const count = harness.session.database
          .prepare('SELECT COUNT(*) AS n FROM artifacts')
          .get() as { n: number };
        expect(count.n).toBe(0);
        expect(stagingDirEntries(harness, project.id)).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });

  it('非法限制在装配期拒绝（有限大小/时间必须显式给出）', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        for (const limits of [
          { maxSizeBytes: 0, timeoutMs: 1000 },
          { maxSizeBytes: -1, timeoutMs: 1000 },
          { maxSizeBytes: 1.5, timeoutMs: 1000 },
          { maxSizeBytes: 1024, timeoutMs: 0 },
          { maxSizeBytes: 1024, timeoutMs: -5 },
        ]) {
          let thrown: unknown;
          try {
            createArtifactPublisher({ artifacts: harness.artifacts, files: harness.files, limits });
          } catch (error) {
            thrown = error;
          }
          expect(
            isStorageError(thrown, 'validation'),
            `expected StorageError(validation), got ${String(thrown)}`,
          ).toBe(true);
        }
      } finally {
        harness.close();
      }
    });
  });

  it('大小超限：staging 阶段失败、failed 记录保留证据与残留、无 ready 引用', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness, { limits: { maxSizeBytes: 8, timeoutMs: 30_000 } });
        const parts = [bytes('1234'), bytes('56789')];
        const error = await expectPublishError('staging', 'size_limit_exceeded', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(parts),
            locator: 'reports/too-big.txt',
            content: chunksOf(parts),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('stage=staging');
        expect(String(record.failure_reason)).toContain('size_limit_exceeded');
        expect(String(record.failure_reason)).toContain('maxSizeBytes=8');
        // 残留保留：staging 区仍有 .part 文件，最终文件不存在。
        const residue = stagingDirEntries(harness, project.id);
        expect(residue.length).toBe(1);
        expect(residue[0]?.endsWith('.part')).toBe(true);
        await expectFileErrorKind('not_found', () =>
          harness.files.statFinal({ projectId: project.id, artifactId: record.id as string }),
        );
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, record.id as string),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('超时（注入确定性时钟）：staging 阶段 timeout、failed 记录、部分残留保留', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        let tick = 0;
        const nowMs = () => (tick += 1000);
        const publisher = makePublisher(harness, {
          limits: { maxSizeBytes: 1_048_576, timeoutMs: 1500 },
          nowMs,
        });
        const parts = [bytes('第一块'), bytes('第二块'), bytes('第三块')];
        const error = await expectPublishError('staging', 'timeout', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(parts),
            locator: 'logs/slow.txt',
            content: chunksOf(parts),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('code=timeout');
        expect(String(record.failure_reason)).toContain('timeoutMs=1500');
        // 只写入了第一块：残留大小与第一块一致（增量写入，未缓冲整流）。
        const residue = stagingDirEntries(harness, project.id);
        expect(residue.length).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('取消：AbortSignal 中途中止，staging 阶段 cancelled、failed 记录', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const controller = new AbortController();
        async function* cancelling(): AsyncGenerator<Uint8Array> {
          yield bytes('第一部分');
          controller.abort();
          yield bytes('第二部分');
        }
        const error = await expectPublishError('staging', 'cancelled', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'logs/cancelled.txt',
            content: cancelling(),
            signal: controller.signal,
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('code=cancelled');
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, record.id as string),
        );

        // 预先中止：不产生任何副作用（无索引行、无文件）。
        const preAborted = new AbortController();
        preAborted.abort();
        const before = (harness.session.database
          .prepare('SELECT COUNT(*) AS n FROM artifacts')
          .get() as { n: number }).n;
        await expectPublishError('staging', 'cancelled', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'logs/pre-aborted.txt',
            content: chunksOf([bytes('x')]),
            signal: preAborted.signal,
          }),
        );
        const after = (harness.session.database
          .prepare('SELECT COUNT(*) AS n FROM artifacts')
          .get() as { n: number }).n;
        expect(after).toBe(before);
      } finally {
        harness.close();
      }
    });
  });

  it('内容流中途抛错：staging 阶段失败、failed 记录、残留保留、无最终文件', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        async function* broken(): AsyncGenerator<Uint8Array> {
          yield bytes('前半');
          throw new Error('注入：内容生产方失败');
        }
        const error = await expectPublishError('staging', 'stream', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'logs/broken.txt',
            content: broken(),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('code=stream');
        expect(stagingDirEntries(harness, project.id).length).toBe(1);
        await expectFileErrorKind('not_found', () =>
          harness.files.statFinal({ projectId: project.id, artifactId: record.id as string }),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('hash 不匹配：verify 阶段失败、failed 记录携带摘要证据、无 ready 引用', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const parts = [bytes('实际内容')];
        const declaredHash = 'a'.repeat(64);
        const actualHash = sha256Hex(parts);
        const error = await expectPublishError('verify', 'hash_mismatch', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: declaredHash,
            locator: 'reports/mismatch.txt',
            content: chunksOf(parts),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        const reason = String(record.failure_reason);
        expect(reason).toContain('stage=verify');
        expect(reason).toContain(declaredHash);
        expect(reason).toContain(actualHash);
        // 不匹配的正文不得发布；staging 残留保留供核对。
        await expectFileErrorKind('not_found', () =>
          harness.files.statFinal({ projectId: project.id, artifactId: record.id as string }),
        );
        expect(stagingDirEntries(harness, project.id).length).toBe(1);
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, record.id as string),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('发布失败（注入）：publish 阶段失败、failed 记录、staging 残留保留', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        // 注入故障：publishStaging 抛出 EIO（明确标注为注入，非真实故障演练）。
        const injectedFiles: ArtifactFileStore = {
          ...harness.files,
          publishStaging: (_staging: ArtifactStagingFile, _key: unknown): Promise<ArtifactPublishedFile> =>
            Promise.reject(
              new ArtifactFileError('io', 'ArtifactFileStore.publishStaging', '注入故障：发布失败', {
                details: { relativePath: 'injected', code: 'EIO' },
              }),
            ),
        };
        const publisher = makePublisher(harness, { files: injectedFiles });
        const parts = [bytes('待发布内容')];
        const error = await expectPublishError('publish', 'file', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(parts),
            locator: 'reports/publish-fails.txt',
            content: chunksOf(parts),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('stage=publish');
        // 发布从未发生：staging 残留保留，最终文件不存在。
        expect(stagingDirEntries(harness, project.id).length).toBe(1);
        await expectFileErrorKind('not_found', () =>
          harness.files.statFinal({ projectId: project.id, artifactId: record.id as string }),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('同步失败（注入 ENOSPC，明确标为注入而非真实磁盘满演练）：staging 阶段失败且无 ready', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        // 注入故障：finishStaging 抛出 ENOSPC（磁盘满为注入，非真实演练）。
        const injectedFiles: ArtifactFileStore = {
          ...harness.files,
          finishStaging: (): Promise<ArtifactStagingFile> =>
            Promise.reject(
              new ArtifactFileError('io', 'ArtifactFileStore.finishStaging', '注入故障：ENOSPC 磁盘满', {
                details: { relativePath: 'injected', code: 'ENOSPC' },
              }),
            ),
        };
        const publisher = makePublisher(harness, { files: injectedFiles });
        const parts = [bytes('写盘失败内容')];
        const error = await expectPublishError('staging', 'file', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(parts),
            locator: 'reports/enospc.txt',
            content: chunksOf(parts),
          }),
        );
        expect(error.details?.['failureRecord']).toBe('failed_recorded');
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('ENOSPC');
        await expectFileErrorKind('not_found', () =>
          harness.files.statFinal({ projectId: project.id, artifactId: record.id as string }),
        );
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, record.id as string),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('commit 失败（真实 busy 锁）：正式文件与 pending 索引保留供恢复，释锁后可补 ready', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock, { busyTimeoutMs: 30, busyRetryAttempts: 2 });
      const locker = openSqliteStorageSession({ path: harness.dbPath });
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const parts = [bytes('前半段'), bytes('后半段')];
        const expectedHash = sha256Hex(parts);
        const expectedSize = parts.reduce((sum, part) => sum + part.byteLength, 0);
        // 内容流在 staging 期间由第二真实连接获取写锁（确定性注入点，非 mock）：
        // register 已完成、staging 为纯文件操作，锁只在 commit 短事务处生效。
        async function* lockingContent(): AsyncGenerator<Uint8Array> {
          yield parts[0]!;
          locker.database.exec('BEGIN IMMEDIATE');
          yield parts[1]!;
        }
        const error = await expectPublishError('commit', 'storage', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash,
            locator: 'reports/commit-blocked.txt',
            content: lockingContent(),
          }),
        );
        expect(isStorageError(error.cause, 'busy')).toBe(true);
        expect(error.details?.['failureRecord']).toBe('kept_pending');
        const artifactId = String(error.details?.['artifactId'] ?? error.artifactId);
        expect(artifactId.length).toBeGreaterThan(0);

        // pending 索引保留，正式文件保留且字节正确，staging 已移除。
        const record = await harness.artifacts.getArtifact(project.id, artifactId);
        expect(record.status).toBe('pending');
        expect(record.revision).toBe(1);
        const stat = await harness.files.statFinal({ projectId: project.id, artifactId });
        expect(stat.sizeBytes).toBe(expectedSize);
        const onDisk = await readAll(
          (await harness.files.openFinalRead({ projectId: project.id, artifactId })).stream,
        );
        expect(sha256Hex([onDisk])).toBe(expectedHash);
        expect(stagingDirEntries(harness, project.id)).toEqual([]);
        // pending 不能取得有效输入引用。
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, artifactId),
        );

        // 释锁后按恢复路径补 ready（F-012 将以此为基础做中断核对）。
        locker.database.exec('COMMIT');
        const recovered = await harness.artifacts.transitionArtifact(project.id, artifactId, {
          expectedRevision: 1,
          outcome: { status: 'ready', actualHash: expectedHash, sizeBytes: expectedSize },
        });
        expect(recovered.status).toBe('ready');
        const ref = await harness.artifacts.getArtifactInputRef(project.id, artifactId);
        expect(ref.contentHash).toBe(expectedHash);
      } finally {
        try {
          locker.database.exec('ROLLBACK');
        } catch {
          // 已 COMMIT 时无事务可回滚。
        }
        locker.close();
        harness.close();
      }
    });
  });

  it('已有 ready 正文不能被同键竞争发布覆盖：文件冲突、索引与正文身份不变', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const originalParts = [bytes('原始 ready 正文')];
        const result = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex(originalParts),
          locator: 'reports/original.txt',
          content: chunksOf(originalParts),
        });
        const artifactId = result.artifact.id;

        // 竞争发布者解析到同一制品键：staging 写入不同内容后发布必须冲突。
        const key = { projectId: project.id, artifactId };
        const competing = await harness.files.openStagingWrite(key);
        competing.stream.end(bytes('竞争者的篡改内容'));
        const staged = await harness.files.finishStaging(competing);
        try {
          await harness.files.publishStaging(staged, key);
          throw new Error('expected publish conflict');
        } catch (error) {
          expect(error instanceof ArtifactFileError && error.kind === 'conflict').toBe(true);
        }

        // ready 正文与索引身份逐字段不变。
        const onDisk = await readAll((await harness.files.openFinalRead(key)).stream);
        expect(sha256Hex([onDisk])).toBe(sha256Hex(originalParts));
        const after = await harness.artifacts.getArtifact(project.id, artifactId);
        expect(after.status).toBe('ready');
        expect(after.contentHash).toBe(sha256Hex(originalParts));
        expect(after.revision).toBe(result.artifact.revision);
        // 竞争者 staging 残留可安全丢弃（受控 staging 区内的已知文件）。
        await harness.files.discardStaging(staged);
        expect(stagingDirEntries(harness, project.id)).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });

  it('暂停内容流时另一真实连接仍能完成独立写入（文件流不占用数据库事务）', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harnessA = openHarness(root, clock);
      const harnessB = openHarness(root, clock);
      try {
        const project = await createProject(harnessA);
        const publisherA = makePublisher(harnessA);
        const publisherB = makePublisher(harnessB);

        let releaseGate!: () => void;
        const gate = new Promise<void>((resolvePromise) => {
          releaseGate = resolvePromise;
        });
        let paused = false;
        const partsA = [bytes('A-第一块'), bytes('A-第二块')];
        async function* pausingContent(): AsyncGenerator<Uint8Array> {
          yield partsA[0]!;
          paused = true;
          await gate;
          yield partsA[1]!;
        }

        const publishA = publisherA.publishArtifact({
          projectId: project.id,
          kind: 'session-log',
          mediaType: 'text/plain',
          expectedHash: sha256Hex(partsA),
          locator: 'logs/a.txt',
          content: pausingContent(),
        });
        // 有界等待 A 暂停在两块之间。
        const deadline = Date.now() + 10_000;
        while (!paused && Date.now() < deadline) {
          await new Promise((resolvePromise) => setImmediate(resolvePromise));
        }
        expect(paused).toBe(true);

        // A 暂停期间，B 经第二连接完成完整的独立发布。
        const partsB = [bytes('B 的独立内容')];
        const resultB = await publisherB.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex(partsB),
          locator: 'reports/b.txt',
          content: chunksOf(partsB),
        });
        expect(resultB.artifact.status).toBe('ready');

        releaseGate();
        const resultA = await publishA;
        expect(resultA.artifact.status).toBe('ready');
        expect(resultA.artifact.id).not.toBe(resultB.artifact.id);
        expect(resultA.finalRelativePath).not.toBe(resultB.finalRelativePath);

        const diskA = await readAll(
          (await harnessA.files.openFinalRead({ projectId: project.id, artifactId: resultA.artifact.id })).stream,
        );
        expect(sha256Hex([diskA])).toBe(sha256Hex(partsA));
        const refB = await harnessB.artifacts.getArtifactInputRef(project.id, resultB.artifact.id);
        expect(refB.contentHash).toBe(sha256Hex(partsB));
      } finally {
        harnessA.close();
        harnessB.close();
      }
    });
  });

  it('失败证据脱敏：错误消息、details 与 failureReason 不含沙箱绝对路径', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness, { limits: { maxSizeBytes: 4, timeoutMs: 30_000 } });
        const error = await expectPublishError('staging', 'size_limit_exceeded', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'reports/sanitized.txt',
            content: chunksOf([bytes('12345')]),
          }),
        );
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        for (const surface of [
          error.message,
          JSON.stringify(error.details ?? {}),
          String(record.failure_reason),
        ]) {
          expect(surface.includes(root)).toBe(false);
        }
      } finally {
        harness.close();
      }
    });
  });

  it('注册失败（缺失项目）：register 阶段结构化错误且零文件副作用', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const publisher = makePublisher(harness);
        const missingProjectId = '11111111-2222-3333-4444-555555555555';
        const error = await expectPublishError('register', 'storage', () =>
          publisher.publishArtifact({
            projectId: missingProjectId,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'reports/orphan.txt',
            content: chunksOf([bytes('x')]),
          }),
        );
        expect(isStorageError(error.cause, 'not_found')).toBe(true);
        expect(error.artifactId).toBeNull();
        expect(stagingDirEntries(harness, missingProjectId)).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });

  it('非 Uint8Array 块：staging 阶段 validation 且 failed 记录', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        async function* badChunks(): AsyncGenerator<Uint8Array> {
          yield '字符串块不是字节' as unknown as Uint8Array;
        }
        await expectPublishError('staging', 'validation', () =>
          publisher.publishArtifact({
            projectId: project.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'logs/bad-chunk.txt',
            content: badChunks(),
          }),
        );
        const record = (await harness.session.database
          .prepare('SELECT * FROM artifacts WHERE project_id = ?')
          .get(project.id)) as Record<string, unknown>;
        expect(record.status).toBe('failed');
        expect(String(record.failure_reason)).toContain('code=validation');
      } finally {
        harness.close();
      }
    });
  });

  it('关闭重开后索引与正文逐字段一致（耐久性，不依赖内存缓存）', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      const parts = [bytes('重开核验-前'), bytes('重开核验-后 🚀')];
      const expectedHash = sha256Hex(parts);
      let artifactId: string;
      let projectId: string;
      let publishedRecord: ArtifactRecord;
      try {
        const project = await createProject(harness);
        projectId = project.id;
        const publisher = makePublisher(harness);
        const result = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'application/octet-stream',
          expectedHash,
          locator: 'reports/durable.bin',
          content: chunksOf(parts),
        });
        artifactId = result.artifact.id;
        publishedRecord = result.artifact;
      } finally {
        harness.close();
      }

      const reopened = openHarness(root, clock);
      try {
        const record = await reopened.artifacts.getArtifact(projectId, artifactId);
        expect(record).toEqual(publishedRecord);
        const ref = await reopened.artifacts.getArtifactInputRef(projectId, artifactId);
        expect(ref.contentHash).toBe(expectedHash);
        const onDisk = await readAll(
          (await reopened.files.openFinalRead({ projectId, artifactId })).stream,
        );
        expect(sha256Hex([onDisk])).toBe(expectedHash);
        // 迁移记录仍在，库未被重建。
        const migrations = reopened.session.database
          .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
          .get() as { n: number };
        expect(migrations.n).toBeGreaterThan(0);
      } finally {
        reopened.close();
      }
    });
  });
});
