import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeInferenceAdapter, RuntimeInferenceAudit, RuntimeInferencePreflightDependencies, RuntimeInferenceProbeRequest } from '../../../packages/core/src/ports/runtime-inference-preflight.ts';
import { createRuntimeInferencePreflight, resolveRuntimeInferencePreflightPolicy } from '../../../packages/core/src/application/runtime-inference-preflight.ts';

const strategy = { runtime: 'pi', provider: 'provider', model: 'model', credentialRef: 'credential:selected' };
const selection = { strategy, authenticationRef: 'auth:selected', environmentDigest: 'a'.repeat(64), resourceDigest: 'b'.repeat(64) };
const policy = { enabled: true, timeoutMs: 1000, maxRequests: 2, backoffMs: 10, successTtlMs: 100 };
const usage = { inputTokens: 2, outputTokens: 1, costUsdMicros: null };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: Partial<Omit<RuntimeInferencePreflightDependencies, 'adapter'>> & {
  adapter?: { isolation: string; probe: (request: RuntimeInferenceProbeRequest) => Promise<unknown> };
} = {}) {
  const audit = vi.fn(async (_record: RuntimeInferenceAudit) => {});
  const probe = vi.fn(async () => ({ terminal: 'completed', response: 'ok', usage }));
  const authorize = vi.fn(async () => true);
  const service = createRuntimeInferencePreflight({ policy, audit, authorize, ...options,
    adapter: (options.adapter ?? { isolation: 'inference_only', probe }) as RuntimeInferenceAdapter });
  return { service, audit, probe, authorize };
}

describe('F-006 isolated inference admission', () => {
  it('[case:default-off] defaults off without auth, requests or audit writes', async () => {
    expect(resolveRuntimeInferencePreflightPolicy().enabled).toBe(false);
    const f = fixture({ policy: undefined });
    expect(await f.service.check(selection)).toMatchObject({ outcome: 'disabled', dispatchAllowed: true });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });

  it('[case:complete-terminal] requires nonempty output and a valid normal terminal', async () => {
    for (const result of [
      { terminal: 'completed', response: ' ', usage },
      { terminal: 'failed', response: 'delta', usage },
      { httpStatus: 200, exitCode: 0, authentication: 'ready', response: 'delta', usage },
    ]) {
      const f = fixture({ adapter: { isolation: 'inference_only', probe: async () => result } });
      expect(await f.service.check(selection)).toMatchObject({ outcome: 'failed', dispatchAllowed: false });
      expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'finished', outcome: 'failed', usage }));
    }
    const f = fixture();
    expect(await f.service.check(selection)).toMatchObject({ outcome: 'passed', dispatchAllowed: true });
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'finished', outcome: 'passed', usage }));
  });
});

afterEach(() => vi.useRealTimers());

