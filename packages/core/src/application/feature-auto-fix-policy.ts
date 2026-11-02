import { createHash } from 'node:crypto';
import { stableStringify } from '../ports/feature-plan.js';
import type { RuntimeStrategyV1 } from '../ports/settings-schema.js';
import type { EffectiveSettings } from './effective-settings.js';

export type ResolvedFeatureAutoFixPolicy =
  | { readonly status: 'disabled' }
  | { readonly status: 'blocked'; readonly reason: 'feature_auto_fix_strategy_missing' }
  | { readonly status: 'ready'; readonly strategy: RuntimeStrategyV1; readonly maxRepairs: number;
      readonly maxTokenTotal: number; readonly timeoutMs: number; readonly maxTurns: number; readonly policyDigest: string };

/** Configuration readiness is not permission to start a Runtime or reset a budget. */
export function resolveFeatureAutoFixPolicy(effective: EffectiveSettings): ResolvedFeatureAutoFixPolicy {
  const policy = effective.policies.featureAutoFix?.value;
  if (policy?.enabled !== true) return { status: 'disabled' };
  const selected = policy.strategy ?? effective.strategies.modelMap.high?.strategy;
  if (!selected) return { status: 'blocked', reason: 'feature_auto_fix_strategy_missing' };
  const material = { strategy: { ...selected }, maxRepairs: policy.maxRepairs ?? 3,
    maxTokenTotal: policy.maxTokenTotal!, timeoutMs: policy.timeoutMs!, maxTurns: policy.maxTurns! };
  const policyDigest = createHash('sha256').update(`shiploop:feature-auto-fix:v1\0${stableStringify(material)}`).digest('hex');
  return Object.freeze({ status: 'ready', ...material, strategy: Object.freeze(material.strategy), policyDigest });
}
