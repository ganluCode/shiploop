/**
 * P07-5 / F-009 验收点 2、3、4：通知故障注入、重复投递与重启恢复的独立性。
 *
 * 全部场景的事件均来自公开入口真实工作流（成功 Task / 人工阻塞），不种事件、
 * 不插通知表身份；断言只用持久行（delivery/结果记录/水位）、真实 Git/SQLite
 * 事实与本地渠道副作用日志。故障注入点为可信投递端口（NotificationChannel
 * 受信注入）；中断用通知运行时 quiesce 屏障构造，重叠消费者用发送屏障证明
 * 真实并发窗口，投递结果未确认用真实 30s 发送超时（默认策略）构造，不用
 * 固定 sleep 假装竞争。
 *
 * - 正常投递后注入渠道失败与发送超时；持久 delivery 记录身份、次数与下次
 *   重试时间；重试四次耗尽停投，原因与结果链经默认 Host/CLI 可查询；
 * - 事件已提交但 delivery 未建的边界重启：按 eventId/channelId 恰好一条
 *   delivery，重复投影扫描幂等；
 * - 投递结果未确认的边界重启：不重复投递、不重新认领（租约/频率策略），
 *   确认停止后经公开存储操作释放并续投；
 * - 重叠消费者屏障竞争：第二消费者零认领，实际投递与本地渠道副作用恰好一次；
 * - 通知全程不重跑模型/Verifier/业务任务（Runtime 启动数、Attempt、Git
 *   提交与预算事实前后一致）；渠道词汇冻结为 local-results，不实现外部
 *   Webhook 或系统桌面通知。
 */
import { describe, expect, it } from 'vitest';
import { connectToHost } from '../../../packages/host/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import {
  NOTIFICATION_CHANNEL_IDS,
  type NotificationChannel,
} from '../../../packages/core/src/ports/notification-delivery.ts';
import {
  openNotificationVerticalFixture,
  waitFor,
  type NotificationVerticalFixture,
} from '../../helpers/p07-4/notification-vertical-fixture.ts';

interface DeliveryRow { id: string; event_id: string; channel_id: string; status: string; attempt_count: number; next_attempt_at: string }
interface ResultRow { delivery_id: string; attempt: number; outcome: string }

function deliveries(f: NotificationVerticalFixture): DeliveryRow[] {
  return JSON.parse(f.notificationFacts().deliveries) as DeliveryRow[];
}
function results(f: NotificationVerticalFixture): ResultRow[] {
  return JSON.parse(f.notificationFacts().results) as ResultRow[];
}
function deliveryOf(f: NotificationVerticalFixture, eventType: string, aggregateId?: string): DeliveryRow | undefined {
  const match = f.eventRows().find(event =>
    event.event_type === eventType && (aggregateId === undefined || event.aggregate_id === aggregateId));
  if (match === undefined) return undefined;
  return deliveries(f).find(row => row.event_id === match.id);
}
function terminalDeliveryOf(f: NotificationVerticalFixture, eventType: string, aggregateId?: string): DeliveryRow {
  const row = deliveryOf(f, eventType, aggregateId);
  if (row === undefined) throw new Error(`期望存在 ${eventType} 的 delivery，实际 ${JSON.stringify(deliveries(f))}`);
  return row;
}

/** 受信注入：三态本地渠道（healthy → fail 立即失败 / hang-once 悬挂一次后恢复健康）。 */
function scriptedChannel(failReason: string): { channel: NotificationChannel; setMode(mode: 'healthy' | 'fail' | 'hang-once'): void } {
  let mode: 'healthy' | 'fail' | 'hang-once' = 'healthy';
  return {
    setMode: next => { mode = next; },
    channel: {
      channelId: 'local-results',
      async send(input) {
        if (mode === 'fail') throw new Error(failReason);
        if (mode === 'hang-once') {
          mode = 'healthy';
          /* 悬挂且忽略中止信号：由真实 30s 发送超时与取消路径收尾。 */
          return new Promise<Readonly<Record<string, unknown>>>(() => {
            input.signal.addEventListener('abort', () => undefined, { once: true });
          });
        }
        if (input.signal.aborted) throw new Error('cancelled');
        return { channelId: 'local-results', deliveryId: input.deliveryId, attempt: input.attempt };
      },
      async cancel() { return true; },
    },
  };
}

