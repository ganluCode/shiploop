/**
 * F-009 全局默认与项目当前覆盖的有效配置合并及来源解释（application 层纯函数）。
 *
 * 覆盖（对应验收标准）：
 * - 三类输入：只有全局默认 / 全局+项目覆盖 / 项目无配置（含空 payload 等价继承）；
 *   双方均无配置返回明确未配置结果（configured=false，不注入默认 Claude/API）；
 * - 完整策略条目整体替换：modelMap/purposeStrategies/agentOverrides/defaultStrategy
 *   同名条目以项目完整条目替换全局，不跨来源拼接 runtime/provider/model，
 *   全局条目的 credentialRef 不泄漏进项目条目；项目条目缺 runtime/provider/model
 *   直接报错，不借全局字段拼成另一个「有效策略」；
 * - 政策合并规则：政策段按段整体覆盖（段内字段不跨来源继承）、数组整体替换不拼接、
 *   空政策段 {} 表示不覆盖该段而继承全局；null 条目/段被拒绝（无 null=清除语义）；
 * - 未知 schemaVersion、未知键、无效项目覆盖与无效全局配置一律报错，
 *   不悄悄忽略或降级成全局配置；
 * - 合并不修改原始 payload（深冻结输入仍成功、快照不变），不解析凭据引用
 *   （credentialRef/endpointRef 原样透传），输出为新对象；
 * - 每项有效条目附精确来源（global_default/project_default + sourceKey + 来源
 *   scope revision），测试断言精确合并值与来源而非只断言对象存在；
 * - 公共入口（packages/core/src/index.ts）导出合并能力，不依赖供应商 SDK。
 */
import { describe, expect, it } from 'vitest';
import {
  mergeEffectiveSettings,
} from '../packages/core/src/application/effective-settings.ts';
import type {
  EffectiveSettings,
} from '../packages/core/src/application/effective-settings.ts';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';

/** 全局默认配置（revision 3）：策略全覆盖 + 三段政策。 */
const GLOBAL_REVISION = 3;
const GLOBAL_PAYLOAD = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  strategies: {
    defaultStrategy: {
      runtime: 'runtime-g',
      provider: 'provider-g',
      model: 'model-g',
      credentialRef: 'cred/global-default',
    },
    modelMap: {
      low: {
        runtime: 'runtime-g-low',
        provider: 'provider-g-low',
        model: 'model-g-low',
        credentialRef: 'cred/global-low',
      },
      medium: {
        runtime: 'runtime-g-medium',
        provider: 'provider-g-medium',
        model: 'model-g-medium',
        endpointRef: 'endpoint/global-medium',
      },
    },
    purposeStrategies: {
      planner: { runtime: 'runtime-g-planner', provider: 'provider-g', model: 'model-g-planner' },
    },
    agentOverrides: {
      'agent-alpha': { runtime: 'runtime-g-alpha', provider: 'provider-g', model: 'model-g-alpha' },
      'agent-beta': { runtime: 'runtime-g-beta', provider: 'provider-g', model: 'model-g-beta' },
    },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 4, workTimeoutMs: 60_000, envAllowlist: ['PATH', 'HOME'] },
    verification: { requireChecksBeforeDone: true },
    securityPolicy: { isolation: 'trusted_project' },
  },
} as const;

/** 项目覆盖（revision 7）：覆盖 modelMap.low、新增 purposeStrategies.judge、替换 agent-beta、段级覆盖 executionLimits。 */
const PROJECT_REVISION = 7;
const PROJECT_PAYLOAD = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  strategies: {
    modelMap: {
      low: { runtime: 'runtime-p-low', provider: 'provider-p-low', model: 'model-p-low' },
    },
    purposeStrategies: {
      judge: { runtime: 'runtime-p-judge', provider: 'provider-p', model: 'model-p-judge' },
    },
    agentOverrides: {
      'agent-beta': { runtime: 'runtime-p-beta', provider: 'provider-p', model: 'model-p-beta' },
    },
  },
  policies: {
    executionLimits: { workTimeoutMs: 5_000, envAllowlist: ['LANG'] },
  },
} as const;

function globalInput(payload: unknown = GLOBAL_PAYLOAD, scopeRevision: unknown = GLOBAL_REVISION) {
  return { scopeRevision, payload };
}

function projectInput(payload: unknown = PROJECT_PAYLOAD, scopeRevision: unknown = PROJECT_REVISION) {
  return { scopeRevision, payload };
}

