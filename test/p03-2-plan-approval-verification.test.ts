/**
 * P03-2 / F-003：扩展计划及检查政策的有效批准核验与失效处理纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针与服务返回结果断言
 * 有效性，不只检查摘要字符串不同）：
 * - 审批覆盖的实质输入身份：要求/完整 acceptance/依赖由前序确定性
 *   planDigest 覆盖（计算不变），适用检查政策以显式绑定核验值
 *   （approvals.check_policy_digest = 当前有效 policies.verification 内容摘要）
 *   覆盖——不依赖可变配置路径、通用配置 revision 或 labels；
 * - 批准前后的实质要求/验收/依赖或适用检查政策修改均令旧批准失去执行效力
 *   （fail-closed：plan_changed / check_policy_changed 明确过期原因）；旧决策
 *   证据保留（行不改写），重新批准当前身份后才能通过核验；
 * - 纯标签 CAS 更新不改变业务摘要不使有效批准失效；项目默认 modelMap 变化
 *   不追溯 Task 策略也不使批准失效；Task 实际策略修订（task.strategy.update）
 *   与需求/检查身份可区分——不使批准失效；
 * - 核验服务（verifyFeaturePlanApprovalInTransaction + features.approvals 的
 *   validity 块）从同一权威状态视图校验项目归属/当前摘要/检查身份/审批状态，
 *   未批准、拒绝、过期、不一致均拒绝；批准不是启动授权（不创建执行实体）；
 * - 政策变更与批准竞争：决策在同一写事务内绑定当前检查政策身份，旧视图不
 *   得提交为当前有效依据；事务失败整组回滚（沿用 F-002 注入点纪律）；
 * - 迁移 v8：v7 库（含既设计划决策行）升级保留数据，遗留行
 *   check_policy_digest=NULL 不等于任何当前身份（fail-closed 需重新批准）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import {
  resolveCurrentCheckPolicyDigest,
  verifyFeaturePlanApprovalInTransaction,
} from '../packages/core/src/application/plan-approval-verification.ts';
import {
  CHECK_POLICY_DIGEST_DOMAIN,
  PLAN_APPROVAL_VERIFICATION_REASONS,
  computeFeatureCheckPolicyDigest,
  evaluatePlanApprovalValidity,
} from '../packages/core/src/ports/plan-approval-verification.ts';
import type { PlanApprovalDecisionIdentity } from '../packages/core/src/ports/plan-approval-verification.ts';
import type { PublicError } from '../packages/core/src/ports/commands.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  createCommandsTestFixture,
  WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH_A = sha256('artifact-source-content');
const HASH_B = sha256('artifact-requirements-content');

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { code: string; operation?: string; reason?: string },
): Promise<PublicError> {
  const error = (await run().then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
  expect(error.code).toBe(expected.code);
  if (expected.operation !== undefined) {
    expect(error.operation).toBe(expected.operation);
  }
  if (expected.reason !== undefined) {
    expect(error.details?.reason).toBe(expected.reason);
  }
  return error;
}

interface PlanTaskSpec {
  readonly id: string;
  readonly title: string;
  readonly complexity?: string;
  readonly criteria: readonly string[];
  readonly requirementsRefs?: readonly { artifactId: string }[];
  readonly dependsOn?: readonly string[];
}

/** 组装计划 payload（缺省为三 Task 链 t-1 ← t-2 ← t-3）。 */
function buildPlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown>;
function buildPlan(
  artifactIds: { readonly src: string; readonly req: string },
  tasks: readonly PlanTaskSpec[],
): Record<string, unknown>;
function buildPlan(
  artifactIds: { readonly src: string; readonly req: string },
  tasks?: readonly PlanTaskSpec[],
): Record<string, unknown> {
  const specs = tasks ?? [
    { id: 't-1', title: '任务一', complexity: 'low', criteria: ['任务一验收'], requirementsRefs: [{ artifactId: artifactIds.req }] },
    { id: 't-2', title: '任务二', complexity: 'medium', criteria: ['任务二验收'], dependsOn: ['t-1'] },
    { id: 't-3', title: '任务三', criteria: ['任务三验收'], dependsOn: ['t-2'] },
  ];
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: null,
      labels: [],
      sourceRefs: [{ artifactId: artifactIds.src, contentHash: HASH_A }],
    },
    tasks: specs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      ...(spec.complexity === undefined ? {} : { complexity: spec.complexity }),
      acceptance: { criteria: [...spec.criteria] },
      ...(spec.requirementsRefs === undefined ? {} : { requirementsRefs: [...spec.requirementsRefs] }),
      ...(spec.dependsOn === undefined ? {} : { dependsOn: [...spec.dependsOn] }),
    })),
  };
}

/** 全局配置：默认策略 + verification 检查政策（requireChecksBeforeDone: true）。 */
const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
} as const;
/** 项目配置：只有 modelMap（无 verification 段 → 继承全局检查政策）。 */
const PROJECT_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
} as const;

