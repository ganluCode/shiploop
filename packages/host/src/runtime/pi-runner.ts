/** Single-invocation Runner endpoint; SDK/resource construction is supplied by trusted assembly. */
import { createHash } from 'node:crypto';
import {
  RuntimeError, validateRuntimeExecutionResult, validateRuntimeStopEvidence,
} from 'shiploop-core';
import type { RuntimeAdapter, RuntimeExecutionRequest, RuntimeHandle } from 'shiploop-core';
import {
  PI_RUNNER_MAX_REQUEST_BYTES, encodePiRunnerMessage, normalizePiRunnerEvent, piRunnerMessage, runnerProtocolError,
  validatePiRunnerRequest,
} from './pi-runner-protocol.js';
import type { PiRunnerBody } from './pi-runner-protocol.js';

export interface PiWorkRunnerOptions {
  readonly adapter: RuntimeAdapter;
  /** Dedicated protocol sink, never console/stdout logging. Completion means the bounded write drained. */
  readonly write: (bytes: Uint8Array) => Promise<void>;
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
  const publish = async (body: PiRunnerBody) => {
    const bytes = encodePiRunnerMessage(piRunnerMessage(request, ++sequence, body));
    outputBytes += bytes.byteLength;
    if (outputBytes > request.limits.maxOutputBytes) throw runnerProtocolError('runner_output_overflow');
    await options.write(bytes);
  };
  try {
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
    await publish({ kind: 'result', body: terminal });
    const stop = await stopped;
    if (stop.failed) throw runnerProtocolError('runner_runtime_stop_failed');
    await publish({ kind: 'stopped', body: validateRuntimeStopEvidence(stop.value) });
  } catch (error) {
    // Do not print arbitrary SDK exceptions or raw input. Host retains typed protocol/process evidence.
    void handle.cancel().catch(() => {});
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('process', 'runner_channel_failed');
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
  await createPiWorkRunner(options).start(value);
}
