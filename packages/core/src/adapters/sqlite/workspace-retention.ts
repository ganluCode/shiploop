import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCompletedReceipt } from '../../ports/commands.js';
import { createResultRef } from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { validateWorkspaceBaseline } from '../../ports/workspace.js';
import { validateWorkspaceRetentionInput } from '../../ports/workspace-retention.js';
import type { WorkspaceRetentionInput, WorkspaceRetentionIntent, WorkspaceRetentionStore } from '../../ports/workspace-retention.js';
import type { WorkResourceAccess, WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { createSqliteWorkspaceAccess } from './workspace.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteAttemptLifecycleStore } from './attempt-lifecycle-store.js';
import type { SqliteStorageSession } from './session.js';

export function createSqliteWorkspaceRetentionStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly nowUtcMs?: () => number;
}): WorkspaceRetentionStore {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const workspaces = createSqliteWorkspaceAccess(session, { ...options, allowRetentionFinalization: true }), attempts = createSqliteAttemptAccess(session);
  const receipts = createSqliteCommandReceiptAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, options), lifecycle = createSqliteAttemptLifecycleStore(session, options);
  const fail = (reason: string): never => { throw new StorageError('conflict', 'Workspace.retain', reason); };
  function current(input: WorkspaceRetentionInput) {
    const resources = options.resources.read(input.identity);
    const attempt = attempts.getAttempt(input.identity.projectId, input.identity.attemptId);
    if (attempt.runId !== input.runId || attempt.taskId !== input.taskId) fail('attempt_scope_mismatch');
    const workspace = workspaces.readWorkspace(input.identity.projectId, attempt.featureId);
    if (!workspace || workspace.id !== input.workspaceId || workspace.status === 'cleaned') return fail('workspace_scope_mismatch');
    if (db.prepare('SELECT id FROM workspace_leases WHERE owner_id <> ? LIMIT 1').get(attempt.id)) fail('another_execution_occupies_resources');
    // Workspace initial identity is immutable; latest operation, not first owner, fences later Tasks.
    const writer = db.prepare(`SELECT attempt_id FROM state_events WHERE project_id = ? AND aggregate_id = ?
      AND event_type = 'workspace.operation_updated' ORDER BY sequence DESC LIMIT 1`).get(input.identity.projectId, attempt.featureId) as { attempt_id: string } | undefined;
    if (writer?.attempt_id !== attempt.id) fail('workspace_has_newer_writer');
    return { resources, attempt, workspace };
  }
  function preparationStopped(workspaceId: string, projectId: string): boolean {
    const processes = db.prepare(`SELECT command_id, result_json FROM command_receipts WHERE project_id = ?
      AND principal_id = 'core-workspace-process' AND json_extract(result_json, '$.workspaceId') = ?`)
      .all(projectId, workspaceId) as { command_id: string; result_json: string }[];
    return processes.every(row => {
      const stopped = receipts.findReceiptByCommandId('core-workspace-stop', row.command_id);
      const result = stopped?.status === 'completed' ? stopped.result as Record<string, unknown> : null;
      return stopped?.scope.kind === 'project' && stopped.scope.projectId === projectId && result?.workspaceId === workspaceId
        && isDeepStrictEqual(result.value, (JSON.parse(row.result_json) as { value: unknown }).value);
    });
  }
  function previouslyReleased(attemptId: string): boolean {
    // Absence of leases alone is not proof. Only the prior trusted lifecycle receipt may attest release.
    const rows = db.prepare('SELECT receipt FROM attempt_notifications WHERE attempt_id = ?').all(attemptId) as { receipt: string }[];
    return rows.some(row => {
      const receipt = JSON.parse(row.receipt) as { disposition?: string; resultSaved?: boolean; stopConfirmed?: boolean };
      return receipt.disposition === 'applied' && receipt.resultSaved === true && receipt.stopConfirmed === true;
    });
  }
  function command(input: WorkspaceRetentionInput, step: string, result: Record<string, unknown>) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId: input.operationId, principalId: 'core-workspace-retain-' + step,
      operation: 'execution.start', scope: { kind: 'project', projectId: input.identity.projectId },
      requestDigest: createHash('sha256').update(stableStringify({ input, step })).digest('hex'),
      issuedAt: timestamp, completedAt: timestamp, result, resultRef: createResultRef(randomBytes(32)) });
  }
  function assertIntent(input: WorkspaceRetentionInput, intent: WorkspaceRetentionIntent) {
    const value = current(input);
    const op = workspaces.readOperation(input.identity.projectId, input.operationId);
    if (!op || op.status !== 'pending' || op.revision !== intent.commit.operation.revision
      || !isDeepStrictEqual(op.identity, input.identity) || value.workspace.revision !== intent.commit.workspace.revision
      || value.attempt.revision !== intent.attemptRevision || !isDeepStrictEqual(value.resources, intent.resources)) fail('stale_retention_revision');
    return value;
  }
  return {
    begin(raw) {
      const input = validateWorkspaceRetentionInput(raw);
      return atomic.transact('Workspace.retain.intent', transaction => {
        const value = current(input);
        input.evidenceRefs.forEach(ref => transaction.getArtifactInputRef(input.identity.projectId, ref));
        const prior = workspaces.readOperation(input.identity.projectId, input.operationId);
        if (prior && (prior.kind !== 'retain' || !isDeepStrictEqual(prior.identity, input.identity)
          || prior.workspaceId !== input.workspaceId || prior.runId !== input.runId)) fail('retention_operation_identity_conflict');
        if (!prior && value.workspace.revision !== input.expectedWorkspaceRevision) fail('stale_workspace_revision');
        if (db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND status = 'pending' AND id <> ? LIMIT 1")
          .get(input.workspaceId, input.operationId)) fail('unfinished_workspace_operation');
        const released = value.resources.leases.length === 0 && previouslyReleased(value.attempt.id);
        if (value.resources.leases.length === 0 && !released && prior?.status !== 'succeeded') fail('missing_release_evidence');
        const baseline = validateWorkspaceBaseline({ repositoryBindingId: value.workspace.repositoryBindingId,
          repositoryBindingRevision: value.workspace.repositoryBindingRevision, repoIdentity: value.workspace.repoIdentity,
          canonicalPath: value.workspace.canonicalPath, gitCommonDir: value.workspace.gitCommonDir,
          branch: value.workspace.branch, baseCommit: value.workspace.baseCommit });
        const commit = workspaces.beginInTransaction({ operationId: input.operationId, workspaceId: input.workspaceId, featureId: value.attempt.featureId,
          kind: 'retain', identity: input.identity, executionStage: value.attempt.executionStage,
          expectedWorkspaceRevision: prior ? null : input.expectedWorkspaceRevision, baseline,
          receipt: command(input, 'intent', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            reason: input.reason, evidenceRefs: input.evidenceRefs }) });
        if (commit.operation.status !== 'pending') {
          const receipt = receipts.findReceiptByCommandId('core-workspace-retain-result', input.operationId);
          if (!receipt) fail('missing_retention_result_receipt');
          return { commit: { ...commit, receipt: receipt! }, resources: value.resources,
            attemptRevision: value.attempt.revision, preparationStopped: false, unstarted: false, previouslyReleased: released };
        }
        const prepStopped = preparationStopped(input.workspaceId, input.identity.projectId);
        return { commit, resources: value.resources, attemptRevision: value.attempt.revision, preparationStopped: prepStopped,
          unstarted: prepStopped && value.attempt.invocationId === null && value.attempt.startedAtUtcMs === null
            && value.attempt.executionStage === 'preflight' && value.resources.leases.length === 3
            && value.resources.leases.every(l => l.processIdentity === null), previouslyReleased: released };
      });
    },
    finish(input, intent, stop, evidenceRef, stopToken) {
      return atomic.transact('Workspace.retain.result', transaction => {
        const value = assertIntent(input, intent);
        transaction.getArtifactInputRef(input.identity.projectId, evidenceRef);
        if (!['not_started', 'confirmed', 'unknown'].includes(stop)
          || (stop === 'not_started' && !intent.unstarted)
          || (stop === 'confirmed' && (!intent.preparationStopped || (!intent.previouslyReleased && !stopToken)))) fail('unverified_retention_stop');
        const isolated = stop === 'unknown';
        const reusable = !isolated && value.attempt.endedAtUtcMs !== null
          && ['failed', 'cancelled', 'interrupted', 'succeeded'].includes(value.attempt.status);
        const done = workspaces.finishInTransaction({ operationId: input.operationId, identity: input.identity,
          expectedRevision: intent.commit.operation.revision, expectedWorkspaceRevision: intent.commit.workspace.revision,
          status: isolated ? 'blocked' : 'succeeded', workspaceStatus: isolated ? 'quarantined' : 'retained',
          headCommit: value.workspace.headCommit, codeDigest: value.workspace.codeDigest,
          result: { evidenceRefs: [...input.evidenceRefs, evidenceRef], errorRef: evidenceRef,
            startedAtUtcMs: null, endedAtUtcMs: now(), durationMs: null, exitCode: null, signal: null },
          receipt: command(input, 'result', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            reason: input.reason, stop, reusable, isolated, evidenceRef }) });
        lifecycle.recordWorkspaceRetentionInTransaction(transaction, input.identity, intent.attemptRevision, evidenceRef);
        // The outcome and Attempt CAS are durable in the same commit as releasing this exact resource group.
        if (isolated) options.resources.quarantineInTransaction(input.identity);
        else if (!intent.previouslyReleased) {
          if (stop === 'not_started') options.resources.releaseUnstartedInTransaction(input.identity);
          else options.resources.releaseStoppedInTransaction(input.identity, stopToken);
        }
        return done;
      });
    },
    quarantine(input, intent) {
      session.transactWrite('Workspace.retain.quarantine', () => {
        try { assertIntent(input, intent); }
        catch (error) { if (error instanceof StorageError && ['ownership', 'conflict'].includes(error.kind)) return; throw error; }
        if (options.resources.read(input.identity).leases.length) options.resources.quarantineInTransaction(input.identity);
      });
    },
  };
}
