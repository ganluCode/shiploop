/**
 * P03-5 / F-011 工作区状态查询（Core 只读面）验收。
 *
 * 依据 docs/p03-5-workspace-host-integration-contract.md §4：
 * - 四查询操作 workspaces.list / workspaces.get / workspace.operations.list /
 *   workspace.operations.get；能力位复用 project.read；跨项目/不存在统一
 *   not_found（不泄漏存在性）；能力缺失先行 forbidden。
 * - 视图含基线（绑定身份/baseCommit）、分支、摘要（HEAD/codeDigest）、状态、
 *   准备 operation 与最新 operation（阶段/原因/实际回执引用）；公开投影绝不
 *   含绝对路径（canonicalPath/gitCommonDir）与内部 repoIdentity。
 * - 列表分页有界（默认 100、上限 500），`wscur_v1_` 游标绑定数据根 + 项目 +
 *   Feature；跨根/跨项目/跨 Feature/畸形游标一律 invalid_cursor。
 * - 权威状态来自 SQLite 一致读与持久回执；查询零写入、零事件、零预算扣减。
 *
 * 真实 SQLite + 真实 Git 准备链路（经 F-005 生产同构装配）；不联网、不调用
 * 模型、不修改开发仓库或用户 HOME。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  scopeAllowlist,
} from './helpers/p02-2/principals.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { git } from './helpers/git-repo.ts';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFeatureWorktreePreparer } from '../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createGitPublicMetadataLock } from '../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteTaskClaimStore } from '../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createWorkspacePreparationService } from '../packages/core/src/application/workspace-preparation.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import {
  WORKSPACE_QUERY_OPERATIONS,
  WORKSPACE_LIST_CURSOR_PREFIX,
  createWorkspaceListCursorBinding,
  decodeWorkspaceListCursor,
  encodeWorkspaceListCursor,
} from '../packages/core/src/ports/workspace-query.ts';
import { PublicError } from '../packages/core/src/ports/commands.ts';

const OWNER = createLocalOwnerPrincipal();

/* ------------------------------------------------------------------ *
 * 夹具：真实认领 + 真实准备（与 F-005 生产同构装配）
 * ------------------------------------------------------------------ */

async function preparedFixture() {
  const f = await openClaimFixture();
  const { session } = f.box;
  const dataRoot = f.box.box.dataRoot;
  const paths = createPathService({
    dataRoot,
    projectLookup: createSqliteStateStore(session),
    featureLookup: createSqliteQueryStore(session),
  });
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [dataRoot], preparationPaths: paths });
  const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
  const store = createSqliteWorkspacePreparationStore(session, {
    resources,
    workspaceAuthority: authority,
    nowUtcMs: () => NOW,
  });
  const publisher = createArtifactPublisher({
    artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => NOW }),
    files: createArtifactFileStore({ dataRoot }),
    limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
  });
  const publishEvidence = async (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => {
    expect(session.database.inTransaction).toBe(false);
    const body = Buffer.from(JSON.stringify(evidence));
    const published = await publisher.publishArtifact({
      projectId,
      kind: 'workspace_evidence',
      mediaType: 'application/json',
      expectedHash: createHash('sha256').update(body).digest('hex'),
      locator: `evidence/${operationId}.json`,
      content: [body],
    });
    return published.artifact.id;
  };
  const confirm = async (identity: { launchId: string }) => {
    await publishEvidence(f.box.projectId, identity.launchId, { schemaVersion: 1, processIdentity: identity });
    return { launchId: identity.launchId };
  };
  const inspector = createWorkspaceInspector({ authorizedRoots: [dataRoot, f.workspace.binding.canonicalPath], confirmProcessIdentity: confirm });
  const preparer = createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: confirm });
  const service = createWorkspacePreparationService({
    store,
    authority,
    resources,
    gitLock: createGitPublicMetadataLock(),
    preparer,
    publishEvidence,
  });
  const token = await authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => NOW })
    .claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = {
    projectId: f.ids.projectId,
    attemptId: claim.attempt.id,
    owner: claim.attempt.owner,
    hostInstanceId: claim.attempt.hostInstanceId,
    executionVersion: claim.attempt.executionVersion,
  };
  const input = {
    identity,
    taskId: f.ids.taskId,
    runId: f.ids.runId,
    claimKey: claim.claimKey,
    operationId: randomUUID(),
    workspaceId: randomUUID(),
  };
  const prepared = await service.prepare(input);
  if (prepared.operation.status !== 'succeeded') {
    const errorRef = prepared.operation.result?.errorRef;
    if (errorRef !== null && errorRef !== undefined) {
      const files = createArtifactFileStore({ dataRoot });
      const placement = files.resolvePlacement({ projectId: f.box.projectId, artifactId: errorRef, locator: `evidence/${input.operationId}.json` });
      console.log('PREPARE ERROR EVIDENCE:', readFileSync(join(dataRoot, placement.finalRelativePath), 'utf8'));
    }
  }
  expect(prepared.operation.status).toBe('succeeded');
  expect(prepared.workspace.status).toBe('ready');
  const queryStore = createSqliteQueryStore(session, { nowUtcMs: () => NOW });
  const queries = createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore: createSqliteStateStore(session),
    configurationService: createConfigurationService({
      stateStore: createSqliteStateStore(session),
      capabilityCatalog: f.box.box.capabilityCatalog,
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    gitOperationReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => NOW,
  });
  return { ...f, dataRoot, paths, authority, resources, service, input, prepared, queries, queryStore };
}

