/**
 * P03-1 / F-003 创建 Task 时完整策略副本与来源选择（application 层纯选择逻辑）。
 *
 * 覆盖（对应验收标准）：
 * - 复用 mergeEffectiveSettings 与 schemaVersion=2 完整策略校验：按复杂度/
 *   defaultStrategy 解析契约选择整体条目，不跨来源拼接 runtime/provider/model
 *   （项目条目缺字段直接拒绝，不借全局字段补齐）；
 * - 各复杂度（low/medium/high）→ `modelMap.<complexity>` 整体副本；复杂度缺省或
 *   无对应条目回退 defaultStrategy；userOverride（明确完整用户覆盖）优先于全部
 *   默认解析（覆盖优先级：userOverride > 复杂度条目 > defaultStrategy）；
 * - 三来源输出：project_default / global_default / user_override 与 sourceKey
 *   （modelMap.low / defaultStrategy / userOverride）；来源仅作解释，不是运行时
 *   动态路由；
 * - 副本独立性：调用方输入对象后续变化不改变已生成副本；重复调用不共享引用；
 * - 拒绝矩阵：缺任一必需策略字段、无匹配的已确认默认（no_strategy_match）、
 *   不完整覆盖（不从默认拼补）、非法凭据引用（credential_in_url 等）、秘密正文
 *   字段（apiKey/token/password，错误不回显秘密正文）、未知字段、非法复杂度；
 * - 不硬编码模型：选择模块源码不含厂商/模型字面量，输出 runtime/provider/model
 *   严格来自被选中的配置条目；
 * - 合法 ≠ 可执行：选择成功不产出可执行声明（结果键仅为副本 + 来源说明；
 *   assessSettingsConfiguration 在生产 Runtime 能力未装配时仍为 executable:false）；
 * - validateTaskExecutionConfig：副本形态 round-trip 与拒绝矩阵（schemaVersion
 *   门槛、缺字段、未知字段、秘密正文、非法引用）；
 * - 公共入口（packages/core/src/index.ts）导出选择能力。
 *
 * 本文件为纯函数测试：无 I/O、无数据库、无模型调用。Task 策略编辑、重新应用默认、
 * 凭据解析与 Attempt 快照不在本任务范围（见 docs/p03-1-task-strategy-selection.md）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TASK_STRATEGY_CONFIG_SOURCES,
  TASK_STRATEGY_SELECTION_OPERATION,
  TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY,
  selectTaskStrategy,
  validateTaskExecutionConfig,
} from '../packages/core/src/application/task-strategy-selection.ts';
import type {
  TaskExecutionConfigV1,
} from '../packages/core/src/application/task-strategy-selection.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import { assessSettingsConfiguration } from '../packages/core/src/ports/runtime-capabilities.ts';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import * as coreEntry from '../packages/core/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTION_MODULE_PATH = resolve(
  REPO_ROOT,
  'packages/core/src/application/task-strategy-selection.ts',
);

const GLOBAL_REVISION = 3;
const PROJECT_REVISION = 7;

/** 全局默认策略：defaultStrategy + 三个复杂度条目（low 带 credentialRef）。 */
const GLOBAL_STRATEGIES = {
  defaultStrategy: {
    runtime: 'runtime-g',
    provider: 'provider-g',
    model: 'model-g',
    credentialRef: 'cred/global-default',
  },
  modelMap: {
    low: {
      runtime: 'runtime-g-low',
      provider: 'provider-g',
      model: 'model-g-low',
      credentialRef: 'cred/global-low',
    },
    medium: {
      runtime: 'runtime-g-medium',
      provider: 'provider-g',
      model: 'model-g-medium',
      endpointRef: 'endpoint/global-medium',
    },
    high: { runtime: 'runtime-g-high', provider: 'provider-g', model: 'model-g-high' },
  },
} as const;

/** 项目覆盖：整体替换 modelMap.low（无 credentialRef——不得从全局条目拼补）。 */
const PROJECT_STRATEGIES = {
  defaultStrategy: { runtime: 'runtime-p', provider: 'provider-p', model: 'model-p' },
  modelMap: {
    low: { runtime: 'runtime-p-low', provider: 'provider-p', model: 'model-p-low' },
  },
} as const;

