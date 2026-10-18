/**
 * F-005 可信 principal 授权纯契约测试（Core 应用层授权，不经 HTTP）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md §4：
 * - §4.1 principal 唯一可信来源是 Host/测试可信装配；请求信封/查询中的
 *   actorId/principal/capabilities/scope 提权字段在 F-002 已按未知键拒绝，
 *   本层绝不从请求数据取身份；
 * - §4.2 TrustedPrincipal 结构（principalId/capabilities/projectScope）与
 *   F-004 测试夹具 TestTrustedPrincipal 逐字段结构兼容（可直接赋值）；
 * - §4.3 操作授权矩阵：命令按 COMMAND_OPERATION_SPECS 能力 + 项目可见性；
 *   全局配置读写独立授权（项目能力不蕴含全局）；项目配置读 = project.read 或
 *   settings.project.read；回执/结果只读本 principal（越权一律 not_found，
 *   不区分不存在与无权）；事件订阅 = events.read + 范围对应读能力；
 * - §4 不变量：授权检查在 Core 应用层（本套件全部直接调用，不经 HTTP）；
 *   projectId 只是目标选择不扩大权限；重放/历史回执重新核验当前身份/权限；
 *   可见范围谓词下推（先收窄再分页/计数）；全局事件不泄漏给项目级主体；
 *   拒绝响应不回显不可见项目的名称/路径/配置/repoIdentity。
 *
 * 授权函数为纯判定：失败即抛 PublicError，不触碰任何持久状态（「失败时
 * 实际项目/配置及事件不变」由纯度与真实数据根探针共同固定）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_CAPABILITIES,
  LOCAL_OWNER_PRINCIPAL_ID,
  PublicError,
  isPublicError,
  isUuidV4,
  validateCommandEnvelope,
  type AppCapability,
  type CommandScope,
  type PublicErrorCode,
  type ValidatedCommandEnvelope,
} from '../../../packages/core/src/ports/commands.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import type { PublicEventScope } from '../../../packages/core/src/ports/events.ts';
import {
  EVENTS_SUBSCRIBE_OPERATION,
  QUERY_OPERATIONS,
  assertTrustedPrincipal,
  authorizeCommand,
  authorizeCommandReplay,
  authorizeEventSubscription,
  authorizeGlobalSettingsRead,
  authorizeProjectLabelCounts,
  authorizeProjectRead,
  authorizeProjectSettingsRead,
  authorizeProjectsList,
  authorizeReceiptRead,
  authorizeReceiptScopeVisibility,
  authorizeResultResolution,
  authorizeSnapshot,
  createEventVisibilityFilter,
  createLocalOwnerPrincipal,
  hasCapability,
  isProjectVisible,
  mapProjectLookupError,
  principalProjectVisibility,
  requireAnyCapability,
  requireCapability,
  requireProjectVisible,
  type TrustedPrincipal,
} from '../../../packages/core/src/ports/authorization.ts';
import {
  createRestrictedPrincipal,
  createLocalOwnerPrincipal as createFixtureLocalOwner,
  scopeAllowlist,
} from '../../helpers/p02-2/principals.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from '../../helpers/p02-2/commands-fixture.ts';

const PROJECT_A = '12345678-1234-4123-8234-1234567890ab';
const PROJECT_B = '12345678-1234-4123-8234-1234567890cd';
const PROJECT_C = '12345678-1234-4123-8234-1234567890ef';
const COMMAND_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ISSUED_AT = '2026-10-08T00:00:00.000Z';
const RESTRICTED_ID = 'test-restricted:bbbbbbbb-2222-4333-9444-555555555555';

function owner(): TrustedPrincipal {
  return createLocalOwnerPrincipal();
}

/** 受限主体：显式能力 + 显式可见范围（无产品默认模板）。 */
function restricted(
  capabilities: readonly AppCapability[],
  projectIds: readonly string[] = [PROJECT_A],
  principalId: string = RESTRICTED_ID,
): TrustedPrincipal {
  return createRestrictedPrincipal({
    capabilities,
    projectScope: scopeAllowlist(projectIds),
    principalId,
  });
}

function scopeAllPrincipal(capabilities: readonly AppCapability[]): TrustedPrincipal {
  return createRestrictedPrincipal({
    capabilities,
    projectScope: { kind: 'all' },
  });
}

function expectPublicError(
  fn: () => unknown,
  expected: { readonly code: PublicErrorCode; readonly operation: string; readonly reason?: string },
): PublicError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicError);
    const publicError = error as PublicError;
    expect(publicError.code).toBe(expected.code);
    expect(publicError.operation).toBe(expected.operation);
    if (expected.reason !== undefined) {
      expect(publicError.details?.reason).toBe(expected.reason);
    }
    return publicError;
  }
  throw new Error(`预期抛出 ${expected.code}，但调用成功返回`);
}

