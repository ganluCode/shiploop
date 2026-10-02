/**
 * P01-3 / F-005 跨进程注册竞争子进程（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 父进程（test/project-registration.test.ts）以
 * `node --import test/helpers/node-ts-loader/register.mjs <本文件> <configJson>`
 * 启动两个本进程实例，连接同一真实临时 SQLite 并竞争注册同一真实 Git 仓库路径：
 *
 * 1. 子进程经真实适配器源码（Node 22 原生类型擦除 + node-ts-loader 重映射）
 *    打开会话、装配 StateStore + 真实 Git RepositoryInspector + ProjectService
 *    ——不是 mock，也不是复制的 SQL；
 * 2. 写入各自的就绪哨兵文件后轮询等待统一起跑哨兵（同步屏障，有界超时）；
 * 3. 起跑后调用 ProjectService.registerRepository（含真实只读 Git 检查 +
 *    单个短事务原子写入）；两个子进程使用不同 displayName/labels，败者不得
 *    覆盖胜者元数据；
 * 4. 把结构化结果（registered/already_exists/error）写入各自结果文件并退出：
 *    - 结果文件成功写入后恒以退出码 0 结束（already_exists 是合法竞争结果）；
 *    - 装配失败、屏障超时或结果文件无法写入才以非零退出；
 *    - 进程正常退出即证明会话已关闭、不残留句柄。
 *
 * 屏障只提高竞争重叠概率，正确性不依赖时序：canonical_path 全库唯一 +
 * BEGIN IMMEDIATE 下检查并插入保证恰有一个进程创建项目。父进程负责有界等待
 * 并核验本进程退出码与结果文件。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../packages/core/src/adapters/sqlite/state-store.ts';
import { createRepositoryInspector } from '../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createProjectService } from '../../packages/core/src/application/project-service.ts';

interface ChildConfig {
  readonly dbPath: string;
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly labels: readonly string[];
  readonly marker: string;
  readonly readyFile: string;
  readonly goFile: string;
  readonly resultFile: string;
}

type ChildResult =
  | {
      readonly outcome: 'registered' | 'already_exists';
      readonly projectId: string;
      readonly bindingId: string;
      readonly canonicalPath: string;
      readonly displayName: string;
      readonly labels: readonly string[];
    }
  | { readonly outcome: 'error'; readonly name: string; readonly message: string };

const GO_POLL_INTERVAL_MS = 2;
const GO_WAIT_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGoSignal(goFile: string): Promise<void> {
  const deadline = Date.now() + GO_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(goFile)) {
      return;
    }
    await sleep(GO_POLL_INTERVAL_MS);
  }
  throw new Error(`等待统一起跑哨兵超时（${GO_WAIT_TIMEOUT_MS}ms）`);
}

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (configArg === undefined) {
    throw new Error('缺少子进程配置参数（argv[2] 应为 JSON）');
  }
  const config = JSON.parse(configArg) as ChildConfig;

  const session = openSqliteStorageSession({
    path: config.dbPath,
    // 竞争窗口内的 busy 预算：败者 BEGIN IMMEDIATE 只需等待胜者毫秒级事务。
    busyTimeoutMs: 2_000,
    busyRetryAttempts: 4,
  });
  try {
    const store = createSqliteStateStore(session);
    const service = createProjectService({
      stateStore: store,
      repositoryInspector: createRepositoryInspector(),
    });
    writeFileSync(config.readyFile, String(process.pid));
    await waitForGoSignal(config.goFile);

    const result: ChildResult = await service
      .registerRepository({
        repositoryPath: config.repositoryPath,
        displayName: config.displayName,
        labels: config.labels,
      })
      .then(
        (registered): ChildResult => ({
          outcome: registered.status,
          projectId: registered.project.id,
          bindingId: registered.binding.id,
          canonicalPath: registered.binding.canonicalPath,
          displayName: registered.project.displayName,
          labels: registered.project.labels,
        }),
        (error: unknown): ChildResult => ({
          outcome: 'error',
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    writeFileSync(config.resultFile, JSON.stringify(result));
  } finally {
    session.close();
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(
      `register-race-child: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
