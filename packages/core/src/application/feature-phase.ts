import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { createResultRef } from '../ports/command-receipts.js';
import { createCompletedReceipt, createRejectedReceipt, mapStorageError } from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import { toPublicFeatureRecord } from '../ports/queries.js';

type MoveEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'feature.phase.move' }>;

export function submitFeaturePhaseMove(
  principalId: string, envelope: MoveEnvelope, requestDigest: string,
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
  let feature;
  try {
    feature = transaction.moveFeaturePhase({ projectId: envelope.scope.projectId,
      expectedRevision: envelope.expectedRevision, payload: envelope.payload });
  } catch (error) {
    if (isStorageError(error, 'conflict')) {
      const receipt = createRejectedReceipt({ ...identity,
        error: mapStorageError(error, { operation: envelope.operation }) });
      transaction.saveReceipt(receipt);
      return receipt;
    }
    throw error;
  }
  transaction.appendPlanEvent({ projectId: feature.projectId, eventType: 'feature.phase.moved',
    aggregateType: 'feature', aggregateId: feature.id, aggregateRevision: feature.revision,
    payload: { phaseMoved: true } });
  const receipt = createCompletedReceipt({ ...identity,
    resultRef: createResultRef(randomBytes(32)), result: { feature: toPublicFeatureRecord(feature) } });
  transaction.saveReceipt(receipt);
  return receipt;
}
