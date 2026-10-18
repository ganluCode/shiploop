/**
 * P03-1 / F-005 跨进程计划导入/配置更新竞争子进程（仅测试使用，不是产品实现）。
 *
 * 父进程（test/modules/planning/p03-1-plan-import-race.test.ts）以
 * `node --import test/helpers/node-ts-loader/register.mjs <本文件> <configJson>`
 * 启动三个本进程实例，连接同一真实临时 SQLite 并竞争提交：
 *
 * 1. 子进程经真实适配器源码打开会话、装配原子命令存储 + 命令服务（真实命令
 *    通道：信封校验/授权/CAS/重核/原子写入），不是 mock，也不是复制的 SQL；
 * 2. 写入各自就绪哨兵后轮询统一起跑哨兵（同步屏障，有界超时）；
 * 3. 起跑后按角色提交：import-x/import-y 各自导入不同 Feature 计划（同
 *    Phase、expectedRevision=1），settings-update 以 CAS 更新项目
 *    modelMap.low；BEGIN IMMEDIATE + busy 预算决定真实串行化顺序；
 * 4. 把结构化结果（completed/rejected/error）写入结果文件并以退出码 0 结束
 *    （业务 rejected 是合法竞争结果）；装配/屏障/结果文件失败才非零退出。
 *
 * 屏障只提高竞争重叠概率；正确性由 BEGIN IMMEDIATE、唯一约束与提交重核
 * 保证，不依赖子进程调度顺序。父进程负责有界等待、退出核验与结果断言。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createCommandService } from '../../packages/core/src/application/command-service.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from './p02-2/principals.ts';

interface ImportChildConfig {
  readonly role: 'import' | 'settings-update';
  readonly dbPath: string;
  readonly projectId: string;
  readonly planVariant: 'x' | 'y';
  readonly readyFile: string;
  readonly goFile: string;
  readonly resultFile: string;
}

type ChildResult =
  | {
      readonly outcome: 'completed' | 'rejected';
      readonly status: string;
      readonly featureId?: string;
      readonly reason?: string;
      readonly entityType?: string;
    }
  | { readonly outcome: 'error'; readonly name: string; readonly message: string };

const GO_POLL_INTERVAL_MS = 2;
const GO_WAIT_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
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

function planForVariant(variant: 'x' | 'y'): Record<string, unknown> {
  const prefix = variant === 'x' ? 'x' : 'y';
  return {
    schemaVersion: 1,
    feature: { title: `竞争 Feature ${variant.toUpperCase()}` },
    tasks: [
      {
        id: `${prefix}-1`,
        title: `${variant}-1 任务`,
        complexity: 'low',
        acceptance: { criteria: [`${variant}-1 验收`] },
      },
      {
        id: `${prefix}-2`,
        title: `${variant}-2 任务`,
        complexity: 'low',
        acceptance: { criteria: [`${variant}-2 验收`] },
        dependsOn: [`${prefix}-1`],
      },
    ],
  };
}

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (configArg === undefined) {
    throw new Error('缺少子进程配置参数（argv[2] 应为 JSON）');
  }
  const config = JSON.parse(configArg) as ImportChildConfig;

  const session = openSqliteStorageSession({
    path: config.dbPath,
    // 竞争窗口内的 busy 预算：并发 BEGIN IMMEDIATE 只需等待彼此毫秒级事务。
    busyTimeoutMs: 5_000,
    busyRetryAttempts: 16,
  });
  let result: ChildResult;
  try {
    const store = createSqliteAtomicCommandStore(session);
    // 与测试夹具同源的静态能力目录（settings-update 角色的能力复检需要）。
    const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
      {
        runtimeId: 'pi',
        providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }],
      },
    ]);
    const service = createCommandService({ atomicStore: store, capabilityCatalog });
    const owner = createLocalOwnerPrincipal();

    writeFileSync(config.readyFile, 'ready', 'utf-8');
    await waitForGoSignal(config.goFile);

    const issuedAt = new Date().toISOString();
    if (config.role === 'import') {
      const envelope = {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation: 'feature.plan.import',
        scope: { kind: 'project', projectId: config.projectId },
        issuedAt,
        expectedRevision: 1,
        payload: { phaseId: 'phase-1', plan: planForVariant(config.planVariant) },
      };
      const receipt = await service.submit(owner, envelope);
      if (receipt.status === 'completed') {
        const feature = (receipt.result as { feature: { id: string } }).feature;
        result = { outcome: 'completed', status: receipt.status, featureId: feature.id };
      } else if (receipt.status === 'rejected') {
        result = {
          outcome: 'rejected',
          status: receipt.status,
          reason: String(receipt.error.details?.reason ?? ''),
          entityType: String(receipt.error.details?.entityType ?? ''),
        };
      } else {
        throw new Error(`意外的回执状态：${receipt.status}`);
      }
    } else {
      const envelope = {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation: 'settings.project.update',
        scope: { kind: 'project', projectId: config.projectId },
        issuedAt,
        expectedRevision: 1,
        payload: {
          schemaVersion: 2,
          strategies: {
            modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
          },
        },
      };
      const receipt = await service.submit(owner, envelope);
      if (receipt.status === 'completed') {
        result = { outcome: 'completed', status: receipt.status };
      } else if (receipt.status === 'rejected') {
        result = {
          outcome: 'rejected',
          status: receipt.status,
          reason: String(receipt.error.details?.reason ?? ''),
          entityType: String(receipt.error.details?.entityType ?? ''),
        };
      } else {
        throw new Error(`意外的回执状态：${receipt.status}`);
      }
    }
  } catch (error) {
    result = {
      outcome: 'error',
      name: error instanceof Error ? error.name : String(error),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    session.close();
  }
  writeFileSync(config.resultFile, JSON.stringify(result), 'utf-8');
  process.exitCode = result.outcome === 'error' ? 1 : 0;
}

void main();
