/**
 * P03-8 / F-009：受授权的 Git 意图、实际提交与操作回执查询（真实 SQLite +
 * 真实 Host 纵向，非 mock）。
 *
 * 验收面（.dag_context.json F-009）：
 * 1. 可按同项目 Feature/Run 和 operation 查询提交边界、预期 HEAD/tree、实际
 *    parent/commit/tree、用户身份来源、验证/审批引用、no_change、失败或待核对
 *    原因及证据引用；不把待核对结果展示为成功；
 * 2. 复用 Core 查询、Host 查询路由及 HostClient 模板，列表有界分页与稳定
 *    排序；跨项目读取、无权限主体、非法游标或超限请求按现有错误契约拒绝；
 * 3. 公开输出不含真实凭据、敏感环境值、开发机固定路径或原始堆栈；重复读取
 *    无状态变更，真实 SQLite 重开后查询得到相同意图与 Git 事实；正常记录、
 *    no_change、回执缺失及核对后记录均有查询断言。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  startHost,
  validateAppQueryResponse,
  resolveAppRoute,
  isHostProtocolError,
  type HostClient,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { APP_OPERATIONS } from '../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../packages/host/src/contract/lifecycle.ts';
import { GIT_OPERATION_QUERY_OPERATIONS } from '../packages/core/src/protocol.ts';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteGitOperationStore } from '../packages/core/src/adapters/sqlite/git-operations.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { openBudgetFixture, NOW, type BudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
} from './helpers/p02-2/principals.ts';
import { loopbackRequest } from './helpers/host/index.ts';

const HASH = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const CANDIDATE_TREE = 'b'.repeat(40);
const ACTUAL_COMMIT = 'c'.repeat(40);
const owner = createLocalOwnerPrincipal();

const fixtures: BudgetFixture[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
function assembleQueries(session: SqliteStorageSession, dataRoot: string): QueryService {
  const queryStore = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
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
}

interface SeededGitOperations {
  readonly fixture: BudgetFixture;
  readonly runId: string;
  readonly head: string;
  readonly worktreePath: string;
}

/**
 * 播种五条真实操作：succeeded / no_change / failed / unknown（核对后记录）/
 * pending（回执缺失）。注意既有 superseded_operation 约束：同 Feature 必须
 * 「注册 → 收尾」逐条交错，不能先注册全部再收尾旧记录。
 */
async function seedGitOperations(): Promise<SeededGitOperations> {
  const fixture = await openBudgetFixture();
  fixtures.push(fixture);
  const ids = await fixture.start();
  const db = fixture.session.database;
  const feature = db
    .prepare('SELECT revision FROM features WHERE project_id = ? AND id = ?')
    .get(fixture.projectId, fixture.featureId) as { revision: number };
  const binding = db
    .prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
    .get(fixture.projectId) as { id: string; repo_identity: string };
  const head = fixture.box.gitHead('A');
  const store = createSqliteGitOperationStore(fixture.session, { nowUtcMs: () => NOW });

  const intent = (operationId: string) => ({
    operationId,
    projectId: fixture.projectId,
    featureId: fixture.featureId,
    runId: ids.runId,
    attemptId: null,
    executionVersion: 1,
    operationType: 'feature_final_commit',
    repositoryBindingId: binding.id,
    repoIdentity: binding.repo_identity,
    worktreePath: fixture.box.repoDirA,
    expectedHead: head,
    candidateTree: CANDIDATE_TREE,
    codeDigest: HASH,
    verificationRefs: [{ kind: 'verification_batch', id: 'vbatch-1', digest: HASH }],
    approvalRefs: [{ kind: 'human_approval', id: 'approval-1', digest: HASH_B }],
    message: 'P03-8 F-009 controlled commit',
    gitIdentity: { name: 'Test User', email: 'test@example.com', confirmed: true },
    deliveryPolicyDigest: HASH_B,
    runtimeSource: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      source: { kind: 'global_default', sourceKey: 'strategies.defaultStrategy' },
    },
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    expectedFeatureRevision: feature.revision,
  });
  const finalize = (operationId: string, overrides: Record<string, unknown>) =>
    store.finalizeGitOperation({
      operationId,
      projectId: fixture.projectId,
      expectedRevision: 1,
      settledAtUtcMs: NOW + 1_000,
      ...overrides,
    });

  store.registerGitOperation(intent('op-0001'));
  finalize('op-0001', {
    status: 'succeeded',
    actualCommit: ACTUAL_COMMIT,
    actualTree: CANDIDATE_TREE,
    exitCode: 0,
    durationMs: 250,
    reasonCode: null,
    deliveryStatus: 'succeeded',
  });
  store.registerGitOperation(intent('op-0002'));
  finalize('op-0002', {
    status: 'no_change',
    actualCommit: head,
    actualTree: 'a'.repeat(40),
    exitCode: null,
    durationMs: null,
    reasonCode: null,
    deliveryStatus: 'succeeded',
  });
  store.registerGitOperation(intent('op-0003'));
  finalize('op-0003', {
    status: 'failed',
    actualCommit: 'd'.repeat(40),
    actualTree: 'e'.repeat(40),
    exitCode: 1,
    durationMs: 180,
    reasonCode: 'hook_failed',
    deliveryStatus: 'failed',
  });
  store.registerGitOperation(intent('op-0004'));
  finalize('op-0004', {
    status: 'unknown',
    actualCommit: null,
    actualTree: null,
    exitCode: null,
    durationMs: null,
    reasonCode: 'receipt_lost',
    deliveryStatus: 'pending',
  });
  store.registerGitOperation(intent('op-0005'));

  // 第二个项目/Feature（真实行）用于跨项目存在性折叠断言。
  db.prepare(
    `INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels)
     VALUES (?, ?, 1, ?, 'Project B', 'active', NULL, '[]')`,
  ).run(randomUUID(), NOW, NOW);
  const projectB = db.prepare('SELECT id FROM projects WHERE display_name = ?').get('Project B') as { id: string };
  db.prepare(
    `INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels)
     VALUES ('phase-b', ?, ?, 1, ?, 'Phase B', 'open', NULL, '[]')`,
  ).run(NOW, projectB.id, NOW);
  db.prepare(
    `INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status,
       plan_status, description, labels, source_refs, plan_digest)
     VALUES ('feature-b', ?, ?, 1, ?, 'phase-b', 'Feature B', 'draft', 'draft', NULL, '[]', '[]', NULL)`,
  ).run(NOW, projectB.id, NOW);

  return { fixture, runId: ids.runId, head, worktreePath: fixture.box.repoDirA };
}

