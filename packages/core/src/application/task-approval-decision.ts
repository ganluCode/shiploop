import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { createCompletedReceipt, PublicError, type AppCapability, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { TASK_APPROVAL_DECIDED_EVENT_TYPE } from '../ports/execution-store.js';
import type { TaskApprovalArtifactRef, TaskApprovalDecision } from '../ports/plan-store.js';
import { verifyFeaturePlanApprovalInTransaction } from './plan-approval-verification.js';

export const TASK_APPROVAL_DECISION_OPERATIONS = ['task.approval.approve', 'task.approval.reject', 'task.approval.unblock'] as const;
type DecisionOperation = (typeof TASK_APPROVAL_DECISION_OPERATIONS)[number];
type Envelope = Extract<ValidatedCommandEnvelope, { operation: DecisionOperation }>;

function decisionForOperation(operation: DecisionOperation): TaskApprovalDecision {
  return operation.slice('task.approval.'.length) as TaskApprovalDecision;
}

function isAuthorizedDecisionPrincipal(responsibleParty: string, principalId: string, capabilities: ReadonlySet<AppCapability>): boolean {
  if (responsibleParty === principalId) return true;
  // 可信 principal 的能力集合是服务端装配的明确获准角色；这些稳定角色名
  // 允许项目/任务审批能力承担责任主体，任意客户端字符串都不能自行获得此授权。
  return capabilities.has('feature.plan.decide')
    && new Set(['owner', 'project-owner', 'feature-approver', 'task-approver', 'role:task-approver']).has(responsibleParty);
}

function sameRefs(a: readonly TaskApprovalArtifactRef[], b: readonly TaskApprovalArtifactRef[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** F-008：事项决定只写事项事实（解除阻塞时清除 Task manual_block），绝不创建执行实体或调用 Runtime。 */
export function submitTaskApprovalDecision(identity: {
  readonly principalId: string;
  readonly capabilities: ReadonlySet<AppCapability>;
  readonly commandId: string;
  readonly operation: DecisionOperation;
  readonly scope: Envelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}, envelope: Envelope, transaction: CommandTransaction): CommandReceipt {
  const projectId = envelope.scope.projectId;
  transaction.getProject(projectId);
  const task = transaction.getTask(projectId, envelope.payload.taskId);
  const approval = verifyFeaturePlanApprovalInTransaction(transaction, projectId, task.featureId);
  const item = transaction.listTaskApprovalItems(projectId, task.id).find(candidate => candidate.id === envelope.payload.itemId);
  if (item === undefined) throw new PublicError('not_found', identity.operation, undefined, { details: { entityType: 'task_approval_item' } });
  if (item.featureId !== task.featureId) throw new PublicError('forbidden', identity.operation, undefined, { details: { reason: 'project_not_visible' } });
  if (item.status !== 'pending') throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'approval_item_already_decided' } });
  if (item.revision !== envelope.expectedRevision) throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'approval_item_revision_conflict' } });
  if (!isAuthorizedDecisionPrincipal(item.responsibleParty, identity.principalId, identity.capabilities)) {
    throw new PublicError('forbidden', identity.operation, undefined, { details: { reason: 'approval_responsibility_required' } });
  }
  if (item.planDigest !== approval.planDigest || envelope.payload.planDigest !== approval.planDigest) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'plan_digest_mismatch' } });
  }
  if (item.codeDigest === null || item.codeDigest !== envelope.payload.codeDigest) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'code_digest_mismatch' } });
  }
  const checkedRefs = envelope.payload.artifactRefs.map(ref => {
    const current = transaction.getArtifactInputRef(projectId, ref.artifactId);
    if (ref.contentHash !== current.contentHash) {
      throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'artifact_digest_mismatch' } });
    }
    return { artifactId: current.artifactId, contentHash: current.contentHash };
  });
  if (item.artifactRefs.length > 0 && !sameRefs(item.artifactRefs, checkedRefs)) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'artifact_binding_mismatch' } });
  }
  const decision = decisionForOperation(identity.operation);
  if ((decision === 'unblock' && item.kind !== 'block') || (decision !== 'unblock' && item.kind !== 'approval')) {
    throw new PublicError('conflict', identity.operation, undefined, { details: { reason: 'approval_item_kind_transition_invalid' } });
  }
  const decided = transaction.decideTaskApprovalItem({
    projectId, taskId: task.id, itemId: item.id, expectedRevision: envelope.expectedRevision,
    decision, planDigest: approval.planDigest, codeDigest: envelope.payload.codeDigest,
    artifactRefs: checkedRefs, reason: envelope.payload.reason, decisionActor: identity.principalId,
  });
  transaction.appendExecutionEvent({
    projectId, eventType: TASK_APPROVAL_DECIDED_EVENT_TYPE, aggregateType: 'task', aggregateId: task.id,
    aggregateRevision: decided.revision,
    payload: { decided: true },
  });
  const receipt = createCompletedReceipt({ ...identity, resultRef: createResultRef(randomBytes(32)),
    result: { taskId: task.id, item: decided, decision, executionStarted: false, runtimeCalled: false },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
