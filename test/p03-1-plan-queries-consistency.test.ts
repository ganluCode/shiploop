/**
 * P03-1 / F-006：计划详情/DAG 一致读视图的跨进程真实竞争（真实 SQLite、真实
 * 命令通道导入计划 + 子进程反复「单写事务整体替换」计划成员）。
 *
 * 断言（竞争正确性不依赖调度顺序）：
 * - 子进程交替写入两套完整计划状态（3 Task DAG ↔ 1 Task），每次替换在单一
 *   BEGIN IMMEDIATE 内提交（删除旧 Task/边 → 插入整套新成员 → 更新
 *   planDigest/revision）；
 * - 父进程持续读取 features.get：每次观察只能是完整的修订前或修订后
 *   （Task 集合、依赖边集合、planDigest、validation 四元组恰好等于 A 或 B），
 *   绝不出现「新 Task 配旧边/旧摘要」的混合状态；
 * - 观察到的摘要与 F-001 纯摘要函数对同一计划的计算一致（不虚构摘要）。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeFeaturePlanDigest,
  validateFeaturePlanInput,
} from '../packages/core/src/ports/feature-plan.ts';
import type { FeatureDetailResult } from '../packages/core/src/ports/queries.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const testDir = fileURLToPath(new URL('.', import.meta.url));
const CHILD_SCRIPT = join(testDir, 'helpers', 'plan-rewrite-race-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

let fixture: CommandsTestFixture | undefined;
afterEach(() => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`有界等待哨兵文件超时（${timeoutMs}ms）`);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error('等待子进程退出超时'));
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

/** 观察签名：Task 集合、依赖边集合、planDigest、validation 必须成组出现。 */
function signatureOf(detail: FeatureDetailResult): string {
  return JSON.stringify({
    ids: detail.tasks.map((task) => task.id),
    edges: detail.dependencies.map((edge) => [edge.taskId, edge.dependsOnId]),
    digest: detail.feature.planDigest,
    validation: detail.validation,
  });
}

const PLAN_A = {
  schemaVersion: 1,
  feature: { title: '竞争计划 A' },
  tasks: [
    { id: 't-1', title: '任务一', complexity: 'low', acceptance: { criteria: ['任务一验收'] } },
    {
      id: 't-2',
      title: '任务二',
      complexity: 'low',
      acceptance: { criteria: ['任务二验收'] },
      dependsOn: ['t-1'],
    },
    {
      id: 't-3',
      title: '任务三',
      complexity: 'low',
      acceptance: { criteria: ['任务三验收'] },
      dependsOn: ['t-2'],
    },
  ],
} as const;

const PLAN_B = {
  schemaVersion: 1,
  feature: { title: '竞争计划 B' },
  tasks: [{ id: 'x-1', title: 'x-1 任务', acceptance: { criteria: ['x-1 验收'] } }],
} as const;

const TASK_CONFIG = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-sonnet',
} as const;

