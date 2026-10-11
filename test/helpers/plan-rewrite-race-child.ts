/**
 * P03-1 / F-006 计划修订竞争子进程（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 父进程（test/p03-1-plan-queries-consistency.test.ts）以
 * `node --import test/helpers/node-ts-loader/register.mjs <本文件> <configJson>`
 * 启动本进程，连接同一真实临时 SQLite 并在统一起跑哨兵放行后反复重写一个
 * Feature 的计划成员（模拟 F-008 计划实质修订的「单写事务整体替换」语义：
 * 删除旧 Task/边 → 插入整套新 Task/边 → 更新 planDigest/revision，全部在同一
 * BEGIN IMMEDIATE 内提交），与父进程的查询读取真实并发（WAL 读写并行）。
 *
 * 交替写入两套完整计划状态（a/b，含各自的 planDigest）。任何读取只能观察到
 * 完整的 a 或完整的 b；若读取实现没有单一一致读事务，就会观察到「新 Task 配
 * 旧边/旧摘要」的混合状态。写入使用真实适配器写原语（insertTask/insertEdge），
 * 不是复制的业务 SQL。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createSqlitePlanAccess } from '../../packages/core/src/adapters/sqlite/plan-store.ts';

interface RewriteTaskInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly id: string;
  readonly title: string;
  readonly complexity?: 'low' | 'medium' | 'high' | null;
  readonly acceptance: { readonly criteria: readonly string[] };
  readonly executionConfig: Record<string, unknown>;
  readonly configSource: string;
}

interface RewriteState {
  readonly digest: string;
  readonly tasks: readonly RewriteTaskInput[];
  readonly edges: readonly (readonly [string, string])[];
}

interface RewriteChildConfig {
  readonly dbPath: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly rounds: number;
  readonly states: { readonly a: RewriteState; readonly b: RewriteState };
  readonly readyFile: string;
  readonly goFile: string;
  readonly resultFile: string;
}

const GO_POLL_INTERVAL_MS = 2;
const GO_WAIT_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
    throw new Error('缺少 config JSON 参数');
  }
  const config = JSON.parse(configArg) as RewriteChildConfig;
  const session = openSqliteStorageSession({
    path: config.dbPath,
    busyTimeoutMs: 5_000,
    busyRetryAttempts: 16,
  });
  try {
    const plan = createSqlitePlanAccess(session, { nowUtcMs: () => 1_900_000_000_000 });
    writeFileSync(config.readyFile, 'ready');
    await waitForGoSignal(config.goFile);
    let rewritten = 0;
    for (let round = 0; round < config.rounds; round += 1) {
      const state = round % 2 === 0 ? config.states.b : config.states.a;
      session.transactWrite('test.plan-rewrite', () => {
        session.database
          .prepare('DELETE FROM task_dependencies WHERE feature_id = ?')
          .run(config.featureId);
        session.database.prepare('DELETE FROM tasks WHERE feature_id = ?').run(config.featureId);
        for (const task of state.tasks) {
          plan.insertTaskInTransaction({ ...task, projectId: config.projectId, featureId: config.featureId });
        }
        for (const [taskId, dependsOnId] of state.edges) {
          plan.insertTaskDependencyInTransaction({
            projectId: config.projectId,
            featureId: config.featureId,
            taskId,
            dependsOnId,
          });
        }
        session.database
          .prepare('UPDATE features SET plan_digest = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run(state.digest, 1_900_000_000_000 + round, config.featureId);
      });
      rewritten += 1;
    }
    writeFileSync(
      config.resultFile,
      JSON.stringify({ outcome: 'rewritten', rewritten, rounds: config.rounds }),
    );
  } finally {
    session.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
