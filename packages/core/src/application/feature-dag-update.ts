import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { createResultRef } from '../ports/command-receipts.js';
import { createCompletedReceipt, createRejectedReceipt, mapStorageError } from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import { FEATURE_DAG_UPDATED_EVENT_TYPE } from '../ports/plan-store.js';
import type { FeatureDagUpdateResult } from '../ports/feature-dag-update.js';
import { toPublicPhaseRecord } from '../ports/queries.js';

type FeatureDagUpdateEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'feature.dag.update' }>;

export function submitFeatureDagUpdate(
  principalId: string,
  envelope: FeatureDagUpdateEnvelope,
  requestDigest: string,
  transaction: CommandTransaction,
  now: number,
): CommandReceipt {
  try {
    transaction.getProject(envelope.scope.projectId);
  } catch (error) {
    mapProjectLookupError(error, envelope.operation);
  }
  const identity = {
    principalId,
    commandId: envelope.commandId,
    operation: envelope.operation,
    scope: envelope.scope,
    requestDigest,
    issuedAt: envelope.issuedAt,
    completedAt: new Date(now).toISOString(),
  };
  let result: FeatureDagUpdateResult;
  try {
    result = transaction.updateFeatureDag({
      projectId: envelope.scope.projectId,
      phaseId: envelope.payload.phaseId,
      expectedRevision: envelope.expectedRevision,
      edges: envelope.payload.edges,
    });
  } catch (error) {
    if (isStorageError(error)) {
      const receipt = createRejectedReceipt({
        ...identity,
        error: mapStorageError(error, { operation: envelope.operation }),
      });
      transaction.saveReceipt(receipt);
      return receipt;
    }
    throw error;
  }
  transaction.appendPlanEvent({
    projectId: result.phase.projectId,
    eventType: FEATURE_DAG_UPDATED_EVENT_TYPE,
    aggregateType: 'phase',
    aggregateId: result.phase.id,
    aggregateRevision: result.phase.revision,
    payload: { dagUpdated: true },
  });
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      phase: toPublicPhaseRecord(result.phase),
      edges: result.edges,
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
