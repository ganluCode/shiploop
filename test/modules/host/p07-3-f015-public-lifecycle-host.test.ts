/**
 * P07-3 / F-015：项目归档/恢复/删除与保留管理公开操作面的真实 loopback Host 回归。
 *
 * 覆盖：
 * - project.archive/restore 经 /v1/commands（completed 回执列出阻塞；恢复不启动
 *   Run）；projects.list 默认隐藏 archived、status 筛选可见（归档列表过滤）；
 * - project.delete.preview / project.delete.confirm 公开流程：accepted 携带稳定
 *   operationId；重复命令返回同一删除事实；accepted 不显示成已删除；
 * - 删除操作受控只读查询 project.delete.operation.get：原始主体读最小事实，
 *   其他主体 403、非法 operationId 400；完成后普通列表/详情不返回已删除项目；
 * - 预览摘要漂移（previewDigest 不匹配）与未归档删除确认一致拒绝；
 * - retention.evaluation.get / retention.cleanup.execute 公开接线（政策未配置
 *   rejected conflict；配置后 completed 摘要）；
 * - 受限主体（无 project.lifecycle.write / settings.global.write）对破坏性
 *   操作 403，无 owner 回退；
 * - 文件制作用受控执行器（受信装配端口，非客户端入口）推进到 completed。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  connectToHost,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  startHost,
} from '../../../packages/host/src/index.ts';
import type { HostApplicationContext } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { initGitRepo, commitAll } from '../../helpers/git-repo.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

interface Fixture {
  readonly root: string;
  readonly host: Awaited<ReturnType<typeof startHost>>;
  readonly client: Awaited<ReturnType<typeof connectToHost>>;
  readonly restrictedServer: Server;
  readonly restrictedPort: number;
  readonly restrictedToken: string;
  dispose(): Promise<void>;
}

async function openFixture(): Promise<Fixture> {
  const box = mkdtempSync(join(tmpdir(), 'shiploop-f015-host-'));
  const root = join(box, 'root');
  const host = await startHost({
    dataRoot: root,
    env: {},
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
  });
  const client = await connectToHost({ canonicalRoot: host.canonicalRoot });
  // 受限主体（仅项目读；无 project.lifecycle.write / settings.global.write）：
  // 第二传输面复用同一 Core 服务，验证破坏性操作不越权、无 owner 回退。
  const project = await host.core.stateStore.createProject({ displayName: 'F-015 restricted scope' });
  const restricted = createRestrictedPrincipal({
    capabilities: ['project.read'],
    projectScope: { kind: 'allowlist', projectIds: [project.id] },
  });
  const stop = createHostStopController({
    activityGate: createIdleActivityGate(),
    getLifecycleState: () => 'ready',
    setLifecycleState: () => {},
    prepareTeardown: async () => {},
    releaseAfterTeardown: async () => {},
  });
  const restrictedToken = randomUUID().replace(/-/g, '');
  const restrictedServer = createHostLifecycleServer({
    hostInstanceId: randomUUID(),
    dataRootIdentity: 'ab'.repeat(32),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    authToken: restrictedToken,
    getLifecycleState: () => 'ready',
    getActivities: () => stop.getActivities(),
    stop,
    application: {
      principal: restricted as unknown as import('../../../packages/core/src/ports/authorization.ts').TrustedPrincipal,
      commandService: host.core.commandService,
      queryService: host.core.queryService,
      commandReceiptsService: host.core.commandReceiptsService,
      onboardingService: host.core.onboardingService,
      baselineQueryService: host.core.baselineQueryService,
      baselineExecutionService: host.core.baselineExecutionService,
      planningQueryService: host.core.planningQueryService,
      projectDeleteQueryService: host.core.projectDeleteQueryService,
      getLifecycleState: () => 'ready',
    } as unknown as HostApplicationContext,
  });
  await new Promise<void>((resolve, reject) => {
    restrictedServer.once('error', reject);
    restrictedServer.listen(0, '127.0.0.1', resolve);
  });
  const restrictedPort = (restrictedServer.address() as { port: number }).port;
  return {
    root,
    host,
    client,
    restrictedServer,
    restrictedPort,
    restrictedToken,
    async dispose() {
      client.close();
      await new Promise<void>(resolve => restrictedServer.close(() => resolve()));
      await host.close();
    },
  };
}

async function registerProject(
  f: Fixture,
  name: string,
): Promise<{ readonly id: string; readonly revision: number }> {
  const repoDir = join(f.root, 'repos', name);
  mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');
  commitAll(repoDir, 'init');
  const receipt = await f.client.submitCommand({
    operation: 'project.register',
    scope: { kind: 'registration' },
    payload: { repositoryPath: repoDir, displayName: name },
  });
  if (receipt.status !== 'completed') throw new Error(JSON.stringify(receipt));
  const result = receipt.result as { project: { id: string; revision: number } };
  return result.project;
}

describe('P07-3 F-015 public lifecycle flows (loopback Host)', () => {
  it('archive → filtered list → restore；恢复不启动 Run，恢复与备份恢复区分命名', async () => {
    const f = await openFixture();
    try {
      const project = await f.host.core.stateStore.createProject({ displayName: 'F-015 archive target' });
      const archive = await f.client.submitProjectArchive({ projectId: project.id, expectedRevision: project.revision });
      expect(archive.status).toBe('completed');
      if (archive.status !== 'completed') throw new Error('unreachable');
      expect(archive.result).toMatchObject({ status: 'archived', settled: true });

      // 归档列表过滤：默认隐藏 archived；显式 status 筛选可见。
      const visible = await f.client.listProjects();
      expect(visible.records.some(record => record.id === project.id)).toBe(false);
      const archivedList = await f.client.listProjects({ status: 'archived' });
      expect(archivedList.records.some(record => record.id === project.id)).toBe(true);

      const detail = await f.client.getProject(project.id);
      expect(detail.project.status).toBe('archived');

      // 显式恢复：archived→active；不创建任何 Run/Batch（查询快照核对）。
      const archivedProject = (archive.result as { project: { revision: number } }).project;
      const restore = await f.client.submitProjectRestore({ projectId: project.id, expectedRevision: archivedProject.revision });
      expect(restore.status).toBe('completed');
      if (restore.status !== 'completed') throw new Error('unreachable');
      expect(restore.result).toMatchObject({ status: 'active' });
      const restoredList = await f.client.listProjects();
      expect(restoredList.records.some(record => record.id === project.id)).toBe(true);
      const runs = await f.host.core.queryService.listRuns(createLocalOwnerPrincipal(), { projectId: project.id });
      expect(runs.records).toHaveLength(0);

      // 错误 CAS：重复 archive 用旧 revision → rejected 回执（stale_revision 一致拒绝）。
      const stale = await f.client.submitProjectArchive({ projectId: project.id, expectedRevision: project.revision });
      expect(stale.status).toBe('rejected');
      if (stale.status !== 'rejected') throw new Error('unreachable');
      expect(stale.error.code).toBe('conflict');
      expect(stale.error.details).toMatchObject({ reason: 'stale_revision' });
    } finally {
      await f.dispose();
    }
  });

  it('delete preview → confirm → 受控执行 → operation 查询；重复命令返回同一删除事实', async () => {
    const f = await openFixture();
    try {
      const project = await registerProject(f, 'f015-delete-target');
      const archive = await f.client.submitProjectArchive({ projectId: project.id, expectedRevision: project.revision });
      if (archive.status !== 'completed') throw new Error(JSON.stringify(archive));

      const preview = await f.client.submitProjectDeletePreview({ projectId: project.id });
      expect(preview.status).toBe('completed');
      if (preview.status !== 'completed') throw new Error('unreachable');
      const page = preview.result as {
        projectRevision: number; previewDigest: string; expiresAtUtcMs: number;
        confirmable: boolean; blockers: readonly string[];
      };
      expect(page.confirmable).toBe(true);
      expect(page.blockers).toEqual([]);

      // 未归档项目删除确认一致拒绝（active 状态不进入删除；公开错误不折算回执）。
      const activeProject = await f.host.core.stateStore.createProject({ displayName: 'F-015 active guard' });
      await expect(f.client.submitProjectDeleteConfirm({
        projectId: activeProject.id, expectedRevision: 1,
        previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
      })).rejects.toMatchObject({ code: 'conflict' });

      // 预览摘要漂移拒绝：错误 previewDigest。
      await expect(f.client.submitProjectDeleteConfirm({
        projectId: project.id, expectedRevision: page.projectRevision,
        previewDigest: 'b'.repeat(64), expiresAtUtcMs: page.expiresAtUtcMs,
      })).rejects.toMatchObject({ code: 'conflict' });

      const confirm = await f.client.submitProjectDeleteConfirm({
        projectId: project.id, expectedRevision: page.projectRevision,
        previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
      });
      expect(confirm.status).toBe('accepted');
      if (confirm.status !== 'accepted') throw new Error('unreachable');
      expect(typeof confirm.operationId).toBe('string');

      // 重复命令（同 commandId + 原 issuedAt 重放）返回同一删除事实（accepted ≠ 已删除）。
      const confirmOriginal = await f.client.getReceipt(confirm.commandId);
      const confirmReplay = await f.client.submitProjectDeleteConfirm({
        projectId: project.id, expectedRevision: page.projectRevision,
        previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
        commandId: confirm.commandId, issuedAt: confirmOriginal.issuedAt,
      });
      expect(confirmReplay.status).toBe('accepted');
      if (confirmReplay.status !== 'accepted') throw new Error('unreachable');
      expect(confirmReplay.replayed).toBe(true);
      expect(confirmReplay.operationId).toBe(confirm.operationId);

      // 受控执行器（受信装配端口）推进删除到 completed。
      const owner = createLocalOwnerPrincipal();
      const operation = await f.host.core.projectDeleteExecutor.execute({
        principal: owner,
        operationId: confirm.operationId,
        owner: `f015-executor-${confirm.operationId}`,
        expectedFence: 1,
        previousExecutorStopped: false,
      });
      expect(operation.status).toBe('completed');

      // 删除操作受控查询：原始主体可读最小事实（不含 manifest 正文）。
      const facts = await f.client.getProjectDeleteOperation(confirm.operationId);
      expect(facts).toMatchObject({ operationId: confirm.operationId, projectId: project.id, status: 'completed', failedStep: null });
      expect(JSON.stringify(facts)).not.toContain('manifest');

      // 普通列表/详情不返回已删除项目。
      const list = await f.client.listProjects({ status: 'all' });
      expect(list.records.some(record => record.id === project.id)).toBe(false);
      // 项目详情对已删除项目按不可见折算（forbidden，与不存在不可区分）。
      await expect(f.client.getProject(project.id)).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await f.dispose();
    }
  });

  it('删除操作查询授权：仅原始提交主体可读；非法 operationId 结构拒绝', async () => {
    const f = await openFixture();
    try {
      const project = await registerProject(f, 'f015-query-guard');
      const archive = await f.client.submitProjectArchive({ projectId: project.id, expectedRevision: project.revision });
      if (archive.status !== 'completed') throw new Error(JSON.stringify(archive));
      const preview = await f.client.submitProjectDeletePreview({ projectId: project.id });
      if (preview.status !== 'completed') throw new Error('unreachable');
      const page = preview.result as { projectRevision: number; previewDigest: string; expiresAtUtcMs: number };
      const confirm = await f.client.submitProjectDeleteConfirm({
        projectId: project.id, expectedRevision: page.projectRevision,
        previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs,
      });
      if (confirm.status !== 'accepted') throw new Error(JSON.stringify(confirm));

      // 受限主体（其他项目可见性）读删除操作 → 403，不回显存在性。
      const response = await fetch(`http://127.0.0.1:${f.restrictedPort}/v1/project-delete-operations/${confirm.operationId}`, {
        headers: { authorization: `Bearer ${f.restrictedToken}` },
      });
      expect(response.status).toBe(403);
      const body = await response.json() as { error?: { code?: string; operation?: string } };
      expect(body.error?.code).toBe('forbidden');
      expect(body.error?.operation).toBe('project.delete.operation.get');

      // 原始主体：非法 operationId → 400 invalid_input。
      const badId = await fetch(`http://127.0.0.1:${f.restrictedPort}/v1/project-delete-operations/not-a-uuid`, {
        headers: { authorization: `Bearer ${f.restrictedToken}` },
      });
      expect(badId.status).toBe(400);

      // owner 主体的 HostClient 输入校验同样拒绝非法形态；不存在的操作 not_found。
      await expect(f.client.getProjectDeleteOperation('not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(f.client.getProjectDeleteOperation(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await f.dispose();
    }
  });

  it('retention evaluation/cleanup 公开接线：未配置政策 rejected；配置后 completed；受限主体 403', async () => {
    const f = await openFixture();
    try {
      // 评估只读：政策未配置也返回报告（policy.status=not_configured）。
      const evaluation = await f.client.getRetentionEvaluation();
      expect(evaluation.operation).toBe('retention.evaluation.get');
      expect(evaluation.policy.status).toBe('not_configured');

      // 清理：政策未配置 → rejected（conflict），不伪造执行。
      const unconfigured = await f.client.submitRetentionCleanup({});
      expect(unconfigured.status).toBe('rejected');
      if (unconfigured.status !== 'rejected') throw new Error('unreachable');
      expect(unconfigured.error.code).toBe('conflict');
      expect(unconfigured.error.details).toMatchObject({ reason: 'retention_policy_not_configured' });

      // 配置全局保留政策后执行一次清理（completed 摘要）并幂等重放。
      await f.host.core.stateStore.createGlobalSettings({
        payload: { schemaVersion: 2, policies: { retentionPolicy: { evidenceRetentionDays: 30, backupRetentionDays: 30, maxBackupCount: 3 } } },
      });
      const cleanup = await f.client.submitRetentionCleanup({});
      expect(cleanup.status).toBe('completed');
      if (cleanup.status !== 'completed') throw new Error('unreachable');
      expect(cleanup.result).toMatchObject({ status: 'completed', itemsDeleted: 0 });
      const cleanupOriginal = await f.client.getReceipt(cleanup.commandId);
      const cleanupReplay = await f.client.submitRetentionCleanup({ commandId: cleanup.commandId, issuedAt: cleanupOriginal.issuedAt });
      expect(cleanupReplay.status).toBe('completed');
      if (cleanupReplay.status !== 'completed') throw new Error('unreachable');
      expect(cleanupReplay.replayed).toBe(true);

      // 受限主体（无 settings.global.write）执行清理 → 403 forbidden，无 owner 回退。
      const response = await fetch(`http://127.0.0.1:${f.restrictedPort}/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.restrictedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 5,
          commandId: randomUUID(),
          operation: 'retention.cleanup.execute',
          scope: { kind: 'global' },
          issuedAt: new Date().toISOString(),
          payload: {},
        }),
      });
      expect(response.status).toBe(403);
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('forbidden');
    } finally {
      await f.dispose();
    }
  });

  it('受限主体对项目破坏性命令 403；能力宣告包含 F-015 命令与查询', async () => {
    const f = await openFixture();
    try {
      const project = await f.host.core.stateStore.createProject({ displayName: 'F-015 restricted guard' });
      const response = await fetch(`http://127.0.0.1:${f.restrictedPort}/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.restrictedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 5,
          commandId: randomUUID(),
          operation: 'project.archive',
          scope: { kind: 'project', projectId: project.id },
          expectedRevision: 1,
          issuedAt: new Date().toISOString(),
          payload: { projectId: project.id },
        }),
      });
      expect(response.status).toBe(403);
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('forbidden');

      // 握手能力宣告与真实接线一致（命令 + 删除操作查询）。
      const capabilities = (f.client.handshake as { capabilities: { application: { commands: readonly string[]; queries: readonly string[] } } }).capabilities.application;
      expect(capabilities.commands).toEqual(expect.arrayContaining([
        'project.archive', 'project.restore', 'project.delete.preview', 'project.delete.confirm', 'retention.cleanup.execute',
      ]));
      expect(capabilities.queries).toContain('project.delete.operation.get');
    } finally {
      await f.dispose();
    }
  });
});
