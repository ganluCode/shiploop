import { expect, it } from 'vitest';
import { parseProductionPiConfig } from '../../../packages/host/src/runtime/production-pi-config.js';
import { createRuntimeRequestRetryController } from '../../../packages/core/src/application/runtime-request-retry.js';
import { validateSettingsPayload } from '../../../packages/core/src/ports/settings-schema.js';
import { mergeEffectiveSettings } from '../../../packages/core/src/application/effective-settings.js';

it('accepts project JSON/YAML policies and merges them as explicit policy sections', () => {
  const payload = { schemaVersion: 2, policies: { piAgent: { transient_retry_attempts: 10,
    transient_retry_backoff_base_seconds: 1, fallback_on_authentication: true },
    piExecution: { thinkingLevel: 'high', codemode: true },
    feishu: { enabled: true, notify: { task_completed: true } } } };
  expect(validateSettingsPayload(payload, { operation: 'test' })).toEqual(payload);
  const effective = mergeEffectiveSettings({ project: { scopeRevision: 1, payload } });
  expect(effective.policies.piAgent?.value).toEqual(payload.policies.piAgent);
  expect(effective.policies.feishu?.value).toEqual(payload.policies.feishu);
});

it('accepts explicit production request limits and Nezha-style retry configuration', () => {
  const config = { schemaVersion: 1, providers: [{ id: 'p', models: ['m'] }],
    pi_agent: { transient_retry_attempts: 10, transient_retry_backoff_base_seconds: 1,
      fallback_on_connection_exhausted: true, fallback_on_server_exhausted: false, fallback_on_authentication: true },
    execution: { maxRequests: 300, maxInputBytes: 512000, maxOutputTokens: 16384,
      thinkingLevel: 'high', commandTimeoutMs: 600000, codemode: true } };
  expect(parseProductionPiConfig(config)).toEqual(config);
});

it.each([-1, 11, 1.5, '10'])('rejects invalid consecutive retry limit %s', value => {
  expect(() => parseProductionPiConfig({ schemaVersion: 1, providers: [{ id: 'p', models: ['m'] }],
    pi_agent: { transient_retry_attempts: value } })).toThrow();
});

it('resets consecutive retry allowance after a valid success and preserves cumulative failures', async () => {
  const delays: number[] = [];
  const retry = createRuntimeRequestRetryController({
    policy: { maxRetries: 2, maxTotalRetries: 2, baseBackoffMs: 1000, maxBackoffMs: 60000,
      budgetScope: 'consecutive', backoffMode: 'linear' },
    nowUtcMs: () => 1000, deadlineUtcMs: 1000000, runnerAlive: () => true,
    wait: async delay => { delays.push(delay); },
  });
  for (let round = 0; round < 2; round++) {
    let calls = 0;
    await retry.execute(async () => ++calls <= 2
      ? { value: 'failed', failure: { category: 'transient_connection' } }
      : { value: 'ok' });
  }
  expect(delays).toEqual([2000, 3000, 2000, 3000]);
  expect(retry.counters()).toMatchObject({ consecutiveFailures: 0, cumulativeFailures: 4, retryCount: 4 });
});
