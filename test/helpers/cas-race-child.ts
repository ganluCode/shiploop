/**
 * F-007 跨进程 CAS 竞争子进程（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 父进程（test/sqlite-cas-and-atomicity.test.ts）以
 * `node --import test/helpers/node-ts-loader/register.mjs <本文件> <configJson>`
 * 启动两个本进程实例，连接同一真实临时 SQLite 并以同一旧 revision 竞争更新
 * 同一项目当前配置：
 *
 * 1. 子进程经真实适配器源码（Node 22 原生类型擦除 + node-ts-loader 重映射）
 *    打开会话并装配 StateStore 端口——不是 mock，也不是复制的 SQL；
 * 2. 写入各自的就绪哨兵文件后轮询等待统一起跑哨兵（同步屏障，有界超时）；
 * 3. 起跑后调用 updateProjectSettings（expectedRevision 为同一旧值）；
 * 4. 把结构化结果（success/conflict/error）写入各自结果文件并退出：
 *    - 结果文件成功写入后恒以退出码 0 结束（conflict 是合法竞争结果）；
 *    - 装配失败、屏障超时或结果文件无法写入才以非零退出；
 *    - 进程正常退出即证明会话已关闭、不残留句柄。
 *
 * 屏障只提高竞争重叠概率，正确性不依赖时序：CAS 语义保证同一旧 revision
 * 下恰有一个进程成功。父进程负责有界等待并核验本进程退出码与结果文件。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../packages/core/src/adapters/sqlite/state-store.ts';
import { isStorageError } from '../../packages/core/src/ports/errors.ts';

interface ChildConfig {
  readonly dbPath: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly marker: string;
  readonly readyFile: string;
  readonly goFile: string;
  readonly resultFile: string;
}

type ChildResult =
  | { readonly outcome: 'success'; readonly revision: number; readonly provider: string }
  | {
      readonly outcome: 'conflict';
      readonly expectedRevision: number | undefined;
      readonly actualRevision: unknown;
      readonly entity: unknown;
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
    writeFileSync(config.readyFile, String(process.pid));
    await waitForGoSignal(config.goFile);

    const marker = config.marker;
    const result: ChildResult = await store
      .updateProjectSettings(config.projectId, {
        expectedRevision: config.expectedRevision,
        payload: {
          schemaVersion: 1,
          strategies: {
            defaultStrategy: {
              runtime: 'pi',
              provider: `provider-${marker}`,
              model: `model-${marker}`,
            },
          },
        },
      })
      .then(
        (record): ChildResult => ({
          outcome: 'success',
          revision: record.revision,
          provider: record.payload.strategies?.defaultStrategy?.provider ?? '',
        }),
        (error: unknown): ChildResult => {
          if (isStorageError(error, 'conflict')) {
            return {
              outcome: 'conflict',
              expectedRevision: error.details?.['expectedRevision'] as number | undefined,
              actualRevision: error.details?.['actualRevision'],
              entity: error.entity,
            };
          }
          return {
            outcome: 'error',
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          };
        },
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
    process.stderr.write(`cas-race-child: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