async function seedReadyArtifact(
  artifactStore: ReturnType<typeof createSqliteArtifactStore>,
  projectId: string,
  contentHash: string,
  locatorName: string,
): Promise<string> {
  const record = await artifactStore.registerArtifact({
    projectId,
    kind: 'requirement',
    mediaType: 'text/markdown',
    expectedHash: contentHash,
    locator: `artifacts/${locatorName}.md`,
  });
  await artifactStore.transitionArtifact(projectId, record.id, {
    expectedRevision: record.revision,
    outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
  });
  return record.id;
}

interface VerificationSetup {
  readonly box: CommandsTestFixture;
  readonly harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>>;
  readonly store: ReturnType<typeof createSqliteAtomicCommandStore>;
  readonly service: CommandService;
  readonly probe: ReturnType<CommandsTestFixture['openProbe']>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly artifactSrcId: string;
  readonly artifactReqId: string;
  readonly globalSettingsRevision: () => number;
  readonly projectSettingsRevision: () => number;
  readonly featureRevision: () => number;
  readonly submit: (
    payload: Record<string, unknown>,
    operation: string,
    extra?: Record<string, unknown>,
  ) => ReturnType<CommandService['submit']>;
  readonly decide: (
    decision?: 'approve' | 'reject',
    overrides?: { digest?: string; expectedRevision?: number },
  ) => ReturnType<CommandService['submit']>;
  readonly revise: (plan: Record<string, unknown>) => ReturnType<CommandService['submit']>;
  readonly validity: () => Promise<{
    valid: boolean;
    reason: string;
    planDigest: string | null;
    checkPolicyDigest: string;
    currentDecisionId: string | null;
  }>;
  readonly verifyInTransaction: () => {
    validity: { valid: boolean; reason: string };
    currentDecision: { id: string; checkPolicyDigest: string | null } | null;
  };
  readonly approvalsRows: () => Record<string, unknown>[];
  readonly featureRow: () => Record<string, unknown> | undefined;
  readonly taskRevision: (taskId: string) => number;
}

async function setup(): Promise<VerificationSetup> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p032-f003-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  const now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    nowUtcMs: () => now,
  });
  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs: () => now });
  const probe = box.openProbe();
  const owner = box.localOwner();

  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = (
    payload: Record<string, unknown>,
    operation: string,
    extra: Record<string, unknown> = {},
  ): ReturnType<CommandService['submit']> =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) {
    throw new Error('夹具注册失败');
  }
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const globalSettings = await submit(GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') {
    throw new Error('夹具全局配置失败');
  }
  const projectSettings = await submit(PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: { kind: 'project', projectId },
  });
  if (projectSettings.status !== 'completed') {
    throw new Error('夹具项目配置失败');
  }

  const phase = await submit({ id: 'phase-1', title: '第一阶段', description: null, labels: [] }, 'phase.create', {
    scope: { kind: 'project', projectId },
  });
  if (phase.status !== 'completed') {
    throw new Error('夹具 Phase 创建失败');
  }

  const artifactSrcId = await seedReadyArtifact(artifactStore, projectId, HASH_A, 'art-src');
  const artifactReqId = await seedReadyArtifact(artifactStore, projectId, HASH_B, 'art-req');

  const imported = await submit(
    { phaseId: 'phase-1', plan: buildPlan({ src: artifactSrcId, req: artifactReqId }) },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) {
    throw new Error('夹具计划导入失败');
  }
  const importedFeature = (imported.result as { feature: { id: string; planDigest: string } }).feature;
  const featureId = importedFeature.id;
  const planDigest = importedFeature.planDigest;

  const featureRow = (): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>('SELECT * FROM features WHERE id = ?', [featureId]) as
      | Record<string, unknown>
      | undefined;

  const decide = (
    decision: 'approve' | 'reject' = 'approve',
    overrides: { digest?: string; expectedRevision?: number } = {},
  ) =>
    submit(
      {
        featureId,
        planDigest: overrides.digest ?? planDigest,
        decision,
      },
      'feature.plan.decide',
      {
        scope: { kind: 'project', projectId },
        expectedRevision: overrides.expectedRevision ?? (featureRow()?.revision as number),
      },
    );

  const revise = (plan: Record<string, unknown>) =>
    submit(
      { featureId, plan },
      'feature.plan.revise',
      { scope: { kind: 'project', projectId }, expectedRevision: featureRow()?.revision as number },
    );

  return {
    box,
    harness,
    store,
    service,
    probe,
    owner,
    projectId,
    featureId,
    planDigest,
    artifactSrcId,
    artifactReqId,
    globalSettingsRevision: () =>
      probe.selectOne<{ revision: number }>('SELECT revision FROM global_settings WHERE id = ?', ['global'])
        ?.revision ?? -1,
    projectSettingsRevision: () =>
      probe.selectOne<{ revision: number }>('SELECT revision FROM project_settings WHERE project_id = ?', [projectId])
        ?.revision ?? -1,
    featureRevision: () => featureRow()?.revision as number,
    submit,
    decide,
    revise,
    validity: async () => {
      const app = await box.openApplication();
      try {
        const result = await app.queryService.getFeatureApprovals(owner, featureId);
        return result.validity;
      } finally {
        await app.close();
      }
    },
    verifyInTransaction: () =>
      store.transact('test.verifyFeaturePlanApproval', (transaction) =>
        verifyFeaturePlanApprovalInTransaction(transaction, projectId, featureId),
      ),
    approvalsRows: () =>
      probe.selectAll<Record<string, unknown>>('SELECT * FROM approvals ORDER BY decided_at, id') as Record<
        string,
        unknown
      >[],
    featureRow,
    taskRevision: (taskId: string) =>
      probe.selectOne<{ revision: number }>('SELECT revision FROM tasks WHERE id = ?', [taskId])?.revision ?? -1,
  };
}

