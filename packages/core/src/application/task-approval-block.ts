import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { createCompletedReceipt, PublicError, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { TASK_APPROVAL_BLOCKED_EVENT_TYPE } from '../ports/execution-store.js';
import { verifyFeaturePlanApprovalInTransaction } from './plan-approval-verification.js';

export const TASK_APPROVAL_BLOCK_OPERATION = 'task.approval.block';
type Envelope = Extract<ValidatedCommandEnvelope, { operation: typeof TASK_APPROVAL_BLOCK_OPERATION }>;
/** Only adds a block. Unblocking and resuming execution are deliberately not implemented here. */
export function submitTaskApprovalBlock(identity: {
  readonly principalId: string; readonly commandId: string; readonly operation: typeof TASK_APPROVAL_BLOCK_OPERATION;
  readonly scope: Envelope['scope']; readonly requestDigest: string; readonly issuedAt: string; readonly completedAt: string;
}, envelope: Envelope, transaction: CommandTransaction): CommandReceipt {
  const projectId = envelope.scope.projectId;
  transaction.getProject(projectId);
  const task = transaction.getTask(projectId, envelope.payload.taskId);
  const approval = verifyFeaturePlanApprovalInTransaction(transaction, projectId, task.featureId);
  if (approval.planDigest !== envelope.payload.planDigest) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'plan_digest_mismatch' } });
  }
  const item = transaction.insertTaskApprovalItem({
    projectId, featureId: task.featureId, taskId: task.id, kind: envelope.payload.kind ?? 'block',
    description: envelope.payload.description ?? 'Manual approval required', responsibleParty: envelope.payload.responsibleParty ?? 'project-owner',
    planDigest: approval.planDigest, codeDigest: envelope.payload.codeDigest ?? null,
    artifactRefs: envelope.payload.artifactRefs ?? [], createdBy: identity.principalId,
  });
  if (!item.created && envelope.expectedRevision !== task.revision) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'task_revision_conflict', expectedRevision: envelope.expectedRevision, actualRevision: task.revision } });
  }
  const revision = item.created
    ? transaction.blockTaskApproval({ projectId, taskId: task.id, expectedRevision: envelope.expectedRevision })
    : task.revision;
  if (item.created) transaction.appendExecutionEvent({ projectId, eventType: TASK_APPROVAL_BLOCKED_EVENT_TYPE,
    aggregateType: 'task', aggregateId: task.id, aggregateRevision: revision,
    payload: { blocked: true, itemId: item.record.id, kind: item.record.kind } });
  const receipt = createCompletedReceipt({ ...identity, resultRef: createResultRef(randomBytes(32)),
    result: { taskId: task.id, manualBlock: true, revision, item: item.record,
      planDigest: approval.planDigest, checkPolicyDigest: approval.checkPolicyDigest } });
  transaction.saveReceipt(receipt);
  return receipt;
}
