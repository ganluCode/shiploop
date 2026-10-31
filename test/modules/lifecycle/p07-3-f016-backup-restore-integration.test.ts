/**
 * P07-3 / F-016：数据生命周期跨层集成（T15/T16 代表性垂直场景）。
 *
 * 覆盖（PRD §3.1/§3.3、core-design/09 T15/T16）：
 * - [case:public-backup-restore-roundtrip] 通过公开入口（默认组合根命令面 +
 *   真实预览/执行/备份执行编排 + owner 离线恢复入口）建立含业务对象、实际
 *   制品正文与原生记录（Session native_ref + Recorder 水位/缺口）的项目，
 *   备份并向新根隔离恢复；对照稳定身份、历史预算、内容 hash、原生版本/
 *   水位/缺口；恢复后的公开查询提供管理数据，但恢复事实与维护门禁明确
 *   阻止把“管理数据可用”误报为“已恢复执行”。
 * - [case:missing-or-tampered-package-rejects-restore] 真实备份包缺正文/篡改
 *   正文时，离线核验与恢复入口拒绝完整恢复（结构化失败），目标根不落
 *   core.sqlite、不写发布日志；原包不受篡改副本影响。
 * 每项断言核对实际 SQLite/Git/文件事实，不依赖成功日志文字。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOfflineBackupVerificationService, createOfflineRestoreService } from '../../../packages/host/src/runtime/offline-restore.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import {
  openLifecycleApp, LIFECYCLE_CATALOG, readonlyDatabase, readJsonIfExists, seedApprovedPlan, seedReadyArtifact,
  seedRuntimeRecords, sha256Hex, startExecution, tableRows, waitFor,
} from '../../helpers/p07-3/lifecycle-app-fixture.ts';

const FACT_TABLES = [
  'projects', 'phases', 'features', 'tasks', 'runs', 'attempts', 'execution_batches',
  'task_attempt_reservations', 'runtime_start_reservations', 'sessions', 'recording_manifests', 'artifacts',
] as const;

describe('P07-3 F-016 data lifecycle cross-layer integration', () => {
  it('[case:public-backup-restore-roundtrip] 公开入口备份→隔离恢复→事实对照；管理数据可用不冒充已恢复执行', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-roundtrip-');
    const scratch: Array<() => void> = [];
    try {
      const repoBefore = lifecycle.repoFacts();
      const plan = await seedApprovedPlan(lifecycle);
      const scope = { kind: 'project', projectId: plan.projectId };

      // 实际制品：公开 execution.input.prepare 发布三正文（真实文件 + 索引）。
      const prepared = await lifecycle.submit('execution.input.prepare', {
        featureId: plan.featureId, taskId: 't-1',
        items: [{ purpose: 'spec', source: { kind: 'file', root: 'repo', relativePath: 'README.md' } }],
      }, { scope });
      if (prepared.status !== 'completed') throw new Error(`input prepare 失败: ${JSON.stringify(prepared)}`);
      const group = prepared.result.group as Record<string, { artifactId: string; contentHash: string }>;

      // 活动执行：公开 execution.start（真实预览 + 受控预算）。
      const runId = await startExecution(lifecycle, plan);

      // Runtime 写路径：Attempt + Work Session（started）+ native_ref/水位/缺口 + manifest。
      const runtime = seedRuntimeRecords(lifecycle, { projectId: plan.projectId, featureId: plan.featureId, runId, inputGroup: group as Record<string, Record<string, unknown>> });
      const nativeBody = new TextEncoder().encode('{"history":"f016-native"}');
      const nativeArtifactId = 'artifact-native-f016';
      const nativeHash = seedReadyArtifact(lifecycle, plan.projectId, nativeArtifactId, 'native-archive', nativeBody);

      // 公开备份命令（默认执行编排）：accepted → 持久完成事实。
      const backupId = 'f016-backup-1';
      const created = await lifecycle.app.dataBackupExecution.submit(lifecycle.owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation: 'data.backup.create', scope: { kind: 'global' }, payload: { backupId, target: 'default' },
      } as never);
      if (created.status !== 'accepted') throw new Error(`backup 未接受: ${JSON.stringify(created)}`);
      const operationId = created.operationId as string;
      await waitFor('备份导出完成', () => {
        const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${operationId}.json`));
        return journal !== null && journal.status !== 'running';
      }, 60_000);
      const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${operationId}.json`));
      if (journal?.status === 'failed') throw new Error(`备份导出失败: ${JSON.stringify(journal)}`);
      const operation = await lifecycle.app.dataBackupQueryService.getOperation(lifecycle.owner, operationId);
      expect(operation.status).toBe('completed');
      expect(operation.manifestDigest).toBeDefined();
      const backup = await lifecycle.app.dataBackupQueryService.getBackup(lifecycle.owner, backupId);
      expect(backup.status).toBe('complete');

      // 公开只读核验命令：完整性通过（文件/摘要一致）。
      const verified = await lifecycle.submit('data.backup.verify', { backupId, manifestDigest: operation.manifestDigest }, { scope: { kind: 'global' } });
      expect(verified.status).toBe('completed');
      expect(verified.result.status).toBe('complete');
      expect(verified.result.verifiedFiles).toBeGreaterThan(0);

      // 包事实：recorder 水位/缺口如实登记（会话级缺口标记 + complete 覆盖）。
      const packagePath = join(lifecycle.sandbox.path, 'backups', backupId);
      const manifest = JSON.parse(readFileSync(join(packagePath, 'manifest.json'), 'utf8')) as Record<string, any>;
      const recorder = (manifest.recorder as Array<Record<string, any>>).find(entry => entry.sessionId === runtime.sessionId);
      expect(recorder).toMatchObject({ watermark: runtime.watermark, coverage: 'complete', gaps: [] });

      // owner 离线恢复入口：核验 → 确认 → 隔离发布（不启动 Host）。
      const target = join(lifecycle.sandbox.path, 'restored-root');
      mkdirSync(target, { mode: 0o700 });
      scratch.push(() => rmSync(target, { recursive: true, force: true }));
      const restore = createOfflineRestoreService({ dataRoot: target });
      const preview = await restore.prepare({ operationId: 'f016-restore-1', packagePath });
      const receipt = await restore.confirm({ operationId: 'f016-restore-1', confirmation: preview.confirmation });
      // 恢复回执如实声明：执行被阻断，待当前仓库与停止事实核对。
      expect(receipt).toMatchObject({ status: 'published', execution: 'blocked_pending_current_repository_and_stop_checks', cleanup: 'retained' });

      // 事实对照：发布数据库与包内数据库逐表一致（稳定身份/预算/会话/原生记录）。
      const snapshot = readonlyDatabaseFor(join(packagePath, 'core.sqlite'));
      const restoredRaw = readonlyDatabaseFor(join(target, 'core.sqlite'));
      try {
        for (const table of FACT_TABLES) {
          expect(tableRows(restoredRaw, table), table).toEqual(tableRows(snapshot, table));
        }
      } finally { restoredRaw.close(); snapshot.close(); }
      // 历史预算（公开查询面）与制品内容 hash（真实字节）保持。
      const budgetStatus = await (async () => {
        const reader = readonlyDatabaseFor(join(target, 'core.sqlite'));
        try { return reader.prepare('SELECT * FROM execution_batches ORDER BY rowid').all(); } finally { reader.close(); }
      })();
      expect(budgetStatus.length).toBeGreaterThan(0);
      for (const artifactId of [group.snapshot!.artifactId, group.manifest!.artifactId, group.prompt!.artifactId, nativeArtifactId]) {
        const source = await lifecycle.app.artifactFileStore.openFinalRead({ projectId: plan.projectId, artifactId });
        const sourceBytes = await drain(source.stream);
        const targetFile = join(target, 'projects', plan.projectId, 'artifacts', artifactId, 'content');
        expect(sha256Hex(readFileSync(targetFile))).toBe(sha256Hex(sourceBytes));
      }
      expect(sha256Hex(readFileSync(join(target, 'projects', plan.projectId, 'artifacts', nativeArtifactId, 'content')))).toBe(nativeHash);

      // 打开恢复根：管理数据可查（公开查询），执行不冒充已恢复。
      // 历史预算 batch 身份从包内快照读取（避免对目标库的只读探测生成 WAL/SHM 边车，
      // 发布体只包含 core.sqlite + 制品正文）。
      const batchId = (() => {
        const reader = readonlyDatabase(join(packagePath, 'core.sqlite'));
        try { return String((reader.prepare('SELECT id FROM execution_batches ORDER BY rowid LIMIT 1').get() as { id: string }).id); }
        finally { reader.close(); }
      })();
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = join(target, `core.sqlite${suffix}`);
        if (existsSync(sidecar)) rmSync(sidecar);
      }
      let factories = 0;
      const restored = await openCoreApplication({
        dataRoot: target, capabilityCatalog: LIFECYCLE_CATALOG,
        workRuntimeFactory() { factories += 1; throw new Error('must-not-assemble-runtime'); },
      });
      try {
        const listed = await restored.queryService.listProjects(lifecycle.owner);
        expect(listed.records.some(record => record.id === plan.projectId)).toBe(true);
        const budget = await restored.queryService.getExecutionBudgetStatus(lifecycle.owner, { projectId: plan.projectId, batchId });
        // 历史预算可查且不因恢复置零/折算：同 batch + 运行事实保留。
        expect(budget.batch.id).toBe(batchId);
        expect(budget.runs.some(run => run.id === runId)).toBe(true);
        expect((await restored.workExecution.scan()).runs).toEqual([]);
        await restored.workExecution.recover();
        await restored.workExecution.scan();
        expect(factories).toBe(0);
        expect(restored.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'restored_data_requires_current_facts' });
        expect(() => restored.maintenanceGate!.assertCanWrite('work')).toThrow();
        const after = readonlyDatabaseFor(join(target, 'core.sqlite'));
        try {
          // 恢复后首次打开不复活执行：Attempt 一律 interrupted（非执行中）。
          expect(after.prepare('SELECT DISTINCT status FROM attempts').all()).toEqual([{ status: 'interrupted' }]);
          const sessionRow = after.prepare('SELECT native_ref, recording_watermark, recording_gaps FROM sessions WHERE id = ?').get(runtime.sessionId) as Record<string, any>;
          expect(sessionRow.native_ref).toBeNull();
          expect(sessionRow.recording_watermark).toBe(runtime.watermark);
          expect(sessionRow.recording_gaps).toBeNull();
          const manifestRow = after.prepare('SELECT native_ref, watermark, missing_reasons, sdk_version, format_version FROM recording_manifests WHERE session_id = ?').get(runtime.sessionId) as Record<string, any>;
          expect(manifestRow).toMatchObject({ watermark: runtime.watermark, missing_reasons: '[]', sdk_version: 'f016-sdk', format_version: 'work-recording/v1' });
          expect(JSON.parse(manifestRow.native_ref as string)).toEqual(runtime.nativeRef);
        } finally { after.close(); }
        // 原生正文在恢复根仍可按内容 hash 校验读取。
        const nativeRead = await restored.artifactFileStore.openFinalRead({ projectId: plan.projectId, artifactId: nativeArtifactId });
        expect(sha256Hex(await drain(nativeRead.stream))).toBe(nativeHash);
      } finally {
        await restored.workExecution.close();
        await restored.close();
      }
      // 源仓库在备份/恢复全程保持原状（Git 事实）。
      const repoAfter = lifecycle.repoFacts();
      expect(repoAfter.head).toBe(repoBefore.head);
      expect(repoAfter.refs).toBe(repoBefore.refs);
      expect(existsSync(join(lifecycle.repoDir, '.git'))).toBe(true);
    } finally {
      await lifecycle.close().catch(() => undefined);
      for (const cleanup of scratch.reverse()) cleanup();
      lifecycle.sandbox.cleanup();
    }
  }, 120_000);

  it('[case:missing-or-tampered-package-rejects-restore] 缺正文/篡改包拒绝完整恢复；原包不受影响', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-tamper-');
    const scratch: Array<() => void> = [];
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const body = new TextEncoder().encode('tamper evidence body');
      const artifactId = 'artifact-doc-f016';
      const hash = seedReadyArtifact(lifecycle, plan.projectId, artifactId, 'document', body);

      const backupId = 'f016-backup-tamper';
      const created = await lifecycle.app.dataBackupExecution.submit(lifecycle.owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation: 'data.backup.create', scope: { kind: 'global' }, payload: { backupId, target: 'default' },
      } as never);
      if (created.status !== 'accepted') throw new Error(JSON.stringify(created));
      const operationId = created.operationId as string;
      await waitFor('备份导出完成', () => {
        const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${operationId}.json`));
        return journal !== null && journal.status !== 'running';
      }, 60_000);
      const failedJournal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${operationId}.json`));
      if (failedJournal?.status === 'failed') throw new Error(`备份导出失败: ${JSON.stringify(failedJournal)}`);
      const operation = await lifecycle.app.dataBackupQueryService.getOperation(lifecycle.owner, operationId);
      expect(operation.status).toBe('completed');
      const packagePath = join(lifecycle.sandbox.path, 'backups', backupId);
      const bodyEntry = join(packagePath, 'artifacts', plan.projectId, artifactId);
      expect(sha256Hex(readFileSync(bodyEntry))).toBe(hash);

      for (const variant of ['missing', 'tampered'] as const) {
        const broken = join(lifecycle.sandbox.path, `package-${variant}`);
        cpSync(packagePath, broken, { recursive: true });
        scratch.push(() => rmSync(broken, { recursive: true, force: true }));
        if (variant === 'missing') rmSync(join(broken, 'artifacts', plan.projectId, artifactId));
        else writeFileSync(join(broken, 'artifacts', plan.projectId, artifactId), 'tampered bytes');

        // 离线核验：结构化报告如实 incomplete，不冒充通过。
        const verifyRoot = join(lifecycle.sandbox.path, `verify-root-${variant}`);
        mkdirSync(verifyRoot, { recursive: true, mode: 0o700 });
        const verifier = createOfflineBackupVerificationService({ dataRoot: verifyRoot });
        const report = await verifier.verify({ packagePath: broken });
        expect(report.status).not.toBe('complete');
        expect(report.reasons.some(reason => reason.includes(plan.projectId) || reason.includes('file'))).toBe(true);

        // 恢复入口拒绝完整恢复；目标根保持空（无 core.sqlite、无发布日志）。
        const target = join(lifecycle.sandbox.path, `target-${variant}`);
        mkdirSync(target, { mode: 0o700 });
        scratch.push(() => rmSync(target, { recursive: true, force: true }));
        const restore = createOfflineRestoreService({ dataRoot: target });
        await expect(restore.prepare({ operationId: `restore-${variant}`, packagePath: broken }))
          .rejects.toThrow('data.restore: backup_not_verified');
        expect(existsSync(join(target, 'core.sqlite'))).toBe(false);
        expect(existsSync(join(target, 'restore-operation.json'))).toBe(false);
      }

      // 原包不受影响：同一原包在干净目标可完整核验并 prepare。
      const cleanTarget = join(lifecycle.sandbox.path, 'target-clean');
      mkdirSync(cleanTarget, { mode: 0o700 });
      scratch.push(() => rmSync(cleanTarget, { recursive: true, force: true }));
      const cleanVerifier = createOfflineBackupVerificationService({ dataRoot: cleanTarget });
      expect((await cleanVerifier.verify({ packagePath })).status).toBe('complete');
      const preview = await createOfflineRestoreService({ dataRoot: cleanTarget }).prepare({ operationId: 'restore-clean', packagePath });
      expect(preview.status).toBe('prepared');
      // 源根事实保持：正文与数据库仍在原位。
      expect(sha256Hex(readFileSync(join(lifecycle.sandbox.path, 'projects', plan.projectId, 'artifacts', artifactId, 'content')))).toBe(hash);
      expect(existsSync(join(lifecycle.sandbox.path, 'core.sqlite'))).toBe(true);
    } finally {
      await lifecycle.close().catch(() => undefined);
      for (const cleanup of scratch.reverse()) cleanup();
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);

  it('[case:declared-native-archive-refuses-backup] 会话声明不可导出的原生存储时，备份拒绝发布完整包', async () => {
    const lifecycle = await openLifecycleApp('shiploop-f016-native-');
    try {
      const plan = await seedApprovedPlan(lifecycle);
      const scope = { kind: 'project', projectId: plan.projectId };
      const prepared = await lifecycle.submit('execution.input.prepare', {
        featureId: plan.featureId, taskId: 't-1',
        items: [{ purpose: 'spec', source: { kind: 'file', root: 'repo', relativePath: 'README.md' } }],
      }, { scope });
      if (prepared.status !== 'completed') throw new Error(JSON.stringify(prepared));
      const group = prepared.result.group as Record<string, Record<string, unknown>>;
      const runId = await startExecution(lifecycle, plan);
      const runtime = seedRuntimeRecords(lifecycle, { projectId: plan.projectId, featureId: plan.featureId, runId, inputGroup: group, partialCoverage: true });
      // Runtime 声明不可导出原生存储 + 记录覆盖含真实缺口：备份 fail-closed 拒绝
      // 发布（操作日志如实 incomplete），不留下半完整包目录。
      const writer = lifecycle.openSession();
      try {
        writer.transactWrite('f016.declare-native', db => {
          db.prepare('UPDATE sessions SET native_ref = ? WHERE id = ?')
            .run(JSON.stringify({ schemaVersion: 1, storageKind: 'artifact', formatVersion: '2' }), runtime.sessionId);
        });
      } finally { writer.close(); }

      const created = await lifecycle.app.dataBackupExecution.submit(lifecycle.owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation: 'data.backup.create', scope: { kind: 'global' }, payload: { backupId: 'f016-backup-native', target: 'default' },
      } as never);
      if (created.status !== 'accepted') throw new Error(JSON.stringify(created));
      await waitFor('备份导出结束', () => {
        const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${created.operationId}.json`));
        return journal !== null && journal.status !== 'running';
      }, 60_000);
      const journal = readJsonIfExists(join(lifecycle.sandbox.path, 'backups', 'operations', `${created.operationId}.json`));
      expect(journal?.status).toBe('failed');
      expect(journal?.report.reasons).toContain(`native_archive_unavailable:${runtime.sessionId}`);
      expect(journal?.report.reasons).toContain(`recording_incomplete:${runtime.sessionId}`);
      expect(existsSync(join(lifecycle.sandbox.path, 'backups', 'f016-backup-native'))).toBe(false);
    } finally {
      await lifecycle.close().catch(() => undefined);
      lifecycle.sandbox.cleanup();
    }
  }, 60_000);
});

function readonlyDatabaseFor(path: string) {
  return readonlyDatabase(path);
}

async function drain(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