/** 递归深冻结：证明合并不依赖修改输入。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 断言抛出带字段定位的 validation 错误并返回之（供脱敏/来源断言）。 */
function expectMergeValidationError(input: unknown, field?: string): StorageError {
  try {
    mergeEffectiveSettings(input);
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(true);
    const storageError = error as StorageError;
    expect(storageError.operation).toBe('EffectiveSettings.merge');
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

describe('F-009 有效配置合并：三类输入与未配置结果', () => {
  it('只有全局默认时，全部策略与政策条目来自 global_default 并附来源 revision 与 sourceKey', () => {
    const effective = mergeEffectiveSettings({ global: globalInput() });

    expect(effective.configured).toBe(true);
    expect(effective.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(effective.strategies.defaultStrategy).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.defaultStrategy,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'defaultStrategy' },
    });
    expect(effective.strategies.modelMap.low).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.modelMap.low,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'modelMap.low' },
    });
    expect(effective.strategies.modelMap.medium).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.modelMap.medium,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'modelMap.medium' },
    });
    expect(effective.strategies.modelMap.high).toBeUndefined();
    expect(effective.strategies.purposeStrategies.planner).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.purposeStrategies.planner,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'purposeStrategies.planner' },
    });
    expect(effective.strategies.agentOverrides['agent-alpha']).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.agentOverrides['agent-alpha'],
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'agentOverrides.agent-alpha' },
    });
    expect(effective.policies.executionLimits).toEqual({
      value: GLOBAL_PAYLOAD.policies.executionLimits,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.executionLimits' },
    });
    expect(effective.policies.verification).toEqual({
      value: GLOBAL_PAYLOAD.policies.verification,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.verification' },
    });
    expect(effective.policies.securityPolicy).toEqual({
      value: GLOBAL_PAYLOAD.policies.securityPolicy,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.securityPolicy' },
    });
  });

  it('项目无配置（无项目记录 / 空 payload / 空 strategies+policies）等价于全部继承全局', () => {
    const baseline = mergeEffectiveSettings({ global: globalInput() });
    const noProjectRecord = mergeEffectiveSettings({ global: globalInput(), project: undefined });
    const emptyPayload = mergeEffectiveSettings({
      global: globalInput(),
      project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION }),
    });
    const emptySections = mergeEffectiveSettings({
      global: globalInput(),
      project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: {}, policies: {} }),
    });
    // 项目空 modelMap:{} / purposeStrategies:{} 表示不覆盖、全部继承。
    const emptyMaps = mergeEffectiveSettings({
      global: globalInput(),
      project: projectInput({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        strategies: { modelMap: {}, purposeStrategies: {}, agentOverrides: {} },
      }),
    });

    for (const effective of [noProjectRecord, emptyPayload, emptySections, emptyMaps]) {
      expect(effective).toEqual(baseline);
    }
  });

  it('全局与项目均无任何策略时返回明确未配置结果，不注入默认 Claude/API', () => {
    for (const input of [
      {},
      { global: undefined, project: undefined },
      { global: globalInput({ schemaVersion: SETTINGS_SCHEMA_VERSION }) },
      {
        global: globalInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { verification: {} } }),
        project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION }),
      },
    ]) {
      const effective: EffectiveSettings = mergeEffectiveSettings(input);
      expect(effective.configured).toBe(false);
      expect(effective.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
      expect(effective.strategies.defaultStrategy).toBeUndefined();
      expect(effective.strategies.modelMap).toEqual({});
      expect(effective.strategies.purposeStrategies).toEqual({});
      expect(effective.strategies.agentOverrides).toEqual({});
    }
    // 无政策时 policies 为空，不编造默认政策。
    const effective = mergeEffectiveSettings({});
    expect(effective.policies).toEqual({});
  });

  it('仅项目配置存在（无全局默认）时条目来源为 project_default', () => {
    const effective = mergeEffectiveSettings({ project: projectInput() });

    expect(effective.configured).toBe(true);
    expect(effective.strategies.modelMap.low).toEqual({
      strategy: PROJECT_PAYLOAD.strategies.modelMap.low,
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'modelMap.low' },
    });
    expect(effective.strategies.purposeStrategies.judge).toEqual({
      strategy: PROJECT_PAYLOAD.strategies.purposeStrategies.judge,
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'purposeStrategies.judge' },
    });
    expect(effective.strategies.defaultStrategy).toBeUndefined();
    expect(effective.strategies.modelMap.medium).toBeUndefined();
    expect(effective.policies.executionLimits).toEqual({
      value: PROJECT_PAYLOAD.policies.executionLimits,
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'policies.executionLimits' },
    });
    expect(effective.policies.verification).toBeUndefined();
  });
});