/** 当前夹具配置下的适用检查政策摘要（全局 verification 段被项目继承）。 */
const EXPECTED_POLICY_DIGEST = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true });

/* ------------------------------------------------------------------ *
 * 纯规则：检查政策身份摘要与有效批准评估
 * ------------------------------------------------------------------ */

describe('F-003 检查政策身份摘要（纯函数，确定性）', () => {
  it('政策内容摘要：同内容同摘要；不同内容/缺席可区分；不依赖配置 revision', () => {
    const digestA = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true });
    const digestB = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true });
    expect(digestA).toBe(digestB);
    expect(digestA).toMatch(/^[0-9a-f]{64}$/);
    // 内容变化 → 摘要变化。
    expect(computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false })).not.toBe(digestA);
    // 缺席（双方均未配置 verification 段）与任何实配政策可区分。
    const absent = computeFeatureCheckPolicyDigest(undefined);
    expect(absent).not.toBe(digestA);
    expect(absent).toBe(computeFeatureCheckPolicyDigest(undefined));
    // 领域前缀锚定：与裸内容摘要不碰撞。
    expect(absent).not.toBe(sha256('{"verificationPolicy":null}'));
    expect(CHECK_POLICY_DIGEST_DOMAIN).toBe('shiploop:feature-plan-check-policy:v1');
    // 有效配置合并：项目非空段整体覆盖全局段；摘要跟随合并后内容。
    const inherited = resolveCurrentCheckPolicyDigest(
      { scopeRevision: 3, payload: GLOBAL_SETTINGS_PAYLOAD },
      { scopeRevision: 7, payload: PROJECT_SETTINGS_PAYLOAD },
    );
    expect(inherited).toBe(EXPECTED_POLICY_DIGEST);
    const overridden = resolveCurrentCheckPolicyDigest(
      { scopeRevision: 3, payload: GLOBAL_SETTINGS_PAYLOAD },
      {
        scopeRevision: 9,
        payload: {
          schemaVersion: 2,
          policies: { verification: { requireChecksBeforeDone: false } },
        } as const,
      },
    );
    expect(overridden).toBe(computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false }));
    // scopeRevision 是合并输入身份，不进入摘要内容（同内容不同 revision 同摘要）。
    const inheritedOtherRevision = resolveCurrentCheckPolicyDigest(
      { scopeRevision: 11, payload: GLOBAL_SETTINGS_PAYLOAD },
      { scopeRevision: 2, payload: PROJECT_SETTINGS_PAYLOAD },
    );
    expect(inheritedOtherRevision).toBe(EXPECTED_POLICY_DIGEST);
  });
});

