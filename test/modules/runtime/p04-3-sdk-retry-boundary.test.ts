import { describe, expect, it } from 'vitest';
import { normalizeContext } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { createRuntimeRequestRetryController } from '../../../packages/core/src/application/runtime-request-retry.ts';
import { wrapPiRequestStream } from '../../../packages/host/src/runtime/pi-request-retry.ts';

const model = getModel('anthropic', 'claude-sonnet-4-5');
const context = normalizeContext({ messages: [{ role: 'user', content: 'test', timestamp: 1 }] });

describe('F-007 installed provider SDK retry boundary', () => {
  it('[case:unverified-provider-boundary] never multiplies an unverified provider SDK retry loop', async () => {
    let invocations = 0, lowerRequests = 0;
    const controller = createRuntimeRequestRetryController({ policy: { maxRetries: 2, maxTotalRetries: 2,
      baseBackoffMs: 0, maxBackoffMs: 0 }, deadlineUtcMs: Date.now() + 60_000,
      nowUtcMs: Date.now, runnerAlive: () => true, wait: async () => {} });
    const selected = wrapPiRequestStream(async () => {
      invocations++;
      // Simulate an SDK that ignores maxRetries and performs three requests.
      for (let request = 0; request < 3; request++) lowerRequests++;
      throw Object.assign(new Error('server_error'), { status: 503 });
    }, controller, () => {});
    const result = await selected({ ...model, api: 'bedrock-converse-stream' }, context);
    for await (const _event of result) { /* Drain the terminal. */ }
    expect((await result.result()).stopReason).toBe('error');
    expect(invocations).toBe(1);
    expect(lowerRequests).toBe(3);
    expect(controller.counters()).toMatchObject({ requestCount: 1, retryCount: 0, runtimeStarts: 1 });
  });

  it.each([false, true])('[case:sdk-boundary-%s] counts actual fetches through Pi 1.0.4 and Anthropic SDK', async wrapped => {
    let fetches = 0;
    const classifications: unknown[] = [];
    const fetchStub: typeof fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'server_error' } }),
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } });
    };
    const controller = createRuntimeRequestRetryController({ policy: { maxRetries: 2, maxTotalRetries: 2,
      baseBackoffMs: 0, maxBackoffMs: 0 }, deadlineUtcMs: Date.now() + 60_000,
      nowUtcMs: Date.now, runnerAlive: () => true, wait: async () => {} });
    const selected = wrapped ? wrapPiRequestStream((selectedModel, input, options) => {
      if (selectedModel.api !== 'anthropic-messages') throw new Error('unexpected_test_api');
      return stream(model, input, options);
    }, controller, () => {}, value => classifications.push(value)) : stream;
    const result = await selected(model, context, { apiKey: 'isolated-test-key', fetch: fetchStub, maxRetries: 2 });
    for await (const _event of result) { /* Drain the installed provider stream. */ }
    expect((await result.result()).stopReason).toBe('error');
    expect(fetches).toBe(3);
    if (wrapped) {
      expect(controller.counters()).toMatchObject({ requestCount: 3, retryCount: 2, runtimeStarts: 1 });
      expect(classifications).toEqual(Array(3).fill(expect.objectContaining({ category: 'transient_server' })));
    }
  });
});
