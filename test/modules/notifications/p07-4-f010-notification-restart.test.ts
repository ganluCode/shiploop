/**
 * P07-4 / F-010 验收点 2、3：通知故障注入与真实 Host 重启不重跑业务；
 * 通知管道中断矩阵（投影前 / 发送前 / 确认丢失 / 重试耗尽）。
 *
 * 全部场景的事件均来自公开入口成功工作流（见 vertical-loop 测试），不种
 * 事件、不插通知表；断言只用持久行（delivery/结果记录/水位）与实际
 * Git/SQLite 事实。中断点用通知运行时的 quiesce 屏障构造（确定性），
 * 不用固定 sleep 假装竞争；并发竞争已由 F-007 屏障用例覆盖（selection 引用）。
 */
import { describe, expect, it } from 'vitest';
import {
  failingChannel,
  healthyChannel,
  openNotificationVerticalFixture,
  waitFor,
  type NotificationVerticalFixture,
} from '../../helpers/p07-4/notification-vertical-fixture.ts';

interface DeliveryRow { id: string; event_id: string; channel_id: string; status: string; attempt_count: number }
interface ResultRow { delivery_id: string; attempt: number; outcome: string }

function deliveries(f: NotificationVerticalFixture): DeliveryRow[] {
  return JSON.parse(f.notificationFacts().deliveries) as DeliveryRow[];
}
function results(f: NotificationVerticalFixture): ResultRow[] {
  return JSON.parse(f.notificationFacts().results) as ResultRow[];
}
/** waitFor 条件可用的非抛错访问器：投递未创建时返回 undefined。 */
function currentDelivery(f: NotificationVerticalFixture): DeliveryRow | undefined {
  return deliveries(f)[0];
}
function terminalDelivery(f: NotificationVerticalFixture): DeliveryRow {
  const row = currentDelivery(f);
  if (row === undefined) throw new Error(`期望恰好一条 delivery，实际 ${JSON.stringify(deliveries(f))}`);
  return row;
}

async function withFixture(body: (f: NotificationVerticalFixture) => Promise<void>): Promise<void> {
  const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p074-f010r-' });
  try {
    await body(f);
  } finally {
    await f.cleanup();
  }
}