type PreparedFixture = Awaited<ReturnType<typeof preparedFixture>>;

async function expectPublicError(action: () => Promise<unknown>, code: string, reason?: string) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicError);
    const publicError = error as PublicError;
    expect(publicError.code).toBe(code);
    if (reason !== undefined) {
      expect((publicError.details as { reason?: string } | undefined)?.reason).toBe(reason);
    }
    return publicError;
  }
  throw new Error(`应当以 ${code} 拒绝，实际成功返回`);
}

/* ------------------------------------------------------------------ *
 * workspaces.get：按 Feature 读取工作区详情
 * ------------------------------------------------------------------ */

describe('F-011 workspaces.get（按 Feature 的详情视图）', () => {
  it('返回基线/分支/摘要/状态与准备+最新 operation（阶段、回执引用），不含绝对路径与内部哈希', async () => {
    const f = await preparedFixture();
    try {
      const detail = await f.queries.getWorkspace(OWNER, {
        projectId: f.ids.projectId,
        featureId: f.box.featureId,
      });
      const workspace = detail.workspace;
      expect(workspace.id).toBe(f.prepared.workspace.id);
      expect(workspace.projectId).toBe(f.ids.projectId);
      expect(workspace.featureId).toBe(f.box.featureId);
      expect(workspace.status).toBe('ready');
      expect(workspace.branch).toMatch(/^shiploop\/feature\/[0-9a-f]{64}$/);
      expect(workspace.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(workspace.headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(workspace.codeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(workspace.repositoryBindingId).toBe(f.workspace.binding.id);
      expect(workspace.repositoryBindingRevision).toBe(f.workspace.binding.bindingRevision);
      expect(workspace.preparationOperationId).toBe(f.input.operationId);
      expect(workspace.runId).toBe(f.ids.runId);
      expect(workspace.attemptId).toBe(f.input.identity.attemptId);
      expect(workspace.revision).toBeGreaterThanOrEqual(2);
      // 脱敏边界：绝不暴露绝对路径/内部仓库身份哈希。
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(f.dataRoot);
      expect(serialized).not.toContain(f.box.box.repoDirA);
      expect(serialized).not.toContain('canonicalPath');
      expect(serialized).not.toContain('gitCommonDir');
      expect(serialized).not.toContain('repoIdentity');
      // 准备 operation：成功、preflight 阶段、实际回执引用（commandId + resultRef）。
      const preparation = detail.preparationOperation;
      expect(preparation).not.toBeNull();
      expect(preparation!.id).toBe(f.input.operationId);
      expect(preparation!.kind).toBe('prepare');
      expect(preparation!.status).toBe('succeeded');
      expect(preparation!.executionStage).toBe('preflight');
      expect(preparation!.receipt).toMatchObject({
        commandId: f.input.operationId,
        status: 'completed',
        reason: null,
      });
      expect(preparation!.receipt!.resultRef).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(preparation!.result!.evidenceRefs.length).toBeGreaterThanOrEqual(1);
      expect(preparation!.result!.exitCode).toBe(0);
      // 最新 operation = 准备 operation（此后无其他 operation）。
      expect(detail.latestOperation!.id).toBe(preparation!.id);
    } finally {
      f.box.close();
    }
  }, 60_000);

  it('不存在/跨项目/不可见统一 not_found（逐字段一致，不泄漏存在性）；能力缺失 forbidden；非法 ID invalid_input', async () => {
    const f = await preparedFixture();
    try {
      const other = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: scopeAllowlist([randomUUID()]) });
      // 能力缺失（无 project.read）先行 forbidden。
      const noCapability = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: scopeAllowlist([randomUUID()]) });
      await expectPublicError(
        () => f.queries.getWorkspace(noCapability, { projectId: f.ids.projectId, featureId: f.box.featureId }),
        'forbidden',
      );
      // 不存在 Feature。
      await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: f.ids.projectId, featureId: randomUUID() }),
        'not_found',
      );
      // 不存在项目（全可见主体）：与「实体不存在」同一 not_found 形状。
      await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: randomUUID(), featureId: f.box.featureId }),
        'not_found',
      );
      // 跨项目：projectId 不属于该 Feature（真实次项目）。
      const registered = await f.box.submit('project.register', {
        repositoryPath: f.box.box.repoDirB,
        displayName: 'B',
        description: null,
        labels: [],
      }, { scope: { kind: 'registration' } });
      const projectB = (registered as { result: { project: { id: string } } }).result.project.id;
      const faceA = await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: projectB, featureId: f.box.featureId }),
        'not_found',
      );
      // 不存在 Feature 与跨项目同一 not_found 形状（不区分存在性）。
      const faceB = await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: f.ids.projectId, featureId: randomUUID() }),
        'not_found',
      );
      expect(faceA.toErrorShape()).toEqual(faceB.toErrorShape());
      // 项目可见性失败：与「项目不存在」同一 forbidden 形状（既有 P01 纪律）。
      await expectPublicError(
        () => f.queries.getWorkspace(other, { projectId: f.ids.projectId, featureId: f.box.featureId }),
        'forbidden',
      );
      // 非法 ID 形态。
      await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: 'bad id', featureId: f.box.featureId }),
        'invalid_input',
      );
      // 未知键拒绝。
      await expectPublicError(
        () => f.queries.getWorkspace(OWNER, { projectId: f.ids.projectId, featureId: f.box.featureId, extra: 1 }),
        'invalid_input',
      );
    } finally {
      f.box.close();
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * workspaces.list / workspace.operations.*：分页、游标、只读
 * ------------------------------------------------------------------ */

describe('F-011 工作区列表与 operation 查询（分页/游标/只读）', () => {
  it('list 分页有界且游标可续读；operations.get 返回实际回执引用与结果；查询零写入', async () => {
    const f = await preparedFixture();
    try {
      const before = f.box.session.database
        .prepare('SELECT COUNT(*) AS n FROM state_events')
        .get() as { n: number };
      const list = await f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId });
      expect(list.schemaVersion).toBe(5);
      expect(list.scope).toBe('workspace-list');
      expect(list.records).toHaveLength(1);
      expect(list.records[0]!.id).toBe(f.prepared.workspace.id);
      expect(list.nextCursor).toBeNull();
      expect(list.limit).toBe(100);
      // limit 边界与续读：limit=1 单页取尽，nextCursor 为 null。
      const page = await f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, limit: 1 });
      expect(page.records).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
      // operations 列表：准备 operation + 进程/停止检查点不进入 operation 列表。
      const operations = await f.queries.listWorkspaceOperations(OWNER, {
        projectId: f.ids.projectId,
        featureId: f.box.featureId,
      });
      expect(operations.scope).toBe('workspace-operation-list');
      expect(operations.records).toHaveLength(1);
      expect(operations.records[0]).toMatchObject({
        id: f.input.operationId,
        kind: 'prepare',
        status: 'succeeded',
      });
      // operation 详情。
      const detail = await f.queries.getWorkspaceOperation(OWNER, {
        projectId: f.ids.projectId,
        operationId: f.input.operationId,
      });
      expect(detail.operation.id).toBe(f.input.operationId);
      expect(detail.operation.receipt!.commandId).toBe(f.input.operationId);
      expect(detail.operation.receipt!.reason).toBeNull();
      // 查询零写入：事件计数不变。
      const after = f.box.session.database
        .prepare('SELECT COUNT(*) AS n FROM state_events')
        .get() as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      f.box.close();
    }
  }, 60_000);

  it('坏游标/跨项目/跨 Feature 游标一律 invalid_cursor；limit 越界 invalid_input', async () => {
    const f = await preparedFixture();
    try {
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, cursor: 'garbage' }),
        'invalid_input',
        'invalid_cursor',
      );
      // 合法游标但绑定到另一个 Feature：拒绝。
      const foreign = encodeWorkspaceListCursor(
        f.prepared.workspace.id,
        createWorkspaceListCursorBinding({
          rootIdentity: computeDataRootIdentity(f.dataRoot),
          scope: { kind: 'workspaces', projectId: f.ids.projectId, featureId: randomUUID() },
        }),
      );
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, cursor: foreign }),
        'invalid_input',
        'invalid_cursor',
      );
      // 合法游标但绑定到另一个数据根：拒绝。
      const otherRoot = encodeWorkspaceListCursor(
        f.prepared.workspace.id,
        createWorkspaceListCursorBinding({
          rootIdentity: 'ab'.repeat(32),
          scope: { kind: 'workspaces', projectId: f.ids.projectId, featureId: null },
        }),
      );
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, cursor: otherRoot }),
        'invalid_input',
        'invalid_cursor',
      );
      // operations 列表游标与 workspaces 列表游标不通用（kind 绑定）。
      const wrongKind = encodeWorkspaceListCursor(
        f.input.operationId,
        createWorkspaceListCursorBinding({
          rootIdentity: computeDataRootIdentity(f.dataRoot),
          scope: { kind: 'workspace-operations', projectId: f.ids.projectId, featureId: f.box.featureId },
        }),
      );
      expect(wrongKind.startsWith(WORKSPACE_LIST_CURSOR_PREFIX)).toBe(true);
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, cursor: wrongKind }),
        'invalid_input',
        'invalid_cursor',
      );
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, limit: 0 }),
        'invalid_input',
      );
      await expectPublicError(
        () => f.queries.listWorkspaces(OWNER, { projectId: f.ids.projectId, limit: 501 }),
        'invalid_input',
      );
      // operations.get：不存在/跨项目折叠 not_found。
      await expectPublicError(
        () => f.queries.getWorkspaceOperation(OWNER, { projectId: f.ids.projectId, operationId: randomUUID() }),
        'not_found',
      );
    } finally {
      f.box.close();
    }
  }, 60_000);

  it('游标往返：encode/decode 同一绑定成立；公开面操作清单冻结四项', () => {
    const binding = createWorkspaceListCursorBinding({
      rootIdentity: 'cd'.repeat(32),
      scope: { kind: 'workspace-operations', projectId: 'p-1', featureId: 'f-1' },
    });
    const cursor = encodeWorkspaceListCursor('op-1', binding);
    expect(decodeWorkspaceListCursor(cursor, binding).lastId).toBe('op-1');
    expect([...WORKSPACE_QUERY_OPERATIONS]).toEqual([
      'workspaces.list',
      'workspaces.get',
      'workspace.operations.list',
      'workspace.operations.get',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * authority：登记绑定源仓库自身即授权根（生产装配前提）
 * ------------------------------------------------------------------ */

describe('F-011 工作区 authority 生产装配边界', () => {
  it('绑定记录自身规范路径视为已授权源（realpath 复核身份）；数据根外的其他路径仍拒绝', async () => {
    const f = await openClaimFixture();
    try {
      const dataRoot = f.box.box.dataRoot;
      const paths = createPathService({
        dataRoot,
        projectLookup: createSqliteStateStore(f.box.session),
        featureLookup: createSqliteQueryStore(f.box.session),
      });
      // 生产形态：authorizedRoots 只含数据根；源仓库在数据根之外。
      const authority = createWorkWorkspaceAuthority({ authorizedRoots: [dataRoot], preparationPaths: paths });
      expect(f.box.box.repoDirA.startsWith(dataRoot)).toBe(false);
      const token = await authority.verifyPreparation(f.workspace.binding, f.box.featureId);
      expect(token.canonicalPath).toContain(join('projects', f.ids.projectId, 'worktrees'));
      // 直接 verify 源仓库绑定路径：realpath 一致 + 身份复核通过。
      const source = await authority.verify(f.workspace.binding, f.workspace.binding.canonicalPath);
      expect(source.canonicalPath).toBe(f.workspace.binding.canonicalPath);
      // 数据根外的其他路径（非绑定自身）仍拒绝。
      await expect(authority.verify(f.workspace.binding, f.box.box.repoDirB)).rejects.toThrow();
    } finally {
      f.box.close();
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 准备链路真实性：worktree 真实落盘、源仓库不变（生产同构装配冒烟）
 * ------------------------------------------------------------------ */

describe('F-011 查询面数据源真实性', () => {
  it('准备创建真实 worktree 且源仓库 HEAD/refs/内容不变；查询读取的是持久事实', async () => {
    const f = await preparedFixture();
    try {
      const worktreePath = join(f.dataRoot, 'projects', f.ids.projectId, 'worktrees', f.box.featureId);
      expect(existsSync(worktreePath)).toBe(true);
      expect(git(['rev-parse', 'HEAD'], worktreePath).trim()).toBe(f.prepared.workspace.headCommit);
      // 源仓库不受影响。
      expect(git(['status', '--porcelain'], f.box.box.repoDirA).trim()).toBe('');
      // 在 worktree 写入未跟踪内容后，查询报告的是准备时记录的摘要（不重新扫描）。
      writeFileSync(join(worktreePath, 'later.txt'), 'post-preparation');
      const detail = await f.queries.getWorkspace(OWNER, {
        projectId: f.ids.projectId,
        featureId: f.box.featureId,
      });
      expect(detail.workspace.codeDigest).toBe(f.prepared.workspace.codeDigest);
      expect(readFileSync(join(worktreePath, 'later.txt'), 'utf8')).toBe('post-preparation');
    } finally {
      f.box.close();
    }
  }, 60_000);
});
