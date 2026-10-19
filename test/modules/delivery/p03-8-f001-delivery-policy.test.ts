/**
 * P03-8 / F-001 Feature 最终提交政策与用户 Git 身份校验
 * （纯契约 + 配置体系集成 + 有效配置合并 + 执行快照固定 + 真实资源纵向）。
 *
 * 覆盖（F-001 验收点）：
 * - task_and_feature 要求 Task 本地提交；feature_final_only 仅读取兼容；其他提交
 *   政策（per_task/task_each/manual/feature_final_and_push 等）一律结构化拒绝；
 * - push、PR（pull_request/merge_request）、自动合并（auto_merge）等交付动作
 *   请求被结构化拒绝，唯一支持动作是 commit（Feature 最终提交本身）；
 * - 提交姓名/邮箱必须由用户明确配置并确认（confirmed: true）：缺失、空值、
 *   非法形态（无 @/多 @/无域点/空白/控制字符/超长）与未确认身份全部拒绝，
 *   不回落到开发机全局身份或官方邮箱默认值；
 * - Runtime/provider/model 来源是独立审计记录（RuntimeSourceAuditRecord），
 *   与用户 Git 身份分离保存，不混入身份字段；
 * - 配置体系扩展沿用 schemaVersion=2（不新增配置版本表或第二套配置文件）：
 *   旧 payload（无 deliveryPolicy 段）继续有效；未知政策段仍拒绝；不兼容
 *   版本（v1/v3）拒绝；持久化读取往返一致；
 * - 政策固定到执行依据：执行输入准备把当前有效 deliveryPolicy（或显式
 *   null 形态摘要）复制进不可变 input snapshot；之后全局/项目配置漂移不
 *   改变已发布快照字节，新 Task 准备按新政策生成新快照。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createInputSourceFileReader } from '../../../packages/core/src/adapters/fs/input-source-files.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../packages/core/src/application/command-service.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createExecutionInputService } from '../../../packages/core/src/application/execution-input.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import {
  DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
  EXECUTION_INPUT_PREPARE_OPERATION,
  createExecutionInputPrepareService,
} from '../../../packages/core/src/application/execution-input-prepare.ts';
import {
  computeDeliveryPolicyDigest,
  FEATURE_FINAL_COMMIT_MODE,
  resolveDeliveryPolicyForUse,
  validateConfirmedDeliveryPolicy,
  validateConfirmedGitIdentity,
  validateDeliveryPolicySection,
  validateRuntimeSourceAuditRecord,
} from '../../../packages/core/src/ports/delivery-policy.ts';
import type { ConfirmedGitIdentity, DeliveryPolicySection } from '../../../packages/core/src/ports/delivery-policy.ts';
import { resolveCurrentDeliveryPolicy } from '../../../packages/core/src/application/delivery-policy.ts';
import {
  SETTINGS_SCHEMA_VERSION,
  parseStoredSettingsPayload,
  validateSettingsPayload,
} from '../../../packages/core/src/ports/settings-schema.ts';
import type { SettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { mergeEffectiveSettings } from '../../../packages/core/src/application/effective-settings.ts';
import { isStorageError, StorageError } from '../../../packages/core/src/ports/errors.ts';
import { isContextBuildError } from '../../../packages/core/src/ports/context-build.ts';
import { isPublicError } from '../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PublicError } from '../../../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from '../../helpers/p02-2/index.ts';

const CONTEXT = {
  operation: 'P03-8-F-001.test',
  entity: { type: 'project_settings', projectId: 'project-a' },
} as const;

function expectRejection(run: () => unknown, fieldFragment: string, reason?: string): StorageError {
  let error: unknown;
  try {
    run();
  } catch (thrown) {
    error = thrown;
  }
  expect(isStorageError(error)).toBe(true);
  const storageError = error as StorageError;
  expect(storageError.kind).toBe('validation');
  expect(String(storageError.details?.field ?? '')).toContain(fieldFragment);
  if (reason !== undefined) {
    expect(storageError.details?.reason).toBe(reason);
  }
  return storageError;
}

const VALID_IDENTITY: ConfirmedGitIdentity = { name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true };

function completeSection(): DeliveryPolicySection {
  return {
    commitMode: FEATURE_FINAL_COMMIT_MODE,
    gitIdentity: { ...VALID_IDENTITY },
    deliveryActions: ['commit'],
  };
}

/* ------------------------------------------------------------------ *
 * 用户 Git 身份校验（纯契约）
 * ------------------------------------------------------------------ */

