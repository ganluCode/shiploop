/**
 * P03-1 / F-005：计划导入与配置更新的跨进程真实竞争（真实 SQLite、真实命令
 * 通道、三个子进程同一起跑哨兵）。
 *
 * 竞争参与方：import-x / import-y（同 Phase、expectedRevision=1 的两个不同
 * Feature 计划导入）与 settings-update（项目 modelMap.low 的 CAS 更新）。
 *
 * 断言（竞争正确性不依赖调度顺序）：
 * - 两个导入都完整提交：各自 Feature + 2 Task + 1 依赖边 + feature.plan.imported
 *   事件 + completed 回执成组出现，不存在半成功（无孤儿 Task/边/事件）；
 * - 配置 CAS 更新恰好提交一次；每个 Feature 的全部 Task 策略副本内部一致
 *   （同一导入事务内读取的当前配置快照），且只可能是新旧两种 modelMap.low
 *   条目之一——导入之后配置再变化不追溯既有 Task；
 * - Phase 聚合 CAS（expectedRevision=1）在竞争下仍只提交满足重核条件的结果。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from './helpers/p02-2/index.ts';

const NOW = 1_900_100_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const testDir = fileURLToPath(new URL('.', import.meta.url));
const CHILD_SCRIPT = join(testDir, 'helpers', 'plan-import-race-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

interface ChildResult {
  readonly outcome: 'completed' | 'rejected' | 'error';
  readonly status?: string;
  readonly featureId?: string;
  readonly reason?: string;
  readonly entityType?: string;
  readonly name?: string;
  readonly message?: string;
}

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every(path => existsSync(path))) {
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
    child.once('error', error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

describe('F-005 计划导入跨进程竞争（导入×2 + 配置 CAS 更新）', () => {
  it('竞争提交只产生满足重核条件的完整结果：无半成功、副本内部一致、不追溯', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f005-race-' });
    const box = fixture;
    const harness = await box.openTransactionalHarness({ busyTimeoutMs: 5_000, busyRetryAttempts: 16 });
    let now = NOW;
    const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
    const service: CommandService = createCommandService({
      atomicStore: store,
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: box.capabilityCatalog,
      nowUtcMs: () => now,
    });
    const owner = box.localOwner();

    // 父进程准备竞争前提：项目 + 全局默认 + 项目 modelMap.low(v1=claude-sonnet-2)
    // + open Phase（revision=1）。子进程只做竞争提交。
    const registered = await service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'project.register',
      scope: { kind: 'registration' },
      issuedAt: NOW_ISO,
      payload: { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    });
    if (registered.status !== 'completed' || registered.result === null) {
      throw new Error('夹具注册失败');
    }
    const projectId = (registered.result as { project: { id: string } }).project.id;
    for (const [operation, payload, scope] of [
      ['settings.global.create', { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } }, { kind: 'global' }],
      ['settings.project.create', { schemaVersion: 2, strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } } }, { kind: 'project', projectId }],
    ] as const) {
      const receipt = await service.submit(owner, {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation,
        scope,
        issuedAt: NOW_ISO,
        payload,
      });
      if (receipt.status !== 'completed') {
        throw new Error(`夹具配置失败（${operation}）`);
      }
    }
    const phase = await service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'phase.create',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
      payload: { id: 'phase-1', title: '竞争阶段', description: null, labels: [] },
    });
    if (phase.status !== 'completed') {
      throw new Error('夹具 Phase 创建失败');
    }
    harness.close();

    // 三路竞争：import-x / import-y / settings-update（modelMap.low → claude-sonnet）。
    // 哨兵文件直接放在夹具根目录（已存在），避免子目录未建导致写入失败。
    const root = box.root;
    const goFile = join(root, 'race.go');
    const racers = [
      { role: 'import' as const, planVariant: 'x' as const },
      { role: 'import' as const, planVariant: 'y' as const },
      { role: 'settings-update' as const, planVariant: 'x' as const },
    ].map((roleSpec, index) => ({
      ...roleSpec,
      config: {
        role: roleSpec.role,
        dbPath: box.dbPath,
        projectId,
        planVariant: roleSpec.planVariant,
        readyFile: join(root, `race.ready.${index}`),
        goFile,
        resultFile: join(root, `race.result.${index}.json`),
      },
    }));

    const children = racers.map(({ config }) => {
      const child = spawn(
        process.execPath,
        ['--import', CHILD_REGISTER, CHILD_SCRIPT, JSON.stringify(config)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      return { child, stderr: () => stderr };
    });

    let results: ChildResult[];
    try {
      await waitForFiles(racers.map(({ config }) => config.readyFile), 20_000);
      writeFileSync(goFile, 'go');
      results = await Promise.all(
        racers.map(async ({ config }, index) => {
          const exit = await waitForExit(children[index]!.child, 60_000);
          const stderr = children[index]!.stderr();
          const result = existsSync(config.resultFile)
            ? (JSON.parse(readFileSync(config.resultFile, 'utf-8')) as ChildResult)
            : ({ outcome: 'error', name: 'missing_result', message: stderr } as const);
          expect({ exit, result }, `子进程 ${index}（${config.role}）：${stderr}`).toMatchObject({
            exit: { code: 0, signal: null },
          });
          expect(result.outcome, `子进程 ${index} 结果：${stderr}`).not.toBe('error');
          return result;
        }),
      );
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }
    }

    // 两个导入与一次配置 CAS 更新都完整提交（合法竞争结果集内）。
    const importResults = results.slice(0, 2);
    const settingsResult = results[2]!;
    for (const [index, result] of importResults.entries()) {
      expect(result, `导入子进程 ${index}`).toMatchObject({ outcome: 'completed', status: 'completed' });
    }
    expect(settingsResult).toMatchObject({ outcome: 'completed', status: 'completed' });

    // 独立只读探针：完整组断言（无半成功）。
    const probe = box.openProbe();
    try {
      const featureRows = probe.selectAll<{ id: string; phase_id: string; status: string; plan_status: string }>(
        'SELECT id, phase_id, status, plan_status FROM features',
      );
      expect(featureRows).toHaveLength(2);
      const featureIds = new Set(featureRows.map(row => row.id));
      for (const row of featureRows) {
        expect(row).toMatchObject({ phase_id: 'phase-1', status: 'draft', plan_status: 'draft' });
      }
      for (const result of importResults) {
        expect(featureIds.has(result.featureId!)).toBe(true);
      }
      // 每个 Feature 恰好 2 Task + 1 边，任务归属唯一 Feature。
      const taskRows = probe.selectAll<{ id: string; feature_id: string; execution_config: string }>(
        'SELECT id, feature_id, execution_config FROM tasks ORDER BY id',
      );
      expect(taskRows).toHaveLength(4);
      expect(taskRows.map(row => row.id)).toEqual(['x-1', 'x-2', 'y-1', 'y-2']);
      const edgeRows = probe.selectAll<{ task_id: string; depends_on_id: string }>(
        'SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id',
      );
      expect(edgeRows).toEqual([
        { task_id: 'x-2', depends_on_id: 'x-1' },
        { task_id: 'y-2', depends_on_id: 'y-1' },
      ]);
      // 两个导入事件（各聚合自身 Feature，revision=1）。
      const importEvents = probe
        .stateEvents()
        .filter(event => event.event_type === 'feature.plan.imported');
      expect(importEvents).toHaveLength(2);
      expect(new Set(importEvents.map(event => event.aggregate_id)).size).toBe(2);
      for (const event of importEvents) {
        expect(event).toMatchObject({
          project_id: projectId,
          aggregate_type: 'feature',
          aggregate_revision: 1,
          payload: '{"imported":true}',
        });
      }
      // 每个 Feature 的策略副本内部一致，且只可能命中新旧两种 modelMap.low 之一；
      // 事务内配置读取保证单一 Feature 不跨配置版本拼接。
      const modelsByFeature = new Map<string, Set<string>>();
      for (const task of taskRows) {
        const model = (JSON.parse(task.execution_config) as { model: string }).model;
        const set = modelsByFeature.get(task.feature_id) ?? new Set<string>();
        set.add(model);
        modelsByFeature.set(task.feature_id, set);
        expect(['claude-sonnet-2', 'claude-sonnet']).toContain(model);
      }
      for (const [, models] of modelsByFeature) {
        expect(models.size).toBe(1);
      }
      // 配置 CAS 更新恰好提交一次：项目 modelMap.low 当前为 claude-sonnet（v2）。
      const settingsRow = probe.settingsRow('project', projectId);
      expect(
        (JSON.parse(settingsRow!.payload) as { strategies: { modelMap: { low: { model: string } } } })
          .strategies.modelMap.low.model,
      ).toBe('claude-sonnet');
      expect(settingsRow!.revision).toBe(2);
    } finally {
      probe.close();
    }
  }, 120_000);
});
