import { randomUUID, createHash } from 'node:crypto';
import { createControlledGitCommitService, gitCommitSourceDigest } from '../../application/controlled-git-commit.js';
import { createGitCommitReconciliationService } from '../../application/git-commit-reconciliation.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { resolveDeliveryPolicyForUse, computeDeliveryPolicyDigest } from '../../ports/delivery-policy.js';
import { verificationCodeIdentity } from '../../ports/verification-aggregate.js';
import { StorageError } from '../../ports/errors.js';
import type { GitCommitDriver, GitCommitAuthorization } from '../../ports/controlled-git-commit.js';
import type { GitPublicMetadataLock } from '../../ports/git-public-metadata-lock.js';
import type { WorkspaceInspector, WorkspaceInspection } from '../../ports/workspace-inspector.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import type { WorkResourceAccess, WorkResourceStopVerifier } from '../../ports/work-resources.js';
import type { WorkResourceIdentity } from '../../ports/work-resources.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteGitOperationStore } from './git-operations.js';
import type { ArtifactPublisher } from '../../application/artifact-publish.js';
import type { ArtifactFileStore } from '../../ports/artifact-files.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { VerificationStopControl } from '../../ports/verification-stop.js';

/** Trusted adapter: current authorization is reread before each Git side effect.
 * No Git/FS I/O is performed inside the short SQLite transactions.
 */
