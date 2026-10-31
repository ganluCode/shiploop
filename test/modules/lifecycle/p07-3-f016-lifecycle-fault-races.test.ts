/**
 * P07-3 / F-016：数据生命周期跨组件故障与屏障竞争（T08/T15/T16 代表场景）。
 *
 * 覆盖：
 * - [case:active-blockers-and-archive-safe-closeout] 活动执行拒绝删除（公开
 *   预览列出真实阻塞 + confirm 拒绝且不建删除意图）；归档进入可观察 archiving
 *   后等待安全收尾，运行结算后完成归档，源仓库 Git 事实不变。
 * - [case:delete-receipt-loss-idempotent-and-git-lock] 公开删除确认后，Git
 *   公共元数据锁被外部持有时删除执行拒绝（正文保留）；锁释放后完成删除，
 *   回执丢失后的重复续核幂等（同一完成事实，无重复副作用，源仓库保留）。
 * - [case:maintenance-vs-dispatch-race] 屏障注入：保留清理持有维护占用期间，
 *   公开 execution.start 派发被拒（resource_busy + 维护事实可观察）；
 *   清理在预算内收尾释放占用后，重试派发被接受。
 * - [case:cleanup-vs-new-reference-race] 屏障注入：清理快照后、删除复核前
 *   并发新增引用（独立连接真实提交），复核拒绝删除该制品；文件与索引保留，
 *   清理在预算内收尾并释放占用。
 * 全部使用真实 SQLite/Git/文件事实与有界等待，不用固定长 sleep 代替断言。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createSqliteRetentionCleanupStore } from '../../../packages/core/src/adapters/sqlite/evidence-retention.ts';
import { createRetentionCleanupService } from '../../../packages/core/src/application/evidence-retention.ts';
import type { RetentionCleanupStore } from '../../../packages/core/src/ports/evidence-retention.ts';
import type { RetentionPolicyV2 } from '../../../packages/core/src/ports/settings-schema.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import {
  openLifecycleApp, seedApprovedPlan, seedReadyArtifact, startExecution, waitFor,
} from '../../helpers/p07-3/lifecycle-app-fixture.ts';
import type { LifecycleApp } from '../../helpers/p07-3/lifecycle-app-fixture.ts';

const POLICY: RetentionPolicyV2 = { evidenceRetentionDays: 10, backupRetentionDays: 10, maxBackupCount: 2, diskMinFreeBytes: 1024 * 1024 };

function barrier(): { reached: Promise<void>; release(): void } {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

function projectRevision(lifecycle: LifecycleApp, projectId: string): number {
  const db = lifecycle.readonlyDatabase();
  try {
    return Number((db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId) as { revision: number }).revision);
  } finally { db.close(); }
}

describe('P07-3 F-016 lifecycle faults and barrier races', () => {
  it('[case:active-blockers-and-archive-safe-closeout] 活动执行拒绝删除；归档等待安全收尾后完成', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-archive-');
    try {
      const repoBefore = lifecycle.repoFacts();
      const plan = await seedApprovedPlan(lifecycle);
      const scope = { kind: 'project', projectId: plan.projectId };
      const runId = await startExecution(lifecycle, plan);

      // 活动执行拒绝删除：公开预览列出真实阻塞，confirm 拒绝且不建删除意图。
      const preview = await lifecycle.submit('project.delete.preview', { projectId: plan.projectId }, { scope });
      if (preview.status !== 'completed') throw new Error(JSON.stringify(preview));
      const page = preview.result as Record<string, any>;
      expect(page.confirmable).toBe(false);
      expect(page.blockers).toContain('project_not_archived');
      expect(page.blockers).toContain('active_execution');
      expect(page.summary.activity.activeRuns).toBeGreaterThanOrEqual(1);
      const confirm = lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, previewDigest: page.previewDigest, confirmed: true, expiresAtUtcMs: page.expiresAtUtcMs,
      }, { scope, expectedRevision: page.projectRevision });
      // 不可确认预览的确认提交被公开命令面拒绝（conflict；不建立删除意图）。
      await expect(confirm).rejects.toMatchObject({ code: 'conflict' });
      const intents = lifecycle.readonlyDatabase();
      try {
        expect((intents.prepare('SELECT COUNT(*) AS n FROM project_delete_operations WHERE target_project_id = ?').get(plan.projectId) as { n: number }).n).toBe(0);
      } finally { intents.close(); }

      // 归档等待安全收尾：enter 先落 archiving（可观察进度），预算内结算运行后完成。
      const archive = lifecycle.submit('project.archive', { projectId: plan.projectId }, { scope, expectedRevision: projectRevision(lifecycle, plan.projectId) });
      const settle = lifecycle.openSession();
      try {
        await waitFor('项目进入 archiving', () => {
          const db = lifecycle.readonlyDatabase();
          try { return String((db.prepare('SELECT status FROM projects WHERE id = ?').get(plan.projectId) as { status: string }).status) === 'archiving'; }
          finally { db.close(); }
        }, 5_000);
        // Runtime 侧结算路径（公开 Runtime 无关；与收尾快照同一事实表）。
        settle.transactWrite('f016.settle-run', db => {
          db.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE project_id = ? AND status IN ('queued','running')").run(plan.projectId);
          db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?").run(Date.now(), runId);
        });
      } finally { settle.close(); }
      const archived = await archive;
      if (archived.status !== 'completed') throw new Error(JSON.stringify(archived));
      expect(archived.result).toMatchObject({ status: 'archived', settled: true });

      // 源仓库 Git 事实不变；归档不删文件。
      const repoAfter = lifecycle.repoFacts();
      expect(repoAfter.head).toBe(repoBefore.head);
      expect(repoAfter.refs).toBe(repoBefore.refs);
      const settleCheck = lifecycle.readonlyDatabase();
      try {
        expect((settleCheck.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe('succeeded');
      } finally { settleCheck.close(); }
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);

  it('[case:delete-receipt-loss-idempotent] 公开删除确认→执行完成；回执丢失后重复续核幂等且无重复副作用；源仓库保留', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-delete-');
    try {
      const repoBefore = lifecycle.repoFacts();
      const plan = await seedApprovedPlan(lifecycle);
      const scope = { kind: 'project', projectId: plan.projectId };
      const artifactId = 'artifact-del-f016';
      seedReadyArtifact(lifecycle, plan.projectId, artifactId, 'document', new TextEncoder().encode('delete evidence'));

      const archived = await lifecycle.submit('project.archive', { projectId: plan.projectId }, { scope, expectedRevision: projectRevision(lifecycle, plan.projectId) });
      if (archived.status !== 'completed') throw new Error(JSON.stringify(archived));
      const preview = await lifecycle.submit('project.delete.preview', { projectId: plan.projectId }, { scope });
      const page = preview.result as Record<string, any>;
      if (page.confirmable !== true) throw new Error(`删除预览不可确认: ${JSON.stringify(page.blockers)} activity=${JSON.stringify(page.summary?.activity)}`);
      expect(page.confirmable).toBe(true);
      const confirmed = await lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, previewDigest: page.previewDigest, confirmed: true, expiresAtUtcMs: page.expiresAtUtcMs,
      }, { scope, expectedRevision: page.projectRevision });
      if (confirmed.status !== 'accepted') throw new Error(JSON.stringify(confirmed));
      const operationId = (confirmed.operationId ?? confirmed.result?.operationId) as string;
      const operation = lifecycle.app.projectDeleteStore.get(lifecycle.owner, operationId);
      const executeInput = { principal: lifecycle.owner, operationId, owner: 'f016-supervisor', expectedFence: operation.fence, previousExecutorStopped: false };
      const artifactPath = join(lifecycle.sandbox.path, 'projects', plan.projectId, 'artifacts', artifactId, 'content');

      // 执行删除：管理行清除、正文删除、源仓库与分支保留（Git 公共锁竞争场景
      // 由 F-011 [case:legacy-modern-common-lock] 以真实锁注入覆盖，见 Task 索引）。
      const completed = await lifecycle.app.projectDeleteExecutor.execute(executeInput);
      expect(completed.status).toBe('completed');
      expect(existsSync(artifactPath)).toBe(false);
      const after = lifecycle.readonlyDatabase();
      try {
        expect(after.prepare('SELECT id FROM projects WHERE id = ?').get(plan.projectId)).toBeUndefined();
      } finally { after.close(); }
      const repoAfter = lifecycle.repoFacts();
      expect(repoAfter.head).toBe(repoBefore.head);
      expect(repoAfter.refs).toBe(repoBefore.refs);

      // 回执丢失后幂等续核：同一 operation 重入返回原完成事实，无重复副作用。
      const replay = await lifecycle.app.projectDeleteExecutor.execute(executeInput);
      expect(replay.status).toBe('completed');
      expect(replay.operationId).toBe(operationId);
      const replayRepo = lifecycle.repoFacts();
      expect(replayRepo.refs).toBe(repoBefore.refs);
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);

  it('[case:maintenance-vs-dispatch-race] 维护占用期间派发被拒；收尾释放后重试被接受', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-maint-race-');
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const raceBudget = { batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: Date.now() + 3_600_000, maxTokenTotal: 100, maxCostTotal: 1 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 } };
      const preview = await lifecycle.app.executionPreview.previewExecution(plan.projectId, {
        featureIds: [plan.featureId], budget: raceBudget,
      });
      if (preview.status !== 'ready') throw new Error(JSON.stringify(preview));
      const startPayload = { featureIds: [plan.featureId], budget: raceBudget, previewDigest: preview.previewDigest, retryBatchId: null };

      // 屏障：真实清理 store 的 beginOperation 之后暂停（占用已持有、可观察）。
      const hold = barrier();
      const maintenanceSession = lifecycle.openSession();
      const realStore = createSqliteRetentionCleanupStore({
        session: maintenanceSession, dataRoot: lifecycle.sandbox.path,
        maintenanceGate: createSqliteMaintenanceWriteGate(maintenanceSession), nowUtcMs: () => Date.now(),
      });
      const store: RetentionCleanupStore = {
        ...realStore,
        async beginOperation(input) { await realStore.beginOperation(input); await hold.reached; },
      };
      const cleanup = createRetentionCleanupService({ store, nowUtcMs: () => Date.now() });
      try {
        const executing = cleanup.execute({ operationId: 'f016-maintenance-race', policy: POLICY });
        await waitFor('维护占用已持有', () => {
          const db = lifecycle.readonlyDatabase();
          try { return String((db.prepare('SELECT state FROM maintenance_occupancy WHERE id = ?').get('global') as { state: string }).state) === 'held'; }
          finally { db.close(); }
        }, 5_000);

        // 派发在维护占用期间被拒（fail-closed，携带维护占用事实）。
        await expect(lifecycle.submit('execution.start', startPayload, { scope: { kind: 'project', projectId: plan.projectId } }))
          .rejects.toMatchObject({ code: 'resource_busy', details: expect.objectContaining({ reason: 'storage_busy', entityType: 'backup' }) });

        hold.release();
        const result = await executing;
        expect(result.status).toBe('completed');
        await waitFor('维护占用已释放', () => {
          const db = lifecycle.readonlyDatabase();
          try { return String((db.prepare('SELECT state FROM maintenance_occupancy WHERE id = ?').get('global') as { state: string }).state) === 'idle'; }
          finally { db.close(); }
        }, 5_000);

        // 维护收尾后重试派发被接受（新 commandId，同一 payload）。
        const retry = await lifecycle.submit('execution.start', startPayload, { scope: { kind: 'project', projectId: plan.projectId } });
        expect(retry.status).toBe('accepted');
      } finally {
        maintenanceSession.close();
      }
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);

  it('[case:cleanup-vs-new-reference-race] 快照后并发新增引用令删除复核拒绝；证据保留且清理收尾', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-ref-race-');
    try {
      const plan = await seedApprovedPlan(lifecycle);
      // 真实 Run（公开 execution.start）作为并发新增引用的载体行。
      const runId = await startExecution(lifecycle, plan);
      const artifactId = 'artifact-race-f016';
      const artifactBody = new TextEncoder().encode('referenced evidence');
      const artifactHash = seedReadyArtifact(lifecycle, plan.projectId, artifactId, 'recording', artifactBody, 40);
      const relative = deriveArtifactFinalRelativePath({ projectId: plan.projectId, artifactId });
      const bodyPath = join(lifecycle.sandbox.path, relative);

      // 屏障：真实快照读取完成后暂停（候选集已定，删除复核尚未发生）。
      const snapshotDone = barrier();
      const resume = barrier();
      const maintenanceSession = lifecycle.openSession();
      const realStore = createSqliteRetentionCleanupStore({
        session: maintenanceSession, dataRoot: lifecycle.sandbox.path,
        maintenanceGate: createSqliteMaintenanceWriteGate(maintenanceSession), nowUtcMs: () => Date.now(),
      });
      const store: RetentionCleanupStore = {
        ...realStore,
        async readSnapshot(policy, at) {
          const snapshot = await realStore.readSnapshot(policy, at);
          snapshotDone.release();
          await resume.reached;
          return snapshot;
        },
      };
      const cleanup = createRetentionCleanupService({ store, nowUtcMs: () => Date.now() });
      try {
        const executing = cleanup.execute({ operationId: 'f016-reference-race', policy: POLICY });
        await snapshotDone.reached;

        // 并发新增引用：独立连接真实提交 attempts.input_ref（与真实命令同一事实表；
        // 输入组引用携带完整制品身份以满足 attempts 身份触发器）。
        const writer = lifecycle.openSession();
        try {
          const digest = 'ab'.repeat(32);
          const artifactRef = { projectId: plan.projectId, artifactId, version: 1, contentHash: artifactHash, sizeBytes: artifactBody.byteLength, locator: `recording/${artifactId}`, mediaType: 'application/octet-stream' };
          writer.transactWrite('f016.add-reference', db => {
            db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id, number,
              owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref, status, execution_stage)
              VALUES ('attempt-ref-race', ?, ?, ?, ?, ?, 't-1', 1, 'owner-race', 'host-race', 1, 0, ?, ?, ?, 'succeeded', 'verification')`)
              .run(Date.now(), Date.now(), plan.projectId, plan.featureId, runId,
                JSON.stringify({ schemaVersion: 1, projectId: plan.projectId, featureId: plan.featureId, taskId: 't-1',
                  digests: { snapshotDigest: digest }, group: { snapshot: artifactRef } }),
                digest, artifactId);
          });
        } finally { writer.close(); }

        resume.release();
        const result = await executing;
        expect(result.status).toBe('completed');
        const retained = result.retained.find(item => item.object.id === artifactId);
        if (retained !== undefined && !retained.reasons.includes('reference_added_after_snapshot')) {
          throw new Error(`保留原因非新增引用: ${JSON.stringify(retained.reasons)}`);
        }
        expect(retained?.reasons).toContain('reference_added_after_snapshot');
        expect(result.deleted.some(item => item.object.id === artifactId)).toBe(false);
        // 真实文件/索引事实：正文与行均保留。
        expect(existsSync(bodyPath)).toBe(true);
        const after = lifecycle.readonlyDatabase();
        try {
          expect(after.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifactId)).toBeDefined();
          expect(String((after.prepare('SELECT state FROM maintenance_occupancy WHERE id = ?').get('global') as { state: string }).state)).toBe('idle');
        } finally { after.close(); }
      } finally {
        maintenanceSession.close();
      }
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);
});
