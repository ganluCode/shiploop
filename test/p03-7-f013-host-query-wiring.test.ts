/**
 * P03-7 / F-013：Host 查询接线（新增操作/能力白名单与公共 Schema 与实际应用
 * 服务一致；经既有 HostClient 取得 Task 机器证据、人审事项与有限返工链）。
 *
 * 验收面（.dag_context.json F-013）：
 * 1. Host 新增操作/能力白名单及公共 Schema 与实际应用服务一致，不创建第二个
 *    Host、不让客户端直接读取 SQLite；
 * 2. 用既有查询夹具验证返回内容与真实持久状态相符；机器 passed 不展示为有效
 *    Task passed；
 * 3. 稳定错误协议：未认证/未知路由/形态不符请求不泄漏内容；线协议冻结字段集
 *    拒绝漂移（effectivePassed 折算、记账不一致等）。
 */
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
import { TASK_EVIDENCE_QUERY_OPERATIONS } from '../packages/core/src/protocol.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openBindingFixture,
  BINDING_NOW,
  type BindingFixture,
} from './helpers/p03-6/input-binding-fixture.ts';
import type { ClaimedAttempt } from './helpers/p03-6/input-binding-fixture.ts';
import { loopbackRequest } from './helpers/host/index.ts';

const CODE_DIGEST = 'cd'.repeat(32);
const POLICY_DIGEST = 'ef'.repeat(32);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;
let claimIdentity:
  | {
      readonly projectId: string;
      readonly attemptId: string;
      readonly owner: string;
      readonly hostInstanceId: string;
      readonly executionVersion: number;
    }
  | undefined;

async function teardown(): Promise<void> {
  client?.close();
  client = undefined;
  // 夹具认领但从未启动的 Attempt 仍持有工作区占用（视为活跃）；经既有受信
  // releaseUnstarted 路径归还后再关闭 Host，使静默确认而非掩盖未收尾占用。
  if (fixture !== undefined && claimIdentity !== undefined) {
    const resources = fixture.createResources();
    fixture.session.transactWrite('release-unstarted-claim', () =>
      resources.releaseUnstartedInTransaction(claimIdentity),
    );
    claimIdentity = undefined;
  }
  if (host) {
    await host.close();
    host = undefined;
  }
  fixture?.close();
  fixture = undefined;
}

afterEach(async () => {
  await teardown();
});

