import { StorageError } from './errors.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId, validateSha256Digest } from './validation.js';

/** Public Batch delivery command results contain identities and evidence only. */
export const BATCH_DELIVERY_COMMAND_OPERATIONS = ['execution.batch.finalize', 'phase.delivery.approve'] as const;
export type BatchDeliveryCommandOperation = (typeof BATCH_DELIVERY_COMMAND_OPERATIONS)[number];

export interface BatchDeliveryCommandPayload {
  readonly phaseId: string;
  readonly batchId: string;
}
export interface PhaseDeliveryApprovePayload extends BatchDeliveryCommandPayload {
  readonly candidateId: string;
  readonly expectedCandidateRevision: number;
}

export interface BatchDeliveryCommandResult {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly batchRevision: number;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly status: 'ready_for_phase_approval' | 'approved';
  readonly featureIds: readonly string[];
  readonly scopeDigest: string;
  readonly inputDigest: string;
  readonly integrationCommitSha: string;
  readonly integrationTreeSha: string;
  readonly integrationEvidenceId: string;
  readonly integrationEvidenceDigest: string;
  readonly verificationEvidenceId: string;
  readonly verificationEvidenceDigest: string;
  readonly approvalId: string | null;
  readonly summaryDigest: string | null;
}

export function validateBatchDeliveryCommandResult(value: unknown): BatchDeliveryCommandResult {
  const context = { operation: 'BatchDeliveryCommandResult.validate' };
  const object = requirePlainObject(value, context, 'result');
  const keys = ['schemaVersion', 'projectId', 'phaseId', 'batchId', 'batchRevision', 'candidateId', 'candidateRevision', 'status', 'featureIds', 'scopeDigest', 'inputDigest', 'integrationCommitSha', 'integrationTreeSha', 'integrationEvidenceId', 'integrationEvidenceDigest', 'verificationEvidenceId', 'verificationEvidenceDigest', 'approvalId', 'summaryDigest'];
  rejectUnknownKeys(object, keys, context, 'result');
  const invalid = (): never => { throw new StorageError('validation', context.operation, 'Batch delivery result is invalid'); };
  if (keys.some(key => !Object.hasOwn(object, key)) || object.schemaVersion !== 1 || !['approved', 'ready_for_phase_approval'].includes(object.status as string)) invalid();
  for (const key of ['projectId', 'phaseId', 'batchId', 'candidateId', 'integrationEvidenceId', 'verificationEvidenceId']) validateStableId(object[key], context, key);
  for (const key of ['batchRevision', 'candidateRevision']) if (!Number.isSafeInteger(object[key]) || (object[key] as number) < 1) invalid();
  for (const key of ['scopeDigest', 'inputDigest', 'integrationEvidenceDigest', 'verificationEvidenceDigest']) validateSha256Digest(object[key], context, key);
  for (const key of ['integrationCommitSha', 'integrationTreeSha']) if (typeof object[key] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object[key] as string)) invalid();
  if (!Array.isArray(object.featureIds) || object.featureIds.length > 1000 || new Set(object.featureIds).size !== object.featureIds.length) invalid();
  for (const id of object.featureIds as unknown[]) validateStableId(id, context, 'featureIds');
  if (object.status === 'approved') {
    validateStableId(object.approvalId, context, 'approvalId'); validateSha256Digest(object.summaryDigest, context, 'summaryDigest');
  } else if (object.approvalId !== null || object.summaryDigest !== null || (object.featureIds as unknown[]).length === 0) invalid();
  return object as unknown as BatchDeliveryCommandResult;
}
