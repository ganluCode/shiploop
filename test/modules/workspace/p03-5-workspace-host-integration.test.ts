/**
 * P03-5 / F-011 workspace 准备/查询/清理/丢弃接入既有 Core 装配与 Host
 * 授权/幂等通道（真实生产组合根 openCoreApplication + 真实 startHost +
 * 真实临时 Git/SQLite/HTTP loopback）。
 *
 * 依据 docs/p03-5-workspace-host-integration-contract.md：
 * - 组合根装配 workspace 栈（workResources/authority/taskClaims/准备/保留/
 *   清理/丢弃/查询门面），不新增 Host/命令队列/事件工作流；
 * - 已认领 Attempt 的准备入口复用 P03-4 已提交认领回执；Run 保持 queued +
 *   runtime_not_found（不认领空 Attempt、不启动 Runtime）；
 * - 命令面：workspace.discard.preview（通用事务，事务外只读检查+证据发布）与
 *   workspace.discard（专属幂等通道：重放预检 + 丢弃摘要比对）；
 * - 查询面：四查询经 GET 路由 + project.read 能力位；分页有界、游标绑定；
 * - 负例：未认证 401、能力缺失 forbidden、跨项目 not_found、同 ID 不同参数
 *   conflict、畸形/未知版本消息 invalid_input、未知/重复查询参数 400。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalOwnerPrincipal, createRestrictedPrincipal, scopeAllowlist } from '../../helpers/p02-2/principals.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { git } from '../../helpers/git-repo.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { connectToHost, startHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { openCoreApplication } from 'shiploop-core/assembly';
import type { CoreApplication } from 'shiploop-core/assembly';
import type { WorkspaceDiscardPreview } from '../../../packages/core/src/ports/workspace-discard.ts';
import { validateWorkspaceDiscardConfirmInput, toWorkspaceDiscardStoreInput } from '../../../packages/core/src/ports/workspace-discard.ts';
import { createSqliteWorkspaceDiscardStore } from '../../../packages/core/src/adapters/sqlite/workspace-discard.ts';

const OWNER = createLocalOwnerPrincipal();

/** 生产组合根命令信封（真实时钟；与 commands.submit 同一纪律）。 */
function envelope(operation: string, projectId: string, payload: unknown, commandId: string = randomUUID()) {
  return {
    schemaVersion: 5,
    commandId,
    issuedAt: new Date().toISOString(),
    operation,
    scope: { kind: 'project' as const, projectId },
    payload,
  };
}

interface Vertical {
  readonly app: CoreApplication;
  readonly fixture: Awaited<ReturnType<typeof openClaimFixture>>;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly close: () => void;
}

/** 真实命令面全链路（register→…→start）+ 生产组合根认领 + 准备 + 保留。 */
async function vertical(): Promise<Vertical> {
  const fixture = await openClaimFixture();
  const app = await openCoreApplication({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
  });
  const projectId = fixture.box.projectId;
  const featureId = fixture.box.featureId;
  const runId = fixture.ids.runId;
  const taskId = fixture.ids.taskId;
  // 生产组合根认领：权标必须由同一 authority 实例颁发（能力不可伪造）。
  const binding = await app.stateStore.getRepositoryBinding(projectId);
  const token = await app.workWorkspaceAuthority.verifyPreparation(binding, featureId);
  const claim = app.taskClaims.claimTask({ ...fixture.input(), workspace: token }).receipt;
  const identity = {
    projectId,
    attemptId: claim.attempt.id,
    owner: claim.attempt.owner,
    hostInstanceId: claim.attempt.hostInstanceId,
    executionVersion: claim.attempt.executionVersion,
  };
  // 准备：真实 worktree 落盘（已认领 Attempt + 已提交认领回执交接）。
  const preparation = await app.workspacePreparation.prepare({
    identity,
    taskId,
    runId,
    claimKey: claim.claimKey,
    operationId: randomUUID(),
    workspaceId: randomUUID(),
  });
  expect(preparation.operation.status).toBe('succeeded');
  expect(preparation.workspace.status).toBe('ready');
  const worktreePath = preparation.workspace.canonicalPath;
  const branch = preparation.workspace.branch;
  const baseCommit = preparation.workspace.baseCommit;
  expect(existsSync(worktreePath)).toBe(true);
  // 保留：not_started 释放（未启动进程），现场与引用保留。
  const detail = await app.queryService.getWorkspace(OWNER, { projectId, featureId });
  const retained = await app.workspaceRetention.retain({
    identity,
    runId,
    taskId,
    workspaceId: preparation.workspace.id,
    operationId: randomUUID(),
    expectedWorkspaceRevision: detail.workspace.revision,
    reason: 'interrupted',
    evidenceRefs: preparation.operation.result!.evidenceRefs,
  });
  expect(retained.operation.status).toBe('succeeded');
  expect(retained.workspace.status).toBe('retained');
  return {
    app,
    fixture,
    projectId,
    featureId,
    runId,
    taskId,
    worktreePath,
    branch,
    baseCommit,
    close: () => {
      app.close();
      fixture.box.close();
    },
  };
}

