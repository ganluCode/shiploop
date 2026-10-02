/**
 * F-008 Runtime 能力兼容性校验（可信装配注入的窄能力描述，纯函数无 I/O）。
 *
 * 覆盖：
 * - createStaticRuntimeCapabilityCatalog：描述符形态校验、重复 runtime/provider ID
 *   明确报错（设计 05 §10：重复 ID/未注册 ID 不静默回退）；
 * - validateStrategyCapabilities：注入的已知描述符通过；未知 runtime、不兼容
 *   provider、未列举 model 带字段定位拒绝；models 省略时 model 作不透明透传；
 *   外来（非任何内置枚举）的 runtime/provider/model 在注入描述符后通过——证明
 *   兼容性来自可信装配注入而非封闭厂商枚举；
 * - 空能力目录对任何策略条目 fail-closed（未装配能力不被伪装为可运行）；
 * - assessSettingsConfiguration：无策略返回明确未配置/不可执行；策略结构合法
 *   也不代表可执行（P01 未装配 Runner/认证/模型执行能力），合法 ≠ 可执行；
 * - 不查询网络模型清单、不导入 Pi SDK（ports 层边界由 scripts/check-boundaries.ts
 *   强制，本模块只依赖 settings-schema/validation 纯契约）。
 */
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  assessSettingsConfiguration,
  createStaticRuntimeCapabilityCatalog,
  validateStrategyCapabilities,
} from '../packages/core/src/ports/runtime-capabilities.ts';
import { validateSettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';

const CONTEXT: ValidationContext = {
  operation: 'Test.operation',
  entity: { type: 'global_settings', id: 'global' },
};

function payload(strategies: unknown): SettingsPayload {
  return validateSettingsPayload({ schemaVersion: 2, strategies }, CONTEXT);
}

function expectValidationError(fn: () => unknown, field?: string, reason?: string): StorageError {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(
      true,
    );
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

/** 已知良好的注入能力目录：pi runtime + 两个 provider（一个枚举模型、一个不列举）。 */
function knownCatalog() {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [
        { providerId: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
        { providerId: 'openai' },
      ],
    },
  ]);
}

describe('F-008 static runtime capability catalog', () => {
  it('builds an in-memory catalog from trusted descriptors and resolves by runtimeId', () => {
    const catalog = knownCatalog();
    expect(catalog.resolve('pi')?.providers.map((provider) => provider.providerId)).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(catalog.resolve('nope')).toBeUndefined();
  });

  it('rejects duplicate runtime IDs instead of silently overriding', () => {
    expectValidationError(
      () =>
        createStaticRuntimeCapabilityCatalog([
          { runtimeId: 'pi', providers: [] },
          { runtimeId: 'pi', providers: [] },
        ]),
      undefined,
      'duplicate_runtime_id',
    );
  });

  it('rejects duplicate provider IDs within one runtime', () => {
    expectValidationError(
      () =>
        createStaticRuntimeCapabilityCatalog([
          { runtimeId: 'pi', providers: [{ providerId: 'a' }, { providerId: 'a' }] },
        ]),
      undefined,
      'duplicate_provider_id',
    );
  });

  it.each([
    ['non-array descriptors', 'pi'],
    ['descriptor missing runtimeId', [{ providers: [] }]],
    ['empty runtimeId', [{ runtimeId: '  ', providers: [] }]],
    ['providers not an array', [{ runtimeId: 'pi', providers: 'openai' }]],
    ['provider missing providerId', [{ runtimeId: 'pi', providers: [{ models: [] }] }]],
    ['models not a string array', [{ runtimeId: 'pi', providers: [{ providerId: 'a', models: [1] }] }]],
  ])('rejects malformed capability descriptors: %s', (_label, descriptors) => {
    expectValidationError(() => createStaticRuntimeCapabilityCatalog(descriptors));
  });
});

