/**
 * F-004 P02-2 命令竞争 / 事务故障 / 受限 principal / SSE 重连夹具套件自测
 * （夹具能力的真实回归，不是产品实现）。
 *
 * 验收来源（F-004 四条验收标准）：
 * 1. 复用临时沙箱与 P02-1 Host/CLI 进程夹具积木：真实临时 SQLite（经公开
 *    Core 装配迁移）、真实 Git 仓库 A/B、受控数据根、真实 127.0.0.1 HTTP；
 *    不读真实凭据、不调用模型、不修改开发仓库或用户 HOME；
 * 2. 受限 principal（test-restricted:<uuid>）只由可信测试装配构造，冻结能力集
 *    与项目允许列表；同步起跑屏障制造命令竞争；原始 SSE 客户端支持断开/重连
 *    与暂停消费；产品源码不存在任何 test-restricted 入口；
 * 3. 故障注入复用 P01 既有真实 SQLite `TEMP TRIGGER … RAISE(ABORT)` 注入面，
 *    注入点在业务写入之后、state_events/command_receipts 写入之前；断言只读
 *    独立真实连接（非 mock）中的业务行/revision/事件计数；
 * 4. 连接、进程、等待全部有界；屏障超时、结果超时与连接中断均回收自有资源并
 *    核验进程退出；证据与错误文本不含 token 或认证头。
 *
 * 本文件只使用 test/helpers/p02-2 与 test/helpers/host 夹具面，不连接真实
 * 模型，不要求 dist，spawn 的真实子进程均带重定向 HOME/TMPDIR 与 IPC 屏障。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_CAPABILITIES,
  LOCAL_OWNER_PRINCIPAL_ID,
} from '../../../packages/core/src/ports/commands.ts';
import { createCompletedReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createResultRef } from '../../../packages/core/src/ports/command-receipts.ts';
import { createSqliteCommandReceiptStore } from '../../../packages/core/src/adapters/sqlite/command-receipts.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BarrierTimeoutError,
  createCommandsTestFixture,
  createReplayLowerBoundController,
  createRestrictedPrincipal,
  createStartBarrier,
  installWriteFault,
  openStorageProbe,
  runBarrierChildren,
  runWithStartBarrier,
  scopeAllowlist,
  SseClientError,
  connectSseLoopback,
  TEST_RESTRICTED_PRINCIPAL_PREFIX,
  WRITE_FAULT_POINTS,
  createLocalOwnerPrincipal,
  isTestRestrictedPrincipalId,
  type CommandsTestFixture,
  type SseConnection,
} from '../../helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  EvidenceSecretLeakError,
  type IsolatedHostEnvironment,
} from '../../helpers/host/index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BARRIER_PROBE_CHILD = fileURLToPath(
  new URL('../../helpers/p02-2/barrier-probe-child.ts', import.meta.url),
);

/** 合成凭据哨兵：任何错误/证据文本都不得回显。 */
const SECRET_SENTINEL = 'credref-f004-top-secret-sentinel';

/** 合法 schemaVersion=2 配置（与夹具静态能力目录 pi/anthropic/claude-sonnet 一致）。 */
function settingsPayload(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
    },
    policies: { verification: { requireChecksBeforeDone: true } },
  };
}

function settingsPayloadV2(credentialRef?: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: {
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet-2',
        ...(credentialRef ? { credentialRef } : {}),
      },
    },
    policies: { verification: { requireChecksBeforeDone: false } },
  };
}

/** 有界轮询等待（不用固定 sleep）；超时即失败。 */
async function viWaitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`viWaitFor 条件在 ${timeoutMs}ms 内未满足`);
}

let commandsFixture: CommandsTestFixture | undefined;
function useCommandsFixture(): CommandsTestFixture {
  commandsFixture = createCommandsTestFixture({ prefix: 'shiploop-f004-cmd-' });
  return commandsFixture;
}

let hostEnv: IsolatedHostEnvironment | undefined;
function useHostEnv(): IsolatedHostEnvironment {
  hostEnv = createIsolatedHostEnvironment({ prefix: 'shiploop-f004-host-', stepMs: 100 });
  return hostEnv;
}

afterEach(async () => {
  const activeCommands = commandsFixture;
  commandsFixture = undefined;
  activeCommands?.cleanup();
  const activeHost = hostEnv;
  hostEnv = undefined;
  await activeHost?.dispose();
});

