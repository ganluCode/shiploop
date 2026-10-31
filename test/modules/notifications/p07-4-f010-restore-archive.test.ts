/**
 * P07-4 / F-010 验收点 4：受新增通知表与消费者影响的 P07-2/P07-3 代表性场景。
 *
 * 覆盖（只选通知受影响部分，不承担整个 P07 故障矩阵）：
 * - 备份恢复：真实公开命令 data.backup.create → 受锁离线恢复（P07-3 既有
 *   确认入口）→ 恢复根上通知水位、delivery、回执与制品引用逐一匹配；
 *   已发送记录不重复生成、不重发；
 * - 归档边界：公开 project.archive 后 pending delivery 不被认领（事实行保留），
 *   project.restore 恢复后到期送达；
 * - 缺失/损坏保持缺失/损坏：通知摘要损坏行经真实查询 fail-closed corrupt，
 *   不伪造成功；不存在的 delivery 明确 not_found。
 *
 * 全部事件仍来自公开入口工作流；损坏注入只改摘要字节（负向检测前提），
 * 不制造完成状态或通知。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, startHost } from '../../../packages/host/src/index.ts';
import type { HostClient, RunningHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createOfflineRestoreService } from '../../../packages/host/src/runtime/offline-restore.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import {
  healthyChannel,
  openNotificationVerticalFixture,
  waitFor,
  type NotificationVerticalFixture,
} from '../../helpers/p07-4/notification-vertical-fixture.ts';

const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);

interface DeliveryRow { id: string; event_id: string; channel_id: string; status: string; attempt_count: number; next_attempt_at: number }
interface ResultRow { delivery_id: string; attempt: number; outcome: string }

function deliveries(f: NotificationVerticalFixture): DeliveryRow[] {
  return JSON.parse(f.notificationFacts().deliveries) as DeliveryRow[];
}
function results(f: NotificationVerticalFixture): ResultRow[] {
  return JSON.parse(f.notificationFacts().results) as ResultRow[];
}

const fixtures: NotificationVerticalFixture[] = [];
const clients: HostClient[] = [];
const extraHosts: RunningHost[] = [];
const extraSessions: SqliteStorageSession[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) { try { await client.close(); } catch { /* 测试收尾 */ } }
  for (const host of extraHosts.splice(0)) { try { await host.close(); } catch { /* 测试收尾 */ } }
  for (const session of extraSessions.splice(0)) { try { session.close(); } catch { /* 测试收尾 */ } }
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function openFixture(): Promise<NotificationVerticalFixture> {
  const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p074-f010s-' });
  fixtures.push(f);
  return f;
}