function envelope(
  operation: ValidatedCommandEnvelope['operation'],
  scope: CommandScope,
  expectedRevision: number | null,
): ValidatedCommandEnvelope {
  const base = {
    schemaVersion: 5 as const,
    commandId: COMMAND_ID,
    issuedAt: ISSUED_AT,
    expiresAt: null,
  };
  switch (operation) {
    case 'execution.attempt.cancel':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: null, payload: { attemptId: 'attempt-1' } };
    case 'execution.pause':
    case 'execution.cancel':
    case 'execution.resume':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: expectedRevision ?? 1, payload: { runId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf2', batchId: null } };
    case 'task.approval.block':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: expectedRevision ?? 1, payload: { taskId: 't-1', planDigest: '0'.repeat(64) } };
    case 'task.approval.approve':
    case 'task.approval.reject':
    case 'task.approval.unblock':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: expectedRevision ?? 1,
        payload: { taskId: 't-1', itemId: 'i-1', planDigest: '0'.repeat(64), codeDigest: '0'.repeat(64), artifactRefs: [], reason: null } };
    case 'feature.verification.continue':
    case 'git.operation.reconcile':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: expectedRevision ?? 1, payload: { featureId: 'f-1', runId: 'run-1', batchId: 'batch-1', operationId: COMMAND_ID } };
    case 'task.verification.continue':
      return { ...base, operation, scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: expectedRevision ?? 1,
        payload: { taskId: 't-1', attemptId: 'attempt-1', verificationBatchId: 'batch-1', codeDigest: '0'.repeat(64),
          observationDigest: '0'.repeat(64) } };
    case 'baseline.preview':
      return {
        ...base,
        operation,
        scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: null,
        payload: { plan: { checks: [] } },
      } as ValidatedCommandEnvelope;
    case 'baseline.run':
      return {
        ...base,
        operation,
        scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: null,
        payload: { decision: 'authorize', plan: { checks: [] }, previewDigest: '0'.repeat(64) },
      } as ValidatedCommandEnvelope;
    case 'baseline.cancel':
      return {
        ...base,
        operation,
        scope: { kind: 'project', projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
        expectedRevision: null,
        payload: { operationId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
      } as ValidatedCommandEnvelope;
    case 'project.register':
      return {
        ...base,
        operation,
        scope: { kind: 'registration' },
        expectedRevision: null,
        payload: { repositoryPath: '/tmp/never-touched-by-authorization', displayName: 'x', description: null, labels: [] },
      };
    case 'project.metadata.update':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: { displayName: '新名称' },
      } as ValidatedCommandEnvelope;
    case 'settings.global.create':
    case 'settings.global.update':
      return {
        ...base,
        operation,
        scope: { kind: 'global' },
        expectedRevision,
        payload: { schemaVersion: 2 },
      } as ValidatedCommandEnvelope;
    case 'settings.project.create':
    case 'settings.project.update':
      return {
        ...base,
        operation,
        scope,
        expectedRevision,
        payload: { schemaVersion: 2 },
      } as ValidatedCommandEnvelope;
    case 'phase.create':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: { id: 'phase-1', title: '阶段', description: null, labels: [] },
      } as ValidatedCommandEnvelope;
    case 'feature.plan.import':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: 1,
        payload: { phaseId: 'phase-1', plan: { schemaVersion: 1, feature: { title: 'F' }, tasks: [] } },
      } as ValidatedCommandEnvelope;
    case 'plan.labels.update':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: { entityType: 'phase', id: 'phase-1', labels: [] },
      } as ValidatedCommandEnvelope;
    case 'feature.plan.revise':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: {
          featureId: 'f-1',
          plan: { schemaVersion: 1, feature: { title: 'F' }, tasks: [] },
        },
      } as ValidatedCommandEnvelope;
    case 'task.strategy.update':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: {
          taskId: 't-1',
          executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        },
      } as ValidatedCommandEnvelope;
    case 'feature.plan.decide':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: {
          featureId: 'f-1',
          planDigest: 'ab'.repeat(32),
          decision: 'approve',
        },
      } as ValidatedCommandEnvelope;
    case 'execution.input.prepare':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: {
          featureId: 'f-1',
          taskId: 't-1',
          items: [],
        },
      } as ValidatedCommandEnvelope;
    case 'execution.preview':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: {
          featureIds: ['f-1'],
          budget: {
            batch: {
              maxRuns: 1,
              maxTotalAttempts: 3,
              maxRuntimeStarts: 3,
              maxNoProgressRuns: 1,
              deadlineUtcMs: 1_900_000_000_000,
            },
            run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
          },
        },
      } as ValidatedCommandEnvelope;
    case 'execution.start':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: {
          featureIds: ['f-1'],
          budget: {
            batch: {
              maxRuns: 1,
              maxTotalAttempts: 3,
              maxRuntimeStarts: 3,
              maxNoProgressRuns: 1,
              deadlineUtcMs: 1_900_000_000_000,
            },
            run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
          },
          previewDigest: 'ab'.repeat(32),
          retryBatchId: null,
        },
      } as ValidatedCommandEnvelope;
    case 'execution.retryFinal':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: {
          featureId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf3',
          historicalRunId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf4',
          workKey: 'ab'.repeat(32),
        },
      } as ValidatedCommandEnvelope;
    case 'execution.budget.revise':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: expectedRevision ?? 1,
        payload: {
          batchId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1',
          budget: {
            batch: {
              maxRuns: 2,
              maxTotalAttempts: 3,
              maxRuntimeStarts: 3,
              maxNoProgressRuns: 1,
              deadlineUtcMs: 1_900_000_000_000,
            },
            run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
          },
          reason: '显式增额',
        },
      } as ValidatedCommandEnvelope;
    case 'workspace.discard':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: { workspaceId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
      } as ValidatedCommandEnvelope;
    case 'workspace.discard.preview':
      return {
        ...base,
        operation,
        scope,
        expectedRevision: null,
        payload: { featureId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1' },
      } as ValidatedCommandEnvelope;
  }
}