async function registerProject(
  fixture: CommandsTestFixture,
  which: 'A' | 'B',
  displayName: string,
): Promise<{ id: string; revision: number }> {
  const app = await fixture.openApplication();
  try {
    const result = await app.projectService.registerRepository({
      repositoryPath: which === 'A' ? fixture.repoDirA : fixture.repoDirB,
      displayName,
      labels: [which.toLowerCase()],
    });
    if (result.status !== 'registered') {
      throw new Error(`测试准备：注册意外返回 ${result.status}`);
    }
    return { id: result.project.id, revision: result.project.revision };
  } finally {
    app.close();
  }
}

/* ------------------------------------------------------------------ *
 * 1. 临时沙箱 + 真实 A/B 资源
 * ------------------------------------------------------------------ */

describe('F-004 临时沙箱与真实 A/B 资源', () => {
  it('沙箱在系统临时目录内且独立于开发仓库/用户 HOME；A/B 为不同真实 Git 仓库', () => {
    const fixture = useCommandsFixture();
    const realTmp = realpathSync(tmpdir());
    const realHome = realpathSync(homedir());
    const root = realpathSync(fixture.root);
    expect(root === realTmp || root.startsWith(realTmp + '/')).toBe(true);
    expect(root.startsWith(realHome + '/')).toBe(false);
    expect(root.startsWith(realpathSync(REPO_ROOT) + '/')).toBe(false);
    expect(realpathSync(fixture.homeDir).startsWith(root + '/')).toBe(true);
    expect(realpathSync(fixture.dataRoot).startsWith(root + '/')).toBe(true);

    expect(fixture.gitHead('A')).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.gitHead('B')).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.gitHead('A')).not.toBe(fixture.gitHead('B'));
    expect(realpathSync(fixture.repoDirA)).not.toBe(realpathSync(fixture.repoDirB));
    expect(fixture.tools.gitVersion).toMatch(/^git version /);
    expect(fixture.tools.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('openApplication 经公开装配在受控数据根迁移真实 SQLite；独立探针只读核对', async () => {
    const fixture = useCommandsFixture();
    const app = await fixture.openApplication();
    try {
      expect(app.dataRoot).toBe(realpathSync(fixture.dataRoot));
    } finally {
      app.close();
    }
    const probe = fixture.openProbe();
    try {
      const versions = probe.selectAll<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
      const counts = probe.counts();
      expect(counts.projects).toBe(0);
      expect(counts.state_events).toBe(0);
      // F-006 迁移 v3 起回执表真实存在（0 行空表，不再是「表不存在」）。
      expect(counts.command_receipts).toBe(0);
      expect(probe.maxSequence()).toBe(0);
    } finally {
      probe.close();
    }
  });

  it('cleanup 关闭全部受管应用/探针并核验沙箱消失；重复调用幂等', async () => {
    const fixture = useCommandsFixture();
    const app = await fixture.openApplication();
    const probe = fixture.openProbe();
    app.close();
    probe.close();
    const root = fixture.root;
    fixture.cleanup();
    expect(statSync.bind(undefined, root)).toThrow();
    expect(fixture.cleaned).toBe(true);
    expect(() => fixture.cleanup()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 2. 受限 principal（仅可信测试装配）
 * ------------------------------------------------------------------ */

describe('F-004 可信测试装配受限 principal（项目 A/B）', () => {
  it('local-owner 持全部冻结能力且范围为 all；冻结不可变', () => {
    const owner = createLocalOwnerPrincipal();
    expect(owner.principalId).toBe(LOCAL_OWNER_PRINCIPAL_ID);
    expect([...owner.capabilities].sort()).toEqual([...APP_CAPABILITIES].sort());
    // P03-1 计划域四项（phase.write / feature.plan.import / plan.labels.write /
    // feature.plan.revise）+ P03-2 / F-001 Task 策略编辑、F-002 计划决策与
    // F-006 执行输入准备三项 + P03-3 / F-004 执行授权面与 F-009 预算修订两项后
    // 加上 P03-5 workspace.discard 后冻结 21 项。
    expect(owner.capabilities.size).toBe(21);
    expect(owner.projectScope).toEqual({ kind: 'all' });
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.projectScope)).toBe(true);
    expect(() =>
      (owner.capabilities as Set<string>).add('would-be-escalation'),
    ).toThrow();
  });

  it('受限主体 id 为 test-restricted:<uuid-v4>，能力与 A 允许列表冻结；A/B 互不可见', async () => {
    const fixture = useCommandsFixture();
    const [projectA, projectB] = await Promise.all([
      registerProject(fixture, 'A', '受限项目 A'),
      registerProject(fixture, 'B', '受限项目 B'),
    ]);

    const principalA = fixture.restrictedPrincipal({
      capabilities: ['project.read', 'settings.project.read', 'receipts.read', 'events.read'],
      projectScope: scopeAllowlist([projectA.id]),
    });
    expect(principalA.principalId.startsWith(TEST_RESTRICTED_PRINCIPAL_PREFIX)).toBe(true);
    expect(
      isTestRestrictedPrincipalId(principalA.principalId),
    ).toBe(true);
    const suffix = principalA.principalId.slice(TEST_RESTRICTED_PRINCIPAL_PREFIX.length);
    expect(suffix).toMatch(/^[0-9a-f-]{36}$/);
    expect(principalA.projectScope).toEqual({ kind: 'allowlist', projectIds: [projectA.id] });
    expect(principalA.capabilities.has('settings.global.read')).toBe(false);
    expect(principalA.capabilities.has('project.read')).toBe(true);
    expect(Object.isFrozen(principalA)).toBe(true);
    expect(Object.isFrozen((principalA.projectScope as { projectIds: readonly string[] }).projectIds)).toBe(true);

    // 允许列表只含 A：B 的 id 不在结构内（授权判定的唯一范围来源）。
    const scopeProjectIds = (principalA.projectScope as { projectIds: readonly string[] }).projectIds;
    expect(scopeProjectIds).toContain(projectA.id);
    expect(scopeProjectIds).not.toContain(projectB.id);

    const principalB = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: scopeAllowlist([projectB.id]),
    });
    expect(isTestRestrictedPrincipalId(principalB.principalId)).toBe(true);
    expect(principalA.principalId).not.toBe(principalB.principalId);
  });

  it.each([
    ['未知能力', { capabilities: ['not-a-capability'], projectScope: { kind: 'all' } }],
    ['能力非数组', { capabilities: 'project.read', projectScope: { kind: 'all' } }],
    ['重复能力', { capabilities: ['project.read', 'project.read'], projectScope: { kind: 'all' } }],
    ['允许列表为空', { capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [] } }],
    [
      '允许列表含非 UUID',
      { capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: ['project-a'] } },
    ],
    [
      '允许列表含重复项',
      {
        capabilities: ['project.read'],
        projectScope: {
          kind: 'allowlist',
          projectIds: [
            '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111',
          ],
        },
      },
    ],
    ['scope 非法 kind', { capabilities: ['project.read'], projectScope: { kind: 'none' } }],
  ] as const)('非法构造被拒绝：%s', (_name, input) => {
    expect(() =>
      createRestrictedPrincipal(
        input as unknown as Parameters<typeof createRestrictedPrincipal>[0],
      ),
    ).toThrow();
  });

  it('显式 principalId 必须是 test-restricted:<uuid-v4>；local-owner 字面量不被接受为受限 id', () => {
    expect(() =>
      createRestrictedPrincipal({
        principalId: 'test-restricted:not-a-uuid',
        capabilities: ['project.read'],
        projectScope: { kind: 'all' },
      }),
    ).toThrow();
    expect(() =>
      createRestrictedPrincipal({
        principalId: LOCAL_OWNER_PRINCIPAL_ID,
        capabilities: ['project.read'],
        projectScope: { kind: 'all' },
      }),
    ).toThrow();
  });

  it('产品源码不存在任何 test-restricted 身份入口（只能由测试夹具构造）', () => {
    const packagesSrc = join(REPO_ROOT, 'packages');
    const occurrences: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'dist' || entry.name === 'node_modules') {
          continue;
        }
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          const content = readFileSync(child, 'utf8');
          if (content.includes(TEST_RESTRICTED_PRINCIPAL_PREFIX)) {
            occurrences.push(child);
          }
        }
      }
    };
    walk(packagesSrc);
    expect(occurrences).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 同步起跑屏障（命令竞争）
 * ------------------------------------------------------------------ */