/** 受信注入：发送永远悬挂且取消不确认（模拟投递结果未确认的消费者死亡）。 */
function hangForeverUnconfirmedChannel(): NotificationChannel {
  return {
    channelId: 'local-results',
    send: () => new Promise<Readonly<Record<string, unknown>>>(() => undefined),
    async cancel() { return false; },
  };
}

/** 受信注入：屏障渠道——记录真实副作用并挂起发送直到显式释放。 */
function barrierChannel(): { channel: NotificationChannel; sends: string[]; heldCount(): number; releaseAll(): void } {
  const held: Array<() => void> = [];
  const sends: string[] = [];
  return {
    sends,
    heldCount: () => held.length,
    releaseAll: () => { for (const release of held.splice(0)) release(); },
    channel: {
      channelId: 'local-results',
      send(input) {
        sends.push(input.deliveryId);
        return new Promise(resolve => {
          held.push(() => resolve({ channelId: 'local-results', deliveryId: input.deliveryId, attempt: input.attempt }));
        });
      },
      async cancel() { return true; },
    },
  };
}

async function withClient<T>(dataRoot: string, body: (client: HostClient) => Promise<T>): Promise<T> {
  const client = await connectToHost({ canonicalRoot: dataRoot });
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

async function cliText(args: readonly string[], dataRoot: string): Promise<string> {
  let stdout = '';
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    env: {},
    io: { stdout: text => { stdout += text; }, stderr: () => undefined },
  });
  expect(result.exitCode, stdout).toBe(0);
  return stdout;
}

