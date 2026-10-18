/**
 * P03-2 / F-007：计划决策、Task 策略编辑与执行输入准备/查询接入 Host 传输与
 * HostClient（薄接线）。
 *
 * 验收面（真实 startHost + 真实 HostClient + 真实 SQLite，不经内部方法调用）：
 * - feature.plan.decide / task.strategy.update / execution.input.prepare 经既有
 *   POST /v1/commands 由 HostClient 公共方法提交（冻结信封/回执/结果/幂等重放
 *   同一命令面）；completed 回执内嵌结果经客户端线校验器运行时复核；
 * - features.approvals 授权查询经既有查询路由暴露（当前批准 vs 历史决定 +
 *   fail-closed validity）；制品组身份经既有回执/结果读取查询（正文永不内联）；
 * - 应用层授权仍是权威：可信身份由装配固定绑定，请求体身份字段（decisionActor/
 *   principalId 等）一律拒绝；跨项目/未知目标/陈旧 revision/摘要 fail-closed；
 * - 受控制品组读取：不新增任何 path/locator 通用文件接口（表外路径 404）；
 *   输入正文只按 Artifact 身份作有界校验读取，跨项目/未知正文统一 not_found/
 *   forbidden 且不泄漏存在性与物理路径；
 * - 传输沿用认证、Host/Origin、no-store、有限正文/超时与错误脱敏；旧线消息
 *   版本（v4 及更早）在认证后明确 unsupported_schema_version，不猜测降级。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  HostProtocolError,
  isHostProtocolError,
  connectToHost,
  startHost,
  validateAppQueryResponse,
  validateExecutionInputPrepareResultWire,
  validateFeaturePlanDecideResultWire,
  validateTaskStrategyUpdateResultWire,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import type { CommandReceipt } from '../../../packages/core/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function asCompleted(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'completed' }> {
  expect(receipt.status).toBe('completed');
  if (receipt.status !== 'completed') {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt;
}

function asRejected(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'rejected' }> {
  expect(receipt.status).toBe('rejected');
  if (receipt.status !== 'rejected') {
    throw new Error(`expected rejected receipt, got ${receipt.status}`);
  }
  return receipt;
}

async function rejectionOf(actions: () => unknown): Promise<unknown> {
  try {
    await actions();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error), `expected HostProtocolError(${code}), got ${String(error)}`).toBe(
    true,
  );
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

/** 错误证据脱敏断言：不泄漏沙箱物理路径。 */
function expectNoPathLeak(error: HostProtocolError, secretRoot: string): void {
  const evidence = `${error.message ?? ''} ${JSON.stringify((error as { details?: unknown }).details ?? {})}`;
  expect(evidence).not.toContain(secretRoot);
  expect(evidence).not.toMatch(/"(\/private)?\/(Users|var|tmp)\//);
}

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};

/** 无引用三 Task 链计划（<p>1 ← <p>2 ← <p>3）；Task ID 全局唯一，跨项目用前缀区分。 */
function samplePlan(titleSuffix = '', idPrefix = 't-'): Record<string, unknown> {
  const id = (n: number): string => `${idPrefix}${n}`;
  return {
    schemaVersion: 1,
    feature: {
      title: `接线 Feature${titleSuffix}`,
      description: 'F-007 接线描述',
      labels: ['wiring'],
      sourceRefs: [],
    },
    tasks: [
      {
        id: id(1),
        title: '任务一',
        complexity: 'low',
        acceptance: { criteria: ['任务一验收'] },
      },
      {
        id: id(2),
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收'] },
        dependsOn: [id(1)],
      },
      {
        id: id(3),
        title: '任务三',
        complexity: 'low',
        acceptance: { criteria: ['任务三验收'] },
        dependsOn: [id(2)],
      },
    ],
  };
}

interface WiredSetup {
  readonly box: CommandsTestFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly port: number;
  /** 注册项目 + 全局配置 + Phase + 计划导入，返回 projectId/phaseId/featureId/planDigest。 */
  seedApprovedCandidate(id: string): Promise<{
    projectId: string;
    phaseId: string;
    featureId: string;
    planDigest: string;
  }>;
  /**
   * 向共享制品索引登记一枚 ready 受管制品（夹具准备；身份级登记，正文仍只经
   * Artifact 身份作有界校验读取）。返回 artifactId。
   */
  seedReadyArtifact(projectId: string, name: string): Promise<string>;
  dispose(): Promise<void>;
}