const COMMANDS_MATRIX = [
  { operation: 'project.register', scope: { kind: 'registration' }, revision: null, capability: 'project.register' },
  { operation: 'project.metadata.update', scope: { kind: 'project', projectId: PROJECT_A }, revision: 2, capability: 'project.metadata.write' },
  { operation: 'settings.global.create', scope: { kind: 'global' }, revision: null, capability: 'settings.global.write' },
  { operation: 'settings.global.update', scope: { kind: 'global' }, revision: 4, capability: 'settings.global.write' },
  { operation: 'settings.project.create', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'settings.project.write' },
  { operation: 'settings.project.update', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'settings.project.write' },
  // P03-1 / F-004：Phase 创建（project scope + phase.write）。
  { operation: 'phase.create', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'phase.write' },
  // P03-1 / F-005：计划导入（project scope + feature.plan.import；expectedRevision 为 Phase 聚合 CAS）。
  { operation: 'feature.plan.import', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'feature.plan.import' },
  // P03-1 / F-007：纯标签 CAS 编辑（project scope + plan.labels.write；expectedRevision 为目标实体自身 revision）。
  { operation: 'plan.labels.update', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'plan.labels.write' },
  // P03-1 / F-008：实质计划修订（project scope + feature.plan.revise；expectedRevision 为 Feature 聚合 CAS）。
  { operation: 'feature.plan.revise', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'feature.plan.revise' },
  // P03-2 / F-001：Task 策略副本 CAS 编辑（project scope + task.strategy.write；expectedRevision 为目标 Task 自身 revision）。
  { operation: 'task.strategy.update', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'task.strategy.write' },
  // P03-2 / F-002：计划批准/拒绝决策（project scope + feature.plan.decide；expectedRevision 为 Feature 聚合 CAS）。
  { operation: 'feature.plan.decide', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'feature.plan.decide' },
  // P03-2 / F-006：执行输入制品组准备（project scope + execution.input.prepare；创建类不携带 expectedRevision）。
  { operation: 'execution.input.prepare', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'execution.input.prepare' },
  // P03-3 / F-004：单 Feature 执行 prepare 预览（project scope + execution.start；
  // 只读预览不携带 expectedRevision）。
  { operation: 'execution.preview', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'execution.start' },
  // P03-3 / F-005：显式执行启动（project scope + execution.start；创建类不携带
  // expectedRevision；与预览共享授权面）。
  { operation: 'execution.start', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'execution.start' },
  // P03-9 / F-010：finalization-only retryFinal（project scope + execution.start；
  // 创建类不携带 expectedRevision；父 Batch revision 在事务内重核）。
  { operation: 'execution.retryFinal', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'execution.start' },
  // P03-3 / F-009：批次预算显式修订（project scope + execution.budget.revise；
  // 更新类 expectedRevision=目标 Batch 当前 budget_revision；增额/延期授权面
  // 与启动能力分离）。
  { operation: 'execution.budget.revise', scope: { kind: 'project', projectId: PROJECT_A }, revision: 1, capability: 'execution.budget.revise' },
  // P03-5 / F-010：人工丢弃确认（project scope + workspace.discard；创建类不携带
  // expectedRevision，预览绑定与 revision CAS 由应用层重核）。
  { operation: 'workspace.discard', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'workspace.discard' },
  // P03-5 / F-011：人工丢弃预览（同一能力位；创建类，payload 深校验在应用层）。
  { operation: 'workspace.discard.preview', scope: { kind: 'project', projectId: PROJECT_A }, revision: null, capability: 'workspace.discard' },
] as const;

describe('F-005 TrustedPrincipal 产品构造与可信装配形状断言', () => {
  it('产品 local-owner：固定 id、全部冻结能力、scope all，整体冻结', () => {
    const principal = createLocalOwnerPrincipal();
    expect(principal.principalId).toBe(LOCAL_OWNER_PRINCIPAL_ID);
    expect(principal.capabilities.size).toBe(APP_CAPABILITIES.length);
    for (const capability of APP_CAPABILITIES) {
      expect(principal.capabilities.has(capability)).toBe(true);
    }
    expect(principal.projectScope).toEqual({ kind: 'all' });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.projectScope)).toBe(true);
    // Object.freeze 对 Set 内部槽无效，产品必须真正拒绝 add/delete/clear。
    const mutable = principal.capabilities as Set<AppCapability>;
    expect(() => mutable.add('project.register')).toThrow(TypeError);
    expect(() => mutable.delete('project.read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(principal.capabilities.size).toBe(APP_CAPABILITIES.length);
  });

  it('产品 local-owner 与 F-004 夹具主体互相通过形状断言（结构兼容可直接赋值）', () => {
    const product: TrustedPrincipal = createLocalOwnerPrincipal();
    const fixtureOwner: TrustedPrincipal = createFixtureLocalOwner();
    const fixtureRestricted: TrustedPrincipal = restricted(['project.read']);
    const fixtureScopeAll: TrustedPrincipal = scopeAllPrincipal(['events.read']);
    const emptyCaps: TrustedPrincipal = createRestrictedPrincipal({
      capabilities: [],
      projectScope: scopeAllowlist([PROJECT_A]),
    });
    for (const principal of [product, fixtureOwner, fixtureRestricted, fixtureScopeAll, emptyCaps]) {
      expect(() => assertTrustedPrincipal(principal)).not.toThrow();
    }
  });

  const INVALID_PRINCIPALS: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'local-owner'],
    ['缺 principalId', { capabilities: new Set(), projectScope: { kind: 'all' } }],
    ['缺 capabilities', { principalId: 'x', projectScope: { kind: 'all' } }],
    ['缺 projectScope', { principalId: 'x', capabilities: new Set() }],
    [
      '多余键（提权字段不进入可信结构）',
      { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'all' }, actorId: 'mallory' },
    ],
    ['principalId 空串', { principalId: '', capabilities: new Set(), projectScope: { kind: 'all' } }],
    ['principalId 前后空白', { principalId: ' owner ', capabilities: new Set(), projectScope: { kind: 'all' } }],
    ['principalId 含控制字符', { principalId: 'ow\u0007ner', capabilities: new Set(), projectScope: { kind: 'all' } }],
    ['principalId 超长', { principalId: 'p'.repeat(129), capabilities: new Set(), projectScope: { kind: 'all' } }],
    ['capabilities 为数组', { principalId: 'x', capabilities: ['project.read'], projectScope: { kind: 'all' } }],
    ['capabilities 为普通对象', { principalId: 'x', capabilities: { 'project.read': true }, projectScope: { kind: 'all' } }],
    [
      '未知能力',
      { principalId: 'x', capabilities: new Set(['project.read', 'work.execute']), projectScope: { kind: 'all' } },
    ],
    [
      '能力数超过冻结清单',
      {
        principalId: 'x',
        capabilities: new Set([...APP_CAPABILITIES, 'extra.capability']),
        projectScope: { kind: 'all' },
      },
    ],
    [
      'size 与迭代条目不一致（伪造集合）',
      {
        principalId: 'x',
        capabilities: {
          has: () => true,
          size: 1,
          *[Symbol.iterator]() {
            yield 'project.read';
            yield 'project.register';
          },
        },
        projectScope: { kind: 'all' },
      },
    ],
    [
      '伪造集合含重复能力',
      {
        principalId: 'x',
        capabilities: {
          has: () => true,
          size: 2,
          *[Symbol.iterator]() {
            yield 'project.read';
            yield 'project.read';
          },
        },
        projectScope: { kind: 'all' },
      },
    ],
    ['projectScope 非对象', { principalId: 'x', capabilities: new Set(), projectScope: 'all' }],
    ['projectScope 未知 kind', { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'everything' } }],
    [
      'all scope 带多余 projectIds',
      { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'all', projectIds: [PROJECT_A] } },
    ],
    [
      'allowlist 缺 projectIds',
      { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'allowlist' } },
    ],
    [
      'allowlist 空数组（可见范围必须显式）',
      { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'allowlist', projectIds: [] } },
    ],
    [
      'allowlist 非 UUID',
      { principalId: 'x', capabilities: new Set(), projectScope: { kind: 'allowlist', projectIds: ['proj-1'] } },
    ],
    [
      'allowlist 重复项目',
      {
        principalId: 'x',
        capabilities: new Set(),
        projectScope: { kind: 'allowlist', projectIds: [PROJECT_A, PROJECT_A] },
      },
    ],
  ];

  it.each(INVALID_PRINCIPALS)('形状非法拒绝（TypeError，可信装配编程错误）：%s', (_label, value) => {
    expect(() => assertTrustedPrincipal(value)).toThrow(TypeError);
    expect(() => assertTrustedPrincipal(value)).not.toThrow(PublicError);
  });
});

