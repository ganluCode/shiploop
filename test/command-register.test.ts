/**
 * F-008：project.register 幂等命令纵向切片——只读仓库检查在写事务之外，
 * 项目 + 绑定 + project.registered 创建事件 + completed 回执在同一
 * BEGIN IMMEDIATE 内原子提交；同 canonicalPath（含符号链接别名）复用
 * already_exists；P01 直接服务首建仍不写创建事件。
 * 全部断言基于真实 SQLite/Git/只读探针，不以方法调用或日志代替业务状态。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { mapStateEvent } from '../packages/core/src/ports/events.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture, runWithStartBarrier, runBarrierChildren, WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
afterEach(async () => {
  await environment?.dispose();
  environment = undefined;
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f008-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    nowUtcMs: () => now,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelope = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 3, commandId: randomUUID(), operation: 'project.register',
    scope: { kind: 'registration' }, issuedAt: NOW_ISO,
    payload: { repositoryPath: box.repoDirA, displayName: 'Repo A', labels: [' Team ', 'team', 'core'] },
    ...changes,
  });
  return { box, harness, store, service, probe, owner, envelope, setNow: (value: number) => { now = value; } };
}

function original(receipt: CommandReceipt) { return { ...receipt, replayed: false }; }
function completedOf(receipt: CommandReceipt) {
  if (receipt.status !== 'completed' || receipt.result === null) throw new Error('expected completed');
  return receipt.result as { status: string; project: Record<string, unknown>; binding: Record<string, unknown> };
}

describe('F-008 注册命令', () => {
  it('注册成功原子保存项目/绑定/创建事件/回执；结果与持久状态一致，无执行就绪语义', async () => {
    const s = await setup();
    const input = s.envelope();
    const receipt = await s.service.submit(s.owner, input);
    expect(receipt).toMatchObject({
      status: 'completed', replayed: false, operation: 'project.register',
      scope: { kind: 'registration' }, issuedAt: NOW_ISO, completedAt: NOW_ISO,
    });
    const result = completedOf(receipt);
    expect(result.status).toBe('registered');
    expect(result.project).toMatchObject({
      displayName: 'Repo A', description: null, status: 'active',
      labels: ['team', 'core'], revision: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO,
    });
    const projectId = result.project.id as string;
    expect(result.binding).toMatchObject({
      projectId, canonicalPath: realpathSync(s.box.repoDirA),
      revision: 1, bindingRevision: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO,
    });
    expect(typeof result.binding.repoIdentity).toBe('string');
    // 注册结果不声称基线健康/执行就绪；瞬时检查事实（HEAD/脏状态）不进结果。
    expect(JSON.stringify(result)).not.toMatch(/baseline|executable|headCommit|ready/i);
    // 持久状态与结果一致（独立只读连接核对）。
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
    });
    expect(s.probe.projectRow(projectId)).toMatchObject({
      display_name: 'Repo A', revision: 1, repository_binding_id: result.binding.id,
    });
    const events = s.probe.stateEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      project_id: projectId, sequence: 1, event_type: 'project.registered',
      aggregate_type: 'project', aggregate_id: projectId, aggregate_revision: 1,
      payload: '{"registered":true}',
    });
    // 事件经 F-003 公开映射复核（scope/aggregate/occurredAt/payload 白名单）；
    // snake_case 列 → PersistedStateEventRow 的映射由 F-010 读取端口承担，此处显式转换。
    const row = events[0]!;
    expect(mapStateEvent({
      id: row.id, sequence: row.sequence, eventType: row.event_type,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateRevision: row.aggregate_revision, projectId: row.project_id,
      payload: JSON.parse(row.payload as string), occurredAtUtcMs: row.occurred_at,
    })).toMatchObject({
      schemaVersion: 1, sequence: 1, type: 'project.registered',
      scope: { kind: 'project', projectId },
      aggregate: { type: 'project', id: projectId, revision: 1 },
      occurredAt: NOW_ISO, payload: { registered: true },
    });
    // 授权读取与 resultRef 解析得到同一稳定回执。
    const app = await s.box.openApplication();
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(original(receipt));
    if (receipt.status !== 'completed') throw new Error('expected completed');
    expect(await app.commandReceiptsService.resolveResult(s.owner, receipt.resultRef)).toEqual(original(receipt));
  });

  it('同 commandId/规范摘要重试复用原结果；副作用恰一次', async () => {
    const s = await setup();
    const input = s.envelope();
    const outcomes = await runWithStartBarrier([
      () => s.service.submit(s.owner, input),
      () => s.service.submit(s.owner, {
        ...input,
        payload: { labels: ['team', ' Team ', 'core'], description: null, displayName: 'Repo A', repositoryPath: s.box.repoDirA },
      }),
    ]);
    const receipts = outcomes.map(outcome => {
      if (outcome.status !== 'fulfilled') throw outcome.reason;
      return outcome.value;
    });
    expect(receipts.map(original)).toEqual([original(receipts[0]!), original(receipts[0]!)]);
    expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
    });
  });

  it('不同 commandId 注册同一 canonicalPath 返回既有项目，不新增行/事件、不覆盖名称与标签', async () => {
    const s = await setup();
    const first = completedOf(await s.service.submit(s.owner, s.envelope()));
    const second = await s.service.submit(s.owner, s.envelope({
      payload: { repositoryPath: s.box.repoDirA, displayName: 'renamed attempt', labels: ['other'] },
    }));
    const secondResult = completedOf(second);
    expect(secondResult.status).toBe('already_exists');
    expect(secondResult.project).toMatchObject({
      id: first.project.id, displayName: 'Repo A', labels: ['team', 'core'], revision: 1,
    });
    expect(secondResult.binding).toEqual(first.binding);
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 2,
    });
    expect(s.probe.stateEvents()).toHaveLength(1);
  });

  it('符号链接别名复用同一项目身份；同 remote 的不同 clone 分别注册', async () => {
    const s = await setup();
    const root = dirname(s.box.repoDirA);
    const alias = join(root, 'alias-to-a');
    symlinkSync(s.box.repoDirA, alias, 'dir');
    const first = completedOf(await s.service.submit(s.owner, s.envelope()));
    const viaAlias = completedOf(await s.service.submit(s.owner, s.envelope({
      payload: { repositoryPath: alias, displayName: 'alias attempt' },
    })));
    expect(viaAlias.status).toBe('already_exists');
    expect(viaAlias.project.id).toBe(first.project.id);
    expect(viaAlias.binding.canonicalPath).toBe(realpathSync(s.box.repoDirA));
    // 同 remote 的不同 clone：canonicalPath 与 repoIdentity 均不同，可分别注册。
    const clone = join(root, 'clone-of-a');
    execFileSync('git', ['clone', s.box.repoDirA, clone], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const viaClone = completedOf(await s.service.submit(s.owner, s.envelope({
      payload: { repositoryPath: clone, displayName: 'clone of A' },
    })));
    expect(viaClone.status).toBe('registered');
    expect(viaClone.project.id).not.toBe(first.project.id);
    expect(viaClone.binding.repoIdentity).not.toBe(first.binding.repoIdentity);
    expect(s.probe.counts()).toMatchObject({
      projects: 2, repository_bindings: 2, state_events: 2, command_receipts: 3,
    });
  });

  it.each([
    ['missing', 'repository_path_not_found'],
    ['file', 'repository_not_a_directory'],
    ['plain', 'repository_not_a_repository'],
  ] as const)('非法仓库 %s 受控 invalid_input，零副作用且不回显路径', async (kind, reason) => {
    const s = await setup();
    const root = dirname(s.box.repoDirA);
    let candidate: string;
    if (kind === 'missing') {
      candidate = join(root, 'missing-repository');
    } else if (kind === 'file') {
      candidate = join(root, 'a-plain-file');
      writeFileSync(candidate, 'not a directory');
    } else {
      candidate = join(root, 'plain-directory');
      mkdirSync(candidate);
    }
    const error = await s.service.submit(s.owner, s.envelope({
      payload: { repositoryPath: candidate, displayName: 'bad' },
    })).catch(e => e);
    expect(error).toMatchObject({ code: 'invalid_input', details: { reason } });
    expect(JSON.stringify(error.toErrorShape())).not.toContain(candidate);
    expect(JSON.stringify(error.toErrorShape())).not.toMatch(/shiploop-f008/);
    expect(s.probe.counts()).toMatchObject({
      projects: 0, repository_bindings: 0, state_events: 0, command_receipts: 0,
    });
  });

  it('未获注册能力在仓库检查之前拒绝；既有项目不可见 → forbidden 且不积回执', async () => {
    const s = await setup();
    // 无能力 + 不存在的路径：若授权先于检查则必为 forbidden 而非 invalid_input。
    const noCapability = s.box.restrictedPrincipal({
      capabilities: [], projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    await expect(s.service.submit(noCapability, s.envelope({
      payload: { repositoryPath: join(dirname(s.box.repoDirA), 'missing-x'), displayName: 'x' },
    }))).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });
    expect(s.probe.counts()).toMatchObject({
      projects: 0, repository_bindings: 0, state_events: 0, command_receipts: 0,
    });
    // owner 注册 A；受限主体（有注册能力但 A 不在可见范围）注册同一路径 → forbidden。
    const first = completedOf(await s.service.submit(s.owner, s.envelope()));
    const invisible = s.box.restrictedPrincipal({
      capabilities: ['project.register'], projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    await expect(s.service.submit(invisible, s.envelope())).rejects.toMatchObject({
      code: 'forbidden', details: { reason: 'project_not_visible' },
    });
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
    });
    // 可见范围包含 A 的受限主体正常 already_exists 复用。
    const visible = s.box.restrictedPrincipal({
      capabilities: ['project.register'], projectScope: s.box.scopeAllowlist([first.project.id as string]),
    });
    const reused = completedOf(await s.service.submit(visible, s.envelope()));
    expect(reused.status).toBe('already_exists');
    expect(reused.project.id).toBe(first.project.id);
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 2,
    });
  });

  it.each(['repositoryBindingsBeforeInsert', 'stateEventsBeforeInsert', 'commandReceiptsBeforeInsert'] as const)(
    '%s 失败整组回滚（无孤立项目/绑定），撤除后相同信封重试成功', async point => {
      const s = await setup();
      const input = s.envelope();
      const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
      const error = await s.service.submit(s.owner, input).catch(e => e);
      expect(error).toMatchObject({ code: 'internal', operation: 'project.register' });
      expect(JSON.stringify(error.toErrorShape())).not.toMatch(/SQL|injected|TRIGGER|shiploop-f008/);
      expect(s.probe.counts()).toMatchObject({
        projects: 0, repository_bindings: 0, state_events: 0, command_receipts: 0,
      });
      fault.remove();
      expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
      expect(s.probe.counts()).toMatchObject({
        projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
      });
    },
  );

  it('过期新命令不做仓库检查/业务写入；历史注册回执仍稳定重放', async () => {
    const s = await setup();
    const input = s.envelope();
    const completed = await s.service.submit(s.owner, input);
    s.setNow(NOW + 60_000);
    // 新命令（同一路径）过期：在写锁之外拒绝，不产生 already_exists 或任何写入。
    await expect(s.service.submit(s.owner, s.envelope())).rejects.toMatchObject({ code: 'command_expired' });
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
    });
    expect(await s.service.submit(s.owner, input)).toEqual({ ...completed, replayed: true });
  });

  it('注册重放重核当前可见性：原注册项目不可见 → not_found，不泄漏旧结果', async () => {
    const s = await setup();
    const input = s.envelope();
    // 受限注册主体：allowlist 占位（新项目 ID 事先生成不可预知），注册成功。
    const principal = s.box.restrictedPrincipal({
      capabilities: ['project.register'], projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const completed = await s.service.submit(principal, input);
    const projectId = completedOf(completed).project.id as string;
    // 同一身份重放：原注册项目当前不可见 → not_found（不区分不存在与无权）。
    await expect(s.service.submit(principal, input)).rejects.toMatchObject({
      code: 'not_found', details: { reason: 'receipt_not_found' },
    });
    // 同一 principalId 但可见范围覆盖原项目：稳定重放原回执。
    const widened = s.box.restrictedPrincipal({
      principalId: principal.principalId,
      capabilities: ['project.register'], projectScope: s.box.scopeAllowlist([projectId]),
    });
    expect(await s.service.submit(widened, input)).toEqual({ ...completed, replayed: true });
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1,
    });
  });

  it('P01 直接服务注册不写创建事件；命令路径写；两条边界共存回归', async () => {
    const s = await setup();
    // P01 边界（F-005 语义保留）：直接服务首建不写 state_events。
    const direct = await s.harness.projectService.registerRepository({
      repositoryPath: s.box.repoDirB, displayName: 'direct B', labels: ['b'],
    });
    expect(direct.status).toBe('registered');
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 0, command_receipts: 0,
    });
    // 命令路径注册 A：恰一条 project.registered。
    await s.service.submit(s.owner, s.envelope());
    expect(s.probe.stateEvents()).toHaveLength(1);
    expect(s.probe.stateEvents()[0]).toMatchObject({ event_type: 'project.registered' });
    // P01 服务再次注册同一路径（B）：幂等复用，仍不写事件。
    const again = await s.harness.projectService.registerRepository({
      repositoryPath: s.box.repoDirB, displayName: 'ignored',
    });
    expect(again.status).toBe('already_exists');
    expect(again.project.id).toBe(direct.project.id);
    expect(s.probe.counts()).toMatchObject({
      projects: 2, repository_bindings: 2, state_events: 1, command_receipts: 1,
    });
  });

  it('元数据/标签命令沿用 P01 CAS 与规范化，恰一条事件，不触碰 projectId/绑定/配置', async () => {
    const s = await setup();
    const registered = completedOf(await s.service.submit(s.owner, s.envelope()));
    const projectId = registered.project.id as string;
    const bindingBefore = s.probe.selectOne('SELECT * FROM repository_bindings WHERE project_id = ?', [projectId]);
    const receipt = await s.service.submit(s.owner, {
      schemaVersion: 3, commandId: randomUUID(), operation: 'project.metadata.update',
      scope: { kind: 'project', projectId }, expectedRevision: 1, issuedAt: NOW_ISO,
      payload: { labels: [' Beta ', 'alpha', 'beta'], description: 'updated' },
    });
    const result = completedOf(receipt).project;
    expect(result).toMatchObject({
      id: projectId, displayName: 'Repo A', description: 'updated',
      labels: ['beta', 'alpha'], revision: 2,
      repositoryBindingId: registered.binding.id,
    });
    // 恰两条事件（registered + metadata_updated），绑定行与配置零变化。
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 2,
      project_settings: 0, global_settings: 0, command_receipts: 2,
    });
    expect(s.probe.selectOne('SELECT * FROM repository_bindings WHERE project_id = ?', [projectId]))
      .toEqual(bindingBefore);
    expect(s.probe.stateEvents()[1]).toMatchObject({
      event_type: 'project.metadata_updated', aggregate_id: projectId, aggregate_revision: 2,
      payload: '{"changedFields":["description","labels"]}',
    });
    // 过期 revision：rejected 固化，对象与事件不再变化。
    const stale = await s.service.submit(s.owner, {
      schemaVersion: 3, commandId: randomUUID(), operation: 'project.metadata.update',
      scope: { kind: 'project', projectId }, expectedRevision: 1, issuedAt: NOW_ISO,
      payload: { displayName: 'stale write' },
    });
    expect(stale).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(s.probe.projectRow(projectId)).toMatchObject({ revision: 2, display_name: 'Repo A' });
    expect(s.probe.counts()).toMatchObject({ state_events: 2, command_receipts: 3 });
  });

  it('跨进程竞争注册同一路径：恰一个 registered，其余 already_exists；核验持久副作用与全部退出', async () => {
    const s = await setup();
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-race-' });
    const make = () => s.envelope({ payload: { repositoryPath: s.box.repoDirA, displayName: 'raced' } });
    const outcomes = await runBarrierChildren(environment, {
      scriptPath: fileURLToPath(new URL('./helpers/p02-2/atomic-command-child.ts', import.meta.url)),
      configs: [make(), make()].map(envelope => ({ dbPath: s.box.dbPath, envelope, now: NOW })),
      readyTimeoutMs: 10_000, resultTimeoutMs: 10_000,
    });
    const receipts = outcomes.map(o => {
      if (o.result.error) throw new Error(`子进程意外失败: ${JSON.stringify(o.result.error)}`);
      return o.result.receipt as CommandReceipt;
    });
    const results = receipts.map(completedOf);
    expect(results.map(r => r.status).sort()).toEqual(['already_exists', 'registered']);
    expect(results[0]!.project.id).toBe(results[1]!.project.id);
    expect(receipts.map(r => r.replayed).sort()).toEqual([false, false]);
    expect(s.probe.counts()).toMatchObject({
      projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 2,
    });
    expect(s.probe.stateEvents()[0]).toMatchObject({ event_type: 'project.registered', sequence: 1 });
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow();
    }
    expect(environment.evidence.serialize()).toContain('child.exit');
  }, 30_000);
});