let fixture: CommandsTestFixture | undefined;
let activeHost: RunningHost | undefined;

afterEach(async () => {
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    await host.close();
  }
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

async function setupWired(prefix: string): Promise<WiredSetup> {
  fixture = createCommandsTestFixture({ prefix: `shiploop-f007-${prefix}-` });
  const box = fixture;
  const host = await startHost({
    dataRoot: box.dataRoot,
    capabilityCatalog: box.capabilityCatalog,
    env: {},
  });
  activeHost = host;
  const token = readFileSync(join(box.dataRoot, 'host', 'auth.token'), 'utf8');
  const client = await connectToHost({ canonicalRoot: box.dataRoot });
  const port = host.port;

  const seedApprovedCandidate = async (phaseId: string) => {
    const registered = asCompleted(
      await client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: box.repoDirA,
          displayName: `F-007 ${phaseId}`,
          description: null,
          labels: [],
        },
      }),
    );
    const projectId = (registered.result as { project: { id: string } }).project.id;
    asCompleted(
      await client.submitCommand({
        operation: 'settings.global.create',
        scope: { kind: 'global' },
        payload: GLOBAL_PAYLOAD,
      }),
    );
    asCompleted(
      await client.createPhase({
        projectId,
        id: phaseId,
        title: `阶段 ${phaseId}`,
        description: null,
        labels: [],
      }),
    );
    const imported = asCompleted(
      await client.importFeaturePlan({
        projectId,
        phaseId,
        expectedRevision: 1,
        plan: samplePlan(),
      }),
    );
    const importResult = imported.result as {
      feature: { id: string; planDigest: string };
    };
    return {
      projectId,
      phaseId,
      featureId: importResult.feature.id,
      planDigest: importResult.feature.planDigest,
    };
  };

  return {
    box,
    host,
    client,
    token,
    port,
    seedApprovedCandidate,
    async seedReadyArtifact(projectId: string, name: string): Promise<string> {
      const contentHash = createHash('sha256').update(`fixture-${name}`, 'utf8').digest('hex');
      const session = openSqliteStorageSession({ path: box.dbPath });
      try {
        await migrateSqliteStorage(session);
        const artifactStore = createSqliteArtifactStore(session, { nowUtcMs: () => Date.now() });
        const record = await artifactStore.registerArtifact({
          projectId,
          kind: 'requirement',
          mediaType: 'text/markdown',
          expectedHash: contentHash,
          locator: `artifacts/${name}.md`,
        });
        await artifactStore.transitionArtifact(projectId, record.id, {
          expectedRevision: record.revision,
          outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
        });
        return record.id;
      } finally {
        session.close();
      }
    },
    async dispose() {
      client.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. 真实 Host + HostClient 纵向：决策/策略/输入准备/授权查询
 * ------------------------------------------------------------------ */

describe('F-007 决策与授权查询 HostClient 纵向（真实 Host + SQLite）', () => {
  it('decideFeaturePlan 批准绑定当前摘要 + features.approvals 查询 + 重放零副作用', async () => {
    const s = await setupWired('decide');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-decide');
      expect(CURRENT_SCHEMA_VERSION).toBe(5);

      // 决策前：无当前决定，fail-closed validity 未批准。
      const before = await s.client.getFeatureApprovals(featureId);
      expect(before.feature.id).toBe(featureId);
      expect(before.feature.planStatus).toBe('draft');
      expect(before.currentDecision).toBeNull();
      expect(before.decisions).toEqual([]);
      expect(before.validity).toMatchObject({ valid: false, reason: 'not_approved' });

      // 1) 批准（Feature 聚合 CAS=1，绑定当前 planDigest）。
      const decideInput = {
        projectId,
        featureId,
        planDigest,
        decision: 'approve' as const,
        reason: null,
        expectedRevision: 1,
      };
      const approved = asCompleted(await s.client.decideFeaturePlan(decideInput));
      const decideResult = validateFeaturePlanDecideResultWire(approved.result);
      expect(decideResult.decision).toBe('approve');
      expect(decideResult.feature.planStatus).toBe('approved');
      expect(decideResult.feature.revision).toBe(2);
      expect(decideResult.approval).toMatchObject({
        subjectId: featureId,
        subjectType: 'feature_plan',
        subjectDigest: planDigest,
        status: 'approved',
        current: true,
      });
      // 结果有界：不携带策略副本正文/正文内容。
      expect(JSON.stringify(approved.result)).not.toContain('任务一验收');

      // 2) 幂等重放：同 commandId + 同 issuedAt 重建同一信封 → 原回执。
      const replayed = asCompleted(
        await s.client.decideFeaturePlan(decideInput, {
          commandId: approved.commandId,
          issuedAt: approved.issuedAt,
        }),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(approved.resultRef);
      expect(replayed.result).toEqual(approved.result);

      // 3) 授权查询：当前决定 vs 历史 + 有效批准核验。
      const after = await s.client.getFeatureApprovals(featureId);
      expect(after.currentDecision).not.toBeNull();
      expect(after.currentDecision?.status).toBe('approved');
      expect(after.currentDecision?.current).toBe(true);
      expect(after.decisions).toHaveLength(1);
      expect(after.validity).toMatchObject({
        valid: true,
        reason: 'approved',
        planDigest,
        currentDecisionId: after.currentDecision?.id ?? null,
      });

      // 4) 同一身份不允许第二条决策（fail-closed，零业务写入）。
      const duplicate = asRejected(
        await s.client.decideFeaturePlan({
          ...decideInput,
          expectedRevision: 2,
          reason: 'again',
        }),
      );
      expect(duplicate.error.code).toBe('conflict');
      expect(
        (duplicate.error.details as { reason?: string } | undefined)?.reason,
      ).toBe('approval_already_decided');
      const unchanged = await s.client.getFeatureApprovals(featureId);
      expect(unchanged.decisions).toHaveLength(1);
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('decideFeaturePlan 拒绝不显示为已批准；失效摘要 fail-closed 零业务写入', async () => {
    const s = await setupWired('reject');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-reject');

      // 失效摘要 → rejected(conflict, plan_digest_mismatch)，planStatus 不变。
      const staleDigest = asRejected(
        await s.client.decideFeaturePlan({
          projectId,
          featureId,
          planDigest: 'ab'.repeat(32),
          decision: 'approve',
          reason: null,
          expectedRevision: 1,
        }),
      );
      expect(staleDigest.error.code).toBe('conflict');
      expect(
        (staleDigest.error.details as { reason?: string } | undefined)?.reason,
      ).toBe('plan_digest_mismatch');
      const untouched = await s.client.getFeatureApprovals(featureId);
      expect(untouched.feature.planStatus).toBe('draft');
      expect(untouched.currentDecision).toBeNull();

      // 拒绝：planStatus 落 draft，查询绝不显示为已批准。
      const rejected = asCompleted(
        await s.client.decideFeaturePlan({
          projectId,
          featureId,
          planDigest,
          decision: 'reject',
          reason: 'not-ready',
          expectedRevision: 1,
        }),
      );
      const rejectResult = validateFeaturePlanDecideResultWire(rejected.result);
      expect(rejectResult.decision).toBe('reject');
      expect(rejectResult.feature.planStatus).toBe('draft');
      expect(rejectResult.approval.status).toBe('rejected');
      const after = await s.client.getFeatureApprovals(featureId);
      expect(after.currentDecision?.status).toBe('rejected');
      expect(after.feature.planStatus).toBe('draft');
      expect(after.validity).toMatchObject({ valid: false, reason: 'rejected' });

      // 拒绝后准备输入：捕获阶段 fail-fast（零回执零发布），拒绝不提供执行依据。
      const prepareFailure = await rejectionOf(() =>
        s.client.prepareExecutionInput({ projectId, featureId, taskId: 't-1', items: [] }),
      );
      const prepareError = expectProtocolError(prepareFailure, 'conflict');
      expect((prepareError.details as { reason?: string } | undefined)?.reason).toBe('rejected');
      expectNoPathLeak(prepareError, s.box.root);
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('updateTaskStrategy CAS 编辑 + 陈旧 revision 固化 rejected + 重放零副作用', async () => {
    const s = await setupWired('strategy');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-strategy');
      // 策略编辑与批准顺序无关（批准不重读/不覆盖副本）。
      const strategyInput = {
        projectId,
        taskId: 't-1',
        executionConfig: {
          schemaVersion: 2,
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet-2',
        },
        expectedRevision: 1,
      };
      const edited = asCompleted(await s.client.updateTaskStrategy(strategyInput));
      const editResult = validateTaskStrategyUpdateResultWire(edited.result);
      expect(editResult.task).toMatchObject({
        id: 't-1',
        revision: 2,
        configSource: 'task_edit',
        configSourceKey: 'taskEdit',
      });
      expect(editResult.task.executionConfig).toEqual(strategyInput.executionConfig);

      // 重放：同 commandId 同参数 → 原回执零副作用。
      const replayed = asCompleted(
        await s.client.updateTaskStrategy(strategyInput, {
          commandId: edited.commandId,
          issuedAt: edited.issuedAt,
        }),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(edited.resultRef);

      // 陈旧 revision → 固化 rejected(conflict) 携带 expected/actual。
      const stale = asRejected(
        await s.client.updateTaskStrategy({ ...strategyInput, expectedRevision: 1 }),
      );
      expect(stale.error.code).toBe('conflict');
      const details = stale.error.details as
        | { reason?: string; expectedRevision?: number; actualRevision?: number }
        | undefined;
      expect(details?.reason).toBe('conflict');
      expect(details?.expectedRevision).toBe(1);
      expect(details?.actualRevision).toBe(2);

      // 策略修订不失效批准（内容身份纪律）：批准后编辑仍可准备输入。
      asCompleted(
        await s.client.decideFeaturePlan({
          projectId,
          featureId,
          planDigest,
          decision: 'approve',
          reason: null,
          expectedRevision: 1,
        }),
      );
      const approvals = await s.client.getFeatureApprovals(featureId);
      expect(approvals.validity.valid).toBe(true);
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('prepareExecutionInput 制品组身份经既有回执/结果查询暴露（正文永不内联）', async () => {
    const s = await setupWired('prepare');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-prepare');
      const artifactId = await s.seedReadyArtifact(projectId, 'prep-req');
      asCompleted(
        await s.client.decideFeaturePlan({
          projectId,
          featureId,
          planDigest,
          decision: 'approve',
          reason: null,
          expectedRevision: 1,
        }),
      );

      // 准备（创建类：不携带 expectedRevision；必需输入按 Artifact 身份受控读取）。
      const items = [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }];
      const prepared = asCompleted(
        await s.client.prepareExecutionInput({
          projectId,
          featureId,
          taskId: 't-1',
          items,
        }),
      );
      const group = validateExecutionInputPrepareResultWire(prepared.result);
      expect(group.bindable).toBe(true);
      expect(group.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(group.group.snapshot.locator).toBe('execution-input-groups/t-1/snapshot');
      expect(group.group.manifest.locator).toBe('execution-input-groups/t-1/manifest');
      expect(group.group.prompt.locator).toBe('execution-input-groups/t-1/prompt');
      expect(group.group.manifest.mediaType).toBe('application/json');
      expect(group.group.prompt.mediaType).toBe('text/plain');
      for (const ref of [group.group.snapshot, group.group.manifest, group.group.prompt]) {
        expect(ref.artifactId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
        expect(ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(ref.sizeBytes).toBeGreaterThan(0);
      }
      expect(group.requiredInputs).toHaveLength(1);
      expect(group.requiredInputs[0]).toMatchObject({
        purpose: 'requirements',
        artifactId,
        origin: { kind: 'artifact' },
      });
      expect(group.digests).toMatchObject({
        strategyCopyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        permissionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(group.approval).toMatchObject({ planDigest, checkPolicyDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(group.taskRevision).toBe(1);
      expect(group.tokenEstimate.kind).toBe('estimation');

      // 制品组身份查询：既有回执/结果读取（不新增查询面、不内联正文）。
      const viaReceipt = asCompleted(await s.client.getReceipt(prepared.commandId));
      expect(viaReceipt.result).toEqual(prepared.result);
      const viaResult = asCompleted(await s.client.resolveResult(prepared.resultRef));
      expect(viaResult.result).toEqual(prepared.result);
      // 身份查询结果不携带 snapshot/prompt 正文。
      const serialized = JSON.stringify(prepared.result);
      expect(serialized).not.toContain('任务一验收');
      expect(serialized).not.toContain(s.box.root);

      // 重放：同 commandId → 原回执（不代表满足当前前置条件）。
      const replayed = asCompleted(
        await s.client.prepareExecutionInput(
          { projectId, featureId, taskId: 't-1', items },
          { commandId: prepared.commandId, issuedAt: prepared.issuedAt },
        ),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(prepared.resultRef);
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * B. 传输边界与授权负例
 * ------------------------------------------------------------------ */

describe('F-007 传输与授权负例（既有契约错误，不自动扩权/降级/启动执行）', () => {
  it('旧线消息版本/未认证/请求体身份伪造均按既有契约拒绝', async () => {
    const s = await setupWired('wire-negative');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-neg');

      // 旧版本（v4）命令信封在认证后明确 unsupported_schema_version。
      const legacy = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: '/v1/commands',
        token: s.token,
        body: {
          schemaVersion: 4,
          commandId: randomUUID(),
          operation: 'feature.plan.decide',
          scope: { kind: 'project', projectId },
          expectedRevision: 1,
          issuedAt: new Date().toISOString(),
          payload: { featureId, planDigest, decision: 'approve', reason: null },
        },
      });
      expect(legacy.statusCode).toBe(400);
      expect((legacy.json() as { error?: { code?: string } }).error?.code).toBe(
        'unsupported_schema_version',
      );

      // 未认证查询 → 401（版本/能力不越过认证）。
      const unauthenticated = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/features/${featureId}/approvals`,
      });
      expect(unauthenticated.statusCode).toBe(401);

      // 请求体伪造可信身份（decisionActor/principalId）→ invalid_input，决策人
      // 只能来自可信装配；伪造尝试零业务写入。
      const forged = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: '/v1/commands',
        token: s.token,
        body: {
          schemaVersion: 5,
          commandId: randomUUID(),
          operation: 'feature.plan.decide',
          scope: { kind: 'project', projectId },
          expectedRevision: 1,
          issuedAt: new Date().toISOString(),
          payload: {
            featureId,
            planDigest,
            decision: 'approve',
            reason: null,
            decisionActor: 'attacker',
            principalId: 'attacker',
          },
        },
      });
      expect(forged.statusCode).toBe(400);
      expect((forged.json() as { error?: { code?: string } }).error?.code).toBe('invalid_input');
      const approvals = await s.client.getFeatureApprovals(featureId);
      expect(approvals.currentDecision).toBeNull();
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('features.approvals 路由负例：未知查询参数/未知目标/错误方法统一既有错误', async () => {
    const s = await setupWired('approvals-negative');
    try {
      const { featureId } = await s.seedApprovedCandidate('phase-aq');

      // 未知查询参数 → 400 unknown_query_parameter。
      const unknownParam = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/features/${featureId}/approvals?foo=1`,
        token: s.token,
      });
      expect(unknownParam.statusCode).toBe(400);
      expect(
        (unknownParam.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason,
      ).toBe('unknown_query_parameter');

      // 未知目标 → 404 not_found（不泄漏存在性）。
      const missing = await rejectionOf(() => s.client.getFeatureApprovals('f-missing'));
      const missingError = expectProtocolError(missing, 'not_found');
      expectNoPathLeak(missingError, s.box.root);

      // POST 到查询路由 → 405；嵌套多余形态 → 404。
      const wrongMethod = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: `/v1/features/${featureId}/approvals`,
        token: s.token,
        body: {},
      });
      expect(wrongMethod.statusCode).toBe(405);
      const nested = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/features/${featureId}/approvals/extra`,
        token: s.token,
      });
      expect(nested.statusCode).toBe(404);
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('受控制品组读取边界：无 path/locator 通用文件接口，跨项目/未知正文不泄漏', async () => {
    const s = await setupWired('group-reads');
    try {
      const { projectId, featureId, planDigest } = await s.seedApprovedCandidate('phase-group');
      const artifactId = await s.seedReadyArtifact(projectId, 'group-req');
      asCompleted(
        await s.client.decideFeaturePlan({
          projectId,
          featureId,
          planDigest,
          decision: 'approve',
          reason: null,
          expectedRevision: 1,
        }),
      );

      // 表外 path/locator 形态一律 404（不新增 /v1/files 类通用文件接口）。
      for (const path of [
        '/v1/files/etc/passwd',
        '/v1/artifacts/art-1',
        '/v1/artifacts/art-1/content/extra',
        `/v1/features/${featureId}/approvals/../tasks`,
      ]) {
        const response = await loopbackRequest({
          port: s.port,
          method: 'GET',
          path,
          token: s.token,
        });
        expect(response.statusCode, path).toBe(404);
      }

      // artifacts.get 查询参数不接受 path/locator 语义。
      const locatorSmuggled = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: '/v1/artifacts/art-1/content?path=/etc/passwd',
        token: s.token,
      });
      expect(locatorSmuggled.statusCode).toBe(400);

      // 未知 Artifact 正文 → 统一 not_found（不泄漏存在性/物理路径）。
      const unknownBody = await rejectionOf(() => s.client.readArtifactContent('art-unknown'));
      const unknownError = expectProtocolError(unknownBody, 'not_found');
      expectNoPathLeak(unknownError, s.box.root);

      // 输入正文只允许按获准制品组内 Artifact 身份作有界校验读取：
      // 合法 artifact 身份引用成功（上方已夹具登记）；内联正文/绝对路径/
      // 路径穿越/未知根/未知制品一律 fail-closed，零泄漏。
      const viaArtifact = asCompleted(
        await s.client.prepareExecutionInput({
          projectId,
          featureId,
          taskId: 't-1',
          items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }],
        }),
      );
      const viaArtifactGroup = validateExecutionInputPrepareResultWire(viaArtifact.result);
      expect(viaArtifactGroup.requiredInputs[0]?.origin).toEqual({ kind: 'artifact' });

      for (const [item, code] of [
        [{ purpose: 'req', source: { kind: 'inline', content: 'secret-body' } }, 'invalid_input'],
        [{ purpose: 'req', source: { kind: 'file', root: 'r', relativePath: '/etc/passwd' } }, 'invalid_input'],
        [{ purpose: 'req', source: { kind: 'file', root: 'r', relativePath: '../../escape' } }, 'invalid_input'],
        [{ purpose: 'req', source: { kind: 'file', root: 'r', relativePath: 'docs/a.md' } }, 'invalid_input'],
        [{ purpose: 'req', source: { kind: 'artifact', artifactId: 'art-unknown' } }, 'not_found'],
      ] as const) {
        const failure = await rejectionOf(() =>
          s.client.prepareExecutionInput({ projectId, featureId, taskId: 't-1', items: [item] }),
        );
        const failureError = expectProtocolError(failure, code);
        expectNoPathLeak(failureError, s.box.root);
        expect(JSON.stringify((failureError as { details?: unknown }).details ?? {})).not.toContain(
          'secret-body',
        );
      }

      // 同一命令内重复用途 fail-fast（不静默去重）。
      const duplicatePurpose = await rejectionOf(() =>
        s.client.prepareExecutionInput({
          projectId,
          featureId,
          taskId: 't-1',
          items: [
            { purpose: 'req', source: { kind: 'artifact', artifactId } },
            { purpose: 'req', source: { kind: 'artifact', artifactId } },
          ],
        }),
      );
      expectProtocolError(duplicatePurpose, 'invalid_input');

      // 跨项目目标 → forbidden（ownership）；未知目标 → not_found；均零业务写入。
      const other = await s.client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: s.box.repoDirB,
          displayName: 'F-007 项目 B',
          description: null,
          labels: [],
        },
      });
      const projectIdB = ((other as { result?: unknown }).result as { project: { id: string } })
        .project.id;
      asCompleted(
        await s.client.createPhase({
          projectId: projectIdB,
          id: 'phase-b',
          title: '阶段 B',
          description: null,
          labels: [],
        }),
      );
      const importedB = asCompleted(
        await s.client.importFeaturePlan({
          projectId: projectIdB,
          phaseId: 'phase-b',
          expectedRevision: 1,
          plan: samplePlan('（B）', 'b-'),
        }),
      );
      const featureIdB = (importedB.result as { feature: { id: string } }).feature.id;

      const crossProject = await rejectionOf(() =>
        s.client.prepareExecutionInput({ projectId, featureId: featureIdB, taskId: 't-1', items: [] }),
      );
      const crossError = expectProtocolError(crossProject, 'forbidden');
      expectNoPathLeak(crossError, s.box.root);

      const missingFeature = await rejectionOf(() =>
        s.client.prepareExecutionInput({ projectId, featureId: 'f-missing', taskId: 't-1', items: [] }),
      );
      expectProtocolError(missingFeature, 'not_found');
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * C. HostClient 零网络输入校验与线校验器负例
 * ------------------------------------------------------------------ */

describe('F-007 HostClient 新方法输入校验（零网络拒绝）', () => {
  it('公共方法拒绝未知键/非法摘要/非法 revision/非法 items', async () => {
    const s = await setupWired('client-input');
    try {
      const base = {
        projectId: 'p-1',
        featureId: 'f-1',
        planDigest: 'ab'.repeat(32),
        decision: 'approve' as const,
        reason: null,
        expectedRevision: 1,
      };
      expectProtocolError(
        await rejectionOf(() =>
          s.client.decideFeaturePlan({
            ...base,
            // @ts-expect-error 未知键必须在零网络阶段拒绝
            decisionActor: 'attacker',
          }),
        ),
        'invalid_input',
      );
      const badDigest = await rejectionOf(() =>
        s.client.decideFeaturePlan({ ...base, planDigest: 'not-a-digest' }),
      );
      expectProtocolError(badDigest, 'invalid_input');
      expectProtocolError(
        await rejectionOf(() =>
          s.client.decideFeaturePlan({
            ...base,
            // @ts-expect-error decision 只允许 approve/reject
            decision: 'maybe',
          }),
        ),
        'invalid_input',
      );
      const badRevision = await rejectionOf(() =>
        s.client.updateTaskStrategy({
          projectId: 'p-1',
          taskId: 't-1',
          executionConfig: {},
          expectedRevision: 0,
        }),
      );
      expectProtocolError(badRevision, 'invalid_input');
      expectProtocolError(
        await rejectionOf(() =>
          s.client.prepareExecutionInput({
            projectId: 'p-1',
            featureId: 'f-1',
            taskId: 't-1',
            // @ts-expect-error items 必须是数组
            items: 'nope',
          }),
        ),
        'invalid_input',
      );
      const badId = await rejectionOf(() => s.client.getFeatureApprovals(''));
      expectProtocolError(badId, 'invalid_input');
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * D. 新增线校验器（畸形响应/未知键拒绝，协议错误不重试）
 * ------------------------------------------------------------------ */

const FEATURE_RECORD_WIRE = {
  id: 'f-1',
  projectId: 'p-1',
  phaseId: 'ph-1',
  title: '标题',
  description: null,
  labels: [],
  status: 'open',
  planStatus: 'approved',
  planDigest: 'ab'.repeat(32),
  sourceRefs: [],
  revision: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
};

const APPROVAL_RECORD_WIRE = {
  id: 'appr-1',
  projectId: 'p-1',
  subjectId: 'f-1',
  subjectType: 'feature_plan',
  subjectDigest: 'ab'.repeat(32),
  checkPolicyDigest: 'cd'.repeat(32),
  status: 'approved',
  decisionActor: 'local-owner',
  reason: null,
  decidedAt: '2026-01-01T00:00:01.000Z',
  revision: 1,
  createdAt: '2026-01-01T00:00:01.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  current: true,
};

const BODY_REF_WIRE = {
  artifactId: 'art-1',
  version: 1,
  contentHash: 'ab'.repeat(32),
  sizeBytes: 10,
  locator: 'execution-input-groups/t-1/snapshot',
  mediaType: 'application/json',
};

const PREPARE_RESULT_WIRE = {
  schemaVersion: 2,
  bindable: true,
  preparedAt: '2026-01-01T00:00:01.000Z',
  group: {
    snapshot: { ...BODY_REF_WIRE },
    manifest: {
      ...BODY_REF_WIRE,
      artifactId: 'art-2',
      locator: 'execution-input-groups/t-1/manifest',
    },
    prompt: {
      ...BODY_REF_WIRE,
      artifactId: 'art-3',
      locator: 'execution-input-groups/t-1/prompt',
      mediaType: 'text/plain',
    },
  },
  requiredInputs: [
    {
      purpose: 'req',
      artifactId: 'art-in',
      version: 1,
      contentHash: 'cd'.repeat(32),
      sizeBytes: 5,
      locator: 'execution-inputs/t-1/req',
      mediaType: 'application/octet-stream',
      origin: { kind: 'file', root: 'r', relativePath: 'docs/a.md' },
    },
  ],
  digests: {
    snapshotDigest: 'ab'.repeat(32),
    manifestDigest: 'cd'.repeat(32),
    promptDigest: 'ef'.repeat(32),
    strategyCopyDigest: '12'.repeat(32),
    permissionsDigest: '34'.repeat(32),
  },
  approval: {
    planDigest: 'ab'.repeat(32),
    checkPolicyDigest: 'cd'.repeat(32),
    decisionId: 'appr-1',
    featureRevision: 2,
  },
  taskRevision: 1,
  promptBytes: 1234,
  tokenEstimate: { value: 321, kind: 'estimation', method: 'chars/4' },
};

function expectWireMalformed(action: () => unknown): void {
  const error = rejectionOfWire(action);
  expectProtocolError(error, 'response_malformed');
}

function rejectionOfWire(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以协议错误拒绝，实际成功返回');
}

describe('F-007 新增线校验器（畸形响应/未知键拒绝）', () => {
  it('feature.plan.decide 结果：正例通过；缺字段/未知键/坏摘要/坏 current 拒绝', () => {
    const valid = {
      feature: { ...FEATURE_RECORD_WIRE },
      decision: 'approve',
      approval: { ...APPROVAL_RECORD_WIRE },
    };
    const result = validateFeaturePlanDecideResultWire(valid);
    expect(result.decision).toBe('approve');
    expect(result.approval.current).toBe(true);
    expectWireMalformed(() =>
      validateFeaturePlanDecideResultWire({ ...valid, decision: 'destroy' }),
    );
    expectWireMalformed(() =>
      validateFeaturePlanDecideResultWire({ ...valid, extra: 1 }),
    );
    expectWireMalformed(() =>
      validateFeaturePlanDecideResultWire({
        ...valid,
        approval: { ...APPROVAL_RECORD_WIRE, current: false },
      }),
    );
    expectWireMalformed(() =>
      validateFeaturePlanDecideResultWire({
        ...valid,
        approval: { ...APPROVAL_RECORD_WIRE, subjectDigest: 'bad' },
      }),
    );
    expectWireMalformed(() => validateFeaturePlanDecideResultWire({ decision: 'approve' }));
  });

  it('execution.input.prepare 结果：正例通过；非 bindable/未知键/坏正文引用/坏 token 估算拒绝', () => {
    const group = validateExecutionInputPrepareResultWire(PREPARE_RESULT_WIRE);
    expect(group.bindable).toBe(true);
    expect(group.group.snapshot.artifactId).toBe('art-1');
    expect(group.requiredInputs[0]?.origin).toEqual({
      kind: 'file',
      root: 'r',
      relativePath: 'docs/a.md',
    });
    expectWireMalformed(() =>
      validateExecutionInputPrepareResultWire({ ...PREPARE_RESULT_WIRE, bindable: false }),
    );
    expectWireMalformed(() =>
      validateExecutionInputPrepareResultWire({ ...PREPARE_RESULT_WIRE, content: 'body' }),
    );
    expectWireMalformed(() =>
      validateExecutionInputPrepareResultWire({
        ...PREPARE_RESULT_WIRE,
        group: {
          ...PREPARE_RESULT_WIRE.group,
          snapshot: { ...BODY_REF_WIRE, contentHash: 'not-a-hash' },
        },
      }),
    );
    expectWireMalformed(() =>
      validateExecutionInputPrepareResultWire({
        ...PREPARE_RESULT_WIRE,
        tokenEstimate: { value: 1, kind: 'exact', method: 'x' },
      }),
    );
    expectWireMalformed(() =>
      validateExecutionInputPrepareResultWire({
        ...PREPARE_RESULT_WIRE,
        requiredInputs: [{ purpose: 'req', content: 'inline' }],
      }),
    );
  });

  it('features.approvals 响应：正例通过；未知决定/坏 validity 词汇/未知键拒绝', () => {
    const valid = {
      feature: { ...FEATURE_RECORD_WIRE },
      currentDecision: { ...APPROVAL_RECORD_WIRE },
      decisions: [{ ...APPROVAL_RECORD_WIRE }],
      validity: {
        valid: true,
        reason: 'approved',
        planDigest: 'ab'.repeat(32),
        checkPolicyDigest: 'cd'.repeat(32),
        currentDecisionId: 'appr-1',
      },
    };
    const result = validateAppQueryResponse('features.approvals', valid);
    expect(result.currentDecision?.current).toBe(true);
    expect(result.validity.valid).toBe(true);
    expectWireMalformed(() =>
      validateAppQueryResponse('features.approvals', {
        ...valid,
        validity: { ...valid.validity, reason: 'maybe' },
      }),
    );
    expectWireMalformed(() =>
      validateAppQueryResponse('features.approvals', {
        ...valid,
        currentDecision: { ...APPROVAL_RECORD_WIRE, current: false },
      }),
    );
    expectWireMalformed(() =>
      validateAppQueryResponse('features.approvals', { ...valid, surprise: true }),
    );
  });
});
