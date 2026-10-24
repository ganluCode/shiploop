import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { createResultRef } from '../ports/command-receipts.js';
import { createCompletedReceipt, createRejectedReceipt, mapStorageError } from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import { PHASE_MUTATION_EVENTS } from '../ports/phase-lifecycle.js';
import type { PhaseMutationOperation } from '../ports/phase-lifecycle.js';
import { toPublicPhaseRecord } from '../ports/queries.js';

type PhaseMutationEnvelope = Extract<ValidatedCommandEnvelope, { operation: PhaseMutationOperation }>;

export function submitPhaseMutation(
  principalId: string, envelope: PhaseMutationEnvelope, requestDigest: string,
  transaction: CommandTransaction, now: number,
): CommandReceipt {
  try {
    transaction.getProject(envelope.scope.projectId);
  } catch (error) {
    mapProjectLookupError(error, envelope.operation);
  }
  const identity = {
    principalId, commandId: envelope.commandId, operation: envelope.operation,
    scope: envelope.scope, requestDigest, issuedAt: envelope.issuedAt,
    completedAt: new Date(now).toISOString(),
  };
  let phase;
  try {
    phase = transaction.updatePhase({
      projectId: envelope.scope.projectId, operation: envelope.operation,
      expectedRevision: envelope.expectedRevision, payload: envelope.payload,
    });
  } catch (error) {
    // All conflict decisions precede the first business write; write faults escape and roll back.
    if (isStorageError(error, 'conflict')) {
      const receipt = createRejectedReceipt({ ...identity,
        error: mapStorageError(error, { operation: envelope.operation }) });
      transaction.saveReceipt(receipt);
      return receipt;
    }
    throw error;
  }
  const event = PHASE_MUTATION_EVENTS[envelope.operation];
  transaction.appendPlanEvent({ projectId: phase.projectId, eventType: event.type,
    aggregateType: 'phase', aggregateId: phase.id, aggregateRevision: phase.revision,
    payload: { [event.key]: true } });
  const receipt = createCompletedReceipt({ ...identity,
    resultRef: createResultRef(randomBytes(32)), result: { phase: toPublicPhaseRecord(phase) } });
  transaction.saveReceipt(receipt);
  return receipt;
}
