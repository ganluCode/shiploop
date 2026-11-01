/**
 * P07-5 / F-008：项目数据边界阶段场景（归档/恢复、删除确认、中断续核、保留清理）。
 *
 * 通过默认管理入口（openCoreApplication 公开命令面 + 受信装配端口）在真实
 * 临时 SQLite/Git/文件项目上验证 P07-3 已交付的数据生命周期契约：
 *
 * - [case:archive-restore-boundary] 含 Git 仓库、真实 Work 记录（Run/Batch）与
 *   备份引用的临时项目软归档再恢复：源仓库 HEAD/refs/status、制品正文、
 *   Work 行与备份包逐项保留；公开列表/详情准确反映状态；归档项目阻止新执行。
 * - [case:delete-guards-receipts] 删除预览/显式确认/operation 回执：活动执行与
 *   未确认停止阻止删除；过期预览、摘要漂移、修订变化与跨项目确认拒绝且零
 *   删除意图；重复相同命令返回同一删除事实；未知来源路径不能进入执行器。
 * - [case:delete-interrupt-restart] 受控删除步骤中断（真实 EACCES）后重启 Core：
 *   未确认旧执行者停止前明确等待（previous_executor_stop_unconfirmed），确认后
 *   经同一 operation 续核完成；保留最小删除回执；源仓库、幸存项目与未获准
 *   目录哨兵、Git 事实保持不变。
 * - [case:retention-policy-disk-threshold] 按前序保留政策与磁盘阈值触发受控清理：
 *   被引用/窗口内/缺正文证据不得无声丢失（缺正文按 file_identity_unknown 保留，
 *   不折算为空记录清理成功）；磁盘阈值评估显式呈现观测与触发结论；唯一最新
 *   备份保留。全部使用真实 SQLite/Git/文件事实，不操作开发仓库或真实用户数据。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { RetentionPolicyV2 } from '../../../packages/core/src/ports/settings-schema.ts';
import {
  LIFECYCLE_CATALOG,
  openLifecycleApp,
  readJsonIfExists,
  seedApprovedPlan,
  seedReadyArtifact,
  sha256Hex,
  startExecution,
  waitFor,
  type LifecycleApp,
} from '../../helpers/p07-3/lifecycle-app-fixture.ts';
import { commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';
import type { TempSandbox } from '../../helpers/temp-sandbox.ts';

/** 环境显式提供证据目录时导出分组结构化事实；默认不向仓库工作树写入。 */
function saveGroupEvidence(group: string, payload: Record<string, unknown>): string | null {
  const root = process.env.SHIPLOOP_P07_EVIDENCE_DIR;
  if (root === undefined || root === '') return null;
  mkdirSync(root, { recursive: true });
  const path = join(root, `f008-${group}.json`);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, kind: 'p07-5-f008-scenario', group, ...payload }, null, 2)}\n`, 'utf8');
  return path;
}

function projectRevision(lifecycle: LifecycleApp, projectId: string): number {
  const db = lifecycle.readonlyDatabase();
  try {
    return Number((db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId) as { revision: number }).revision);
  } finally { db.close(); }
}

function projectStatus(app: CoreApplication, projectId: string): Promise<string> {
  return app.stateStore.getProject(projectId).then(project => project.status);
}

function repoStatusEntries(repoDir: string): readonly string[] {
  return git(['status', '--porcelain'], repoDir).trim().split('\n').filter(entry => entry.length > 0);
}

/** 结算 Run/Batch（Runtime 侧结算路径：与收尾快照同一事实表）。 */
function settleRun(lifecycle: LifecycleApp, projectId: string, runId: string): void {
  const session = lifecycle.openSession();
  try {
    session.transactWrite('f008.settle-run', db => {
      db.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE project_id = ? AND status IN ('queued','running')").run(projectId);
      db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?").run(Date.now(), runId);
    });
  } finally { session.close(); }
}

async function waitForBackupSettled(dataRoot: string, operationId: string): Promise<void> {
  await waitFor(`backup ${operationId} settle`, () => {
    const journal = readJsonIfExists(join(dataRoot, 'backups', 'operations', `${operationId}.json`));
    return journal !== null && String(journal.status) !== 'running';
  }, 30_000);
}

async function createBackup(lifecycle: LifecycleApp, backupId: string): Promise<void> {
  // 公开备份命令面（与 Host 传输同源）：提交回执后由备份执行编排驱动实际导出，
  // 完成事实持久化到备份包目录与操作日志。
  const receipt = await lifecycle.app.dataBackupExecution.submit(lifecycle.owner, {
    schemaVersion: 5,
    commandId: randomUUID(),
    operation: 'data.backup.create',
    issuedAt: new Date().toISOString(),
    scope: { kind: 'global' },
    payload: { backupId, target: 'default' },
  } as never) as Record<string, any>;
  if (receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
  const operationId = (receipt.operationId ?? receipt.result?.operationId) as string;
  if (typeof operationId !== 'string') throw new Error(`备份命令缺少 operationId: ${JSON.stringify(receipt)}`);
  await waitForBackupSettled(lifecycle.sandbox.path, operationId);
  const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${operationId}.json`));
  if (journal === null || journal.status !== 'completed') {
    throw new Error(`备份未完成: ${JSON.stringify(journal)}`);
  }
}