describe('F-001 用户 Git 身份校验', () => {
  it('接受用户明确配置并确认的姓名与邮箱（规范化新对象）', () => {
    const identity = validateConfirmedGitIdentity(
      { name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true },
      CONTEXT,
      'gitIdentity',
    );
    expect(identity).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true });
  });

  it.each([
    ['name 为空字符串', { name: '', email: 'ada@example.com', confirmed: true }, 'name'],
    ['name 仅空白', { name: '   ', email: 'ada@example.com', confirmed: true }, 'name'],
    ['name 前后空白', { name: ' Ada ', email: 'ada@example.com', confirmed: true }, 'name'],
    ['name 含控制字符', { name: 'Ada\nLovelace', email: 'ada@example.com', confirmed: true }, 'name'],
    ['name 含尖括号注入', { name: 'Ada <ada@example.com>', email: 'ada@example.com', confirmed: true }, 'name'],
    ['name 超长（>128 码点）', { name: '长'.repeat(129), email: 'ada@example.com', confirmed: true }, 'name'],
    ['email 缺失', { name: 'Ada', confirmed: true }, 'email'],
    ['email 无 @', { name: 'Ada', email: 'ada.example.com', confirmed: true }, 'email'],
    ['email 多个 @', { name: 'Ada', email: 'a@b@example.com', confirmed: true }, 'email'],
    ['email 本地部分为空', { name: 'Ada', email: '@example.com', confirmed: true }, 'email'],
    ['email 域无点', { name: 'Ada', email: 'ada@localhost', confirmed: true }, 'email'],
    ['email 域以点结尾', { name: 'Ada', email: 'ada@example.com.', confirmed: true }, 'email'],
    ['email 含空白', { name: 'Ada', email: 'ada @example.com', confirmed: true }, 'email'],
    ['email 含控制字符', { name: 'Ada', email: 'ada@example.com\n', confirmed: true }, 'email'],
    ['email 超长（>254）', { name: 'Ada', email: `${'a'.repeat(64)}@${'b'.repeat(190)}.com`, confirmed: true }, 'email'],
  ])('拒绝非法身份：%s', (_name, payload, fieldFragment) => {
    expectRejection(() => validateConfirmedGitIdentity(payload, CONTEXT, 'gitIdentity'), fieldFragment);
  });

  it('未经用户明确确认的身份（confirmed 缺失/false/非布尔）被结构化拒绝', () => {
    expectRejection(
      () => validateConfirmedGitIdentity({ name: 'Ada', email: 'ada@example.com' }, CONTEXT, 'gitIdentity'),
      'gitIdentity.confirmed',
      'identity_not_confirmed',
    );
    expectRejection(
      () => validateConfirmedGitIdentity({ name: 'Ada', email: 'ada@example.com', confirmed: false }, CONTEXT, 'gitIdentity'),
      'gitIdentity.confirmed',
      'identity_not_confirmed',
    );
    expectRejection(
      () => validateConfirmedGitIdentity({ name: 'Ada', email: 'ada@example.com', confirmed: 'yes' }, CONTEXT, 'gitIdentity'),
      'gitIdentity.confirmed',
      'identity_not_confirmed',
    );
  });

  it('未知字段 fail-closed（不接收 fallback/署名等旁路键）', () => {
    const error = expectRejection(
      () =>
        validateConfirmedGitIdentity(
          { ...VALID_IDENTITY, fallbackEmail: 'agent@example.com' },
          CONTEXT,
          'gitIdentity',
        ),
      'gitIdentity',
    );
    expect(String(error.details?.reason ?? '')).toContain('未知字段');
  });
});

/* ------------------------------------------------------------------ *
 * Feature 最终提交政策（纯契约）
 * ------------------------------------------------------------------ */

describe('F-001 提交政策与历史兼容', () => {
  it('接受 task_and_feature 并保留有效配置与持久化语义', () => {
    const value = { commitMode: 'task_and_feature' as const, gitIdentity: { ...VALID_IDENTITY } };
    expect(validateConfirmedDeliveryPolicy(value, CONTEXT, 'deliveryPolicy')).toEqual(value);
    expect(resolveDeliveryPolicyForUse(value)).toMatchObject({ status: 'ready', policy: value });
    expect(parseStoredSettingsPayload(JSON.stringify({ schemaVersion: 2,
      policies: { deliveryPolicy: value } }), CONTEXT)).toMatchObject({ policies: { deliveryPolicy: value } });
  });

  it('接受历史 feature_final_only 完整政策', () => {
    const policy = validateConfirmedDeliveryPolicy(
      { commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: { ...VALID_IDENTITY } },
      CONTEXT,
      'deliveryPolicy',
    );
    expect(policy).toEqual({
      commitMode: FEATURE_FINAL_COMMIT_MODE,
      gitIdentity: VALID_IDENTITY,
    });
  });

  it.each([
    'per_task',
    'task_each',
    'manual_only',
    'feature_final_and_push',
    'feature_final_only_v2',
  ])('拒绝未经支持的提交政策 %s', (mode) => {
    expectRejection(
      () =>
        validateConfirmedDeliveryPolicy(
          { commitMode: mode, gitIdentity: { ...VALID_IDENTITY } },
          CONTEXT,
          'deliveryPolicy',
        ),
      'deliveryPolicy.commitMode',
      'unsupported_commit_mode',
    );
  });

  it('缺 commitMode 或 gitIdentity 明确拒绝（没有默认政策）', () => {
    expectRejection(
      () => validateConfirmedDeliveryPolicy({ gitIdentity: { ...VALID_IDENTITY } }, CONTEXT, 'deliveryPolicy'),
      'deliveryPolicy.commitMode',
    );
    expectRejection(
      () => validateConfirmedDeliveryPolicy({ commitMode: FEATURE_FINAL_COMMIT_MODE }, CONTEXT, 'deliveryPolicy'),
      'deliveryPolicy.gitIdentity',
    );
  });
});

