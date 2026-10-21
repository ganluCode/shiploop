/** Trusted Core facts for fenced Runtime settlement; never a Task acceptance API. */
import type { RuntimeErrorKind, RuntimeExecutionResult, RuntimeStopEvidence } from './runtime-execution.js';
import { RUNTIME_ERROR_KINDS, validateRuntimeExecutionResult, validateRuntimeStopEvidence } from './runtime-execution.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';

export interface RuntimeTimeoutFact {
  /** 触发层；Session/tool/check 是执行层，run/batch 是持久父额度。 */
  readonly layer: 'session' | 'tool' | 'check' | 'run' | 'batch';
  /** 超时发生时执行阶段（已知值；不在未知时猜造）。 */
  readonly stage: 'runtime' | 'verification';
  /** 该层授权上限（毫秒）；适配器未暴露已知上限时保持 null。 */
  readonly limitMs: number | null;
  /** 已知耗时（毫秒）；无法观测时保持 null，绝不写 0。 */
  readonly elapsedMs: number | null;
}

export interface RuntimeControlFacts {
  readonly reason: 'user_cancelled' | 'service_close' | 'runtime_timeout' | 'tool_timeout' | 'parent_deadline' | 'recording_failed'
    | 'runtime_failed' | 'runtime_cancelled' | 'stop_unconfirmed';
  readonly cancel: 'accepted' | 'rejected' | 'failed' | 'unobserved';
  /** P03-9 / F-004：仅 timeout 类控制事实携带触发层/阶段/已知耗时。 */
  readonly timeout?: RuntimeTimeoutFact;
}

export interface RuntimeSettlementFacts {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly result: RuntimeExecutionResult | null;
  readonly failure: { readonly kind: RuntimeErrorKind; readonly reason: string } | null;
  readonly recording: { readonly complete: boolean; readonly manifestRef: string | null; readonly gaps?: readonly string[] };
  /** null means no stop observation, never confirmed by inference. */
  readonly stopped: RuntimeStopEvidence | null;
  readonly control?: RuntimeControlFacts;
}

export function validateRuntimeSettlementFacts(value: unknown): RuntimeSettlementFacts {
  const context = { operation: 'AttemptLifecycle.runtimeSettlement' };
  const raw = requirePlainObject(value, context, 'runtime');
  rejectUnknownKeys(raw, ['sessionId', 'invocationId', 'result', 'failure', 'recording', 'stopped', 'control'], context, 'runtime');
  const recording = requirePlainObject(raw.recording, context, 'recording');
  rejectUnknownKeys(recording, ['complete', 'manifestRef', 'gaps'], context, 'recording');
  let gaps: string[] | undefined;
  if (recording.gaps !== undefined) {
    if (!Array.isArray(recording.gaps) || recording.gaps.length > 32 || recording.gaps.some(gap =>
      typeof gap !== 'string' || gap.length === 0 || [...gap].length > 256 || /[\u0000-\u001F\u007F]/.test(gap))) {
      throw validationError(context, 'recording.gaps', 'invalid_recording_gaps');
    }
    gaps = [...recording.gaps] as string[];
  }
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
  if (result === null && failure === null && raw.control === undefined) throw validationError(context, 'failure', 'missing_execution_outcome');
  let control: RuntimeControlFacts | undefined;
  if (raw.control !== undefined) {
    const c = requirePlainObject(raw.control, context, 'control');
    rejectUnknownKeys(c, ['reason', 'cancel', 'timeout'], context, 'control');
    if (!['user_cancelled', 'service_close', 'runtime_timeout', 'tool_timeout', 'parent_deadline', 'recording_failed', 'runtime_failed', 'runtime_cancelled', 'stop_unconfirmed'].includes(String(c.reason))
      || !['accepted', 'rejected', 'failed', 'unobserved'].includes(String(c.cancel))) throw validationError(context, 'control', 'invalid_control_facts');
    let timeout: RuntimeTimeoutFact | undefined;
    if (c.timeout !== undefined) {
      const t = requirePlainObject(c.timeout, context, 'control.timeout');
      rejectUnknownKeys(t, ['layer', 'stage', 'limitMs', 'elapsedMs'], context, 'control.timeout');
      if (!['session', 'tool', 'check', 'run', 'batch'].includes(String(t.layer))
        || !['runtime', 'verification'].includes(String(t.stage))) {
        throw validationError(context, 'control.timeout', 'invalid_timeout_facts');
      }
      const optionalNonNegative = (value: unknown, field: string): number | null => {
        if (value === null) return null;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw validationError(context, field, 'invalid_duration');
        }
        return value;
      };
      timeout = {
        layer: t.layer as RuntimeTimeoutFact['layer'],
        stage: t.stage as RuntimeTimeoutFact['stage'],
        limitMs: optionalNonNegative(t.limitMs, 'control.timeout.limitMs'),
        elapsedMs: optionalNonNegative(t.elapsedMs, 'control.timeout.elapsedMs'),
      };
    }
    control = {
      reason: c.reason as RuntimeControlFacts['reason'],
      cancel: c.cancel as RuntimeControlFacts['cancel'],
      ...(timeout === undefined ? {} : { timeout }),
    };
  }
  return { sessionId: validateStableId(raw.sessionId, context, 'sessionId'),
    invocationId: validateStableId(raw.invocationId, context, 'invocationId'), result, failure,
    recording: { complete: recording.complete, manifestRef, ...(gaps === undefined ? {} : { gaps }) },
    stopped: raw.stopped === null ? null : validateRuntimeStopEvidence(raw.stopped), ...(control ? { control } : {}) };
}
