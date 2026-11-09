import { expect, it } from 'vitest';
import { validateSettingsPayload, validateRuntimeStrategy } from '../../../packages/core/src/ports/settings-schema.ts';
import { selectTaskStrategy, validateTaskExecutionConfig } from '../../../packages/core/src/application/task-strategy-selection.ts';
import { createStaticRuntimeCapabilityCatalog, validateStrategyCapabilities } from '../../../packages/core/src/ports/runtime-capabilities.ts';

const ctx = { operation: 'test.config-fallbacks' };
const strategy = { runtime: 'pi', provider: 'p', model: 'primary' };
const payload = () => ({ schemaVersion: 2, strategies: { modelMap: { medium: { ...strategy,
  fallbacks: [{ runtime: 'pi', provider: 'p', model: 'second' }, { runtime: 'pi', provider: 'p', model: 'third' }],
  fallbackPolicy: { onQuotaBlocked: 'switch', onAuthentication: 'stop' },
} } } });

it('主备顺序写入配置和 Task 快照，单次 Runtime 仍拒绝备用字段', () => {
  const input = payload();
  const saved = validateSettingsPayload(input, ctx);
  const selected = selectTaskStrategy({ project: { scopeRevision: 1, payload: saved }, complexity: 'medium' });
  expect(selected.executionConfig).toMatchObject(input.strategies.modelMap.medium);
  expect(validateTaskExecutionConfig(selected.executionConfig, 'test')).toEqual(selected.executionConfig);
  input.strategies.modelMap.medium.fallbacks[0].model = 'mutated';
  expect((selected.executionConfig as any).fallbacks[0].model).toBe('second');
  expect(() => validateRuntimeStrategy({ ...strategy, fallbacks: [] }, ctx, 'strategy')).toThrow();
});

it('写配置时检查所有备用模型能力，不把未知模型留到执行时才报错', () => {
  const config = validateSettingsPayload(payload(), ctx);
  const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'p', models: ['primary', 'second'] }] }]);
  expect(() => validateStrategyCapabilities(config, catalog, ctx)).toThrow();
});

it.each([
  [{ ...strategy }],
  [{ runtime: 'pi', provider: 'p', model: 'second', fallbacks: [] }],
  [{ runtime: 'pi', provider: 'p', model: 'second' }, { runtime: 'pi', provider: 'p', model: 'second' }],
  Array.from({ length: 33 }, (_, i) => ({ runtime: 'pi', provider: 'p', model: `m${i}` })),
].map(fallbacks => ({ fallbacks })))('拒绝重复、嵌套或过长的备用链 %#', ({ fallbacks }) => {
  const p = payload();
  (p.strategies.modelMap.medium as any).fallbacks = fallbacks;
  expect(() => validateSettingsPayload(p, ctx)).toThrow();
});