describe('F-001 交付动作请求边界（push/PR/自动合并拒绝）', () => {
  it('deliveryActions 只接受 commit；push、pull_request、merge_request、auto_merge 及任意未知动作全部结构化拒绝', () => {
    const section = validateDeliveryPolicySection(
      { ...completeSection(), deliveryActions: ['commit'] },
      CONTEXT,
      'policies.deliveryPolicy',
    );
    expect(section.deliveryActions).toEqual(['commit']);
    for (const action of ['push', 'pull_request', 'pr', 'merge_request', 'auto_merge', 'force_push', 'deploy']) {
      expectRejection(
        () =>
          validateDeliveryPolicySection(
            { ...completeSection(), deliveryActions: ['commit', action] },
            CONTEXT,
            'policies.deliveryPolicy',
          ),
        'deliveryPolicy.deliveryActions',
        'unsupported_delivery_action',
      );
      expectRejection(
        () =>
          validateDeliveryPolicySection(
            { ...completeSection(), deliveryActions: [action] },
            CONTEXT,
            'policies.deliveryPolicy',
          ),
        'deliveryPolicy.deliveryActions',
        'unsupported_delivery_action',
      );
    }
  });

  it('deliveryActions 非数组或含非字符串项拒绝', () => {
    expectRejection(
      () =>
        validateDeliveryPolicySection(
          { ...completeSection(), deliveryActions: 'commit' },
          CONTEXT,
          'policies.deliveryPolicy',
        ),
      'deliveryPolicy.deliveryActions',
    );
    expectRejection(
      () =>
        validateDeliveryPolicySection(
          { ...completeSection(), deliveryActions: [1] },
          CONTEXT,
          'policies.deliveryPolicy',
        ),
      'deliveryPolicy.deliveryActions',
    );
  });

  it('配置段允许空对象与部分字段（段级继承语义由合并层决定），但存在的字段全部校验', () => {
    expect(validateDeliveryPolicySection({}, CONTEXT, 'policies.deliveryPolicy')).toEqual({});
    const partial = validateDeliveryPolicySection(
      { gitIdentity: { ...VALID_IDENTITY } },
      CONTEXT,
      'policies.deliveryPolicy',
    );
    expect(partial).toEqual({ gitIdentity: VALID_IDENTITY });
    expectRejection(
      () => validateDeliveryPolicySection({ commitMode: 'per_task' }, CONTEXT, 'policies.deliveryPolicy'),
      'deliveryPolicy.commitMode',
      'unsupported_commit_mode',
    );
  });
});

