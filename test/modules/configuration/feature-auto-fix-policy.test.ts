import { expect, it } from 'vitest';
import { validateSettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { mergeEffectiveSettings } from '../../../packages/core/src/application/effective-settings.ts';
import { resolveFeatureAutoFixPolicy } from '../../../packages/core/src/application/feature-auto-fix-policy.ts';
import { listStrategyEntries } from '../../../packages/core/src/ports/settings-schema.ts';
import { createStaticRuntimeCapabilityCatalog, validateStrategyCapabilities } from '../../../packages/core/src/ports/runtime-capabilities.ts';

const context = { operation: 'FeatureAutoFix.test', entity: { type: 'project_settings' as const, projectId: 'project-1' } };
const strategy = { runtime: 'fake', provider: 'test-provider', model: 'strong' };
const enabled = { enabled: true, maxTokenTotal: 10000, timeoutMs: 60000, maxTurns: 20 };

it('accepts explicit bounded auto repair and preserves the absence of optional defaults', () => {
  const policy = { ...enabled, strategy };
  expect(validateSettingsPayload({ schemaVersion: 2, policies: { featureAutoFix: policy } }, context).policies?.featureAutoFix)
    .toEqual(policy);
});

it.each([
  { ...enabled, maxRepairs: 4 }, { ...enabled, maxRepairs: 0 }, { ...enabled, maxRepairs: 1.5 },
  { ...enabled, maxTokenTotal: 0 }, { ...enabled, maxTokenTotal: null },
  { ...enabled, maxTurns: 0 }, { ...enabled, timeoutMs: 999 },
  { enabled: true }, { ...enabled, strategy: { runtime: 'fake' } },
  { ...enabled, strategy: { ...strategy, apiKey: 'must-not-be-accepted' } },
  { ...enabled, prompt: 'bypass approvals' }, { ...enabled, enabled: 'true' },
])('rejects invalid or unbounded feature auto repair %#', policy => {
  expect(() => validateSettingsPayload({ schemaVersion: 2, policies: { featureAutoFix: policy } }, context)).toThrow();
});

it('lets an explicit project disable replace the global enabled policy without inheriting its model', () => {
  const merged = mergeEffectiveSettings({
    global: { scopeRevision: 1, payload: { schemaVersion: 2, policies: { featureAutoFix: { ...enabled, strategy } } } },
    project: { scopeRevision: 2, payload: { schemaVersion: 2, policies: { featureAutoFix: { enabled: false } } } },
  });
  expect(merged.policies.featureAutoFix).toMatchObject({ value: { enabled: false }, source: { kind: 'project_default' } });
  expect(merged.policies.featureAutoFix?.value.strategy).toBeUndefined();
});

it('defaults to disabled, resolves an explicit strategy before high and binds finite caps into a stable digest', () => {
  const merge = (policies: object = {}, strategies: object = {}) => mergeEffectiveSettings({
    project: { scopeRevision: 1, payload: { schemaVersion: 2, policies, strategies } },
  });
  expect(resolveFeatureAutoFixPolicy(merge())).toEqual({ status: 'disabled' });
  expect(resolveFeatureAutoFixPolicy(merge({ featureAutoFix: enabled })))
    .toEqual({ status: 'blocked', reason: 'feature_auto_fix_strategy_missing' });
  expect(resolveFeatureAutoFixPolicy(merge({ featureAutoFix: enabled }, { defaultStrategy: strategy })))
    .toEqual({ status: 'blocked', reason: 'feature_auto_fix_strategy_missing' });
  const ready = resolveFeatureAutoFixPolicy(merge({ featureAutoFix: enabled }, { modelMap: { high: strategy } }));
  expect(ready).toMatchObject({ status: 'ready', strategy, maxRepairs: 3, maxTokenTotal: 10000, maxTurns: 20, timeoutMs: 60000 });
  const explicit = resolveFeatureAutoFixPolicy(merge({ featureAutoFix: { ...enabled, strategy } }));
  expect(explicit).toEqual(ready);
  const changed = resolveFeatureAutoFixPolicy(merge({ featureAutoFix: { ...enabled, strategy, maxRepairs: 2 } }));
  expect(changed).not.toEqual(ready);
  expect(listStrategyEntries(undefined, { featureAutoFix: { ...enabled, strategy } }))
    .toEqual([{ field: 'payload.policies.featureAutoFix.strategy', strategy }]);
});

it('validates repair provider/model capabilities even when no ordinary task strategy is configured', () => {
  const payload = validateSettingsPayload({ schemaVersion: 2, policies: { featureAutoFix: { ...enabled, strategy } } }, context);
  const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['strong'] }] }]);
  expect(() => validateStrategyCapabilities(payload, catalog, context)).not.toThrow();
  const unknown = validateSettingsPayload({ schemaVersion: 2, policies: { featureAutoFix: {
    ...enabled, strategy: { ...strategy, model: 'unknown' },
  } } }, context);
  expect(() => validateStrategyCapabilities(unknown, catalog, context)).toThrow();
});