describe('F-008 strategy capability compatibility (injected, not a closed enum)', () => {
  it('accepts strategies whose runtime/provider/model are all confirmed by the injected catalog', () => {
    const value = payload({
      defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-5-mini' } },
      purposeStrategies: { judge: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' } },
    });
    expect(() => validateStrategyCapabilities(value, knownCatalog(), CONTEXT)).not.toThrow();
  });

  it('accepts exotic runtime/provider IDs when a trusted descriptor is injected (no closed vendor enum)', () => {
    const catalog = createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'acme-local-runtime', providers: [{ providerId: 'acme-provider' }] },
    ]);
    const value = payload({
      defaultStrategy: { runtime: 'acme-local-runtime', provider: 'acme-provider', model: 'model-x' },
    });
    expect(() => validateStrategyCapabilities(value, catalog, CONTEXT)).not.toThrow();
  });

  it('rejects an unknown runtime ID with a field-located error', () => {
    const value = payload({ defaultStrategy: { runtime: 'ghost', provider: 'anthropic', model: 'm' } });
    expectValidationError(
      () => validateStrategyCapabilities(value, knownCatalog(), CONTEXT),
      'payload.strategies.defaultStrategy.runtime',
      'unknown_runtime',
    );
  });

  it('rejects a provider that the resolved runtime does not support', () => {
    const value = payload({ defaultStrategy: { runtime: 'pi', provider: 'bedrock', model: 'm' } });
    expectValidationError(
      () => validateStrategyCapabilities(value, knownCatalog(), CONTEXT),
      'payload.strategies.defaultStrategy.provider',
      'incompatible_provider',
    );
  });

  it('rejects a model outside the enumerated model list of the provider', () => {
    const value = payload({ defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'gpt-5' } });
    expectValidationError(
      () => validateStrategyCapabilities(value, knownCatalog(), CONTEXT),
      'payload.strategies.defaultStrategy.model',
      'unsupported_model',
    );
  });

  it('passes any non-empty model when the provider descriptor does not enumerate models', () => {
    const value = payload({ defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'future-model-9' } });
    expect(() => validateStrategyCapabilities(value, knownCatalog(), CONTEXT)).not.toThrow();
  });

  it('checks every strategies section with the precise field path (agentOverrides)', () => {
    const value = payload({
      agentOverrides: { 'coding-agent': { runtime: 'pi', provider: 'bedrock', model: 'm' } },
    });
    expectValidationError(
      () => validateStrategyCapabilities(value, knownCatalog(), CONTEXT),
      'payload.strategies.agentOverrides.coding-agent.provider',
      'incompatible_provider',
    );
  });

  it('fails closed when no capability catalog content is assembled at all', () => {
    const emptyCatalog = createStaticRuntimeCapabilityCatalog([]);
    const value = payload({ defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } });
    expectValidationError(
      () => validateStrategyCapabilities(value, emptyCatalog, CONTEXT),
      'payload.strategies.defaultStrategy.runtime',
      'unknown_runtime',
    );
  });

  it('passes trivially when the payload carries no strategy entries', () => {
    expect(() => validateStrategyCapabilities(payload(undefined), knownCatalog(), CONTEXT)).not.toThrow();
    expect(() => validateStrategyCapabilities(payload({}), knownCatalog(), CONTEXT)).not.toThrow();
  });
});

describe('F-008 configuration vs executability assessment', () => {
  it('reports an explicit unconfigured/not-executable result when no strategy is provided', () => {
    const assessment = assessSettingsConfiguration(payload(undefined));
    expect(assessment).toEqual({
      configured: false,
      executable: false,
      reason: 'no_strategy_configured',
    });
    expect(assessSettingsConfiguration(payload({})).configured).toBe(false);
  });

  it('reports structurally valid strategies as configured but NOT executable in P01 (legality ≠ executability)', () => {
    const value = payload({ defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } });
    // 结构 + 兼容性均合法……
    expect(() => validateStrategyCapabilities(value, knownCatalog(), CONTEXT)).not.toThrow();
    // ……但 P01 未装配 Runner/认证/模型执行能力，不得伪装为可运行。
    const assessment = assessSettingsConfiguration(value);
    expect(assessment.configured).toBe(true);
    expect(assessment.executable).toBe(false);
    expect(assessment.reason).toBe('execution_capability_not_assembled');
  });
});
