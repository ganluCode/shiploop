/** Minimal Pi transport only: never creates AgentSession, cwd, resource loaders or tools. */
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from '@earendil-works/pi-ai';
import { classifyRuntimeFailure, runtimeInferenceSelectionKey, validateRuntimeInferenceSelection } from 'shiploop-core';
import type { RuntimeInferenceAdapter, RuntimeInferenceSelection, RuntimeInferenceUsage } from 'shiploop-core';

/**
 * Registered by trusted Host authentication assembly. resolve uses ONLY the selected managed
 * credential/endpoint and necessary auth plugin; it must honor signal and disable ambient
 * discovery. Sources/plugins unable to enforce this boundary must not register as isolated.
 * Secrets remain inside the returned stream closure (no prompt, argv or audit exposure).
 */
export interface PiInferenceSource {
  readonly selection: RuntimeInferenceSelection;
  readonly isolation: 'inference_only';
  resolve(signal: AbortSignal): Promise<{
    readonly model: Model<Api>;
    readonly stream: StreamFunction<Api, SimpleStreamOptions>;
  }>;
}
const unavailable: RuntimeInferenceUsage = { inputTokens: null, outputTokens: null, costUsdMicros: null };
function observedUsage(message: AssistantMessage | undefined): RuntimeInferenceUsage {
  const raw = message?.usage;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const cost = raw?.cost?.total;
  return { inputTokens: count(raw?.input), outputTokens: count(raw?.output),
    costUsdMicros: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? count(Math.round(cost * 1_000_000)) : null };
}
export function createPiInferencePreflightAdapter(sources: readonly PiInferenceSource[]): RuntimeInferenceAdapter {
  const registered = new Map<string, PiInferenceSource>();
  for (const source of sources) {
    const selection = validateRuntimeInferenceSelection(source.selection);
    if (selection.strategy.runtime !== 'pi' || source.isolation !== 'inference_only') throw new TypeError('pi_probe_isolation_unavailable');
    const key = runtimeInferenceSelectionKey(selection);
    if (registered.has(key)) throw new TypeError('duplicate_pi_probe_source');
    registered.set(key, { selection, isolation: 'inference_only', resolve: source.resolve.bind(source) });
  }
  return Object.freeze({
    isolation: 'inference_only',
    async probe(request) {
      request.signal.throwIfAborted();
      const source = registered.get(runtimeInferenceSelectionKey(request));
      if (!source) return { terminal: 'failed', response: '', category: 'configuration', usage: unavailable };
      let partial: AssistantMessage | undefined;
      try {
        const resolved = await source.resolve(request.signal);
        request.signal.throwIfAborted();
        if (resolved.model.provider !== request.strategy.provider || resolved.model.id !== request.strategy.model) {
          return { terminal: 'failed', response: '', category: 'configuration', usage: unavailable };
        }
        const { normalizeContext } = await import('@earendil-works/pi-ai');
        const context = normalizeContext({ messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }], tools: [] });
        const stream = resolved.stream(resolved.model, context, { signal: request.signal, maxRetries: 0, maxTokens: 32 });
        let count = 0, started = false;
        for await (const event of stream) {
          request.signal.throwIfAborted();
          if ((event.type === 'start' && started) || (event.type !== 'start' && event.type !== 'error' && !started)) {
            return { terminal: 'failed', response: '', category: 'protocol', usage: observedUsage(partial) };
          }
          if (event.type === 'start') started = true;
          partial = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          request.observeUsage(observedUsage(partial));
          if (++count > 256 || partial.content.some(block => block.type === 'toolCall')
            || Buffer.byteLength(JSON.stringify(partial.content)) > 4096) {
            return { terminal: 'failed', response: '', category: 'protocol', usage: observedUsage(partial) };
          }
          if (event.type === 'done') {
            const response = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
            const normal = event.reason === 'stop' && event.message.stopReason === 'stop'
              && event.message.provider === resolved.model.provider && event.message.model === resolved.model.id
              && event.message.api === resolved.model.api;
            return { terminal: normal ? 'completed' : 'failed', response,
              ...(normal ? {} : { category: 'protocol' as const }), usage: observedUsage(partial) };
          }
          if (event.type === 'error') {
            const message = event.error.errorMessage;
            const status = typeof message === 'string' ? /^(?:HTTP\s+)?([45]\d{2})\b/.exec(message) : null;
            const failure = classifyRuntimeFailure({ terminal: 'failed', terminalObserved: true,
              cancelRequested: request.signal.aborted,
              ...(status ? { http: { status: Number(status[1]) } } : {}),
              errorChain: [{ source: 'sdk', message }] });
            return { terminal: 'failed', response: '', category: failure.category ?? 'unknown', usage: observedUsage(partial) };
          }
        }
        return { terminal: 'failed', response: '', category: 'protocol', usage: observedUsage(partial) };
      } catch (error) {
        const raw = error as { code?: string; status?: number } | null;
        const failure = classifyRuntimeFailure({ terminal: 'failed', terminalObserved: true,
          cancelRequested: request.signal.aborted,
          http: typeof raw?.status === 'number' ? { status: raw.status } : undefined,
          errorChain: [{ source: 'transport', code: raw?.code }] });
        return { terminal: 'failed', response: '', category: failure.category ?? 'unknown', usage: observedUsage(partial) };
      }
    },
  } satisfies RuntimeInferenceAdapter);
}
