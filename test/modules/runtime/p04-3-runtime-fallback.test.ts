import { describe, expect, it } from 'vitest';
import {
  RUNTIME_FALLBACK_SCHEMA_VERSION,
  decideRuntimeFallback,
  validateRuntimeFallbackPlan,
  type RuntimeFallbackDecision,
  type RuntimeFallbackStopDecision,
  type RuntimeFallbackSwitchDecision,
} from '../../../packages/core/src/application/runtime-fallback.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';

const preferred = { runtime: 'runtime-a', provider: 'provider-a', model: 'model-a' };
const backup = { runtime: 'runtime-b', provider: 'provider-b', model: 'model-b' };
const secondBackup = { runtime: 'runtime-c', provider: 'provider-c', model: 'model-c' };

const capabilities = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'runtime-a', providers: [{ providerId: 'provider-a', models: ['model-a'] }] },
  { runtimeId: 'runtime-b', providers: [{ providerId: 'provider-b', models: ['model-b'] }] },
  { runtimeId: 'runtime-c', providers: [{ providerId: 'provider-c', models: ['model-c'] }] },
]);

function plan(overrides: Record<string, unknown> = {}) {
  return validateRuntimeFallbackPlan({
    schemaVersion: RUNTIME_FALLBACK_SCHEMA_VERSION,
    preferred: { strategy: preferred, source: 'task.preferred', approved: true },
    fallbacks: [
      { strategy: backup, source: 'task.fallbacks[0]', approved: true },
      { strategy: secondBackup, source: 'task.fallbacks[1]', approved: true },
    ],
    policy: {
      switchOn: ['quota_blocked', 'transient_connection', 'authentication'],
    },
    ...overrides,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    plan: plan(),
    failure: { category: 'quota_blocked', reason: 'rate_limit_exhausted' },
    nowUtcMs: 10_000,
    capabilities,
    ...overrides,
  };
}

function selected(result: RuntimeFallbackDecision): RuntimeFallbackSwitchDecision {
  expect(result.mode).toBe('switch');
  if (result.mode !== 'switch') throw new Error('expected switch decision');
  return result;
}

function stopped(result: RuntimeFallbackDecision): RuntimeFallbackStopDecision {
  expect(result.mode).toBe('stop');
  if (result.mode !== 'stop') throw new Error('expected stop decision');
  return result;
}

describe('P04-3 F-004 冻结备用链纯决策', () => {
  it('只从已冻结且已批准的有序候选中选择，并返回独立策略快照', () => {
    const result = selected(decideRuntimeFallback(input()));
    expect(result).toMatchObject({
      mode: 'switch',
      nextExecution: 'new_attempt',
      triggerCategory: 'quota_blocked',
      strategySource: 'task.fallbacks[0]',
      strategySnapshot: { ...backup },
      attemptCreated: false,
      occupancyReleased: false,
      nativeHistoryMigrated: false,
    });
    expect(result.candidateEvaluations).toHaveLength(1);
    expect(result.strategySnapshot).not.toBe(backup);
  });

  it('能力或授权失败时跳过候选，不能靠换模型绕过缺陷或未授权', () => {
    const result = selected(decideRuntimeFallback(input({
      authorization: { 'task.fallbacks[0]': 'denied' },
      capabilities: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'runtime-a', providers: [{ providerId: 'provider-a', models: ['model-a'] }] },
        { runtimeId: 'runtime-b', providers: [{ providerId: 'provider-b', models: ['other-model'] }] },
        { runtimeId: 'runtime-c', providers: [{ providerId: 'provider-c', models: ['model-c'] }] },
      ]),
    })));
    expect(result.mode).toBe('switch');
    expect(result.strategySnapshot).toEqual(secondBackup);
    expect(result.candidateEvaluations).toEqual([
      expect.objectContaining({ source: 'task.fallbacks[0]', outcome: 'unavailable', reason: 'authorization_denied' }),
      expect.objectContaining({ source: 'task.fallbacks[1]', outcome: 'selected' }),
    ]);
  });

  it.each([
    ['configuration', 'category_not_switchable'],
    ['protocol', 'category_not_switchable'],
    ['tool_failure', 'category_not_switchable'],
  ] as const)('禁止类别 %s 独立停止', (category, reason) => {
    const result = decideRuntimeFallback(input({ failure: { category, reason: 'terminal' } }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: reason, triggerCategory: category });
  });

  it('限流、认证和连接故障只有显式政策允许才切换；连接未耗尽时不切换', () => {
    expect(decideRuntimeFallback(input({
      plan: plan({ policy: { switchOn: [] } }),
    }))).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable' });
    expect(stopped(decideRuntimeFallback(input({
      failure: { category: 'transient_connection', reason: 'temporary' },
      sameAttemptRetryExhausted: false,
    }))).stopReason).toBe('same_attempt_retry_not_exhausted');
    expect(decideRuntimeFallback(input({
      failure: { category: 'transient_connection', reason: 'temporary' },
      sameAttemptRetryExhausted: true,
    })).mode).toBe('switch');
  });

  it('可信恢复时间未到会跳过候选；未知时间不猜冷却窗口且记录真实请求依据', () => {
    const future = selected(decideRuntimeFallback(input({
      plan: validateRuntimeFallbackPlan({
        ...plan(),
        fallbacks: [
          { strategy: backup, source: 'task.fallbacks[0]', approved: true, trustedRecoveryAtUtcMs: 20_000 },
          { strategy: secondBackup, source: 'task.fallbacks[1]', approved: true },
        ],
      }),
    })));
    expect(future.strategySnapshot).toEqual(secondBackup);
    expect(future.candidateEvaluations[0]).toMatchObject({ reason: 'trusted_recovery_not_ready' });
    expect(future.decisionBasis.recoveryTime).toBe('trusted_time_not_reached');

    const unknown = selected(decideRuntimeFallback(input({
      trustedRecoveryAtUtcMs: null,
    })));
    expect(unknown.strategySnapshot).toEqual(backup);
    expect(unknown.decisionBasis).toMatchObject({ recoveryTime: 'unknown_real_request' });
    expect(JSON.stringify(unknown)).not.toContain('hi');
  });

  it('无候选、全链失败分别给出停止原因，且决策无执行副作用', () => {
    expect(stopped(decideRuntimeFallback(input({
      plan: validateRuntimeFallbackPlan({ ...plan(), fallbacks: [] }),
    }))).stopReason).toBe('no_candidate');
    const result = decideRuntimeFallback(input({
      authorization: { 'task.fallbacks[0]': 'denied', 'task.fallbacks[1]': 'denied' },
    }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: 'all_candidates_unavailable' });
    expect(result).not.toHaveProperty('attemptId');
    expect(result).not.toHaveProperty('releaseOccupancy');
  });

  it('冻结链和策略校验拒绝未批准候选、重复候选与未知字段', () => {
    expect(() => validateRuntimeFallbackPlan({
      ...plan(),
      fallbacks: [{ strategy: backup, source: 'task.fallbacks[0]', approved: false }],
    })).toThrow();
    expect(() => validateRuntimeFallbackPlan({
      ...plan(),
      fallbacks: [
        { strategy: backup, source: 'task.fallbacks[0]', approved: true },
        { strategy: backup, source: 'task.fallbacks[1]', approved: true },
      ],
    })).toThrow();
    expect(() => validateRuntimeFallbackPlan({ ...plan(), unexpected: true })).toThrow();
    expect(() => decideRuntimeFallback(input({ authorization: { 'task.fallbacks[0]': 'unknown' } }))).toThrow();
  });

  it('未知故障类别保持未知并停止，不进入备用链', () => {
    const result = decideRuntimeFallback(input({ failure: { category: 'unknown', reason: 'unknown' } }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable', triggerCategory: 'unknown' });
  });
});
