/**
 * F-012 中断发布子进程（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 父进程（test/artifact-verify.test.ts）以
 * `node --import test/helpers/node-ts-loader/register.mjs <本文件> <configJson>`
 * 启动本进程，模拟 Host 在发布流程的三个确定性检查点被中断：
 *
 * 1. checkpoint='registered'：pending 索引已登记（短事务已提交）后立即退出；
 * 2. checkpoint='staged'：staging 已写入并 fsync 关闭（无正式文件）后退出；
 * 3. checkpoint='published'：正式文件已发布但 ready 提交前退出
 *    （这正是 F-011 commit 失败保留 pending + 正式文件的恢复现场）。
 *
 * 每个检查点把结构化结果写入 resultFile 后以约定的非零退出码
 * （70/71/72）直接 process.exit——不调用 session.close()，模拟中断的 Host
 * （短同步事务要么已提交要么整体不存在，不存在半条记录；fd 由 OS 回收）。
 *
 * 子进程经真实适配器源码操作真实临时 SQLite 与真实文件根，不是 mock；
 * 父进程核验退出码与结果文件后，关闭自己的会话并重开真实库/文件根再核对
 * （F-012 中断核对），不依赖子进程内存状态。
 */
import { writeFileSync } from 'node:fs';
import { createArtifactFileStore } from '../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';

export type InterruptCheckpoint = 'registered' | 'staged' | 'published';

interface ChildConfig {
  readonly dbPath: string;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly expectedHash: string;
  readonly locator: string;
  readonly contentBase64: string;
  readonly checkpoint: InterruptCheckpoint;
  readonly resultFile: string;
}

type ChildResult = {
  readonly artifactId: string;
  readonly stagingRelativePath?: string;
  readonly finalRelativePath?: string;
};

const EXIT_CODES: Record<InterruptCheckpoint, number> = {
  registered: 70,
  staged: 71,
  published: 72,
};

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (configArg === undefined) {
    throw new Error('缺少子进程配置参数（argv[2] 应为 JSON）');
  }
  const config = JSON.parse(configArg) as ChildConfig;
  if (!(config.checkpoint in EXIT_CODES)) {
    throw new Error(`未知检查点：${String(config.checkpoint)}`);
  }

  const session = openSqliteStorageSession({
    path: config.dbPath,
    busyTimeoutMs: 2_000,
    busyRetryAttempts: 4,
  });
  // 模拟中断的 Host：在检查点直接 process.exit，不调用 session.close()。
  const artifacts = createSqliteArtifactStore(session);
  const files = createArtifactFileStore({ dataRoot: config.dataRoot, stagingName: () => 'child' });

  // 检查点 1：pending 短事务登记已提交。
  const record = await artifacts.registerArtifact({
    projectId: config.projectId,
    kind: config.kind,
    mediaType: config.mediaType,
    expectedHash: config.expectedHash,
    locator: config.locator,
    version: 1,
  });
  if (config.checkpoint === 'registered') {
    writeFileSync(config.resultFile, JSON.stringify({ artifactId: record.id } satisfies ChildResult));
    process.exit(EXIT_CODES.registered);
  }

  // 检查点 2：staging 写入并 fsync 关闭完成（事务外文件操作）。
  const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
  const write = await files.openStagingWrite(key);
  write.stream.write(Buffer.from(config.contentBase64, 'base64'));
  write.stream.end();
  const staged = await files.finishStaging(write);
  if (config.checkpoint === 'staged') {
    writeFileSync(
      config.resultFile,
      JSON.stringify({
        artifactId: record.id,
        stagingRelativePath: staged.relativePath,
      } satisfies ChildResult),
    );
    process.exit(EXIT_CODES.staged);
  }

  // 检查点 3：正式文件已发布，ready 提交前中断。
  const published = await files.publishStaging(staged, key);
  if (config.checkpoint === 'published') {
    writeFileSync(
      config.resultFile,
      JSON.stringify({
        artifactId: record.id,
        finalRelativePath: published.relativePath,
      } satisfies ChildResult),
    );
    process.exit(EXIT_CODES.published);
  }
  throw new Error(`检查点 ${config.checkpoint} 处理完毕但未退出（实现错误）`);
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(
      `interrupt-publish-child: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
