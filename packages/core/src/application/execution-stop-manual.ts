/** P04-7 / F-006：人工停止处置命令的同步事务用例。 */
import { randomBytes } from 'node:crypto';
import { mapProjectLookupError } from '../ports/authorization.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { createCompletedReceipt } from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';

type ManualEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'execution.stop.manual' }>;

export interface ExecutionStopManualCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: ManualEnvelope['operation'];
  readonly scope: ManualEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

export function submitExecutionStopManual(
  identity: ExecutionStopManualCommandIdentity,
  envelope: ManualEnvelope,
  transaction: CommandTransaction,
): CommandReceipt {
  const operation = envelope.operation;
  try {
    transaction.getProject(envelope.scope.projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }
  const result = transaction.recordExecutionStopManualAction({
    projectId: envelope.scope.projectId,
    stopOperationId: envelope.payload.stopOperationId,
    commandId: envelope.commandId,
    actorId: identity.principalId,
    action: envelope.payload.action,
    evidenceRef: envelope.payload.evidenceRef,
    expectedRevision: envelope.expectedRevision,
  });
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      disposition: result.disposition,
      operationId: result.operationId,
      action: result.action,
      auditRef: result.auditRef,
      revision: result.revision,
      status: result.status,
      stopConfirmed: result.stopConfirmed,
      releaseEligible: result.releaseEligible,
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