describe('P07-5 / F-009 通知故障、重复投递与重启恢复独立性', () => {
  it('[case:fault-injection-exhaustion-queryable] 正常投递后注入失败与超时：持久重试记录、耗尽停投可查询且业务事实不变', async () => {
    const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p075-f009f-' });
    let host: Awaited<ReturnType<NotificationVerticalFixture['startHost']>> | undefined;
    try {
      /* ---- 阶段一：正常投递（task.terminal 真实送达），随后翻转渠道为失败。 ---- */
      const scripted = scriptedChannel('channel down (F-009 injection)');
      host = await f.startHost({ channels: [scripted.channel] });
      const success = await f.driveSuccess(host);
      await waitFor('正常投递完成', () => deliveryOf(f, 'task.terminal')?.status === 'delivered', 30_000);
      const normal = terminalDeliveryOf(f, 'task.terminal');
      expect(normal.attempt_count).toBe(1);
      expect(results(f)).toEqual([{ delivery_id: normal.id, attempt: 1, outcome: 'succeeded' }]);

      /* ---- 阶段二：失败注入（人工阻塞事件）→ 首次失败进入有界重试。 ---- */
      scripted.setMode('fail');
      const blocked = await f.createBlockedWorkflow(host, { phaseId: 'phase-2', taskId: 't-b' });
      await waitFor('需人处理事件首次投递失败', () => deliveryOf(f, 'task.action_required', blocked.taskId)?.status === 'retry_scheduled', 30_000);
      const retrying = terminalDeliveryOf(f, 'task.action_required', blocked.taskId);
      expect(retrying.attempt_count).toBe(1);
      expect(retrying.next_attempt_at).not.toBeNull();
      expect(results(f).filter(row => row.delivery_id === retrying.id)).toEqual([{ delivery_id: retrying.id, attempt: 1, outcome: 'failed' }]);
      const baseline = f.businessFacts();

      /* ---- 阶段三：有限重试（默认 maxAttempts=4）耗尽停投，不再认领。 ---- */
      for (let attempt = 2; attempt <= 4; attempt++) {
        f.forceDeliveriesDue([retrying.id]);
        await waitFor(`第 ${attempt} 次尝试`, () => terminalDeliveryOf(f, 'task.action_required', blocked.taskId).attempt_count === attempt, 30_000);
      }
      await waitFor('次数耗尽停投', () => terminalDeliveryOf(f, 'task.action_required', blocked.taskId).status === 'exhausted', 30_000);
      const exhausted = terminalDeliveryOf(f, 'task.action_required', blocked.taskId);
      expect(exhausted.attempt_count).toBe(4);
      expect(results(f).filter(row => row.delivery_id === exhausted.id).map(row => row.outcome)).toEqual(['failed', 'failed', 'failed', 'failed']);
      f.forceDeliveriesDue([exhausted.id]);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(terminalDeliveryOf(f, 'task.action_required', blocked.taskId).attempt_count).toBe(4);
      /* 通知故障全程不重跑业务：Runtime 启动数、Attempt、Git 提交与预算不变。 */
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);

      /* ---- 阶段四：发送超时注入（真实 30s 默认策略），退避到期后恢复送达。 ---- */
      scripted.setMode('hang-once');
      const blocked2 = await f.createBlockedWorkflow(host, { phaseId: 'phase-3', taskId: 't-c' });
      await waitFor('发送超时记失败并进入重试', () => deliveryOf(f, 'task.action_required', blocked2.taskId)?.status === 'retry_scheduled', 90_000);
      const timeoutDelivery = terminalDeliveryOf(f, 'task.action_required', blocked2.taskId);
      expect(timeoutDelivery.attempt_count).toBe(1);
      f.forceDeliveriesDue([timeoutDelivery.id]);
      await waitFor('到期续投成功', () => terminalDeliveryOf(f, 'task.action_required', blocked2.taskId).status === 'delivered', 30_000);
      const recovered = terminalDeliveryOf(f, 'task.action_required', blocked2.taskId);
      expect(recovered.attempt_count).toBe(2);
      expect(results(f).filter(row => row.delivery_id === recovered.id)).toEqual([
        { delivery_id: recovered.id, attempt: 1, outcome: 'failed' },
        { delivery_id: recovered.id, attempt: 2, outcome: 'succeeded' },
      ]);
      expect(f.businessFacts()).toMatchObject({ runtimeStarts: 1, headCommit: success.commit });
      expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toMatchObject({ n: 1 });

      /* ---- 耗尽/超时状态与原因经默认 Host/CLI 可查询（结果链可追溯）。 ---- */
      await withClient(f.dataRoot, async client => {
        const exhaustedList = await client.listNotifications(f.projectId, { status: 'exhausted' });
        expect(exhaustedList.records).toHaveLength(1);
        const detail = await client.getNotification(f.projectId, exhausted.id);
        expect(detail.delivery.status).toBe('exhausted');
        expect(detail.delivery.lastOutcome).toBe('failed');
        expect(detail.delivery.lastFailureReason).toBe('channel_failed');
        expect(detail.delivery.nextAttemptAt).toBeNull();
        expect(detail.attempts.map(attempt => attempt.attempt)).toEqual([1, 2, 3, 4]);
        expect(detail.attempts.every(attempt => attempt.outcome === 'failed' && attempt.failureReason === 'channel_failed')).toBe(true);
        const eventRow = f.eventRows().find(event => event.id === detail.delivery.eventId);
        expect(eventRow?.event_type).toBe('task.action_required');
        const timeoutDetail = await client.getNotification(f.projectId, recovered.id);
        expect(timeoutDetail.attempts[0]).toMatchObject({ attempt: 1, outcome: 'failed', failureReason: 'send_timeout' });
        expect(timeoutDetail.attempts[1]).toMatchObject({ attempt: 2, outcome: 'succeeded' });
      });
      const cliExhausted = await cliText(['notifications', 'get', exhausted.id, '--project', f.projectId], f.dataRoot);
      expect(cliExhausted).toContain('exhausted');
      expect(cliExhausted).toContain('attempts=4');
      expect(cliExhausted).toContain('channel_failed');
      const cliTimeout = await cliText(['notifications', 'get', recovered.id, '--project', f.projectId], f.dataRoot);
      expect(cliTimeout).toContain('send_timeout');

      /* ---- 渠道词汇冻结：仅 local-results，不实现外部 Webhook/系统桌面通知。 ---- */
      expect(NOTIFICATION_CHANNEL_IDS).toEqual(['local-results']);
      await expect(host.core.notificationDelivery.runOnce({ owner: 'p075-probe', channelId: 'webhook' })).rejects.toThrow();

      await f.closeHost(host);
      host = undefined;
    } finally {
      await f.cleanup();
    }
  }, 420_000);

  it('[case:restart-dedupe-overlap-barrier] 事件已提交未建 delivery 的边界重启按事件去重；重叠消费者屏障竞争零重复投递', async () => {
    const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p075-f009r-' });
    let host: Awaited<ReturnType<NotificationVerticalFixture['startHost']>> | undefined;
    try {
      /* ---- 阶段一：两个事件（成功 Task + 人工阻塞）提交后、投影前中断。 ---- */
      host = await f.startHost({ quiesceNotifications: true });
      const success = await f.driveSuccess(host);
      const blocked = await f.createBlockedWorkflow(host, { phaseId: 'phase-2', taskId: 't-b' });
      await waitFor('阻塞事件持久化', () =>
        f.eventRows().some(event => event.event_type === 'task.action_required' && event.aggregate_id === blocked.taskId), 30_000);
      await new Promise(resolve => setTimeout(resolve, 1_200));
      expect(deliveries(f)).toHaveLength(0);
      expect(f.notificationFacts().watermark).toBe(0);
      const baseline = f.businessFacts();
      await f.closeHost(host);
      host = undefined;

      /* ---- 阶段二：重启后手动重复投影（重复扫描幂等）：恰好两条 delivery。 ---- */
      const host2 = await f.startHost({ quiesceNotifications: true });
      host = host2;
      const projected = host2.core.notificationProjection.runProjectionRound();
      expect(projected.deliveriesCreated).toBe(2);
      host2.core.notificationProjection.runProjectionRound();
      host2.core.notificationProjection.runProjectionRound();
      expect(deliveries(f)).toHaveLength(2);
      expect(deliveries(f).every(row => row.status === 'pending' && row.channel_id === 'local-results')).toBe(true);
      expect(new Set(deliveries(f).map(row => row.event_id)).size).toBe(2);
      expect(f.businessFacts()).toEqual(baseline);
      await f.closeHost(host2);
      host = undefined;

      /* ---- 阶段三：屏障渠道重启：真实并发窗口内第二消费者零认领。 ---- */
      const barrier = barrierChannel();
      const host3 = await f.startHost({ channels: [barrier.channel] });
      host = host3;
      await waitFor('两条 delivery 均被认领并挂起在发送屏障', () => {
        const rows = deliveries(f);
        return rows.length === 2 && rows.every(row => row.status === 'in_flight') && barrier.heldCount() === 2;
      }, 30_000);
      /* 重叠消费者：发送真实在途（屏障持有）时第二消费者零认领、零副作用。 */
      const overlap = await host3.core.notificationDelivery.runOnce({ owner: 'p075-overlap-probe' });
      expect(overlap.claimedCount).toBe(0);
      expect(overlap.results).toHaveLength(0);
      expect(barrier.sends).toHaveLength(2);
      /* 释放屏障：每条 delivery 恰好一次本地渠道副作用与一条成功结果。 */
      barrier.releaseAll();
      await waitFor('全部送达', () => deliveries(f).every(row => row.status === 'delivered'), 30_000);
      expect(barrier.sends).toHaveLength(2);
      expect(new Set(barrier.sends).size).toBe(2);
      expect(results(f)).toHaveLength(2);
      expect(results(f).every(row => row.outcome === 'succeeded')).toBe(true);
      /* 业务事实与原工作流一致；通知未重跑任何业务执行。 */
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);

      /* ---- 公开查询核对 eventId/channelId 去重与交付事实。 ---- */
      await withClient(f.dataRoot, async client => {
        const list = await client.listNotifications(f.projectId, {});
        expect(list.records).toHaveLength(2);
        expect(new Set(list.records.map(record => record.eventId)).size).toBe(2);
        expect(list.records.every(record => record.channelId === 'local-results' && record.status === 'delivered')).toBe(true);
        for (const record of list.records) {
          expect(record.attemptCount).toBe(1);
          expect(record.receipt).toEqual({ channelId: 'local-results', deliveryId: record.deliveryId, attempt: 1 });
        }
      });
      await f.closeHost(host3);
      host = undefined;
    } finally {
      await f.cleanup();
    }
  }, 420_000);

  it('[case:unconfirmed-result-restart-release] 投递结果未确认的边界重启：不重复投递不重认领，确认停止后释放续投', async () => {
    const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p075-f009u-' });
    let host: Awaited<ReturnType<NotificationVerticalFixture['startHost']>> | undefined;
    try {
      /* ---- 阶段一：发送悬挂且取消不确认（真实 30s 超时）→ delivery 停留 in_flight。 ---- */
      host = await f.startHost({ channels: [hangForeverUnconfirmedChannel()] });
      const success = await f.driveSuccess(host);
      await waitFor('发送超时后保持 in_flight（结果未确认）', () =>
        deliveryOf(f, 'task.terminal')?.status === 'in_flight', 90_000);
      await waitFor('在途轮次按超时收尾', () => {
        const state = host!.core.notificationRuntime.state();
        return !state.roundInFlight && state.roundsExecuted >= 1;
      }, 45_000);
      const stuck = terminalDeliveryOf(f, 'task.terminal');
      expect(stuck.attempt_count).toBe(1);
      expect(results(f)).toHaveLength(0);
      const baseline = f.businessFacts();
      await f.closeHost(host);
      host = undefined;

      /* ---- 阶段二：重启健康渠道：不重复建 delivery、不重新认领（租约/频率策略）。 ---- */
      const host2 = await f.startHost();
      host = host2;
      await new Promise(resolve => setTimeout(resolve, 2_000));
      expect(deliveries(f)).toHaveLength(1);
      expect(terminalDeliveryOf(f, 'task.terminal')).toMatchObject({ status: 'in_flight', attempt_count: 1 });
      expect(results(f)).toHaveLength(0);
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);
      await withClient(f.dataRoot, async client => {
        const inFlight = await client.listNotifications(f.projectId, { status: 'in_flight' });
        expect(inFlight.records).toHaveLength(1);
        expect(inFlight.records[0]!.nextAttemptAt).toBeNull();
      });

      /* ---- 阶段三：确认停止后经公开存储操作释放并到期续投（代次递增）。 ---- */
      const claim = f.q('SELECT claim_owner, claim_generation FROM notification_deliveries WHERE id = ?', stuck.id) as { claim_owner: string; claim_generation: number };
      expect(claim.claim_owner).not.toBeNull();
      expect(() => host2.core.notificationDeliveryStore.releaseDeliveryClaim({
        deliveryId: stuck.id, owner: claim.claim_owner, claimGeneration: claim.claim_generation, confirmedStopped: false,
      })).toThrow();
      const released = host2.core.notificationDeliveryStore.releaseDeliveryClaim({
        deliveryId: stuck.id, owner: claim.claim_owner, claimGeneration: claim.claim_generation, confirmedStopped: true,
      });
      expect(released.status).toBe('retry_scheduled');
      f.forceDeliveriesDue([stuck.id]);
      await waitFor('确认停止后续投成功', () => terminalDeliveryOf(f, 'task.terminal').status === 'delivered', 30_000);
      const recovered = terminalDeliveryOf(f, 'task.terminal');
      expect(recovered.attempt_count).toBe(2);
      expect(results(f)).toEqual([{ delivery_id: recovered.id, attempt: 2, outcome: 'succeeded' }]);
      expect(f.businessFacts()).toEqual(baseline);
      expect(f.headCommit()).toBe(success.commit);

      /* ---- CLI 可查询恢复后的投递事实。 ---- */
      const cli = await cliText(['notifications', 'get', recovered.id, '--project', f.projectId], f.dataRoot);
      expect(cli).toContain('attempts=2');
      expect(cli).toContain('delivered');
      await f.closeHost(host2);
      host = undefined;
    } finally {
      await f.cleanup();
    }
  }, 420_000);
});