describe('P07-4 / F-010 通知故障与真实 Host 重启', () => {
  it('[case:restart-continuation-single-delivery] 渠道失败注入下重启只继续通知：同一源事件和渠道恰好一条 delivery 和一条本地结果记录，业务事实全程不变', async () => {
    await withFixture(async f => {
      /* 阶段一：注入本地渠道失败 + 通知轮次停止（事件提交后、投影前中断）。 */
      const host1 = await f.startHost({ channels: [failingChannel()], quiesceNotifications: true });
      const success = await f.driveSuccess(host1);
      await new Promise(resolve => setTimeout(resolve, 1_200));
      expect(deliveries(f)).toHaveLength(0);
      expect(f.notificationFacts().watermark).toBe(0);
      const baseline = f.businessFacts();
      await f.closeHost(host1);
      expect(f.businessFacts()).toEqual(baseline);

      /* 阶段二：重启（健康渠道）但通知轮次仍停止：手动经公开应用服务只投影。 */
      const host2 = await f.startHost({ channels: [healthyChannel()], quiesceNotifications: true });
      const projected = host2.core.notificationProjection.runProjectionRound();
      expect(projected.deliveriesCreated).toBe(1);
      const pending = terminalDelivery(f);
      expect(pending.status).toBe('pending');
      expect(results(f)).toHaveLength(0);
      expect(f.businessFacts()).toEqual(baseline);
      await f.closeHost(host2);

      /* 阶段三：再次重启（健康渠道，默认自动轮次）：只继续通知。 */
      const host3 = await f.startHost();
      await waitFor('投递完成', () => currentDelivery(f)?.status === 'delivered', 30_000);
      const delivered = terminalDelivery(f);
      expect(delivered.attempt_count).toBe(1);
      expect(results(f)).toHaveLength(1);
      expect(results(f)[0]).toMatchObject({ delivery_id: delivered.id, attempt: 1, outcome: 'succeeded' });
      /* 业务事实与原工作流一致：Task/Feature 结果、Run/Attempt、Runtime 启动、预算、Git HEAD。 */
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.q('SELECT COUNT(*) AS n FROM runs')).toMatchObject({ n: 1 });
      expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toMatchObject({ n: 1 });
      expect(f.headCommit()).toBe(success.commit);
      await f.closeHost(host3);
    });
  }, 240_000);

  it('[case:failed-send-retry-recovery] 发送失败持久化有界重试：重启后未到期不重发，到期续投成功且每尝试恰好一条结果记录', async () => {
    await withFixture(async f => {
      /* 阶段一：健康调度 + 失败渠道：业务提交后首次发送失败（result #1 failed）。 */
      const host1 = await f.startHost({ channels: [failingChannel('channel down (F-010 retry)')] });
      const success = await f.driveSuccess(host1);
      await waitFor('首次发送失败进入有界重试', () => currentDelivery(f)?.status === 'retry_scheduled', 30_000);
      const failed = terminalDelivery(f);
      expect(failed.attempt_count).toBe(1);
      expect(results(f)).toEqual([{ delivery_id: failed.id, attempt: 1, outcome: 'failed' }]);
      const baseline = f.businessFacts();
      await f.closeHost(host1);

      /* 阶段二：重启（健康渠道）：退避未到期，不重复发送、不重复记录。 */
      const host2 = await f.startHost({ channels: [healthyChannel()] });
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(terminalDelivery(f)).toMatchObject({ status: 'retry_scheduled', attempt_count: 1 });
      expect(results(f)).toHaveLength(1);
      expect(f.businessFacts()).toEqual(baseline);

      /* 阶段三：退避流逝（F-008 同例受限时间模拟，不改身份/次数/状态）后续投成功。 */
      f.forceDeliveriesDue([failed.id]);
      await waitFor('到期续投成功', () => currentDelivery(f)?.status === 'delivered', 30_000);
      const delivered = terminalDelivery(f);
      expect(delivered.attempt_count).toBe(2);
      expect(results(f)).toEqual([
        { delivery_id: delivered.id, attempt: 1, outcome: 'failed' },
        { delivery_id: delivered.id, attempt: 2, outcome: 'succeeded' },
      ]);
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);
      expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toMatchObject({ n: 1 });
      await f.closeHost(host2);
    });
  }, 240_000);

  it('[case:confirmation-lost-restart-no-duplicate] 本地结果写入后确认丢失：重启不重发、不新增结果记录', async () => {
    await withFixture(async f => {
      /* 阶段一：正常送达（结果已写入、回执已存），观察者直接关闭（确认丢失）。 */
      const host1 = await f.startHost();
      const success = await f.driveSuccess(host1);
      await waitFor('投递完成', () => currentDelivery(f)?.status === 'delivered', 30_000);
      const before = {
        facts: f.businessFacts(),
        deliveries: f.notificationFacts().deliveries,
        results: f.notificationFacts().results,
      };
      await f.closeHost(host1);

      /* 阶段二：重启后无新认领、无新结果记录、attempt_count 与回执不变。
       * （消费水位会随重启补扫正常推进（非订阅事件只推进扫描位置），不属重复投递。） */
      const host2 = await f.startHost();
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const delivered = terminalDelivery(f);
      expect(delivered.status).toBe('delivered');
      expect(delivered.attempt_count).toBe(1);
      expect(results(f)).toHaveLength(1);
      expect(f.notificationFacts().deliveries).toEqual(before.deliveries);
      expect(f.notificationFacts().results).toEqual(before.results);
      expect(f.businessFacts()).toEqual(before.facts);
      expect(f.headCommit()).toBe(success.commit);
      await f.closeHost(host2);
    });
  }, 240_000);

  it('[case:retry-exhaustion-bounded] 重试耗尽停投：四次失败后 exhausted，不再认领，业务事实不变', async () => {
    await withFixture(async f => {
      const host1 = await f.startHost({ channels: [failingChannel('channel down (F-010 exhaustion)')] });
      const success = await f.driveSuccess(host1);
      await waitFor('首次失败', () => currentDelivery(f)?.status === 'retry_scheduled', 30_000);
      const baseline = f.businessFacts();

      /* 有界重试：默认策略 maxAttempts=4；每次失败后受限退避流逝模拟再试。 */
      for (let attempt = 2; attempt <= 4; attempt++) {
        f.forceDeliveriesDue([currentDelivery(f)!.id]);
        await waitFor(`第 ${attempt} 次尝试`, () => currentDelivery(f)?.attempt_count === attempt, 30_000);
      }
      await waitFor('次数耗尽停投', () => currentDelivery(f)?.status === 'exhausted', 30_000);
      const exhausted = terminalDelivery(f);
      expect(exhausted.attempt_count).toBe(4);
      expect(results(f)).toHaveLength(4);
      expect(results(f).map(row => row.outcome)).toEqual(['failed', 'failed', 'failed', 'failed']);

      /* 耗尽后再次到期也不认领（无第五条记录）。 */
      f.forceDeliveriesDue([exhausted.id]);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(terminalDelivery(f).attempt_count).toBe(4);
      expect(results(f)).toHaveLength(4);
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);
      expect(f.q('SELECT COUNT(*) AS n FROM runs')).toMatchObject({ n: 1 });
      expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toMatchObject({ n: 1 });
      await f.closeHost(host1);
    });
  }, 300_000);
});
