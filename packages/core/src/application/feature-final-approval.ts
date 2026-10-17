import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { TaskApprovalItemRecord } from '../ports/plan-store.js';
import type { FeaturePlanApprovalVerification } from './plan-approval-verification.js';

/**
 * The existing approval rows are Task-owned, while final delivery is Feature-owned.
 * Read every member through the same write transaction so a final decision never
 * combines one Task revision with another revision of the Feature plan.
 */
export function listFeatureApprovalItemsInTransaction(
  transaction: CommandTransaction,
  projectId: string,
  featureId: string,
): readonly TaskApprovalItemRecord[] {
  const plan = transaction.getFeaturePlan(projectId, featureId);
  return plan.tasks.flatMap(task => transaction.listTaskApprovalItems(projectId, task.id));
}

export type FeatureFinalApprovalReason =
  | 'plan_approval_invalid'
  | 'approval_required'
  | 'approval_pending'
  | 'approval_rejected'
  | 'manual_block'
  | 'approval_identity_stale'
  | 'approval_artifact_stale';

export interface FeatureFinalApprovalInput {
  readonly codeDigest: string;
  readonly requireApproval?: boolean;
}

export interface FeatureFinalApprovalEvaluation {
  readonly valid: boolean;
  readonly reason: FeatureFinalApprovalReason | null;
  readonly approval: TaskApprovalItemRecord | null;
  readonly blockingItems: readonly TaskApprovalItemRecord[];
}

function refsEqual(left: readonly { artifactId: string; contentHash: string | null }[], right: readonly { artifactId: string; contentHash: string | null }[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Evaluate the human gate against the current Feature plan approval and current
 * verification code identity. Historical rows remain visible, but cannot grant
 * authorization after a plan or code identity change.
 */
export function evaluateFeatureFinalApproval(
  transaction: CommandTransaction,
  approval: FeaturePlanApprovalVerification,
  input: FeatureFinalApprovalInput,
  items: readonly TaskApprovalItemRecord[] = [],
): FeatureFinalApprovalEvaluation {
  if (!approval.validity.valid || approval.planDigest === null) {
    return { valid: false, reason: 'plan_approval_invalid', approval: null, blockingItems: [] };
  }
  const current = items.length > 0
    ? items
    : listFeatureApprovalItemsInTransaction(transaction, approval.projectId, approval.featureId);
  const blockingItems: TaskApprovalItemRecord[] = [];
  let approved: TaskApprovalItemRecord | null = null;
  let staleIdentity = false;
  let staleArtifact = false;
  let rejected = false;
  let pending = false;

  for (const item of current) {
    const currentPlan = item.planDigest === approval.planDigest;
    const currentCode = item.codeDigest === input.codeDigest;
    if (!currentPlan || (item.codeDigest !== null && !currentCode)) {
      if (item.kind === 'approval' || item.status === 'pending') staleIdentity = true;
      continue;
    }
    if (item.kind === 'block' && item.status === 'pending') {
      blockingItems.push(item);
      continue;
    }
    if (item.kind !== 'approval') continue;
    if (item.status === 'pending') { pending = true; continue; }
    if (item.status === 'rejected') { rejected = true; continue; }
    if (item.status !== 'approved' || item.decisionCodeDigest !== input.codeDigest) {
      staleIdentity = true;
      continue;
    }
    // A decision may carry a refreshed artifact snapshot. Prefer it when present;
    // an empty decision snapshot preserves the existing digest-only approval form.
    const decisionRefs = item.decisionArtifactRefs.length > 0 ? item.decisionArtifactRefs : item.artifactRefs;
    for (const ref of decisionRefs) {
      try {
        const currentRef = transaction.getArtifactInputRef(approval.projectId, ref.artifactId);
        if (currentRef.contentHash !== ref.contentHash) staleArtifact = true;
      } catch {
        staleArtifact = true;
      }
    }
    if (!staleArtifact && approved === null) approved = item;
  }

  if (blockingItems.length > 0) return { valid: false, reason: 'manual_block', approval: approved, blockingItems };
  if (staleArtifact) return { valid: false, reason: 'approval_artifact_stale', approval: approved, blockingItems };
  if (rejected) return { valid: false, reason: 'approval_rejected', approval: approved, blockingItems };
  if (pending) return { valid: false, reason: 'approval_pending', approval: approved, blockingItems };
  if (staleIdentity && approved === null) {
    return { valid: false, reason: 'approval_identity_stale', approval: approved, blockingItems };
  }
  if (input.requireApproval !== false && approved === null) {
    return { valid: false, reason: 'approval_required', approval: approved, blockingItems };
  }
  return { valid: true, reason: null, approval: approved, blockingItems };
}

/** Keep the approval artifact comparison available to callers assembling a Git authorization. */
export { refsEqual as sameFeatureApprovalArtifactRefs };
