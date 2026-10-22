/**
 * P04-9 / F-003 单执行槽位事务原语（真实临时 SQLite）。
 *
 * 验收面（.dag_context.json F-003）：
 * 1. 两个独立消费者/连接争抢额度 1：仅一个取得有效槽位，失败方得到明确占用/等待
 *    原因且不产生 Attempt、预算扣减或 Runner 启动；同身份重复获取幂等，不出现
 *    一 Run 多槽或一槽多 owner。
 * 2. 槽位绑定项目/Feature/Run/owner/Host/认领版本；续租、释放必须匹配当前身份，
 *    旧 owner/version 或伪造释放不能抢占/释放；租约到期只隔离、不自动回收。
 * 3. 容量缺省 1；受信装配显式大于 1 与 0/负数/非整数 fail-closed；生产并发配置
 *    大于 1 由既有授权政策明确拒绝。
 * 4. 槽位只限制运行数量：不改写 `global:execution`/项目 Work/工作区三组租约、
 *    基线占用、Git operation，也不把槽位伪装成 Attempt 工作区租约。
 * 5. 只提供短事务原语：事务外拒写，准入顺序固定（身份→认领→容量→插入），
 *    失败路径整组回滚。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import {
  assertSingleWorkConcurrencyAuthorization,
  resolveEffectiveMaxConcurrentWorks,
} from '../../../packages/core/src/application/execution-authorization-policy.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import type { ExecutionSlotClaimRecord } from '../../../packages/core/src/ports/execution-dispatch.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import {
  SLOT_NOW,
  acquireInput,
  openPeerSession,
  openSlotFixture,
  slotIdentity,
  type SlotFixture,
} from '../../helpers/p04-9/slot-fixture.ts';

function rejection(run: () => unknown): { kind: string; reason: unknown } {
  try {
    run();
  } catch (error) {
    if (!isStorageError(error)) throw error;
    return { kind: error.kind, reason: error.details?.reason };
  }
  throw new Error('expected a structured rejection');
}

function acquire(f: SlotFixture, which: 'A' | 'B', leaseUntilUtcMs?: number): ExecutionSlotClaimRecord {
  return f.box.session.transactWrite('test.slot-acquire', () =>
    f.access.acquireInTransaction(acquireInput(f, which, leaseUntilUtcMs)));
}

describe('P04-9 F-003 single execution slot primitives', () => {
  it('[case:capacity-single-winner] 两个独立连接争抢额度 1：仅一个取得槽位，失败方零副作用', async () => {
    const f = await openSlotFixture();
    const peer = openPeerSession(f);
    try {
      const before = f.counts();
      const peerAccess = createSqliteExecutionSlotAccess(peer, { nowUtcMs: () => f.now() });
      const winner = acquire(f, 'A');
      expect(winner.state).toBe('held');
      expect(winner.slotIndex).toBe(0);
      expect(winner.projectId).toBe(f.projectId);
      expect(winner.runId).toBe(f.runA.runId);
      expect(winner.claimId).toBe(f.claimA);
      expect(winner.ownerId).toBe('owner-a');

      const loser = rejection(() => peer.transactWrite('test.peer-slot', () =>
        peerAccess.acquireInTransaction(acquireInput(f, 'B'))));
      expect(loser).toEqual({ kind: 'conflict', reason: 'execution_slot_unavailable' });
      // 失败方整组回滚：没有第二槽位、没有 Attempt/预算/Runner 启动记录，
      // 也没有在工作区/基线/Git 表中留下任何“占位”。
      expect(f.counts()).toEqual({ ...before, execution_slot_claims: 1 });
      expect(f.slotRows()).toHaveLength(1);
      expect(f.access.readActive({ projectId: f.projectId, runId: f.runB.runId })).toBeNull();
      expect(f.box.session.database.prepare('SELECT * FROM workspace_leases').all()).toEqual([]);

      // 释放后容量回到可用：另一 Run 在同一槽号取得新槽位（不是复用旧 owner）。
      const released = f.box.session.transactWrite('test.slot-release', () =>
        f.access.releaseInTransaction(slotIdentity(f, winner)));
      expect(released.state).toBe('released');
      const next = peer.transactWrite('test.peer-slot-retry', () =>
        peerAccess.acquireInTransaction(acquireInput(f, 'B')));
      expect(next.id).not.toBe(winner.id);
      expect(next.slotIndex).toBe(0);
      expect(next.runId).toBe(f.runB.runId);
      expect(peerAccess.readActive({ projectId: f.projectId, runId: f.runA.runId })).toBeNull();
    } finally {
      peer.close();
      f.close();
    }
  }, 60_000);

  it('[case:capacity-cross-process] 两个受控消费者跨进程竞争：恰好一个有效槽位，迟到方回滚', async () => {
    const f = await openSlotFixture();
    const environment = createIsolatedHostEnvironment();
    try {
      const before = f.counts();
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p04-9/execution-slot-race-child.ts', import.meta.url)),
        configs: [
          { dbPath: f.box.box.dbPath, now: SLOT_NOW, acquire: acquireInput(f, 'A') },
          { dbPath: f.box.box.dbPath, now: SLOT_NOW, acquire: acquireInput(f, 'B') },
        ],
      });
      const winners = results.filter((result) => result.result.ok === true);
      const losers = results.filter((result) => result.result.ok === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.result).toMatchObject({
        errorKind: 'conflict',
        reason: 'execution_slot_unavailable',
      });
      const slots = f.slotRows();
      expect(slots).toHaveLength(1);
      expect(f.counts()).toEqual({ ...before, execution_slot_claims: 1 });
      const winningRun = results[0]!.result.ok ? f.runA : f.runB;
      expect(f.access.readActive({ projectId: f.projectId, runId: winningRun.runId })?.id)
        .toBe(String(winners[0]!.result.slotId));
    } finally {
      await environment.dispose();
      f.close();
    }
  }, 90_000);

  it('[case:idempotent-acquire] 同身份重复获取复用同一行；一 Run 一槽、一槽一 owner', async () => {
    const f = await openSlotFixture();
    try {
      const first = acquire(f, 'A');
      const again = acquire(f, 'A');
      expect(again).toEqual(first);
      expect(f.slotRows()).toHaveLength(1);
      // 一槽一 owner：另一 Run 不能同时取得同一槽号。
      expect(rejection(() => acquire(f, 'B')))
        .toEqual({ kind: 'conflict', reason: 'execution_slot_unavailable' });
      // 一 Run 一活动槽位：用另一 Run 的认领身份冒充在认领层被拒绝。
      expect(rejection(() => f.box.session.transactWrite('test.slot-forged', () =>
        f.access.acquireInTransaction({
          ...acquireInput(f, 'A'),
          claimId: f.claimB,
          featureId: f.runB.featureId,
          runId: f.runB.runId,
        }))))
        .toEqual({ kind: 'ownership', reason: 'slot_claim_identity_mismatch' });
      // 认领代次不一致同样被拒绝（Run 级代次不是 Attempt executionVersion）。
      expect(rejection(() => f.box.session.transactWrite('test.slot-version', () =>
        f.access.acquireInTransaction({ ...acquireInput(f, 'A'), claimVersion: 2 }))))
        .toEqual({ kind: 'ownership', reason: 'slot_claim_identity_mismatch' });
      // 槽位租约不得长于认领租约。
      expect(rejection(() => acquire(f, 'A', SLOT_NOW + 120_000)))
        .toEqual({ kind: 'conflict', reason: 'slot_lease_exceeds_claim' });
      // 机械点击式绕过（自选槽号/伪造 Attempt 版本）在入口被校验拒绝。
      expect(rejection(() => f.box.session.transactWrite('test.slot-extra', () =>
        f.access.acquireInTransaction({ ...acquireInput(f, 'A'), slotIndex: 1 }))))
        .toMatchObject({ kind: 'validation' });
      expect(rejection(() => f.box.session.transactWrite('test.slot-extra-2', () =>
        f.access.acquireInTransaction({ ...acquireInput(f, 'A'), executionVersion: 9 }))))
        .toMatchObject({ kind: 'validation' });
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:identity-fencing] 旧 owner/version 与伪造释放不能续租或释放当前槽位', async () => {
    const f = await openSlotFixture();
    try {
      const slot = acquire(f, 'A');
      const identity = slotIdentity(f, slot);
      const before = f.slotRows();

      for (const bad of [
        { ownerId: 'stale-owner' },
        { hostInstanceId: 'stale-host' },
        { claimVersion: 2 },
        { claimId: 'claim-other' },
      ]) {
        const forged = { ...identity, ...bad };
        const renew = rejection(() => f.box.session.transactWrite('test.slot-renew-forged', () =>
          f.access.renewInTransaction(forged, SLOT_NOW + 20_000)));
        expect(['ownership', 'not_found']).toContain(renew.kind);
        const released = rejection(() => f.box.session.transactWrite('test.slot-release-forged', () =>
          f.access.releaseInTransaction(forged)));
        expect(['ownership', 'not_found']).toContain(released.kind);
      }
      expect(rejection(() => f.box.session.transactWrite('test.slot-missing', () =>
        f.access.releaseInTransaction({ ...identity, slotId: '11111111-1111-4111-8111-111111111111' }))))
        .toMatchObject({ kind: 'not_found' });
      // 失败路径没有任何部分写入：行内容与 revision 保持不变。
      expect(f.slotRows()).toEqual(before);

      const renewed = f.box.session.transactWrite('test.slot-renew', () =>
        f.access.renewInTransaction(identity, SLOT_NOW + 20_000));
      expect(renewed.revision).toBe(slot.revision + 1);
      expect(renewed.leaseUntilUtcMs).toBe(SLOT_NOW + 20_000);
      // 续租不得缩短。
      expect(rejection(() => f.box.session.transactWrite('test.slot-shorten', () =>
        f.access.renewInTransaction(identity, SLOT_NOW + 5_000))))
        .toMatchObject({ kind: 'validation' });

      const released = f.box.session.transactWrite('test.slot-release', () =>
        f.access.releaseInTransaction(identity));
      expect(released.state).toBe('released');
      expect(released.releasedAtUtcMs).toBe(SLOT_NOW);
      // 已释放是终态：重复释放幂等，续租/隔离拒绝。
      expect(f.box.session.transactWrite('test.slot-release-again', () =>
        f.access.releaseInTransaction(identity))).toEqual(released);
      expect(rejection(() => f.box.session.transactWrite('test.slot-renew-released', () =>
        f.access.renewInTransaction(identity, SLOT_NOW + 30_000))))
        .toEqual({ kind: 'conflict', reason: 'slot_released' });
      expect(rejection(() => f.box.session.transactWrite('test.slot-quarantine-released', () =>
        f.access.quarantineInTransaction(identity, 'late_uncertain'))))
        .toEqual({ kind: 'conflict', reason: 'slot_released' });
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:lease-expiry-quarantine] 租约到期只转隔离：不续租、不释放、不自动回收量额', async () => {
    const f = await openSlotFixture();
    try {
      const slot = acquire(f, 'A', SLOT_NOW + 1_000);
      const identity = slotIdentity(f, slot);
      f.tick(2_000);
      // 到期后的获取/续租/释放全部 fail-closed，且不会静默改写当前行。
      expect(rejection(() => acquire(f, 'A', f.now() + 1_000)))
        .toEqual({ kind: 'conflict', reason: 'slot_lease_expired_unverified' });
      expect(rejection(() => f.box.session.transactWrite('test.slot-release-expired', () =>
        f.access.releaseInTransaction(identity))))
        .toEqual({ kind: 'conflict', reason: 'slot_lease_expired_unverified' });
      expect(f.slotRows()[0]!.state).toBe('held');
      expect(f.slotRows()[0]!.lease_until).toBe(SLOT_NOW + 1_000);

      // 有界清理只把到期行转成待核对隔离，保留租约与占用的槽号。
      expect(f.box.session.transactWrite('test.slot-expire', () => f.access.expireInTransaction())).toBe(1);
      expect(f.box.session.transactWrite('test.slot-expire-again', () => f.access.expireInTransaction())).toBe(0);
      const quarantined = f.access.readActive({ projectId: f.projectId, runId: f.runA.runId })!;
      expect(quarantined.state).toBe('quarantined');
      expect(quarantined.reason).toBe('lease_expired_unverified');
      expect(quarantined.leaseUntilUtcMs).toBe(SLOT_NOW + 1_000);
      // 隔离继续占用量额：另一 Run 不能因此取得槽位。
      expect(rejection(() => acquire(f, 'B', f.now() + 1_000)))
        .toEqual({ kind: 'conflict', reason: 'execution_slot_unavailable' });
      expect(rejection(() => f.box.session.transactWrite('test.slot-quarantine-renew', () =>
        f.access.renewInTransaction(identity, f.now() + 1_000))))
        .toEqual({ kind: 'conflict', reason: 'slot_quarantined' });
      expect(rejection(() => f.box.session.transactWrite('test.slot-quarantine-release', () =>
        f.access.releaseInTransaction(identity))))
        .toEqual({ kind: 'conflict', reason: 'slot_quarantined' });
      // 显式隔离幂等：保留首次原因与 revision。
      expect(f.box.session.transactWrite('test.slot-quarantine-again', () =>
        f.access.quarantineInTransaction(identity, 'second_reason'))).toEqual(quarantined);

      // 重开数据库后仍是隔离，不自动恢复成 held 或已释放。
      f.reopen();
      expect(f.access.readActive({ projectId: f.projectId, runId: f.runA.runId })?.state).toBe('quarantined');
      expect(rejection(() => acquire(f, 'A', f.now() + 1_000)))
        .toEqual({ kind: 'conflict', reason: 'slot_quarantined' });
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:capacity-fail-closed] 容量缺省 1；>1/0/负数/非整数与生产并发配置均 fail-closed', async () => {
    const f = await openSlotFixture();
    try {
      expect(f.access.capacity).toBe(1);
      expect(createSqliteExecutionSlotAccess(f.box.session).capacity).toBe(1);
      const unsupported = rejection(() => createSqliteExecutionSlotAccess(f.box.session, { capacity: 2 }));
      expect(unsupported).toEqual({ kind: 'validation', reason: 'capacity_unsupported' });
      for (const invalid of [0, -1, 1.5, Number.NaN, '1', null, true]) {
        expect(rejection(() => createSqliteExecutionSlotAccess(f.box.session, { capacity: invalid })))
          .toMatchObject({ kind: 'validation' });
      }
      // 生产配置面：保存的并发政策 >1 仍被既有执行授权明确拒绝（不暗中串行）。
      expect(resolveEffectiveMaxConcurrentWorks({}).maxConcurrentWorks).toBe(1);
      expect(() => assertSingleWorkConcurrencyAuthorization({})).not.toThrow();
      for (const policies of [
        { executionLimits: { source: { kind: 'project_default' }, value: { maxConcurrentWorks: 2 } } },
        { executionLimits: { source: { kind: 'global_default' }, value: { maxConcurrentWorks: 3 } } },
      ]) {
        const rejected = rejection(() => assertSingleWorkConcurrencyAuthorization(policies));
        expect(rejected).toEqual({ kind: 'validation', reason: 'concurrency_not_supported' });
      }
    } finally {
      f.close();
    }
  }, 60_000);

  it('[case:resource-role-separation] 槽位原语只动槽位表：三组租约/基线/Git/预算/Run 事实不变', async () => {
    const f = await openSlotFixture();
    try {
      const tables = ['workspace_leases', 'baseline_occupancy', 'git_operations', 'runs', 'attempts',
        'task_attempt_reservations', 'runtime_start_reservations', 'run_dispatch_intents', 'state_events'];
      const snapshot = () => Object.fromEntries(tables.map((table) =>
        [table, f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const claimsBefore = f.claimRows();
      const beforeCounts = f.counts();
      const before = snapshot();
      const slot = acquire(f, 'A', SLOT_NOW + 10_000);
      const identity = slotIdentity(f, slot);
      f.box.session.transactWrite('test.slot-renew-role', () => f.access.renewInTransaction(identity, SLOT_NOW + 20_000));
      expect(snapshot()).toEqual(before);
      expect(f.claimRows()).toEqual(claimsBefore);
      // 槽位不是 Attempt 工作区租约：租约表始终为空，槽位也不产生 Attempt。
      expect(f.counts().workspace_leases).toBe(0);
      expect(f.counts().attempts).toBe(beforeCounts['attempts']);
      f.box.session.transactWrite('test.slot-release-role', () => f.access.releaseInTransaction(identity));
      expect(snapshot()).toEqual(before);
      // 释放槽位不会替 Run 级认领/资源组“假装停止”：认领仍 held、租约仍为空。
      expect(f.claimRows().every((row) => row.state === 'held')).toBe(true);
      expect(f.counts().workspace_leases).toBe(0);
    } finally {
      f.close();
    }
  }, 60_000);

  it('requires an open write transaction for mutations; reads stay side-effect free', async () => {
    const f = await openSlotFixture();
    try {
      expect(() => f.access.acquireInTransaction(acquireInput(f, 'A'))).toThrow(TypeError);
      expect(() => f.access.readActive({ projectId: f.projectId, runId: f.runA.runId })).not.toThrow();
      expect(f.counts().execution_slot_claims).toBe(0);
      const slot = acquire(f, 'A');
      const before = f.slotRows();
      expect(f.access.readActive({ projectId: f.projectId, runId: f.runA.runId })).toEqual(slot);
      expect(f.access.read({ projectId: f.projectId, slotId: slot.id })).toEqual(slot);
      expect(f.slotRows()).toEqual(before);
    } finally {
      f.close();
    }
  }, 60_000);
});