describe('F-003 有效批准评估纯规则（evaluatePlanApprovalValidity）', () => {
  const DIGEST_A = sha256('plan-a');
  const DIGEST_B = sha256('plan-b');
  const POLICY_X = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true });
  const POLICY_Y = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false });
  const decision = (
    id: string,
    digest: string,
    policy: string | null,
    status: PlanApprovalDecisionIdentity['status'],
  ): PlanApprovalDecisionIdentity => ({ id, subjectDigest: digest, checkPolicyDigest: policy, status });

  it('原因词汇冻结且覆盖 未批准/拒绝/过期/不一致', () => {
    expect([...PLAN_APPROVAL_VERIFICATION_REASONS]).toEqual([
      'approved',
      'no_plan',
      'no_tasks',
      'not_approved',
      'rejected',
      'plan_changed',
      'check_policy_changed',
      'approval_state_inconsistent',
    ]);
  });

  it('批准有效：当前身份 approved 决策 + planStatus=approved', () => {
    const result = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'approved',
      taskCount: 3,
      decisions: [decision('ap-1', DIGEST_A, POLICY_X, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(result).toEqual({
      valid: true,
      reason: 'approved',
      planDigest: DIGEST_A,
      checkPolicyDigest: POLICY_X,
      currentDecisionId: 'ap-1',
    });
  });

  it('无计划摘要 → no_plan；零 Task → no_tasks', () => {
    expect(
      evaluatePlanApprovalValidity({
        planDigest: null,
        planStatus: 'draft',
        taskCount: 3,
        decisions: [],
        currentCheckPolicyDigest: POLICY_X,
      }).reason,
    ).toBe('no_plan');
    expect(
      evaluatePlanApprovalValidity({
        planDigest: DIGEST_A,
        planStatus: 'draft',
        taskCount: 0,
        decisions: [],
        currentCheckPolicyDigest: POLICY_X,
      }).reason,
    ).toBe('no_tasks');
  });

  it('未批准 → not_approved；同摘要拒绝 → rejected（政策变化不赦免同摘要拒绝）', () => {
    expect(
      evaluatePlanApprovalValidity({
        planDigest: DIGEST_A,
        planStatus: 'draft',
        taskCount: 1,
        decisions: [],
        currentCheckPolicyDigest: POLICY_X,
      }).reason,
    ).toBe('not_approved');
    // 同摘要 rejected（旧政策绑定）→ 当前身份下仍 rejected。
    const rejected = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'draft',
      taskCount: 1,
      decisions: [decision('ap-1', DIGEST_A, POLICY_Y, 'rejected')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(rejected).toMatchObject({ valid: false, reason: 'rejected', currentDecisionId: 'ap-1' });
  });

  it('实质计划变化 → plan_changed；旧摘要 approved 决策保留为历史证据', () => {
    const result = evaluatePlanApprovalValidity({
      planDigest: DIGEST_B,
      planStatus: 'draft',
      taskCount: 2,
      decisions: [decision('ap-1', DIGEST_A, POLICY_X, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(result).toMatchObject({ valid: false, reason: 'plan_changed', currentDecisionId: 'ap-1' });
    // 决策后计划被修订重置（planStatus 回 draft，摘要巧合相同）→ plan_changed。
    const revisedBack = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'draft',
      taskCount: 2,
      decisions: [decision('ap-1', DIGEST_A, POLICY_X, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(revisedBack).toMatchObject({ valid: false, reason: 'plan_changed' });
  });

  it('检查政策变化 → check_policy_changed（含 v7 遗留 NULL 绑定）', () => {
    const changed = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'approved',
      taskCount: 2,
      decisions: [decision('ap-1', DIGEST_A, POLICY_Y, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(changed).toMatchObject({ valid: false, reason: 'check_policy_changed', currentDecisionId: 'ap-1' });
    const legacy = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'approved',
      taskCount: 2,
      decisions: [decision('ap-1', DIGEST_A, null, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(legacy).toMatchObject({ valid: false, reason: 'check_policy_changed' });
  });

  it('planStatus=approved 但当前摘要无 approved 决策 → approval_state_inconsistent', () => {
    const result = evaluatePlanApprovalValidity({
      planDigest: DIGEST_A,
      planStatus: 'approved',
      taskCount: 2,
      decisions: [decision('ap-1', DIGEST_B, POLICY_X, 'approved')],
      currentCheckPolicyDigest: POLICY_X,
    });
    expect(result).toMatchObject({ valid: false, reason: 'approval_state_inconsistent' });
  });
});

/* ------------------------------------------------------------------ *
 * 批准绑定检查政策身份（真实 SQLite + 命令通道）
 * ------------------------------------------------------------------ */

describe('F-003 批准绑定当前适用检查政策身份', () => {
  it('批准决策记录绑定当前检查政策摘要（回执/决策行/查询一致），核验 valid=approved', async () => {
    const s = await setup();
    const receipt = await s.decide('approve');
    expect(receipt.status).toBe('completed');
    if (receipt.status !== 'completed' || receipt.result === null) {
      throw new Error('expected completed');
    }
    const result = receipt.result as {
      approval: { status: string; subjectDigest: string; checkPolicyDigest: string };
    };
    expect(result.approval).toMatchObject({
      status: 'approved',
      subjectDigest: s.planDigest,
      checkPolicyDigest: EXPECTED_POLICY_DIGEST,
    });
    // 决策行：check_policy_digest 真实落库（政策内容摘要，非配置路径/revision/labels）。
    expect(s.approvalsRows()).toEqual([
      expect.objectContaining({
        subject_digest: s.planDigest,
        check_policy_digest: EXPECTED_POLICY_DIGEST,
        status: 'approved',
      }),
    ]);
    // 查询同一权威视图：validity 为有效批准（后续显式执行授权的审批依据）。
    const validity = await s.validity();
    expect(validity).toMatchObject({
      valid: true,
      reason: 'approved',
      planDigest: s.planDigest,
      checkPolicyDigest: EXPECTED_POLICY_DIGEST,
    });
    expect(validity.currentDecisionId).toBe(s.approvalsRows()[0]?.id);
    // 批准不是启动授权：不创建任何执行实体（P03-3 / F-002 起执行域表已由迁移 v9
    // 建立但为空；attempts 等后续表仍未建立）。
    expect(s.probe.tableExists('runs')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 0 }]);
    expect(s.probe.tableExists('attempts')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM attempts')).toEqual([{ n: 0 }]);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual([{ n: 0 }]);
  });

  it('双方均未配置 verification 段：绑定显式缺席形态摘要（确定性）', async () => {
    const s = await setup();
    // 全局移除 verification 政策（保留策略段）。
    const cleared = await s.submit(
      {
        schemaVersion: 2,
        strategies: GLOBAL_SETTINGS_PAYLOAD.strategies,
      },
      'settings.global.update',
      { scope: { kind: 'global' }, expectedRevision: s.globalSettingsRevision() },
    );
    expect(cleared.status).toBe('completed');
    const absentDigest = computeFeatureCheckPolicyDigest(undefined);
    const receipt = await s.decide('approve');
    expect(receipt.status).toBe('completed');
    expect(s.approvalsRows()[0]?.check_policy_digest).toBe(absentDigest);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved', checkPolicyDigest: absentDigest });
  });
});

/* ------------------------------------------------------------------ *
 * 实质要求/验收/依赖变化使旧批准失效（独立测试组）
 * ------------------------------------------------------------------ */

describe('F-003 实质计划变化令旧批准失效（要求/验收/依赖）', () => {
  /** 批准后实质修订 → 旧批准失效 → 重批当前身份恢复的公共流程断言。 */
  async function expectSubstantiveRevisionInvalidates(
    s: VerificationSetup,
    revisedPlan: Record<string, unknown>,
  ): Promise<void> {
    expect((await s.decide('approve')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });
    const digestBefore = s.planDigest;

    const revised = await s.revise(revisedPlan);
    expect(revised.status).toBe('completed');
    const digestAfter = s.featureRow()?.plan_digest as string;
    expect(digestAfter).not.toBe(digestBefore);
    expect(s.featureRow()).toMatchObject({ plan_status: 'draft' });

    // 旧批准失去执行效力：明确过期原因；旧决策证据保留（行不改写）。
    const validity = await s.validity();
    expect(validity).toMatchObject({
      valid: false,
      reason: 'plan_changed',
      planDigest: digestAfter,
      checkPolicyDigest: EXPECTED_POLICY_DIGEST,
    });
    expect(validity.currentDecisionId).toBe(s.approvalsRows()[0]?.id);
    const rows = s.approvalsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_digest: digestBefore, status: 'approved' });

    // 重新批准当前身份（新摘要）后才能通过核验。
    const reapproved = await s.decide('approve', { digest: digestAfter });
    expect(reapproved.status).toBe('completed');
    expect(s.approvalsRows()).toHaveLength(2);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved', planDigest: digestAfter });
  }

  it('验收变化：修订 acceptance 使旧批准失效', async () => {
    const s = await setup();
    await expectSubstantiveRevisionInvalidates(
      s,
      buildPlan({ src: s.artifactSrcId, req: s.artifactReqId }, [
        { id: 't-1', title: '任务一', complexity: 'low', criteria: ['任务一验收'], requirementsRefs: [{ artifactId: s.artifactReqId }] },
        { id: 't-2', title: '任务二', complexity: 'medium', criteria: ['任务二验收——更严格的完成口径'], dependsOn: ['t-1'] },
        { id: 't-3', title: '任务三', criteria: ['任务三验收'], dependsOn: ['t-2'] },
      ]),
    );
  });

  it('需求变化：修订 requirementsRefs 使旧批准失效', async () => {
    const s = await setup();
    await expectSubstantiveRevisionInvalidates(
      s,
      buildPlan({ src: s.artifactSrcId, req: s.artifactReqId }, [
        // t-1 移除需求引用（实质要求变化）。
        { id: 't-1', title: '任务一', complexity: 'low', criteria: ['任务一验收'] },
        { id: 't-2', title: '任务二', complexity: 'medium', criteria: ['任务二验收'], dependsOn: ['t-1'] },
        { id: 't-3', title: '任务三', criteria: ['任务三验收'], dependsOn: ['t-2'] },
      ]),
    );
  });

  it('依赖变化：修订 dependsOn 使旧批准失效', async () => {
    const s = await setup();
    await expectSubstantiveRevisionInvalidates(
      s,
      buildPlan({ src: s.artifactSrcId, req: s.artifactReqId }, [
        { id: 't-1', title: '任务一', complexity: 'low', criteria: ['任务一验收'], requirementsRefs: [{ artifactId: s.artifactReqId }] },
        // t-3 改为直接依赖 t-1（依赖边实质变化）。
        { id: 't-2', title: '任务二', complexity: 'medium', criteria: ['任务二验收'], dependsOn: ['t-1'] },
        { id: 't-3', title: '任务三', criteria: ['任务三验收'], dependsOn: ['t-1'] },
      ]),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 检查政策变化使旧批准失效与重新批准（独立测试组）
 * ------------------------------------------------------------------ */

describe('F-003 检查政策变化令旧批准失效（项目覆盖与全局继承）', () => {
  it('项目 verification 覆盖变化 → check_policy_changed；planStatus 证据保留；重批当前身份恢复', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');
    expect(s.approvalsRows()).toHaveLength(1);

    // 项目覆盖检查政策：requireChecksBeforeDone true → false。
    const updated = await s.submit(
      {
        schemaVersion: 2,
        strategies: PROJECT_SETTINGS_PAYLOAD.strategies,
        policies: { verification: { requireChecksBeforeDone: false } },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.projectSettingsRevision() },
    );
    expect(updated.status).toBe('completed');

    // 旧批准失去执行效力：明确过期原因；planStatus/决策行证据不回写改写。
    const newPolicyDigest = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false });
    const validity = await s.validity();
    expect(validity).toMatchObject({
      valid: false,
      reason: 'check_policy_changed',
      planDigest: s.planDigest,
      checkPolicyDigest: newPolicyDigest,
    });
    expect(validity.currentDecisionId).toBe(s.approvalsRows()[0]?.id);
    expect(s.featureRow()).toMatchObject({ plan_status: 'approved', plan_digest: s.planDigest });
    expect(s.approvalsRows()).toHaveLength(1);
    expect(s.approvalsRows()[0]).toMatchObject({
      subject_digest: s.planDigest,
      check_policy_digest: EXPECTED_POLICY_DIGEST,
      status: 'approved',
    });

    // 重新批准当前身份（同一 planDigest + 新检查政策）：新决策行，旧行保留。
    const reapproved = await s.decide('approve');
    expect(reapproved.status).toBe('completed');
    const rows = s.approvalsRows();
    expect(rows).toHaveLength(2);
    // 决策行按绑定身份定位（同一注入时钟下 decided_at 相同，不依赖行序）。
    const oldRow = rows.find((row) => row.check_policy_digest === EXPECTED_POLICY_DIGEST);
    const newRow = rows.find((row) => row.check_policy_digest === newPolicyDigest);
    expect(oldRow).toMatchObject({ subject_digest: s.planDigest, status: 'approved' });
    expect(newRow).toMatchObject({ subject_digest: s.planDigest, status: 'approved' });
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved', checkPolicyDigest: newPolicyDigest });

    // 同身份重复决策仍 fail-closed（两个竞争决定最多一个生效）。
    const duplicate = await s.decide('reject');
    expect(duplicate.status).toBe('rejected');
    if (duplicate.status !== 'rejected') {
      throw new Error('expected rejected');
    }
    expect(duplicate.error.details).toMatchObject({ reason: 'approval_already_decided' });
    expect(s.approvalsRows()).toHaveLength(2);
  });

  it('全局 verification 变化（项目继承）→ check_policy_changed；v7 遗留 NULL 绑定同', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');

    // 全局检查政策变化（项目无覆盖 → 继承全局）。
    const updated = await s.submit(
      {
        schemaVersion: 2,
        strategies: GLOBAL_SETTINGS_PAYLOAD.strategies,
        policies: { verification: { requireChecksBeforeDone: false } },
      },
      'settings.global.update',
      { scope: { kind: 'global' }, expectedRevision: s.globalSettingsRevision() },
    );
    expect(updated.status).toBe('completed');
    expect(await s.validity()).toMatchObject({
      valid: false,
      reason: 'check_policy_changed',
      checkPolicyDigest: computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false }),
    });

    // 重批当前身份恢复有效。
    expect((await s.decide('approve')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });

    // 模拟 v7 遗留行（无检查政策绑定）：NULL 不等于任何当前身份，fail-closed。
    s.harness.session.transactWrite('test.legacy-null-binding', (db) => {
      db.prepare('UPDATE approvals SET check_policy_digest = NULL').run();
    });
    const legacyValidity = await s.validity();
    expect(legacyValidity.valid).toBe(false);
    expect(legacyValidity.reason).toBe('check_policy_changed');
    // 遗留行不与新决策身份冲突：可重新批准当前身份。
    expect((await s.decide('approve')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });
  });
});

/* ------------------------------------------------------------------ *
 * 纯标签变化与默认路由变化不使批准失效（独立测试组）
 * ------------------------------------------------------------------ */

describe('F-003 纯标签/默认路由/Task 策略修订不使批准失效', () => {
  it('纯标签 CAS 更新（Feature/Task/Phase）不改变业务摘要、不使有效批准失效', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });

    // Feature 纯标签编辑（实体自身 revision CAS）。
    const featureLabels = await s.submit(
      { entityType: 'feature', id: s.featureId, labels: ['needs-review'] },
      'plan.labels.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.featureRevision() },
    );
    expect(featureLabels.status).toBe('completed');
    // Task 纯标签编辑。
    const taskLabels = await s.submit(
      { entityType: 'task', id: 't-1', labels: ['fast-lane'] },
      'plan.labels.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.taskRevision('t-1') },
    );
    expect(taskLabels.status).toBe('completed');
    // Phase 纯标签编辑。
    const phaseLabels = await s.submit(
      { entityType: 'phase', id: 'phase-1', labels: ['milestone'] },
      'plan.labels.update',
      {
        scope: { kind: 'project', projectId: s.projectId },
        expectedRevision: s.probe.selectOne<{ revision: number }>(
          'SELECT revision FROM phases WHERE id = ?', ['phase-1'],
        )?.revision ?? -1,
      },
    );
    expect(phaseLabels.status).toBe('completed');

    // 业务摘要与批准有效性不变（服务返回结果断言，不只是摘要字符串）。
    expect(s.featureRow()?.plan_digest).toBe(s.planDigest);
    expect(s.featureRow()?.plan_status).toBe('approved');
    expect(s.approvalsRows()).toHaveLength(1);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved', planDigest: s.planDigest });
  });

  it('项目默认 modelMap 变化不追溯 Task 策略、不使批准失效；Task 策略修订同样不触及批准身份', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');
    const taskRowBefore = s.probe.selectOne<Record<string, unknown>>(
      'SELECT execution_config, config_source, revision FROM tasks WHERE id = ?',
      ['t-1'],
    );

    // 项目默认路由变化（modelMap.low 换模型）。
    const rerouted = await s.submit(
      {
        schemaVersion: 2,
        strategies: {
          modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.projectSettingsRevision() },
    );
    expect(rerouted.status).toBe('completed');
    // 不追溯：Task 策略副本逐字段不变；批准仍有效。
    expect(
      s.probe.selectOne<Record<string, unknown>>(
        'SELECT execution_config, config_source, revision FROM tasks WHERE id = ?',
        ['t-1'],
      ),
    ).toEqual(taskRowBefore);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });

    // Task 实际策略修订（task.strategy.update）：与需求/检查身份可区分，
    // 不使批准失效（按已确认策略编辑规则捕获下一份输入，不改写批准历史）。
    const edited = await s.submit(
      {
        taskId: 't-1',
        executionConfig: {
          schemaVersion: 2,
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          credentialRef: 'ref://keychain/pi-anthropic',
        },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.taskRevision('t-1') },
    );
    expect(edited.status).toBe('completed');
    expect(s.featureRow()?.plan_digest).toBe(s.planDigest);
    expect(s.approvalsRows()).toHaveLength(1);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });
  });
});