describe('F-004 同步起跑屏障', () => {
  it('全部参与方到达后在同一放行点起跑；竞争结果顺序与参与方一致', async () => {
    const order: string[] = [];
    const outcomes = await runWithStartBarrier(
      [
        async () => {
          order.push('a-running');
          return 'A';
        },
        async () => {
          order.push('b-running');
          return 'B';
        },
      ],
      { timeoutMs: 2_000 },
    );
    expect(order).toHaveLength(2);
    expect(outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : 'rejected'))).toEqual([
      'A',
      'B',
    ]);
  });

  it('一方缺席：有界超时拒绝全部等待，未擅自杀害任何资源；迟到参与方也被拒绝', async () => {
    const barrier = createStartBarrier(3, { timeoutMs: 60 });
    const first = barrier.arrive();
    const second = barrier.arrive();
    const started = performance.now();
    await expect(first).rejects.toBeInstanceOf(BarrierTimeoutError);
    await expect(second).rejects.toBeInstanceOf(BarrierTimeoutError);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(barrier.state).toBe('timed_out');
    await expect(barrier.arrive()).rejects.toBeInstanceOf(BarrierTimeoutError);
  });

  it('已放行后屏障完成；单参与方立即放行', async () => {
    const barrier = createStartBarrier(2, { timeoutMs: 2_000 });
    const first = barrier.arrive();
    const second = barrier.arrive();
    await Promise.all([first, second]);
    expect(barrier.state).toBe('released');
    // 迟到者立即放行（不再阻塞），不改变已完成状态。
    await barrier.arrive();
    expect(barrier.state).toBe('released');

    const single = createStartBarrier(1);
    await single.arrive();
    expect(single.state).toBe('released');
  });

  it('参与方数量非法直接拒绝（不建无界/空屏障）', () => {
    expect(() => createStartBarrier(0)).toThrow();
    expect(() => createStartBarrier(2.5)).toThrow();
    expect(() => createStartBarrier(2, { timeoutMs: 0 })).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 4. 真实 SQLite 事务故障注入 + 独立只读探针
 * ------------------------------------------------------------------ */

describe('F-004 事务故障注入（业务写后、事件/回执写前）与真实行探针', () => {
  it('state_events 写入处确定性失败：业务 revision/payload 与事件整组回滚，撤除后成功', async () => {
    const fixture = useCommandsFixture();
    const harness = await fixture.openTransactionalHarness();
    const probe = fixture.openProbe();
    try {
      const registration = await harness.projectService.registerRepository({
        repositoryPath: fixture.repoDirA,
        displayName: '回滚项目 A',
        labels: ['a'],
      });
      expect(registration.status).toBe('registered');
      const projectId = registration.project.id;
      await harness.configurationService.createSettings({ kind: 'global' }, { payload: settingsPayload() });
      await harness.configurationService.createSettings(
        { kind: 'project', projectId },
        { payload: settingsPayload() },
      );
      const rowBefore = probe.settingsRow('project', projectId);
      expect(rowBefore?.revision).toBe(1);
      expect(probe.stateEvents()).toHaveLength(0);
      const countsBefore = probe.counts();

      // 注入点：业务 UPDATE（revision+1、payload 替换）在同一 BEGIN IMMEDIATE
      // 内已执行，state_events INSERT 处 RAISE(ABORT) → 整组回滚。
      const fault = harness.installFault(WRITE_FAULT_POINTS.stateEventsBeforeInsert);
      const error = await (harness.configurationService
        .updateSettings(
          { kind: 'project', projectId },
          { expectedRevision: 1, payload: settingsPayloadV2(SECRET_SENTINEL) },
        )
        .then(
          () => new Error('预期注入失败，但更新成功返回'),
          (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
        ));
      expect(error.message).toContain(fault.message);
      // 注入错误不回显 payload 中的合成凭据哨兵。
      expect(`${error.name} ${error.message}`).not.toContain(SECRET_SENTINEL);

      // 独立只读连接核对真实事务结果（非 mock、非成功日志）。
      expect(probe.settingsRow('project', projectId)).toEqual(rowBefore);
      expect(probe.projectRow(projectId)?.revision).toBe(1);
      expect(probe.stateEvents()).toHaveLength(0);
      expect(probe.counts()).toEqual(countsBefore);

      // 撤除注入后同一 CAS 更新成功：revision 仅 +1，恰一条持久脱敏事件。
      fault.remove();
      expect(fault.removed).toBe(true);
      const recovered = await harness.configurationService.updateSettings(
        { kind: 'project', projectId },
        { expectedRevision: 1, payload: settingsPayloadV2() },
      );
      expect(recovered.revision).toBe(2);
      const rowAfter = probe.settingsRow('project', projectId);
      expect(rowAfter?.revision).toBe(2);
      const events = probe.stateEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('settings.project_updated');
      expect(events[0]!.project_id).toBe(projectId);
      expect(events[0]!.aggregate_revision).toBe(2);
      expect(events[0]!.payload).not.toContain(SECRET_SENTINEL);
      expect(probe.maxSequence()).toBe(1);
    } finally {
      probe.close();
      harness.close();
    }
  });

  it('业务表写入处注入阻止首个写入；command_receipts 注入点真实中止回执写入（F-006 起）', async () => {
    const fixture = useCommandsFixture();
    const harness = await fixture.openTransactionalHarness();
    const probe = fixture.openProbe();
    try {
      const fault = harness.installFault(WRITE_FAULT_POINTS.projectSettingsBeforeInsert);
      const project = await harness.projectService.registerRepository({
        repositoryPath: fixture.repoDirA,
        displayName: '业务注入项目',
      });
      // 注册成功后的基线：项目/绑定各 1，无配置行。
      const countsAfterRegister = probe.counts();
      expect(countsAfterRegister.projects).toBe(1);
      expect(countsAfterRegister.repository_bindings).toBe(1);
      await expect(
        harness.configurationService.createSettings(
          { kind: 'project', projectId: project.project.id },
          { payload: settingsPayload() },
        ),
      ).rejects.toThrow(fault.message);
      // 注入只回滚配置创建，注册行保持，配置行不存在。
      expect(probe.counts()).toEqual(countsAfterRegister);
      expect(probe.settingsRow('project', project.project.id)).toBeUndefined();
      fault.remove();
      const recovered = await harness.configurationService.createSettings(
        { kind: 'project', projectId: project.project.id },
        { payload: settingsPayload() },
      );
      expect(recovered.revision).toBe(1);
      expect(probe.settingsRow('project', project.project.id)?.revision).toBe(1);

      // F-006 迁移 v3 起：回执注入点真实存在；安装后同一连接的回执写入被
      // 中止且零残留，撤除后经真实适配器写入恢复（探针独立连接核对）。
      expect(probe.counts().command_receipts).toBe(0);
      const receiptFault = harness.installFault(WRITE_FAULT_POINTS.commandReceiptsBeforeInsert);
      const receiptStore = createSqliteCommandReceiptStore(harness.session);
      const receipt = createCompletedReceipt({
        commandId: randomUUID(),
        principalId: fixture.localOwner().principalId,
        operation: 'project.register',
        scope: { kind: 'registration' },
        requestDigest: createHash('sha256').update('f006-fixture-kit').digest('hex'),
        issuedAt: new Date(1_760_000_000_000).toISOString(),
        completedAt: new Date(1_760_000_000_001).toISOString(),
        result: { status: 'registered', project: { id: randomUUID() } },
        resultRef: createResultRef(randomBytes(32)),
      });
      await expect(receiptStore.saveReceipt(receipt)).rejects.toThrow(receiptFault.message);
      expect(probe.counts().command_receipts).toBe(0);
      expect(probe.receiptRow(receipt.principalId, receipt.commandId)).toBeUndefined();
      receiptFault.remove();
      await receiptStore.saveReceipt(receipt);
      expect(probe.counts().command_receipts).toBe(1);
      expect(probe.receiptRow(receipt.principalId, receipt.commandId)?.status).toBe('completed');
    } finally {
      probe.close();
      harness.close();
    }
  });

  it('注入器拒绝任意表名/非法消息；独立探针只读（写尝试被驱动拒绝）', async () => {
    const fixture = useCommandsFixture();
    // 先经公开装配创建/迁移真实库，再以独立只读连接打开。
    const app = await fixture.openApplication();
    app.close();
    const probe = openStorageProbe(fixture.dbPath);
    try {
      expect(probe.counts().projects).toBe(0);
      // 注入点必须来自冻结表白名单：任意 SQL 标识符拼接被拒绝（无需真实连接）。
      expect(() =>
        installWriteFault({} as never, {
          target: { table: 'projects; DROP TABLE projects', when: 'BEFORE', operation: 'INSERT', label: 'evil' },
        }),
      ).toThrow();
      expect(() =>
        installWriteFault({} as never, {
          target: WRITE_FAULT_POINTS.stateEventsBeforeInsert,
          message: 'p02-2 injected fault: bad message with spaces; DROP TABLE projects',
        }),
      ).toThrow();
      // 只读探针：任何写语句在 SQL 解析前即被夹具拒绝。
      expect(() => probe.selectOne('INSERT INTO projects (id) VALUES (?)', ['x'])).toThrow();
      expect(() => probe.selectAll('DELETE FROM projects')).toThrow();
      expect(probe.selectOne<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
    } finally {
      probe.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. 保留下界水位（F-012 测试缝，不删持久审计）
 * ------------------------------------------------------------------ */

describe('F-004 保留下界水位控制器', () => {
  it('默认 0；按 scope 独立设置/复位；非法值拒绝；快照不含越权结构', () => {
    const controller = createReplayLowerBoundController();
    const projectScope = { kind: 'project' as const, projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    expect(controller.retainedSequence(projectScope)).toBe(0);
    expect(controller.retainedSequence({ kind: 'global' })).toBe(0);
    controller.setRetained(projectScope, 30);
    controller.setRetained({ kind: 'global' }, 7);
    expect(controller.retainedSequence(projectScope)).toBe(30);
    expect(controller.retainedSequence({ kind: 'global' })).toBe(7);
    expect(controller.snapshot()).toEqual({
      'project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 30,
      global: 7,
    });
    controller.reset(projectScope);
    expect(controller.retainedSequence(projectScope)).toBe(0);
    expect(controller.retainedSequence({ kind: 'global' })).toBe(7);
    controller.reset();
    expect(controller.snapshot()).toEqual({});

    expect(() => controller.setRetained(projectScope, -1)).toThrow();
    expect(() => controller.setRetained(projectScope, 1.5)).toThrow();
    expect(() =>
      controller.setRetained({ kind: 'project', projectId: 'not-uuid' }, 1),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 6. 跨进程竞争屏障运行器（复用 P02-1 managed-child）
 * ------------------------------------------------------------------ */

describe('F-004 跨进程竞争屏障运行器', () => {
  it('两个真实子进程经 ready/go 同时起跑，结果按序返回且退出经核验', async () => {
    const box = useHostEnv();
    const outcomes = await runBarrierChildren(box, {
      scriptPath: BARRIER_PROBE_CHILD,
      configs: [{ index: 0 }, { index: 1, delayMs: 5 }],
      readyTimeoutMs: 10_000,
      resultTimeoutMs: 10_000,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => (outcome.result as { index?: number }).index)).toEqual([0, 1]);
    expect(outcomes[0]!.pid).not.toBe(outcomes[1]!.pid);
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow(); // OS 层已退出
    }
    // 证据只记 pid/退出码，无认证头/token 字段。
    const serialized = box.evidence.serialize();
    expect(serialized).toContain('child.exit');
    expect(serialized.toLowerCase()).not.toContain('authorization');
  }, 30_000);

  it('子进程持住不报结果：结果有界超时，全部子进程被协作关闭并核验退出', async () => {
    const box = useHostEnv();
    await expect(
      runBarrierChildren(box, {
        scriptPath: BARRIER_PROBE_CHILD,
        configs: [{ index: 0 }, { index: 1, hold: true }],
        readyTimeoutMs: 10_000,
        resultTimeoutMs: 400,
      }),
    ).rejects.toThrow();
    // 运行器拒绝路径必须自行回收：监督器上无存活子进程。
    for (const child of box.processes.tracked) {
      expect(child.isAlive()).toBe(false);
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * 7. 原始 SSE 客户端：帧、暂停消费、断开/重连
 * ------------------------------------------------------------------ */

interface LoopbackSseHarness {
  readonly port: number;
  readonly url: string;
  readonly server: Server;
  readonly connections: LoopbackSseConnectionObservation[];
  close(): Promise<void>;
}

interface LoopbackSseConnectionObservation {
  readonly socket: Socket;
  readonly lastEventId: string | undefined;
  readonly authorization: string | undefined;
  readonly path: string;
  response: ServerResponse;
  sawBackpressure: boolean;
  closed: boolean;
}

/**
 * 最小真实 SSE 服务（仅本测试文件）：记录 Last-Event-ID/Authorization，
 * 暴露逐字节写入与连接关闭观察，供 F-012 客户端/背压工具自测。
 */
async function startLoopbackSseServer(
  handler: (observation: LoopbackSseConnectionObservation, body: IncomingMessage) => Promise<void> | void,
): Promise<LoopbackSseHarness> {
  const connections: LoopbackSseConnectionObservation[] = [];
  const server = createServer((req, res) => {
    const observation: LoopbackSseConnectionObservation = {
      socket: req.socket,
      lastEventId: req.headers['last-event-id'] as string | undefined,
      authorization: req.headers['authorization'] as string | undefined,
      path: req.url ?? '/',
      response: res,
      sawBackpressure: false,
      closed: false,
    };
    connections.push(observation);
    req.socket.on('close', () => {
      observation.closed = true;
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    void handler(observation, req);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('伪 SSE 服务未取得监听地址');
  }
  return {
    server,
    connections,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sseFrame(frame: { id?: string; event?: string; data: string }): string {
  let raw = '';
  if (frame.id !== undefined) {
    raw += `id: ${frame.id}\n`;
  }
  if (frame.event !== undefined) {
    raw += `event: ${frame.event}\n`;
  }
  raw += `data: ${frame.data}\n\n`;
  return raw;
}

async function collectEvents(connection: SseConnection, count: number): Promise<SseConnection['lastEventId'][]> {
  const frames: SseConnection['lastEventId'][] = [];
  for await (const frame of connection.events()) {
    frames.push(frame.data);
    if (frames.length >= count) {
      break;
    }
  }
  return frames;
}

const SSE_TOKEN = 't'.repeat(48) + 'f004sse';

describe('F-004 原始 loopback SSE 客户端', () => {
  it('跨 chunk/多字节 UTF-8 边界与 CRLF 的帧完整解析；心跳忽略；lastEventId 跟踪', async () => {
    const harness = await startLoopbackSseServer(async (obs) => {
      const multibyte = '事件🚢舨';
      const frames = [
        sseFrame({ id: '1', event: 'state-event', data: JSON.stringify({ seq: 1 }) }),
        ': ping\n\n',
        sseFrame({ id: '2', event: 'state-event', data: multibyte }),
      ];
      // 故意在多字节字符中间切分写入，并混用 CRLF。
      const payload = frames.join('').replace('\nid: 2', '\r\nid: 2');
      const cut = Buffer.from(payload, 'utf8').indexOf(Buffer.from('🚢', 'utf8')) + 2;
      obs.response.write(Buffer.from(payload, 'utf8').subarray(0, cut));
      setTimeout(() => obs.response.end(Buffer.from(payload, 'utf8').subarray(cut)), 10);
    });
    try {
      const connection = await connectSseLoopback({
        port: harness.port,
        token: SSE_TOKEN,
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 2_000,
      });
      try {
        expect(harness.connections[0]!.authorization).toBe(`Bearer ${SSE_TOKEN}`);
        const datas: string[] = [];
        for await (const frame of connection.events()) {
          datas.push(frame.data);
          expect(frame.event).toBe('state-event');
          if (datas.length >= 2) {
            break;
          }
        }
        expect(datas[0]).toBe(JSON.stringify({ seq: 1 }));
        expect(datas[1]).toBe('事件🚢舨');
        expect(connection.lastEventId).toBe('2');
        expect(connection.eventsReceived).toBe(2);
      } finally {
        await connection.close();
      }
    } finally {
      await harness.close();
    }
  });

  it('暂停消费使服务端写出出现真实背压；恢复后继续投递', async () => {
    const harness = await startLoopbackSseServer(async (obs) => {
      const chunk = sseFrame({ id: 'x', data: 'x'.repeat(512) });
      for (let i = 0; i < 4_096; i += 1) {
        if (obs.closed) {
          return;
        }
        const ok = obs.response.write(chunk);
        if (!ok) {
          obs.sawBackpressure = true;
          await new Promise<void>((resolve) => obs.socket.once('drain', () => resolve()));
          if (obs.closed) {
            return;
          }
        }
      }
      obs.response.end();
    });
    try {
      const connection = await connectSseLoopback({
        port: harness.port,
        token: SSE_TOKEN,
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 2_000,
      });
      try {
        connection.pauseConsumption();
        expect(connection.consumptionPaused).toBe(true);
        // 有界等待服务端观察到背压（TCP 接收窗口收窄），不依赖固定 sleep。
        await viWaitFor(() => harness.connections.some((obs) => obs.sawBackpressure), 5_000);
        connection.resumeConsumption();
        expect(connection.consumptionPaused).toBe(false);
        let received = 0;
        for await (const frame of connection.events()) {
          received += 1;
          if (received >= 100) {
            break;
          }
        }
        expect(received).toBe(100);
      } finally {
        await connection.close();
      }
    } finally {
      await harness.close();
    }
  }, 20_000);

  it('客户端突然断开：服务端在有界时间内观察到 TCP 关闭，服务进程不受影响', async () => {
    const harness = await startLoopbackSseServer(async (obs) => {
      let i = 0;
      while (!obs.closed) {
        obs.response.write(sseFrame({ id: String((i += 1)), data: 'keep-alive' }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    try {
      const connection = await connectSseLoopback({
        port: harness.port,
        token: SSE_TOKEN,
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 2_000,
      });
      await collectEvents(connection, 1);
      await connection.close();
      await viWaitFor(() => harness.connections.every((obs) => obs.closed), 3_000);
      expect(connection.lastEventId).toBe('1');
      // 服务端仍可接受新连接（断开一个客户端不停止服务）。
      const second = await connectSseLoopback({
        port: harness.port,
        token: SSE_TOKEN,
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 2_000,
      });
      await collectEvents(second, 1);
      await second.close();
    } finally {
      await harness.close();
    }
  });

  it('重连携带 Last-Event-ID 并从下一条续读；游标走 query，不重置身份', async () => {
    const harness = await startLoopbackSseServer(async (obs) => {
      const from = Number(obs.lastEventId ?? '0');
      for (let i = from + 1; i <= from + 2; i += 1) {
        obs.response.write(sseFrame({ id: String(i), event: 'state-event', data: `evt-${i}` }));
      }
      // 不 end：保持连接，由客户端断开。
      await new Promise<void>((resolve) => obs.socket.on('close', resolve));
    });
    try {
      const first = await connectSseLoopback({
        port: harness.port,
        token: SSE_TOKEN,
        cursor: 'evcur_v1_Zw', // 非 Last-Event-ID 路径由服务端 query 观测
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 2_000,
      });
      expect(await collectEvents(first, 2)).toEqual(['evt-1', 'evt-2']);
      const reconnected = await first.reconnect();
      try {
        expect(reconnected).not.toBe(first);
        expect(harness.connections[1]!.lastEventId).toBe('2');
        expect(harness.connections[1]!.path).toContain('cursor=evcur_v1_');
        expect(harness.connections[1]!.authorization).toBe(`Bearer ${SSE_TOKEN}`);
        expect(await collectEvents(reconnected, 2)).toEqual(['evt-3', 'evt-4']);
      } finally {
        await reconnected.close();
      }
    } finally {
      await harness.close();
    }
  });

  it('建连/响应头有界超时；非 SSE 响应拒绝；错误与证据不含 token', async () => {
    // TCP 接受但永不回响应头 → headers 超时，客户端回收 socket。
    const silent = createServer((req, res) => {
      req.resume();
      void res;
      // 保持 socket 不写任何响应。
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as { port: number }).port;
    try {
      await expect(
        connectSseLoopback({
          port: silentPort,
          token: SSE_TOKEN,
          connectTimeoutMs: 500,
          headersTimeoutMs: 300,
        }),
      ).rejects.toMatchObject({ code: 'headers_timeout' });
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }

    // 未监听端口 → 有界连接失败（不挂起）。
    await expect(
      connectSseLoopback({
        port: 1,
        token: SSE_TOKEN,
        connectTimeoutMs: 1_000,
        headersTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'connect_failed' });

    // 非 SSE 响应（200 JSON）→ non_sse_response，错误文本不含 token。
    const json = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'boom' } }));
    });
    await new Promise<void>((resolve) => json.listen(0, '127.0.0.1', resolve));
    const jsonPort = (json.address() as { port: number }).port;
    let error: unknown;
    try {
      try {
        await connectSseLoopback({
          port: jsonPort,
          token: SSE_TOKEN,
          connectTimeoutMs: 1_000,
          headersTimeoutMs: 1_000,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SseClientError);
      expect((error as SseClientError).code).toBe('non_sse_response');
      expect(String((error as Error).message)).not.toContain(SSE_TOKEN);
      expect(JSON.stringify(error)).not.toContain(SSE_TOKEN);
    } finally {
      await new Promise<void>((resolve) => json.close(() => resolve()));
    }
  }, 10_000);

  it('单帧超过解析缓冲上限：有界失败且不含 token；客户端关闭连接', async () => {
    const harness = await startLoopbackSseServer(async (obs) => {
      obs.response.write(sseFrame({ id: '1', data: 'z'.repeat(4_096) }));
      await new Promise<void>((resolve) => obs.socket.on('close', resolve));
    });
    try {
      await expect(
        connectSseLoopback({
          port: harness.port,
          token: SSE_TOKEN,
          maxBufferedBytes: 1_024,
          connectTimeoutMs: 2_000,
          headersTimeoutMs: 2_000,
        }).then(async (connection) => {
          try {
            // 触发迭代并等待缓冲超限。
            for await (const _frame of connection.events()) {
              void _frame;
            }
          } finally {
            await connection.close();
          }
        }),
      ).rejects.toMatchObject({ code: 'buffer_overflow' });
      await viWaitFor(() => harness.connections.every((obs) => obs.closed), 3_000);
    } finally {
      await harness.close();
    }
  });

  it('脱敏证据：登记 token 后任何携带认证头原值的记录被 fail-closed 拒绝', async () => {
    const fixture = useCommandsFixture();
    fixture.evidence.registerSecret(SSE_TOKEN);
    expect(() =>
      fixture.evidence.record('sse.connect', { authorization: `Bearer ${SSE_TOKEN}` }),
    ).toThrow(EvidenceSecretLeakError);
    // 允许的非秘密分类字段。
    expect(() => fixture.evidence.record('sse.connect', { auth: 'bearer', path: '/v1/events' })).not.toThrow();
    expect(fixture.evidence.serialize()).not.toContain(SSE_TOKEN);
  });
});
