/** Private Host/Runner wire format. No SDK, storage, prompt text or credentials. */
import {
  RuntimeError, validateRuntimeEvent, validateRuntimeExecutionRequest,
  validateRuntimeExecutionResult, validateRuntimeStopEvidence, validateRuntimeCancelReceipt,
} from 'shiploop-core';
import type {
  RuntimeEvent, RuntimeExecutionRequest, RuntimeExecutionResult, RuntimeStopEvidence, RuntimeCancelReceipt,
} from 'shiploop-core';

export const PI_RUNNER_PROTOCOL_VERSION = 1;
export const PI_RUNNER_MAX_REQUEST_BYTES = 48 * 1024;
export const PI_RUNNER_MAX_MESSAGE_BYTES = 16 * 1024;
export const PI_RUNNER_BUFFER_BYTES = 64 * 1024;
export const PI_RUNNER_BUFFER_EVENTS = 64;

export function runnerProtocolError(reason: string): RuntimeError {
  return new RuntimeError('protocol', reason);
}

export function validatePiRunnerRequest(value: unknown): RuntimeExecutionRequest {
  const request = validateRuntimeExecutionRequest(value);
  if (Buffer.byteLength(JSON.stringify(request)) > PI_RUNNER_MAX_REQUEST_BYTES) {
    throw runnerProtocolError('runner_request_overflow');
  }
  return request;
}

export type PiRunnerBody =
  | { readonly kind: 'event'; readonly body: RuntimeEvent }
  | { readonly kind: 'result'; readonly body: RuntimeExecutionResult }
  | { readonly kind: 'stopped'; readonly body: RuntimeStopEvidence }
  | { readonly kind: 'cancel_receipt'; readonly body: RuntimeCancelReceipt }
  | { readonly kind: 'diagnostic'; readonly body: { readonly code: string } };

export type PiRunnerMessage = PiRunnerBody & {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly sequence: number;
};

function wireEvent(event: RuntimeEvent): RuntimeEvent {
  const payload = event.payload as RuntimeEvent['payload'] & { readonly kind?: RuntimeEvent['kind']; readonly usage?: unknown };
  if (payload.kind === 'usage') return { ...event, payload: payload.usage as unknown as RuntimeEvent['payload'] };
  const { kind: _payloadKind, ...wirePayload } = payload;
  return { ...event, payload: wirePayload as RuntimeEvent['payload'] };
}

export function normalizePiRunnerEvent(value: unknown): RuntimeEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return validateRuntimeEvent(value);
  const raw = value as Record<string, unknown>;
  const payload = raw.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).kind === raw.kind) {
    const canonical = payload as Record<string, unknown>;
    const { kind: _payloadKind, usage, ...wirePayload } = canonical;
    return validateRuntimeEvent({ ...raw, payload: raw.kind === 'usage' ? usage : wirePayload });
  }
  return validateRuntimeEvent(value);
}

export function piRunnerMessage(request: RuntimeExecutionRequest, sequence: number, payload: PiRunnerBody): PiRunnerMessage {
  if (request.identity.purpose !== 'work') throw runnerProtocolError('runner_work_required');
  const identity = request.identity as Extract<RuntimeExecutionRequest['identity'], { readonly purpose: 'work' }>;
  const normalized = payload.kind === 'event' ? { ...payload, body: wireEvent(payload.body) } : payload;
  return {
    schemaVersion: PI_RUNNER_PROTOCOL_VERSION, invocationId: request.invocationId,
    projectId: request.projectId, sessionId: request.sessionId,
    runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId,
    executionVersion: request.executionVersion, sequence, ...normalized,
  };
}