function globalInput(payload: unknown = { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: GLOBAL_STRATEGIES }) {
  return { scopeRevision: GLOBAL_REVISION, payload };
}

function projectInput(payload: unknown = { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: PROJECT_STRATEGIES }) {
  return { scopeRevision: PROJECT_REVISION, payload };
}

/** 递归深冻结：证明选择不依赖修改输入。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 断言抛出 validation StorageError 并返回之（供字段定位/脱敏断言）。 */
function expectSelectionError(input: unknown, field?: string, reason?: string): StorageError {
  try {
    selectTaskStrategy(input);
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(true);
    const storageError = error as StorageError;
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    if (reason !== undefined) {
      expect(storageError.details?.reason).toBe(reason);
    }
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

/** 由完整策略条目构造期望的 execution_config 副本（schemaVersion=2 标记 + 扁平条目）。 */
function expectedConfig(entry: {
  runtime: string;
  provider: string;
  model: string;
  credentialRef?: string;
  endpointRef?: string;
}): TaskExecutionConfigV1 {
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, ...entry };
}

describe('F-003 各复杂度：modelMap 整体条目副本', () => {
  it.each(['low', 'medium', 'high'] as const)(
    '复杂度 %s 选择 modelMap.%s 的完整独立副本（global_default + sourceKey）',
    (complexity) => {
      const entry = GLOBAL_STRATEGIES.modelMap[complexity];
      const selection = selectTaskStrategy({ global: globalInput(), complexity });
      expect(selection).toEqual({
        executionConfig: expectedConfig(entry),
        configSource: 'global_default',
        configSourceKey: `modelMap.${complexity}`,
      });
    },
  );

  it('复杂度条目整体替换：项目条目无 credentialRef 时不从全局条目拼补（不跨来源拼接）', () => {
    const selection = selectTaskStrategy({
      global: globalInput(),
      project: projectInput(),
      complexity: 'low',
    });
    // 项目条目整体替换全局条目：全局 low 的 credentialRef 不得泄漏进副本。
    expect(selection.executionConfig).toEqual(expectedConfig(PROJECT_STRATEGIES.modelMap.low));
    expect(selection.executionConfig).not.toHaveProperty('credentialRef');
    expect(selection.configSource).toBe('project_default');
    expect(selection.configSourceKey).toBe('modelMap.low');
  });

  it('项目未覆盖的复杂度继续继承全局条目（global_default + sourceKey）', () => {
    const selection = selectTaskStrategy({
      global: globalInput(),
      project: projectInput(),
      complexity: 'high',
    });
    expect(selection).toEqual({
      executionConfig: expectedConfig(GLOBAL_STRATEGIES.modelMap.high),
      configSource: 'global_default',
      configSourceKey: 'modelMap.high',
    });
  });
});

describe('F-003 覆盖优先级与回退（userOverride > 复杂度条目 > defaultStrategy）', () => {
  it('明确完整用户覆盖 userOverride 优先于复杂度条目与 defaultStrategy', () => {
    const userOverride = {
      runtime: 'runtime-u',
      provider: 'provider-u',
      model: 'model-u',
      endpointRef: 'endpoint/user',
    };
    const selection = selectTaskStrategy({
      global: globalInput(),
      project: projectInput(),
      complexity: 'low',
      userOverride,
    });
    expect(selection).toEqual({
      executionConfig: expectedConfig(userOverride),
      configSource: 'user_override',
      configSourceKey: TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY,
    });
    expect(selection.configSourceKey).toBe('userOverride');
  });

  it('复杂度条目优先于 defaultStrategy', () => {
    const selection = selectTaskStrategy({ global: globalInput(), complexity: 'low' });
    expect(selection.configSourceKey).toBe('modelMap.low');
    expect(selection.executionConfig.model).toBe('model-g-low');
  });

  it.each([
    ['复杂度省略', undefined],
    ['复杂度为 null', null],
  ] as const)('%s 时回退 defaultStrategy（项目覆盖优先于全局）', (_label, complexity) => {
    const selection = selectTaskStrategy({
      global: globalInput(),
      project: projectInput(),
      complexity,
    });
    expect(selection).toEqual({
      executionConfig: expectedConfig(PROJECT_STRATEGIES.defaultStrategy),
      configSource: 'project_default',
      configSourceKey: 'defaultStrategy',
    });
  });

  it('复杂度无对应 modelMap 条目时回退 defaultStrategy（全局继承）', () => {
    const selection = selectTaskStrategy({
      global: globalInput({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        strategies: {
          defaultStrategy: GLOBAL_STRATEGIES.defaultStrategy,
          modelMap: { low: GLOBAL_STRATEGIES.modelMap.low },
        },
      }),
      project: projectInput(),
      complexity: 'medium',
    });
    // 全局/项目均无 modelMap.medium：回退 defaultStrategy（项目条目整体优先）。
    expect(selection).toEqual({
      executionConfig: expectedConfig(PROJECT_STRATEGIES.defaultStrategy),
      configSource: 'project_default',
      configSourceKey: 'defaultStrategy',
    });
  });

  it('复杂度已确认但无对应条目且无 defaultStrategy：拒绝而非拼接或猜模型', () => {
    const error = expectSelectionError(
      {
        global: globalInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { modelMap: { medium: GLOBAL_STRATEGIES.modelMap.medium } },
        }),
        complexity: 'low',
      },
      'strategies',
      'no_strategy_match',
    );
    expect(error.message).not.toContain('model-g');
  });

  it('无复杂度索引时不猜 modelMap 条目：无 defaultStrategy 即拒绝', () => {
    expectSelectionError(
      {
        global: globalInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { modelMap: { low: GLOBAL_STRATEGIES.modelMap.low } },
        }),
        complexity: null,
      },
      'strategies',
      'no_strategy_match',
    );
  });

  it.each(['', 'very-high', 'LOW', 42, {}] as const)('非法复杂度取值 %s 明确拒绝', (complexity) => {
    expectSelectionError({ global: globalInput(), complexity }, 'complexity');
  });
});

