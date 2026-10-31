/**
 * P07-4 / F-010 验收点 1：公开入口结果与本地通知纵向闭环。
 *
 * 以真实临时 Git、SQLite、数据根、受控检查进程（check-runner.mjs 真实子进程）
 * 与受信注入的 FakeRuntime，从公开产品入口（公开命令 + 真实进程内 Host 调度）
 * 产生：
 * - 一条成功工作流：调度认领 → FakeRuntime 写入真实 worktree → 生产
 *   NodeTaskVerificationExecutor 启动真实检查进程 → 公开收尾 → 真实 Git task
 *   commit → Task passed；
 * - 一条人工阻塞工作流：公开 task.approval.block → task.action_required 事件。
 *
 * 通过真实 loopback HostClient 与公开 CLI 核对：代码引用、检查引用、Token、
 * 记录缺口、最终交付轴（三轴分离），以及通知 delivery/回执/脱敏摘要。
 * 正常路径不靠测试直接补库制造完成状态或通知。
 */
import { describe, expect, it } from 'vitest';
import { connectToHost } from '../../../packages/host/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import {
  openNotificationVerticalFixture,
  waitFor,
  type NotificationVerticalFixture,
} from '../../helpers/p07-4/notification-vertical-fixture.ts';

const fixtures: NotificationVerticalFixture[] = [];
const clients: HostClient[] = [];

async function cliJson(args: readonly string[], dataRoot: string): Promise<Record<string, unknown>> {
  let stdout = '';
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot, '--json'],
    env: {},
    io: { stdout: text => { stdout += text; }, stderr: () => undefined },
  });
  expect(result.exitCode, stdout).toBe(0);
  const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  return envelope.result as Record<string, unknown>;
}