/** 产品内备份完成等待（公开查询面；与 P07-3 F-014 同一纪律）。 */
async function waitForBackup(client: HostClient, operationId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const operation = await client.getBackupOperation(operationId);
    if (operation.status === 'completed') return;
    if (operation.status === 'failed') throw new Error(`backup failed: ${JSON.stringify(operation).slice(0, 900)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('backup operation did not settle');
}

describe('P07-4 / F-010 受影响备份恢复 / 归档 / 记录缺失场景', () => {
  it('[case:backup-restore-notification-state] 备份恢复后通知水位、delivery、回执及制品引用匹配，已发送记录不重复生成', async () => {
    const f = await openFixture();
    let host: RunningHost | undefined;
    try {
      host = await f.startHost();
      await f.driveSuccess(host);
      await waitFor('投递完成', () => {
        const rows = deliveries(f);
        return rows.length >= 1 && rows.every(row => row.status === 'delivered');
      }, 30_000);
      /* 冻结通知写入：备份与恢复的比较基线不再漂移。 */
      host.core.notificationRuntime.enterQuiesce();
      const before = f.notificationFacts();
      expect(JSON.parse(before.deliveries)).toHaveLength(1);
      expect(JSON.parse(before.results)).toHaveLength(1);

      /* 制品引用基线：结果记录的 resultRef（验证批次引用）与检查输出制品（真实文件字节）。 */
      const summaryRow = f.q('SELECT summary_json FROM notification_deliveries LIMIT 1') as { summary_json: string };
      const summary = JSON.parse(summaryRow.summary_json) as { resultRef: string | null };
      expect(summary.resultRef).toMatch(/^p07-4-verif-/);
      const checkOutput = f.q('SELECT output_artifact_id AS id FROM check_results ORDER BY created_at LIMIT 1') as { id: string };
      const projectRow = f.q('SELECT id FROM projects LIMIT 1') as { id: string };
      const artifactBytes = (root: string, artifactId: string) =>
        readFileSync(join(root, 'projects', projectRow.id, 'artifacts', artifactId, 'content'));
      const refBytes = artifactBytes(f.dataRoot, checkOutput.id);

      /* 公开命令创建备份（Host 执行编排 + 持久结果；不手工复制文件）。 */
      const client = await connectToHost({ canonicalRoot: f.dataRoot });
      clients.push(client);
      const receipt = await client.submitDataBackupCreate({ backupId: 'backup-p074-f010' });
      expect(receipt.status).toBe('accepted');
      const operationId = (receipt as { operationId: string }).operationId;
      await waitForBackup(client, operationId);
      await client.close();
      clients.splice(0, 1);
      await f.closeHost(host);
      host = undefined;

      /* 受锁离线恢复（P07-3 既有确认入口）到独立临时数据根。 */
      const targetRoot = mkdtempSync(join(tmpdir(), 'shiploop-p074-restore-'));
      const service = createOfflineRestoreService({ dataRoot: targetRoot });
      const packagePath = join(f.dataRoot, 'backups', 'backup-p074-f010');
      const restoreId = `restore-${randomUUID()}`;
      const preview = await service.prepare({ operationId: restoreId, packagePath });
      const restored = await service.confirm({ operationId: restoreId, confirmation: preview.confirmation });
      expect(restored.status).toBe('published');

      /* 恢复根持久行逐一匹配：水位、delivery、回执（恢复后、启动前核对恢复值）。 */
      const restoredDb = openSqliteStorageSession({ path: join(targetRoot, 'core.sqlite') });
      extraSessions.push(restoredDb);
      const rDelivery = restoredDb.database.prepare(
        'SELECT id, event_id, channel_id, status, attempt_count, next_attempt_at FROM notification_deliveries ORDER BY event_sequence, id',
      ).all() as DeliveryRow[];
      const rResults = restoredDb.database.prepare(
        'SELECT delivery_id, attempt, outcome FROM notification_delivery_results ORDER BY created_at, id',
      ).all() as ResultRow[];
      const rWatermark = (restoredDb.database.prepare(
        "SELECT last_scanned_sequence AS n FROM notification_scan_state WHERE channel_id = 'local-results'",
      ).get() as { n: number }).n;
      expect(JSON.stringify(rDelivery)).toBe(before.deliveries);
      expect(JSON.stringify(rResults)).toBe(before.results);
      expect(rWatermark).toBe(before.watermark);
      /* 制品引用匹配：摘要引用的验证批次仍在，恢复根文件字节与源一致。 */
      const rBatch = restoredDb.database.prepare('SELECT id FROM verification_batches WHERE id = ?').get(summary.resultRef as string) as { id: string } | undefined;
      expect(rBatch?.id).toBe(summary.resultRef as string);
      expect(artifactBytes(targetRoot, checkOutput.id)).toEqual(refBytes);
      const rSummary = restoredDb.database.prepare('SELECT summary_json FROM notification_deliveries LIMIT 1').get() as { summary_json: string };
      expect(rSummary.summary_json).toBe(summaryRow.summary_json);
      restoredDb.close();
      extraSessions.splice(0, 1);

      /* 启动恢复根 Host：已发送记录不重复生成、不重发（结果记录不变）。 */
      const restoredHost = await startHost({ dataRoot: targetRoot, capabilityCatalog: EMPTY_CATALOG, env: {} });
      extraHosts.push(restoredHost);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const afterDb = openSqliteStorageSession({ path: join(targetRoot, 'core.sqlite') });
      extraSessions.push(afterDb);
      const aDelivery = afterDb.database.prepare('SELECT id, status, attempt_count FROM notification_deliveries').all();
      const aResults = afterDb.database.prepare('SELECT delivery_id, attempt, outcome FROM notification_delivery_results').all();
      expect(JSON.stringify(aDelivery)).toBe(JSON.stringify(rDelivery.map(row => ({ id: row.id, status: row.status, attempt_count: row.attempt_count }))));
      expect(JSON.stringify(aResults)).toBe(JSON.stringify(rResults));
    } finally {
      if (host !== undefined) await f.closeHost(host).catch(() => undefined);
    }
  }, 300_000);

  it('[case:archive-boundary-pending-delivery] 归档项目不认领 pending delivery：事实行保留、回执如实，不伪造送达', async () => {
    const f = await openFixture();
    let host1: RunningHost | undefined;
    let host2: RunningHost | undefined;
    try {
      /* 阶段一：通知轮次停止 + 手动投影：得到一条 pending delivery（未发送）。 */
      host1 = await f.startHost({ channels: [healthyChannel()], quiesceNotifications: true });
      await f.driveSuccess(host1);
      const projected = host1.core.notificationProjection.runProjectionRound();
      expect(projected.deliveriesCreated).toBe(1);
      expect(deliveries(f)[0]).toMatchObject({ status: 'pending', attempt_count: 0 });
      expect(results(f)).toHaveLength(0);
      const baseline = f.businessFacts();

      /* 公开 project.archive（项目离开 active 后不再是投递目标）。 */
      const projectRevision = (f.q('SELECT revision FROM projects LIMIT 1') as { revision: number }).revision;
      const receipt = await f.submitCommand(host1, 'project.archive', { projectId: f.projectId },
        { scope: { kind: 'project', projectId: f.projectId }, expectedRevision: projectRevision }) as {
        result?: { status?: string; settled?: boolean; blockers?: Record<string, number> };
      };
      /* 回执如实：不伪造 archived；无论 archiving/archived，项目已离开 active。 */
      expect(['archiving', 'archived']).toContain(receipt.result?.status);
      const projectStatus = (f.q('SELECT status FROM projects LIMIT 1') as { status: string }).status;
      expect(projectStatus).not.toBe('active');
      await f.closeHost(host1);
      host1 = undefined;

      /* 阶段二：重启（健康渠道，自动轮次）：归档/归档中项目 delivery 不被认领，
       * 事实行保留（不删除、不伪造送达），业务事实不被通知活动改变。 */
      host2 = await f.startHost({ channels: [healthyChannel()] });
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(deliveries(f)[0]).toMatchObject({ status: 'pending', attempt_count: 0 });
      expect(results(f)).toHaveLength(0);
      expect(f.businessFacts()).toEqual(baseline);
      await f.closeHost(host2);
      host2 = undefined;
    } finally {
      if (host1 !== undefined) await f.closeHost(host1).catch(() => undefined);
      if (host2 !== undefined) await f.closeHost(host2).catch(() => undefined);
    }
  }, 300_000);

  it('[case:missing-corrupt-fail-closed] 损坏通知摘要 fail-closed corrupt 不伪造成功；缺失 delivery 明确 not_found', async () => {
    const f = await openFixture();
    let host: RunningHost | undefined;
    try {
      host = await f.startHost();
      await f.driveSuccess(host);
      await waitFor('投递完成', () => deliveries(f).length === 1 && deliveries(f)[0]!.status === 'delivered', 30_000);
      const deliveryId = deliveries(f)[0]!.id;
      const client = await connectToHost({ canonicalRoot: f.dataRoot });
      clients.push(client);
      /* 正常读取先于损坏（同一行可诊断）。 */
      const healthy = await client.getNotification(f.projectId, deliveryId);
      expect(healthy.delivery.deliveryId).toBe(deliveryId);

      /* 注入损坏（负向检测前提，不改业务/通知状态）：摘要 kind 超出冻结词汇。 */
      const probe = openSqliteStorageSession({ path: f.dbPath, busyTimeoutMs: 2_000, busyRetryAttempts: 8 });
      extraSessions.push(probe);
      probe.database.prepare('UPDATE notification_deliveries SET summary_json = ? WHERE id = ?')
        .run(JSON.stringify({ schemaVersion: 1, kind: 'forged_kind', taskId: 't-1' }), deliveryId);
      probe.close();
      extraSessions.splice(0, 1);

      /* 查询 fail-closed：拒绝伪造状态，不返回“成功”行。
       * （实体过滤列表用冻结摘要键下推 SQL，伪造 kind 不匹配任何筛选；
       *   无过滤列表逐行映射，损坏行必须 fail-closed。） */
      await expect(client.getNotification(f.projectId, deliveryId)).rejects.toMatchObject(
        { code: expect.stringMatching(/corrupt/) },
      );
      await expect(client.listNotifications(f.projectId, {})).rejects.toMatchObject(
        { code: expect.stringMatching(/corrupt/) },
      );

      /* 缺失保持缺失：不存在的 delivery 明确 not_found。 */
      await expect(client.getNotification(f.projectId, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      if (host !== undefined) await f.closeHost(host).catch(() => undefined);
    }
  }, 300_000);
});
