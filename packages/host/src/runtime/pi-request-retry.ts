/** Request-only Pi transport bridge. Never replays prompt(), tools or Runner startup. */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import { classifyRuntimeFailure, RuntimeError, type RuntimeFailureClassification, type RuntimeFailureErrorInput, type RuntimeRequestRetryController } from 'shiploop-core';

type TerminalEvent = Extract<AssistantMessageEvent, { type: 'done' | 'error' }>;

function transportFacts(error: unknown): { chain: RuntimeFailureErrorInput[]; status: number | null } {
  const chain: RuntimeFailureErrorInput[] = [];
  const seen = new Set<unknown>();
  let current = error, status: number | null = null;
  while (current !== null && typeof current === 'object' && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    const raw = current as Record<string, unknown>;
    const observedStatus = raw.status ?? raw.statusCode;
    if (status === null && typeof observedStatus === 'number' && Number.isInteger(observedStatus)) status = observedStatus;
    chain.push({ source: 'transport',
      name: typeof raw.name === 'string' ? raw.name : undefined,
      code: typeof raw.code === 'string' ? raw.code : undefined,
      message: typeof raw.message === 'string' ? raw.message : undefined });
    current = raw.cause;
  }
  return { chain, status };
}

export function wrapPiRequestStream(
  original: StreamFn,
  retry: RuntimeRequestRetryController,
  onRetriedFailure: (message: AssistantMessage) => void,
  onFailure?: (failure: RuntimeFailureClassification | null) => void,
): StreamFn {
  return (model, context, options) => {
    // Pi 1.0.4 explicitly disables native SDK retries and honors maxRetries for
    // these APIs. Bedrock ignores maxRetries; other APIs need separate evidence.
    const controlsProviderRetries = ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api);
    const output = createAssistantMessageEventStream();
    const empty = (): AssistantMessage => {
      // SDK requires numeric usage on its internal terminal. Mark this synthetic
      // placeholder so the Core bridge preserves unavailable usage as null.
      const message: AssistantMessage = { role: 'assistant', content: [], api: model.api,
        provider: model.provider, model: model.id, stopReason: 'error', errorMessage: 'runtime_request_failed', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      Object.defineProperty(message, Symbol.for('shiploop.pi.usageUnavailable'), { value: true, enumerable: true });
      return message;
    };
    let partial: AssistantMessage | undefined;
    let previousError: AssistantMessage | undefined;
    const run = async () => {
      const terminal = await retry.execute<TerminalEvent>(async () => {
        if (previousError !== undefined) onRetriedFailure(previousError);
        previousError = undefined;
        partial = undefined;
        let deltaReceived = false;
        let ended: TerminalEvent | undefined;
        let pendingStart: Extract<AssistantMessageEvent, { type: 'start' }> | undefined;
        let thrown: unknown;
        const startedAt = Date.now();
        try {
          // Disable Pi's provider retry loop where supported. AgentSession retry
          // is disabled by the adapter; unverified APIs get no outer replay.
          const source = await original(model, context, { ...options, maxRetries: 0 });
          for await (const event of source) {
            if (event.type === 'done' || event.type === 'error') { ended = event; break; }
            partial = event.partial;
            // A start alone must not create an assistant message/usage entry for
            // a suppressed retry. Flush it only when observable content follows.
            if (event.type === 'start') { pendingStart = event; continue; }
            deltaReceived = true;
            if (pendingStart !== undefined) { output.push(pendingStart); pendingStart = undefined; }
            output.push(event);
          }
          if (ended === undefined) thrown = { code: 'protocol', message: 'missing_request_terminal' };
        } catch (error) { thrown = error; }
        if (ended?.type === 'done' && ['stop', 'length', 'toolUse'].includes(ended.reason)
          && ended.message.stopReason === ended.reason) {
          if (pendingStart !== undefined) output.push(pendingStart);
          onFailure?.(null);
          return { value: ended };
        }
        const message: AssistantMessage = ended?.type === 'error'
          ? { ...ended.error, stopReason: ended.error.stopReason === 'aborted' ? 'aborted' : 'error' }
          : { ...(ended?.type === 'done' ? ended.message : partial ?? empty()),
            stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: 'runtime_request_failed' };
        const sdkTerminal = ended?.type === 'error' ? ended.error.stopReason
          : ended?.type === 'done' ? ended.message.stopReason : message.stopReason;
        const raw = thrown !== null && typeof thrown === 'object' ? thrown as Record<string, unknown> : {};
        const sdkMessage = ended?.type === 'error' ? ended.error.errorMessage : typeof thrown === 'string' ? thrown : raw.message;
        const statusText = typeof sdkMessage === 'string' ? /^(?:HTTP\s+)?([45]\d{2})\b/.exec(sdkMessage) : null;
        const facts = transportFacts(thrown);
        const status = facts.status ?? (statusText ? Number(statusText[1]) : null);
        const classification = classifyRuntimeFailure({ sdkTerminal: sdkTerminal === 'aborted' ? 'cancelled'
          : sdkTerminal === 'error' ? 'failed' : ['stop', 'length', 'toolUse'].includes(sdkTerminal) ? 'completed' : sdkTerminal,
          ...(ended?.type === 'done' ? { protocolIssue: 'invalid_request_terminal' } : {}),
          terminalObserved: true, cancelRequested: options?.signal?.aborted,
          http: status === null ? undefined : { status },
          errorChain: [{ source: 'sdk', message: typeof sdkMessage === 'string' ? sdkMessage : 'unknown_request_failure' }, ...facts.chain],
          stream: partial === undefined ? undefined : 'interrupted' });
        onFailure?.(classification);
        previousError = message;
        return { value: { type: 'error' as const, reason: message.stopReason === 'aborted' ? 'aborted' as const : 'error' as const, error: message },
          failure: { category: classification.category ?? 'unknown',
            sideEffect: controlsProviderRetries && (classification.category === 'transient_connection' || classification.category === 'transient_server')
              ? 'none' as const : 'uncertain' as const,
            responseHeadersReceived: partial !== undefined,
            deltaReceived, partialResult: message.content.length > 0, durationMs: Date.now() - startedAt } };
      });
      output.push(terminal);
    };
    void run().catch((error: unknown) => {
      // A controller/observer failure must end as a failed request, never completion.
      const failure = classifyRuntimeFailure({ terminal: 'failed', terminalObserved: true,
        cancelRequested: options?.signal?.aborted,
        ...(error instanceof RuntimeError ? { existingRuntimeError: { kind: error.kind, reason: error.reason } }
          : { protocolIssue: 'runtime_request_control_failed' }) });
      onFailure?.(failure);
      const message = { ...(partial ?? empty()), stopReason: failure.category === 'cancelled' ? 'aborted' as const : 'error' as const,
        errorMessage: failure.reason };
      output.push({ type: 'error', reason: message.stopReason, error: message });
    });
    return output;
  };
}
