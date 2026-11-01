/**
 * P07-5 / F-009 验收点 1、5：结果查询的只读独立性、口径与脱敏。
 *
 * 以真实临时 Git/SQLite/数据根 + 受控检查进程 + FakeRuntime 的公开纵向夹具
 * （P07-4 F-010）产生三类真实执行结果：
 * - 成功（真实 Git task commit + Task passed）；
 * - 失败（真实检查进程连续失败至代码尝试上限，Task failed / Run paused）；
 * - 需人处理（公开 task.approval.block → task.action_required 事件）。
 *
 * 经默认 HostClient 与公开 CLI 查询结果诊断与本地通知，核对：
 * - 三轴状态、停止/阻塞原因、待处理动作、代码/检查/记录引用与 Token 口径
 *   （未知用量保持 null/unknown，不以 0 冒充）；
 * - 结果证据正文缺失明确 missing（result_evidence_body_missing），不伪造完整；
 * - 分页键集游标覆盖不重不漏，跨筛选游标拒绝；跨项目行不可见、点读折叠；
 * - 查询全程零写入：业务事实、通知事实与事件计数前后一致；重启后查询结果
 *   与持久事实一致（「恢复后查询」按持久行核对，不依赖内存状态）；
 * - 摘要/正文输出通过合成敏感哨兵检查：任务/Feature 标题与阻塞描述中的
 *   哨兵凭据与开发机绝对路径不进入任何查询输出；通知摘要仅含冻结派生键。
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectToHost } from '../../../packages/host/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import {
  openNotificationVerticalFixture,
  waitFor,
  type NotificationVerticalFixture,
} from '../../helpers/p07-4/notification-vertical-fixture.ts';

/** 合成敏感哨兵：凭据形态 + 开发机绝对路径形态（仅用于输出脱敏断言）。 */
const SENTINEL_TOKEN = 'sk-P07SENTINEL-TOKEN-7f3a91';
const SENTINEL_PATH = '/Users/sentinel-ops/dev-machine/absolute/path';

interface DeliveryRow { id: string; event_id: string; status: string; attempt_count: number }

async function cliRun(args: readonly string[], dataRoot: string): Promise<{ text: string; json: Record<string, unknown> | null; exitCode: number }> {
  let stdout = '';
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    env: {},
    io: { stdout: text => { stdout += text; }, stderr: () => undefined },
  });
  let json: Record<string, unknown> | null = null;
  if (args.includes('--json')) {
    const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> };
    expect(envelope.ok, stdout).toBe(true);
    json = envelope.result as Record<string, unknown>;
  }
  return { text: stdout, json, exitCode: result.exitCode };
}

/** 同一 Run 内把后继 Task（t-2）驱动到真实失败：真实检查进程连续失败至代码尝试上限。 */
async function driveFailingTask(f: NotificationVerticalFixture, host: Awaited<ReturnType<NotificationVerticalFixture['startHost']>>): Promise<void> {
  for (;;) {
    const taskRow = f.q("SELECT status FROM tasks WHERE id = 't-2'") as { status: string } | undefined;
    if (taskRow?.status === 'failed') return;
    await f.verifyNextAttempt(host, false);
    await waitFor('失败收尾生效', () => {
      const row = f.q("SELECT status FROM tasks WHERE id = 't-2'") as { status: string } | undefined;
      return row?.status === 'failed' || row?.status === 'pending';
    }, 30_000);
  }
}

