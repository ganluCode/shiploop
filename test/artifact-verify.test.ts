/**
 * F-012 制品中断核对与损坏诊断回归（真实临时 SQLite + 真实文件根 + 受控子进程，非 mock）。
 *
 * 覆盖（P01-2 / F-012 验收点，全部为真实断言）：
 * - 受控子进程在 pending 登记后 / staging 写入后 / 正式发布后但 ready 提交前
 *   三个确定性检查点中断；父进程核验退出码后重开真实库/文件根再核对；
 * - pending 且正式文件存在时校验项目/路径/预期 hash/size，通过后 CAS 补
 *   ready；只有 staging 或无文件时返回可理解的中断原因并保持不可用，
 *   不能只因文件存在就 ready（hash 不符给出 corrupt 诊断且不删除文件）；
 * - ready 正文缺失、大小不符、hash 被篡改分别返回明确 corrupt 诊断且有效
 *   读取失败；核对前的 ready 读取执行必要完整性检查，不把缺失正文当空内容；
 * - 扫描发现无索引正式文件与 staging 孤儿时生成含逻辑位置、原因、适用身份
 *   的恢复证据；原文件保留（kept_in_place），不立即删除未知文件，不跨项目
 *   自动绑定；链接条目不跟随访问根外哨兵；
 * - 核对重复执行不重复制造索引、不改变已核验内容身份；与发布状态更新竞争
 *   时使用 revision 重新核对，不让旧检查结果倒写；分批核对有界（分页与
 *   maxArtifacts/maxOrphans 上限），失败用例有有限超时与资源收尾。
 *
 * 竞争注入说明：verifyArtifact 与并发状态更新的竞争通过“一次性触发的
 * statFinal 包装 + 真实存储端口状态更新”确定性注入（与 F-011 busy 锁注入
 * 同一性质）；中断场景由真实子进程完成，不靠 mock 方法调用证明恢复。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { isArtifactFileError } from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactFileErrorKind, ArtifactFileStore } from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactStore, StateStore } from '../packages/core/src/index.ts';
import {
  ArtifactVerifyError,
  createArtifactVerifier,
  isArtifactVerifyError,
} from '../packages/core/src/application/artifact-verify.ts';
import type {
  ArtifactVerifyErrorCode,
  ArtifactVerifyReport,
  ArtifactVerifier,
} from '../packages/core/src/application/artifact-verify.ts';
import {
  ArtifactPublishError,
  createArtifactPublisher,
  isArtifactPublishError,
} from '../packages/core/src/application/artifact-publish.ts';
import type { ArtifactPublishStage } from '../packages/core/src/application/artifact-publish.ts';
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

function createClock(start = 1_700_500_000_000) {
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

async function withMigratedRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f012-');
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

async function createProject(harness: Harness, displayName = '核对项目'): Promise<{ id: string }> {
  return harness.state.createProject({ displayName });
}

function makeVerifier(
  harness: Harness,
  overrides: { files?: ArtifactFileStore; maxReadBytes?: number } = {},
): ArtifactVerifier {
  return createArtifactVerifier({
    artifacts: harness.artifacts,
    files: overrides.files ?? harness.files,
    limits: { maxReadBytes: overrides.maxReadBytes ?? 1_048_576 },
  });
}

function makePublisher(harness: Harness): ReturnType<typeof createArtifactPublisher> {
  return createArtifactPublisher({
    artifacts: harness.artifacts,
    files: harness.files,
    limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
  });
}

/** 经真实文件端口直接发布正文（不经发布用例），用于构造 pending+正式文件等恢复现场。 */
async function publishDirect(
  harness: Harness,
  key: { projectId: string; artifactId: string },
  content: Uint8Array,
): Promise<string> {
  const write = await harness.files.openStagingWrite(key);
  write.stream.write(content);
  write.stream.end();
  const staged = await harness.files.finishStaging(write);
  const published = await harness.files.publishStaging(staged, key);
  return published.relativePath;
}

/** 受控根内相对位置 → 绝对路径（仅测试断言用；产品代码不做该推导）。 */
function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function finalRelativePathOf(projectId: string, artifactId: string): string {
  return `projects/${projectId}/artifacts/${artifactId}/content`;
}