/** 认领 t-1 并播种机器证据（passed 批次 + 输出 Artifact/tail）与待决人审事项。 */
async function seedEvidence(): Promise<{ attempt: ClaimedAttempt['receipt']['attempt']; batchId: string }> {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  fixture = f;
  const claim = f.claimTask('t-1');
  const attempt = claim.receipt.attempt;
  claimIdentity = {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
  const verification = createSqliteVerificationStore(f.session, { nowUtcMs: () => BINDING_NOW });
  const batchId = `batch-${attempt.id}`;
  verification.createVerificationBatch({
    batchId,
    projectId: f.projectId,
    featureId: f.featureId,
    runId: f.runId,
    taskId: 't-1',
    attemptId: attempt.id,
    executionVersion: attempt.executionVersion,
    operation: 'task.checks',
    codeDigest: CODE_DIGEST,
    policyDigest: POLICY_DIGEST,
    environmentSummary: { runner: 'node' },
    checkSnapshot: [
      {
        checkKey: 'unit',
        scope: 'task',
        kind: 'command',
        argv: ['node', '--test'],
        cwdRef: 'workspace-root',
        environmentRef: null,
        timeout: 60_000,
        required: true,
        requirementRefs: [],
      },
    ],
    selection: {
      schemaVersion: 1,
      mode: 'full_fallback',
      reason: 'shared_high_risk_config_changed',
      selectedCheckKeys: ['unit'],
    },
    startedAtUtcMs: BINDING_NOW,
  });
  verification.saveCheckResult({
    resultId: `result-${attempt.id}`,
    projectId: f.projectId,
    batchId,
    checkKey: 'unit',
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputArtifactId: attempt.inputRef,
    outputTail: 'ok 1 test',
    startedAtUtcMs: BINDING_NOW,
    endedAtUtcMs: BINDING_NOW + 10,
  });
  verification.finalizeVerificationBatch({
    projectId: f.projectId,
    batchId,
    expectedRevision: 1,
    status: 'passed',
    endedAtUtcMs: BINDING_NOW + 10,
  });
  const plan = createSqlitePlanAccess(f.session, { nowUtcMs: () => BINDING_NOW });
  const planDigest = (
    f.query('SELECT plan_digest AS p FROM features WHERE id = ?', f.featureId) as { p: string }
  ).p;
  f.session.transactWrite('seed-approval', () =>
    plan.insertTaskApprovalItemInTransaction({
      projectId: f.projectId,
      featureId: f.featureId,
      taskId: 't-1',
      kind: 'approval',
      description: '确认检查定义',
      responsibleParty: 'release-manager',
      planDigest,
      codeDigest: CODE_DIGEST,
      artifactRefs: [],
      createdBy: 'owner-1',
    }),
  );
  return { attempt, batchId };
}

describe('F-013 Host 路由与白名单接线', () => {
  it('Task 证据/人审/返工链子资源路由冻结，其他嵌套形态未匹配', () => {
    expect(resolveAppRoute('/v1/tasks/t-1/verification')).toEqual({
      operation: 'execution.task.verification.get',
      method: 'GET',
      pathParam: { name: 'taskId', value: 't-1' },
    });
    expect(resolveAppRoute('/v1/tasks/t-1/approvals')).toEqual({
      operation: 'execution.task.approvals.list',
      method: 'GET',
      pathParam: { name: 'taskId', value: 't-1' },
    });
    expect(resolveAppRoute('/v1/tasks/t-1/rework-chain')).toEqual({
      operation: 'execution.task.rework-chain.list',
      method: 'GET',
      pathParam: { name: 'taskId', value: 't-1' },
    });
    /* 既有 tasks.get 不受影响；未知/多段形态一律未匹配。 */
    expect(resolveAppRoute('/v1/tasks/t-1')).toMatchObject({ operation: 'tasks.get' });
    expect(resolveAppRoute('/v1/tasks/t-1/unknown')).toBeUndefined();
    expect(resolveAppRoute('/v1/tasks/t-1/verification/extra')).toBeUndefined();
    expect(resolveAppRoute('/v1/tasks//verification')).toBeUndefined();
  });

  it('新增操作/能力白名单与 Core 操作身份同步，不漂移', () => {
    for (const operation of TASK_EVIDENCE_QUERY_OPERATIONS) {
      expect(APP_OPERATIONS).toContain(operation);
      expect(APPLICATION_QUERY_CAPABILITIES).toContain(operation);
    }
    /* 白名单无重复；能力宣告与错误白名单查询面一致（含既有操作）。 */
    expect(new Set(APP_OPERATIONS).size).toBe(APP_OPERATIONS.length);
    for (const operation of APPLICATION_QUERY_CAPABILITIES) {
      expect(APP_OPERATIONS).toContain(operation);
    }
  });
});

describe('F-013 HostClient 查询接线（真实 Host 纵向）', () => {
  it('经既有 HostClient 取得机器证据/人审事项/返工链，内容与真实持久状态相符', async () => {
    const { attempt, batchId } = await seedEvidence();
    const f = fixture!;
    host = await startHost({
      dataRoot: f.box.dataRoot,
      capabilityCatalog: f.box.capabilityCatalog,
      env: {},
    });
    client = await connectToHost({ canonicalRoot: f.box.dataRoot });

    /* Task 机器证据：机器 passed 不展示为有效 Task passed。 */
    const verification = await client.getTaskVerification(f.projectId, 't-1');
    expect(verification.machine).toMatchObject({
      status: 'passed',
      reason: 'checks_passed',
      batchId,
      attemptId: attempt.id,
      codeDigest: CODE_DIGEST,
      policyDigest: POLICY_DIGEST,
    });
    expect(verification.task.status).toBe(
      (f.query('SELECT status AS s FROM tasks WHERE id = ?', 't-1') as { s: string }).s,
    );
    expect(verification.task.effectivePassed).toBe(false);
    expect(verification.batches[0]!.selection).toEqual({
      mode: 'full_fallback',
      reason: 'shared_high_risk_config_changed',
      selectedCheckKeys: ['unit'],
    });
    expect(verification.batches[0]!.checks[0]).toMatchObject({
      outputArtifactId: attempt.inputRef,
      outputTail: 'ok 1 test',
      status: 'passed',
    });

    /* 独立人审事项：责任主体、绑定摘要与决定。 */
    const approvals = await client.listTaskApprovalItems(f.projectId, 't-1');
    expect(approvals.records).toHaveLength(1);
    expect(approvals.records[0]).toMatchObject({
      kind: 'approval',
      responsibleParty: 'release-manager',
      status: 'pending',
      decision: null,
      codeDigest: CODE_DIGEST,
    });

    /* 有限返工链：历次 Attempt + 汇总（与持久状态相符）。 */
    const chain = await client.listTaskReworkChain(f.projectId, 't-1');
    expect(chain.records.map((record) => record.id)).toEqual([attempt.id]);
    expect(chain.records[0]).toMatchObject({ status: 'preparing', errorKind: null });
    expect(chain.summary.codeEligibility).toEqual({ used: 1, limit: 3, remaining: 2, rule: 'code_cap_default' });
    expect(
      f.query('SELECT code_attempts_used AS used FROM tasks WHERE id = ?', 't-1'),
    ).toEqual({ used: 1 });

    /* 公共 Schema 漂移拒绝：机器 passed 折算有效 Task passed、记账不一致均 response_malformed。 */
    const wire = JSON.parse(JSON.stringify(verification)) as Record<string, unknown>;
    const tamperedEffective = JSON.parse(JSON.stringify(wire)) as {
      task: { effectivePassed: boolean };
    };
    tamperedEffective.task.effectivePassed = true;
    expectWireMalformed('execution.task.verification.get', tamperedEffective);
    const chainWire = JSON.parse(JSON.stringify(chain)) as {
      records: { codeAccounting: { countsAsCodeAttempt: boolean } }[];
    };
    chainWire.records[0]!.codeAccounting.countsAsCodeAttempt = false;
    expectWireMalformed('execution.task.rework-chain.list', chainWire);
    /* 未知键拒绝（冻结字段集）。 */
    const extraKey = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    extraKey['leak'] = '/absolute/path';
    expectWireMalformed('execution.task.verification.get', extraKey);

    /* 稳定错误协议：未认证请求统一 401；跨项目目标 not_found（不泄漏内容）。 */
    const unauthenticated = await loopbackRequest({
      port: host.port,
      method: 'GET',
      path: '/v1/tasks/t-1/verification?projectId=' + encodeURIComponent(f.projectId),
    });
    expect(unauthenticated.statusCode).toBe(401);
    await expect(
      client.getTaskVerification('p-other', 't-1'),
    ).rejects.toMatchObject({ code: 'not_found' });

    await teardown();
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