export function validatePiRunnerMessage(value: unknown, request: RuntimeExecutionRequest, previousSequence: number): PiRunnerMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw runnerProtocolError('runner_invalid_message');
  const raw = value as Record<string, unknown>;
  const expected = piRunnerMessage(request, previousSequence + 1, { kind: 'diagnostic', body: { code: 'unused' } });
  if (Object.keys(raw).some(key => !(key in expected))) throw runnerProtocolError('runner_unknown_field');
  for (const key of ['schemaVersion', 'invocationId', 'projectId', 'sessionId', 'runId', 'taskId', 'attemptId', 'executionVersion'] as const) {
    if (raw[key] !== expected[key]) throw runnerProtocolError(`runner_wrong_${key}`);
  }
  if (raw.sequence !== previousSequence + 1) throw runnerProtocolError('runner_invalid_sequence');
  let payload: PiRunnerBody;
  switch (raw.kind) {
    case 'event': payload = { kind: 'event', body: validateRuntimeEvent(raw.body) }; break;
    case 'result': payload = { kind: 'result', body: validateRuntimeExecutionResult(raw.body) }; break;
    case 'stopped': payload = { kind: 'stopped', body: validateRuntimeStopEvidence(raw.body) }; break;
    case 'cancel_receipt': payload = { kind: 'cancel_receipt', body: validateRuntimeCancelReceipt(raw.body) }; break;
    case 'diagnostic': {
      const body = raw.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'code')
        || typeof body.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.code)) {
        throw runnerProtocolError('runner_invalid_diagnostic');
      }
      payload = { kind: 'diagnostic', body: { code: body.code } };
      break;
    }
    default: throw runnerProtocolError('runner_unknown_message');
  }
  const identity = request.identity as Extract<RuntimeExecutionRequest['identity'], { readonly purpose: 'work' }>;
  return {
    schemaVersion: PI_RUNNER_PROTOCOL_VERSION, invocationId: request.invocationId,
    projectId: request.projectId, sessionId: request.sessionId,
    runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId,
    executionVersion: request.executionVersion, sequence: raw.sequence as number, ...payload,
  };
}

export function encodePiRunnerMessage(message: PiRunnerMessage): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (bytes.length > PI_RUNNER_MAX_MESSAGE_BYTES) throw runnerProtocolError('runner_message_overflow');
  return bytes;
}

/** Byte framing before JSON parsing: even a newline-free producer has a fixed ceiling. */
export class PiRunnerDecoder {
  private pending: Buffer = Buffer.alloc(0);
  *push(bytes: Uint8Array): Generator<unknown> {
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = this.pending.length + end - start;
      if (length + 1 > PI_RUNNER_MAX_MESSAGE_BYTES) throw runnerProtocolError('runner_message_overflow');
      const part = chunk.subarray(start, end);
      this.pending = this.pending.length ? Buffer.concat([this.pending, part], length) : Buffer.from(part);
      if (newline < 0) return;
      let message: unknown;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.pending)); }
      catch { throw runnerProtocolError('runner_invalid_json'); }
      this.pending = Buffer.alloc(0);
      yield message;
      start = end + 1;
    }
  }
  finish(): void {
    if (this.pending.length) throw runnerProtocolError('runner_truncated_message');
  }
}

/** A slow recorder fails closed, while protocol/process draining continues independently. */
export class PiRunnerEventChannel implements AsyncIterable<RuntimeEvent> {
  private readonly queue: Array<{ event: RuntimeEvent; bytes: number }> = [];
  private bufferedBytes = 0;
  private closed = false;
  private taken = false;
  private waiter: ((value: IteratorResult<RuntimeEvent>) => void) | undefined;
  constructor(private readonly onAbandon: () => void) {}
  push(event: RuntimeEvent): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = undefined;
      wake({ value: event, done: false });
      return true;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.queue.length >= PI_RUNNER_BUFFER_EVENTS || this.bufferedBytes + bytes > PI_RUNNER_BUFFER_BYTES) return false;
    this.queue.push({ event, bytes });
    this.bufferedBytes += bytes;
    return true;
  }
  snapshot(): { events: number; bytes: number } { return { events: this.queue.length, bytes: this.bufferedBytes }; }
  close(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    if (this.taken) throw runnerProtocolError('runner_events_already_consumed');
    this.taken = true;
    return {
      next: async () => {
        const item = this.queue.shift();
        if (item) {
          this.bufferedBytes -= item.bytes;
          return { value: item.event, done: false };
        }
        if (this.closed) return { value: undefined, done: true };
        if (this.waiter) throw runnerProtocolError('runner_concurrent_next');
        return new Promise(resolve => { this.waiter = resolve; });
      },
      return: async () => {
        if (!this.closed) this.onAbandon();
        this.queue.length = 0;
        this.bufferedBytes = 0;
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
