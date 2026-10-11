/**
 * P03-2 / F-004 执行必需输入受控采集与校验读取回归
 * （真实临时 SQLite + 真实临时文件根 + 真实源文件树，非 mock；
 * 仅发布失败注入使用端口包装，明确标注）。
 *
 * 覆盖（F-004 验收点）：
 * - 可变文件来源经获准根 + realpath/no-follow 采集实际字节，复用
 *   ArtifactPublisher 发布为同项目不可变受管 Artifact（源绝对路径不当快照）；
 *   已有受管引用保留 projectId / Artifact 身份 / 版本 / hash / 大小 / 用途；
 * - 复用完整性验证读取：ready 状态、预期摘要、字节数与受控位置全部核验，
 *   缺失/篡改/pending/failed/跨项目一律明确失败，不静默省略、不修补引用
 *   hash、不读越界正文；
 * - 单项/总字节、引用数量与采集/读取时间边界显式有限；不扫描全部历史；
 * - 发布后修改/删除源文件不改变已捕获正文；重新采集生成新引用，旧制品
 *   字节与 hash 不变；发布失败保留可诊断证据（索引非 ready + 原因）；
 * - 秘密纪律：输入不允许内联正文/凭据字段，凭据只以引用表达；错误消息与
 *   details 不含绝对路径与正文内容；错误关联项目/Task/Artifact 身份；
 * - 可信项目模式：realpath/lstat/no-follow 检查与并发替换窗口由既有前提
 *   收窄，本用例不宣称强 OS 沙箱。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { deriveArtifactFinalRelativePath } from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactFileStore, ArtifactStagingFile, ArtifactPublishedFile } from '../packages/core/src/ports/artifact-files.ts';
import type { ArtifactStore, StateStore } from '../packages/core/src/index.ts';
import { createInputSourceFileReader } from '../packages/core/src/adapters/fs/input-source-files.ts';
import {
  EXECUTION_INPUT_ARTIFACT_KIND,
  EXECUTION_INPUT_LOCATOR_PREFIX,
  InputSourceError,
  isInputSourceError,
} from '../packages/core/src/ports/execution-input.ts';
import type { ExecutionInputRef } from '../packages/core/src/ports/execution-input.ts';
import {
  ExecutionInputError,
  createExecutionInputService,
  isExecutionInputError,
} from '../packages/core/src/application/execution-input.ts';
import type { ExecutionInputService } from '../packages/core/src/application/execution-input.ts';
import {
  ArtifactPublishError,
  createArtifactPublisher,
} from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const encoder = new TextEncoder();

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function createClock(start = 1_700_400_000_000, step = 1) {
  let current = start;
  return {
    next(): number {
      current += step;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

type Harness = {
  readonly root: string;
  readonly session: SqliteStorageSession;
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  close(): void;
};

function openHarness(root: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  const nowUtcMs = () => clock.next();
  return {
    root,
    session,
    state: createSqliteStateStore(session, { nowUtcMs }),
    artifacts: createSqliteArtifactStore(session, { nowUtcMs }),
    files: createArtifactFileStore({ dataRoot: root }),
    close(): void {
      session.close();
    },
  };
}

const DEFAULT_LIMITS = {
  maxItems: 8,
  maxItemBytes: 1_000_000,
  maxTotalBytes: 4_000_000,
  captureTimeoutMs: 30_000,
  readTimeoutMs: 30_000,
} as const;

type LimitOverrides = Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;

function makeService(
  harness: Harness,
  options: {
    roots: Record<string, string>;
    limits?: LimitOverrides;
    nowMs?: () => number;
    publisher?: ReturnType<typeof createArtifactPublisher>;
  },
): ExecutionInputService {
  const publisher =
    options.publisher ??
    createArtifactPublisher({
      artifacts: harness.artifacts,
      files: harness.files,
      limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
    });
  const verifier = createArtifactVerifier({
    artifacts: harness.artifacts,
    files: harness.files,
    limits: { maxReadBytes: 16_000_000 },
  });
  const sources = createInputSourceFileReader({ roots: options.roots });
  return createExecutionInputService({
    artifacts: harness.artifacts,
    publisher,
    verifier,
    sources,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
}

async function withHarness(
  fn: (context: {
    harness: Harness;
    sandboxRoot: string;
    sourceRoot: string;
    service: ExecutionInputService;
    projectId: string;
  }) => Promise<void>,
  options: { limits?: LimitOverrides; nowMs?: () => number } = {},
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f004-');
  try {
    const clock = createClock();
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    const sourceRoot = join(sandbox.path, 'source-root');
    mkdirSync(sourceRoot, { recursive: true });
    const harness = openHarness(sandbox.path, clock);
    try {
      const project = await harness.state.createProject({ displayName: '输入采集项目' });
      const service = makeService(harness, {
        roots: { repo: sourceRoot },
        ...(options.limits !== undefined ? { limits: options.limits } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      });
      await fn({ harness, sandboxRoot: sandbox.path, sourceRoot, service, projectId: project.id });
    } finally {
      harness.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

function finalFilePath(harness: Harness, projectId: string, artifactId: string): string {
  return join(
    harness.root,
    ...deriveArtifactFinalRelativePath({ projectId, artifactId }).split('/'),
  );
}

async function captureOne(
  service: ExecutionInputService,
  projectId: string,
  item: unknown,
  taskId = 'task-1',
): Promise<ExecutionInputRef> {
  const result = await service.captureRequiredInputs({
    projectId,
    taskId,
    items: [item],
  });
  expect(result.refs).toHaveLength(1);
  return result.refs[0] as ExecutionInputRef;
}

describe('P03-2 / F-004 受控采集（可变来源 → 不可变制品）', () => {
  it('文件来源采集实际字节并发布为同项目不可变制品，引用保留全部身份字段', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'requirements.md'), '# 需求\n必须支持审批。');
      const ref = await captureOne(service, projectId, {
        purpose: 'requirements',
        source: { kind: 'file', root: 'repo', relativePath: 'requirements.md' },
      });
      expect(ref.projectId).toBe(projectId);
      expect(ref.kind).toBe(EXECUTION_INPUT_ARTIFACT_KIND);
      expect(ref.purpose).toBe('requirements');
      expect(ref.version).toBe(1);
      expect(ref.contentHash).toBe(sha256Hex('# 需求\n必须支持审批。'));
      expect(ref.sizeBytes).toBe(encoder.encode('# 需求\n必须支持审批。').byteLength);
      expect(ref.locator).toBe(`${EXECUTION_INPUT_LOCATOR_PREFIX}/requirements`);
      expect(ref.mediaType).toBe('application/octet-stream');
      expect(ref.origin).toEqual({
        kind: 'file',
        root: 'repo',
        relativePath: 'requirements.md',
      });
      // 引用不得携带源文件绝对路径。
      expect(JSON.stringify(ref)).not.toContain(sourceRoot);
      // 索引与正文一致：ready、hash/size 与引用一致、落盘字节为捕获正文。
      const record = await harness.artifacts.getArtifact(projectId, ref.artifactId);
      expect(record.status).toBe('ready');
      expect(record.contentHash).toBe(ref.contentHash);
      expect(record.sizeBytes).toBe(ref.sizeBytes);
      const onDisk = await readFile(finalFilePath(harness, projectId, ref.artifactId));
      expect(onDisk.equals(encoder.encode('# 需求\n必须支持审批。'))).toBe(true);
    });
  });

  it('已有受管引用保留 projectId/Artifact 身份/版本/hash/大小/用途，且不新建制品', async () => {
    await withHarness(async ({ harness, service, projectId }) => {
      const publisher = createArtifactPublisher({
        artifacts: harness.artifacts,
        files: harness.files,
        limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
      });
      const content = encoder.encode('既有制品正文');
      const published = await publisher.publishArtifact({
        projectId,
        kind: 'verification-report',
        mediaType: 'text/markdown',
        expectedHash: createHash('sha256').update(content).digest('hex'),
        locator: 'reports/baseline.md',
        version: 3,
        content: [content],
      });
      const before = (await harness.artifacts.listArtifacts(projectId, { limit: 16 })).records.length;
      const ref = await captureOne(service, projectId, {
        purpose: '基线报告',
        source: { kind: 'artifact', artifactId: published.artifact.id },
      });
      expect(ref.artifactId).toBe(published.artifact.id);
      expect(ref.projectId).toBe(projectId);
      expect(ref.version).toBe(3);
      expect(ref.contentHash).toBe(published.artifact.contentHash);
      expect(ref.sizeBytes).toBe(published.artifact.sizeBytes);
      expect(ref.locator).toBe('reports/baseline.md');
      expect(ref.purpose).toBe('基线报告');
      expect(ref.origin).toEqual({ kind: 'artifact' });
      const after = (await harness.artifacts.listArtifacts(projectId, { limit: 16 })).records.length;
      expect(after).toBe(before);
    });
  });

  it('发布后修改或删除源文件不改变已捕获正文；重新采集生成新引用且旧制品不变', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      const file = join(sourceRoot, 'design.md');
      writeFileSync(file, 'v1 正文');
      const first = await captureOne(service, projectId, {
        purpose: 'design',
        source: { kind: 'file', root: 'repo', relativePath: 'design.md' },
      });
      // 修改源文件：已捕获引用仍读到 v1 正文。
      await writeFile(file, 'v2 正文（已改动）');
      const reread = await service.readRequiredInput(projectId, first);
      expect(Buffer.from(reread.content).toString('utf8')).toBe('v1 正文');
      // 重新采集生成新引用（新 artifactId 与新 hash）。
      const second = await captureOne(service, projectId, {
        purpose: 'design',
        source: { kind: 'file', root: 'repo', relativePath: 'design.md' },
      });
      expect(second.artifactId).not.toBe(first.artifactId);
      expect(second.contentHash).toBe(sha256Hex('v2 正文（已改动）'));
      // 旧制品保持原字节与 hash。
      const oldRecord = await harness.artifacts.getArtifact(projectId, first.artifactId);
      expect(oldRecord.contentHash).toBe(first.contentHash);
      const oldBytes = await readFile(finalFilePath(harness, projectId, first.artifactId));
      expect(oldBytes.toString('utf8')).toBe('v1 正文');
      // 删除源文件：旧引用仍然可读。
      await unlink(file);
      const afterDelete = await service.readRequiredInput(projectId, first);
      expect(Buffer.from(afterDelete.content).toString('utf8')).toBe('v1 正文');
    });
  });

  it('必需文件缺失明确失败：不静默省略、不产生引用，错误关联项目/Task/用途且不含绝对路径', async () => {
    await withHarness(async ({ service, projectId }) => {
      let error: unknown;
      try {
        await service.captureRequiredInputs({
          projectId,
          taskId: 'task-9',
          items: [
            { purpose: 'missing-input', source: { kind: 'file', root: 'repo', relativePath: 'absent.md' } },
          ],
        });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'not_found')).toBe(true);
      const typed = error as ExecutionInputError;
      expect(typed.projectId).toBe(projectId);
      expect(typed.taskId).toBe('task-9');
      expect(typed.purpose).toBe('missing-input');
      expect(typed.message).not.toContain('source-root');
      expect(JSON.stringify(typed.details ?? {})).not.toContain('source-root');
    });
  });

  it('目录穿越、绝对路径、反斜杠与空段一律 validation 拒绝（不读越界正文）', async () => {
    await withHarness(async ({ sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'ok.md'), 'ok');
      for (const relativePath of ['../outside.md', 'a/../../b.md', '/etc/passwd', 'a//b.md', 'a/./b.md']) {
        let error: unknown;
        try {
          await captureOne(service, projectId, {
            purpose: ' traversal ',
            source: { kind: 'file', root: 'repo', relativePath },
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'validation')).toBe(true);
      }
    });
  });

  it('符号链接叶与符号链接祖先越界均拒绝（escape），不跟随、不读取目标正文', async () => {
    const sandbox = createTempSandbox('shiploop-f004-link-');
    try {
      const clock = createClock();
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        await migrateSqliteStorage(session);
      } finally {
        session.close();
      }
      const sourceRoot = join(sandbox.path, 'source-root');
      const outsideDir = join(sandbox.path, 'outside');
      mkdirSync(sourceRoot, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'secret.txt'), '根外秘密正文');
      symlinkSync(join(outsideDir, 'secret.txt'), join(sourceRoot, 'leaf-link.txt'));
      symlinkSync(outsideDir, join(sourceRoot, 'dir-link'));
      const harness = openHarness(sandbox.path, clock);
      try {
        const project = await harness.state.createProject({ displayName: '链接项目' });
        const service = makeService(harness, { roots: { repo: sourceRoot } });
        for (const relativePath of ['leaf-link.txt', 'dir-link/secret.txt']) {
          let error: unknown;
          try {
            await captureOne(service, project.id, {
              purpose: 'escape',
              source: { kind: 'file', root: 'repo', relativePath },
            });
          } catch (caught) {
            error = caught;
          }
          expect(isExecutionInputError(error, 'source_unavailable')).toBe(true);
          expect((error as ExecutionInputError).details?.['reason']).toBe('escape');
          expect((error as ExecutionInputError).message).not.toContain('根外秘密正文');
        }
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('未获准根（unknown root）拒绝采集', async () => {
    await withHarness(async ({ service, projectId }) => {
      let error: unknown;
      try {
        await captureOne(service, projectId, {
          purpose: 'unknown-root',
          source: { kind: 'file', root: 'not-authorized', relativePath: 'a.md' },
        });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'source_unavailable')).toBe(true);
      expect((error as ExecutionInputError).details?.['reason']).toBe('unknown_root');
    });
  });

  it('pending/failed 引用明确失败（not_ready），不修补引用 hash、不伪装可用', async () => {
    await withHarness(async ({ harness, service, projectId }) => {
      const pending = await harness.artifacts.registerArtifact({
        projectId,
        kind: 'execution-input',
        mediaType: 'text/plain',
        expectedHash: 'ab'.repeat(32),
        locator: 'execution-inputs/pending-one',
      });
      const failed = await harness.artifacts.registerArtifact({
        projectId,
        kind: 'execution-input',
        mediaType: 'text/plain',
        expectedHash: 'cd'.repeat(32),
        locator: 'execution-inputs/failed-one',
      });
      await harness.artifacts.transitionArtifact(projectId, failed.id, {
        expectedRevision: failed.revision,
        outcome: { status: 'failed', reason: 'stage=verify; code=hash_mismatch' },
      });
      for (const [artifactId, status] of [
        [pending.id, 'pending'],
        [failed.id, 'failed'],
      ] as const) {
        let error: unknown;
        try {
          await captureOne(service, projectId, {
            purpose: 'not-ready',
            source: { kind: 'artifact', artifactId },
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'not_ready')).toBe(true);
        expect((error as ExecutionInputError).details?.['status']).toBe(status);
      }
    });
  });

  it('跨项目引用拒绝（ownership），不能仅凭全局 artifactId 放行', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'owned.md'), '项目 A 正文');
      const ref = await captureOne(service, projectId, {
        purpose: 'owned',
        source: { kind: 'file', root: 'repo', relativePath: 'owned.md' },
      });
      const other = await harness.state.createProject({ displayName: '项目 B' });
      let error: unknown;
      try {
        await service.captureRequiredInputs({
          projectId: other.id,
          items: [{ purpose: 'stolen', source: { kind: 'artifact', artifactId: ref.artifactId } }],
        });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'ownership')).toBe(true);
    });
  });

  it('引用数量、单项字节与总字节边界显式有限（limit_exceeded），不扫描全部历史', async () => {
    await withHarness(
      async ({ sourceRoot, service, projectId }) => {
        writeFileSync(join(sourceRoot, 'big.md'), 'x'.repeat(2048));
        // 单项超限。
        let error: unknown;
        try {
          await captureOne(service, projectId, {
            purpose: 'too-big',
            source: { kind: 'file', root: 'repo', relativePath: 'big.md' },
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'limit_exceeded')).toBe(true);
        expect((error as ExecutionInputError).details?.['limit']).toBe('maxItemBytes');
        // 引用数量超限。
        error = undefined;
        try {
          await service.captureRequiredInputs({
            projectId,
            items: [
              { purpose: 'one', source: { kind: 'file', root: 'repo', relativePath: 'big.md' } },
              { purpose: 'two', source: { kind: 'file', root: 'repo', relativePath: 'big.md' } },
            ],
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'limit_exceeded')).toBe(true);
        expect((error as ExecutionInputError).details?.['limit']).toBe('maxItems');
      },
      { limits: { maxItemBytes: 1024, maxItems: 1 } },
    );
    // 总字节边界：两个各 800B 的项超过 1000B 总量。
    await withHarness(
      async ({ sourceRoot, service, projectId }) => {
        writeFileSync(join(sourceRoot, 'a.md'), 'a'.repeat(800));
        writeFileSync(join(sourceRoot, 'b.md'), 'b'.repeat(800));
        let error: unknown;
        try {
          await service.captureRequiredInputs({
            projectId,
            items: [
              { purpose: 'a', source: { kind: 'file', root: 'repo', relativePath: 'a.md' } },
              { purpose: 'b', source: { kind: 'file', root: 'repo', relativePath: 'b.md' } },
            ],
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'limit_exceeded')).toBe(true);
        expect((error as ExecutionInputError).details?.['limit']).toBe('maxTotalBytes');
      },
      { limits: { maxItemBytes: 1024, maxTotalBytes: 1000 } },
    );
  });

  it('采集时间预算显式有限：超时明确失败（timeout），不无限等待', async () => {
    const sandbox = createTempSandbox('shiploop-f004-timeout-');
    try {
      const clock = createClock();
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        await migrateSqliteStorage(session);
      } finally {
        session.close();
      }
      const sourceRoot = join(sandbox.path, 'source-root');
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, 'slow.md'), 'z'.repeat(4096));
      const harness = openHarness(sandbox.path, clock);
      try {
        const project = await harness.state.createProject({ displayName: '超时项目' });
        // 注入时钟：起始之后每次调用跨越整个采集预算。
        let tick = 1_000;
        const service = makeService(harness, {
          roots: { repo: sourceRoot },
          limits: { captureTimeoutMs: 10 },
          nowMs: () => {
            tick += 100;
            return tick;
          },
        });
        let error: unknown;
        try {
          await captureOne(service, project.id, {
            purpose: 'slow',
            source: { kind: 'file', root: 'repo', relativePath: 'slow.md' },
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'timeout')).toBe(true);
        expect((error as ExecutionInputError).details?.['phase']).toBe('capture');
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('拒绝内联正文/凭据字段与未知键：秘密不作为配置或引用持久化，错误不回显秘密正文', async () => {
    await withHarness(async ({ service, projectId }) => {
      const secret = 'sk-live-secret-正文';
      let error: unknown;
      try {
        await captureOne(service, projectId, {
          purpose: 'inline-secret',
          content: secret,
          source: { kind: 'file', root: 'repo', relativePath: 'a.md' },
        });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'validation')).toBe(true);
      const typed = error as ExecutionInputError;
      expect(typed.message).not.toContain(secret);
      expect(JSON.stringify(typed.details ?? {})).not.toContain(secret);
      // 未知来源类别同样 fail-closed。
      error = undefined;
      try {
        await captureOne(service, projectId, {
          purpose: 'bad-kind',
          source: { kind: 'git', ref: 'HEAD' },
        });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'validation')).toBe(true);
      // 空 items 与重复用途不静默省略。
      error = undefined;
      try {
        await service.captureRequiredInputs({ projectId, items: [] });
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'validation')).toBe(true);
    });
  });

  it('发布失败保留可诊断证据：引用不可用、索引保留非 ready 状态与失败原因', async () => {
    const sandbox = createTempSandbox('shiploop-f004-pubfail-');
    try {
      const clock = createClock();
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        await migrateSqliteStorage(session);
      } finally {
        session.close();
      }
      const sourceRoot = join(sandbox.path, 'source-root');
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, 'fragile.md'), '即将发布失败的正文');
      const harness = openHarness(sandbox.path, clock);
      try {
        const project = await harness.state.createProject({ displayName: '发布失败项目' });
        // 明确注入：包装文件端口使 publishStaging 失败（非真实磁盘故障演练）。
        const failingFiles: ArtifactFileStore = {
          ...harness.files,
          publishStaging(_staging: ArtifactStagingFile, _key: unknown): Promise<ArtifactPublishedFile> {
            return Promise.reject(
              new ArtifactPublishError('publish', 'file', '注入：正式发布失败', {
                projectId: project.id,
                artifactId: null,
              }),
            );
          },
        };
        const publisher = createArtifactPublisher({
          artifacts: harness.artifacts,
          files: failingFiles,
          limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
        });
        const service = makeService(harness, { roots: { repo: sourceRoot }, publisher });
        let error: unknown;
        try {
          await captureOne(service, project.id, {
            purpose: 'fragile',
            source: { kind: 'file', root: 'repo', relativePath: 'fragile.md' },
          });
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'publish')).toBe(true);
        const typed = error as ExecutionInputError;
        expect(typed.projectId).toBe(project.id);
        expect(typeof typed.artifactId).toBe('string');
        // 诊断证据：索引保留 failed 状态与阶段化原因，引用不可用。
        const record = await harness.artifacts.getArtifact(project.id, typed.artifactId as string);
        expect(record.status).toBe('failed');
        expect(record.failureReason).toContain('stage=publish');
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

describe('P03-2 / F-004 校验读取（完整性核验 + 边界）', () => {
  it('正常读取返回原字节并核验身份一致', async () => {
    await withHarness(async ({ sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'spec.md'), '规格正文');
      const ref = await captureOne(service, projectId, {
        purpose: 'spec',
        source: { kind: 'file', root: 'repo', relativePath: 'spec.md' },
      });
      const result = await service.readRequiredInput(projectId, ref);
      expect(Buffer.from(result.content).toString('utf8')).toBe('规格正文');
      expect(result.ref.contentHash).toBe(ref.contentHash);
    });
  });

  it('ready 正文丢失 → corrupt(missing)，明确失败而不是返回空内容', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'lost.md'), '将被删除的正文');
      const ref = await captureOne(service, projectId, {
        purpose: 'lost',
        source: { kind: 'file', root: 'repo', relativePath: 'lost.md' },
      });
      await rm(finalFilePath(harness, projectId, ref.artifactId));
      let error: unknown;
      try {
        await service.readRequiredInput(projectId, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'corrupt')).toBe(true);
      const typed = error as ExecutionInputError;
      expect(typed.corruption?.kind).toBe('missing');
      expect(typed.artifactId).toBe(ref.artifactId);
    });
  });

  it('hash 篡改与 size 篡改分别明确失败（corrupt），不放行、不修补引用', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'target.md'), 'abcd');
      const ref = await captureOne(service, projectId, {
        purpose: 'target',
        source: { kind: 'file', root: 'repo', relativePath: 'target.md' },
      });
      const path = finalFilePath(harness, projectId, ref.artifactId);
      // 同长度改写 → hash_mismatch。
      await writeFile(path, 'wxyz');
      let error: unknown;
      try {
        await service.readRequiredInput(projectId, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'corrupt')).toBe(true);
      expect((error as ExecutionInputError).corruption?.kind).toBe('hash_mismatch');
      // 追加字节 → size_mismatch。
      await writeFile(path, 'abcde');
      error = undefined;
      try {
        await service.readRequiredInput(projectId, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'corrupt')).toBe(true);
      expect((error as ExecutionInputError).corruption?.kind).toBe('size_mismatch');
    });
  });

  it('被修补的引用 hash/size 明确失败（mismatch）：核验以权威索引为准', async () => {
    await withHarness(async ({ sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'pinned.md'), '固定正文');
      const ref = await captureOne(service, projectId, {
        purpose: 'pinned',
        source: { kind: 'file', root: 'repo', relativePath: 'pinned.md' },
      });
      const patchedHash: ExecutionInputRef = { ...ref, contentHash: 'ef'.repeat(32) };
      let error: unknown;
      try {
        await service.readRequiredInput(projectId, patchedHash);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'mismatch')).toBe(true);
      const patchedSize: ExecutionInputRef = { ...ref, sizeBytes: ref.sizeBytes + 1 };
      error = undefined;
      try {
        await service.readRequiredInput(projectId, patchedSize);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'mismatch')).toBe(true);
    });
  });

  it('pending/failed 引用读取明确失败（not_ready）', async () => {
    await withHarness(async ({ harness, service, projectId }) => {
      const pending = await harness.artifacts.registerArtifact({
        projectId,
        kind: 'execution-input',
        mediaType: 'text/plain',
        expectedHash: 'ab'.repeat(32),
        locator: 'execution-inputs/pending-read',
      });
      const ref: ExecutionInputRef = {
        projectId,
        artifactId: pending.id,
        kind: EXECUTION_INPUT_ARTIFACT_KIND,
        purpose: 'pending-read',
        version: 1,
        contentHash: 'ab'.repeat(32),
        sizeBytes: 1,
        locator: 'execution-inputs/pending-read',
        mediaType: 'text/plain',
        origin: { kind: 'artifact' },
      };
      let error: unknown;
      try {
        await service.readRequiredInput(projectId, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'not_ready')).toBe(true);
      expect((error as ExecutionInputError).details?.['status']).toBe('pending');
    });
  });

  it('跨项目读取拒绝（ownership）：引用项目与请求项目不一致', async () => {
    await withHarness(async ({ harness, sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'scope.md'), '项目内正文');
      const ref = await captureOne(service, projectId, {
        purpose: 'scope',
        source: { kind: 'file', root: 'repo', relativePath: 'scope.md' },
      });
      const other = await harness.state.createProject({ displayName: '另一项目' });
      let error: unknown;
      try {
        await service.readRequiredInput(other.id, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'ownership')).toBe(true);
      expect((error as ExecutionInputError).projectId).toBe(projectId);
    });
  });

  it('读取超过单项字节上限明确失败（limit_exceeded），不无限缓存', async () => {
    // 高上限服务采集成功；低上限服务读取同一制品明确失败。
    const sandbox = createTempSandbox('shiploop-f004-readcap-');
    try {
      const clock = createClock();
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        await migrateSqliteStorage(session);
      } finally {
        session.close();
      }
      const sourceRoot = join(sandbox.path, 'source-root');
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, 'large.md'), 'y'.repeat(4096));
      const harness = openHarness(sandbox.path, clock);
      try {
        const project = await harness.state.createProject({ displayName: '上限项目' });
        const writer = makeService(harness, { roots: { repo: sourceRoot } });
        const ref = await captureOne(writer, project.id, {
          purpose: 'large',
          source: { kind: 'file', root: 'repo', relativePath: 'large.md' },
        });
        const reader = makeService(harness, {
          roots: { repo: sourceRoot },
          limits: { maxItemBytes: 1024 },
        });
        let error: unknown;
        try {
          await reader.readRequiredInput(project.id, ref);
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'limit_exceeded')).toBe(true);
        expect((error as ExecutionInputError).details?.['limit']).toBe('maxItemBytes');
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('读取时间预算显式有限：超时明确失败（timeout）', async () => {
    await withHarness(async ({ harness, sourceRoot, projectId }) => {
      writeFileSync(join(sourceRoot, 'timed.md'), '计时正文');
      const writer = makeService(harness, { roots: { repo: sourceRoot } });
      const ref = await captureOne(writer, projectId, {
        purpose: 'timed',
        source: { kind: 'file', root: 'repo', relativePath: 'timed.md' },
      });
      let tick = 1_000;
      const reader = makeService(harness, {
        roots: { repo: sourceRoot },
        limits: { readTimeoutMs: 10 },
        nowMs: () => {
          tick += 100;
          return tick;
        },
      });
      let error: unknown;
      try {
        await reader.readRequiredInput(projectId, ref);
      } catch (caught) {
        error = caught;
      }
      expect(isExecutionInputError(error, 'timeout')).toBe(true);
      expect((error as ExecutionInputError).details?.['phase']).toBe('read');
    });
  });

  it('非法引用形态（缺字段/未知键/非法摘要）一律 validation 拒绝', async () => {
    await withHarness(async ({ sourceRoot, service, projectId }) => {
      writeFileSync(join(sourceRoot, 'valid.md'), 'valid');
      const ref = await captureOne(service, projectId, {
        purpose: 'valid',
        source: { kind: 'file', root: 'repo', relativePath: 'valid.md' },
      });
      for (const bad of [
        { ...ref, contentHash: 'not-a-hash' },
        { ...ref, extra: 'field' },
        { ...ref, version: 0 },
        { purpose: 'valid' },
      ]) {
        let error: unknown;
        try {
          await service.readRequiredInput(projectId, bad);
        } catch (caught) {
          error = caught;
        }
        expect(isExecutionInputError(error, 'validation')).toBe(true);
      }
    });
  });
});

describe('P03-2 / F-004 源文件读取端口（adapters/fs/input-source-files）', () => {
  it('装配期根核验：相对根/缺失根/文件根 fail-closed，不创建任何目录', async () => {
    const sandbox = createTempSandbox('shiploop-f004-roots-');
    try {
      expect(() => createInputSourceFileReader({ roots: { repo: 'relative/root' } })).toThrow(
        InputSourceError,
      );
      expect(() =>
        createInputSourceFileReader({ roots: { repo: join(sandbox.path, 'absent') } }),
      ).toThrow(InputSourceError);
      const file = join(sandbox.path, 'file.txt');
      writeFileSync(file, 'x');
      try {
        createInputSourceFileReader({ roots: { repo: file } });
        expect.unreachable('文件根应被拒绝');
      } catch (error) {
        expect(isInputSourceError(error, 'invalid_input')).toBe(true);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('读取句柄脱敏：错误不含绝对路径，正文只经流交付', async () => {
    const sandbox = createTempSandbox('shiploop-f004-src-');
    try {
      const root = join(sandbox.path, 'root');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'doc.md'), '文档正文');
      const reader = createInputSourceFileReader({ roots: { repo: root } });
      const content = await reader.openSourceRead({ root: 'repo', relativePath: 'sub/doc.md' });
      expect(content.sizeBytes).toBe(encoder.encode('文档正文').byteLength);
      const chunks: Buffer[] = [];
      for await (const chunk of content.stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('文档正文');
      // 目录目标不是常规文件。
      let error: unknown;
      try {
        await reader.openSourceRead({ root: 'repo', relativePath: 'sub' });
      } catch (caught) {
        error = caught;
      }
      expect(isInputSourceError(error, 'not_regular_file')).toBe(true);
      expect((error as InputSourceError).message).not.toContain(sandbox.path);
      // 缺失目标。
      error = undefined;
      try {
        await reader.openSourceRead({ root: 'repo', relativePath: 'missing.md' });
      } catch (caught) {
        error = caught;
      }
      expect(isInputSourceError(error, 'not_found')).toBe(true);
      expect((error as InputSourceError).message).not.toContain(sandbox.path);
      // 输入校验失败复用 StorageError(kind='validation')。
      error = undefined;
      try {
        await reader.openSourceRead({ root: 'repo', relativePath: '../escape.md' });
      } catch (caught) {
        error = caught;
      }
      expect(isStorageError(error, 'validation')).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });
});
