/** Trusted Core facts for fenced Runtime settlement; never a Task acceptance API. */
import type { RuntimeErrorKind, RuntimeExecutionResult, RuntimeStopEvidence } from './runtime-execution.js';
import { RUNTIME_ERROR_KINDS, validateRuntimeExecutionResult, validateRuntimeStopEvidence } from './runtime-execution.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';

export interface RuntimeSettlementFacts {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly result: RuntimeExecutionResult | null;
  readonly failure: { readonly kind: RuntimeErrorKind; readonly reason: string } | null;
  readonly recording: { readonly complete: boolean; readonly manifestRef: string | null };
  /** null means no stop observation, never confirmed by inference. */
  readonly stopped: RuntimeStopEvidence | null;
}

export function validateRuntimeSettlementFacts(value: unknown): RuntimeSettlementFacts {
  const context = { operation: 'AttemptLifecycle.runtimeSettlement' };
  const raw = requirePlainObject(value, context, 'runtime');
  rejectUnknownKeys(raw, ['sessionId', 'invocationId', 'result', 'failure', 'recording', 'stopped'], context, 'runtime');
  const recording = requirePlainObject(raw.recording, context, 'recording');
  rejectUnknownKeys(recording, ['complete', 'manifestRef'], context, 'recording');
  if (typeof recording.complete !== 'boolean') throw validationError(context, 'recording.complete', 'invalid_boolean');
  const manifestRef = recording.manifestRef === null ? null : validateStableId(recording.manifestRef, context, 'manifestRef');
  if (recording.complete && manifestRef === null) throw validationError(context, 'manifestRef', 'required_recording_missing');
  let failure: RuntimeSettlementFacts['failure'] = null;
  if (raw.failure !== null) {
    const f = requirePlainObject(raw.failure, context, 'failure');
    rejectUnknownKeys(f, ['kind', 'reason'], context, 'failure');
    if (!(RUNTIME_ERROR_KINDS as readonly unknown[]).includes(f.kind)) throw validationError(context, 'failure.kind', 'invalid_kind');
    if (typeof f.reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(f.reason)) throw validationError(context, 'failure.reason', 'invalid_reason');
    failure = { kind: f.kind as RuntimeErrorKind, reason: f.reason };
  }
  const result = raw.result === null ? null : validateRuntimeExecutionResult(raw.result);
  if (result === null && failure === null) throw validationError(context, 'failure', 'missing_execution_outcome');
  return { sessionId: validateStableId(raw.sessionId, context, 'sessionId'),
    invocationId: validateStableId(raw.invocationId, context, 'invocationId'), result, failure,
    recording: { complete: recording.complete, manifestRef },
    stopped: raw.stopped === null ? null : validateRuntimeStopEvidence(raw.stopped) };
}