/** 经命令面提交预览并返回预览结果（completed 回执）。 */
async function previewViaCommand(v: Vertical): Promise<{ receipt: unknown; preview: WorkspaceDiscardPreview }> {
  const receipt = await v.app.commandService.submit(
    OWNER,
    envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId }),
  );
  expect(receipt.status).toBe('completed');
  const preview = (receipt as { result: unknown }).result as WorkspaceDiscardPreview;
  expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
  return { receipt, preview };
}

function confirmPayload(v: Vertical, workspaceId: string, preview: WorkspaceDiscardPreview) {
  return {
    featureId: v.featureId,
    workspaceId,
    operationId: randomUUID(),
    expectedWorkspaceRevision: preview.workspaceRevision,
    preview: {
      previewDigest: preview.previewDigest,
      headCommit: preview.headCommit,
      codeDigest: preview.codeDigest,
      ignoredDigest: preview.ignoredDigest,
      workspaceRevision: preview.workspaceRevision,
      expiresAtUtcMs: preview.expiresAtUtcMs,
    },
    evidenceRefs: [preview.evidenceRef],
  };
}

describe('F-011 生产组合根纵向：认领→准备→保留→预览→确认→查询', () => {
  let v: Vertical | undefined;
  afterEach(() => {
    v?.close();
    v = undefined;
  });

  it('命令面预览+确认丢弃受管工作区；目录确证删除、分支/审计保留、状态可查询', async () => {
    v = await vertical();
    const sourceRefs = git(['show-ref'], v.fixture.box.box.repoDirA);
    const detailBefore = await v.app.queryService.getWorkspace(OWNER, {
      projectId: v.projectId,
      featureId: v.featureId,
    });
    expect(detailBefore.workspace.status).toBe('retained');
    expect(detailBefore.workspace.branch).toBe(v.branch);
    expect(detailBefore.workspace.baseCommit).toBe(v.baseCommit);

    // 预览命令：completed 回执携带预览；同一信封重放返回同一回执。
    const previewEnvelope = envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId });
    const previewReceipt = await v.app.commandService.submit(OWNER, previewEnvelope);
    expect(previewReceipt.status).toBe('completed');
    const preview = (previewReceipt as { result: unknown }).result as WorkspaceDiscardPreview;
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    const replayed = await v.app.commandService.submit(OWNER, previewEnvelope);
    expect(replayed).toEqual({ ...previewReceipt, replayed: true });

    // 确认命令：真实删除 worktree；分支与审计保留；回执 completed。
    const confirmEnvelope = envelope(
      'workspace.discard',
      v.projectId,
      confirmPayload(v, detailBefore.workspace.id, preview),
    );
    const confirmReceipt = await v.app.commandService.submit(OWNER, confirmEnvelope);
    expect(confirmReceipt.status).toBe('completed');
    expect(existsSync(v.worktreePath)).toBe(false);
    expect(git(['show-ref'], v.fixture.box.box.repoDirA)).toBe(sourceRefs);
    expect(git(['branch', '--list', v.branch], v.fixture.box.box.repoDirA).trim()).toBe(v.branch);

    // 确认重放：同一信封返回同一回执，零二次副作用。
    const confirmReplay = await v.app.commandService.submit(OWNER, confirmEnvelope);
    expect(confirmReplay).toEqual({ ...confirmReceipt, replayed: true });
    expect(existsSync(v.worktreePath)).toBe(false);

    // 查询：清理后状态与全部 operation（prepare/retain/discard）可读。
    // （列表按 id 升序稳定分页；UUID 主键下顺序非时间序，按集合断言。）
    const detail = await v.app.queryService.getWorkspace(OWNER, {
      projectId: v.projectId,
      featureId: v.featureId,
    });
    expect(detail.workspace.status).toBe('cleaned');
    const operations = await v.app.queryService.listWorkspaceOperations(OWNER, {
      projectId: v.projectId,
      featureId: v.featureId,
    });
    expect([...operations.records.map(record => record.kind)].sort()).toEqual(['discard', 'prepare', 'retain']);
    expect(operations.records.every(record => record.status === 'succeeded')).toBe(true);
    // 用户命令身份与终态结果回执是两层审计，引用必须指向真实持久行。
    const discard = operations.records.find(record => record.kind === 'discard')!;
    expect(discard.commandId).toBe(confirmReceipt.commandId);
    const persisted = v.fixture.box.session.database.prepare(`
      SELECT c.command_id, c.result_ref, c.status FROM workspace_operations o
      JOIN command_receipts c ON c.id = o.receipt_id WHERE o.id = ?
    `).get(discard.id) as { command_id: string; result_ref: string; status: string };
    expect(discard.receipt).toMatchObject({
      commandId: persisted.command_id, resultRef: persisted.result_ref, status: persisted.status,
    });
    expect(discard.receipt!.status).toBe('completed');
  }, 120_000);

  it('同命令重试恢复已提交的 pending 丢弃意图，而不是把意图回执冒充最终结果', async () => {
    v = await vertical();
    const { preview } = await previewViaCommand(v);
    const detail = await v.app.queryService.getWorkspace(OWNER, { projectId: v.projectId, featureId: v.featureId });
    const command = envelope('workspace.discard', v.projectId, confirmPayload(v, detail.workspace.id, preview));
    const input = toWorkspaceDiscardStoreInput(validateWorkspaceDiscardConfirmInput({
      ...command.payload as Record<string, unknown>, principal: OWNER, projectId: v.projectId, commandId: command.commandId,
    }));
    // 模拟进程在意图事务提交后、Git 删除之前中断。
    const store = createSqliteWorkspaceDiscardStore(v.fixture.box.session, { resources: v.app.workResources });
    expect(store.begin(input).commit.operation.status).toBe('pending');
    expect(existsSync(v.worktreePath)).toBe(true);
    const receipt = await v.app.commandService.submit(OWNER, command);
    expect(receipt.status).toBe('completed');
    expect(existsSync(v.worktreePath)).toBe(false);
    expect(receipt.replayed).toBe(true);
    const operations = await v.app.queryService.listWorkspaceOperations(OWNER, { projectId: v.projectId, featureId: v.featureId });
    expect(operations.records.filter(record => record.kind === 'discard')).toHaveLength(1);
    expect(operations.records.find(record => record.kind === 'discard')?.status).toBe('succeeded');
  }, 120_000);

  it('经生产命令面启动的 Run 保持 queued + runtime_not_found；不伪造 Runtime/Verifier 能力', async () => {
    // 独立夹具（不经 workspace 纵向）：验证生产组合根的启动纪律。
    const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const budget = { ...BUDGET, batch };
    const fixture = await openBudgetFixture(budget);
    const app = await openCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fixture.box.capabilityCatalog,
    });
    try {
      const projectId = fixture.projectId;
      const featureId = fixture.featureId;
      const previewReceipt = await app.commandService.submit(
        OWNER,
        envelope('execution.preview', projectId, { featureIds: [featureId], budget }),
      );
      expect(previewReceipt.status).toBe('completed');
      const preview = (previewReceipt as { result: { status: string; previewDigest: string } }).result;
      expect(preview.status).toBe('ready');
      expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
      const previewDigest = preview.previewDigest;
      const startReceipt = await app.commandService.submit(
        OWNER,
        envelope('execution.start', projectId, {
          featureIds: [featureId],
          budget,
          previewDigest,
        }),
      );
      expect(startReceipt.status).toBe('accepted');
      const runId = (startReceipt as { runId: string }).runId;
      const schedule = await app.queryService.getRunScheduleStatus(OWNER, {
        projectId,
        runId,
      });
      expect(schedule.run.status).toBe('queued');
      expect(schedule.run.reason).toBe('runtime_not_found');
      for (const table of ['attempts', 'runtime_start_reservations']) {
        const count = fixture.session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(count.n).toBe(0);
      }
    } finally {
      app.close();
      fixture.close();
    }
  }, 60_000);
});