describe('F-005 能力与可见性原语', () => {
  it('hasCapability / isProjectVisible / principalProjectVisibility', () => {
    const principal = restricted(['project.read', 'events.read'], [PROJECT_A, PROJECT_B]);
    expect(hasCapability(principal, 'project.read')).toBe(true);
    expect(hasCapability(principal, 'settings.global.read')).toBe(false);
    expect(isProjectVisible(principal, PROJECT_A)).toBe(true);
    expect(isProjectVisible(principal, PROJECT_B)).toBe(true);
    expect(isProjectVisible(principal, PROJECT_C)).toBe(false);
    expect(isProjectVisible(owner(), PROJECT_C)).toBe(true);

    // 可见范围谓词描述符：原样交给查询端口在 SQL 谓词收窄（先收窄再分页）。
    expect(principalProjectVisibility(owner())).toEqual({ kind: 'all' });
    const predicate = principalProjectVisibility(principal);
    expect(predicate).toEqual({ kind: 'allowlist', projectIds: [PROJECT_A, PROJECT_B] });
  });

  it('requireCapability：缺能力 forbidden/403，保留操作身份，details 只放受控 reason', () => {
    const principal = restricted(['project.read']);
    expect(() => requireCapability(principal, 'project.read', 'projects.list')).not.toThrow();
    const error = expectPublicError(
      () => requireCapability(principal, 'settings.global.write', 'settings.global.update'),
      { code: 'forbidden', operation: 'settings.global.update', reason: 'capability_denied' },
    );
    expect(error.httpStatus).toBe(403);
    expect(Object.keys(error.details ?? {}).sort()).toEqual(['reason']);
  });

  it('requireAnyCapability：命中其一即通过，全缺才拒绝', () => {
    const readOnly = restricted(['settings.project.read']);
    expect(() =>
      requireAnyCapability(readOnly, ['project.read', 'settings.project.read'], 'settings.project.get'),
    ).not.toThrow();
    expectPublicError(
      () => requireAnyCapability(restricted(['events.read']), ['project.read', 'settings.project.read'], 'settings.project.get'),
      { code: 'forbidden', operation: 'settings.project.get', reason: 'capability_denied' },
    );
  });

  it('requireProjectVisible：不可见统一 forbidden，不回显 projectId', () => {
    const principal = restricted(['project.metadata.write']);
    expect(() => requireProjectVisible(principal, PROJECT_A, 'project.metadata.update')).not.toThrow();
    const error = expectPublicError(() => requireProjectVisible(principal, PROJECT_B, 'project.metadata.update'), {
      code: 'forbidden',
      operation: 'project.metadata.update',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(error.toErrorShape())).not.toContain(PROJECT_B);
  });
});

describe('F-005 命令授权（§4.3 矩阵：能力 + 项目可见性）', () => {
  it.each(COMMANDS_MATRIX)('local-owner 可执行 %s', ({ operation, scope, revision }) => {
    expect(() =>
      authorizeCommand(owner(), envelope(operation, scope as CommandScope, revision)),
    ).not.toThrow();
  });

  it.each(COMMANDS_MATRIX)('持恰切能力且目标可见的受限主体可执行 %s', ({ operation, scope, revision, capability }) => {
    const principal = restricted([capability]);
    expect(() =>
      authorizeCommand(principal, envelope(operation, scope as CommandScope, revision)),
    ).not.toThrow();
  });

  it.each(COMMANDS_MATRIX)('缺能力一律 forbidden（capability_denied）：%s', ({ operation, scope, revision }) => {
    const principal = restricted(['receipts.read']);
    expectPublicError(
      () => authorizeCommand(principal, envelope(operation, scope as CommandScope, revision)),
      { code: 'forbidden', operation, reason: 'capability_denied' },
    );
  });

  it.each(['project.metadata.update', 'settings.project.create', 'settings.project.update'] as const)(
    '项目命令目标在可见范围之外：有能力也 forbidden（project_not_visible，不区分不存在）：%s',
    (operation) => {
      const capability =
        operation === 'project.metadata.update' ? 'project.metadata.write' : 'settings.project.write';
      const principal = restricted([capability], [PROJECT_A]);
      const target = { kind: 'project', projectId: PROJECT_B } as const;
      const error = expectPublicError(
        () => authorizeCommand(principal, envelope(operation, target, operation.endsWith('.update') ? 1 : null)),
        { code: 'forbidden', operation, reason: 'project_not_visible' },
      );
      expect(JSON.stringify(error.toErrorShape())).not.toContain(PROJECT_B);
    },
  );

  it('全局配置命令独立授权：项目能力不蕴含 settings.global.write', () => {
    const projectOnly = restricted(['project.register', 'project.read', 'project.metadata.write', 'settings.project.write']);
    expectPublicError(
      () => authorizeCommand(projectOnly, envelope('settings.global.update', { kind: 'global' }, 1)),
      { code: 'forbidden', operation: 'settings.global.update', reason: 'capability_denied' },
    );
  });

  it('请求中的 projectId 只是目标选择：scope project 指向 allowlist 外项目不会扩大权限', () => {
    const principal = restricted(['project.metadata.write'], [PROJECT_A]);
    expectPublicError(
      () => authorizeCommand(principal, envelope('project.metadata.update', { kind: 'project', projectId: PROJECT_C }, 1)),
      { code: 'forbidden', operation: 'project.metadata.update', reason: 'project_not_visible' },
    );
  });

  it('注册命令只查注册能力；既有项目可见性由 requireProjectVisible 把关（不可见即 forbidden，不泄漏存在性）', () => {
    const registrar = restricted(['project.register'], [PROJECT_A]);
    expect(() =>
      authorizeCommand(registrar, envelope('project.register', { kind: 'registration' }, null)),
    ).not.toThrow();
    // canonicalPath 已绑定到可见项目 → 允许 already_exists 复用。
    expect(() => requireProjectVisible(registrar, PROJECT_A, 'project.register')).not.toThrow();
    // 绑定到不可见项目 → forbidden，与「不存在」不可区分。
    expectPublicError(() => requireProjectVisible(registrar, PROJECT_B, 'project.register'), {
      code: 'forbidden',
      operation: 'project.register',
      reason: 'project_not_visible',
    });
  });

  it('F-002 校验后的真实信封可直接进入 authorizeCommand；提权字段在校验阶段即拒绝', () => {
    const raw = {
      schemaVersion: 5,
      commandId: COMMAND_ID,
      operation: 'project.register',
      scope: { kind: 'registration' },
      issuedAt: ISSUED_AT,
      payload: { repositoryPath: '/tmp/some-repo', displayName: '登记' },
    };
    const validated = validateCommandEnvelope(raw);
    expect(() => authorizeCommand(owner(), validated)).not.toThrow();
    // actorId/principal/capabilities 提权字段在 F-002 按未知键拒绝，根本到不了授权层。
    expectPublicError(() => validateCommandEnvelope({ ...raw, actorId: 'mallory' }), {
      code: 'invalid_input',
      operation: 'commands.submit',
    });
    expectPublicError(() => validateCommandEnvelope({ ...raw, principalId: 'local-owner' }), {
      code: 'invalid_input',
      operation: 'commands.submit',
    });
  });
});

describe('F-005 查询授权（§4.3：可见范围先收窄再分页/计数）', () => {
  it('projects.list / projects.labelCounts：要求 project.read 并返回收窄谓词', () => {
    expect(authorizeProjectsList(owner())).toEqual({ kind: 'all' });
    const principal = restricted(['project.read'], [PROJECT_A, PROJECT_B]);
    expect(authorizeProjectsList(principal)).toEqual({ kind: 'allowlist', projectIds: [PROJECT_A, PROJECT_B] });
    expect(authorizeProjectLabelCounts(principal)).toEqual({ kind: 'allowlist', projectIds: [PROJECT_A, PROJECT_B] });
    expectPublicError(() => authorizeProjectsList(restricted(['settings.project.read'])), {
      code: 'forbidden',
      operation: 'projects.list',
      reason: 'capability_denied',
    });
    expectPublicError(() => authorizeProjectLabelCounts(restricted(['events.read'])), {
      code: 'forbidden',
      operation: 'projects.labelCounts',
      reason: 'capability_denied',
    });
  });

  it('projects.get / projects.binding.get：project.read + 目标可见', () => {
    const principal = restricted(['project.read']);
    expect(() => authorizeProjectRead(principal, PROJECT_A)).not.toThrow();
    expect(() => authorizeProjectRead(principal, PROJECT_A, 'projects.binding.get')).not.toThrow();
    expectPublicError(() => authorizeProjectRead(principal, PROJECT_B), {
      code: 'forbidden',
      operation: 'projects.get',
      reason: 'project_not_visible',
    });
    expectPublicError(() => authorizeProjectRead(restricted(['settings.project.read']), PROJECT_A), {
      code: 'forbidden',
      operation: 'projects.get',
      reason: 'capability_denied',
    });
  });

  it('settings.global.get/export：仅 settings.global.read；project.read 与 settings.global.write 都不蕴含', () => {
    const globalReader = createRestrictedPrincipal({
      capabilities: ['settings.global.read'],
      projectScope: scopeAllowlist([PROJECT_A]),
    });
    expect(() => authorizeGlobalSettingsRead(globalReader)).not.toThrow();
    expect(() => authorizeGlobalSettingsRead(globalReader, 'settings.global.export')).not.toThrow();
    expectPublicError(
      () => authorizeGlobalSettingsRead(restricted(['project.read', 'settings.project.read'])),
      { code: 'forbidden', operation: 'settings.global.get', reason: 'capability_denied' },
    );
    expectPublicError(() => authorizeGlobalSettingsRead(restricted(['settings.global.write'])), {
      code: 'forbidden',
      operation: 'settings.global.get',
      reason: 'capability_denied',
    });
  });

  it('settings.project.get/effective/export：project.read 或 settings.project.read + 目标可见', () => {
    expect(() => authorizeProjectSettingsRead(restricted(['project.read']), PROJECT_A)).not.toThrow();
    expect(() =>
      authorizeProjectSettingsRead(restricted(['settings.project.read']), PROJECT_A, 'settings.project.effective'),
    ).not.toThrow();
    expectPublicError(
      () => authorizeProjectSettingsRead(restricted(['settings.global.read', 'events.read']), PROJECT_A),
      { code: 'forbidden', operation: 'settings.project.get', reason: 'capability_denied' },
    );
    // 有读能力但项目不可见：统一 forbidden，不回显 projectId。
    const error = expectPublicError(
      () => authorizeProjectSettingsRead(restricted(['settings.project.read']), PROJECT_B, 'settings.project.export'),
      { code: 'forbidden', operation: 'settings.project.export', reason: 'project_not_visible' },
    );
    expect(JSON.stringify(error.toErrorShape())).not.toContain(PROJECT_B);
  });

  it('snapshot.get：全局快照仅 settings.global.read；项目快照 = 项目设置读规则', () => {
    const globalScope: PublicEventScope = { kind: 'global' };
    const projectScope: PublicEventScope = { kind: 'project', projectId: PROJECT_A };
    const globalReader = createRestrictedPrincipal({
      capabilities: ['settings.global.read'],
      projectScope: scopeAllowlist([PROJECT_A]),
    });
    expect(() => authorizeSnapshot(globalReader, globalScope)).not.toThrow();
    expectPublicError(() => authorizeSnapshot(restricted(['project.read']), globalScope), {
      code: 'forbidden',
      operation: 'snapshot.get',
      reason: 'capability_denied',
    });
    expect(() => authorizeSnapshot(restricted(['settings.project.read']), projectScope)).not.toThrow();
    expectPublicError(() => authorizeSnapshot(restricted(['project.read']), { kind: 'project', projectId: PROJECT_B }), {
      code: 'forbidden',
      operation: 'snapshot.get',
      reason: 'project_not_visible',
    });
  });

  it('QUERY_OPERATIONS 与契约 §3.2 查询路由一一对应', () => {
    expect([...QUERY_OPERATIONS]).toEqual([
      'projects.list',
      'projects.get',
      'projects.binding.get',
      'projects.labelCounts',
      'settings.global.get',
      'settings.global.export',
      'settings.project.get',
      'settings.project.effective',
      'settings.project.export',
      'receipts.get',
      'results.resolve',
      'snapshot.get',
    ]);
    expect(EVENTS_SUBSCRIBE_OPERATION).toBe('events.subscribe');
  });
});

describe('F-005 回执 / 结果引用 / 命令重放授权（重核当前身份与权限）', () => {
  const ownReceipt = { principalId: RESTRICTED_ID, operation: 'project.metadata.update' as const, scope: { kind: 'project', projectId: PROJECT_A } as const };

  it('receipts.get：只读本 principal 回执；越权一律 not_found（不区分不存在与无权）', () => {
    const principal = restricted(['receipts.read']);
    expect(() => authorizeReceiptRead(principal, RESTRICTED_ID)).not.toThrow();
    // 缺 receipts.read 能力 → forbidden（能力级，不泄漏任何回执存在性）。
    expectPublicError(() => authorizeReceiptRead(restricted(['project.read']), RESTRICTED_ID), {
      code: 'forbidden',
      operation: 'receipts.get',
      reason: 'capability_denied',
    });
    // 他人 principal 的回执 → 404，而非 403；响应不含他人 principalId。
    const error = expectPublicError(() => authorizeReceiptRead(principal, LOCAL_OWNER_PRINCIPAL_ID), {
      code: 'not_found',
      operation: 'receipts.get',
      reason: 'receipt_not_found',
    });
    expect(error.httpStatus).toBe(404);
    expect(JSON.stringify(error.toErrorShape())).not.toContain(LOCAL_OWNER_PRINCIPAL_ID);
  });

  it('回执 scope 可见性：项目回执目标不可见 → not_found；注册回执核验新建项目当前可见性', () => {
    const principal = restricted(['receipts.read']);
    expect(() =>
      authorizeReceiptScopeVisibility(principal, { kind: 'project', projectId: PROJECT_A }, null, 'receipts.get'),
    ).not.toThrow();
    expectPublicError(
      () => authorizeReceiptScopeVisibility(principal, { kind: 'project', projectId: PROJECT_B }, null, 'receipts.get'),
      { code: 'not_found', operation: 'receipts.get', reason: 'receipt_not_found' },
    );
    // 注册回执：创建的项目当前仍可见 → 通过；不可见 → not_found；无项目实体（创建前被拒）→ 仅归属核验。
    expect(() =>
      authorizeReceiptScopeVisibility(principal, { kind: 'registration' }, PROJECT_A, 'results.resolve'),
    ).not.toThrow();
    expectPublicError(
      () => authorizeReceiptScopeVisibility(principal, { kind: 'registration' }, PROJECT_B, 'results.resolve'),
      { code: 'not_found', operation: 'results.resolve', reason: 'receipt_not_found' },
    );
    expect(() =>
      authorizeReceiptScopeVisibility(principal, { kind: 'registration' }, null, 'receipts.get'),
    ).not.toThrow();
    // 全局 scope 无项目实体：归属核验已足。
    expect(() => authorizeReceiptScopeVisibility(principal, { kind: 'global' }, null, 'receipts.get')).not.toThrow();
  });

  it('results.resolve：伪造/不可见/他人引用一律 not_found；缺能力 forbidden', () => {
    const principal = restricted(['receipts.read']);
    expect(() => authorizeResultResolution(principal, ownReceipt, null)).not.toThrow();
    expectPublicError(
      () => authorizeResultResolution(principal, { ...ownReceipt, principalId: LOCAL_OWNER_PRINCIPAL_ID }, null),
      { code: 'not_found', operation: 'results.resolve', reason: 'receipt_not_found' },
    );
    expectPublicError(
      () => authorizeResultResolution(principal, { ...ownReceipt, scope: { kind: 'project', projectId: PROJECT_B } }, null),
      { code: 'not_found', operation: 'results.resolve', reason: 'receipt_not_found' },
    );
    expectPublicError(() => authorizeResultResolution(restricted(['project.read']), ownReceipt, null), {
      code: 'forbidden',
      operation: 'results.resolve',
      reason: 'capability_denied',
    });
  });

  it('命令重放重新核验当前身份/权限：已有 commandId 不绕过授权', () => {
    const principal = restricted(['project.metadata.write', 'receipts.read']);
    // 能力仍在、项目仍可见 → 重放可取回原回执。
    expect(() => authorizeCommandReplay(principal, ownReceipt, null, 'project.metadata.update')).not.toThrow();
    // 当前身份已失去原命令能力 → forbidden，重放不绕过授权。
    expectPublicError(
      () => authorizeCommandReplay(restricted(['receipts.read']), ownReceipt, null, 'project.metadata.update'),
      { code: 'forbidden', operation: 'project.metadata.update', reason: 'capability_denied' },
    );
    // 项目已离开可见范围 → 回执对该主体不可见（not_found）。
    expectPublicError(
      () => authorizeCommandReplay(restricted(['project.metadata.write'], [PROJECT_C]), ownReceipt, null, 'project.metadata.update'),
      { code: 'not_found', operation: 'project.metadata.update', reason: 'receipt_not_found' },
    );
    // 归属核验：他人回执不因 commandId 相同而可见。
    expectPublicError(
      () =>
        authorizeCommandReplay(
          principal,
          { ...ownReceipt, principalId: LOCAL_OWNER_PRINCIPAL_ID },
          null,
          'project.metadata.update',
        ),
      { code: 'not_found', operation: 'project.metadata.update', reason: 'receipt_not_found' },
    );
    // 注册回执重放：核验注册能力与新建项目当前可见性。
    const registrationReceipt = {
      principalId: RESTRICTED_ID,
      operation: 'project.register' as const,
      scope: { kind: 'registration' as const },
    };
    expect(() =>
      authorizeCommandReplay(restricted(['project.register']), registrationReceipt, PROJECT_A, 'project.register'),
    ).not.toThrow();
    expectPublicError(
      () => authorizeCommandReplay(restricted(['project.register']), registrationReceipt, PROJECT_B, 'project.register'),
      { code: 'not_found', operation: 'project.register', reason: 'receipt_not_found' },
    );
  });
});

describe('F-005 事件订阅授权与可见过滤（§4.3 events 行、§9.4）', () => {
  const projectScope: PublicEventScope = { kind: 'project', projectId: PROJECT_A };
  const globalScope: PublicEventScope = { kind: 'global' };

  it('项目流：events.read + 项目读能力 + 目标可见；任一不满足在发送正文前 forbidden', () => {
    expect(() =>
      authorizeEventSubscription(restricted(['events.read', 'project.read']), projectScope),
    ).not.toThrow();
    expect(() =>
      authorizeEventSubscription(restricted(['events.read', 'settings.project.read']), projectScope),
    ).not.toThrow();
    // 缺 events.read。
    expectPublicError(() => authorizeEventSubscription(restricted(['project.read']), projectScope), {
      code: 'forbidden',
      operation: 'events.subscribe',
      reason: 'capability_denied',
    });
    // 有 events.read 但无项目读能力。
    expectPublicError(() => authorizeEventSubscription(restricted(['events.read']), projectScope), {
      code: 'forbidden',
      operation: 'events.subscribe',
      reason: 'capability_denied',
    });
    // 项目不可见。
    const error = expectPublicError(
      () =>
        authorizeEventSubscription(restricted(['events.read', 'project.read']), { kind: 'project', projectId: PROJECT_B }),
      { code: 'forbidden', operation: 'events.subscribe', reason: 'project_not_visible' },
    );
    expect(JSON.stringify(error.toErrorShape())).not.toContain(PROJECT_B);
  });

  it('全局流：events.read + settings.global.read；项目能力不蕴含全局事件', () => {
    const globalReader = createRestrictedPrincipal({
      capabilities: ['events.read', 'settings.global.read'],
      projectScope: scopeAllowlist([PROJECT_A]),
    });
    expect(() => authorizeEventSubscription(globalReader, globalScope)).not.toThrow();
    expectPublicError(
      () => authorizeEventSubscription(restricted(['events.read', 'project.read', 'settings.project.read']), globalScope),
      { code: 'forbidden', operation: 'events.subscribe', reason: 'capability_denied' },
    );
  });

  it('可见过滤器：项目流只放行本项目行，全局行（project_id IS NULL）永不泄漏给项目级主体', () => {
    const projectFilter = createEventVisibilityFilter(projectScope);
    expect(projectFilter({ projectId: PROJECT_A })).toBe(true);
    expect(projectFilter({ projectId: PROJECT_B })).toBe(false);
    expect(projectFilter({ projectId: null })).toBe(false);
    const globalFilter = createEventVisibilityFilter(globalScope);
    expect(globalFilter({ projectId: null })).toBe(true);
    expect(globalFilter({ projectId: PROJECT_A })).toBe(false);
  });
});

describe('F-005 项目目标错误统一折算（不可见/不存在对调用方不可区分）', () => {
  it('项目 not_found 折算为统一 forbidden；其他实体/错误原样抛出', () => {
    const storageNotFound = new StorageError('not_found', 'StateStore.getProject', '项目不存在', {
      entity: { type: 'project', id: PROJECT_B },
    });
    const mapped = expectPublicError(() => mapProjectLookupError(storageNotFound, 'projects.get'), {
      code: 'forbidden',
      operation: 'projects.get',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(mapped.toErrorShape())).not.toContain(PROJECT_B);

    const publicNotFound = new PublicError('not_found', 'projects.get', undefined, {
      details: { entityType: 'project' },
    });
    expectPublicError(() => mapProjectLookupError(publicNotFound, 'projects.get'), {
      code: 'forbidden',
      operation: 'projects.get',
      reason: 'project_not_visible',
    });

    // 非项目实体的 not_found（如配置缺失）必须保留 404，不得折算。
    const settingsNotFound = new StorageError('not_found', 'StateStore.getSettings', '配置不存在', {
      entity: { type: 'project_settings', id: PROJECT_A },
    });
    expect(() => mapProjectLookupError(settingsNotFound, 'settings.project.get')).toThrow(settingsNotFound);
    const conflict = new StorageError('conflict', 'StateStore.updateProject', 'CAS 冲突');
    expect(() => mapProjectLookupError(conflict, 'project.metadata.update')).toThrow(conflict);
  });
});

describe('F-005 真实数据根上的直接应用层拒绝（不经 HTTP，失败零副作用）', () => {
  let fixture: CommandsTestFixture | undefined;

  afterEach(() => {
    const active = fixture;
    fixture = undefined;
    active?.cleanup();
  });

  it('受限 A 身份在真实项目 A/B 上的授权判定；拒绝后项目/事件/配置行零变化', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f005-authz-' });
    const app = await fixture.openApplication();
    const registrationA = await app.projectService.registerRepository({
      repositoryPath: fixture.repoDirA,
      displayName: '授权项目 A',
    });
    const registrationB = await app.projectService.registerRepository({
      repositoryPath: fixture.repoDirB,
      displayName: '授权项目 B',
    });
    if (registrationA.status !== 'registered' || registrationB.status !== 'registered') {
      throw new Error('夹具注册前置失败');
    }
    const projectA = registrationA.project.id;
    const projectB = registrationB.project.id;
    expect(isUuidV4(projectA)).toBe(true);
    expect(isUuidV4(projectB)).toBe(true);

    const probe = fixture.openProbe();
    const countsBefore = probe.counts();

    // 受限主体：可见范围仅 A，持项目级全部能力（无全局能力）。
    const principalA = createRestrictedPrincipal({
      capabilities: [
        'project.register',
        'project.read',
        'project.metadata.write',
        'settings.project.read',
        'settings.project.write',
        'receipts.read',
        'events.read',
      ],
      projectScope: scopeAllowlist([projectA]),
    });
    expect(() => assertTrustedPrincipal(principalA)).not.toThrow();

    // A 可读可改，B 一律拒绝；真实 projectId 由持久注册产生。
    expect(() => authorizeProjectRead(principalA, projectA)).not.toThrow();
    expectPublicError(() => authorizeProjectRead(principalA, projectB), {
      code: 'forbidden',
      operation: 'projects.get',
      reason: 'project_not_visible',
    });
    expect(() =>
      authorizeCommand(principalA, envelope('project.metadata.update', { kind: 'project', projectId: projectA }, 1)),
    ).not.toThrow();
    expectPublicError(
      () => authorizeCommand(principalA, envelope('project.metadata.update', { kind: 'project', projectId: projectB }, 1)),
      { code: 'forbidden', operation: 'project.metadata.update', reason: 'project_not_visible' },
    );
    // 猜测 B 的回执/结果引用 → not_found；订阅 B 的事件 → forbidden。
    expectPublicError(
      () =>
        authorizeResultResolution(
          principalA,
          { principalId: (principalA as TrustedPrincipal).principalId, scope: { kind: 'project', projectId: projectB } },
          null,
        ),
      { code: 'not_found', operation: 'results.resolve', reason: 'receipt_not_found' },
    );
    expectPublicError(
      () => authorizeEventSubscription(principalA, { kind: 'project', projectId: projectB }),
      { code: 'forbidden', operation: 'events.subscribe', reason: 'project_not_visible' },
    );
    // 全局配置/全局事件独立授权：项目级能力不蕴含。
    expectPublicError(() => authorizeGlobalSettingsRead(principalA), {
      code: 'forbidden',
      operation: 'settings.global.get',
      reason: 'capability_denied',
    });
    expectPublicError(() => authorizeEventSubscription(principalA, { kind: 'global' }), {
      code: 'forbidden',
      operation: 'events.subscribe',
      reason: 'capability_denied',
    });
    // 列表收窄谓词只含 A（下推 SQL 先收窄再分页）。
    expect(authorizeProjectsList(principalA)).toEqual({ kind: 'allowlist', projectIds: [projectA] });
    // 事件过滤器：B 行与全局行对 A 的流不可见。
    const filter = createEventVisibilityFilter({ kind: 'project', projectId: projectA });
    expect(filter({ projectId: projectA })).toBe(true);
    expect(filter({ projectId: projectB })).toBe(false);
    expect(filter({ projectId: null })).toBe(false);

    // 授权判定为纯函数：拒绝后真实业务行/事件/配置零变化（独立只读连接核对）。
    expect(probe.counts()).toEqual(countsBefore);
    expect(probe.projectRow(projectA)?.revision).toBe(1);
    expect(probe.projectRow(projectB)?.revision).toBe(1);
    expect(probe.stateEvents()).toHaveLength(0);

    // 真实业务变更（P01 直接服务）后授权语义不变：A 仍通过、B 仍拒绝，
    // 事件只来自真实更新，授权调用本身不产生任何行。
    const updated = await app.projectService.updateProjectMetadata(projectA, {
      expectedRevision: 1,
      labels: ['alpha'],
    });
    expect(updated.revision).toBe(2);
    expect(probe.stateEvents()).toHaveLength(1);
    expect(() =>
      authorizeCommand(principalA, envelope('project.metadata.update', { kind: 'project', projectId: projectA }, 2)),
    ).not.toThrow();
    expectPublicError(
      () => authorizeCommand(principalA, envelope('project.metadata.update', { kind: 'project', projectId: projectB }, 1)),
      { code: 'forbidden', operation: 'project.metadata.update', reason: 'project_not_visible' },
    );
    expect(probe.counts().projects).toBe(2);
    expect(probe.counts().state_events).toBe(1);
  });
});

describe('F-005 模块纯度（import 无数据库/网络/文件/时钟副作用）', () => {
  it('源码不绑定驱动/网络/文件/时钟/进程能力，只依赖 ports 契约模块', () => {
    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/core/src/ports/authorization.ts',
    );
    const source = readFileSync(modulePath, 'utf-8');
    for (const forbidden of [
      'better-sqlite3',
      'drizzle',
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'node:child_process',
      'Date.now',
      'Math.random',
      'process.env',
      'process.argv',
      'test-restricted',
    ]) {
      expect(source.includes(forbidden), `源码不得出现 ${forbidden}`).toBe(false);
    }
    const imports = [...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['./commands.js', './errors.js', './events.js']);
  });
});