describe('F-006 计划详情一致读视图（跨进程修订竞争 × 持续读取）', () => {
  it('并发修订期间的每次读取都是完整修订前或修订后；无新 Task 配旧边/旧摘要的混合状态', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-race-' });
    const box = fixture;
    const app = await box.openApplication();
    const owner = box.localOwner();
    const submit = (
      operation: string,
      scope: unknown,
      payload: Record<string, unknown>,
      changes: Record<string, unknown> = {},
    ): Promise<CommandReceipt> =>
      app.commandService.submit(owner, {
        schemaVersion: 4,
        commandId: randomUUID(),
        operation,
        scope,
        issuedAt: NOW_ISO,
        payload,
        ...changes,
      });

    const registered = await submit('project.register', { kind: 'registration' }, {
      repositoryPath: box.repoDirA,
      displayName: 'Repo A',
      description: null,
      labels: [],
    });
    if (registered.status !== 'completed' || registered.result === null) throw new Error('注册失败');
    const projectId = (registered.result as { project: { id: string } }).project.id;
    for (const [operation, scope, payload] of [
      [
        'settings.global.create',
        { kind: 'global' },
        {
          schemaVersion: 2,
          strategies: {
            defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          },
        },
      ],
      ['phase.create', { kind: 'project', projectId }, { id: 'phase-1', title: '竞争阶段' }],
    ] as const) {
      const receipt = await submit(operation, scope, payload as Record<string, unknown>);
      if (receipt.status !== 'completed') throw new Error(`夹具失败（${operation}）`);
    }

    const importReceipt = await submit(
      'feature.plan.import',
      { kind: 'project', projectId },
      { phaseId: 'phase-1', plan: PLAN_A },
      { expectedRevision: 1 },
    );
    if (importReceipt.status !== 'completed' || importReceipt.result === null) {
      throw new Error('计划导入失败');
    }
    const imported = importReceipt.result as {
      feature: { id: string; planDigest: string };
    };
    const featureId = imported.feature.id;

    // 摘要与 F-001 纯摘要函数同源：导入摘要 = 同一计划的确定性计算值。
    const digestA = computeFeaturePlanDigest(validateFeaturePlanInput(PLAN_A));
    const digestB = computeFeaturePlanDigest(validateFeaturePlanInput(PLAN_B));
    expect(imported.feature.planDigest).toBe(digestA);

    const taskInput = (id: string, title: string, criteria: string) => ({
      projectId,
      featureId,
      id,
      title,
      complexity: 'low' as const,
      acceptance: { criteria: [criteria] },
      executionConfig: { ...TASK_CONFIG },
      configSource: 'global_default',
      configSourceKey: 'defaultStrategy',
    });
    const config = {
      dbPath: box.dbPath,
      projectId,
      featureId,
      rounds: 40,
      states: {
        a: {
          digest: digestA,
          tasks: [
            taskInput('t-1', '任务一', '任务一验收'),
            taskInput('t-2', '任务二', '任务二验收'),
            taskInput('t-3', '任务三', '任务三验收'),
          ],
          edges: [
            ['t-2', 't-1'],
            ['t-3', 't-2'],
          ],
        },
        b: {
          digest: digestB,
          tasks: [taskInput('x-1', 'x-1 任务', 'x-1 验收')],
          edges: [],
        },
      },
      readyFile: join(box.root, 'rewrite.ready'),
      goFile: join(box.root, 'rewrite.go'),
      resultFile: join(box.root, 'rewrite.result.json'),
    };

    const child = spawn(
      process.execPath,
      ['--import', CHILD_REGISTER, CHILD_SCRIPT, JSON.stringify(config)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const SIG_A = JSON.stringify({
      ids: ['t-1', 't-2', 't-3'],
      edges: [
        ['t-2', 't-1'],
        ['t-3', 't-2'],
      ],
      digest: digestA,
      validation: { taskCount: 3, dependencyEdgeCount: 2, executable: true },
    });
    const SIG_B = JSON.stringify({
      ids: ['x-1'],
      edges: [],
      digest: digestB,
      validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
    });

    let observations = 0;
    try {
      await waitForFiles([config.readyFile], 20_000);
      writeFileSync(config.goFile, 'go');
      const exitPromise = waitForExit(child, 60_000);
      // 子进程修订期间持续读取：每个快照必须是完整 A 或完整 B（四元组成组）。
      while (!existsSync(config.resultFile) && observations < 400) {
        const detail = await app.queryService.getFeature(owner, featureId);
        const observed = signatureOf(detail);
        expect([SIG_A, SIG_B], `第 ${observations} 次观察出现混合状态：${observed}`).toContain(observed);
        observations += 1;
        await sleep(1);
      }
      const exit = await exitPromise;
      expect({ exit, stderr }, stderr).toMatchObject({ exit: { code: 0, signal: null } });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }

    const result = JSON.parse(readFileSync(config.resultFile, 'utf-8')) as {
      outcome: string;
      rewritten: number;
    };
    expect(result).toMatchObject({ outcome: 'rewritten', rewritten: config.rounds });
    expect(observations).toBeGreaterThan(0);

    // 最终一致：收尾读取同样是完整状态之一。
    const finalDetail = await app.queryService.getFeature(owner, featureId);
    expect([SIG_A, SIG_B]).toContain(signatureOf(finalDetail));
  }, 60_000);
});