describe('F-011 命令面授权/幂等纪律（生产组合根）', () => {
  let v: Vertical | undefined;
  afterEach(() => {
    v?.close();
    v = undefined;
  });

  it('能力缺失 forbidden；跨项目折叠 not_found；payload 深校验 invalid_input；同 ID 不同参数 conflict', async () => {
    v = await vertical();
    // 能力缺失（无 workspace.discard 能力位）→ forbidden（先于任何读取）。
    const noCapability = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: scopeAllowlist([v.projectId]),
    });
    await expect(
      v.app.commandService.submit(
        noCapability,
        envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 畸形 payload（缺 featureId / 未知键）→ invalid_input。
    await expect(
      v.app.commandService.submit(OWNER, envelope('workspace.discard.preview', v.projectId, {})),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      v.app.commandService.submit(
        OWNER,
        envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId, extra: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // 未知版本信封 → unsupported_schema_version（既有版本纪律不回退）。
    await expect(
      v.app.commandService.submit(OWNER, {
        ...envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId }),
        schemaVersion: 4,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_schema_version' });
    // 同 commandId 不同参数（预览）→ conflict(command_reused)。
    const { receipt } = await previewViaCommand(v);
    const commandId = (receipt as { commandId: string }).commandId;
    await expect(
      v.app.commandService.submit(
        OWNER,
        envelope('workspace.discard.preview', v.projectId, { featureId: randomUUID() }, commandId),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    // 工作区不存在（未丢弃但 featureId 不属于本项目的其他值）→ not_found。
    await expect(
      v.app.commandService.submit(
        OWNER,
        envelope('workspace.discard.preview', v.projectId, { featureId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  }, 120_000);

  it('并发重复确认提交安全：至多一次删除；败者得到资源占用/冲突拒绝或同一回执', async () => {
    v = await vertical();
    const { preview } = await previewViaCommand(v);
    const detail = await v.app.queryService.getWorkspace(OWNER, {
      projectId: v.projectId,
      featureId: v.featureId,
    });
    const commandId = randomUUID();
    const issuedAt = new Date().toISOString();
    const payload = confirmPayload(v, detail.workspace.id, preview);
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        v!.app.commandService.submit(
          OWNER,
          { ...envelope('workspace.discard', v!.projectId, payload, commandId), issuedAt },
        )),
    );
    const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected');
    // 至少一路完成；重放者返回同一回执，竞争者得到受控拒绝（resource_busy/conflict）。
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const outcome of fulfilled) {
      expect(outcome.value).toEqual({
        ...fulfilled[0]!.value,
        replayed: expect.any(Boolean),
      });
    }
    for (const outcome of rejected) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(['resource_busy', 'conflict']).toContain((reason as { code?: string }).code);
    }
    expect(existsSync(v.worktreePath)).toBe(false);
    const operations = await v.app.queryService.listWorkspaceOperations(OWNER, {
      projectId: v.projectId,
      featureId: v.featureId,
    });
    expect(operations.records.filter(record => record.kind === 'discard')).toHaveLength(1);
  }, 120_000);
});

describe('F-011 Host 传输面：查询路由 + 命令路由 + 能力握手', () => {
  let v: Vertical | undefined;
  let host: RunningHost | undefined;
  afterEach(async () => {
    if (host !== undefined) {
      await host.close();
      host = undefined;
    }
    v?.close();
    v = undefined;
  });

  it('四查询路由与命令路由真实接线；未认证 401；未知参数/方法/版本拒绝', async () => {
    v = await vertical();
    host = await startHost({
      dataRoot: v.fixture.box.box.dataRoot,
      capabilityCatalog: v.fixture.box.box.capabilityCatalog,
      env: {},
    });
    const token = readFileSync(join(v.fixture.box.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const auth = { authorization: `Bearer ${token}` };
    const get = (path: string, headers: Record<string, string> = auth) =>
      loopbackRequest({ port: host!.port, method: 'GET', path, headers });

    // 握手能力：四查询 + 两命令真实宣告（v5 内增量）。
    const client = await connectToHost({ canonicalRoot: v.fixture.box.box.dataRoot });
    try {
      expect(client.handshake.capabilities.application.queries).toEqual(
        expect.arrayContaining([
          'workspaces.list',
          'workspaces.get',
          'workspace.operations.list',
          'workspace.operations.get',
        ]),
      );
      expect(client.handshake.capabilities.application.commands).toEqual(
        expect.arrayContaining(['workspace.discard', 'workspace.discard.preview']),
      );
    } finally {
      client.close();
    }

    // workspaces.list
    const list = await get(`/v1/workspaces?projectId=${v.projectId}`);
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as {
      scope: string;
      records: { id: string; status: string; branch: string; featureId: string }[];
      nextCursor: string | null;
    };
    expect(listBody.scope).toBe('workspace-list');
    expect(listBody.records).toHaveLength(1);
    expect(listBody.records[0]).toMatchObject({
      featureId: v.featureId,
      status: 'retained',
      branch: v.branch,
    });
    expect(listBody.nextCursor).toBeNull();
    // 脱敏：响应不含绝对路径。
    expect(list.bodyText).not.toContain(v.fixture.box.box.dataRoot);
    expect(list.bodyText).not.toContain(v.fixture.box.box.repoDirA);

    // workspaces.get
    const detail = await get(`/v1/workspaces/${v.featureId}?projectId=${v.projectId}`);
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      workspace: { status: string };
      preparationOperation: { kind: string; status: string; receipt: { commandId: string } } | null;
      latestOperation: { kind: string } | null;
    };
    expect(detailBody.workspace.status).toBe('retained');
    expect(detailBody.preparationOperation).toMatchObject({ kind: 'prepare', status: 'succeeded' });
    expect(detailBody.latestOperation).toMatchObject({ kind: 'retain' });

    // workspace.operations.list / .get
    const operations = await get(`/v1/workspace-operations?projectId=${v.projectId}&featureId=${v.featureId}`);
    expect(operations.statusCode).toBe(200);
    const operationsBody = operations.json() as { records: { id: string; kind: string }[] };
    expect([...operationsBody.records.map(record => record.kind)].sort()).toEqual(['prepare', 'retain']);
    const operationId = operationsBody.records[0]!.id;
    const operation = await get(`/v1/workspace-operations/${operationId}?projectId=${v.projectId}`);
    expect(operation.statusCode).toBe(200);
    expect((operation.json() as { operation: { id: string } }).operation.id).toBe(operationId);

    // 命令路由：workspace.discard.preview 经 POST /v1/commands 接线。
    const command = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/commands',
      headers: { ...auth, 'content-type': 'application/json' },
      body: envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId }),
    });
    expect(command.statusCode).toBe(200);
    const commandBody = command.json() as { status: string; result: { previewDigest: string } };
    expect(commandBody.status).toBe('completed');
    expect(commandBody.result.previewDigest).toMatch(/^[0-9a-f]{64}$/);

    // 错误的二次序列化仍须拒绝，不能为测试放宽 Host 信封校验。
    const stringBody = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/commands',
      headers: auth,
      body: JSON.stringify(envelope('workspace.discard.preview', v.projectId, { featureId: v.featureId })),
    });
    expect(stringBody.statusCode).toBe(400);

    // 未认证：401 固定不可区分形状。
    const unauthenticated = await get(`/v1/workspaces?projectId=${v.projectId}`, {});
    expect(unauthenticated.statusCode).toBe(401);
    // 未知查询参数：400 定位 query.<字段>。
    const unknownParam = await get(`/v1/workspaces?projectId=${v.projectId}&bogus=1`);
    expect(unknownParam.statusCode).toBe(400);
    expect((unknownParam.json() as { error: { details: { field?: string; reason?: string } } }).error.details).toMatchObject({
      field: 'query.bogus',
      reason: 'unknown_query_parameter',
    });
    // 重复查询参数：400。
    const duplicate = await get(`/v1/workspaces?projectId=${v.projectId}&projectId=${v.projectId}`);
    expect(duplicate.statusCode).toBe(400);
    // 方法不允许：POST 到查询路由 405。
    const wrongMethod = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: `/v1/workspaces?projectId=${v.projectId}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrongMethod.statusCode).toBe(405);
    // 多段路径未匹配：404。
    const unknownShape = await get(`/v1/workspaces/${v.featureId}/extra?projectId=${v.projectId}`);
    expect(unknownShape.statusCode).toBe(404);
    // 坏游标：400 invalid_cursor。
    const badCursor = await get(`/v1/workspaces?projectId=${v.projectId}&cursor=garbage`);
    expect(badCursor.statusCode).toBe(400);
    // 跨项目折叠：不存在的项目 → 404（不泄漏存在性）。
    const crossProject = await get(`/v1/workspaces/${v.featureId}?projectId=${randomUUID()}`);
    expect(crossProject.statusCode).toBe(404);
  }, 120_000);
});
