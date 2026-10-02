/**
 * F-014 文档示例核验：`docs/storage-operations.md` §3 的最小端口使用示例与本文档
 * 所述的常量/状态机，必须与真实可调用接口一致（编译检查 + 运行断言）。
 *
 * 定位：F-014 只交付文档；为避免文档与实现漂移，本套件把文档中的执行顺序
 * （迁移 → 组合创建 → 发布 → 有效引用 → 核验读取 → 关闭重开一致）真实跑通，
 * 并断言文档引用的常量（busy 预算、PRAGMA 策略、受控 locator 推导）。
 * 不新增业务实现、不扩大 P01-2 交付范围。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  DEFAULT_BUSY_TIMEOUT_MS,
  SQLITE_PRAGMA_POLICY,
  openSqliteStorageSession,
} from '../packages/core/src/adapters/sqlite/session.ts';
import { deriveArtifactFinalRelativePath } from '../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const PAYLOAD = {
  schemaVersion: 1,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
} as const;

function sha256Hex(parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest('hex');
}

describe('F-014 文档示例：与真实接口一致且可运行', () => {
  it('最小端口使用示例（docs/storage-operations.md §3）闭环编译并运行', async () => {
    const sandbox = createTempSandbox('shiploop-f014-docs-');
    const dataRoot = sandbox.path;
    try {
      const dbPath = join(dataRoot, 'state.db');
      const session = openSqliteStorageSession({ path: dbPath });
      try {
        await migrateSqliteStorage(session);

        const state = createSqliteStateStore(session, { nowUtcMs: Date.now });
        const artifacts = createSqliteArtifactStore(session, { nowUtcMs: Date.now });
        const files = createArtifactFileStore({ dataRoot });
        const publisher = createArtifactPublisher({
          artifacts,
          files,
          limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
        });
        const verifier = createArtifactVerifier({
          artifacts,
          files,
          limits: { maxReadBytes: 1_048_576 },
        });

        const created = await state.createProjectWithInitialSettings(
          { displayName: '示例项目', description: '可选说明', labels: ['P01 ', '示例'] },
          { payload: PAYLOAD },
        );

        const content = [new TextEncoder().encode('ShipLoop '), new TextEncoder().encode('示例正文')];
        const expectedHash = sha256Hex(content);
        const published = await publisher.publishArtifact({
          projectId: created.project.id,
          kind: 'verification-report',
          mediaType: 'text/markdown',
          expectedHash,
          locator: 'reports/示例.md',
          content,
        });

        const ref = await artifacts.getArtifactInputRef(created.project.id, published.artifact.id);
        const read = await verifier.readVerifiedContent(created.project.id, published.artifact.id);

        expect(published.artifact.status).toBe('ready');
        expect(published.artifact.revision).toBe(2);
        expect(published.artifact.contentHash).toBe(expectedHash);
        expect(ref.contentHash).toBe(expectedHash);
        expect(read.contentHash).toBe(expectedHash);
        expect(Buffer.from(read.content)).toEqual(Buffer.concat(content.map(Buffer.from)));

        session.close();

        // 关闭重开同一数据根后逐字段一致（文档 §3 步骤 7）。
        const reopened = openSqliteStorageSession({ path: dbPath });
        try {
          const reopenedState = createSqliteStateStore(reopened, { nowUtcMs: Date.now });
          const reopenedArtifacts = createSqliteArtifactStore(reopened, { nowUtcMs: Date.now });
          const project = await reopenedState.getProject(created.project.id);
          const artifact = await reopenedArtifacts.getArtifact(created.project.id, published.artifact.id);
          expect(project).toEqual(created.project);
          expect(artifact).toEqual(published.artifact);
        } finally {
          reopened.close();
        }
      } finally {
        if (session.isOpen()) {
          session.close();
        }
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('文档所述的 busy 预算、PRAGMA 策略与受控 locator 推导与实现一致', () => {
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(250);
    expect(DEFAULT_BUSY_RETRY_ATTEMPTS).toBe(3);
    expect(SQLITE_PRAGMA_POLICY).toEqual({
      journalMode: 'wal',
      synchronous: 'FULL',
      synchronousValue: 2,
      foreignKeys: 'ON',
    });
    // 物理位置只由稳定 ID 推导，locator（逻辑身份）不参与。
    expect(deriveArtifactFinalRelativePath({ projectId: 'p-1', artifactId: 'a-1' })).toBe(
      'projects/p-1/artifacts/a-1/content',
    );
    expect(
      deriveArtifactFinalRelativePath({ projectId: 'p-1', artifactId: 'a-1', locator: '报告/验收.md' }),
    ).toBe('projects/p-1/artifacts/a-1/content');
  });
});
