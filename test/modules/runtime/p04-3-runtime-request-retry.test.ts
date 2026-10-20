import { describe, expect, it } from 'vitest';
import { createRuntimeRequestRetryController } from '../../../packages/core/src/application/runtime-request-retry.ts';
import { wrapPiRequestStream } from '../../../packages/host/src/runtime/pi-request-retry.ts';
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';

const policy = { maxRetries: 2, maxTotalRetries: 2, baseBackoffMs: 0, maxBackoffMs: 0 };
const failed = (partial = false): AssistantMessage => ({
  role: 'assistant', content: partial ? [{ type: 'text', text: 'partial response' }] : [],
  api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
  usage: { input: 3, output: partial ? 1 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: partial ? 4 : 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'error', errorMessage: 'ECONNRESET', timestamp: 1,
});

function controller(overrides: Record<string, unknown> = {}) {
  return createRuntimeRequestRetryController({ policy, deadlineUtcMs: Date.now() + 60_000,
    nowUtcMs: Date.now, runnerAlive: () => true, wait: async () => {}, ...overrides });
}

describe('F-003 live request retry integration', () => {
  it('[case:F003-SAME-REQUEST] retries the request in one Runner with shared counters and resets only on complete success', async () => {
    const observations: unknown[] = [];
    const retry = controller({ observe: (event: unknown) => observations.push(event) });
    let requests = 0;
    const result = await retry.execute(async () => ++requests < 3
      ? { value: 'failed', failure: { category: 'transient_connection', sideEffect: 'none', durationMs: 4 } }
      : { value: 'complete' });
    expect(result).toBe('complete');
    expect(requests).toBe(3);
    expect(retry.counters()).toMatchObject({ runtimeStarts: 1, requestCount: 3, retryCount: 2,
      cumulativeFailures: 2, peakConsecutiveFailures: 2, consecutiveFailures: 0, failureElapsedMs: 8 });
    await retry.execute(async () => ({ value: 'failed', failure: { category: 'transient_server', sideEffect: 'none' } }));
    expect(retry.counters()).toMatchObject({ requestCount: 4, retryCount: 2, cumulativeFailures: 3 });
    expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'stop' })]));
  });

  it('[case:F003-CANCEL-BACKOFF] cancellation during backoff prevents the next request and retains the failure', async () => {
    const abort = new AbortController();
    let calls = 0;
    const retry = controller({ signal: abort.signal, wait: async () => { abort.abort(); },
      policy: { ...policy, baseBackoffMs: 10, maxBackoffMs: 10 } });
    const result = await retry.execute(async () => { calls++; return { value: 'partial', failure: { category: 'transient_server' } }; });
    expect(result).toBe('partial');
    expect(calls).toBe(1);
    expect(retry.counters().cumulativeFailures).toBe(1);
  });

  it('[case:F003-NO-UNSAFE-REPLAY] stops on partial output, dead Runner and absolute deadline', async () => {
    for (const overrides of [{ runnerAlive: () => false }, { deadlineUtcMs: Date.now() - 1 }, {}]) {
      let calls = 0;
      const retry = controller(overrides);
      try {
        await retry.execute(async () => { calls++; return { value: null,
          failure: { category: 'transient_connection', deltaReceived: true } }; });
      } catch { /* A request must not begin once its absolute deadline has expired. */ }
      expect(calls).toBeLessThanOrEqual(1);
      expect(retry.counters().retryCount).toBe(0);
    }
  });

  it('[case:F003-PI-STREAM] wraps the actual Pi stream contract without repeating tools or multiplying SDK retries', async () => {
    let calls = 0;
    const contexts: unknown[] = [];
    const usage: AssistantMessage[] = [];
    const context = normalizeContext({ messages: [] });
    const stream = wrapPiRequestStream((_model, input, options) => {
      calls++; contexts.push(input);
      expect(options?.maxRetries).toBe(0);
      const out = createAssistantMessageEventStream();
      const message = failed();
      if (calls === 1) out.push({ type: 'error', reason: 'error', error: message });
      else out.push({ type: 'done', reason: 'stop', message: { ...message, stopReason: 'stop', errorMessage: undefined } });
      return out;
    }, controller(), message => usage.push(message));
    const out = await stream(getModel('anthropic', 'claude-sonnet-4-5'), context, {});
    const events = [];
    for await (const event of out) events.push(event);
    expect(events.map(event => event.type)).toEqual(['done']);
    expect((await out.result()).stopReason).toBe('stop');
    expect(calls).toBe(2);
    expect(contexts).toEqual([context, context]);
    expect(contexts.every(value => value === context)).toBe(true);
    expect(usage).toHaveLength(1);
  });

  it('[case:F003-PI-PARTIAL] preserves a broken stream and usage as failure, including 200 followed by content', async () => {
    let calls = 0;
    const stream = wrapPiRequestStream(() => {
      calls++;
      const out = createAssistantMessageEventStream();
      const message = failed(true);
      out.push({ type: 'start', partial: message });
      out.push({ type: 'text_delta', contentIndex: 0, delta: 'partial response', partial: message });
      out.push({ type: 'error', reason: 'error', error: message });
      return out;
    }, controller(), () => {});
    const out = await stream(getModel('anthropic', 'claude-sonnet-4-5'), normalizeContext({ messages: [] }), {});
    const events = [];
    for await (const event of out) events.push(event);
    expect(calls).toBe(1);
    expect(events.map(event => event.type)).toEqual(['start', 'text_delta', 'error']);
    expect((await out.result()).usage.output).toBe(1);
  });

  it('[case:F003-NESTED-TRANSPORT] classifies the transport cause of a failed fetch before deciding whether to retry', async () => {
    let calls = 0;
    const stream = wrapPiRequestStream(() => {
      if (++calls === 1) throw new Error('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
      const output = createAssistantMessageEventStream();
      output.push({ type: 'done', reason: 'stop', message: { ...failed(), stopReason: 'stop', errorMessage: undefined } });
      return output;
    }, controller(), () => {});
    const output = await stream(getModel('anthropic', 'claude-sonnet-4-5'), normalizeContext({ messages: [] }), {});
    for await (const _event of output) { /* Drain the SDK stream. */ }
    expect(calls).toBe(2);
    expect((await output.result()).stopReason).toBe('stop');
  });

  it('[case:F003-INVALID-POLICY] rejects missing or unbounded retry limits at the trusted configuration boundary', () => {
    for (const limits of [{ ...policy, maxRetries: -1 }, { ...policy, maxTotalRetries: undefined },
      { ...policy, maxBackoffMs: Infinity }]) {
      expect(() => controller({ policy: limits })).toThrow('invalid_request_retry_policy');
    }
  });

  it('[case:F003-OVERLAP] rejects overlapping model requests instead of resetting the shared budget', async () => {
    const retry = controller();
    let complete!: (value: { value: string }) => void;
    const first = retry.execute(() => new Promise<{ value: string }>(resolve => { complete = resolve; }));
    await expect(retry.execute(async () => ({ value: 'overlap' }))).rejects.toMatchObject({ reason: 'overlapping_runtime_requests' });
    complete({ value: 'done' });
    expect(await first).toBe('done');
    expect(retry.counters().requestCount).toBe(1);
  });

  it('[case:F003-CONTROL-TERMINAL] retains deadline/cancel classification without starting a transport request or inventing usage', async () => {
    for (const cancelled of [false, true]) {
      const abort = new AbortController();
      if (cancelled) abort.abort();
      const classifications: unknown[] = [];
      let calls = 0;
      const stream = wrapPiRequestStream(() => { calls++; throw new Error('must not start'); },
        controller({ signal: abort.signal, ...(cancelled ? {} : { deadlineUtcMs: Date.now() - 1 }) }),
        () => {}, failure => classifications.push(failure));
      const output = await stream(getModel('anthropic', 'claude-sonnet-4-5'), normalizeContext({ messages: [] }), {});
      const events = [];
      for await (const event of output) events.push(event);
      expect(events.map(event => event.type)).toEqual(['error']);
      const result = await output.result();
      expect(result.stopReason).toBe(cancelled ? 'aborted' : 'error');
      expect(Reflect.get(result, Symbol.for('shiploop.pi.usageUnavailable'))).toBe(true);
      expect(classifications).toEqual([expect.objectContaining({ category: cancelled ? 'cancelled' : 'timeout' })]);
      expect(calls).toBe(0);
    }
  });
});