async function previewDelete(lifecycle: LifecycleApp, projectId: string): Promise<Record<string, any>> {
  const preview = await lifecycle.submit('project.delete.preview', { projectId }, { scope: { kind: 'project', projectId } });
  if (preview.status !== 'completed') throw new Error(JSON.stringify(preview));
  return preview.result as Record<string, any>;
}

describe('P07-5 F-008 project data boundary', () => {
  it('[case:archive-restore-boundary] 软归档再恢复保留 Git/Work/制品/备份事实；列表详情准确；归档阻止新执行', async () => {
    const lifecycle = await openLifecycleApp('shiploop-p07-5-f008-archive-');
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const runId = await startExecution(lifecycle, plan);
      const artifactId = 'f008-archive-evidence';
      const artifactBody = new TextEncoder().encode('f008 archived project evidence');
      seedReadyArtifact(lifecycle, plan.projectId, artifactId, 'document', artifactBody);
      settleRun(lifecycle, plan.projectId, runId);

      // 真实备份引用：公开备份命令产出受管 backups/<id> 包（含数据库与制品正文）。
      await createBackup(lifecycle, 'f008-backup-archive');
      const backupDir = join(lifecycle.sandbox.path, 'backups', 'f008-backup-archive');
      const backupManifestBefore = readFileSync(join(backupDir, 'manifest.json'), 'utf8');

      // 归档前事实快照（SQLite/文件/Git 分组采集）。
      const headBefore = git(['rev-parse', 'HEAD'], lifecycle.repoDir).trim();
      const refsBefore = git(['show-ref'], lifecycle.repoDir).trim();
      const statusBefore = repoStatusEntries(lifecycle.repoDir);
      const artifactPath = join(lifecycle.sandbox.path, 'projects', plan.projectId, 'artifacts', artifactId, 'content');
      const workRowsBefore = (() => {
        const db = lifecycle.readonlyDatabase();
        try {
          return {
            runs: db.prepare('SELECT id, status, ended_at FROM runs WHERE project_id = ? ORDER BY id').all(plan.projectId),
            batches: db.prepare('SELECT id, status FROM execution_batches WHERE project_id = ? ORDER BY id').all(plan.projectId),
            artifact: db.prepare('SELECT id, kind, status, content_hash, size_bytes FROM artifacts WHERE id = ?').get(artifactId),
          };
        } finally { db.close(); }
      })();

      // 归档前捕获执行预览摘要（用于归档后派发拒绝断言）。
      const budget = {
        batch: { maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2, deadlineUtcMs: Date.now() + 3_600_000, maxTokenTotal: 1000, maxCostTotal: 10 },
        run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
      };
      const ready = await lifecycle.app.executionPreview.previewExecution(plan.projectId, { featureIds: [plan.featureId], budget });
      if (ready.status !== 'ready') throw new Error(`preview not ready: ${JSON.stringify(ready)}`);

      // 公开软归档：收尾干净时同一命令内完成。
      const archived = await lifecycle.submit('project.archive', { projectId: plan.projectId }, {
        scope: { kind: 'project', projectId: plan.projectId }, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      expect(archived).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });

      // 文件/引用/仓库事实逐项保留（归档只写项目行，不删任何数据）。
      expect(git(['rev-parse', 'HEAD'], lifecycle.repoDir).trim()).toBe(headBefore);
      expect(git(['show-ref'], lifecycle.repoDir).trim()).toBe(refsBefore);
      expect(repoStatusEntries(lifecycle.repoDir)).toEqual(statusBefore);
      expect(readFileSync(artifactPath)).toEqual(Buffer.from(artifactBody));
      expect(existsSync(join(backupDir, 'manifest.json'))).toBe(true);
      expect(readFileSync(join(backupDir, 'manifest.json'), 'utf8')).toBe(backupManifestBefore);
      const workRowsAfterArchive = (() => {
        const db = lifecycle.readonlyDatabase();
        try {
          return {
            runs: db.prepare('SELECT id, status, ended_at FROM runs WHERE project_id = ? ORDER BY id').all(plan.projectId),
            batches: db.prepare('SELECT id, status FROM execution_batches WHERE project_id = ? ORDER BY id').all(plan.projectId),
            artifact: db.prepare('SELECT id, kind, status, content_hash, size_bytes FROM artifacts WHERE id = ?').get(artifactId),
          };
        } finally { db.close(); }
      })();
      expect(workRowsAfterArchive).toEqual(workRowsBefore);

      // 公开列表与详情准确反映状态：默认隐藏 archived，显式筛选/详情可查。
      expect((await lifecycle.app.stateStore.listProjects()).records.map(record => record.id)).not.toContain(plan.projectId);
      expect((await lifecycle.app.stateStore.listProjects({ status: 'archived' })).records.map(record => record.id)).toEqual([plan.projectId]);
      expect(await projectStatus(lifecycle.app, plan.projectId)).toBe('archived');

      // 归档项目执行限制（P07-3 契约）：同摘要派发被拒，不产生新执行写入。
      const rejectedStart = await lifecycle.submit('execution.start', {
        featureIds: [plan.featureId], budget, previewDigest: ready.previewDigest, retryBatchId: null,
      }, { scope: { kind: 'project', projectId: plan.projectId } });
      expect(rejectedStart).toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
      const runCount = (() => {
        const db = lifecycle.readonlyDatabase();
        try { return Number((db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get(plan.projectId) as { n: number }).n); } finally { db.close(); }
      })();
      expect(runCount).toBe(workRowsBefore.runs.length);

      // 显式恢复：archived→active；不启动 Run、不重复执行写入；仓库与制品仍保留。
      const restored = await lifecycle.submit('project.restore', { projectId: plan.projectId }, {
        scope: { kind: 'project', projectId: plan.projectId }, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      expect(restored).toMatchObject({ status: 'completed', result: { status: 'active' } });
      expect((await lifecycle.app.stateStore.listProjects()).records.map(record => record.id)).toContain(plan.projectId);
      expect(git(['rev-parse', 'HEAD'], lifecycle.repoDir).trim()).toBe(headBefore);
      expect(readFileSync(artifactPath)).toEqual(Buffer.from(artifactBody));
      const runsAfterRestore = (() => {
        const db = lifecycle.readonlyDatabase();
        try { return Number((db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get(plan.projectId) as { n: number }).n); } finally { db.close(); }
      })();
      expect(runsAfterRestore).toBe(workRowsBefore.runs.length);

      saveGroupEvidence('archive-restore', {
        projectId: plan.projectId,
        git: { head: headBefore, refs: refsBefore, statusEntries: statusBefore },
        workRows: workRowsBefore,
        artifact: { artifactId, contentHash: sha256Hex(artifactBody), sizeBytes: artifactBody.byteLength },
        backup: { backupId: 'f008-backup-archive', manifestKept: true },
        listedStatus: ['hidden-default', 'visible-archived-filter', 'visible-after-restore'],
      });
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 120_000);

  it('[case:delete-guards-receipts] 活动/未确认停止阻止删除；过期、漂移、修订与跨项目确认拒绝；重复命令同一事实', async () => {
    const lifecycle = await openLifecycleApp('shiploop-p07-5-f008-guards-');
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const scope = { kind: 'project' as const, projectId: plan.projectId };
      const runId = await startExecution(lifecycle, plan);

      // 活动执行：预览列出真实阻塞，确认被拒且不建立删除意图。
      const activePage = await previewDelete(lifecycle, plan.projectId);
      expect(activePage.confirmable).toBe(false);
      expect(activePage.blockers).toEqual(expect.arrayContaining(['project_not_archived', 'active_execution']));
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: activePage.previewDigest, expiresAtUtcMs: activePage.expiresAtUtcMs,
      }, { scope, expectedRevision: activePage.projectRevision })).rejects.toMatchObject({ code: 'conflict' });
      expect(countDeleteOperations(lifecycle, plan.projectId)).toBe(0);

      // 未确认停止：结算 Run 后注入未确认停止事实（与收尾快照同一权威表）。
      settleRun(lifecycle, plan.projectId, runId);
      const batchId = (() => {
        const db = lifecycle.readonlyDatabase();
        try { return String((db.prepare('SELECT batch_id FROM runs WHERE id = ?').get(runId) as { batch_id: string }).batch_id); } finally { db.close(); }
      })();
      const now = Date.now();
      const session = lifecycle.openSession();
      try {
        session.transactWrite('f008.seed-stop', db => {
          db.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, revision, updated_at, command_id,
            target_kind, target_id, batch_id, run_id, reason, status, requested_at, stop_confirmed)
            VALUES ('stop-f008-guard', ?, ?, 1, ?, 'cmd-stop-f008-guard', 'run', ?, ?, ?, 'user_cancel', 'stopping', ?, 0)`)
            .run(now, plan.projectId, now, runId, batchId, runId, now);
        });
      } finally { session.close(); }
      const blockedArchive = await lifecycle.submit('project.archive', { projectId: plan.projectId }, {
        scope, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      // 等待预算耗尽不是失败转移：项目保持可查询的 archiving，回执如实记录阻塞。
      expect(blockedArchive).toMatchObject({ status: 'completed', result: { status: 'archiving', settled: false, blockers: { unconfirmedStops: 1 } } });
      expect(await projectStatus(lifecycle.app, plan.projectId)).toBe('archiving');
      const archivingPage = await previewDelete(lifecycle, plan.projectId);
      expect(archivingPage.confirmable).toBe(false);
      expect(archivingPage.blockers).toContain('project_not_archived');
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: archivingPage.previewDigest, expiresAtUtcMs: archivingPage.expiresAtUtcMs,
      }, { scope, expectedRevision: archivingPage.projectRevision })).rejects.toMatchObject({ code: 'conflict' });
      expect(countDeleteOperations(lifecycle, plan.projectId)).toBe(0);

      // 确认停止后再次归档收敛；预览变为可确认。
      const confirmSession = lifecycle.openSession();
      try {
        confirmSession.transactWrite('f008.confirm-stop', db => {
          db.prepare("UPDATE execution_stop_operations SET status = 'stopped', stop_confirmed = 1, settled_at = ?, updated_at = ? WHERE id = 'stop-f008-guard'")
            .run(Date.now(), Date.now());
        });
      } finally { confirmSession.close(); }
      const settledArchive = await lifecycle.submit('project.archive', { projectId: plan.projectId }, {
        scope, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      expect(settledArchive).toMatchObject({ status: 'completed', result: { status: 'archived', settled: true } });

      // 过期预览：有效摘要 + 过期有效期 → conflict（不进入清点事务）。
      const page = await previewDelete(lifecycle, plan.projectId);
      expect(page.confirmable).toBe(true);
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: Date.now() - 1_000,
      }, { scope, expectedRevision: page.projectRevision })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });

      // 摘要漂移：错误 previewDigest 拒绝。
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: 'b'.repeat(64), expiresAtUtcMs: page.expiresAtUtcMs,
      }, { scope, expectedRevision: page.projectRevision })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });
      expect(countDeleteOperations(lifecycle, plan.projectId)).toBe(0);

      // 修订变化：恢复→再归档使项目修订前进；旧预览的确认被拒。
      await lifecycle.submit('project.restore', { projectId: plan.projectId }, {
        scope, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      await lifecycle.submit('project.archive', { projectId: plan.projectId }, {
        scope, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      const staleRevision = page.projectRevision;
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
      }, { scope, expectedRevision: staleRevision })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });
      expect(countDeleteOperations(lifecycle, plan.projectId)).toBe(0);

      // 跨项目确认：第二个真实项目的 scope 携带本项目摘要 → 拒绝。
      const repoB = join(lifecycle.sandbox.path, 'repository-guard-b');
      initGitRepo(repoB);
      writeFileSync(join(repoB, 'README.md'), 'guard b\n');
      commitAll(repoB, 'guard b baseline');
      const registeredB = await lifecycle.submit('project.register', {
        repositoryPath: repoB, displayName: 'F-008 guard B', description: null, labels: [],
      }, { scope: { kind: 'registration' } });
      const projectB = (registeredB.result as { project: { id: string } }).project.id;
      await lifecycle.submit('project.archive', { projectId: projectB }, {
        scope: { kind: 'project', projectId: projectB }, expectedRevision: projectRevision(lifecycle, projectB),
      });
      const pageB = await previewDelete(lifecycle, projectB);
      expect(pageB.confirmable).toBe(true);
      await expect(lifecycle.submit('project.delete.confirm', {
        projectId: projectB, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: pageB.expiresAtUtcMs,
      }, { scope: { kind: 'project', projectId: projectB }, expectedRevision: pageB.projectRevision }))
        .rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });
      expect(countDeleteOperations(lifecycle, projectB)).toBe(0);

      // 有效确认：固定命令信封提交一次并重放，返回同一删除事实，不重复副作用。
      const freshPage = await previewDelete(lifecycle, plan.projectId);
      expect(freshPage.confirmable).toBe(true);
      const confirmEnvelope = {
        schemaVersion: 5 as const,
        commandId: randomUUID(),
        operation: 'project.delete.confirm' as const,
        issuedAt: new Date().toISOString(),
        scope: { kind: 'project' as const, projectId: plan.projectId },
        expectedRevision: freshPage.projectRevision,
        payload: { projectId: plan.projectId, confirmed: true, previewDigest: freshPage.previewDigest, expiresAtUtcMs: freshPage.expiresAtUtcMs },
      };
      const confirmed = await lifecycle.app.commandService.submit(lifecycle.owner, confirmEnvelope as never);
      expect(confirmed).toMatchObject({ status: 'accepted' });
      const operationId = (confirmed as Record<string, any>).operationId as string;
      const replayed = await lifecycle.app.commandService.submit(lifecycle.owner, confirmEnvelope as never);
      expect(replayed).toMatchObject({ status: 'accepted', replayed: true, operationId });
      expect(countDeleteOperations(lifecycle, plan.projectId)).toBe(1);
      expect(await projectStatus(lifecycle.app, plan.projectId)).toBe('deleting');
      // deleting 保持可见可查询（区别于已删除）。
      expect((await lifecycle.app.stateStore.listProjects({ status: 'all' })).records.map(record => record.id)).toContain(plan.projectId);

      // 未知来源路径不能变为删除目标：执行器拒绝携带 sourcePath 的输入，零副作用。
      const operation = lifecycle.app.projectDeleteStore.get(lifecycle.owner, operationId);
      await expect(lifecycle.app.projectDeleteExecutor.execute({
        principal: lifecycle.owner, operationId, owner: 'f008-guard-executor',
        expectedFence: operation.fence, previousExecutorStopped: false,
        sourcePath: lifecycle.repoDir,
      } as never)).rejects.toMatchObject({ kind: 'validation' });
      expect(await projectStatus(lifecycle.app, plan.projectId)).toBe('deleting');

      saveGroupEvidence('delete-guards', {
        projectId: plan.projectId,
        activeBlockers: activePage.blockers,
        archivingBlockers: archivingPage.blockers,
        settledArchiveReceipt: { settled: true },
        rejected: ['expired-preview', 'digest-drift', 'stale-revision', 'cross-project-confirm'],
        confirmedOperationId: operationId,
        deleteOperationCount: 1,
      });
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 120_000);

  it('[case:delete-interrupt-restart] 受控删除中断后重启：等待停止确认，同 operation 续核完成；最小回执与外部事实保留', async () => {
    const lifecycle = await openLifecycleApp('shiploop-p07-5-f008-interrupt-');
    const dataRoot = lifecycle.sandbox.path;
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const runId = await startExecution(lifecycle, plan);
      settleRun(lifecycle, plan.projectId, runId);
      const artifactA = new TextEncoder().encode('f008 delete body a');
      const artifactB = new TextEncoder().encode('f008 delete body b');
      seedReadyArtifact(lifecycle, plan.projectId, 'f008-body-a', 'document', artifactA);
      seedReadyArtifact(lifecycle, plan.projectId, 'f008-body-b', 'document', artifactB);
      const stagingPath = join(dataRoot, 'staging', plan.projectId, 'f008-residue.part');
      mkdirSync(join(stagingPath, '..'), { recursive: true });
      writeFileSync(stagingPath, 'f008 fixed staging bytes');

      // 幸存项目（另一项目的行与正文）与未获准目录哨兵：删除不得波及。
      const survivorBody = Buffer.from('f008 survivor evidence');
      const survivorArtifactId = 'f008-survivor-evidence';
      const survivorPath = join(dataRoot, 'projects', 'f008-survivor', 'artifacts', survivorArtifactId, 'content');
      mkdirSync(join(survivorPath, '..'), { recursive: true });
      writeFileSync(survivorPath, survivorBody);
      const sentinelDir = join(dataRoot, 'unapproved-keep');
      mkdirSync(sentinelDir, { recursive: true });
      const sentinelPath = join(sentinelDir, 'sentinel.txt');
      writeFileSync(sentinelPath, 'do not delete');
      writeFileSync(join(lifecycle.repoDir, 'external-keep.txt'), 'external sentinel');
      const session = lifecycle.openSession();
      try {
        session.transactWrite('f008.seed-survivor', db => {
          const now = Date.now();
          db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('f008-survivor', ?, 1, ?, 'F-008 survivor', 'active', '[]')").run(now, now);
          db.prepare(`INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type,
            expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason)
            VALUES (?, ?, 'f008-survivor', 1, ?, 'document', 'ready', 'text/plain', ?, ?, ?, 1, 'documents/f008-survivor', NULL)`)
            .run(survivorArtifactId, now, now, sha256Hex(survivorBody), sha256Hex(survivorBody), survivorBody.byteLength);
        });
      } finally { session.close(); }

      const headBefore = git(['rev-parse', 'HEAD'], lifecycle.repoDir).trim();
      const refsBefore = git(['show-ref'], lifecycle.repoDir).trim();
      const statusBefore = repoStatusEntries(lifecycle.repoDir);

      // 公开归档 → 预览 → 显式确认（默认管理入口全链）。
      const archiveReceipt = await lifecycle.submit('project.archive', { projectId: plan.projectId }, {
        scope: { kind: 'project', projectId: plan.projectId }, expectedRevision: projectRevision(lifecycle, plan.projectId),
      });
      if (archiveReceipt.status !== 'completed') throw new Error(JSON.stringify(archiveReceipt));
      const archiveCommandId = archiveReceipt.commandId as string;
      const page = await previewDelete(lifecycle, plan.projectId);
      expect(page.confirmable).toBe(true);
      const confirmed = await lifecycle.submit('project.delete.confirm', {
        projectId: plan.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
      }, { scope: { kind: 'project', projectId: plan.projectId }, expectedRevision: page.projectRevision });
      if (confirmed.status !== 'accepted') throw new Error(JSON.stringify(confirmed));
      const operationId = confirmed.operationId as string;

      // 受控删除步骤中断：第二个制品目录只读化，第一次执行在真实 unlink 边界失败
      //（第一枚正文已按持久计划移除，第二枚因 EACCES 保留，步骤未完成）。
      const bodyADir = join(dataRoot, 'projects', plan.projectId, 'artifacts', 'f008-body-a');
      const bodyBDir = join(dataRoot, 'projects', plan.projectId, 'artifacts', 'f008-body-b');
      chmodSync(bodyBDir, 0o500);
      const accepted = lifecycle.app.projectDeleteStore.get(lifecycle.owner, operationId);
      await expect(lifecycle.app.projectDeleteExecutor.execute({
        principal: lifecycle.owner, operationId, owner: 'f008-exec-a', expectedFence: accepted.fence, previousExecutorStopped: false,
      })).rejects.toThrow();
      const interrupted = lifecycle.app.projectDeleteStore.get(lifecycle.owner, operationId);
      expect(interrupted.status).toBe('failed');
      expect(interrupted.steps.every(step => step.status !== 'completed')).toBe(true);
      expect(await projectStatus(lifecycle.app, plan.projectId)).toBe('deleting');
      expect(existsSync(join(bodyADir, 'content'))).toBe(false);
      expect(existsSync(join(bodyBDir, 'content'))).toBe(true);
      expect(existsSync(stagingPath)).toBe(true);
      expect(occupancyState(lifecycle)).toBe('held');
      chmodSync(bodyBDir, 0o700);

      // 重启 Core：同一数据根上的新组合根（旧执行者进程已随旧 App 关闭）。
      await lifecycle.close();
      const app2 = await openCoreApplication({
        dataRoot, capabilityCatalog: LIFECYCLE_CATALOG, inputSourceRoots: { repo: lifecycle.repoDir },
      });
      try {
        const current = app2.projectDeleteStore.get(lifecycle.owner, operationId);
        // 未确认旧执行者停止：明确等待人工/可信控制层确认，不自动续跑。
        await expect(app2.projectDeleteExecutor.execute({
          principal: lifecycle.owner, operationId, owner: 'f008-exec-b', expectedFence: current.fence, previousExecutorStopped: false,
        })).rejects.toMatchObject({ details: { reason: 'previous_executor_stop_unconfirmed' } });
        expect(await projectStatus(app2, plan.projectId)).toBe('deleting');

        // 确认旧执行者停止后，同一 operation 续核完成。
        const completed = await app2.projectDeleteExecutor.execute({
          principal: lifecycle.owner, operationId, owner: 'f008-exec-b', expectedFence: current.fence, previousExecutorStopped: true,
        });
        expect(completed.status).toBe('completed');

        // 管理行/正文/残留清除；项目不可见；幸存项目与其正文保留。
        expect(existsSync(join(bodyADir, 'content'))).toBe(false);
        expect(existsSync(join(bodyBDir, 'content'))).toBe(false);
        expect(existsSync(stagingPath)).toBe(false);
        await expect(app2.stateStore.getProject(plan.projectId)).rejects.toMatchObject({ kind: 'not_found' });
        expect((await app2.stateStore.listProjects({ status: 'all' })).records.map(record => record.id)).not.toContain(plan.projectId);
        expect(await app2.stateStore.getProject('f008-survivor')).toMatchObject({ id: 'f008-survivor', status: 'active' });
        expect(readFileSync(survivorPath)).toEqual(survivorBody);

        // 外部源码仓库与未获准目录哨兵、Git 事实保持不变。
        expect(git(['rev-parse', 'HEAD'], lifecycle.repoDir).trim()).toBe(headBefore);
        expect(git(['show-ref'], lifecycle.repoDir).trim()).toBe(refsBefore);
        expect(repoStatusEntries(lifecycle.repoDir)).toEqual(statusBefore);
        expect(readFileSync(join(lifecycle.repoDir, 'external-keep.txt'), 'utf8')).toBe('external sentinel');
        expect(readFileSync(sentinelPath, 'utf8')).toBe('do not delete');

        // 最小删除回执与 operation 摘要保留（无 manifest 正文）。
        const facts = await app2.projectDeleteQueryService.get(lifecycle.owner, operationId);
        expect(facts).toMatchObject({ operationId, projectId: plan.projectId, status: 'completed', failedStep: null });
        // 受控查询返回最小事实：不包含 manifest/inventory 正文。
        expect(JSON.stringify(facts)).not.toContain('manifest');
        expect(JSON.stringify(facts)).not.toContain('inventory');
        const db = lifecycle.readonlyDatabase();
        try {
          const operationRow = db.prepare('SELECT status, manifest_json FROM project_delete_operations WHERE id = ?').get(operationId) as { status: string; manifest_json: string | null };
          expect(operationRow).toEqual({ status: 'completed', manifest_json: null });
          expect((db.prepare('SELECT COUNT(*) AS n FROM project_delete_steps WHERE operation_id = ? AND status = ?').get(operationId, 'completed') as { n: number }).n).toBe(3);
          const minimal = db.prepare('SELECT receipt_json FROM project_delete_receipts WHERE command_id = ?').get(archiveCommandId) as { receipt_json: string };
          const receipt = JSON.parse(minimal.receipt_json) as { result?: Record<string, unknown> };
          // 已完成回执仅保留最小事实：不携带原结果正文（settled/project 等）。
          expect(receipt.result).toEqual({ projectDeleted: true });
          expect(minimal.receipt_json).not.toContain('settled');
          expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
        } finally { db.close(); }
        expect(occupancyState(lifecycle)).toBe('idle');
      } finally {
        await app2.workExecution.close();
        await app2.close();
      }

      saveGroupEvidence('delete-restart', {
        projectId: plan.projectId,
        interrupted: { status: 'failed', completedSteps: 0, occupancy: 'held' },
        restart: { waitedForStopConfirmation: true, completed: true },
        retained: { survivorProject: 'f008-survivor', sentinel: 'unapproved-keep/sentinel.txt', sourceRepo: { head: headBefore, refs: refsBefore } },
        minimalReceipt: { projectDeleted: true },
      });
    } finally {
      // lifecycle.close() 已在重启前执行；此处只兜底清理沙箱。
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 120_000);

  it('[case:retention-policy-disk-threshold] 保留政策与磁盘阈值：引用/窗口/缺正文证据保留，唯一备份保留，清理结果显式', async () => {
    const lifecycle = await openLifecycleApp('shiploop-p07-5-f008-retention-');
    try {
      const registered = await lifecycle.submit('project.register', {
        repositoryPath: lifecycle.repoDir, displayName: 'F-008 retention', description: null, labels: [],
      }, { scope: { kind: 'registration' } });
      const projectId = (registered.result as { project: { id: string } }).project.id;

      const policy: RetentionPolicyV2 = {
        evidenceRetentionDays: 10, backupRetentionDays: 30, maxBackupCount: 5,
        diskMinFreeBytes: 1_048_576, diskMinFreePercent: 99,
      };
      await lifecycle.submit('settings.global.create', { schemaVersion: 2, policies: { retentionPolicy: policy } }, { scope: { kind: 'global' } });

      // 证据分组：过期未引用（可清理）、过期被引用、窗口内、缺正文。
      const freeBody = new TextEncoder().encode('f008 expired unreferenced');
      const referencedBody = new TextEncoder().encode('f008 referenced evidence');
      seedReadyArtifact(lifecycle, projectId, 'f008-artifact-free', 'recording', freeBody, 20);
      seedReadyArtifact(lifecycle, projectId, 'f008-artifact-referenced', 'recording', referencedBody, 20);
      seedReadyArtifact(lifecycle, projectId, 'f008-artifact-recent', 'document', new TextEncoder().encode('f008 recent evidence'));

      // 唯一最新备份保留：在引入缺正文证据前建立真实备份包（备份导出对缺正文
      // 证据 fail-closed，本身即一条保护事实），清理后不得被轮换删除。
      await createBackup(lifecycle, 'f008-backup-retention');
      const backupDir = join(lifecycle.sandbox.path, 'backups', 'f008-backup-retention');

      const missingHash = 'ef'.repeat(32);
      const seed = lifecycle.openSession();
      try {
        const now = Date.now() - 20 * 86_400_000;
        seed.transactWrite('f008.seed-missing-body', db => {
          db.prepare(`INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type,
            expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason)
            VALUES ('f008-artifact-missing-body', ?, ?, 1, ?, 'recording', 'ready', 'application/octet-stream', ?, ?, ?, 1, 'recording/f008-artifact-missing-body', NULL)`)
            .run(now, projectId, now, missingHash, missingHash, 16);
          db.prepare(`INSERT INTO memory_records (id, created_at, project_id, updated_at, record_key, version, scope, status, content_ref, content_hash, source_refs, retrieval_count)
            VALUES ('f008-memory-reference', ?, ?, ?, 'key-f008', 1, 'project', 'accepted', 'f008-artifact-referenced', ?, ?, 0)`)
            .run(now, projectId, now, 'cd'.repeat(32), JSON.stringify([{ artifactId: 'f008-artifact-referenced' }]));
        });
      } finally { seed.close(); }

      // 磁盘阈值评估（只读观测显式呈现，不授权删除被引用证据）。
      const report = await lifecycle.app.retentionEvaluationService.evaluate(lifecycle.owner);
      expect(report.policy).toMatchObject({ status: 'configured' });
      expect(report.disk.status).toBe('observed');
      expect(report.thresholds.status).toBe('evaluated');
      const bytesTrigger = report.thresholds.triggers.find(trigger => trigger.kind === 'disk_min_free_bytes')!;
      expect(bytesTrigger.observedValue).toBeGreaterThanOrEqual(1_048_576);
      expect(bytesTrigger.assessment).toBe('not_triggered');
      const percentTrigger = report.thresholds.triggers.find(trigger => trigger.kind === 'disk_min_free_percent')!;
      expect(percentTrigger.observedValue).toBeGreaterThanOrEqual(0);
      expect(percentTrigger.assessment).toBe(percentTrigger.observedValue! < 99 ? 'triggered' : 'not_triggered');

      // 清理前评估（只读）：候选与保留原因显式分组。
      const evaluation = await lifecycle.app.retentionCleanupService.evaluate({ policy });
      expect(evaluation.candidates.map(item => item.object.id)).toEqual(['f008-artifact-free']);
      const retainedIds = evaluation.retained.map(item => item.object.id);
      expect(retainedIds).toEqual(expect.arrayContaining(['f008-artifact-referenced', 'f008-artifact-recent', 'f008-artifact-missing-body']));
      expect(evaluation.retained.find(item => item.object.id === 'f008-artifact-referenced')!.reasons).toContain('memory_records_reference');
      expect(evaluation.retained.find(item => item.object.id === 'f008-artifact-recent')!.reasons).toContain('within_retention_window');
      // 缺正文：显式 file_identity_unknown 保留，不折算为可清理空记录。
      expect(evaluation.retained.find(item => item.object.id === 'f008-artifact-missing-body')!.reasons).toContain('file_identity_unknown');

      const cleanup = await lifecycle.submit('retention.cleanup.execute', {}, { scope: { kind: 'global' } });
      expect(cleanup).toMatchObject({ status: 'completed', result: { status: 'completed', itemsDeleted: 1 } });
      const paths = {
        free: join(lifecycle.sandbox.path, 'projects', projectId, 'artifacts', 'f008-artifact-free', 'content'),
        referenced: join(lifecycle.sandbox.path, 'projects', projectId, 'artifacts', 'f008-artifact-referenced', 'content'),
        recent: join(lifecycle.sandbox.path, 'projects', projectId, 'artifacts', 'f008-artifact-recent', 'content'),
      };
      expect(existsSync(paths.free)).toBe(false);
      expect(readFileSync(paths.referenced)).toEqual(Buffer.from(referencedBody));
      expect(existsSync(paths.recent)).toBe(true);
      // 唯一最新备份在清理后保留（latest_backup_required；未被轮换删除）。
      expect(existsSync(join(backupDir, 'manifest.json'))).toBe(true);
      const db = lifecycle.readonlyDatabase();
      try {
        expect(db.prepare("SELECT id FROM artifacts WHERE id = 'f008-artifact-free'").get()).toBeUndefined();
        expect(db.prepare("SELECT id FROM artifacts WHERE id = 'f008-artifact-referenced'").get()).toBeDefined();
        expect(db.prepare("SELECT id FROM artifacts WHERE id = 'f008-artifact-recent'").get()).toBeDefined();
        // 缺正文行保留（未折算为空记录清理成功）。
        expect(db.prepare("SELECT id FROM artifacts WHERE id = 'f008-artifact-missing-body'").get()).toBeDefined();
        const operationId = (cleanup.result as Record<string, any>).operationId as string;
        const itemStatus = (id: string) => String((db.prepare('SELECT status FROM retention_operation_items WHERE operation_id = ? AND object_id = ?').get(operationId, id) as { status: string } | undefined)?.status);
        expect(itemStatus('f008-artifact-free')).toBe('deleted');
        expect(itemStatus('f008-artifact-referenced')).not.toBe('deleted');
        expect(itemStatus('f008-artifact-recent')).not.toBe('deleted');
        expect(itemStatus('f008-artifact-missing-body')).not.toBe('deleted');
      } finally { db.close(); }

      saveGroupEvidence('retention-cleanup', {
        projectId,
        policy,
        diskTriggerAssessments: { bytes: bytesTrigger.assessment, percent: percentTrigger.assessment },
        deleted: ['f008-artifact-free'],
        retained: ['f008-artifact-referenced', 'f008-artifact-recent', 'f008-artifact-missing-body', 'f008-backup-retention'],
      });
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 120_000);
});

function countDeleteOperations(lifecycle: LifecycleApp, projectId: string): number {
  const db = lifecycle.readonlyDatabase();
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM project_delete_operations WHERE target_project_id = ?').get(projectId) as { n: number }).n);
  } finally { db.close(); }
}

function occupancyState(lifecycle: LifecycleApp): string {
  const db = lifecycle.readonlyDatabase();
  try {
    return String((db.prepare("SELECT state FROM maintenance_occupancy WHERE id = 'global'").get() as { state: string }).state);
  } finally { db.close(); }
}