/* ------------------------------------------------------------------ *
 * 未批准/拒绝/不一致均 fail-closed（核验服务与查询同一权威视图）
 * ------------------------------------------------------------------ */

describe('F-003 核验服务 fail-closed（未批准/拒绝/不一致）', () => {
  it('未批准 → not_approved；当前身份拒绝 → rejected；事务内核验与查询一致', async () => {
    const s = await setup();
    // 未批准。
    expect(await s.validity()).toMatchObject({
      valid: false,
      reason: 'not_approved',
      planDigest: s.planDigest,
      checkPolicyDigest: EXPECTED_POLICY_DIGEST,
    });
    // 事务内核验（P03-3/4 复用入口）：同一权威视图，同一结论。
    const inTx = s.verifyInTransaction();
    expect(inTx.validity).toMatchObject({ valid: false, reason: 'not_approved' });
    expect(inTx.currentDecision).toBeNull();

    // 拒绝：决策记录 rejected + planStatus draft；核验 rejected。
    expect((await s.decide('reject')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: false, reason: 'rejected' });
    const rejectedInTx = s.verifyInTransaction();
    expect(rejectedInTx.validity).toMatchObject({ valid: false, reason: 'rejected' });
    expect(rejectedInTx.currentDecision).toMatchObject({ checkPolicyDigest: EXPECTED_POLICY_DIGEST });
    // 拒绝事实不是批准：planStatus 权威为 draft。
    expect(s.featureRow()?.plan_status).toBe('draft');
  });

  it('planStatus=approved 但无当前身份 approved 决策 → approval_state_inconsistent（防御 fail-closed）', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');
    // 模拟不一致现场：删除唯一决策行但保留 planStatus=approved（正常命令通道
    // 不可达；白盒构造验证核验服务不把 planStatus 单独当批准依据）。
    s.harness.session.transactWrite('test.inconsistent-state', (db) => {
      db.prepare('DELETE FROM approvals').run();
    });
    expect(await s.validity()).toMatchObject({ valid: false, reason: 'approval_state_inconsistent' });
    expect(s.verifyInTransaction().validity).toMatchObject({
      valid: false,
      reason: 'approval_state_inconsistent',
    });
  });

  it('事务内核验的项目归属把关：缺失/跨项目目标抛出（不泄漏存在性）', async () => {
    const s = await setup();
    expect((await s.decide('approve')).status).toBe('completed');
    // 缺失 Feature。
    let missing: unknown;
    try {
      s.store.transact('test.verify.missing', (transaction) =>
        verifyFeaturePlanApprovalInTransaction(transaction, s.projectId, 'f-missing'),
      );
    } catch (error) {
      missing = error;
    }
    expect(isStorageError(missing, 'not_found')).toBe(true);
    // 跨项目：以其他项目 ID 核验本 Feature（不存在于该项目 → not_found/ownership）。
    let crossProject: unknown;
    try {
      s.store.transact('test.verify.cross-project', (transaction) =>
        verifyFeaturePlanApprovalInTransaction(transaction, 'proj-other', s.featureId),
      );
    } catch (error) {
      crossProject = error;
    }
    expect(
      isStorageError(crossProject, 'not_found') || isStorageError(crossProject, 'ownership'),
      `实际 ${String(crossProject)}`,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 竞争与事务纪律（政策变更与批准竞争；失败无半成功）
 * ------------------------------------------------------------------ */

describe('F-003 政策变更与批准竞争（同一写事务绑定当前身份）', () => {
  it('决策绑定提交时当前检查政策（政策更新后的决定不携带旧身份）', async () => {
    const s = await setup();
    // 政策先更新为 false，再提交批准：决策必须绑定新身份（旧视图不得提交）。
    const updated = await s.submit(
      {
        schemaVersion: 2,
        strategies: PROJECT_SETTINGS_PAYLOAD.strategies,
        policies: { verification: { requireChecksBeforeDone: false } },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: s.projectSettingsRevision() },
    );
    expect(updated.status).toBe('completed');
    const newPolicyDigest = computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: false });
    expect((await s.decide('approve')).status).toBe('completed');
    expect(s.approvalsRows()[0]?.check_policy_digest).toBe(newPolicyDigest);
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved', checkPolicyDigest: newPolicyDigest });
  });

  it('决策事务失败（回执注入点故障）整组回滚：无决策行、planStatus 不变、核验仍为未批准', async () => {
    const s = await setup();
    const faultHandle = s.harness.installFault(WRITE_FAULT_POINTS.commandReceiptsBeforeInsert);
    const error = await s.decide('approve').catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'feature.plan.decide' });
    faultHandle.remove();
    // 整组回滚：无半条有效批准。
    expect(s.approvalsRows()).toHaveLength(0);
    expect(s.featureRow()).toMatchObject({ plan_status: 'draft', revision: 1 });
    expect(await s.validity()).toMatchObject({ valid: false, reason: 'not_approved' });
    // 故障清除后同一命令面可正常完成（不遗留半成功状态）。
    expect((await s.decide('approve')).status).toBe('completed');
    expect(await s.validity()).toMatchObject({ valid: true, reason: 'approved' });
  });
});

