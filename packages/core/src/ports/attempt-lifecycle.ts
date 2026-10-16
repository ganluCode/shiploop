import type { RuntimeSettlementFacts } from './runtime-settlement.js';
import { validateRuntimeSettlementFacts } from './runtime-settlement.js';
import type { AttemptStatus } from './attempt-store.js';
import type { WorkResourceIdentity } from './work-resources.js';
import { validateWorkResourceIdentity } from './work-resources.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';

export { ATTEMPT_UPDATED_EVENT_TYPE, TASK_APPROVAL_BLOCKED_EVENT_TYPE } from './execution-store.js';
export const ATTEMPT_DIAGNOSTICS_LIMIT = 32;
export type AttemptNotification = WorkResourceIdentity & {
  readonly taskId: string;
  readonly runId: string;
  readonly notificationId: string;
} & (
  | { readonly kind: 'executing' }
  | { readonly kind: 'preparation_failed'; readonly errorKind: 'configuration' | 'workspace' | 'input'; readonly evidenceRef: string }
  | { readonly kind: 'runtime_completed'; readonly exitCode: number; readonly evidenceRef: string }
  | { readonly kind: 'runtime_settled'; readonly runtime: RuntimeSettlementFacts; readonly evidenceRef: string }
);
export interface AttemptApplicationResult {
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly attemptId: string;
  readonly status: AttemptStatus | null;
  readonly reason: string | null;
  readonly waitingFor: 'approval' | 'verification_not_assembled' | 'recording_required' | 'execution_uncertain' | null;
  readonly runtimeCompleted: boolean;
  readonly resultSaved: boolean;
  readonly stopConfirmed: boolean;
  readonly eventId: string | null;
}
/** Trusted Core/Runner ingress, not a model-writable command or acceptance API. */
export interface AttemptLifecycleStore {
  apply(notification: unknown, stopEvidence?: unknown): AttemptApplicationResult;
}
export function validateAttemptNotification(value: unknown): AttemptNotification {
  const context = { operation: 'AttemptLifecycle.apply' };
  const raw = requirePlainObject(value, context, 'notification');
  const common = ['projectId', 'attemptId', 'taskId', 'runId', 'owner', 'hostInstanceId', 'executionVersion', 'notificationId', 'kind'];
  const kind = raw.kind;
  if (kind !== 'executing' && kind !== 'preparation_failed' && kind !== 'runtime_completed' && kind !== 'runtime_settled') {
    throw validationError(context, 'kind', 'unsupported_notification');
  }
  rejectUnknownKeys(raw, [...common, ...(kind === 'executing' ? [] : ['evidenceRef']),
    ...(kind === 'preparation_failed' ? ['errorKind'] : kind === 'runtime_completed' ? ['exitCode'] : kind === 'runtime_settled' ? ['runtime'] : [])], context, 'notification');
  const identity = validateWorkResourceIdentity({ projectId: raw.projectId, attemptId: raw.attemptId,
    owner: raw.owner, hostInstanceId: raw.hostInstanceId, executionVersion: raw.executionVersion });
  const base = { ...identity, taskId: validateStableId(raw.taskId, context, 'taskId'),
    runId: validateStableId(raw.runId, context, 'runId'), notificationId: validateStableId(raw.notificationId, context, 'notificationId') };
  if (kind === 'executing') return { ...base, kind };
  const evidenceRef = validateStableId(raw.evidenceRef, context, 'evidenceRef');
  if (kind === 'preparation_failed') {
    if (typeof raw.errorKind !== 'string' || !['configuration', 'workspace', 'input'].includes(raw.errorKind)) throw validationError(context, 'errorKind', 'invalid_error_kind');
    return { ...base, kind, evidenceRef, errorKind: raw.errorKind as 'configuration' | 'workspace' | 'input' };
  }
  if (kind === 'runtime_settled') return { ...base, kind, evidenceRef, runtime: validateRuntimeSettlementFacts(raw.runtime) };
  if (typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode)) throw validationError(context, 'exitCode', 'invalid_exit_code');
  return { ...base, kind: 'runtime_completed', evidenceRef, exitCode: raw.exitCode };
}
