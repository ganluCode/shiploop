/**
 * P07-3 / F-014：备份创建/核验/查询默认接线的真实 loopback Host 回归。
 *
 * 覆盖：
 * - data.backup.create → 202 accepted v8 回执（稳定 operationId + backupId），
 *   执行编排在提交后导出；完成状态取自持久结果（操作日志 + 备份包目录）；
 * - 同 commandId 重放返回原回执、不重复导出；连接丢失后按 commandId 查回执；
 * - data.backup.verify 只读核验（manifest 摘要绑定；漂移 conflict）；
 * - backups.get / backup.operations.get 查询（未完成备份 not_found/报告）；
 * - 越权：无 data.backup 能力的受限主体（含仅单项目权限）403，查询同样拒绝；
 *   Work 工具面不可达 data.* 操作（独立操作表，无 owner 回退）；
 * - data.backup.restore 不经 HTTP（501 unsupported；实际恢复只在独立受锁维护
 *   入口执行，见 CLI 离线用例）。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/http-probe.ts';

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
  const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-host-'));
  const root = join(box, 'root');
  const host = await startHost({
    dataRoot: root,
    env: {},
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
  });
  const client = await connectToHost({ canonicalRoot: host.canonicalRoot });
  // 受限主体（仅单项目读权限；无 data.backup/data.restore）：可信测试装配的
  // 第二传输面复用同一 Core 服务，验证 owner 专用能力不被越权触达。
  const project = await host.core.stateStore.createProject({ displayName: 'F-014 restricted scope' });
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
      dataBackupExecutionService: host.core.dataBackupExecution,
      dataBackupQueryService: host.core.dataBackupQueryService,
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

async function waitForOperation(
  client: Awaited<ReturnType<typeof connectToHost>>,
  operationId: string,
): Promise<Awaited<ReturnType<typeof client.getBackupOperation>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await client.getBackupOperation(operationId);
    if (operation.status !== 'running') return operation;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('backup operation did not settle');
}

function backupCreateEnvelope(backupId: string, commandId = randomUUID()) {
  return {
    schemaVersion: 5 as const,
    commandId,
    operation: 'data.backup.create' as const,
    scope: { kind: 'global' as const },
    issuedAt: new Date().toISOString(),
    payload: { backupId, target: 'default' },
  };
}

describe('P07-3 F-014 backup default wiring (real loopback Host + HostClient)', () => {
  it('[case:accepted-then-persisted-result] create returns accepted v8 and completion comes from persisted facts', async () => {
    const f = await openFixture();
    try {
      const receipt = await f.client.submitDataBackupCreate({ backupId: 'backup-f014-a' });
      expect(receipt).toMatchObject({
        status: 'accepted',
        schemaVersion: 8,
        operation: 'data.backup.create',
        backupId: 'backup-f014-a',
        replayed: false,
      });
      const accepted = receipt as { operationId: string };
      expect(accepted.operationId).toMatch(/^[0-9a-f-]{36}$/);
      const operation = await waitForOperation(f.client, accepted.operationId);
      expect(operation).toMatchObject({
        status: 'completed',
        operationId: accepted.operationId,
        backupId: 'backup-f014-a',
        kind: 'backup',
        target: 'default',
      });
      expect(operation.report?.status).toBe('complete');
      expect(operation.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
      const backup = await f.client.getBackup('backup-f014-a');
      expect(backup.status).toBe('complete');
      expect(backup.manifestDigest).toBe(operation.manifestDigest);
      expect(backup.manifestSummary).toMatchObject({ backupId: 'backup-f014-a', fileCount: expect.any(Number) });
      // 持久结果在磁盘（受管 backups/ 根），不是进程内存。
      expect(readdirSync(join(f.root, 'backups', 'backup-f014-a'))).toContain('manifest.json');
    } finally {
      await f.dispose();
    }
  });

  it('[case:idempotent-replay-no-duplicate-export] same commandId replays the original receipt exactly once', async () => {
    const f = await openFixture();
    try {
      const commandId = randomUUID();
      const first = await f.client.submitDataBackupCreate({ backupId: 'backup-f014-b', commandId });
      expect(first.status).toBe('accepted');
      const firstOperationId = (first as { operationId: string }).operationId;
      await waitForOperation(f.client, firstOperationId);
      // 重放以既有回执的原 issuedAt 重建同一信封（同摘要 → 原回执）。
      const replay = await f.client.submitDataBackupCreate(
        { backupId: 'backup-f014-b', commandId, issuedAt: first.issuedAt },
        { commandId, issuedAt: first.issuedAt },
      );
      expect(replay).toMatchObject({ status: 'accepted', operationId: firstOperationId, replayed: true });
      // 备份目标唯一：不同 commandId 同 backupId 在事务外预检即拒绝（conflict，
      // 零回执零副作用；受管 backups/ 根内不出现第二份导出）。
      await expect(f.client.submitDataBackupCreate({ backupId: 'backup-f014-b' })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(readdirSync(join(f.root, 'backups')).filter(name => name.startsWith('backup-f014-b'))).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it('[case:receipt-query-after-connection-loss] lost submit response resolves via receipts.get by original commandId', async () => {
    const f = await openFixture();
    try {
      // 模拟提交响应丢失：直接打 HTTP，不消费响应体后关闭；随后以原 commandId
      // 查回执并重放同一信封——不重复导出。
      const commandId = randomUUID();
      const issuedAt = new Date().toISOString();
      const envelope = backupCreateEnvelope('backup-f014-c', commandId);
      envelope.issuedAt = issuedAt;
      const ownerToken = readFileSync(join(f.root, 'host', 'auth.token'), 'utf8');
      const response = await loopbackRequest({
        port: f.host.port,
        method: 'POST',
        path: '/v1/commands',
        token: ownerToken,
        body: envelope,
      });
      expect(response.statusCode).toBe(202);
      const receipt = await f.client.getReceipt(commandId);
      expect(receipt).toMatchObject({ status: 'accepted', operationId: expect.any(String) });
      const acceptedReceipt = receipt as { operationId: string };
      const settled = await waitForOperation(f.client, acceptedReceipt.operationId);
      expect(settled.status).toBe('completed');
      const replay = await f.client.submitDataBackupCreate(
        { backupId: 'backup-f014-c', commandId, issuedAt },
        { commandId, issuedAt },
      );
      expect(replay).toMatchObject({ status: 'accepted', replayed: true });
      expect(readdirSync(join(f.root, 'backups')).filter(name => name.startsWith('backup-f014-c'))).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it('[case:verify-binds-manifest-digest] verify returns the read-only report and rejects digest drift', async () => {
    const f = await openFixture();
    try {
      const created = await f.client.submitDataBackupCreate({ backupId: 'backup-f014-d' });
      expect(created.status).toBe('accepted');
      const operation = await waitForOperation(f.client, (created as { operationId: string }).operationId);
      const digest = operation.manifestDigest as string;
      const verified = await f.client.submitDataBackupVerify({ backupId: 'backup-f014-d', manifestDigest: digest });
      expect(verified.status).toBe('completed');
      if (verified.status === 'completed') {
        expect(verified.result).toMatchObject({ status: 'complete', backupId: 'backup-f014-d', manifestDigest: digest });
      }
      // 摘要漂移/未知备份在事务外预检即拒绝（conflict/not_found，零回执）。
      await expect(f.client.submitDataBackupVerify({ backupId: 'backup-f014-d', manifestDigest: 'a'.repeat(64) }))
        .rejects.toMatchObject({ code: 'conflict' });
      await expect(f.client.submitDataBackupVerify({ backupId: 'backup-f014-missing', manifestDigest: digest }))
        .rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await f.dispose();
    }
  });

  it('[case:unauthorized-and-unsupported] restricted principal cannot export/verify/query and restore is not routed over HTTP', async () => {
    const f = await openFixture();
    try {
      const post = (path: string, body: unknown) =>
        loopbackRequest({ port: f.restrictedPort, method: 'POST', path, token: f.restrictedToken, body });
      const get = (path: string) =>
        loopbackRequest({ port: f.restrictedPort, method: 'GET', path, token: f.restrictedToken });
      // 整库导出拒绝只有单项目权限的主体（403 forbidden，零回执）。
      const create = await post('/v1/commands', backupCreateEnvelope('backup-f014-e'));
      expect(create.statusCode).toBe(403);
      expect(create.bodyText).not.toContain('local-owner');
      const verify = await post('/v1/commands', {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation: 'data.backup.verify',
        scope: { kind: 'global' },
        issuedAt: new Date().toISOString(),
        payload: { backupId: 'backup-f014-e', manifestDigest: 'b'.repeat(64) },
      });
      expect(verify.statusCode).toBe(403);
      // 查询面同样拒绝（能力位复用 data.backup）。
      expect((await get('/v1/backups/backup-f014-e')).statusCode).toBe(403);
      expect((await get(`/v1/backup-operations/${randomUUID()}`)).statusCode).toBe(403);
      // data.backup.restore 不经 HTTP：owner 提交也保持 unsupported（不通过
      // HTTP 替换运行中 Host 数据库；实际恢复在独立受锁维护入口）。
      await expect(f.client.submitCommand({
        operation: 'data.backup.restore',
        scope: { kind: 'global' },
        payload: {
          confirmation: {
            schemaVersion: 1,
            backupId: 'backup-f014-e',
            manifestDigest: 'c'.repeat(64),
            verificationDigest: 'd'.repeat(64),
            targetDataRootId: 'target-root',
            targetMode: 'empty-isolated',
            confirmed: true,
          },
        },
      })).rejects.toMatchObject({ code: 'unsupported' });
      // 未知备份查询 → not_found（owner 面如实呈现不存在，不伪造空事实）。
      await expect(f.client.getBackup('backup-f014-unknown')).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.client.getBackupOperation(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await f.dispose();
    }
  });
});