describe('F-009 完整策略条目整体替换（不跨来源拼接执行身份）', () => {
  it('项目 modelMap.low 同名条目整体替换全局，全局 credentialRef 不泄漏进项目条目', () => {
    const effective = mergeEffectiveSettings({ global: globalInput(), project: projectInput() });

    // 精确合并值：恰为项目完整条目；全局条目的 credentialRef 未被拼接进来。
    expect(effective.strategies.modelMap.low).toEqual({
      strategy: { runtime: 'runtime-p-low', provider: 'provider-p-low', model: 'model-p-low' },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'modelMap.low' },
    });
    expect(effective.strategies.modelMap.low?.strategy).not.toHaveProperty('credentialRef');
    // 未覆盖的键继续继承全局。
    expect(effective.strategies.modelMap.medium).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.modelMap.medium,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'modelMap.medium' },
    });
  });

  it('defaultStrategy / purposeStrategies / agentOverrides 同名整体替换，异名键并集且各自附来源', () => {
    const effective = mergeEffectiveSettings({
      global: globalInput(),
      project: projectInput({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        strategies: {
          defaultStrategy: { runtime: 'runtime-p', provider: 'provider-p', model: 'model-p' },
          purposeStrategies: {
            planner: { runtime: 'runtime-p-planner', provider: 'provider-p', model: 'model-p-planner' },
          },
          agentOverrides: {
            'agent-beta': { runtime: 'runtime-p-beta', provider: 'provider-p', model: 'model-p-beta' },
          },
        },
      }),
    });

    expect(effective.strategies.defaultStrategy).toEqual({
      strategy: { runtime: 'runtime-p', provider: 'provider-p', model: 'model-p' },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'defaultStrategy' },
    });
    expect(effective.strategies.purposeStrategies.planner).toEqual({
      strategy: { runtime: 'runtime-p-planner', provider: 'provider-p', model: 'model-p-planner' },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'purposeStrategies.planner' },
    });
    // agentOverrides：agent-alpha 继承全局、agent-beta 被项目整体替换。
    expect(effective.strategies.agentOverrides['agent-alpha']).toEqual({
      strategy: GLOBAL_PAYLOAD.strategies.agentOverrides['agent-alpha'],
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'agentOverrides.agent-alpha' },
    });
    expect(effective.strategies.agentOverrides['agent-beta']).toEqual({
      strategy: { runtime: 'runtime-p-beta', provider: 'provider-p', model: 'model-p-beta' },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'agentOverrides.agent-beta' },
    });
    expect(Object.keys(effective.strategies.agentOverrides).sort()).toEqual(['agent-alpha', 'agent-beta']);
  });

  it('项目策略条目缺 runtime/provider/model 直接报错，不借全局字段拼成另一个有效策略', () => {
    const incompleteEntries: Array<{ missing: string; entry: Record<string, string> }> = [
      { missing: 'model', entry: { runtime: 'runtime-p', provider: 'provider-p' } },
      { missing: 'provider', entry: { runtime: 'runtime-p', model: 'model-p' } },
      { missing: 'runtime', entry: { provider: 'provider-p', model: 'model-p' } },
    ];
    for (const { missing, entry } of incompleteEntries) {
      const error = expectMergeValidationError(
        {
          global: globalInput(),
          project: projectInput({
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            strategies: { modelMap: { low: entry } },
          }),
        },
        `payload.strategies.modelMap.low.${missing}`,
      );
      // 错误归属于项目配置，不是悄悄降级为全局配置。
      expect(error.entity?.type).toBe('project_settings');
    }
    // 同样适用于 defaultStrategy 与 agentOverrides 条目。
    expectMergeValidationError(
      { global: globalInput(), project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: { defaultStrategy: { runtime: 'r' } } }) },
      'payload.strategies.defaultStrategy.provider',
    );
    expectMergeValidationError(
      { project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: { agentOverrides: { 'agent-x': { model: 'm' } } } }) },
      'payload.strategies.agentOverrides.agent-x.runtime',
    );
  });

  it('null 策略条目与 null 政策段被拒绝（无 null=清除语义；不覆盖只能省略该键）', () => {
    expectMergeValidationError(
      { global: globalInput(), project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: { defaultStrategy: null } }) },
      'payload.strategies.defaultStrategy',
    );
    expectMergeValidationError(
      { project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: { modelMap: { low: null } } }) },
      'payload.strategies.modelMap.low',
    );
    expectMergeValidationError(
      { global: globalInput(), project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { executionLimits: null } }) },
      'payload.policies.executionLimits',
    );
  });
});

