import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../ports/errors.js';
import { isUuidV4 } from '../ports/commands.js';
import { validateStableId } from '../ports/validation.js';
import { gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { GitCommitAuthorization } from '../ports/controlled-git-commit.js';
import type { GitOperationIntent, GitOperationRecord } from '../ports/git-operations.js';
import type { GitCommitReconciliation, GitCommitReconciliationService } from '../ports/git-commit-reconciliation.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';
import { gitCommitSourceDigest } from './controlled-git-commit.js';
import type { createControlledGitCommitService } from './controlled-git-commit.js';

const OP = 'GitCommit.reconcile';
function fail(reason: string): never {
  throw new StorageError('conflict', OP, reason, { details: { reason } });
}
function recorded(operation: GitOperationRecord): GitCommitReconciliation {
  return { outcome: operation.status === 'succeeded' || operation.status === 'no_change' ? 'matched'
    : operation.status === 'failed' ? 'failed' : 'unknown', reasonCode: operation.reasonCode, operation };
}

/** Does not launch commit, re-open Runs, reserve budgets, or release Work leases.
 * The trusted authorization reader must enforce the existing Run deadline/budget.
 * Each call uses the existing bounded driver/inspector; only HEAD is searched.
 */
export function createGitCommitReconciliationService(deps: Parameters<typeof createControlledGitCommitService>[0] & {
  /** Resolve the original immutable Verifier inspection via intent.verificationRefs,
   * including same-project artifact/digest checks. Never synthesize it from today's
   * worktree or SDK checkpoints. Missing evidence cannot authorize delivery.
   */
  readonly readVerificationInspection: (intent: GitOperationIntent) => WorkspaceInspection | null;
}): GitCommitReconciliationService {
  const now = deps.nowMs ?? Date.now;
  return { async reconcile(request) {
    if (!request || Object.keys(request).some(key => !['projectId', 'operationId'].includes(key))) fail('invalid_request');
    validateStableId(request.projectId, { operation: OP }, 'projectId');
    if (!isUuidV4(request.operationId)) fail('invalid_operation_id');
    const original = deps.operations.getGitOperation(request.projectId, request.operationId);
    // A recorded terminal result is historical evidence, never a fresh delivery grant.
    if (original.status !== 'pending') return recorded(original);
    const intent = original.intent;
    const authorization = structuredClone(deps.readAuthorization(request));
    const { baseline, resourceIdentity } = authorization;
    function sameIntent(auth: GitCommitAuthorization) {
      const { expectedFeatureRevision: _revision, ...currentIntent } = auth.intent;
      return isDeepStrictEqual({ ...currentIntent, candidateTree: intent.candidateTree }, intent);
    }
    if (!sameIntent(authorization) || resourceIdentity.projectId !== intent.projectId
      || resourceIdentity.owner !== intent.ownerId || resourceIdentity.hostInstanceId !== intent.hostInstanceId
      || resourceIdentity.executionVersion !== intent.executionVersion
      || (intent.attemptId !== null && resourceIdentity.attemptId !== intent.attemptId)
      || baseline.canonicalPath !== intent.worktreePath || baseline.repoIdentity !== intent.repoIdentity
      || baseline.repositoryBindingId !== intent.repositoryBindingId) fail('authorization_identity_mismatch');
    const workspaceKey = `workspace:${createHash('sha256').update(JSON.stringify([intent.repoIdentity, intent.worktreePath])).digest('hex')}`;
    function held() {
      const snapshot = deps.resources.read(resourceIdentity);
      if (!isDeepStrictEqual(snapshot.identity, resourceIdentity) || snapshot.leases.length !== 3
        || ['global:execution', `project:${intent.projectId}:work`, workspaceKey].some((key, index) => {
          const lease = snapshot.leases[index];
          return !lease || lease.resourceKey !== key || lease.resourceKind !== ['global', 'project', 'workspace'][index]
            || lease.ownerKind !== 'attempt' || lease.owner !== resourceIdentity.attemptId
            || lease.projectId !== intent.projectId || lease.hostInstanceId !== intent.hostInstanceId
            || lease.executionVersion !== intent.executionVersion || lease.state !== 'held' || lease.leaseUntilUtcMs <= now();
        })) fail('workspace_not_held');
      return snapshot;
    }
    const snapshot = structuredClone(held());
    function current() {
      if (!isDeepStrictEqual(deps.readAuthorization(request), authorization)) fail('authorization_changed');
      if (!isDeepStrictEqual(held(), snapshot)) fail('writer_identity_changed');
    }
    current();
    const token = await deps.stopVerifier.verify(snapshot);
    if (token === null || !isDeepStrictEqual(deps.stopVerifier.inspect(token), snapshot)) fail('previous_writer_stop_unconfirmed');
    current();
    const lockInput = { repoIdentity: intent.repoIdentity, workspacePath: intent.worktreePath,
      gitCommonDir: baseline.gitCommonDir, operationId: intent.operationId };
    // Keep a retained claim throughout inspection. Read-only reconciliation readers
    // may share an exact-owner stopped claim; SQL CAS chooses the sole settlement.
    let freshLease;
    try { freshLease = await deps.lock.acquire(lockInput); }
    catch (error) {
      if (!(await deps.lock.inspectRecovered?.(lockInput))) throw error;
    }
    let releaseClaim = false;
    try {
      current();
      const raced = deps.operations.getGitOperation(request.projectId, request.operationId);
      if (raced.status !== 'pending') { releaseClaim = raced.status !== 'unknown'; return recorded(raced); }
      const driver = deps.driver.open(baseline, current);
      const actual = await driver.facts();
      const before = await deps.inspector.inspect(baseline);
      current();
      if (before.repository.headCommit !== actual.head) fail('head_changed_during_reconciliation');
      const noChange = actual.head === intent.expectedHead && actual.tree === intent.candidateTree;
      if (actual.head === intent.expectedHead && !noChange) {
        // A surviving pending intent cannot distinguish never launched from a lost
        // failing command response. No result is invented, and no retry is made.
        return { outcome: 'not_executed', reasonCode: 'commit_not_observed', operation: original };
      }
      const message = gitOperationCommitMessage(intent.message, intent.operationId);
      const identity = { name: intent.gitIdentity.name, email: intent.gitIdentity.email };
      let unknownReason: string | null = null;
      if (!noChange && (actual.parents.length !== 1 || actual.parents[0] !== intent.expectedHead)) unknownReason = 'unexplained_head_drift';
      else if (!noChange && (actual.message !== message || !isDeepStrictEqual(actual.author, identity)
        || !isDeepStrictEqual(actual.committer, identity))) unknownReason = 'commit_intent_mismatch';
      let reason = unknownReason;
      if (unknownReason === null) {
        // write-tree may take index.lock even with GIT_OPTIONAL_LOCKS=0. Compare
        // the index to the verified HEAD tree using a read-only diff instead.
        if (actual.tree !== intent.candidateTree || (await driver.stagedPaths()).length !== 0) reason = 'candidate_tree_mismatch';
        else {
          const verified = deps.readVerificationInspection(intent);
          if (verified === null || verificationCodeIdentity(verified).codeDigest !== intent.codeDigest
            || verified.repository.headCommit !== intent.expectedHead
            || verified.repository.canonicalPath !== intent.worktreePath
            || verified.repository.repoIdentity !== intent.repoIdentity) reason = 'verification_evidence_missing';
          else if (gitCommitSourceDigest(before) !== gitCommitSourceDigest(verified)) reason = 'source_changed';
        }
        if (reason === null && (authorization.verificationPassed !== true || intent.verificationRefs.length === 0
          || authorization.approvalCurrent !== true || authorization.commitAuthorized !== true)) reason = 'delivery_not_authorized';
      }
      // Re-read real Git state and all bytes after inspection, then fence in the
      // same synchronous transaction as the receipt, delivery projection and event.
      const after = await deps.inspector.inspect(baseline);
      const finalFacts = await driver.facts();
      if (!isDeepStrictEqual(finalFacts, actual) || after.repository.headCommit !== actual.head
        || gitCommitSourceDigest(after) !== gitCommitSourceDigest(before)) fail('source_changed_during_reconciliation');
      if (reason === null && (await driver.stagedPaths()).length !== 0) fail('index_changed_during_reconciliation');
      const operation = deps.transact(() => {
        current();
        const latest = deps.operations.getGitOperation(request.projectId, request.operationId);
        if (latest.status !== 'pending') return latest;
        return deps.operations.finalizeGitOperation({ projectId: intent.projectId, operationId: intent.operationId,
          expectedRevision: original.revision, status: unknownReason ? 'unknown' : reason ? 'failed' : noChange ? 'no_change' : 'succeeded',
          actualCommit: unknownReason ? null : actual.head, actualTree: unknownReason ? null : actual.tree,
          exitCode: null, durationMs: null, reasonCode: reason,
          deliveryStatus: unknownReason ? 'pending' : reason ? 'failed' : 'succeeded', settledAtUtcMs: now() }).operation;
      });
      releaseClaim = operation.status !== 'unknown';
      return recorded(operation);
    } finally {
      // Unknown writers/results, source races and lost DB transactions preserve
      // the claim. Never take over by TTL, and never release Work occupancy here.
      if (releaseClaim) {
        if (freshLease) await freshLease.release();
        else if (!(await deps.lock.releaseRecovered(lockInput))) fail('git_claim_release_failed');
      }
    }
  } };
}