function countArtifacts(harness: Harness): number {
  return (
    harness.session.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }
  ).n;
}

function stagingFilesFor(harness: Harness, projectId: string, namePrefix: string): string[] {
  const dir = join(harness.root, 'staging', projectId);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(namePrefix))
      .sort();
  } catch {
    return [];
  }
}

async function expectVerifyError(
  code: ArtifactVerifyErrorCode,
  fn: () => Promise<unknown>,
): Promise<ArtifactVerifyError> {
  try {
    await fn();
  } catch (error) {
    expect(
      isArtifactVerifyError(error, code),
      `expected ArtifactVerifyError(code=${code}), got ${String(error)}`,
    ).toBe(true);
    return error as ArtifactVerifyError;
  }
  throw new Error(`expected ArtifactVerifyError(code=${code})`);
}

async function expectStorageErrorKind(kind: StorageErrorKind, fn: () => Promise<unknown>): Promise<void> {
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

const testDir = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(testDir, 'helpers', 'interrupt-publish-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

type InterruptCheckpoint = 'registered' | 'staged' | 'published';

const CHECKPOINT_EXIT: Record<InterruptCheckpoint, number> = {
  registered: 70,
  staged: 71,
  published: 72,
};

type ChildResult = {
  readonly artifactId: string;
  readonly stagingRelativePath?: string;
  readonly finalRelativePath?: string;
};

/** 启动受控子进程并在指定检查点中断；核验退出码与结果文件（有界等待）。 */
async function runInterruptedChild(config: {
  dbPath: string;
  dataRoot: string;
  projectId: string;
  kind: string;
  mediaType: string;
  expectedHash: string;
  locator: string;
  contentBase64: string;
  checkpoint: InterruptCheckpoint;
  resultFile: string;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; result: ChildResult }> {
  const child = spawn(
    process.execPath,
    ['--import', CHILD_REGISTER, CHILD_SCRIPT, JSON.stringify(config)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  try {
    const exit = await waitForExit(child, 60_000);
    if (exit.code !== CHECKPOINT_EXIT[config.checkpoint] || !existsSync(config.resultFile)) {
      throw new Error(
        `子进程未在检查点 ${config.checkpoint} 中断（exit=${String(exit.code)} signal=${String(exit.signal)}）：${stderr}`,
      );
    }
    return {
      exitCode: exit.code,
      signal: exit.signal,
      stderr,
      result: JSON.parse(readFileSync(config.resultFile, 'utf8')) as ChildResult,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

describe('F-012 制品中断核对与损坏诊断（真实 SQLite + 真实文件根）', () => {
  it('受控子进程三检查点中断后重开核对：no_content / staging_only（残留保留）/ pending+正式文件 CAS 补 ready', async () => {
    const content = bytes('中断核对正文：检查点演练 🚀');
    const expectedHash = sha256Hex([content]);
    for (const checkpoint of ['registered', 'staged', 'published'] as const) {
      await withMigratedRoot(async (root) => {
        const clock = createClock();
        // 父进程建项目后关闭会话；子进程独立连接同一真实库与文件根。
        const setup = openHarness(root, clock);
        let projectId: string;
        try {
          projectId = (await createProject(setup, `中断项目-${checkpoint}`)).id;
        } finally {
          setup.close();
        }

        const { exitCode, signal, stderr, result } = await runInterruptedChild({
          dbPath: join(root, 'state.db'),
          dataRoot: root,
          projectId,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash,
          locator: `reports/interrupt-${checkpoint}.json`,
          contentBase64: Buffer.from(content).toString('base64'),
          checkpoint,
          resultFile: join(root, `child-result-${checkpoint}.json`),
        });
        expect(exitCode).toBe(CHECKPOINT_EXIT[checkpoint]);
        expect(signal, stderr).toBeNull();
        expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/);

        // 重开真实库与文件根再核对（不依赖子进程内存状态）。
        const harness = openHarness(root, clock);
        try {
          const verifier = makeVerifier(harness);
          const report = await verifier.verifyArtifact(projectId, result.artifactId);
          expect(JSON.stringify(report).includes(root)).toBe(false);

          if (checkpoint === 'registered') {
            expect(report.kind).toBe('interrupted');
            expect(report.interruption?.reason).toBe('no_content');
            expect(report.status).toBe('pending');
            expect(report.revision).toBe(1);
            expect(report.stagingResidues).toEqual([]);
            await expectFileErrorKind('not_found', () =>
              harness.files.statFinal({ projectId, artifactId: result.artifactId }),
            );
            await expectStorageErrorKind('conflict', () =>
              harness.artifacts.getArtifactInputRef(projectId, result.artifactId),
            );
          } else if (checkpoint === 'staged') {
            expect(report.kind).toBe('interrupted');
            expect(report.interruption?.reason).toBe('staging_only');
            expect(report.status).toBe('pending');
            expect(report.revision).toBe(1);
            expect(result.stagingRelativePath).toBeDefined();
            expect(report.stagingResidues.map((entry) => entry.relativePath)).toEqual([
              result.stagingRelativePath,
            ]);
            // 中断原因可理解且残留保留：核对不删除未知文件，保持不可用。
            expect(existsSync(absoluteOf(root, result.stagingRelativePath!))).toBe(true);
            await expectFileErrorKind('not_found', () =>
              harness.files.statFinal({ projectId, artifactId: result.artifactId }),
            );
            await expectStorageErrorKind('conflict', () =>
              harness.artifacts.getArtifactInputRef(projectId, result.artifactId),
            );
          } else {
            // pending + 正式文件存在：校验 hash/size 后 CAS 补 ready。
            expect(report.kind).toBe('recovered_ready');
            expect(report.status).toBe('ready');
            expect(report.revision).toBe(2);
            expect(report.contentHash).toBe(expectedHash);
            expect(result.finalRelativePath).toBe(finalRelativePathOf(projectId, result.artifactId));
            const ref = await harness.artifacts.getArtifactInputRef(projectId, result.artifactId);
            expect(ref.contentHash).toBe(expectedHash);
            expect(ref.sizeBytes).toBe(content.byteLength);
            const onDisk = await readAll(
              (await harness.files.openFinalRead({ projectId, artifactId: result.artifactId })).stream,
            );
            expect(onDisk.equals(Buffer.from(content))).toBe(true);
            expect(stagingFilesFor(harness, projectId, result.artifactId)).toEqual([]);
            // 重复核对：verified_ready，不重复制造索引、不改变内容身份。
            const again = await verifier.verifyArtifact(projectId, result.artifactId);
            expect(again.kind).toBe('verified_ready');
            expect(again.status).toBe('ready');
            expect(again.revision).toBe(2);
            expect(again.contentHash).toBe(expectedHash);
            expect(countArtifacts(harness)).toBe(1);
          }
        } finally {
          harness.close();
        }
      });
    }
  });

  it('pending 且正式文件存在但摘要不符：corrupt 诊断、保持 pending 不覆盖、不删除文件、重复核对一致', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const good = bytes('登记时声明的正确正文');
        const bad = bytes('落盘的篡改正文');
        const record = await harness.artifacts.registerArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex([good]),
          locator: 'reports/pending-mismatch.txt',
        });
        await publishDirect(harness, { projectId: project.id, artifactId: record.id }, bad);

        const verifier = makeVerifier(harness);
        const report = await verifier.verifyArtifact(project.id, record.id);
        // 不能只因文件存在就 ready：摘要不符给出明确 corrupt 诊断。
        expect(report.kind).toBe('corrupt');
        expect(report.corruption?.kind).toBe('hash_mismatch');
        expect(report.corruption?.expectedHash).toBe(sha256Hex([good]));
        expect(report.corruption?.actualHash).toBe(sha256Hex([bad]));
        expect(report.status).toBe('pending');
        expect(report.revision).toBe(1);
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.getArtifactInputRef(project.id, record.id),
        );
        // 文件保留（不自动删除未知文件），字节不变。
        const onDisk = await readAll(
          (await harness.files.openFinalRead({ projectId: project.id, artifactId: record.id })).stream,
        );
        expect(onDisk.equals(Buffer.from(bad))).toBe(true);

        // 重复核对结果一致，不改变状态、不倒写。
        const again = await verifier.verifyArtifact(project.id, record.id);
        expect(again.kind).toBe('corrupt');
        expect(again.corruption?.kind).toBe('hash_mismatch');
        expect(again.revision).toBe(1);
        expect(again.status).toBe('pending');
      } finally {
        harness.close();
      }
    });
  });

  it('ready 正文缺失 / 大小不符 / hash 被篡改：三种明确 corrupt 诊断，有效读取失败且核对不改状态', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const publisher = makePublisher(harness);
        const original = bytes('0123456789ABCDEF');
        const published = await publisher.publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'application/octet-stream',
          expectedHash: sha256Hex([original]),
          locator: 'reports/corruption.bin',
          content: chunksOf([original]),
        });
        const artifactId = published.artifact.id;
        const finalRel = finalRelativePathOf(project.id, artifactId);
        const physical = absoluteOf(root, finalRel);

        // 缺失：正文被移除 → corrupt missing；读取失败而不是空内容。
        rmSync(physical);
        const missing = await makeVerifier(harness).verifyArtifact(project.id, artifactId);
        expect(missing.kind).toBe('corrupt');
        expect(missing.corruption?.kind).toBe('missing');
        expect(missing.corruption?.expectedHash).toBe(sha256Hex([original]));
        expect(missing.corruption?.expectedSizeBytes).toBe(original.byteLength);
        const readMissing = await expectVerifyError('corrupt', () =>
          makeVerifier(harness).readVerifiedContent(project.id, artifactId),
        );
        expect(readMissing.corruption?.kind).toBe('missing');
        expect(missing.revision).toBe(2);
        expect((await harness.artifacts.getArtifact(project.id, artifactId)).status).toBe('ready');

        // 大小不符：正文被截断 → corrupt size_mismatch。
        writeFileSync(physical, bytes('截断'));
        const sized = await makeVerifier(harness).verifyArtifact(project.id, artifactId);
        expect(sized.kind).toBe('corrupt');
        expect(sized.corruption?.kind).toBe('size_mismatch');
        expect(sized.corruption?.expectedSizeBytes).toBe(original.byteLength);
        expect(sized.corruption?.actualSizeBytes).toBe(bytes('截断').byteLength);
        const readSized = await expectVerifyError('corrupt', () =>
          makeVerifier(harness).readVerifiedContent(project.id, artifactId),
        );
        expect(readSized.corruption?.kind).toBe('size_mismatch');

        // hash 被篡改：同长度替换 → corrupt hash_mismatch（读取在流式核验后拒绝）。
        const tampered = bytes('FEDCBA9876543210');
        writeFileSync(physical, tampered);
        const hashed = await makeVerifier(harness).verifyArtifact(project.id, artifactId);
        expect(hashed.kind).toBe('corrupt');
        expect(hashed.corruption?.kind).toBe('hash_mismatch');
        expect(hashed.corruption?.expectedHash).toBe(sha256Hex([original]));
        expect(hashed.corruption?.actualHash).toBe(sha256Hex([tampered]));
        const readHashed = await expectVerifyError('corrupt', () =>
          makeVerifier(harness).readVerifiedContent(project.id, artifactId),
        );
        expect(readHashed.corruption?.kind).toBe('hash_mismatch');

        // 核对与读取失败都不改状态、不修改文件：ready 身份与篡改字节原样保留。
        const record = await harness.artifacts.getArtifact(project.id, artifactId);
        expect(record.status).toBe('ready');
        expect(record.revision).toBe(2);
        expect(record.contentHash).toBe(sha256Hex([original]));
        const onDisk = await readAll(
          (await harness.files.openFinalRead({ projectId: project.id, artifactId })).stream,
        );
        expect(onDisk.equals(Buffer.from(tampered))).toBe(true);

        // 重复核对与失败读取的报错脱敏：不含沙箱绝对路径。
        expect(JSON.stringify(hashed).includes(root)).toBe(false);
        expect(readHashed.message.includes(root)).toBe(false);
      } finally {
        harness.close();
      }
    });
  });

  it('readVerifiedContent：正常路径逐字节一致；pending 返回 conflict；超缓冲上限 size_limit_exceeded', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const parts = [bytes('完整性核验-前'), bytes('完整性核验-后 ✅')];
        const expectedHash = sha256Hex(parts);
        const published = await makePublisher(harness).publishArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash,
          locator: 'reports/verified-read.txt',
          content: chunksOf(parts),
        });
        const verifier = makeVerifier(harness);
        const content = await verifier.readVerifiedContent(project.id, published.artifact.id);
        expect(Buffer.from(content.content).equals(Buffer.concat(parts.map((part) => Buffer.from(part))))).toBe(true);
        expect(content.contentHash).toBe(expectedHash);
        expect(content.sizeBytes).toBe(parts.reduce((sum, part) => sum + part.byteLength, 0));
        expect(content.locator).toBe('reports/verified-read.txt');
        expect(content.relativePath).toBe(finalRelativePathOf(project.id, published.artifact.id));

        // pending 制品没有可读正文：conflict。
        const pending = await harness.artifacts.registerArtifact({
          projectId: project.id,
          kind: 'session-log',
          mediaType: 'text/plain',
          expectedHash: 'a'.repeat(64),
          locator: 'logs/pending.txt',
        });
        await expectVerifyError('conflict', () =>
          verifier.readVerifiedContent(project.id, pending.id),
        );

        // 超过显式缓冲上限：size_limit_exceeded（不无限缓存大正文）。
        const capped = makeVerifier(harness, { maxReadBytes: 4 });
        await expectVerifyError('size_limit_exceeded', () =>
          capped.readVerifiedContent(project.id, published.artifact.id),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('ready 正文被替换为符号链接：untrusted_file 诊断，不跟随访问根外哨兵，链接保留', async () => {
    await withMigratedRoot(async (root) => {
      const outside = createTempSandbox('shiploop-f012-outside-');
      try {
        const sentinelDir = join(outside.path, 'sentinel-dir');
        mkdirSync(sentinelDir);
        const clock = createClock();
        const harness = openHarness(root, clock);
        try {
          const project = await createProject(harness);
          const parts = [bytes('符号链接替换前的 ready 正文')];
          const published = await makePublisher(harness).publishArtifact({
            projectId: project.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(parts),
            locator: 'reports/symlinked.txt',
            content: chunksOf(parts),
          });
          const physical = absoluteOf(root, finalRelativePathOf(project.id, published.artifact.id));
          rmSync(physical);
          symlinkSync(sentinelDir, physical);

          const verifier = makeVerifier(harness);
          const report = await verifier.verifyArtifact(project.id, published.artifact.id);
          expect(report.kind).toBe('untrusted_file');
          expect(report.status).toBe('ready');
          expect(report.revision).toBe(2);
          expect(report.untrustedDetail).toContain('escape');
          // 根外哨兵未被访问；链接保留（不删除未知对象）。
          expect(readdirSync(sentinelDir)).toEqual([]);
          expect(lstatSync(physical).isSymbolicLink()).toBe(true);
          // 有效读取同样失败（不跟随链接）。
          const readError = await expectVerifyError('file', () =>
            verifier.readVerifiedContent(project.id, published.artifact.id),
          );
          expect(isArtifactFileError(readError.cause, 'escape')).toBe(true);
          expect(JSON.stringify(report).includes(root)).toBe(false);
          expect(JSON.stringify(report).includes(outside.path)).toBe(false);
        } finally {
          harness.close();
        }
      } finally {
        outside.cleanup();
      }
    });
  });

  it('与状态更新竞争：CAS 冲突后按 revision 重新核对，旧核对结果不倒写（failed / ready 两个方向）', async () => {
    // 方向一：核对期间并发状态更新先标 failed → 核对报告 failed_evidence，不倒写 ready。
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const content = bytes('并发竞争的正文');
        const record = await harness.artifacts.registerArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex([content]),
          locator: 'reports/race-failed.txt',
        });
        await publishDirect(harness, { projectId: project.id, artifactId: record.id }, content);

        // 确定性注入：核对首次 statFinal 时，真实存储端口先被并发状态更新标 failed
        // （一次性触发；模拟状态更新发生在核对读取与 CAS 提交之间）。
        let fired = false;
        const racingFiles: ArtifactFileStore = {
          ...harness.files,
          async statFinal(key: unknown) {
            if (!fired) {
              fired = true;
              await harness.artifacts.transitionArtifact(project.id, record.id, {
                expectedRevision: 1,
                outcome: { status: 'failed', reason: '并发状态更新胜出（注入）' },
              });
            }
            return harness.files.statFinal(key);
          },
        };
        const verifier = makeVerifier(harness, { files: racingFiles });
        const report = await verifier.verifyArtifact(project.id, record.id);
        expect(report.kind).toBe('failed_evidence');
        expect(report.status).toBe('failed');
        expect(report.revision).toBe(2);
        expect(report.failureReason).toContain('并发状态更新胜出');
        // 旧核对结果不倒写：以核对前 revision 转 ready 被 CAS 拒绝。
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, record.id, {
            expectedRevision: 1,
            outcome: { status: 'ready', actualHash: sha256Hex([content]), sizeBytes: content.byteLength },
          }),
        );
        // failed 为索引级终态：即使 revision 正确也不能再覆盖。
        await expectStorageErrorKind('conflict', () =>
          harness.artifacts.transitionArtifact(project.id, record.id, {
            expectedRevision: 2,
            outcome: { status: 'ready', actualHash: sha256Hex([content]), sizeBytes: content.byteLength },
          }),
        );
      } finally {
        harness.close();
      }
    });

    // 方向二：核对期间并发发布者先提交 ready → 重新核对 ready 完整性，报告 verified_ready。
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const project = await createProject(harness);
        const content = bytes('并发 ready 方向的正文');
        const record = await harness.artifacts.registerArtifact({
          projectId: project.id,
          kind: 'verification-report',
          mediaType: 'text/plain',
          expectedHash: sha256Hex([content]),
          locator: 'reports/race-ready.txt',
        });
        await publishDirect(harness, { projectId: project.id, artifactId: record.id }, content);

        let fired = false;
        const racingFiles: ArtifactFileStore = {
          ...harness.files,
          async statFinal(key: unknown) {
            if (!fired) {
              fired = true;
              await harness.artifacts.transitionArtifact(project.id, record.id, {
                expectedRevision: 1,
                outcome: {
                  status: 'ready',
                  actualHash: sha256Hex([content]),
                  sizeBytes: content.byteLength,
                },
              });
            }
            return harness.files.statFinal(key);
          },
        };
        const verifier = makeVerifier(harness, { files: racingFiles });
        const report = await verifier.verifyArtifact(project.id, record.id);
        expect(report.kind).toBe('verified_ready');
        expect(report.status).toBe('ready');
        expect(report.revision).toBe(2);
        expect(report.contentHash).toBe(sha256Hex([content]));
        // 不重复递增 revision、正文不变。
        const again = await makeVerifier(harness).verifyArtifact(project.id, record.id);
        expect(again.kind).toBe('verified_ready');
        expect(again.revision).toBe(2);
        const onDisk = await readAll(
          (await harness.files.openFinalRead({ projectId: project.id, artifactId: record.id })).stream,
        );
        expect(onDisk.equals(Buffer.from(content))).toBe(true);
      } finally {
        harness.close();
      }
    });
  });

  it('项目级批量核对与孤儿扫描：证据完整、原文件保留、不跨项目、重复执行一致、上限截断有界', async () => {
    await withMigratedRoot(async (root) => {
      const outside = createTempSandbox('shiploop-f012-outside-');
      try {
        const clock = createClock();
        const harness = openHarness(root, clock);
        try {
          const projectA = await createProject(harness, '项目A');
          const projectB = await createProject(harness, '项目B');
          const publisher = makePublisher(harness);

          // ready 制品（正式文件存在）。
          const readyParts = [bytes('A 的 ready 报告正文')];
          const ready = await publisher.publishArtifact({
            projectId: projectA.id,
            kind: 'verification-report',
            mediaType: 'text/plain',
            expectedHash: sha256Hex(readyParts),
            locator: 'reports/a-ready.txt',
            content: chunksOf(readyParts),
          });
          // pending 制品（无任何文件）。
          const pending = await harness.artifacts.registerArtifact({
            projectId: projectA.id,
            kind: 'session-log',
            mediaType: 'text/plain',
            expectedHash: 'a'.repeat(64),
            locator: 'logs/a-pending.txt',
          });
          // failed 制品 + staging 残留（发布者 hash 不匹配路径）。
          const failedParts = [bytes('与声明不符的内容')];
          const failedError = await expectPublishError('verify', 'hash_mismatch', () =>
            publisher.publishArtifact({
              projectId: projectA.id,
              kind: 'verification-report',
              mediaType: 'text/plain',
              expectedHash: 'b'.repeat(64),
              locator: 'reports/a-failed.txt',
              content: chunksOf(failedParts),
            }),
          );
          const failedId = String(failedError.details?.['artifactId']);

          // 孤儿正式文件（无索引制品目录 + 正文）。
          const orphanFinalId = randomUUID();
          await publishDirect(harness, { projectId: projectA.id, artifactId: orphanFinalId }, bytes('孤儿正式正文'));
          // 孤儿 staging 残留（无索引）。
          const orphanStagingId = randomUUID();
          const orphanWrite = await harness.files.openStagingWrite({
            projectId: projectA.id,
            artifactId: orphanStagingId,
          });
          orphanWrite.stream.write(bytes('孤儿 staging 残留'));
          orphanWrite.stream.end();
          await harness.files.finishStaging(orphanWrite);
          // 正式区未信任条目：指向根外目录的链接（不跟随）。
          const sentinelDir = join(outside.path, 'sentinel-dir');
          mkdirSync(sentinelDir);
          symlinkSync(sentinelDir, join(root, 'projects', projectA.id, 'artifacts', 'untrusted-link'));

          const verifier = makeVerifier(harness);
          expect(countArtifacts(harness)).toBe(3);

          // 分页核对（pageSize=2 强制真实分页）：三个已索引制品各核对一次，无重复。
          const report = await verifier.verifyProject(projectA.id, { pageSize: 2 });
          expect(report.orphanPolicy).toBe('kept_in_place');
          expect(report.truncated).toBe(false);
          const reportById = new Map(report.artifactReports.map((entry) => [entry.artifactId, entry] as const));
          expect(reportById.size).toBe(3);
          const readyReport = reportById.get(ready.artifact.id);
          expect(readyReport?.kind).toBe('verified_ready');
          expect(readyReport?.revision).toBe(2);
          const pendingReport = reportById.get(pending.id);
          expect(pendingReport?.kind).toBe('interrupted');
          expect(pendingReport?.interruption?.reason).toBe('no_content');
          const failedReport = reportById.get(failedId);
          expect(failedReport?.kind).toBe('failed_evidence');
          expect(failedReport?.failureReason).toContain('stage=verify');
          expect(failedReport?.stagingResidues.length).toBe(1);
          expect(failedReport?.stagingResidues[0]?.relativePath.startsWith(`staging/${projectA.id}/${failedId}.`)).toBe(true);

          // 孤儿证据：含逻辑位置、原因、适用身份；不跨项目自动绑定。
          expect(report.orphans.length).toBe(3);
          const finalOrphan = report.orphans.find((entry) => entry.reason === 'final_without_index');
          expect(finalOrphan).toBeDefined();
          expect(finalOrphan?.candidateArtifactId).toBe(orphanFinalId);
          expect(finalOrphan?.area).toBe('final');
          expect(finalOrphan?.relativePath).toBe(`projects/${projectA.id}/artifacts/${orphanFinalId}`);
          expect(finalOrphan?.projectId).toBe(projectA.id);
          const stagingOrphan = report.orphans.find((entry) => entry.reason === 'staging_without_index');
          expect(stagingOrphan?.candidateArtifactId).toBe(orphanStagingId);
          expect(stagingOrphan?.area).toBe('staging');
          expect(stagingOrphan?.relativePath.startsWith(`staging/${projectA.id}/${orphanStagingId}.`)).toBe(true);
          expect(stagingOrphan?.sizeBytes).toBe(bytes('孤儿 staging 残留').byteLength);
          const untrusted = report.orphans.find((entry) => entry.reason === 'untrusted_entry');
          expect(untrusted?.area).toBe('final');
          expect(untrusted?.candidateArtifactId).toBeNull();
          expect(untrusted?.sizeBytes).toBeNull();

          // 原文件保留（不立即删除未知文件）；链接未跟随（哨兵目录为空）。
          expect(existsSync(absoluteOf(root, `projects/${projectA.id}/artifacts/${orphanFinalId}/content`))).toBe(true);
          expect(stagingFilesFor(harness, projectA.id, orphanStagingId).length).toBe(1);
          expect(
            lstatSync(join(root, 'projects', projectA.id, 'artifacts', 'untrusted-link')).isSymbolicLink(),
          ).toBe(true);
          expect(readdirSync(sentinelDir)).toEqual([]);
          // 不重复制造索引。
          expect(countArtifacts(harness)).toBe(3);
          // 项目间隔离：B 无制品、无孤儿。
          const reportB = await verifier.verifyProject(projectB.id);
          expect(reportB.artifactReports).toEqual([]);
          expect(reportB.orphans).toEqual([]);
          expect(reportB.truncated).toBe(false);

          // 重复执行一致：孤儿仍保留仍上报，ready 内容身份不变，无新增索引。
          const again = await verifier.verifyProject(projectA.id, { pageSize: 2 });
          expect(again.orphans.length).toBe(3);
          expect(countArtifacts(harness)).toBe(3);
          const readyAgain = again.artifactReports.find((entry) => entry.artifactId === ready.artifact.id);
          expect(readyAgain?.kind).toBe('verified_ready');
          expect(readyAgain?.revision).toBe(2);
          expect(readyAgain?.contentHash).toBe(sha256Hex(readyParts));

          // 有界上限：maxArtifacts / maxOrphans 截断并给出 truncated 标志。
          const cappedArtifacts = await verifier.verifyProject(projectA.id, { maxArtifacts: 2 });
          expect(cappedArtifacts.truncated).toBe(true);
          expect(cappedArtifacts.artifactReports.length).toBe(2);
          const cappedOrphans = await verifier.verifyProject(projectA.id, { maxOrphans: 1 });
          expect(cappedOrphans.truncated).toBe(true);
          expect(cappedOrphans.orphans.length).toBe(1);

          // 报告脱敏：不含沙箱与哨兵绝对路径。
          expect(JSON.stringify(report).includes(root)).toBe(false);
          expect(JSON.stringify(report).includes(outside.path)).toBe(false);
        } finally {
          harness.close();
        }
      } finally {
        outside.cleanup();
      }
    });
  });

  it('校验与边界：缺失项目/制品、跨项目归属、非法参数；零持久化副作用', async () => {
    await withMigratedRoot(async (root) => {
      const clock = createClock();
      const harness = openHarness(root, clock);
      try {
        const projectA = await createProject(harness, '项目A');
        const projectB = await createProject(harness, '项目B');
        const record = await harness.artifacts.registerArtifact({
          projectId: projectA.id,
          kind: 'session-log',
          mediaType: 'text/plain',
          expectedHash: 'a'.repeat(64),
          locator: 'logs/boundary.txt',
        });
        const verifier = makeVerifier(harness);

        // 缺失项目 / 制品。
        const missingProjectId = '11111111-2222-3333-4444-555555555555';
        const missingArtifactId = '99999999-8888-7777-6666-555555555555';
        await expectVerifyError('not_found', () => verifier.verifyProject(missingProjectId));
        await expectVerifyError('not_found', () =>
          verifier.verifyArtifact(projectA.id, missingArtifactId),
        );
        // 跨项目归属：项目 B 请求项目 A 的制品。
        await expectVerifyError('ownership', () => verifier.verifyArtifact(projectB.id, record.id));
        // 非法参数。
        await expectVerifyError('validation', () =>
          verifier.verifyArtifact(projectA.id, '../not-an-id'),
        );
        for (const options of [
          { pageSize: 0 },
          { pageSize: 257 },
          { maxArtifacts: 0 },
          { maxOrphans: 0 },
          { unknownKey: true },
          'not-an-object',
        ]) {
          await expectVerifyError('validation', () => verifier.verifyProject(projectA.id, options));
        }
        // 装配校验：非法 limits / 依赖形态。
        let thrown: unknown;
        try {
          createArtifactVerifier({
            artifacts: harness.artifacts,
            files: harness.files,
            limits: { maxReadBytes: 0 },
          });
        } catch (error) {
          thrown = error;
        }
        expect(isStorageError(thrown, 'validation')).toBe(true);

        // 全部边界失败均无持久化副作用。
        expect(countArtifacts(harness)).toBe(1);
        // 空项目核对：空报告（正式/staging 区尚不存在 → 空页而非错误）。
        const emptyReport = await verifier.verifyProject(projectB.id);
        expect(emptyReport.artifactReports).toEqual([]);
        expect(emptyReport.orphans).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });
});