describe('P07-4 / F-010 公开纵向闭环', () => {
  it('[case:vertical-success-and-manual-block] 成功与人工阻塞工作流的真实事件经 HostClient/CLI 可诊断且通知真实送达', async () => {
    const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p074-f010v-' });
    fixtures.push(f);
    let host: Awaited<ReturnType<NotificationVerticalFixture['startHost']>> | undefined;
    try {
      host = await f.startHost();
      expect(host.lifecycleState).toBe('ready');

      /* ---- 成功工作流（公开入口 + 真实检查进程 + 真实 Git 提交）。 ---- */
      const success = await f.driveSuccess(host);
      expect(success.commit).toMatch(/^[0-9a-f]{40}$/);
      const eventsBeforeBlock = f.eventRows();
      const taskTerminal = eventsBeforeBlock.find(event => event.event_type === 'task.terminal');
      expect(taskTerminal).toBeDefined();

      /* ---- 人工阻塞工作流（公开 task.approval.block → task.action_required）。 ---- */
      const blocked = await f.createBlockedWorkflow(host);
      await waitFor('task.action_required 事件持久化', () =>
        f.eventRows().some(event => event.event_type === 'task.action_required' && event.aggregate_id === blocked.taskId), 30_000);
      /* 阻塞 Task 不被调度认领：无第二个业务 Attempt。 */
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(f.q('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blocked.taskId)).toMatchObject({ n: 0 });

      /* ---- 通知经默认 Host 通知运行时真实送达（无任何通知表种数）。 ---- */
      const events = f.eventRows();
      const subscribed = events.filter(event =>
        ['task.terminal', 'task.action_required', 'execution.run.ended', 'feature.finalized', 'feature.finalization_blocked'].includes(event.event_type));
      expect(subscribed.length).toBeGreaterThanOrEqual(2);
      await waitFor(`全部订阅事件送达（subscribed=${JSON.stringify(subscribed.map(e => e.event_type))} facts=${f.notificationFacts().deliveries.slice(0, 300)}）`, () => {
        const rows = JSON.parse(f.notificationFacts().deliveries) as Array<{ status: string }>;
        return rows.length === subscribed.length && rows.every(row => row.status === 'delivered');
      }, 30_000);
      const facts = f.notificationFacts();
      const results = JSON.parse(facts.results) as Array<{ outcome: string }>;
      expect(results).toHaveLength(subscribed.length);
      expect(results.every(row => row.outcome === 'succeeded')).toBe(true);

      /* ---- 真实 loopback HostClient：结果诊断三轴 + 通知查询一致。 ---- */
      const client = await connectToHost({ canonicalRoot: f.dataRoot });
      clients.push(client);
      const diagnostics = await client.listResultDiagnostics(f.projectId, { runId: f.runId });
      expect(diagnostics.records.length).toBeGreaterThanOrEqual(1);
      const row = diagnostics.records.find(record => record.attemptId === success.attemptId)!;
      expect(row).toBeDefined();
      /* 三轴分离：Runtime 完成 ≠ Task 验收 ≠ Feature 交付。 */
      expect(row.runtime.attemptStatus).toBe('succeeded');
      expect(row.task.verification).toMatchObject({ batchId: success.batchId, status: 'passed' });
      expect(row.feature.deliveryStatus).toBe('not_requested');
      /* 代码轴：真实 Git task commit 回执；检查轴：真实检查进程批次。 */
      expect(row.gitOperationRefs.map(op => op.operationId).length).toBeGreaterThanOrEqual(1);
      expect(diagnostics.usage.countedObservations).toBeGreaterThanOrEqual(0);

      /* 阻塞工作流：无第二个业务 Attempt，不幻影执行。 */
      expect(f.q('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blocked.taskId)).toMatchObject({ n: 0 });

      /* 通知查询：实体筛选与送达状态一致（与持久事实一致）。 */
      const notifications = await client.listNotifications(f.projectId, { taskId: 't-1' });
      expect(notifications.records.length).toBeGreaterThanOrEqual(1);
      expect(notifications.records.every(record => record.status === 'delivered')).toBe(true);
      expect(notifications.records.every(record => record.entity.kind === 'task' && record.entity.id === 't-1')).toBe(true);
      const blockedNotifications = await client.listNotifications(f.projectId, { taskId: blocked.taskId });
      expect(blockedNotifications.records.length).toBeGreaterThanOrEqual(1);
      expect(blockedNotifications.records.every(record => record.status === 'delivered')).toBe(true);
      /* 脱敏：通知正文不含数据根/仓库路径。 */
      const text = JSON.stringify(notifications) + JSON.stringify(blockedNotifications);
      expect(text).not.toContain(f.dataRoot);

      /* ---- 公开 CLI（真实进程内 Host 之上）与 HostClient 同一事实。 ---- */
      const cliDiag = await cliJson(['execution', 'result-diagnostics', '--project', f.projectId, '--run', f.runId], f.dataRoot);
      const cliRecords = (cliDiag['records'] as Array<Record<string, unknown>>);
      expect(cliRecords.find(record => record['attemptId'] === success.attemptId)).toBeDefined();
      const cliNotifications = await cliJson(['notifications', 'list', '--project', f.projectId, '--task', 't-1'], f.dataRoot);
      const cliNotificationRecords = cliNotifications['records'] as Array<Record<string, unknown>>;
      expect(cliNotificationRecords.every(record => record['status'] === 'delivered')).toBe(true);
      expect(cliNotificationRecords.length).toBe(notifications.records.length);

      /* 查询零副作用：通知与业务事实在查询后不变。 */
      const after = { business: f.businessFacts(), notifications: f.notificationFacts() };
      await client.listResultDiagnostics(f.projectId, { runId: f.runId });
      await client.listNotifications(f.projectId, { runId: f.runId });
      expect(f.businessFacts()).toEqual(after.business);
      expect(f.notificationFacts()).toEqual(after.notifications);
    } finally {
      for (const client of clients.splice(0)) { try { await client.close(); } catch { /* 已由用例断言 */ } }
      if (host !== undefined) await f.closeHost(host).catch(() => undefined);
      for (const fixture of fixtures.splice(0)) await fixture.cleanup();
    }
  }, 240_000);
});