/* ------------------------------------------------------------------ *
 * 迁移 v8：v7 遗留库升级（决策行保留、NULL 绑定 fail-closed）
 * ------------------------------------------------------------------ */

describe('F-003 迁移 v8（approvals.check_policy_digest）', () => {
  it('v7 库（含既设计划决策行）升级 v8：行逐字段保留、check_policy_digest=NULL，核验 fail-closed', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-p032-f003-v7-' });
    const box = fixture;
    const session = openSqliteStorageSession({ path: box.dbPath });
    try {
      // 先迁移到 v7 并种入真实项目/计划/决策行（v7 形态：无 check_policy_digest）。
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 7), nowUtcMs: () => NOW });
      session.transactWrite('fixture.v7', (db) => {
        db.prepare(
          'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) ' +
            "VALUES ('proj-v7', ?, 1, ?, 'v7 项目', 'active', '[]')",
        ).run(NOW, NOW);
        db.prepare(
          'INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) ' +
            "VALUES ('phase-v7', ?, 'proj-v7', 1, ?, '阶段', 'open', '[]')",
        ).run(NOW, NOW);
        db.prepare(
          'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs, plan_digest) ' +
            "VALUES ('feature-v7', ?, 'proj-v7', 2, ?, 'phase-v7', '特性', 'draft', 'approved', '[]', '[]', ?)",
        ).run(NOW, NOW, 'ab'.repeat(32));
        db.prepare(
          'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, labels, acceptance, requirements_refs, execution_config, config_source) ' +
            "VALUES ('t-v7', ?, 'proj-v7', 1, ?, 'feature-v7', '任务', 'pending', '[]', ?, '[]', ?, 'project_default')",
        ).run(
          NOW,
          NOW,
          JSON.stringify({ criteria: ['验收一'] }),
          JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
        );
        db.prepare(
          'INSERT INTO approvals (id, created_at, project_id, revision, updated_at, subject_type, subject_id, subject_digest, status, decision_actor, reason, decided_at) ' +
            "VALUES ('ap-v7', ?, 'proj-v7', 1, ?, 'feature_plan', 'feature-v7', ?, 'approved', 'local-owner', 'v7 批准', ?)",
        ).run(NOW, NOW, 'ab'.repeat(32), NOW);
      });

      const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW + 1_000 });
      expect(result.fromVersion).toBe(7);
      // P03-3 / F-002 起接续 v9（执行域三表；v8 仍为检查政策身份绑定迁移）。
      expect(result.toVersion).toBe(28);
      expect(result.appliedVersions).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);

      // 既有决策行逐字段保留；check_policy_digest 为 NULL（不等于任何当前身份）。
      const row = session.database
        .prepare<[string], Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?')
        .get('ap-v7');
      expect(row).toMatchObject({
        project_id: 'proj-v7',
        subject_id: 'feature-v7',
        subject_digest: 'ab'.repeat(32),
        status: 'approved',
        decision_actor: 'local-owner',
        reason: 'v7 批准',
        decided_at: NOW,
        check_policy_digest: null,
      });

      // 同一权威读视图：v7 遗留批准 fail-closed（check_policy_changed，需重新批准）。
      const planAccess = createSqlitePlanAccess(session, { nowUtcMs: () => NOW });
      const view = planAccess.readFeatureApprovalsView('feature-v7');
      expect(view?.approvals[0]?.checkPolicyDigest).toBeNull();
      const currentDigest = resolveCurrentCheckPolicyDigest(view?.settings.global ?? null, view?.settings.project ?? null);
      const validity = evaluatePlanApprovalValidity({
        planDigest: view?.feature.planDigest ?? null,
        planStatus: view?.feature.planStatus ?? 'draft',
        taskCount: view?.taskCount ?? 0,
        decisions: view?.approvals ?? [],
        currentCheckPolicyDigest: currentDigest,
      });
      expect(validity).toMatchObject({ valid: false, reason: 'check_policy_changed' });
    } finally {
      session.close();
    }
  });
});