function maxEventSequence(db: BudgetFixture['session']['database']): number {
  return (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM state_events').get() as { s: number }).s;
}

describe('F-009 Git 操作查询（Core 授权与持久事实）', () => {
  it('正常/no_change/failed/unknown/pending 记录的查询内容与真实持久状态逐字段相符，待核对不显示为成功', async () => {
    const { fixture, runId, head } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);

    const detail = await queries.getGitOperation(owner, {
      projectId: fixture.projectId,
      operationId: 'op-0001',
    });
    expect(detail.operation).toMatchObject({
      operationId: 'op-0001',
      projectId: fixture.projectId,
      featureId: fixture.featureId,
      runId,
      attemptId: null,
      executionVersion: 1,
      operationType: 'feature_final_commit',
      expectedHead: head,
      candidateTree: CANDIDATE_TREE,
      codeDigest: HASH,
      actualCommit: ACTUAL_COMMIT,
      actualTree: CANDIDATE_TREE,
      // succeeded：执行/核对已验证唯一 parent 等于固定的预期 HEAD。
      actualParent: head,
      status: 'succeeded',
      exitCode: 0,
      durationMs: 250,
      reasonCode: null,
      deliveryStatus: 'succeeded',
      message: 'P03-8 F-009 controlled commit',
      gitIdentity: { name: 'Test User', email: 'test@example.com', confirmed: true },
      deliveryPolicyDigest: HASH_B,
      runtimeSource: {
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
        source: { kind: 'global_default', sourceKey: 'strategies.defaultStrategy' },
      },
      verificationRefs: [{ kind: 'verification_batch', id: 'vbatch-1', digest: HASH }],
      approvalRefs: [{ kind: 'human_approval', id: 'approval-1', digest: HASH_B }],
    });
    expect(detail.operation.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.operation.receipt).toMatchObject({
      schemaVersion: 1,
      operationId: 'op-0001',
      status: 'succeeded',
      intentDigest: detail.operation.intentDigest,
      actualCommit: ACTUAL_COMMIT,
      actualTree: CANDIDATE_TREE,
      deliveryStatus: 'succeeded',
    });

    const list = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(list.scope).toBe('git-operation-list');
    expect(list.records.map(record => record.operationId)).toEqual([
      'op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005',
    ]);
    const byId = new Map(list.records.map(record => [record.operationId, record]));

    // no_change：实际 HEAD 不变（actualCommit = expectedHead），无新提交 parent。
    expect(byId.get('op-0002')).toMatchObject({
      status: 'no_change',
      actualCommit: head,
      actualParent: null,
      exitCode: null,
      durationMs: null,
      deliveryStatus: 'succeeded',
    });
    // failed：保留实际 Git 事实与失败原因，deliveryStatus 为 failed。
    expect(byId.get('op-0003')).toMatchObject({
      status: 'failed',
      actualCommit: 'd'.repeat(40),
      actualTree: 'e'.repeat(40),
      actualParent: null,
      exitCode: 1,
      reasonCode: 'hook_failed',
      deliveryStatus: 'failed',
    });
    // unknown（核对后记录）：待核对，不显示成功；actual 事实为 null。
    const unknown = byId.get('op-0004')!;
    expect(unknown).toMatchObject({
      status: 'unknown',
      actualCommit: null,
      actualTree: null,
      actualParent: null,
      reasonCode: 'receipt_lost',
      deliveryStatus: 'pending',
    });
    expect(unknown.status).not.toBe('succeeded');
    expect(unknown.deliveryStatus).not.toBe('succeeded');
    expect(unknown.receipt).toMatchObject({ status: 'unknown', deliveryStatus: 'pending' });
    // pending（回执缺失）：无回执/无终态事实，不显示成功。
    const pending = byId.get('op-0005')!;
    expect(pending).toMatchObject({
      status: 'pending',
      actualCommit: null,
      actualTree: null,
      actualParent: null,
      receipt: null,
      deliveryStatus: null,
      settledAt: null,
    });
    expect(pending.status).not.toBe('succeeded');
  });

  it('公开输出不含 worktree 路径、执行归属或凭据材料', async () => {
    const { fixture, worktreePath } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const list = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    const detail = await queries.getGitOperation(owner, {
      projectId: fixture.projectId,
      operationId: 'op-0001',
    });
    for (const payload of [JSON.stringify(list), JSON.stringify(detail)]) {
      expect(payload).not.toContain(worktreePath);
      expect(payload).not.toContain('owner-1');
      expect(payload).not.toContain('host-1');
      expect(payload).not.toContain(fixture.box.dataRoot);
      expect(payload).not.toContain('worktreePath');
    }
  });

  it('按 Run 查询与有界分页、稳定排序与受控游标（跨父级重放拒绝）', async () => {
    const { fixture, runId } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);

    const page1 = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      runId,
      limit: 2,
    });
    expect(page1.records.map(record => record.operationId)).toEqual(['op-0001', 'op-0002']);
    expect(page1.limit).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      runId,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.records.map(record => record.operationId)).toEqual(['op-0003', 'op-0004']);
    const page3 = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      runId,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.records.map(record => record.operationId)).toEqual(['op-0005']);
    expect(page3.nextCursor).toBeNull();

    // Feature 父级游标在 Run 父级重放 → invalid_cursor（绝不当从零读取）。
    const featurePage = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
      limit: 2,
    });
    await expect(
      queries.listGitOperations(owner, {
        projectId: fixture.projectId,
        runId,
        limit: 2,
        cursor: featurePage.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    // 篡改/异形态游标同样拒绝。
    for (const cursor of ['plcur_v1_!!!!', 'not-a-cursor', 'plcur_v1_']) {
      await expect(
        queries.listGitOperations(owner, {
          projectId: fixture.projectId,
          runId,
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    // 超限/非法分页参数按现有错误契约拒绝。
    for (const limit of [0, 201, 1.5, '3']) {
      await expect(
        queries.listGitOperations(owner, {
          projectId: fixture.projectId,
          runId,
          limit: limit as unknown as number,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('跨项目读取与无权限主体按现有错误契约拒绝，不泄漏存在性', async () => {
    const { fixture, runId } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);

    // 无 project.read 能力 → forbidden（能力核验先于任何读取）。
    const noCapability = createRestrictedPrincipal({
      capabilities: ['events.read'],
      projectScope: { kind: 'all' },
    });
    await expect(
      queries.listGitOperations(noCapability, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      queries.getGitOperation(noCapability, {
        projectId: fixture.projectId,
        operationId: 'op-0001',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 可见范围不含目标项目 → forbidden（与不存在不可区分由边界决定）。
    const hidden = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'allowlist', projectIds: [randomUUID()] },
    });
    await expect(
      queries.listGitOperations(hidden, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 跨项目 Feature/Run/operation 与不存在目标统一 not_found（同一形状）。
    await expect(
      queries.listGitOperations(owner, {
        projectId: fixture.projectId,
        featureId: 'feature-b',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.listGitOperations(owner, { projectId: fixture.projectId, featureId: 'feature-x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.listGitOperations(owner, { projectId: fixture.projectId, runId: 'run-x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.getGitOperation(owner, { projectId: fixture.projectId, operationId: 'op-x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // 真实存在的 operation 以错误项目身份读取 → not_found（不回显归属）。
    const otherProject = randomUUID();
    await expect(
      queries.getGitOperation(owner, { projectId: otherProject, operationId: 'op-0001' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.listGitOperations(owner, { projectId: otherProject, runId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('非法输入在任何读取前拒绝（父级二选一、未知键、非法身份）', async () => {
    const { fixture, runId } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);

    // 父级必须且只能提供一个。
    await expect(
      queries.listGitOperations(owner, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
        runId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      queries.listGitOperations(owner, { projectId: fixture.projectId }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // 未知键（含提权字段）拒绝。
    await expect(
      queries.listGitOperations(owner, {
        projectId: fixture.projectId,
        featureId: fixture.featureId,
        principalId: 'local-owner',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      queries.getGitOperation(owner, {
        projectId: fixture.projectId,
        operationId: 'op-0001',
        includeSecrets: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // 非法稳定身份。
    await expect(
      queries.listGitOperations(owner, { projectId: fixture.projectId, featureId: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      queries.getGitOperation(owner, { projectId: fixture.projectId, operationId: '../etc' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('重复读取无状态变更，真实 SQLite 重开后查询得到相同意图与 Git 事实', async () => {
    const { fixture, runId } = await seedGitOperations();
    const queries = assembleQueries(fixture.session, fixture.box.dataRoot);
    const before = {
      sequence: maxEventSequence(fixture.session.database),
      rows: fixture.session.database
        .prepare('SELECT id, revision, updated_at, status FROM git_operations ORDER BY id')
        .all(),
    };
    const first = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    const second = await queries.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    const detail = await queries.getGitOperation(owner, {
      projectId: fixture.projectId,
      operationId: 'op-0003',
    });
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(maxEventSequence(fixture.session.database)).toBe(before.sequence);
    expect(
      fixture.session.database
        .prepare('SELECT id, revision, updated_at, status FROM git_operations ORDER BY id')
        .all(),
    ).toEqual(before.rows);

    // 真实 SQLite 重开：相同意图与 Git 事实（逐字节 JSON 一致）。
    fixture.reopen();
    const reopened = assembleQueries(fixture.session, fixture.box.dataRoot);
    const relisted = await reopened.listGitOperations(owner, {
      projectId: fixture.projectId,
      featureId: fixture.featureId,
    });
    expect(JSON.parse(JSON.stringify(relisted))).toEqual(JSON.parse(JSON.stringify(first)));
    const reDetail = await reopened.getGitOperation(owner, {
      projectId: fixture.projectId,
      operationId: 'op-0003',
    });
    expect(JSON.parse(JSON.stringify(reDetail))).toEqual(JSON.parse(JSON.stringify(detail)));
    const byRun = await reopened.listGitOperations(owner, {
      projectId: fixture.projectId,
      runId,
    });
    expect(byRun.records.map(record => record.operationId)).toEqual(
      first.records.map(record => record.operationId),
    );
  });
});

describe('F-009 Host 路由与能力白名单接线', () => {
  it('Git 操作查询路由冻结，其他形态未匹配', () => {
    expect(resolveAppRoute('/v1/git-operations')).toEqual({
      operation: 'git.operations.list',
      method: 'GET',
    });
    expect(resolveAppRoute('/v1/git-operations/op-0001')).toEqual({
      operation: 'git.operations.get',
      method: 'GET',
      pathParam: { name: 'operationId', value: 'op-0001' },
    });
    expect(resolveAppRoute('/v1/git-operations/a/b')).toBeUndefined();
    expect(resolveAppRoute('/v1/git-operations/')).toBeUndefined();
  });

  it('新增操作/能力白名单与 Core 操作身份同步，不漂移', () => {
    for (const operation of GIT_OPERATION_QUERY_OPERATIONS) {
      expect(APP_OPERATIONS).toContain(operation);
      expect(APPLICATION_QUERY_CAPABILITIES).toContain(operation);
    }
    expect(new Set(APP_OPERATIONS).size).toBe(APP_OPERATIONS.length);
  });
});

describe('F-009 HostClient 查询接线（真实 Host 纵向）', () => {
  let client: HostClient | undefined;
  afterEach(() => {
    client?.close();
    client = undefined;
  });

  it('经既有 HostClient 查询意图/实际提交/回执，内容与真实持久状态相符且错误协议稳定', async () => {
    const { fixture, runId, head, worktreePath } = await seedGitOperations();
    const host = await startHost({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fixture.box.capabilityCatalog,
      env: {},
    });
    hosts.push(host);
    client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    expect(client.handshake.capabilities.application.queries).toContain('git.operations.list');
    expect(client.handshake.capabilities.application.queries).toContain('git.operations.get');

    const list = await client.listGitOperations(fixture.projectId, { featureId: fixture.featureId });
    expect(list.scope).toBe('git-operation-list');
    expect(list.records.map(record => record.operationId)).toEqual([
      'op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005',
    ]);
    expect(JSON.stringify(list)).not.toContain(worktreePath);
    const succeeded = list.records[0]!;
    expect(succeeded).toMatchObject({
      operationId: 'op-0001',
      expectedHead: head,
      candidateTree: CANDIDATE_TREE,
      actualCommit: ACTUAL_COMMIT,
      actualParent: head,
      status: 'succeeded',
      deliveryStatus: 'succeeded',
    });

    const page1 = await client.listGitOperations(fixture.projectId, { runId }, { limit: 2 });
    expect(page1.records.map(record => record.operationId)).toEqual(['op-0001', 'op-0002']);
    const page2 = await client.listGitOperations(
      fixture.projectId,
      { runId },
      { limit: 2, cursor: page1.nextCursor! },
    );
    expect(page2.records.map(record => record.operationId)).toEqual(['op-0003', 'op-0004']);

    const detail = await client.getGitOperation(fixture.projectId, 'op-0005');
    expect(detail.operation).toMatchObject({
      operationId: 'op-0005',
      status: 'pending',
      receipt: null,
      deliveryStatus: null,
    });

    // 线协议冻结字段集：回执缺失的 pending 携带回执、未知键、unknown 携带
    // actual 事实、succeeded tree 与候选 tree 不符均 response_malformed。
    const wire = JSON.parse(JSON.stringify(list)) as {
      records: Record<string, unknown>[];
    };
    const tamperedPending = JSON.parse(JSON.stringify(wire));
    tamperedPending.records[4]!['receipt'] = { schemaVersion: 1 };
    expectWireMalformed('git.operations.list', tamperedPending);
    const tamperedUnknown = JSON.parse(JSON.stringify(wire));
    tamperedUnknown.records[3]!['actualCommit'] = ACTUAL_COMMIT;
    expectWireMalformed('git.operations.list', tamperedUnknown);
    const tamperedTree = JSON.parse(JSON.stringify(wire));
    tamperedTree.records[0]!['actualTree'] = 'f'.repeat(40);
    expectWireMalformed('git.operations.list', tamperedTree);
    const extraKey = JSON.parse(JSON.stringify(wire));
    extraKey['worktreePath'] = worktreePath;
    expectWireMalformed('git.operations.list', extraKey);
    const detailWire = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
    detailWire['operation'] = { ...(detailWire['operation'] as object), ownerId: 'owner-1' };
    expectWireMalformed('git.operations.get', detailWire);

    // 稳定错误协议：未认证 401；未知查询参数 400；超限 limit 400；跨项目 not_found。
    const token = readFileSync(join(fixture.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const base = `/v1/git-operations?projectId=${encodeURIComponent(fixture.projectId)}` +
      `&featureId=${encodeURIComponent(fixture.featureId)}`;
    expect((await loopbackRequest({ port: host.port, method: 'GET', path: base })).statusCode).toBe(401);
    expect(
      (
        await loopbackRequest({
          port: host.port,
          method: 'GET',
          path: `${base}&bogus=1`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await loopbackRequest({
          port: host.port,
          method: 'GET',
          path: `${base}&limit=201`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(400);
    await expect(
      client.listGitOperations(randomUUID(), { featureId: fixture.featureId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.getGitOperation(fixture.projectId, 'op-x')).rejects.toMatchObject({
      code: 'not_found',
    });
    // 客户端输入校验：父级二选一先于任何请求。
    await expect(
      client.listGitOperations(fixture.projectId, {
        featureId: fixture.featureId,
        runId,
      } as never),
    ).rejects.toSatisfy(
      (error: unknown) => isHostProtocolError(error) && error.code === 'invalid_input',
    );
  }, 60_000);
});

function expectWireMalformed(operation: string, body: unknown): void {
  try {
    validateAppQueryResponse(operation as never, body);
  } catch (error) {
    if (!isHostProtocolError(error)) throw error;
    expect(error.code).toBe('response_malformed');
    return;
  }
  throw new Error(`预期 response_malformed（${operation}），实际通过`);
}