describe('F-009 政策 / 数组 / 空值合并规则', () => {
  it('政策段按段整体覆盖：段内字段不跨来源继承（段级整体替换，不逐字段拼接）', () => {
    const effective = mergeEffectiveSettings({ global: globalInput(), project: projectInput() });

    // 项目只提供 workTimeoutMs + envAllowlist：全局的 maxConcurrentWorks 不被继承进该段。
    expect(effective.policies.executionLimits).toEqual({
      value: { workTimeoutMs: 5_000, envAllowlist: ['LANG'] },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'policies.executionLimits' },
    });
    expect(effective.policies.executionLimits?.value).not.toHaveProperty('maxConcurrentWorks');
    // 未覆盖的政策段继承全局。
    expect(effective.policies.verification).toEqual({
      value: GLOBAL_PAYLOAD.policies.verification,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.verification' },
    });
    expect(effective.policies.securityPolicy).toEqual({
      value: GLOBAL_PAYLOAD.policies.securityPolicy,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.securityPolicy' },
    });
  });

  it('数组（envAllowlist）整体替换，不做并集/拼接', () => {
    const effective = mergeEffectiveSettings({ global: globalInput(), project: projectInput() });
    expect(effective.policies.executionLimits?.value.envAllowlist).toEqual(['LANG']);
  });

  it('空政策段对象 {} 表示不覆盖该段、继承全局', () => {
    const effective = mergeEffectiveSettings({
      global: globalInput(),
      project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { executionLimits: {}, verification: {} } }),
    });
    expect(effective.policies.executionLimits).toEqual({
      value: GLOBAL_PAYLOAD.policies.executionLimits,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.executionLimits' },
    });
    expect(effective.policies.verification).toEqual({
      value: GLOBAL_PAYLOAD.policies.verification,
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.verification' },
    });
  });

  it('项目提供某政策段而全局没有该段时，来源为 project_default；双方都没有则缺省', () => {
    const effective = mergeEffectiveSettings({
      global: globalInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { verification: { requireChecksBeforeDone: false } } }),
      project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { securityPolicy: { isolation: 'trusted_project' } } }),
    });
    expect(effective.policies.verification).toEqual({
      value: { requireChecksBeforeDone: false },
      source: { kind: 'global_default', scopeRevision: GLOBAL_REVISION, sourceKey: 'policies.verification' },
    });
    expect(effective.policies.securityPolicy).toEqual({
      value: { isolation: 'trusted_project' },
      source: { kind: 'project_default', scopeRevision: PROJECT_REVISION, sourceKey: 'policies.securityPolicy' },
    });
    expect(effective.policies.executionLimits).toBeUndefined();
  });

  it('无效政策数值在项目覆盖中被拒绝，不降级为全局政策', () => {
    expectMergeValidationError(
      {
        global: globalInput(),
        project: projectInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          policies: { executionLimits: { maxConcurrentWorks: 0 } },
        }),
      },
      'payload.policies.executionLimits.maxConcurrentWorks',
    );
    expectMergeValidationError(
      {
        global: globalInput(),
        project: projectInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          policies: { executionLimits: { envAllowlist: ['MY_API_KEY'] } },
        }),
      },
      'payload.policies.executionLimits.envAllowlist[0]',
    );
  });
});