export function createSqliteTaskCommitter(deps: {
  session: SqliteStorageSession;
  resources: WorkResourceAccess;
  stopVerifier: WorkResourceStopVerifier;
  inspectorFor(projectId: string): Promise<WorkspaceInspector>;
  driverFor(projectId: string, signal?: AbortSignal,
    observeStop?: (value: { stopConfirmed: boolean; exitCode: number | null; signal: string | null; reason: string | null }) => void): GitCommitDriver;
  lock: GitPublicMetadataLock;
  publisher: ArtifactPublisher;
  files: ArtifactFileStore;
  stopControl: VerificationStopControl;
  nowMs?: () => number;
}) {
  const { session } = deps;
  const db = session.database;
  const atomic = createSqliteAtomicCommandStore(session);
  const operations = createSqliteGitOperationStore(session);
  const now = deps.nowMs ?? Date.now;
  function fail(reason: string): never {
    throw new StorageError('conflict', 'TaskCommit.commit', reason, { details: { reason } });
  }
  return async (input: { identity: WorkResourceIdentity; taskId: string; runId: string;
    verificationBatchId: string; codeDigest: string; expectedHead: string;
    assertCurrent?: (tx: CommandTransaction) => void; retryFailed?: boolean }): Promise<void> => {
    const { identity } = input;
    const awaitingApproval = atomic.transact('TaskCommit.approval', tx => {
      const attempt = db.prepare<[string], { feature_id: string; input_snapshot: string }>(
        'SELECT feature_id, input_snapshot FROM attempts WHERE id = ?').get(identity.attemptId);
      if (!attempt) fail('attempt_missing');
      const approval = verifyFeaturePlanApprovalInTransaction(tx, identity.projectId, attempt.feature_id);
      const task = db.prepare<[string], { manual_block: number }>('SELECT manual_block FROM tasks WHERE id = ?').get(input.taskId);
      const saved = JSON.parse(attempt.input_snapshot).approval;
      return !task || task.manual_block === 1 || !approval.validity.valid
        || approval.planDigest !== saved?.planDigest || approval.currentDecision?.id !== saved?.decisionId
        || tx.listTaskApprovalItems(identity.projectId, input.taskId).some(item =>
          item.planDigest !== approval.planDigest || (item.codeDigest !== null && item.codeDigest !== input.codeDigest)
          || (item.kind === 'approval' && (item.status !== 'approved' || item.decisionCodeDigest !== input.codeDigest))
          || (item.kind === 'block' && item.status !== 'unblocked'));
    });
    if (awaitingApproval) return;
    const workspace = db.prepare<[string], {
      repository_binding_id: string; repository_binding_revision: number; repo_identity: string;
      canonical_path: string; git_common_dir: string; branch: string; base_commit: string;
    }>('SELECT w.* FROM managed_workspaces w JOIN attempts a ON a.feature_id = w.feature_id WHERE a.id = ?').get(identity.attemptId);
    if (!workspace) fail('workspace_missing');
    const baseline: WorkspaceBaseline = {
      repositoryBindingId: workspace.repository_binding_id, repositoryBindingRevision: workspace.repository_binding_revision,
      repoIdentity: workspace.repo_identity, canonicalPath: workspace.canonical_path, gitCommonDir: workspace.git_common_dir,
      branch: workspace.branch, baseCommit: workspace.base_commit,
    };
    const inspector = await deps.inspectorFor(identity.projectId);
    const inspection = await inspector.inspect(baseline);
    const codeDigest = input.codeDigest;
    const prior = db.prepare<[string, string], { id: string }>(
      `SELECT id FROM git_operations WHERE project_id = ? AND attempt_id = ? AND operation_type = 'task_commit'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(identity.projectId, identity.attemptId);
    const previous = prior && operations.getGitOperation(identity.projectId, prior.id);
    const retryFailed = input.retryFailed === true && previous?.status === 'failed'
      && previous.actualCommit === previous.intent.expectedHead && previous.reasonCode === 'git_commit_failed';
    const operationId = retryFailed ? randomUUID() : prior?.id ?? randomUUID();
    let original: WorkspaceInspection = inspection;
    let inspectionRef: { kind: 'artifact'; id: string; digest: string };
    if (prior) {
      const record = previous!;
      const ref = record.intent.verificationRefs.find(ref => ref.kind === 'artifact');
      if (!ref) fail('commit_inspection_missing');
      const file = await deps.files.openFinalRead({ projectId: identity.projectId, artifactId: ref.id });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of file.stream) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) fail('commit_inspection_oversized');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      if (createHash('sha256').update(body).digest('hex') !== ref.digest) fail('commit_inspection_corrupt');
      original = JSON.parse(body.toString('utf8')) as WorkspaceInspection;
      inspectionRef = { ...ref, kind: 'artifact' };
    } else {
      if (verificationCodeIdentity(original).codeDigest !== codeDigest) fail('verification_source_changed');
      const body = Buffer.from(JSON.stringify(original));
      if (body.length > 4 * 1024 * 1024) fail('commit_inspection_oversized');
      const digest = createHash('sha256').update(body).digest('hex');
      const artifact = await deps.publisher.publishArtifact({ projectId: identity.projectId,
        kind: 'task_commit_inspection', mediaType: 'application/json', expectedHash: digest,
        locator: `attempts/${identity.attemptId}/commits/${operationId}.json`, content: [body] });
      inspectionRef = { kind: 'artifact', id: artifact.artifact.id, digest };
    }
    if (original.repository.headCommit !== input.expectedHead
      || verificationCodeIdentity(original).codeDigest !== codeDigest) fail('verification_source_changed');
    let paths = [...new Set([...original.contents.tracked, ...original.contents.untracked].map(x => x.path))]
      .filter(path => path !== '.shiploop' && !path.startsWith('.shiploop/')).sort();
    let activeTransaction: CommandTransaction | undefined;
    const authorize = (tx: CommandTransaction): GitCommitAuthorization => {
      input.assertCurrent?.(tx);
      const a = db.prepare<[string], { project_id: string; feature_id: string; run_id: string; task_id: string;
        owner_id: string; host_instance_id: string; execution_version: number; status: string; input_snapshot: string }>(
        'SELECT * FROM attempts WHERE id = ?').get(identity.attemptId);
      if (!a || a.project_id !== identity.projectId || a.run_id !== input.runId || a.task_id !== input.taskId
        || a.owner_id !== identity.owner || a.host_instance_id !== identity.hostInstanceId
        || a.execution_version !== identity.executionVersion || a.status !== 'verifying') fail('stale_attempt');
      const task = db.prepare<[string], { manual_block: number; execution_version: number; status: string }>(
        'SELECT manual_block, execution_version, status FROM tasks WHERE id = ?').get(input.taskId);
      const approval = verifyFeaturePlanApprovalInTransaction(tx, identity.projectId, a.feature_id);
      const snapshot = JSON.parse(a.input_snapshot);
      const global = tx.getGlobalSettingsOrNull(), project = tx.getProjectSettingsOrNull(identity.projectId);
      const settings = mergeEffectiveSettings({
        global: global && { scopeRevision: global.revision, payload: global.payload },
        project: project && { scopeRevision: project.revision, payload: project.payload },
      });
      const section = settings.policies.deliveryPolicy?.value;
      const policy = resolveDeliveryPolicyForUse(section);
      if (policy.status !== 'ready') fail(policy.reason);
      const batch = db.prepare<[string], { status: string; code_digest: string; attempt_id: string; policy_digest: string }>(
        'SELECT * FROM verification_batches WHERE id = ?').get(input.verificationBatchId);
      const results = db.prepare<[string], { count: number; failed: number }>(
        "SELECT COUNT(*) AS count, SUM(CASE WHEN status <> 'passed' THEN 1 ELSE 0 END) AS failed FROM check_results WHERE batch_id = ?")
        .get(input.verificationBatchId)!;
      const run = db.prepare<[string], { status: string; reason: string | null; batch_id: string; started_at: number | null; run_time_limit_ms: number }>('SELECT * FROM runs WHERE id = ?').get(input.runId);
      const batchState = run && db.prepare<[string], { status: string; deadline_at: number }>('SELECT * FROM execution_batches WHERE id = ?').get(run.batch_id);
      const waiting = tx.listTaskApprovalItems(identity.projectId, input.taskId).some(item =>
        item.planDigest !== approval.planDigest || (item.codeDigest !== null && item.codeDigest !== codeDigest)
        || (item.kind === 'approval' && (item.status !== 'approved' || item.decisionCodeDigest !== codeDigest))
        || (item.kind === 'block' && item.status !== 'unblocked'));
      const feature = db.prepare<[string], { revision: number }>('SELECT revision FROM features WHERE id = ?').get(a.feature_id)!;
      return {
        intent: { operationId, projectId: identity.projectId, featureId: a.feature_id, runId: input.runId,
          attemptId: identity.attemptId, executionVersion: identity.executionVersion, operationType: 'task_commit',
          repositoryBindingId: baseline.repositoryBindingId, repoIdentity: baseline.repoIdentity, worktreePath: baseline.canonicalPath,
          expectedHead: original.repository.headCommit, codeDigest,
          verificationRefs: [{ kind: 'verification_batch', id: input.verificationBatchId, digest: codeDigest }, inspectionRef],
          approvalRefs: approval.currentDecision && approval.planDigest ? [{ kind: 'plan_approval', id: approval.currentDecision.id, digest: approval.planDigest }] : [],
          message: `${input.taskId}: verified task`, gitIdentity: policy.policy.gitIdentity,
          deliveryPolicyDigest: computeDeliveryPolicyDigest(section), runtimeSource: null,
          ownerId: identity.owner, hostInstanceId: identity.hostInstanceId, expectedFeatureRevision: feature.revision },
        baseline, resourceIdentity: identity, allowedPaths: paths,
        verificationPassed: batch?.status === 'passed' && batch.attempt_id === identity.attemptId
          && batch.code_digest === codeDigest && batch.policy_digest === snapshot.approval?.checkPolicyDigest
          && results.count > 0 && results.failed === 0,
        approvalCurrent: !!task && task.manual_block === 0 && task.status === 'running'
          && task.execution_version === identity.executionVersion && !waiting && approval.validity.valid
          && approval.planDigest === snapshot.approval?.planDigest && approval.currentDecision?.id === snapshot.approval?.decisionId,
        commitAuthorized: !!run && ['queued', 'running', 'pausing', 'paused'].includes(run.status)
          && (run.status !== 'paused' || ['verification_not_assembled', 'approval', 'user_pause', 'task_commit_required'].includes(run.reason ?? ''))
          && !!batchState && batchState.deadline_at > now()
          && (run.started_at === null || run.started_at + run.run_time_limit_ms > now())
          && !['cancelled', 'cancelling', 'failed', 'succeeded'].includes(batchState.status),
      };
    };
    const readAuthorization = () => activeTransaction ? authorize(activeTransaction)
      : atomic.transact('TaskCommit.authorize', authorize);
    if (!readAuthorization().approvalCurrent) return;
    if (!prior || retryFailed) {
      const driver = deps.driverFor(identity.projectId).open(baseline, () => {
        const auth = readAuthorization();
        if (!auth.verificationPassed || !auth.approvalCurrent || !auth.commitAuthorized) fail('task_commit_not_authorized');
      });
      const changed = new Set([...(await driver.stagedPaths()), ...(await driver.unstagedPaths())]);
      // The bounded Git write set is changed files, not every file in a large repo.
      paths = paths.filter(path => changed.has(path));
    }
    const run = db.prepare<[string], { batch_id: string }>('SELECT batch_id FROM runs WHERE id = ?').get(input.runId);
    if (!run) fail('run_missing');
    const registration = deps.stopControl.begin({ projectId: identity.projectId, runId: input.runId,
      batchId: run.batch_id, attemptId: identity.attemptId, executionVersion: identity.executionVersion, operation: 'task.commit' });
    try {
    const serviceDeps = { operations, inspector, resources: deps.resources, stopVerifier: deps.stopVerifier,
      lock: deps.lock, driver: deps.driverFor(identity.projectId, registration.signal, value => registration.record({
        checkKey: 'task.commit', launched: true, ...value, forced: value.signal === 'SIGKILL' ? true : null,
        gaps: value.stopConfirmed ? [] : ['git_stop_unconfirmed'],
      })), readAuthorization,
      transact: <T>(fn: () => T) => atomic.transact('TaskCommit.commit', tx => {
        activeTransaction = tx;
        try { return fn(); } finally { activeTransaction = undefined; }
      }), excludedPaths: [], nowMs: now, originalVerificationInspection: () => original };
    // Keep the machine observation for human approval; never commit through a hold.
    if (!readAuthorization().approvalCurrent) return;
    let record;
    if (prior && !retryFailed && previous!.status === 'pending') {
      const reconciled = await createGitCommitReconciliationService({ ...serviceDeps,
        readVerificationInspection: () => original }).reconcile({ projectId: identity.projectId, operationId });
      record = operations.getGitOperation(identity.projectId, operationId);
      if (reconciled.outcome === 'not_executed') fail('task_commit_not_observed_requires_recovery');
    } else {
      record = await createControlledGitCommitService(serviceDeps).commit({ projectId: identity.projectId, operationId });
    }
    if (!['succeeded', 'no_change'].includes(record.status)) fail('task_commit_failed');
    const after = await inspector.inspect(baseline);
    if (after.repository.headCommit !== record.actualCommit || gitCommitSourceDigest(after) !== gitCommitSourceDigest(original)) {
      fail('task_commit_head_or_source_drift');
    }
    // The lifecycle transaction consumes only this operation's persisted, verified facts.
    atomic.transact('TaskCommit.workspace', tx => {
      authorize(tx);
      const changed = db.prepare(`UPDATE managed_workspaces SET head_commit = ?, code_digest = ?,
        revision = revision + 1, updated_at = ? WHERE project_id = ? AND canonical_path = ?
        AND EXISTS (SELECT 1 FROM workspace_leases l WHERE l.project_id = managed_workspaces.project_id
          AND l.resource_kind = 'workspace' AND l.owner_id = ? AND l.host_instance_id = ?
          AND l.execution_version = ? AND l.state = 'held' AND l.lease_until > ?)
        AND (head_commit IS NULL OR head_commit = ? OR head_commit = ?)`)
        .run(record.actualCommit, after.codeDigest, now(), identity.projectId, baseline.canonicalPath,
          identity.attemptId, identity.hostInstanceId, identity.executionVersion, now(), record.intent.expectedHead, record.actualCommit);
      if (changed.changes !== 1) {
        const current = db.prepare('SELECT head_commit, revision FROM managed_workspaces WHERE project_id = ? AND canonical_path = ?')
          .get(identity.projectId, baseline.canonicalPath);
        throw new StorageError('conflict', 'TaskCommit.workspace', 'task_commit_workspace_fenced', { details: {
          reason: 'task_commit_workspace_fenced', expectedHead: record.intent.expectedHead,
          actualCommit: record.actualCommit, current,
          leases: deps.resources.read(identity).leases.map(l => ({ state: l.state, expires: l.leaseUntilUtcMs, version: l.executionVersion })),
          now: now(),
        } });
      }
    });
    } finally { registration.complete(); }
  };
}