describe('F-003 无策略、不硬编码模型与合法 ≠ 可执行', () => {
  it('全局与项目均无任一策略时拒绝（no_strategy_match），不注入任何默认厂商/模型', () => {
    const error = expectSelectionError(
      {
        global: globalInput({ schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: {} }),
        project: projectInput({ schemaVersion: SETTINGS_SCHEMA_VERSION }),
        complexity: 'low',
      },
      'strategies',
      'no_strategy_match',
    );
    expect(error.message).not.toContain('model-g');
    expect(error.message).not.toContain('model-p');
    expect(JSON.stringify(error.details)).not.toContain('model-g');
  });

  it('完全未配置（无任何来源）同样明确拒绝', () => {
    expectSelectionError({ complexity: 'low' }, 'strategies', 'no_strategy_match');
  });

  it('选择模块源码不含厂商/模型字面量（不硬编码模型）', () => {
    const source = readFileSync(SELECTION_MODULE_PATH, 'utf-8');
    for (const token of ['claude', 'anthropic', 'openai', 'gpt-', 'gemini', 'deepseek', 'mistral']) {
      expect(source.toLowerCase()).not.toContain(token);
    }
  });

  it('输出 runtime/provider/model 严格来自被选中的配置条目', () => {
    const first = selectTaskStrategy({
      global: globalInput({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        strategies: {
          defaultStrategy: { runtime: 'r-1', provider: 'p-1', model: 'm-1' },
        },
      }),
    });
    const second = selectTaskStrategy({
      global: globalInput({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        strategies: {
          defaultStrategy: { runtime: 'r-2', provider: 'p-2', model: 'm-2' },
        },
      }),
    });
    expect(first.executionConfig).toMatchObject({ runtime: 'r-1', provider: 'p-1', model: 'm-1' });
    expect(second.executionConfig).toMatchObject({ runtime: 'r-2', provider: 'p-2', model: 'm-2' });
  });

  it('合法 ≠ 可执行：选择成功不产出可执行声明，生产能力未装配时仍 executable:false', () => {
    const selection = selectTaskStrategy({ global: globalInput(), complexity: 'low' });
    // 结果键仅为副本 + 来源说明：没有 executable / 可运行类声明。
    expect(Object.keys(selection).sort()).toEqual(['configSource', 'configSourceKey', 'executionConfig']);
    const assessment = assessSettingsConfiguration({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      strategies: GLOBAL_STRATEGIES,
    });
    expect(assessment.configured).toBe(true);
    expect(assessment.executable).toBe(false);
    expect(assessment.reason).toBe('execution_capability_not_assembled');
  });
});

