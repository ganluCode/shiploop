import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCompletedReceipt } from '../../ports/commands.js';
import { createResultRef } from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { validateWorkProcessIdentity, validateWorkResourceIdentity } from '../../ports/work-resources.js';
import type { WorkResourceAccess, WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { validateStableId } from '../../ports/validation.js';
import { validateWorkspaceCommit, validateWorkspaceBaseline } from '../../ports/workspace.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import type { WorkspacePreparationInput, WorkspacePreparationStore, PreparationDirectoryIdentity } from '../../ports/workspace-preparation.js';
import type { WorkspaceOperationCommit } from '../../ports/workspace.js';
import type { CommandProcessIdentity } from '../../ports/command-process.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
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
  /** F-004：校验 Run 快照中的基线来自已通过集成计划；不得回退到 branch HEAD。 */
  readonly integrationBaselineGate?: (input: { readonly projectId: string; readonly featureId: string; readonly baseCommit: string }) => void;
  readonly nowUtcMs?: () => number;
}): WorkspacePreparationStore {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const attempts = createSqliteAttemptAccess(session), executions = createSqliteExecutionAccess(session, options);
  const state = createSqliteStateAccess(session), workspaces = createSqliteWorkspaceAccess(session, options);
  const artifacts = createSqlitePlanAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const lifecycle = createSqliteAttemptLifecycleStore(session, options);
  const receipts = createSqliteCommandReceiptAccess(session);
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
      || snapshot.leases.some(l => !['held', 'quarantined'].includes(l.state) || l.leaseUntilUtcMs <= now() || l.processIdentity !== null))) fail('attempt_not_live_preflight');
    const run = executions.getExecutionRunInTransaction(identity.projectId, input.runId);
    const batch = executions.getExecutionBatchInTransaction(identity.projectId, run.batchId);
    if (run.featureId !== attempt.featureId || batch.featureId !== attempt.featureId) fail('authorization_scope_mismatch');
    if (!db.prepare("SELECT id FROM command_receipts WHERE operation = 'execution.start' AND status = 'accepted' AND operation_id = ? AND project_id = ?").get(batch.id, identity.projectId)) fail('committed_authorization_required');
    if (live && (!['queued', 'running'].includes(run.status) || !['queued', 'running'].includes(batch.status)
      || state.getProject(identity.projectId).status !== 'active'
      || (db.prepare('SELECT status, manual_block FROM tasks WHERE id = ?').get(input.taskId) as { status: string; manual_block: number }).manual_block !== 0
      || (db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as { status: string }).status !== 'running')) fail('execution_no_longer_authorized');
    const binding = state.getRepositoryBinding(identity.projectId);
    const baseline = run.inputSnapshot.workspaceBaseline as { repositoryBindingId?: unknown; repositoryBindingRevision?: unknown; baseCommit?: unknown } | undefined;
    if (!baseline || baseline.repositoryBindingId !== binding.id || baseline.repositoryBindingRevision !== binding.bindingRevision) fail('confirmed_baseline_or_current_binding_required');
    const baseCommit = validateWorkspaceCommit(baseline!.baseCommit);
    options.integrationBaselineGate?.({ projectId: identity.projectId, featureId: attempt.featureId, baseCommit });
    if (binding.gitCommonDir === null) fail('git_common_dir_required');
    return { binding, featureId: attempt.featureId, baseCommit };
  }
  function command(input: WorkspacePreparationInput, step: string, result: Record<string, unknown>, commandId = input.operationId) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId, principalId: 'core-workspace-' + step,
      operation: 'execution.start', scope: { kind: 'project', projectId: input.identity.projectId },
      requestDigest: createHash('sha256').update(stableStringify({ input, step, result })).digest('hex'),
      issuedAt: timestamp, completedAt: timestamp, result, resultRef: createResultRef(randomBytes(32)) });
  }
  function assertCurrent(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit) {
    authorize(input);
    const ws = workspaces.readWorkspace(input.identity.projectId, intent.workspace.featureId);
    const op = workspaces.readOperation(input.identity.projectId, input.operationId);
    if (!ws || !op || ws.id !== input.workspaceId || ws.revision !== intent.workspace.revision
      || op.revision !== intent.operation.revision || !isDeepStrictEqual(op.identity, input.identity)
      || !isDeepStrictEqual(op.inputSnapshot, intent.operation.inputSnapshot)) fail('stale_preparation_revision');
  }
  function directory(value: unknown): PreparationDirectoryIdentity {
    const raw = value as PreparationDirectoryIdentity;
    if (!raw || Object.keys(raw).length !== 3
      || [raw.device, raw.inode, raw.birthtimeNs].some(v => typeof v !== 'string' || !/^\d{1,30}$/.test(v))) fail('invalid_directory_identity');
    return { device: raw.device, inode: raw.inode, birthtimeNs: raw.birthtimeNs };
  }
  function journal(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit) {
    assertCurrent(input, intent);
    const recorded = receipts.findReceiptByCommandId('core-workspace-directory', intent.workspace.preparationOperationId);
    let directoryIdentity: PreparationDirectoryIdentity | null = null;
    if (recorded) {
      const result = recorded.status === 'completed' ? recorded.result as Record<string, unknown> : null;
      if (recorded.scope.kind !== 'project' || recorded.scope.projectId !== input.identity.projectId
        || !result || result.workspaceId !== input.workspaceId) fail('directory_checkpoint_scope_mismatch');
      directoryIdentity = directory(result!.value);
    }
    const rows = db.prepare(`SELECT command_id, result_json FROM command_receipts WHERE principal_id = 'core-workspace-process'
      AND project_id = ? AND json_extract(result_json, '$.workspaceId') = ?`).all(input.identity.projectId, input.workspaceId) as { command_id: string; result_json: string }[];
    const unfinishedProcesses: CommandProcessIdentity[] = [];
    for (const row of rows) {
      const process = validateWorkProcessIdentity((JSON.parse(row.result_json) as { value: unknown }).value);
      const stopped = receipts.findReceiptByCommandId('core-workspace-stop', row.command_id);
      if (!stopped) unfinishedProcesses.push(process);
      else {
        const result = stopped.status === 'completed' ? stopped.result as Record<string, unknown> : null;
        if (!result || result.workspaceId !== input.workspaceId || !isDeepStrictEqual(result.value, process)) fail('stop_checkpoint_mismatch');
      }
    }
    return { directoryIdentity, expectedHead: intent.workspace.headCommit ?? intent.workspace.baseCommit, unfinishedProcesses };
  }
  function currentCommit(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit): WorkspaceOperationCommit {
    const op = workspaces.readOperation(input.identity.projectId, input.operationId)!;
    const row = db.prepare('SELECT principal_id, command_id FROM command_receipts WHERE id = (SELECT receipt_id FROM workspace_operations WHERE id = ?)')
      .get(input.operationId) as { principal_id: string; command_id: string };
    return { workspace: workspaces.readWorkspace(input.identity.projectId, intent.workspace.featureId)!, operation: op,
      receipt: receipts.findReceiptByCommandId(row.principal_id, row.command_id)!, replay: true };
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
        const existing = workspaces.readWorkspace(input.identity.projectId, auth.featureId);
        const prior = workspaces.readOperation(input.identity.projectId, input.operationId);
        if (existing && existing.id !== input.workspaceId) fail('managed_workspace_identity_mismatch');
        if (existing && db.prepare(`SELECT a.id FROM attempts a JOIN workspace_operations o ON o.attempt_id = a.id
          WHERE o.project_id = ? AND o.workspace_id = ? AND a.id <> ?
            AND (a.status NOT IN ('failed', 'cancelled', 'interrupted', 'succeeded') OR a.ended_at IS NULL
              OR EXISTS (SELECT 1 FROM workspace_leases l WHERE l.owner_id = a.id)) LIMIT 1`)
          .get(input.identity.projectId, input.workspaceId, input.identity.attemptId)) fail('previous_writer_not_finalized');
        if (existing && !prior && db.prepare("SELECT id FROM workspace_operations WHERE project_id = ? AND feature_id = ? AND status = 'pending' LIMIT 1")
          .get(input.identity.projectId, auth.featureId)) fail('unfinished_preparation_requires_original_operation');
        return workspaces.beginInTransaction({ operationId: input.operationId, workspaceId: input.workspaceId,
          featureId: auth.featureId, identity: input.identity, kind: 'prepare', executionStage: 'preflight',
          expectedWorkspaceRevision: prior ? null : existing?.revision ?? null, baseline,
          receipt: command(input, 'intent', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId }) });
      });
    },
    assertCurrent(input, intent) { transactSqliteConsistentRead(session, 'Workspace.prepare.check', () => assertCurrent(input, intent)); },
    readJournal(input, intent) { return transactSqliteConsistentRead(session, 'Workspace.prepare.journal', () => journal(input, intent)); },
    recordCheckpoint(input, intent, kind, rawValue) {
      session.transactWrite('Workspace.prepare.checkpoint', () => {
        assertCurrent(input, intent);
        if (intent.operation.status !== 'pending') fail('checkpoint_requires_pending_operation');
        const value = kind === 'directory' ? directory(rawValue) : validateWorkProcessIdentity(rawValue);
        const id = kind === 'directory' ? intent.workspace.preparationOperationId : (value as CommandProcessIdentity).launchId;
        const receipt = command(input, kind, { workspaceOperationId: input.operationId, workspaceId: input.workspaceId, value }, id);
        const old = receipts.findReceiptByCommandId(receipt.principalId, id);
        if (old) {
          if (old.requestDigest !== receipt.requestDigest) fail('checkpoint_identity_conflict');
          return;
        }
        if (kind === 'stop' && !receipts.findReceiptByCommandId('core-workspace-process', id)) fail('process_checkpoint_required');
        receipts.saveReceiptInTransaction(receipt);
      });
    },
    finish(input, intent, outcome, evidenceRef) {
      return atomic.transact('Workspace.prepare.result', transaction => {
        authorize(input, !outcome.isolated);
        assertCurrent(input, intent);
        const evidence = artifacts.getArtifactInputRefInTransaction(input.identity.projectId, evidenceRef);
        if (!evidence) fail('ready_evidence_required');
        const success = outcome.inspection !== null && outcome.reason === null;
        if (success) {
          const checkpoint = journal(input, intent);
          if (checkpoint.unfinishedProcesses.length || !checkpoint.directoryIdentity
            || outcome.inspection!.repository.headCommit !== checkpoint.expectedHead) fail('preparation_evidence_mismatch');
          // Only a complete, stopped observation can lift preflight persistence quarantine.
          db.prepare("UPDATE workspace_leases SET state = 'held', revision = revision + 1, updated_at = ? WHERE owner_id = ? AND host_instance_id = ? AND execution_version = ? AND state = 'quarantined'")
            .run(now(), input.identity.attemptId, input.identity.hostInstanceId, input.identity.executionVersion);
        }
        if (intent.operation.status === 'succeeded') {
          if (!success) fail('replay_inspection_failed');
          const changed = db.prepare('UPDATE managed_workspaces SET code_digest = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
            .run(outcome.inspection!.codeDigest, now(), input.workspaceId, intent.workspace.revision);
          if (changed.changes !== 1) fail('stale_preparation_revision');
          receipts.saveReceiptInTransaction(command(input, 'reuse', { workspaceOperationId: input.operationId,
            workspaceId: input.workspaceId, attemptId: input.identity.attemptId, evidenceRef, codeDigest: outcome.inspection!.codeDigest }, randomUUID()));
          return currentCommit(input, intent);
        }
        if (intent.operation.status !== 'pending') fail('terminal_preparation_not_recoverable');
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
    quarantine(input, intent) {
      session.transactWrite('Workspace.prepare.quarantine', () => {
        const op = workspaces.readOperation(input.identity.projectId, input.operationId);
        if (!op) return;
        const ws = workspaces.readWorkspace(input.identity.projectId, op.featureId);
        if (!ws || ws.id !== input.workspaceId || (intent && (ws.revision !== intent.workspace.revision || op.revision !== intent.operation.revision))
          || !isDeepStrictEqual(op.identity, input.identity)) return;
        try { options.resources.read(input.identity); }
        catch (error) { if (error instanceof StorageError && error.kind === 'ownership') return; throw error; }
        options.resources.quarantineInTransaction(input.identity);
      });
    },
  };
}