describe('F-001 使用时解析（fail-closed，缺失/不完整政策不能授权提交）', () => {
  it('未配置或空段 → delivery_policy_not_configured', () => {
    expect(resolveDeliveryPolicyForUse(undefined).status).toBe('rejected');
    expect(resolveDeliveryPolicyForUse(undefined)).toMatchObject({
      status: 'rejected',
      reason: 'delivery_policy_not_configured',
    });
    expect(resolveDeliveryPolicyForUse({})).toMatchObject({
      status: 'rejected',
      reason: 'delivery_policy_not_configured',
    });
  });

  it('缺 commitMode / 缺身份分别给出明确原因', () => {
    expect(resolveDeliveryPolicyForUse({ gitIdentity: { ...VALID_IDENTITY } })).toMatchObject({
      status: 'rejected',
      reason: 'commit_mode_missing',
    });
    expect(resolveDeliveryPolicyForUse({ commitMode: FEATURE_FINAL_COMMIT_MODE })).toMatchObject({
      status: 'rejected',
      reason: 'git_identity_missing',
    });
  });

  it('防御性复验：非法模式/未确认身份即使混入也拒绝而非降级', () => {
    expect(
      resolveDeliveryPolicyForUse({
        commitMode: 'per_task',
        gitIdentity: { ...VALID_IDENTITY },
      } as unknown as DeliveryPolicySection),
    ).toMatchObject({ status: 'rejected', reason: 'commit_mode_unsupported' });
    expect(
      resolveDeliveryPolicyForUse({
        commitMode: FEATURE_FINAL_COMMIT_MODE,
        gitIdentity: { name: 'Ada', email: 'ada@example.com', confirmed: false },
      } as unknown as DeliveryPolicySection),
    ).toMatchObject({ status: 'rejected', reason: 'git_identity_not_confirmed' });
    expect(
      resolveDeliveryPolicyForUse({
        commitMode: FEATURE_FINAL_COMMIT_MODE,
        gitIdentity: { name: 'Ada', email: 'bad-email', confirmed: true },
      } as unknown as DeliveryPolicySection),
    ).toMatchObject({ status: 'rejected', reason: 'git_identity_invalid' });
  });

  it('完整获准政策解析为 ready（含或不含 deliveryActions）', () => {
    expect(resolveDeliveryPolicyForUse(completeSection())).toEqual({
      status: 'ready',
      policy: {
        commitMode: FEATURE_FINAL_COMMIT_MODE,
        gitIdentity: VALID_IDENTITY,
        deliveryActions: ['commit'],
      },
    });
    expect(resolveDeliveryPolicyForUse({ commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: { ...VALID_IDENTITY } }))
      .toEqual({
        status: 'ready',
        policy: { commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: VALID_IDENTITY },
      });
  });
});

/* ------------------------------------------------------------------ *
 * Runtime/provider/model 来源独立审计记录
 * ------------------------------------------------------------------ */

describe('F-001 Runtime 来源独立审计记录', () => {
  it('接受完整 runtime/provider/model 与来源说明', () => {
    const record = validateRuntimeSourceAuditRecord(
      {
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
        source: { kind: 'global_default', sourceKey: 'payload.strategies.defaultStrategy' },
      },
      CONTEXT,
      'runtimeSource',
    );
    expect(record.model).toBe('claude-sonnet');
  });

  it.each([
    ['缺 runtime', { provider: 'anthropic', model: 'm', source: { kind: 'global_default', sourceKey: 'k' } }],
    ['缺 model', { runtime: 'pi', provider: 'anthropic', source: { kind: 'global_default', sourceKey: 'k' } }],
    ['未知来源种类', { runtime: 'pi', provider: 'a', model: 'm', source: { kind: 'user_global', sourceKey: 'k' } }],
    ['缺 sourceKey', { runtime: 'pi', provider: 'a', model: 'm', source: { kind: 'global_default' } }],
    ['内联凭据旁路键', { runtime: 'pi', provider: 'a', model: 'm', apiKey: 'sk-x', source: { kind: 'global_default', sourceKey: 'k' } }],
  ])('拒绝 %s（审计记录不含秘密、不缺必需来源字段）', (_label, payload) => {
    expectRejection(() => validateRuntimeSourceAuditRecord(payload, CONTEXT, 'runtimeSource'), 'runtimeSource');
  });
});

/* ------------------------------------------------------------------ *
 * 政策身份摘要
 * ------------------------------------------------------------------ */

describe('F-001 交付政策身份摘要', () => {
  it('确定性：相同段相同摘要；null 形态、空段与实配段互不相同', () => {
    const nullForm = computeDeliveryPolicyDigest(undefined);
    const emptyForm = computeDeliveryPolicyDigest({});
    const configured = computeDeliveryPolicyDigest(completeSection());
    expect(nullForm).toMatch(/^[0-9a-f]{64}$/);
    expect(emptyForm).toMatch(/^[0-9a-f]{64}$/);
    expect(configured).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([nullForm, emptyForm, configured]).size).toBe(3);
    expect(computeDeliveryPolicyDigest(completeSection())).toBe(configured);
    // 内容变化（换邮箱）摘要变化。
    expect(
      computeDeliveryPolicyDigest({ ...completeSection(), gitIdentity: { name: 'Ada', email: 'ada2@example.com', confirmed: true } }),
    ).not.toBe(configured);
  });
});

/* ------------------------------------------------------------------ *
 * 配置体系集成（settings schema；沿用 schemaVersion=2）
 * ------------------------------------------------------------------ */

