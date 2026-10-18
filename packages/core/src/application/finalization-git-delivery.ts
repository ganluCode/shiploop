/**
 * P03-9 / F-012 受信 finalization-only Git 交付适配器。
 *
 * 复用既有受控提交/核对实现（意图、暂存、hook、真实 Git 事实与 operation
 * 回执），但收尾 Run 没有活动 Attempt，因此本适配器：
 * - 只接受 F-012 编排在事务外重新核对过的 scope/审批/预算；
 * - 以历史 Attempt 的归属身份构造受控提交授权（不启动该 Attempt）；
 * - 使用调用方提供的受界 inspector、Git driver、operation store 与公开元数据锁；
 * - 已终态 operation 只核对真实 HEAD/tree，不再次提交；pending 只走 reconcile。
 *
 * F-009/F-012 已确认没有活动 Attempt、held/quarantined 租约与遗留 writer；
 * 本适配器不自行接管进程，也不释放任何 Work 租约。
 */
import { createHash } from 'node:crypto';
import { createControlledGitCommitService, gitCommitSourceDigest } from './controlled-git-commit.js';
import { createGitCommitReconciliationService } from './git-commit-reconciliation.js';
import type { GitCommitAuthorization, GitCommitDriver } from '../ports/controlled-git-commit.js';
import { gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { GitCommitReconciliation } from '../ports/git-commit-reconciliation.js';
import type { GitOperationRecord, GitOperationStore } from '../ports/git-operations.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type {
  FinalizationCommitRequest,
  FinalizationDeliveryPort,
  FinalizationDeliveryVerification,
  FinalizationGitOperationView,
} from '../ports/finalization-completion.js';
import type { WorkResourceSnapshot } from '../ports/work-resources.js';
import type { WorkspaceInspection, WorkspaceInspector } from '../ports/workspace-inspector.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.startsWith('/')
    && !/[\0-\x1f\x7f]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
}

export interface FinalizationGitDeliveryDeps {
  readonly operations: GitOperationStore;
  readonly inspector: WorkspaceInspector;
  readonly driver: GitCommitDriver;
  readonly lock: GitPublicMetadataLock;
  /** Synchronous write transaction shared with operation store and feature revision. */
  readonly transact: <T>(callback: () => T) => T;
  readonly readFeatureRevision: (projectId: string, featureId: string) => number;
  readonly excludedPaths?: readonly string[];
  readonly nowMs?: () => number;
}

export function toFinalizationGitOperationView(operation: GitOperationRecord): FinalizationGitOperationView {
  return {
    operationId: operation.intent.operationId,
    status: operation.status,
    expectedHead: operation.intent.expectedHead,
    candidateTree: operation.intent.candidateTree,
    actualCommit: operation.actualCommit,
    actualTree: operation.actualTree,
    deliveryStatus: operation.deliveryStatus,
    reasonCode: operation.reasonCode,
  };
}