describe('F-009 非法输入不静默忽略、不降级', () => {
  it('未知 schemaVersion 的项目覆盖报错，不悄悄降级成全局配置', () => {
    for (const version of [1, 3, 0, '2']) {
      const error = expectMergeValidationError(
        { global: globalInput(), project: projectInput({ schemaVersion: version }) },
        'payload.schemaVersion',
      );
      expect(error.entity?.type).toBe('project_settings');
    }
  });

  it('未知键 / 未知政策段在项目覆盖中报错（任意 JSON 不能冒充执行配置）', () => {
    expectMergeValidationError(
      { global: globalInput(), project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, unknownKey: {} }) },
      'payload',
    );
    expectMergeValidationError(
      { global: globalInput(), project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, policies: { memoryPolicy: {} } }) },
      'payload.policies',
    );
    // 明文秘密字段同样被拒绝，且错误不回显秘密值。
    const error = expectMergeValidationError(
      {
        global: globalInput(),
        project: projectInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: { runtime: 'r', provider: 'p', model: 'm', apiKey: 'sk-synthetic-secret-9f8e7d' } },
        }),
      },
      'payload.strategies.defaultStrategy',
    );
    expect(JSON.stringify(error.details)).not.toContain('sk-synthetic-secret-9f8e7d');
    expect(error.message).not.toContain('sk-synthetic-secret-9f8e7d');
  });

  it('无效全局配置同样报错，不被合法项目覆盖掩盖', () => {
    const error = expectMergeValidationError(
      { global: globalInput({ schemaVersion: 1 }), project: projectInput() },
      'payload.schemaVersion',
    );
    expect(error.entity?.type).toBe('global_settings');
  });

  it('scopeRevision 必须是 ≥1 整数：缺失 / 0 / 负数 / 小数 / 字符串均拒绝', () => {
    expectMergeValidationError({ global: { payload: GLOBAL_PAYLOAD } }, 'global.scopeRevision');
    for (const bad of [0, -1, 1.5, '3']) {
      expectMergeValidationError({ global: globalInput(GLOBAL_PAYLOAD, bad) }, 'global.scopeRevision');
      expectMergeValidationError({ project: projectInput(PROJECT_PAYLOAD, bad) }, 'project.scopeRevision');
    }
  });

  it('输入必须是普通对象且顶层只允许 global/project 键', () => {
    expectMergeValidationError(null, 'input');
    expectMergeValidationError([], 'input');
    expectMergeValidationError({ global: globalInput(), extra: {} }, 'input');
    expectMergeValidationError({ global: null, project: 'not-an-object' }, 'project');
    // scope 输入缺 payload 拒绝。
    expectMergeValidationError({ global: { scopeRevision: 1 } }, 'global.payload');
  });
});

describe('F-009 合并纯度与凭据引用卫生', () => {
  it('深冻结输入仍合并成功，且输入快照逐字节不变（不修改原始 payload）', () => {
    const global = deepFreeze(structuredClone({ scopeRevision: GLOBAL_REVISION, payload: GLOBAL_PAYLOAD }));
    const project = deepFreeze(structuredClone({ scopeRevision: PROJECT_REVISION, payload: PROJECT_PAYLOAD }));
    const globalSnapshot = JSON.stringify(global);
    const projectSnapshot = JSON.stringify(project);

    const effective = mergeEffectiveSettings({ global, project });

    expect(effective.configured).toBe(true);
    expect(JSON.stringify(global)).toBe(globalSnapshot);
    expect(JSON.stringify(project)).toBe(projectSnapshot);
  });

  it('输出为新对象，不与输入 payload 共享引用（调用方改写结果不影响输入）', () => {
    const global = structuredClone({ scopeRevision: GLOBAL_REVISION, payload: GLOBAL_PAYLOAD });
    const effective = mergeEffectiveSettings({ global });

    expect(effective.strategies.defaultStrategy?.strategy).not.toBe(global.payload.strategies.defaultStrategy);
    expect(effective.strategies.modelMap.low?.strategy).not.toBe(global.payload.strategies.modelMap.low);
    expect(effective.policies.executionLimits?.value).not.toBe(global.payload.policies.executionLimits);
    expect(effective.policies.executionLimits?.value.envAllowlist).not.toBe(
      global.payload.policies.executionLimits.envAllowlist,
    );
  });

  it('不解析凭据引用：credentialRef / endpointRef 按引用字符串原样透传', () => {
    const effective = mergeEffectiveSettings({ global: globalInput() });
    expect(effective.strategies.defaultStrategy?.strategy.credentialRef).toBe('cred/global-default');
    expect(effective.strategies.modelMap.medium?.strategy.endpointRef).toBe('endpoint/global-medium');
  });
});

describe('F-009 公共入口', () => {
  it('mergeEffectiveSettings 从 Core 公共入口可导入（普通 Core 入口，不依赖供应商 SDK）', async () => {
    const publicEntry = await import('../packages/core/src/index.ts');
    expect(typeof publicEntry.mergeEffectiveSettings).toBe('function');
    const effective = publicEntry.mergeEffectiveSettings({ global: globalInput(), project: projectInput() });
    expect(effective.configured).toBe(true);
    expect(effective.strategies.modelMap.low?.source.kind).toBe('project_default');
  });
});