describe('F-003 完整性与拒绝矩阵', () => {
  it.each(['runtime', 'provider', 'model'] as const)(
    'userOverride 缺 %s 明确拒绝（不完整覆盖不从默认拼补）',
    (missing) => {
      const incomplete: Record<string, unknown> = {
        runtime: 'runtime-u',
        provider: 'provider-u',
        model: 'model-u',
      };
      delete incomplete[missing];
      const error = expectSelectionError(
        { global: globalInput(), userOverride: incomplete },
        `userOverride.${missing}`,
      );
      expect(error.message).not.toContain('model-g');
    },
  );

  it('不完整 userOverride 不被默认条目补齐：缺 model 时拒绝而不是拼出「有效策略」', () => {
    expectSelectionError(
      {
        global: globalInput(),
        userOverride: { runtime: 'runtime-u', provider: 'provider-u' },
      },
      'userOverride.model',
    );
  });

  it('项目条目缺必需字段直接拒绝，不借全局字段拼成有效策略', () => {
    expectSelectionError(
      {
        global: globalInput(),
        project: projectInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { modelMap: { low: { runtime: 'runtime-p-low', provider: 'provider-p' } } },
        }),
        complexity: 'low',
      },
      'payload.strategies.modelMap.low.model',
    );
  });

  it.each([
    ['apiKey', 'sk-synthetic-apiKey-77c1'],
    ['token', 'synthetic-token-88d2'],
    ['password', 'synthetic-password-99e3'],
  ])('userOverride 秘密正文字段 %s 明确拒绝且错误不回显秘密', (key, secret) => {
    const error = expectSelectionError(
      {
        global: globalInput(),
        userOverride: {
          runtime: 'runtime-u',
          provider: 'provider-u',
          model: 'model-u',
          [key]: secret,
        },
      },
      'userOverride',
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it('配置条目中的秘密正文字段同样拒绝（复用 schemaVersion=2 校验）', () => {
    const error = expectSelectionError(
      {
        global: globalInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: {
            defaultStrategy: {
              runtime: 'runtime-g',
              provider: 'provider-g',
              model: 'model-g',
              apiKey: 'sk-synthetic-apiKey-77c1',
            },
          },
        }),
        complexity: 'low',
      },
      'payload.strategies.defaultStrategy',
    );
    expect(error.message).not.toContain('sk-synthetic-apiKey-77c1');
    expect(JSON.stringify(error.details)).not.toContain('sk-synthetic-apiKey-77c1');
  });

  it('userOverride 未知字段拒绝（schemaVersion 限定结构不接受任意对象）', () => {
    expectSelectionError(
      {
        global: globalInput(),
        userOverride: {
          runtime: 'runtime-u',
          provider: 'provider-u',
          model: 'model-u',
          temperature: 0.2,
        },
      },
      'userOverride',
    );
  });

  it('选择输入顶层未知键拒绝', () => {
    expectSelectionError(
      { global: globalInput(), complexity: 'low', purpose: 'planner' },
      'input',
    );
  });

  it('配置 payload 未知键拒绝（复用 schemaVersion=2 校验）', () => {
    expectSelectionError(
      {
        global: globalInput({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: GLOBAL_STRATEGIES.defaultStrategy },
          memoryPolicy: {},
        }),
        complexity: 'low',
      },
      'payload',
    );
  });

  it.each([
    ['credentialRef', 'https://user:synthetic-password-9f27@example.com'],
    ['endpointRef', 'https://ci-bot:synthetic-token-41ab@gateway.internal/v1'],
  ])('非法凭据引用（带凭据 URL）在 %s 上拒绝且错误不回显秘密', (field, url) => {
    const error = expectSelectionError(
      {
        global: globalInput(),
        userOverride: {
          runtime: 'runtime-u',
          provider: 'provider-u',
          model: 'model-u',
          [field]: url,
        },
      },
      `userOverride.${field}`,
      'credential_in_url',
    );
    expect(error.message).not.toContain('synthetic-password-9f27');
    expect(error.message).not.toContain('synthetic-token-41ab');
    expect(JSON.stringify(error.details)).not.toContain('synthetic-password-9f27');
    expect(JSON.stringify(error.details)).not.toContain('synthetic-token-41ab');
  });

  it('含空白/控制字符的凭据引用拒绝', () => {
    expectSelectionError(
      {
        global: globalInput(),
        userOverride: {
          runtime: 'runtime-u',
          provider: 'provider-u',
          model: 'model-u',
          credentialRef: 'cred with space',
        },
      },
      'userOverride.credentialRef',
    );
  });

  it('userOverride 为 null 或非对象时不当作「未提供」，明确拒绝', () => {
    expectSelectionError({ global: globalInput(), userOverride: null }, 'userOverride');
    expectSelectionError({ global: globalInput(), userOverride: 'model-u' }, 'userOverride');
  });
});

