import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCompletedReceipt } from '../../ports/commands.js';
import { createResultRef } from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { validateWorkResourceIdentity } from '../../ports/work-resources.js';
import type { WorkResourceAccess, WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { validateStableId } from '../../ports/validation.js';
import { validateWorkspaceCommit, validateWorkspaceBaseline } from '../../ports/workspace.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import type { WorkspacePreparationInput, WorkspacePreparationStore } from '../../ports/workspace-preparation.js';
import { createSqliteWorkspaceAccess } from './workspace.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteStateAccess, transactSqliteConsistentRead } from './state-store.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteAttemptLifecycleStore } from './attempt-lifecycle-store.js';
import { createSqlitePlanAccess } from './plan-store.js';
import type { SqliteStorageSession } from './session.js';

export function createSqliteWorkspacePreparationStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly nowUtcMs?: () => number;
}): WorkspacePreparationStore {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const attempts = createSqliteAttemptAccess(session), executions = createSqliteExecutionAccess(session, options);
  const state = createSqliteStateAccess(session), workspaces = createSqliteWorkspaceAccess(session, options);
  const artifacts = createSqlitePlanAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const lifecycle = createSqliteAttemptLifecycleStore(session, options);
  const fail = (reason: string): never => { throw new StorageError('conflict', 'Workspace.prepare', reason); };
  function authorize(input: WorkspacePreparationInput, live = true) {
    const identity = validateWorkResourceIdentity(input.identity);
    for (const key of ['claimKey', 'runId', 'taskId', 'operationId', 'workspaceId'] as const) validateStableId(input[key], { operation: 'Workspace.prepare' }, key);
    const attempt = attempts.getAttempt(identity.projectId, identity.attemptId);
    const snapshot = options.resources.read(identity);
    if (attempt.runId !== input.runId || attempt.taskId !== input.taskId) fail('claim_identity_mismatch');
    const claim = db.prepare<[string], { project_id: string; attempt_id: string; receipt: string }>('SELECT project_id, attempt_id, receipt FROM task_claim_receipts WHERE id = ?').get(input.claimKey);
    if (!claim || claim.project_id !== identity.projectId || claim.attempt_id !== attempt.id) fail('committed_claim_required');
    const receipt = JSON.parse(claim!.receipt) as { attempt: typeof attempt };
    if (!receipt.attempt || ['id', 'runId', 'taskId', 'owner', 'hostInstanceId', 'executionVersion'].some(key =>
      receipt.attempt[key as keyof typeof attempt] !== attempt[key as keyof typeof attempt])
      || !isDeepStrictEqual(receipt.attempt.inputSnapshot, attempt.inputSnapshot)) fail('claim_receipt_mismatch');
    if (live && (attempt.status !== 'preparing' || attempt.executionStage !== 'preflight'
      || attempt.invocationId !== null || attempt.startedAtUtcMs !== null || snapshot.leases.length !== 3
      || snapshot.leases.some(l => l.state !== 'held' || l.leaseUntilUtcMs <= now() || l.processIdentity !== null))) fail('attempt_not_live_preflight');
    const run = executions.getExecutionRunInTransaction(identity.projectId, input.runId);
    const batch = executions.getExecutionBatchInTransaction(identity.projectId, run.batchId);
    if (run.featureId !== attempt.featureId || batch.featureId !== attempt.featureId) fail('authorization_scope_mismatch');
    if (!db.prepare("SELECT id FROM command_receipts WHERE operation = 'execution.start' AND status = 'accepted' AND operation_id = ? AND project_id = ?").get(batch.id, identity.projectId)) fail('committed_authorization_required');
    if (live && (!['queued', 'running'].includes(run.status) || !['queued', 'running'].includes(batch.status)
      || state.getProject(identity.projectId).status !== 'active'
      || (db.prepare('SELECT manual_block FROM tasks WHERE id = ?').get(input.taskId) as { manual_block: number }).manual_block !== 0)) fail('execution_no_longer_authorized');
    const binding = state.getRepositoryBinding(identity.projectId);
    const baseline = run.inputSnapshot.workspaceBaseline as { repositoryBindingId?: unknown; repositoryBindingRevision?: unknown; baseCommit?: unknown } | undefined;
    if (!baseline || baseline.repositoryBindingId !== binding.id || baseline.repositoryBindingRevision !== binding.bindingRevision) fail('confirmed_baseline_or_current_binding_required');
    const baseCommit = validateWorkspaceCommit(baseline!.baseCommit);
    if (binding.gitCommonDir === null) fail('git_common_dir_required');
    return { binding, featureId: attempt.featureId, baseCommit };
  }
  function command(input: WorkspacePreparationInput, step: string, result: Record<string, unknown>) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId: input.operationId, principalId: 'core-workspace-' + step,
      operation: 'execution.start', scope: { kind: 'project', projectId: input.identity.projectId },
      requestDigest: createHash('sha256').update(stableStringify({ input, step, result })).digest('hex'),
      issuedAt: timestamp, completedAt: timestamp, result, resultRef: createResultRef(randomBytes(32)) });
  }
  return {
    readAuthorization(input) { return transactSqliteConsistentRead(session, 'Workspace.prepare.read', () => authorize(input)); },
    begin(input, rawBaseline) {
      const baseline = validateWorkspaceBaseline(rawBaseline);
      return session.transactWrite('Workspace.prepare.intent', () => {
        const auth = authorize(input);
        if (baseline.baseCommit !== auth.baseCommit || baseline.repositoryBindingId !== auth.binding.id
          || baseline.repositoryBindingRevision !== auth.binding.bindingRevision || baseline.repoIdentity !== auth.binding.repoIdentity
          || baseline.gitCommonDir !== auth.binding.gitCommonDir) fail('confirmed_baseline_mismatch');
        const workspaceKey = `workspace:${createHash('sha256').update(JSON.stringify([baseline.repoIdentity, baseline.canonicalPath])).digest('hex')}`;
        if (!options.resources.read(input.identity).leases.some(lease => lease.resourceKind === 'workspace' && lease.resourceKey === workspaceKey)) fail('claimed_workspace_mismatch');
        return workspaces.beginInTransaction({ operationId: input.operationId, workspaceId: input.workspaceId,
          featureId: auth.featureId, identity: input.identity, kind: 'prepare', executionStage: 'preflight',
          expectedWorkspaceRevision: null, baseline, receipt: command(input, 'intent', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId }) });
      });
    },
    finish(input, intent, outcome, evidenceRef) {
      return atomic.transact('Workspace.prepare.result', transaction => {
        authorize(input, !outcome.isolated);
        const evidence = artifacts.getArtifactInputRefInTransaction(input.identity.projectId, evidenceRef);
        if (!evidence) fail('ready_evidence_required');
        const success = outcome.inspection !== null && outcome.reason === null;
        const done = workspaces.finishInTransaction({ operationId: input.operationId, identity: input.identity,
          expectedRevision: intent.operation.revision, expectedWorkspaceRevision: intent.workspace.revision,
          status: success ? 'succeeded' : outcome.isolated ? 'blocked' : 'failed',
          workspaceStatus: success ? 'ready' : outcome.isolated ? 'quarantined' : 'retained',
          headCommit: outcome.inspection?.repository.headCommit ?? null, codeDigest: outcome.inspection?.codeDigest ?? null,
          result: { ...outcome.result, evidenceRefs: [evidenceRef], errorRef: success ? null : evidenceRef },
          receipt: command(input, 'result', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            prepared: success, isolated: outcome.isolated, reason: outcome.reason }) });
        if (!success) {
          const applied = lifecycle.applyPreparationFailureInTransaction(transaction, {
            ...input.identity, runId: input.runId, taskId: input.taskId, notificationId: input.operationId,
            kind: 'preparation_failed', errorKind: 'workspace', evidenceRef,
          }, outcome.isolated ? 'uncertain' : 'unstarted');
          if (applied.disposition !== 'applied') fail('attempt_preparation_failure_cas');
        }
        return done;
      });
    },
    quarantine(input) { session.transactWrite('Workspace.prepare.quarantine', () => options.resources.quarantineInTransaction(input.identity)); },
  };
}