export function createFinalizationGitDelivery(deps: FinalizationGitDeliveryDeps): FinalizationDeliveryPort {
  if (deps === null || typeof deps !== 'object') throw new TypeError('FinalizationGitDelivery dependencies are required');
  for (const name of ['operations', 'inspector', 'driver', 'lock', 'transact', 'readFeatureRevision'] as const) {
    if (deps[name] === undefined || deps[name] === null) {
      throw new TypeError(`FinalizationGitDelivery dependency ${name} is required`);
    }
  }
  const now = deps.nowMs ?? Date.now;
  const exclusions = ['.shiploop', ...(deps.excludedPaths ?? [])];
  if (exclusions.some(path => !safePath(path))) throw new TypeError('Invalid Core exclusion path');

  function view(
    request: FinalizationCommitRequest,
    paths: readonly string[] = [],
    identityCodeDigest: string = request.codeDigest,
  ): { authorization: GitCommitAuthorization; snapshot: WorkResourceSnapshot } {
    const workspaceKey = `workspace:${createHash('sha256')
      .update(JSON.stringify([request.baseline.repoIdentity, request.baseline.canonicalPath]))
      .digest('hex')}`;
    const resourceIdentity = {
      projectId: request.projectId,
      attemptId: request.attempt.attemptId,
      owner: request.attempt.owner,
      hostInstanceId: request.attempt.hostInstanceId,
      executionVersion: request.attempt.executionVersion,
    };
    const snapshot: WorkResourceSnapshot = {
      identity: resourceIdentity,
      invocationId: null,
      processIdentity: null,
      leases: ['global:execution', `project:${request.projectId}:work`, workspaceKey].map((resourceKey, index) => ({
        id: `finalization-delivery-${resourceKey}`,
        createdAtUtcMs: now(),
        updatedAtUtcMs: now(),
        revision: 1,
        projectId: request.projectId,
        resourceKey,
        resourceKind: (['global', 'project', 'workspace'] as const)[index]!,
        ownerKind: 'attempt' as const,
        owner: resourceIdentity.attemptId,
        hostInstanceId: resourceIdentity.hostInstanceId,
        executionVersion: resourceIdentity.executionVersion,
        state: 'held' as const,
        leaseUntilUtcMs: now() + 3_600_000,
        processIdentity: null,
      })),
    };
    const authorization: GitCommitAuthorization = {
      intent: {
        operationId: request.operationId,
        projectId: request.projectId,
        featureId: request.featureId,
        runId: request.runId,
        attemptId: request.attempt.attemptId,
        executionVersion: request.attempt.executionVersion,
        operationType: 'feature_final_commit',
        repositoryBindingId: request.baseline.repositoryBindingId,
        repoIdentity: request.baseline.repoIdentity,
        worktreePath: request.baseline.canonicalPath,
        expectedHead: request.expectedHead,
        codeDigest: identityCodeDigest,
        verificationRefs: [...request.verificationRefs],
        approvalRefs: [...request.approvalRefs],
        message: request.message,
        gitIdentity: request.gitIdentity,
        deliveryPolicyDigest: request.deliveryPolicyDigest,
        runtimeSource: null,
        ownerId: request.attempt.owner,
        hostInstanceId: request.attempt.hostInstanceId,
        expectedFeatureRevision: deps.readFeatureRevision(request.projectId, request.featureId),
      },
      baseline: request.baseline,
      resourceIdentity,
      allowedPaths: [...paths],
      verificationPassed: true,
      approvalCurrent: true,
      finalApprovalCurrent: true,
      commitAuthorized: true,
    };
    return { authorization, snapshot };
  }

  function allowedPaths(inspection: WorkspaceInspection): string[] {
    return [...new Set([
      ...inspection.contents.tracked.map(entry => entry.path),
      ...inspection.contents.untracked.map(entry => entry.path),
    ])].filter(path => safePath(path)
      && !exclusions.some(excluded => path === excluded || path.startsWith(`${excluded}/`)))
      .sort();
  }

  function evidenceFor(request: FinalizationCommitRequest, baselineInspection: WorkspaceInspection) {
    // Git intent binds the content identity that survives add/commit; the F-009
    // workspace codeDigest also includes Git status and is only a preflight check.
    const identityCodeDigest = verificationCodeIdentity(baselineInspection).codeDigest;
    return view(request, allowedPaths(baselineInspection), identityCodeDigest).authorization;
  }

  function resources(snapshot: WorkResourceSnapshot) {
    return { read: () => snapshot };
  }

  function stopVerifier(snapshot: WorkResourceSnapshot) {
    return {
      verify: async () => ({}),
      inspect: () => snapshot,
    };
  }

  function controlled(request: FinalizationCommitRequest, baselineInspection: WorkspaceInspection) {
    const authorization = evidenceFor(request, baselineInspection);
    const built = view(request, authorization.allowedPaths, authorization.intent.codeDigest);
    return createControlledGitCommitService({
      operations: deps.operations,
      inspector: deps.inspector,
      resources: resources(built.snapshot),
      stopVerifier: stopVerifier(built.snapshot),
      lock: deps.lock,
      driver: deps.driver,
      readAuthorization: () => authorization,
      transact: deps.transact,
      excludedPaths: exclusions,
      nowMs: now,
    });
  }

  function reconciler(request: FinalizationCommitRequest, baselineInspection: WorkspaceInspection) {
    const authorization = evidenceFor(request, baselineInspection);
    const built = view(request, authorization.allowedPaths, authorization.intent.codeDigest);
    return createGitCommitReconciliationService({
      operations: deps.operations,
      inspector: deps.inspector,
      resources: resources(built.snapshot),
      stopVerifier: stopVerifier(built.snapshot),
      lock: deps.lock,
      driver: deps.driver,
      readAuthorization: () => authorization,
      transact: deps.transact,
      excludedPaths: exclusions,
      nowMs: now,
      readVerificationInspection(intent) {
        // A pending operation proves the original expected HEAD and verified
        // content identity. Reconstruct only that immutable view from current
        // bytes; never synthesize evidence when the content identity differs.
        const code = verificationCodeIdentity(baselineInspection);
        if (code.codeDigest !== intent.codeDigest) return null;
        return {
          ...baselineInspection,
          repository: { ...baselineInspection.repository, headCommit: intent.expectedHead },
        };
      },
    });
  }

  function requestFromOperation(
    request: FinalizationCommitRequest,
    operation: GitOperationRecord,
  ): FinalizationCommitRequest {
    if (operation.intent.attemptId === null) {
      throw Object.assign(new Error('attempt_identity_mismatch'), { reason: 'attempt_identity_mismatch' });
    }
    return {
      ...request,
      runId: operation.intent.runId,
      operationId: operation.intent.operationId,
      expectedHead: operation.intent.expectedHead,
      codeDigest: operation.intent.codeDigest,
      verificationRefs: operation.intent.verificationRefs,
      approvalRefs: operation.intent.approvalRefs,
      attempt: {
        attemptId: operation.intent.attemptId,
        executionVersion: operation.intent.executionVersion,
        owner: operation.intent.ownerId,
        hostInstanceId: operation.intent.hostInstanceId,
      },
      message: operation.intent.message,
      gitIdentity: operation.intent.gitIdentity,
      deliveryPolicyDigest: operation.intent.deliveryPolicyDigest,
    };
  }

  return {
    readOperation(projectId, operationId) {
      try {
        return toFinalizationGitOperationView(deps.operations.getGitOperation(projectId, operationId));
      } catch {
        return null;
      }
    },

    async verifyOperation(request, operationId): Promise<FinalizationDeliveryVerification> {
      let operation: GitOperationRecord;
      try {
        operation = deps.operations.getGitOperation(request.projectId, operationId);
      } catch {
        return { matched: false, reasonCode: 'operation_missing' };
      }
      if (operation.status !== 'succeeded' && operation.status !== 'no_change') {
        return { matched: false, reasonCode: 'operation_not_terminal' };
      }
      const session = deps.driver.open(request.baseline, () => undefined);
      const facts = await session.facts();
      const inspection = await deps.inspector.inspect(request.baseline);
      const identity = verificationCodeIdentity(inspection);
      if (inspection.repository.headCommit !== facts.head || identity.codeDigest !== operation.intent.codeDigest) {
        return { matched: false, reasonCode: 'source_changed' };
      }
      if (operation.status === 'no_change') {
        if (facts.head !== operation.intent.expectedHead || facts.tree !== operation.intent.candidateTree) {
          return { matched: false, reasonCode: 'no_change_facts_mismatch' };
        }
        return { matched: true, reasonCode: null };
      }
      if (operation.actualCommit === null || operation.actualTree === null
        || facts.head !== operation.actualCommit || facts.tree !== operation.actualTree
        || facts.parents.length !== 1 || facts.parents[0] !== operation.intent.expectedHead) {
        return { matched: false, reasonCode: 'commit_facts_mismatch' };
      }
      const message = gitOperationCommitMessage(operation.intent.message, operation.intent.operationId);
      if (facts.message !== message) return { matched: false, reasonCode: 'commit_intent_mismatch' };
      return { matched: true, reasonCode: null };
    },

    async commit(request) {
      const before = await deps.inspector.inspect(request.baseline);
      if (before.repository.headCommit !== request.expectedHead) {
        throw Object.assign(new Error('head_drift'), { reason: 'head_drift' });
      }
      if (before.codeDigest !== request.codeDigest) {
        throw Object.assign(new Error('source_changed'), { reason: 'source_changed' });
      }
      const operation = await controlled(request, before).commit({
        projectId: request.projectId,
        operationId: request.operationId,
      });
      return toFinalizationGitOperationView(operation);
    },

    async reconcile(request, operationId): Promise<GitCommitReconciliation> {
      const operation = deps.operations.getGitOperation(request.projectId, operationId);
      const preserved = requestFromOperation(request, operation);
      const before = await deps.inspector.inspect(preserved.baseline);
      return reconciler(preserved, before).reconcile({ projectId: request.projectId, operationId });
    },
  };
}

/** Exported for focused tests asserting that no unverified source is delivered. */
export function finalizationDeliverySourceDigest(inspection: WorkspaceInspection): string {
  return gitCommitSourceDigest(inspection);
}
