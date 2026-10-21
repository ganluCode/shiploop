/** Single-invocation Runner endpoint; SDK/resource construction is supplied by trusted assembly. */
import { createHash } from 'node:crypto';
import {
  RuntimeError, validateRuntimeCancelReceipt, validateRuntimeExecutionResult, validateRuntimeStopEvidence,
} from 'shiploop-core';
import type { RuntimeAdapter, RuntimeCancelReceipt, RuntimeExecutionRequest, RuntimeHandle } from 'shiploop-core';
import { observePiWithin, PI_ABORT_WAIT_MS, PI_STOP_WAIT_MS } from './pi-lifecycle.js';
import {
  PI_RUNNER_MAX_REQUEST_BYTES, encodePiRunnerMessage, normalizePiRunnerEvent, piRunnerMessage, runnerProtocolError,
  validatePiRunnerRequest,
} from './pi-runner-protocol.js';
import type { PiRunnerBody } from './pi-runner-protocol.js';

export interface PiWorkRunnerOptions {
  readonly adapter: RuntimeAdapter;
  /** Dedicated protocol sink, never console/stdout logging. Completion means the bounded write drained. */
  readonly write: (bytes: Uint8Array) => Promise<void>;
  /** Trusted control input; OS signals are attached only by the standalone entry. */
  readonly signal?: AbortSignal;
}

export function createPiWorkRunner(options: PiWorkRunnerOptions): {
  start(value: unknown): Promise<void>;
} {
  let admitted: { digest: string; completion: Promise<void> } | undefined;
  return {
    async start(value) {
      const request = validatePiRunnerRequest(value);
      const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (admitted) {
        if (admitted.digest !== digest) throw runnerProtocolError('runner_request_conflict');
        return admitted.completion;
      }
      const completion = Promise.resolve().then(() => execute(request, options));
      admitted = { digest, completion };
      return completion;
    },
  };
}

async function execute(request: RuntimeExecutionRequest, options: PiWorkRunnerOptions): Promise<void> {
  let handle: RuntimeHandle;
  try { handle = await options.adapter.start(request); }
  catch { throw new RuntimeError('process', 'runner_runtime_start_failed'); }
  // Observe both promises immediately, even while the event sink is awaiting backpressure.
  const result = handle.result.then(value => ({ value, failed: false as const }), () => ({ failed: true as const }));
  const stopped = handle.stopped.then(value => ({ value, failed: false as const }), () => ({ failed: true as const }));
  let sequence = 0, outputBytes = 0, eventSequence: number | null = null, events = 0;
  let writes = Promise.resolve();
  const publish = (body: PiRunnerBody): Promise<void> => {
    // Serialize control receipts with data frames, including under backpressure.
    const write = writes.then(async () => {
      const bytes = encodePiRunnerMessage(piRunnerMessage(request, ++sequence, body));
      outputBytes += bytes.byteLength;
      if (outputBytes > request.limits.maxOutputBytes) throw runnerProtocolError('runner_output_overflow');
      await options.write(bytes);
    });
    writes = write;
    return write;
  };
  let cancelPromise: Promise<void> | undefined;
  const cancel = () => {
    cancelPromise ??= (async () => {
      const observed = await observePiWithin(Promise.resolve().then(() => handle.cancel()), PI_ABORT_WAIT_MS);
      const receipt: RuntimeCancelReceipt = observed.status === 'fulfilled' ? validateRuntimeCancelReceipt(observed.value)
        : { accepted: false, reason: observed.status === 'timeout' ? 'runner_sdk_cancel_timeout' : 'runner_sdk_cancel_failed' };
      await publish({ kind: 'cancel_receipt', body: receipt });
    })();
    // A disconnected sink is handled by the main execute path; never an unhandled rejection.
    void cancelPromise.catch(() => {});
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, request.limits.timeoutMs);
  try {
    if (handle.recoveryRecording !== undefined) {
      const handoff = await observePiWithin(handle.recoveryRecording, PI_STOP_WAIT_MS);
      if (handoff.status === 'fulfilled' && handoff.value !== null) await publish({ kind: 'recovery', body: handoff.value });
      else if (handoff.status !== 'fulfilled') await publish({ kind: 'diagnostic', body: { code: 'runner_recovery_handoff_unknown' } });
    }
    for await (const raw of handle.events) {
      const event = normalizePiRunnerEvent(raw);
      if (event.sequence !== (eventSequence ?? 0) + 1) throw runnerProtocolError('runner_event_sequence');
      if (++events > request.limits.maxEvents) throw runnerProtocolError('runner_event_overflow');
      eventSequence = event.sequence;
      await publish({ kind: 'event', body: event });
    }
    const observed = await result;
    if (observed.failed) throw runnerProtocolError('runner_runtime_result_failed');
    const terminal = validateRuntimeExecutionResult(observed.value);
    if (terminal.lastEventSequence !== eventSequence) throw runnerProtocolError('runner_result_watermark');
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await cancelPromise;
    await publish({ kind: 'result', body: terminal });
    const stop = await observePiWithin(stopped, PI_STOP_WAIT_MS);
    const evidence = stop.status === 'fulfilled' && !stop.value.failed ? validateRuntimeStopEvidence(stop.value.value)
      : { schemaVersion: 1 as const, confirmed: false, checkedAtUtc: new Date().toISOString(), detail: 'runner_runtime_stop_unknown' };
    await publish({ kind: 'stopped', body: evidence });
  } catch (error) {
    // Do not print arbitrary SDK exceptions or raw input. Host retains typed protocol/process evidence.
    cancel();
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('process', 'runner_channel_failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** stdin contains exactly one bounded JSON request. A second object/trailing payload is invalid. */
export async function runPiWorkRunner(options: PiWorkRunnerOptions & {
  readonly input: AsyncIterable<Uint8Array>;
}): Promise<void> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of options.input) {
    size += chunk.byteLength;
    if (size > PI_RUNNER_MAX_REQUEST_BYTES) throw runnerProtocolError('runner_request_overflow');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw runnerProtocolError('runner_invalid_request_json'); }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try { await createPiWorkRunner({ ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }).start(value); }
  finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}