describe('F-003 副本独立性与来源仅作解释', () => {
  it('调用方输入对象后续变化不改变已生成副本（配置来源路径）', () => {
    // 使用独立深拷贝夹具（不共享常量引用），只允许修改「调用方自己的输入对象」。
    const globalScope = globalInput({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      strategies: JSON.parse(JSON.stringify(GLOBAL_STRATEGIES)),
    });
    const projectScope = projectInput({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      strategies: JSON.parse(JSON.stringify(PROJECT_STRATEGIES)),
    });
    const selection = selectTaskStrategy({
      global: globalScope,
      project: projectScope,
      complexity: 'low',
    });
    const before = JSON.parse(JSON.stringify(selection.executionConfig)) as unknown;

    (globalScope.payload as { strategies: { modelMap: { low: { model: string } } } })
      .strategies.modelMap.low.model = 'mutated-global';
    (projectScope.payload as { strategies: { modelMap: { low: { model: string } } } })
      .strategies.modelMap.low.model = 'mutated-project';

    expect(selection.executionConfig).toEqual(before);
    expect(selection.executionConfig.model).toBe('model-p-low');
  });

  it('调用方输入对象后续变化不改变已生成副本（userOverride 路径）', () => {
    const userOverride: Record<string, unknown> = {
      runtime: 'runtime-u',
      provider: 'provider-u',
      model: 'model-u',
    };
    const selection = selectTaskStrategy({ global: globalInput(), userOverride });
    userOverride.model = 'mutated-user';
    userOverride.credentialRef = 'cred/late';
    expect(selection.executionConfig).toEqual(expectedConfig({
      runtime: 'runtime-u',
      provider: 'provider-u',
      model: 'model-u',
    }));
  });

  it('深冻结输入仍成功（纯选择不修改输入）', () => {
    const selection = selectTaskStrategy(
      deepFreeze({
        global: globalInput(),
        project: projectInput(),
        complexity: 'low',
      }),
    );
    expect(selection.configSource).toBe('project_default');
  });

  it('重复调用不共享副本引用；修改一次结果不影响后续选择', () => {
    const input = { global: globalInput(), complexity: 'low' as const };
    const first = selectTaskStrategy(input);
    const second = selectTaskStrategy(input);
    expect(first.executionConfig).not.toBe(second.executionConfig);
    (first.executionConfig as { model: string }).model = 'mutated-output';
    expect(second.executionConfig.model).toBe('model-g-low');
    expect(selectTaskStrategy(input).executionConfig.model).toBe('model-g-low');
  });

  it('来源与 sourceKey 是纯解释字符串（枚举冻结值），不是运行时动态引用', () => {
    expect(TASK_STRATEGY_CONFIG_SOURCES).toEqual(['project_default', 'global_default', 'user_override']);
    const cases = [
      selectTaskStrategy({ global: globalInput(), complexity: 'low' }),
      selectTaskStrategy({ global: globalInput(), project: projectInput(), complexity: 'low' }),
      selectTaskStrategy({ global: globalInput(), userOverride: { runtime: 'r', provider: 'p', model: 'm' } }),
    ];
    for (const selection of cases) {
      expect(TASK_STRATEGY_CONFIG_SOURCES).toContain(selection.configSource);
      expect(typeof selection.configSourceKey).toBe('string');
      // 副本可 JSON 序列化为普通对象：不含函数/活引用（无动态路由）。
      expect(JSON.parse(JSON.stringify(selection.executionConfig))).toEqual(selection.executionConfig);
    }
  });
});

