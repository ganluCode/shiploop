import { rejectUnknownKeys, requirePlainObject, validateSha256Digest, validateStableId, validationError } from './validation.js';

/** Internal Core settlement, never a model/client-reported classification. */
export const CODE_ATTEMPT_OUTCOMES = ['passed', 'code_failure', 'non_code_failure'] as const;
export type CodeAttemptOutcome = typeof CODE_ATTEMPT_OUTCOMES[number];
export const CODE_ATTEMPT_SETTLEMENT_PREFIX = 'verification-budget:v1:';

export interface CodeAttemptSettlementInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptKey: string;
  readonly outcome: CodeAttemptOutcome;
  /** Digest of the trusted observation, including immutable check/evidence identities. */
  readonly observationDigest: string;
}

export function validateCodeAttemptSettlement(value: unknown, operation: string): CodeAttemptSettlementInput {
  const context = { operation };
  const input = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(input, ['projectId', 'batchId', 'runId', 'taskId', 'attemptKey', 'outcome', 'observationDigest'], context, 'input');
  if (!CODE_ATTEMPT_OUTCOMES.includes(input.outcome as CodeAttemptOutcome)) throw validationError(context, 'outcome', 'Invalid code attempt outcome');
  if (typeof input.attemptKey !== 'string' || !input.attemptKey.trim() || input.attemptKey.length > 128) {
    throw validationError(context, 'attemptKey', 'Invalid reservation identity');
  }
  return {
    projectId: validateStableId(input.projectId, context, 'projectId'),
    batchId: validateStableId(input.batchId, context, 'batchId'),
    runId: validateStableId(input.runId, context, 'runId'),
    taskId: validateStableId(input.taskId, context, 'taskId'),
    attemptKey: input.attemptKey, outcome: input.outcome as CodeAttemptOutcome,
    observationDigest: validateSha256Digest(input.observationDigest, context, 'observationDigest'),
  };
}