describe('F-006 independent limits and audit', () => {
  it('[case:policy-validation] accepts only explicit enablement and finite bounded budgets', () => {
    for (const value of [null, true, { enabled: 'true' }, { timeoutMs: 0 }, { maxRequests: 4 },
      { maxRequests: Infinity }, { successTtlMs: -1 }, { backoffMs: 5001 }, { bogus: true }, { toString: 'invalid' }]) {
      expect(() => resolveRuntimeInferencePreflightPolicy(value)).toThrow();
    }
    expect(resolveRuntimeInferencePreflightPolicy({ timeoutMs: 15 }).enabled).toBe(false);
    expect(resolveRuntimeInferencePreflightPolicy({ enabled: undefined }).enabled).toBe(false);
  });

  it('[case:isolation-auth] fails closed before transport for isolation or authorization gaps', async () => {
    const probe = vi.fn();
    const f = fixture({ adapter: { isolation: 'trusted_project', probe } });
    expect(await f.service.check(selection)).toMatchObject({ dispatchAllowed: false, reason: 'isolation_unavailable' });
    expect(probe).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    const denied = fixture({ authorize: async () => false });
    expect(await denied.service.check(selection)).toMatchObject({ dispatchAllowed: false, reason: 'authorization_denied' });
    expect(denied.probe).not.toHaveBeenCalled();
    expect(denied.audit).toHaveBeenCalledWith(expect.objectContaining({ category: 'authentication' }));
  });

  it('[case:ttl] expires successful entries against monotonic time despite wall-clock rollback', async () => {
    let clock = 0, wall = 10000;
    const f = fixture({ monotonicNow: () => clock, nowUtcMs: () => wall });
    expect((await f.service.check(selection)).outcome).toBe('passed');
    clock = 99; wall = -10000;
    expect((await f.service.check(selection)).outcome).toBe('cached');
    expect(f.probe).toHaveBeenCalledTimes(1);
    clock = 100;
    expect((await f.service.check(selection)).outcome).toBe('passed');
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenCalledTimes(5);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cached', usage: {
      inputTokens: null, outputTokens: null, costUsdMicros: null,
    } }));
  });

  it('[case:cache-key] keys every selected strategy, auth source and environment/resource version', async () => {
    const f = fixture();
    const selections = [selection,
      ...['runtime', 'provider', 'model', 'credentialRef', 'endpointRef'].map(field => ({
        ...selection, strategy: { ...strategy, [field]: 'another' },
      })),
      { ...selection, authenticationRef: 'auth:another' },
      { ...selection, environmentDigest: 'c'.repeat(64) },
      { ...selection, resourceDigest: 'd'.repeat(64) }];
    for (const value of selections) expect((await f.service.check(value)).outcome).toBe('passed');
    expect(f.probe).toHaveBeenCalledTimes(selections.length);
    expect(new Set(f.audit.mock.calls.map(([record]) => record.cacheKey)).size).toBe(selections.length);
  });

  it('[case:no-failure-cache] never caches failure and rechecks authorization on cache hits', async () => {
    const failed = fixture({ adapter: { isolation: 'inference_only', probe: async () => ({ terminal: 'failed', response: '', usage }) } });
    await failed.service.check(selection); await failed.service.check(selection);
    expect(failed.audit.mock.calls.filter(([record]) => record.phase === 'started')).toHaveLength(2);
    const f = fixture();
    await f.service.check(selection);
    f.authorize.mockResolvedValue(false);
    expect(await f.service.check(selection)).toMatchObject({ outcome: 'failed', dispatchAllowed: false });
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it('[case:bounded-retry] limits independent requests and records each request usage once', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ terminal: 'failed', category: 'transient_server', response: '', usage })
      .mockResolvedValue({ terminal: 'completed', response: 'ok', usage });
    const f = fixture({ adapter: { isolation: 'inference_only', probe } });
    expect((await f.service.check(selection)).outcome).toBe('passed');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0][0]).toMatchObject({ ...selection, maxOutputTokens: 32, maxRetries: 0, prompt: 'Reply with OK.' });
    expect(f.audit.mock.calls.filter(([r]) => r.phase === 'finished').map(([r]) => r.usage)).toEqual([usage, usage]);
    probe.mockReset().mockResolvedValue({ terminal: 'failed', category: 'transient_server', response: '', usage });
    const exhausted = fixture({ adapter: { isolation: 'inference_only', probe } });
    expect((await exhausted.service.check(selection)).outcome).toBe('failed');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('[case:cancel-backoff] cancels backoff before another request without duplicate usage', async () => {
    const cancel = new AbortController(), started = deferred();
    const records: RuntimeInferenceAudit[] = [];
    const probe = vi.fn(async () => ({ terminal: 'failed', category: 'transient_connection', response: '', usage }));
    const f = fixture({ policy: { ...policy, backoffMs: 500 }, adapter: { isolation: 'inference_only', probe },
      audit: async record => { records.push(record); if (record.outcome === 'failed') started.resolve(); } });
    const result = f.service.check(selection, cancel.signal);
    await started.promise; cancel.abort();
    expect(await result).toMatchObject({ dispatchAllowed: false, reason: 'cancelled' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(records.filter(r => r.phase === 'finished' && r.usage.inputTokens !== null)).toHaveLength(1);
  });

  it('[case:timeout-partial] aborts hanging transport and audits observed partial usage', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    let transportSignal: AbortSignal | undefined;
    const f = fixture({ policy: { ...policy, timeoutMs: 20 }, adapter: { isolation: 'inference_only',
      probe: request => { transportSignal = request.signal; request.observeUsage(usage); entered.resolve(); return new Promise(() => {}); } } });
    const result = f.service.check(selection);
    await entered.promise; await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ reason: 'timeout', dispatchAllowed: false });
    expect(transportSignal!.aborted).toBe(true);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'timeout', usage }));
  });

  it('[case:cancel-auth] cancels authorization before any inference request', async () => {
    const entered = deferred(), cancel = new AbortController();
    const f = fixture({ authorize: async () => { entered.resolve(); return new Promise(() => {}); } });
    const pending = f.service.check(selection, cancel.signal);
    await entered.promise; cancel.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled', dispatchAllowed: false });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it('[case:zero-ttl] disables successful reuse when TTL is zero', async () => {
    const f = fixture({ policy: { ...policy, successTtlMs: 0 } });
    expect((await f.service.check(selection)).outcome).toBe('passed');
    expect((await f.service.check(selection)).outcome).toBe('passed');
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  it('[case:late-success] cannot turn a timed-out response into a cached success', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    let finish!: (value: unknown) => void;
    const probe = vi.fn().mockImplementationOnce(() => {
      entered.resolve(); return new Promise(resolve => { finish = resolve; });
    }).mockResolvedValue({ terminal: 'completed', response: 'ok', usage });
    const f = fixture({ policy: { ...policy, timeoutMs: 20 }, adapter: { isolation: 'inference_only', probe } });
    const pending = f.service.check(selection);
    await entered.promise; await vi.advanceTimersByTimeAsync(20);
    expect((await pending).dispatchAllowed).toBe(false);
    finish({ terminal: 'completed', response: 'late', usage });
    await Promise.resolve();
    expect((await f.service.check(selection)).outcome).toBe('passed');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('[case:deadline-before-admission] rechecks elapsed time after audit even before a timer callback runs', async () => {
    let clock = 0;
    const f = fixture({ policy: { ...policy, timeoutMs: 20 }, monotonicNow: () => clock,
      audit: async record => { if (record.outcome === 'passed') clock += 20; } });
    expect(await f.service.check(selection)).toMatchObject({ dispatchAllowed: false, reason: 'timeout' });
    expect(await f.service.check(selection)).toMatchObject({ dispatchAllowed: false, reason: 'timeout' });
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  it('[case:partial-usage-gap] retains known partial usage when a terminal report is unavailable', async () => {
    const f = fixture({ adapter: { isolation: 'inference_only', probe: async request => {
      request.observeUsage(usage);
      return { terminal: 'failed', response: '', usage: { inputTokens: null, outputTokens: null, costUsdMicros: null } };
    } } });
    await f.service.check(selection);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'finished', usage }));
  });

  it('[case:durable-fail-closed] refuses admission/cache when durable audit fails', async () => {
    const f = fixture({ audit: async () => { throw new Error('audit unavailable'); } });
    await expect(f.service.check(selection)).rejects.toThrow('audit unavailable');
    expect(f.probe).not.toHaveBeenCalled();
  });

  it('[case:redaction] persists references and fixed reasons, never output or raw thrown errors', async () => {
    const secret = 'sk-super-secret-key';
    const f = fixture({ adapter: { isolation: 'inference_only', probe: async () => { throw new Error(secret); } } });
    await f.service.check(selection);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(secret);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'probe_failed', accounting: 'inference_preflight' }));
    const success = fixture({ adapter: { isolation: 'inference_only', probe: async () => ({ terminal: 'completed', response: secret, usage }) } });
    await success.service.check(selection);
    expect(JSON.stringify(success.audit.mock.calls)).not.toContain(secret);
    await expect(f.service.check({ ...selection, authenticationRef: secret })).rejects.toThrow();
    await expect(f.service.check({ ...selection, strategy: { ...strategy, credentialRef: secret } })).rejects.toThrow();
  });
});