describe('F-003 validateTaskExecutionConfig（副本形态语义校验）', () => {
  it('选择输出 round-trip 通过且逐字段一致', () => {
    const selection = selectTaskStrategy({ global: globalInput(), complexity: 'medium' });
    expect(validateTaskExecutionConfig(selection.executionConfig, 'test.roundtrip')).toEqual(
      selection.executionConfig,
    );
  });

  it('接受完整副本（含可选引用字段）', () => {
    const copy = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runtime: 'runtime-u',
      provider: 'provider-u',
      model: 'model-u',
      credentialRef: 'keyring://primary',
      endpointRef: 'endpoint/primary',
    };
    expect(validateTaskExecutionConfig(copy, 'test.full')).toEqual(copy);
  });

  it.each([1, 3, undefined, null])('schemaVersion %s 不是 2 时拒绝', (schemaVersion) => {
    const error = (() => {
      try {
        validateTaskExecutionConfig(
          { schemaVersion, runtime: 'r', provider: 'p', model: 'm' },
          'test.schema',
        );
      } catch (caught) {
        return caught;
      }
      throw new Error('expected a validation StorageError to be thrown');
    })();
    expect(isStorageError(error, 'validation')).toBe(true);
    expect((error as StorageError).details?.field).toBe('executionConfig.schemaVersion');
  });

  it.each(['runtime', 'provider', 'model'] as const)('缺 %s 时拒绝', (missing) => {
    const copy: Record<string, unknown> = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runtime: 'r',
      provider: 'p',
      model: 'm',
    };
    delete copy[missing];
    try {
      validateTaskExecutionConfig(copy, 'test.missing');
      throw new Error('expected a validation StorageError to be thrown');
    } catch (error) {
      expect(isStorageError(error, 'validation')).toBe(true);
      expect((error as StorageError).details?.field).toBe(`executionConfig.${missing}`);
    }
  });

  it('未知字段与秘密正文字段拒绝且不回显秘密', () => {
    try {
      validateTaskExecutionConfig(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          runtime: 'r',
          provider: 'p',
          model: 'm',
          apiKey: 'sk-synthetic-apiKey-77c1',
        },
        'test.unknown',
      );
      throw new Error('expected a validation StorageError to be thrown');
    } catch (error) {
      expect(isStorageError(error, 'validation')).toBe(true);
      expect((error as StorageError).details?.field).toBe('executionConfig');
      expect((error as StorageError).message).not.toContain('sk-synthetic-apiKey-77c1');
    }
    expect(() =>
      validateTaskExecutionConfig(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          runtime: 'r',
          provider: 'p',
          model: 'm',
          temperature: 0.2,
        },
        'test.unknown',
      ),
    ).toThrow();
  });

  it('非法凭据引用拒绝（credential_in_url）', () => {
    try {
      validateTaskExecutionConfig(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          runtime: 'r',
          provider: 'p',
          model: 'm',
          credentialRef: 'https://user:synthetic-password-9f27@example.com',
        },
        'test.credential',
      );
      throw new Error('expected a validation StorageError to be thrown');
    } catch (error) {
      expect(isStorageError(error, 'validation')).toBe(true);
      expect((error as StorageError).details?.reason).toBe('credential_in_url');
      expect((error as StorageError).message).not.toContain('synthetic-password-9f27');
    }
  });

  it('非对象输入拒绝', () => {
    for (const value of ['copy', 42, null, [{ runtime: 'r' }]]) {
      expect(() => validateTaskExecutionConfig(value, 'test.shape')).toThrow();
    }
  });

  it('来源选择操作名固定（结构化错误 operation 可核对）', () => {
    expect(TASK_STRATEGY_SELECTION_OPERATION).toBe('TaskStrategySelection.select');
    const error = expectSelectionError({ complexity: 'low' });
    expect(error.operation).toBe(TASK_STRATEGY_SELECTION_OPERATION);
  });
});

describe('F-003 公共入口导出（不另立私有入口）', () => {
  it('shiploop-core 公共入口导出选择与副本校验能力', () => {
    expect(typeof coreEntry.selectTaskStrategy).toBe('function');
    expect(typeof coreEntry.validateTaskExecutionConfig).toBe('function');
    expect(coreEntry.TASK_STRATEGY_CONFIG_SOURCES).toEqual(TASK_STRATEGY_CONFIG_SOURCES);
    expect(coreEntry.TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY).toBe('userOverride');
  });
});
