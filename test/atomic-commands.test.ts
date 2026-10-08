/** F-007：真实业务状态断言；不以方法调用或日志代替原子性。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import type { CommandTransaction } from '../packages/core/src/ports/atomic-commands.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture, runWithStartBarrier, runBarrierChildren, WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
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
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f007-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  const project = await harness.store.createProject({ displayName: 'original', labels: ['old'] });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service = createCommandService({ atomicStore: store, nowUtcMs: () => now });
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelope = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 2, commandId: randomUUID(), operation: 'project.metadata.update',
    scope: { kind: 'project', projectId: project.id }, expectedRevision: 1,
    issuedAt: new Date(NOW).toISOString(), payload: { displayName: 'edited', labels: [' NEW ', 'new'] },
    ...changes,
  });
  return { box, harness, project, store, service, probe, owner, envelope, setNow: (value: number) => { now = value; } };
}

function original(receipt: CommandReceipt) { return { ...receipt, replayed: false }; }

describe('F-007 原子幂等命令', () => {
  it('同 ID/规范摘要竞争只更新一次；结果引用和回执与真实状态一致', async () => {
    const s = await setup();
    const input = s.envelope();
    const outcomes = await runWithStartBarrier([
      () => s.service.submit(s.owner, input),
      () => s.service.submit(s.owner, { ...input, payload: { labels: ['new'], displayName: 'edited' } }),
    ]);
    const receipts = outcomes.map(outcome => {
      if (outcome.status !== 'fulfilled') throw outcome.reason;
      return outcome.value;
    });
    expect(receipts.map(original)).toEqual([original(receipts[0]!), original(receipts[0]!)]);
    expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(receipts[0]).toMatchObject({ status: 'completed', result: { project: {
      id: s.project.id, revision: 2, labels: ['new'], displayName: 'edited',
      createdAt: new Date(s.project.createdAtUtcMs).toISOString(), updatedAt: new Date(NOW).toISOString(),
    } } });
    expect(s.probe.projectRow(s.project.id)).toMatchObject({ revision: 2, display_name: 'edited' });
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
    expect(s.probe.stateEvents()[0]).toMatchObject({ aggregate_revision: 2, payload: '{"changedFields":["displayName","labels"]}' });
    const app = await s.box.openApplication();
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(original(receipts[0]!));
    if (receipts[0]!.status !== 'completed') throw new Error('expected completed');
    expect(await app.commandReceiptsService.resolveResult(s.owner, receipts[0]!.resultRef)).toEqual(original(receipts[0]!));
  });

  it('同 ID 异摘要 conflict，原回执/业务/事件不被覆盖', async () => {
    const s = await setup(); const input = s.envelope();
    await s.service.submit(s.owner, input);
    const before = s.probe.receiptRow(s.owner.principalId, input.commandId);
    await expect(s.service.submit(s.owner, { ...input, payload: { displayName: 'other' } })).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'idempotency_key_reuse' },
    });
    expect(s.probe.receiptRow(s.owner.principalId, input.commandId)).toEqual(before);
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(2);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
  });

  it.each(['stateEventsBeforeInsert', 'commandReceiptsBeforeInsert'] as const)(
    '%s 失败整组回滚，撤除后相同信封可重试，不遗留 accepted', async point => {
      const s = await setup(); const input = s.envelope();
      const before = s.probe.projectRow(s.project.id); const counts = s.probe.counts();
      const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
      const error = await s.service.submit(s.owner, input).catch(e => e);
      expect(error).toMatchObject({ code: 'internal', operation: 'project.metadata.update' });
      expect(JSON.stringify(error.toErrorShape())).not.toMatch(/SQL|injected|TRIGGER|stack|shiploop-f007/);
      expect(s.probe.projectRow(s.project.id)).toEqual(before);
      expect(s.probe.counts()).toEqual(counts);
      expect(s.probe.receiptRow(s.owner.principalId, input.commandId)).toBeUndefined();
      fault.remove();
      expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
      expect(s.probe.projectRow(s.project.id)?.revision).toBe(2);
      expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
    },
  );

  it('CAS 冲突持久 rejected；晚到重放不改拒绝，新的 ID 才可修正输入', async () => {
    const s = await setup(); const rejectedInput = s.envelope({ expectedRevision: 2 });
    const rejected = await s.service.submit(s.owner, rejectedInput);
    expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { expectedRevision: 2, actualRevision: 1 } } });
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 1 });
    await s.service.submit(s.owner, s.envelope());
    s.setNow(NOW + 300_000);
    expect(await s.service.submit(s.owner, rejectedInput)).toEqual({ ...rejected, replayed: true });
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(2);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 2 });
  });

  it('业务 rejected 的回执写失败也回滚，重试不产生伪完成', async () => {
    const s = await setup(); const input = s.envelope({ expectedRevision: 99 });
    const fault = s.harness.installFault(WRITE_FAULT_POINTS.commandReceiptsBeforeInsert);
    await expect(s.service.submit(s.owner, input)).rejects.toMatchObject({ code: 'internal' });
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
    fault.remove();
    expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'rejected', replayed: false });
  });

  it('过期新命令在写锁之外拒绝；历史成功即使过期仍重放/可查询', async () => {
    const s = await setup(); const input = s.envelope();
    const completed = await s.service.submit(s.owner, input);
    s.setNow(NOW + 60_000);
    const blocker = await s.box.openTransactionalHarness();
    blocker.session.database.exec('BEGIN IMMEDIATE');
    try {
      await expect(s.service.submit(s.owner, s.envelope())).rejects.toMatchObject({ code: 'command_expired' });
    } finally { blocker.session.database.exec('ROLLBACK'); }
    expect(await s.service.submit(s.owner, input)).toEqual({ ...completed, replayed: true });
    const app = await s.box.openApplication();
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(completed);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
  });

  it('获得锁后重新核验时效，不提交在等待期间过期的信封', async () => {
    const s = await setup(); let ticks = 0;
    const service = createCommandService({ atomicStore: s.store, nowUtcMs: () => ++ticks === 1 ? NOW : NOW + 60_000 });
    await expect(service.submit(s.owner, s.envelope())).rejects.toMatchObject({ code: 'command_expired' });
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
  });

  it('预读 miss 后其他连接先提交：事务内重读回执，而非重复 CAS', async () => {
    const s = await setup(); const input = s.envelope();
    const other = await s.box.openApplication({ nowUtcMs: () => NOW });
    let first = true; let winner: Promise<CommandReceipt> | undefined;
    const service = createCommandService({ atomicStore: s.store, nowUtcMs: () => {
      if (first) { first = false; winner = other.commandService.submit(s.owner, input); }
      return NOW;
    } });
    const receipt = await service.submit(s.owner, input);
    expect(receipt).toEqual({ ...await winner, replayed: true });
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
  });

  it('重放重核当前能力/范围；直接服务调用跨项目拒绝不写回执', async () => {
    const s = await setup(); const input = s.envelope();
    const principalId = `test-restricted:${randomUUID()}`;
    const allowed = s.box.restrictedPrincipal({ principalId, capabilities: ['project.metadata.write'], projectScope: s.box.scopeAllowlist([s.project.id]) });
    const completed = await s.service.submit(allowed, input);
    expect(completed.status).toBe('completed');
    const noCapability = s.box.restrictedPrincipal({ principalId, capabilities: [], projectScope: s.box.scopeAllowlist([s.project.id]) });
    await expect(s.service.submit(noCapability, input)).rejects.toMatchObject({ code: 'forbidden' });
    const other = await s.harness.store.createProject({ displayName: 'B' });
    const noScope = s.box.restrictedPrincipal({ principalId, capabilities: ['project.metadata.write'], projectScope: s.box.scopeAllowlist([other.id]) });
    await expect(s.service.submit(noScope, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(s.service.submit(allowed, s.envelope({ scope: { kind: 'project', projectId: other.id } }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.probe.projectRow(other.id)?.revision).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
  });

  it('跨操作复用 ID 仍先核验原回执的注册项目可见性，不泄漏旧结果', async () => {
    const s = await setup(); const input = s.envelope();
    const b = await s.harness.store.createProject({ displayName: 'hidden B' });
    const principal = s.box.restrictedPrincipal({
      capabilities: ['project.metadata.write', 'project.register'],
      projectScope: s.box.scopeAllowlist([s.project.id]),
    });
    // F-006 公开回执写端口种入历史注册回执；不实现 F-008 注册命令。
    const app = await s.box.openApplication();
    await app.commandReceiptStore.saveReceipt(createCompletedReceipt({
      commandId: input.commandId, principalId: principal.principalId,
      operation: 'project.register', scope: { kind: 'registration' }, requestDigest: 'a'.repeat(64),
      issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
      resultRef: createResultRef(randomBytes(32)), result: { project: { id: b.id } },
    }));
    await expect(s.service.submit(principal, input)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'receipt_not_found' } });
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 1 });
  });

  it('不同 principal 的同 ID 独立，不共享成功结果', async () => {
    const s = await setup(); const input = s.envelope();
    const a = await s.service.submit(s.owner, input);
    const restricted = s.box.restrictedPrincipal({ capabilities: ['project.metadata.write'], projectScope: s.box.scopeAllowlist([s.project.id]) });
    const b = await s.service.submit(restricted, input);
    expect(a.status).toBe('completed'); expect(b.status).toBe('rejected');
    expect(b.principalId).toBe(restricted.principalId);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 2 });
  });

  it.each([
    { schemaVersion: 1 }, { actorId: 'attacker' }, { payload: { displayName: '' } },
    { issuedAt: new Date(NOW + 60_001).toISOString() },
    { operation: 'run.start' },
  ])('非法结构/提权/未来时间/未知操作零副作用 %j', async changes => {
    const s = await setup();
    await expect(s.service.submit(s.owner, s.envelope(changes))).rejects.toHaveProperty('code');
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
  });

  it('未知项目与不可见项目同 forbidden，不泄漏存在性/路径', async () => {
    const s = await setup();
    await expect(s.service.submit(s.owner, s.envelope({ scope: { kind: 'project', projectId: randomUUID() } }))).rejects.toMatchObject({
      code: 'forbidden', details: { reason: 'project_not_visible' },
    });
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
  });

  it('busy 超预算明确 resource_busy；不留回执，解锁后可同信封重试', async () => {
    const s = await setup(); const input = s.envelope();
    const blocker = await s.box.openTransactionalHarness();
    blocker.session.database.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      await expect(s.service.submit(s.owner, input)).rejects.toMatchObject({ code: 'resource_busy', details: { reason: 'storage_busy' } });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
    } finally { blocker.session.database.exec('ROLLBACK'); }
    expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed' });
  });

  it('Promise 回调回滚同步业务写入；await 后失效上下文不能继续写库', async () => {
    const s = await setup();
    let late: Promise<void> | undefined;
    expect(() => s.store.transact('commands.submit', transaction => {
      late = (async () => {
        transaction.updateProjectMetadata(s.project.id, { expectedRevision: 1, displayName: 'must rollback' });
        await Promise.resolve();
        transaction.updateProjectMetadata(s.project.id, { expectedRevision: 1, displayName: 'late write' });
      })();
      return late;
    })).toThrow(/同步/);
    await expect(late).rejects.toThrow(/失效/);
    expect(s.probe.projectRow(s.project.id)).toMatchObject({ revision: 1, display_name: 'original' });
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
  });

  it('事务上下文不能逃逸/嵌套，异常回滚元数据与事件', async () => {
    const s = await setup(); let captured: CommandTransaction | undefined;
    expect(() => s.store.transact('commands.submit', transaction => {
      captured = transaction;
      transaction.updateProjectMetadata(s.project.id, { expectedRevision: 1, displayName: 'must rollback' });
      s.store.transact('commands.submit', () => undefined);
    })).toThrow(/嵌套/);
    expect(() => captured!.updateProjectMetadata(s.project.id, { expectedRevision: 1, displayName: 'escaped' })).toThrow(/失效/);
    expect(s.probe.projectRow(s.project.id)).toMatchObject({ revision: 1, display_name: 'original' });
    expect(s.probe.counts()).toMatchObject({ state_events: 0, command_receipts: 0 });
  });

  it('本次未接入的配置命令明确 unsupported，不做任何业务写入', async () => {
    const s = await setup();
    await expect(s.service.submit(s.owner, {
      schemaVersion: 2, commandId: randomUUID(), operation: 'settings.global.create',
      scope: { kind: 'global' }, issuedAt: new Date(NOW).toISOString(),
      payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } },
    })).rejects.toMatchObject({ code: 'unsupported' });
    expect(s.probe.counts()).toMatchObject({ projects: 1, global_settings: 0, state_events: 0, command_receipts: 0 });
  });

  it('关闭重开后相同回执稳定，项目后续编辑不改变原 result', async () => {
    const s = await setup(); const input = s.envelope();
    const completed = await s.service.submit(s.owner, input);
    await s.harness.store.updateProject(s.project.id, { expectedRevision: 2, displayName: 'later' });
    s.harness.close();
    const app = await s.box.openApplication({ nowUtcMs: () => NOW + 300_000 });
    expect(await app.commandService.submit(s.owner, input)).toEqual({ ...completed, replayed: true });
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(completed);
    expect(s.probe.projectRow(s.project.id)).toMatchObject({ revision: 3, display_name: 'later' });
  });

  it.each(['same', 'different', 'cas'] as const)('跨进程真实竞争 %s；核验持久副作用和全部退出', async mode => {
    const s = await setup();
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f007-race-' });
    const input = s.envelope();
    const second = mode === 'same' ? input : mode === 'different'
      ? { ...input, payload: { displayName: 'other' } }
      : { ...input, commandId: randomUUID() };
    const outcomes = await runBarrierChildren(environment, {
      scriptPath: fileURLToPath(new URL('./helpers/p02-2/atomic-command-child.ts', import.meta.url)),
      configs: [input, second].map(envelope => ({ dbPath: s.box.dbPath, envelope, now: NOW })),
      readyTimeoutMs: 10_000, resultTimeoutMs: 10_000,
    });
    const results = outcomes.map(o => o.result);
    if (mode === 'same') {
      const receipts = results.map(r => r.receipt as CommandReceipt);
      expect(receipts.map(original)).toEqual([original(receipts[0]!), original(receipts[0]!)]);
      expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
    } else if (mode === 'different') {
      expect(results.filter(r => r.error)).toHaveLength(1);
      expect(results.find(r => r.error)?.error).toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });
    } else {
      expect(results.map(r => (r.receipt as CommandReceipt).status).sort()).toEqual(['completed', 'rejected']);
    }
    expect(s.probe.projectRow(s.project.id)?.revision).toBe(2);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: mode === 'cas' ? 2 : 1 });
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow();
    }
    expect(environment.evidence.serialize()).toContain('child.exit');
  }, 30_000);
});