describe('P07-5 / F-009 结果查询独立性与脱敏', () => {
  it('[case:result-query-matrix-readonly-sentinel] 成功/失败/需人处理结果经默认 Host/CLI 查询：口径、分页、跨项目、正文缺失与哨兵脱敏，且查询零写入', async () => {
    const f = await openNotificationVerticalFixture({ prefix: 'shiploop-p075-f009q-', secondTaskChain: true });
    try {
      const host1 = await f.startHost();

      /* ---- 三类真实结果：成功（t-1）→ 失败（t-2 依赖链后继）→ 需人处理（阻塞）。 ---- */
      const success = await f.driveSuccess(host1);
      await driveFailingTask(f, host1);
      const blocked = await f.createBlockedWorkflow(host1, {
        phaseId: 'phase-2', taskId: 't-b',
        title: `blocked ${SENTINEL_TOKEN}`, description: `manual block ${SENTINEL_PATH}`,
      });
      await waitFor('task.action_required 事件持久化', () =>
        f.eventRows().some(event => event.event_type === 'task.action_required' && event.aggregate_id === blocked.taskId), 30_000);

      /* ---- 全部订阅事件经默认通知运行时真实送达（零通知表种数）。 ---- */
      const subscribed = f.eventRows().filter(event =>
        ['task.terminal', 'task.action_required', 'execution.run.ended', 'feature.finalized', 'feature.finalization_blocked'].includes(event.event_type));
      expect(subscribed.length).toBeGreaterThanOrEqual(3);
      expect(subscribed.filter(event => event.event_type === 'task.terminal')).toHaveLength(2);
      await waitFor(`全部订阅事件送达（${JSON.stringify(subscribed.map(event => event.event_type))}）`, () => {
        const rows = JSON.parse(f.notificationFacts().deliveries) as DeliveryRow[];
        return rows.length === subscribed.length && rows.every(row => row.status === 'delivered');
      }, 60_000);

      /* ---- 查询前基线（业务/通知/本项目事件计数）。 ---- */
      const projectEventCount = (): number =>
        (f.q('SELECT COUNT(*) AS n FROM state_events WHERE project_id = ?', f.projectId) as { n: number }).n;
      const baseline = { business: f.businessFacts(), notifications: f.notificationFacts(), events: projectEventCount() };

      const client = await connectToHost({ canonicalRoot: f.dataRoot });
      let successEvidenceRef = '';
      let failingAttemptIds: string[] = [];
      try {
        /* ---- 成功结果（t-1）：三轴、代码/检查/记录引用与 Token 口径。 ---- */
        const runPage = await client.listResultDiagnostics(f.projectId, { runId: f.runId });
        expect(runPage.records).toHaveLength(4);
        const successRow = runPage.records.find(record => record.taskId === 't-1')!;
        expect(successRow).toBeDefined();
        expect(successRow.task.verification?.status).toBe('passed');
        expect(successRow.feature.deliveryStatus).toBe('not_requested');
        expect(successRow.gitOperationRefs.length).toBeGreaterThanOrEqual(1);
        expect(successRow.gitOperationRefs.some(op => op.operationType === 'task_commit')).toBe(true);
        expect(successRow.checkRefs.length).toBeGreaterThanOrEqual(1);
        expect(successRow.resultEvidenceRef).not.toBeNull();
        /* FakeRuntime usage=null：未知用量保持 null/unknown，不以 0 冒充。 */
        expect(successRow.usage).toMatchObject({ basis: 'unknown', coverage: 'unknown', inputTokens: null, outputTokens: null, costMicros: null });
        expect(successRow.issues).toContain('usage_partial');
        expect(successRow.pendingActions).not.toContain('rework_task');
        const successEvidenceRefValue = successRow.resultEvidenceRef!;
        successEvidenceRef = successEvidenceRefValue;

        /* ---- 失败结果（t-2 ×3）：Task failed、阻塞原因与待处理动作。 ---- */
        const failingRows = runPage.records.filter(record => record.taskId === 't-2');
        expect(failingRows).toHaveLength(3);
        for (const row of failingRows) {
          expect(row.task.taskStatus).toBe('failed');
          expect(row.blockReasons).toContain('run:code_attempts_exhausted');
          expect(row.pendingActions).toContain('rework_task');
          expect(row.pendingActions).toContain('resume_or_cancel_run');
        }
        failingAttemptIds = runPage.records.map(row => row.attemptId).sort();

        /* ---- Run 分页：limit=1 键集游标走完全部 Attempt（4 条），不重不漏。 ---- */
        const seenAttempts = new Set<string>();
        let cursor: string | null = null;
        for (;;) {
          const page = await client.listResultDiagnostics(f.projectId, { runId: f.runId, limit: 1, ...(cursor === null ? {} : { cursor }) });
          for (const row of page.records) {
            expect(seenAttempts.has(row.attemptId)).toBe(false);
            seenAttempts.add(row.attemptId);
          }
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(seenAttempts.size).toBe(4);

        /* ---- 需人处理结果：无幻影 Attempt；公开信号是 action_required 通知。 ---- */
        const blockedPage = await client.listResultDiagnostics(f.projectId, { runId: blocked.runId });
        expect(blockedPage.records).toHaveLength(0);
        expect(f.q('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blocked.taskId)).toMatchObject({ n: 0 });
        const blockedNotifications = await client.listNotifications(f.projectId, { taskId: blocked.taskId });
        expect(blockedNotifications.records).toHaveLength(1);
        const actionRecord = blockedNotifications.records[0]!;
        expect(actionRecord.eventType).toBe('task.action_required');
        expect(actionRecord.entity).toEqual({ kind: 'task', id: blocked.taskId });
        expect(actionRecord.summary).toMatchObject({ kind: 'task_action_required', action: 'manual_review', reason: 'approval_required' });
        expect(actionRecord.receipt).toEqual({ channelId: 'local-results', deliveryId: actionRecord.deliveryId, attempt: 1 });
        expect(actionRecord.nextAttemptAt).toBeNull();
        expect(actionRecord.status).toBe('delivered');

        /* ---- 通知详情：稳定 deliveryId 执行审计链（attempt 升序、可追溯 eventId）。 ---- */
        const detail = await client.getNotification(f.projectId, actionRecord.deliveryId);
        expect(detail.delivery.deliveryId).toBe(actionRecord.deliveryId);
        expect(detail.attempts).toEqual([expect.objectContaining({ attempt: 1, outcome: 'succeeded' })]);
        const eventRow = f.eventRows().find(event => event.id === detail.delivery.eventId);
        expect(eventRow?.event_type).toBe('task.action_required');

        /* ---- 通知列表分页：limit=1 全覆盖；跨筛选游标拒绝。 ---- */
        const seenDeliveries = new Set<string>();
        const allNotificationRecords: unknown[] = [];
        let listCursor: string | null = null;
        for (;;) {
          const page = await client.listNotifications(f.projectId, { limit: 1, ...(listCursor === null ? {} : { cursor: listCursor }) });
          for (const record of page.records) {
            expect(seenDeliveries.has(record.deliveryId)).toBe(false);
            seenDeliveries.add(record.deliveryId);
            allNotificationRecords.push(record);
          }
          if (page.nextCursor === null) break;
          listCursor = page.nextCursor;
        }
        expect(seenDeliveries.size).toBe(subscribed.length);
        await expect(client.listNotifications(f.projectId, { taskId: blocked.taskId, cursor: listCursor! })).rejects.toThrow();

        /* ---- 跨项目授权：第二项目（公开 project.register，真实 repoB）。 ---- */
        const registered = await f.submitCommand(host1, 'project.register', {
          repositoryPath: f.binding.box.repoDirB, displayName: 'F-009 cross-project', description: null, labels: [],
        }, { scope: { kind: 'registration' } });
        const otherProjectId = ((registered as { result?: { project?: { id?: string } } }).result?.project?.id) ?? '';
        expect(otherProjectId).not.toBe('');
        expect((await client.listNotifications(otherProjectId, {})).records).toHaveLength(0);
        await expect(client.getNotification(otherProjectId, actionRecord.deliveryId)).rejects.toThrow();
        await expect(client.listResultDiagnostics(otherProjectId, { runId: f.runId })).rejects.toThrow();

        /* ---- CLI：结果诊断与通知 list/get（文本 + JSON 口径一致）。 ---- */
        const cliSuccess = await cliRun(['execution', 'result-diagnostics', '--project', f.projectId, '--run', f.runId, '--json'], f.dataRoot);
        expect(cliSuccess.exitCode).toBe(0);
        expect(JSON.stringify(cliSuccess.json)).toContain('"passed"');
        const cliFailingText = await cliRun(['execution', 'result-diagnostics', '--project', f.projectId, '--run', f.runId], f.dataRoot);
        expect(cliFailingText.exitCode).toBe(0);
        expect(cliFailingText.text).toContain('failed');
        const cliNotifications = await cliRun(['notifications', 'list', '--project', f.projectId, '--task', blocked.taskId, '--json'], f.dataRoot);
        expect(cliNotifications.exitCode).toBe(0);
        expect((cliNotifications.json!['records'] as unknown[]).length).toBe(1);
        const cliDetail = await cliRun(['notifications', 'get', actionRecord.deliveryId, '--project', f.projectId], f.dataRoot);
        expect(cliDetail.exitCode).toBe(0);
        expect(cliDetail.text).toContain(`delivery=${actionRecord.deliveryId}`);

        /* ---- 敏感哨兵与开发机路径不进入任何查询输出。 ---- */
        const outputs = [
          JSON.stringify(runPage), JSON.stringify(blockedPage),
          JSON.stringify(blockedNotifications), JSON.stringify(detail),
          cliSuccess.text, cliFailingText.text, cliNotifications.text, cliDetail.text,
        ];
        for (const output of outputs) {
          expect(output).not.toContain(SENTINEL_TOKEN);
          expect(output).not.toContain(SENTINEL_PATH);
          expect(output).not.toContain(f.dataRoot);
        }
        /* 通知摘要（全部公开记录，含分页覆盖）只含冻结派生键，不含标题/描述原文。 */
        expect(allNotificationRecords.length).toBe(subscribed.length);
        expect(JSON.stringify(allNotificationRecords)).not.toContain(SENTINEL_TOKEN);
        expect(JSON.stringify(allNotificationRecords)).not.toContain(SENTINEL_PATH);

        /* ---- 查询零写入：业务/通知事实与事件计数与基线一致。 ---- */
        expect(f.businessFacts()).toEqual(baseline.business);
        expect(f.notificationFacts()).toEqual(baseline.notifications);
        expect(projectEventCount()).toBe(baseline.events);
      } finally {
        await client.close();
      }

      /* ---- 结果证据正文缺失：明确 result_evidence_body_missing，不伪造完整。 ---- */
      const evidencePath = join(f.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId: successEvidenceRef }));
      rmSync(evidencePath);
      const client2 = await connectToHost({ canonicalRoot: f.dataRoot });
      try {
        const afterMissing = await client2.listResultDiagnostics(f.projectId, { runId: f.runId });
        expect(afterMissing.records).toHaveLength(4);
        const missingRow = afterMissing.records.find(record => record.taskId === 't-1')!;
        expect(missingRow.issues).toContain('result_evidence_body_missing');
        /* 查询不修复文件、不改变业务状态。 */
        expect(f.businessFacts()).toEqual(baseline.business);
      } finally {
        await client2.close();
      }

      /* ---- 重启后查询与持久事实一致（恢复后按持久行核对）。 ---- */
      await f.closeHost(host1);
      const host2 = await f.startHost();
      try {
        await waitFor('重启后通知补扫完成', () => {
          const rows = JSON.parse(f.notificationFacts().deliveries) as DeliveryRow[];
          return rows.length === subscribed.length && rows.every(row => row.status === 'delivered');
        }, 30_000);
        const client3 = await connectToHost({ canonicalRoot: f.dataRoot });
        try {
          const afterRestart = await client3.listResultDiagnostics(f.projectId, { runId: f.runId });
          expect(afterRestart.records.map(row => row.attemptId).sort()).toEqual(failingAttemptIds);
          /* 通知重启后不重发、不重复（确认丢失边界由 fault-restart 文件覆盖）。 */
          const facts = f.notificationFacts();
          expect(JSON.parse(facts.results)).toHaveLength(subscribed.length);
        } finally {
          await client3.close();
        }
      } finally {
        await f.closeHost(host2);
      }
    } finally {
      await f.cleanup();
    }
  }, 420_000);
});