describe('F-001 配置 Schema 集成', () => {
  it('携带完整获准 deliveryPolicy 的 payload 校验通过并规范化为新对象', () => {
    const payload = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      policies: { deliveryPolicy: completeSection() },
    };
    const validated = validateSettingsPayload(payload, CONTEXT);
    expect(validated.policies?.deliveryPolicy).toEqual(completeSection());
    expect(validated.policies?.deliveryPolicy).not.toBe(payload.policies.deliveryPolicy);
  });

  it('旧 v2 payload（无 deliveryPolicy 段）继续有效且语义不变', () => {
    const legacy = validateSettingsPayload(
      {
        schemaVersion: 2,
        strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        policies: { executionLimits: { maxConcurrentWorks: 1 } },
      },
      CONTEXT,
    );
    expect(legacy.policies?.deliveryPolicy).toBeUndefined();
    expect(legacy.policies?.executionLimits).toEqual({ maxConcurrentWorks: 1 });
  });

  it('不兼容版本拒绝：v1 与未来 v3 均不静默误读', () => {
    expectRejection(() => validateSettingsPayload({ schemaVersion: 1 }, CONTEXT), 'payload.schemaVersion');
    expectRejection(
      () =>
        validateSettingsPayload(
          { schemaVersion: 3, policies: { deliveryPolicy: completeSection() } },
          CONTEXT,
        ),
      'payload.schemaVersion',
    );
  });

  it('未知政策段仍拒绝（deliveryPolicy 已定义，memoryPolicy 等仍未定义）', () => {
    for (const segment of ['memoryPolicy', 'agentModes', 'releasePolicy']) {
      expectRejection(
        () => validateSettingsPayload({ schemaVersion: 2, policies: { [segment]: {} } }, CONTEXT),
        'payload.policies',
      );
    }
  });

  it('deliveryPolicy 段内非法内容（非法模式/未确认身份/push 请求）在写入边界拒绝', () => {
    expectRejection(
      () =>
        validateSettingsPayload(
          { schemaVersion: 2, policies: { deliveryPolicy: { commitMode: 'per_task', gitIdentity: { ...VALID_IDENTITY } } } },
          CONTEXT,
        ),
      'deliveryPolicy.commitMode',
      'unsupported_commit_mode',
    );
    expectRejection(
      () =>
        validateSettingsPayload(
          { schemaVersion: 2, policies: { deliveryPolicy: { commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com' } } } },
          CONTEXT,
        ),
      'deliveryPolicy.gitIdentity.confirmed',
      'identity_not_confirmed',
    );
    expectRejection(
      () =>
        validateSettingsPayload(
          { schemaVersion: 2, policies: { deliveryPolicy: { commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: { ...VALID_IDENTITY }, deliveryActions: ['push'] } } },
          CONTEXT,
        ),
      'deliveryPolicy.deliveryActions',
      'unsupported_delivery_action',
    );
  });

  it('持久化读取往返一致；结构损坏按 corrupt 拒绝', () => {
    const payload = { schemaVersion: 2, policies: { deliveryPolicy: completeSection() } };
    const stored = parseStoredSettingsPayload(JSON.stringify(payload), CONTEXT);
    expect(stored.policies?.deliveryPolicy).toEqual(completeSection());
    let corrupt: unknown;
    try {
      parseStoredSettingsPayload(JSON.stringify({ schemaVersion: 2, policies: { deliveryPolicy: { commitMode: 'nope' } } }), CONTEXT);
    } catch (error) {
      corrupt = error;
    }
    expect(isStorageError(corrupt, 'corrupt')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 有效配置合并（段整体替换/继承）
 * ------------------------------------------------------------------ */

describe('F-001 有效配置合并', () => {
  const globalPayload = (deliveryPolicy?: DeliveryPolicySection): SettingsPayload => ({
    schemaVersion: 2,
    ...(deliveryPolicy === undefined ? {} : { policies: { deliveryPolicy } }),
  });

  it('项目未覆盖时继承全局段；项目空段 {} 同样继承全局（键级语义不变）', () => {
    const merged = mergeEffectiveSettings({
      global: { scopeRevision: 1, payload: globalPayload(completeSection()) },
      project: { scopeRevision: 1, payload: { schemaVersion: 2, policies: { deliveryPolicy: {} } } },
    });
    expect(merged.policies.deliveryPolicy?.value).toEqual(completeSection());
    expect(merged.policies.deliveryPolicy?.source.kind).toBe('global_default');
  });

  it('项目非空段整体替换全局段（含清空身份），来源标记 project_default', () => {
    const merged = mergeEffectiveSettings({
      global: { scopeRevision: 4, payload: globalPayload(completeSection()) },
      project: {
        scopeRevision: 2,
        payload: {
          schemaVersion: 2,
          policies: {
            deliveryPolicy: { commitMode: FEATURE_FINAL_COMMIT_MODE, gitIdentity: { name: 'Grace', email: 'grace@example.com', confirmed: true } },
          },
        },
      },
    });
    expect(merged.policies.deliveryPolicy?.value.gitIdentity?.name).toBe('Grace');
    expect(merged.policies.deliveryPolicy?.source).toMatchObject({
      kind: 'project_default',
      scopeRevision: 2,
      sourceKey: 'policies.deliveryPolicy',
    });
    // 项目仅声明模式（无身份）也整体替换：不与全局身份拼接。
    const replaced = mergeEffectiveSettings({
      global: { scopeRevision: 4, payload: globalPayload(completeSection()) },
      project: {
        scopeRevision: 2,
        payload: { schemaVersion: 2, policies: { deliveryPolicy: { commitMode: FEATURE_FINAL_COMMIT_MODE } } },
      },
    });
    expect(replaced.policies.deliveryPolicy?.value.gitIdentity).toBeUndefined();
  });

  it('resolveCurrentDeliveryPolicy 摘要锚定有效段；未配置时摘要锚定 null 形态', () => {
    const configured = resolveCurrentDeliveryPolicy(
      { scopeRevision: 1, payload: globalPayload(completeSection()) },
      null,
    );
    expect(configured.digest).toBe(computeDeliveryPolicyDigest(completeSection()));
    expect(configured.section).toEqual(completeSection());
    const unconfigured = resolveCurrentDeliveryPolicy(
      { scopeRevision: 1, payload: globalPayload() },
      null,
    );
    expect(unconfigured.section).toBeUndefined();
    expect(unconfigured.digest).toBe(computeDeliveryPolicyDigest(undefined));
  });
});

/* ------------------------------------------------------------------ *
 * 执行快照固定（ContextBuilder 可选 deliveryPolicy 投影）
 * ------------------------------------------------------------------ */

const SNAPSHOT_DIGEST_A = 'a'.repeat(64);

function baseBuildInput(deliveryPolicy?: unknown): Record<string, unknown> {
  return {
    projectId: 'p-1',
    featureId: 'f-1',
    taskId: 't-1',
    task: {
      title: '任务',
      description: null,
      acceptance: { criteria: ['验收一'] },
      requirementsRefs: [],
      dependencies: [],
      executionConfig: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      configSource: 'modelMap.low',
      configSourceKey: 'modelMap.low',
    },
    checkPolicy: { digest: SNAPSHOT_DIGEST_A },
    permissions: { grants: [] },
    requiredInputs: [],
    ...(deliveryPolicy === undefined ? {} : { deliveryPolicy }),
  };
}

describe('F-001 执行快照固定（ContextBuilder）', () => {
  const builder = createContextBuilder({ budget: DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET });

  it('未提供 deliveryPolicy 时快照不携带该字段（旧输入形态兼容）', () => {
    const result = builder.build(baseBuildInput());
    expect('deliveryPolicy' in result.inputSnapshot).toBe(false);
    expect(result.inputManifest.sources.some((source) => source.kind === 'delivery-policy')).toBe(false);
  });

  it('提供 digest+copy 时进入 snapshot 业务投影、manifest 来源与 prompt，并改变 snapshotDigest', () => {
    const without = builder.build(baseBuildInput());
    const copy = completeSection() as unknown as Record<string, unknown>;
    const digest = computeDeliveryPolicyDigest(completeSection());
    const withPolicy = builder.build(baseBuildInput({ digest, copy }));
    expect(withPolicy.inputSnapshot.deliveryPolicy).toEqual({ digest, copy });
    expect(
      withPolicy.inputManifest.sources.some(
        (source) => source.kind === 'delivery-policy' && source.identity?.digest === digest,
      ),
    ).toBe(true);
    expect(withPolicy.prompt).toContain(`sha256:${digest}`);
    expect(withPolicy.digests.snapshotDigest).not.toBe(without.digests.snapshotDigest);
    // 摘要身份变化（政策漂移）同样改变快照身份。
    const drifted = builder.build(baseBuildInput({ digest: 'b'.repeat(64), copy }));
    expect(drifted.digests.snapshotDigest).not.toBe(withPolicy.digests.snapshotDigest);
  });

  it('只提供 digest（无 copy）是合法形态（身份固定，正文不复制）', () => {
    const digest = computeDeliveryPolicyDigest(completeSection());
    const result = builder.build(baseBuildInput({ digest }));
    expect(result.inputSnapshot.deliveryPolicy).toEqual({ digest });
    const source = result.inputManifest.sources.find((item) => item.kind === 'delivery-policy');
    expect(source?.selection).toBe('digest');
  });

  it('非法形态拒绝：非 sha256 摘要、copy 为 null、未知键（null 输入按缺省处理，与 rework 约定一致）', () => {
    const absent = builder.build(baseBuildInput(null));
    expect('deliveryPolicy' in absent.inputSnapshot).toBe(false);
    for (const bad of [
      { digest: 'not-a-digest' },
      { digest: SNAPSHOT_DIGEST_A, copy: null },
      { digest: SNAPSHOT_DIGEST_A, forged: true },
    ]) {
      let error: unknown;
      try {
        builder.build(baseBuildInput(bad));
      } catch (thrown) {
        error = thrown;
      }
      expect(isContextBuildError(error, 'validation'), JSON.stringify(bad)).toBe(true);
    }
    let oversize: unknown;
    try {
      builder.build(
        baseBuildInput({ digest: SNAPSHOT_DIGEST_A, copy: { blob: 'x'.repeat(20_000) } }),
      );
    } catch (thrown) {
      oversize = thrown;
    }
    expect(isContextBuildError(oversize)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 真实资源纵向：执行输入准备固定交付政策，配置漂移不改旧快照
 * ------------------------------------------------------------------ */

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

const DELIVERY_POLICY_GLOBAL = {
  commitMode: FEATURE_FINAL_COMMIT_MODE,
  gitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com', confirmed: true },
};
const DELIVERY_POLICY_DRIFTED = {
  commitMode: FEATURE_FINAL_COMMIT_MODE,
  gitIdentity: { name: 'Grace Hopper', email: 'grace@example.com', confirmed: true },
};

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

interface VerticalHarness {
  readonly service: CommandService;
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly dataRoot: string;
  readonly updateGlobalSettings: (payload: Record<string, unknown>) => Promise<CommandReceipt>;
  readonly submitPrepare: (taskId: string) => Promise<CommandReceipt>;
}

async function setupVertical(globalDeliveryPolicy?: Record<string, unknown>): Promise<VerticalHarness> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p038-f001-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const nowUtcMs = (): number => now;

  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs });
  const files = createArtifactFileStore({ dataRoot: box.dataRoot });
  const publisher = createArtifactPublisher({
    artifacts: artifactStore,
    files,
    limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
  });
  const verifier = createArtifactVerifier({
    artifacts: artifactStore,
    files,
    limits: { maxReadBytes: 16_000_000 },
  });
  const sourcesRoot = join(box.root, 'sources');
  mkdirSync(sourcesRoot, { recursive: true });
  writeFileSync(join(sourcesRoot, 'spec.md'), '# 规格\n', 'utf8');

  const atomicStore = createSqliteAtomicCommandStore(harness.session, { nowUtcMs });
  const preparePort = createExecutionInputPrepareService({
    views: createSqlitePlanAccess(harness.session, { nowUtcMs }),
    inputs: createExecutionInputService({
      artifacts: artifactStore,
      publisher,
      verifier,
      sources: createInputSourceFileReader({ roots: { src: sourcesRoot } }),
      limits: {
        maxItems: 8,
        maxItemBytes: 1_000_000,
        maxTotalBytes: 4_000_000,
        captureTimeoutMs: 30_000,
        readTimeoutMs: 30_000,
      },
      nowMs: nowUtcMs,
    }),
    builder: createContextBuilder({ budget: DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET }),
    publisher,
    verifier,
    permissions: () => ({ grants: [] }),
    limits: { maxRequiredItems: 8 },
    nowMs: nowUtcMs,
  });
  const service = createCommandService({
    atomicStore,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    executionInputPrepare: preparePort,
    nowUtcMs,
  });
  const owner = box.localOwner();
  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (
    payload: Record<string, unknown>,
    operation: string,
    extra: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) throw new Error('夹具注册失败');
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const globalPayload = {
    schemaVersion: 2,
    strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
    ...(globalDeliveryPolicy === undefined
      ? {}
      : { policies: { deliveryPolicy: globalDeliveryPolicy } }),
  };
  const globalSettings = await submit(globalPayload, 'settings.global.create', { scope: { kind: 'global' } });
  if (globalSettings.status !== 'completed') throw new Error('夹具全局配置失败');

  const phase = await submit(
    { id: 'phase-1', title: '第一阶段', description: null, labels: [] },
    'phase.create',
    { scope: { kind: 'project', projectId } },
  );
  if (phase.status !== 'completed') throw new Error('夹具 Phase 创建失败');

  const plan = {
    schemaVersion: 1,
    feature: { title: '交付政策 Feature', description: null, labels: [], sourceRefs: [] },
    tasks: [
      { id: 't-1', title: '任务一', complexity: 'low', acceptance: { criteria: ['任务一验收'] } },
      { id: 't-2', title: '任务二', complexity: 'low', acceptance: { criteria: ['任务二验收'] }, dependsOn: ['t-1'] },
    ],
  };
  const imported = await submit(
    { phaseId: 'phase-1', plan },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) throw new Error('夹具计划导入失败');
  const feature = (imported.result as { feature: { id: string; planDigest: string } }).feature;
  const approve = await submit(
    { featureId: feature.id, planDigest: feature.planDigest, decision: 'approve', reason: '交付政策验收' },
    'feature.plan.decide',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (approve.status !== 'completed') throw new Error('夹具批准失败');

  const updateGlobalSettings = async (payload: Record<string, unknown>): Promise<CommandReceipt> =>
    submit(payload, 'settings.global.update', { scope: { kind: 'global' }, expectedRevision: 1 });
  const submitPrepare = async (taskId: string): Promise<CommandReceipt> =>
    submit(
      { featureId: feature.id, taskId, items: [{ purpose: 'spec', source: { kind: 'file', root: 'src', relativePath: 'spec.md' } }] },
      EXECUTION_INPUT_PREPARE_OPERATION,
      { scope: { kind: 'project', projectId } },
    );

  return {
    service,
    projectId,
    featureId: feature.id,
    planDigest: feature.planDigest,
    dataRoot: box.dataRoot,
    updateGlobalSettings,
    submitPrepare,
  };
}

function groupResultOf(receipt: CommandReceipt): {
  group: { snapshot: { artifactId: string; contentHash: string } };
  digests: { snapshotDigest: string };
} {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as unknown as {
    group: { snapshot: { artifactId: string; contentHash: string } };
    digests: { snapshotDigest: string };
  };
}

async function snapshotBody(harness: VerticalHarness, artifactId: string): Promise<string> {
  return (
    await readFile(join(harness.dataRoot, deriveArtifactFinalRelativePath({ projectId: harness.projectId, artifactId })))
  ).toString('utf8');
}

describe('F-001 执行输入准备纵向（真实 SQLite/文件）', () => {
  it('未配置交付政策时快照固定 null 形态摘要（无 copy），Task 执行不要求交付政策', async () => {
    const harness = await setupVertical(undefined);
    const receipt = await harness.submitPrepare('t-1');
    const result = groupResultOf(receipt);
    const body = JSON.parse(await snapshotBody(harness, result.group.snapshot.artifactId)) as {
      deliveryPolicy?: { digest: string; copy?: unknown };
    };
    expect(body.deliveryPolicy?.digest).toBe(computeDeliveryPolicyDigest(undefined));
    expect(body.deliveryPolicy?.copy).toBeUndefined();
  });

  it('配置获准政策后快照复制政策副本；全局配置漂移后旧快照字节不变、新 Task 按新政策生成', async () => {
    const harness = await setupVertical(DELIVERY_POLICY_GLOBAL);
    const first = groupResultOf(await harness.submitPrepare('t-1'));
    const firstBody = await snapshotBody(harness, first.group.snapshot.artifactId);
    const firstSnapshot = JSON.parse(firstBody) as {
      deliveryPolicy: { digest: string; copy: { gitIdentity: { name: string } } };
    };
    expect(firstSnapshot.deliveryPolicy.digest).toBe(computeDeliveryPolicyDigest(DELIVERY_POLICY_GLOBAL as DeliveryPolicySection));
    expect(firstSnapshot.deliveryPolicy.copy.gitIdentity.name).toBe('Ada Lovelace');

    /* 全局默认配置漂移：换成另一身份。 */
    const drifted = await harness.updateGlobalSettings({
      schemaVersion: 2,
      strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
      policies: { deliveryPolicy: DELIVERY_POLICY_DRIFTED },
    });
    expect(drifted.status).toBe('completed');

    /* 旧快照制品逐字节不变（执行依据固定）。 */
    expect(await snapshotBody(harness, first.group.snapshot.artifactId)).toBe(firstBody);

    /* 新 Task 准备捕获新政策。 */
    const second = groupResultOf(await harness.submitPrepare('t-2'));
    const secondSnapshot = JSON.parse(await snapshotBody(harness, second.group.snapshot.artifactId)) as {
      deliveryPolicy: { copy: { gitIdentity: { name: string } } };
    };
    expect(secondSnapshot.deliveryPolicy.copy.gitIdentity.name).toBe('Grace Hopper');
    expect(second.digests.snapshotDigest).not.toBe(first.digests.snapshotDigest);
  });

  it('非法交付政策（push 请求）在配置写入边界被拒绝，不会进入任何快照', async () => {
    const harness = await setupVertical(undefined);
    let thrown: unknown;
    try {
      await harness.updateGlobalSettings({
        schemaVersion: 2,
        strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        policies: {
          deliveryPolicy: { ...DELIVERY_POLICY_GLOBAL, deliveryActions: ['push'] },
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(isPublicError(thrown)).toBe(true);
    expect((thrown as PublicError).code).toBe('invalid_input');
    expect((thrown as PublicError).details?.reason).toBe('unsupported_delivery_action');
  });
});
