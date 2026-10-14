/**
 * F-009 工作区清理 operation 的 SQLite 存储适配器。
 *
 * 边界：
 * - 复用既有 workspace_operations/managed_workspaces、命令回执、Artifact 引用
 *   与三组资源租约；不创建平行占用体系，不修改 Task/Attempt/Feature 业务结论；
 * - 新 operation 登记时运行全门槛（F-008 cleanable 决策新鲜度、Attempt 安全成功、
 *   可信停止+释放证据、占用为空、审批仍然有效、任务未人工阻塞）；pending 恢复
 *   只做 fencing，授权门槛在删除前由 recheckAuthorization 重核；
 * - 删除后补写（recovered）与正常完成共用 finish 的 revision CAS；旧结果不能
 *   覆盖新 operation，迟到写入被 fencing 拒绝；
 * - Git/文件 I/O 不在本层事务内；本层只持久化意图、检查点、结果与审计事件。
 */
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCompletedReceipt } from '../../ports/commands.js';
import { createResultRef } from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { validateWorkProcessIdentity, validateWorkResourceIdentity } from '../../ports/work-resources.js';
import type { WorkResourceAccess } from '../../ports/work-resources.js';
import { validateStableId } from '../../ports/validation.js';
import { validateWorkspaceBaseline, validateWorkspaceCommit } from '../../ports/workspace.js';
import type { WorkspaceBaseline, WorkspaceOperationCommit } from '../../ports/workspace.js';
import { validateWorkspaceCleanerInput, validateWorkspaceCleanerVerified } from '../../ports/workspace-cleaner.js';
import type { WorkspaceCleanerInput, WorkspaceCleanerIntent, WorkspaceCleanerJournal,
  WorkspaceCleanerOutcome, WorkspaceCleanerStore } from '../../ports/workspace-cleaner.js';
import { validateSha256Digest } from '../../ports/validation.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import type { CommandProcessIdentity } from '../../ports/command-process.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import { createSqliteWorkspaceAccess } from './workspace.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteStateAccess, transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const DEFAULT_MAX_DECISION_AGE_MS = 120_000;

export function createSqliteWorkspaceCleanerStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly nowUtcMs?: () => number;
  /** Maximum age of the F-008 cleanable decision; older or future decisions are refused. */
  readonly maxDecisionAgeMs?: number;
}): WorkspaceCleanerStore {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const maxDecisionAgeMs = options.maxDecisionAgeMs ?? DEFAULT_MAX_DECISION_AGE_MS;
  if (!Number.isSafeInteger(maxDecisionAgeMs) || maxDecisionAgeMs < 1) {
    throw new StorageError('validation', 'Workspace.clean', 'Invalid decision age bound');
  }
  const workspaces = createSqliteWorkspaceAccess(session, { resources: options.resources, nowUtcMs: options.nowUtcMs, allowCleanupFinalization: true });
  const attempts = createSqliteAttemptAccess(session);
  const receipts = createSqliteCommandReceiptAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const state = createSqliteStateAccess(session);
  const fail = (reason: string): never => { throw new StorageError('conflict', 'Workspace.clean', reason); };

  function current(input: WorkspaceCleanerInput) {
    const identity = validateWorkResourceIdentity(input.identity);
    const resources = options.resources.read(identity);
    const attempt = attempts.getAttempt(identity.projectId, identity.attemptId);
    if (attempt.runId !== input.runId || attempt.taskId !== input.taskId) fail('attempt_scope_mismatch');
    const workspace = workspaces.readWorkspace(identity.projectId, attempt.featureId);
    if (!workspace || workspace.id !== input.workspaceId) return fail('workspace_scope_mismatch');
    const managedWorkspace = workspace;
    if (db.prepare('SELECT id FROM workspace_leases WHERE owner_id <> ? LIMIT 1').get(attempt.id)) fail('another_execution_occupies_resources');
    // Workspace initial identity is immutable; the latest operation, not the first owner, fences later writers.
    const writer = db.prepare(`SELECT attempt_id FROM state_events WHERE project_id = ? AND aggregate_id = ?
      AND event_type = 'workspace.operation_updated' ORDER BY sequence DESC LIMIT 1`)
      .get(identity.projectId, attempt.featureId) as { attempt_id: string } | undefined;
    if (writer?.attempt_id !== attempt.id) fail('workspace_has_newer_writer');
    return { resources, attempt, workspace: managedWorkspace };
  }

  /** Durable lifecycle proof that the Runtime result was saved with a confirmed stop and released occupancy. */
  function previouslyReleased(attemptId: string): boolean {
    const rows = db.prepare('SELECT receipt FROM attempt_notifications WHERE attempt_id = ?').all(attemptId) as { receipt: string }[];
    return rows.some(row => {
      const receipt = JSON.parse(row.receipt) as { disposition?: string; resultSaved?: boolean; stopConfirmed?: boolean };
      return receipt.disposition === 'applied' && receipt.resultSaved === true && receipt.stopConfirmed === true;
    });
  }

  function gates(transaction: CommandTransaction, input: WorkspaceCleanerInput, value: ReturnType<typeof current>): string | null {
    const decision = input.decision;
    if (decision.outcome !== 'cleanable' || decision.gates.some(g => g.status !== 'passed')) return 'decision_not_cleanable';
    const timestamp = now();
    if (decision.checkedAtUtcMs > timestamp || timestamp - decision.checkedAtUtcMs > maxDecisionAgeMs) return 'decision_expired';
    if (!['verifying', 'succeeded'].includes(value.attempt.status) || value.attempt.endedAtUtcMs === null
      || value.attempt.exitCode !== 0) return 'execution_not_succeeded';
    if (!previouslyReleased(value.attempt.id)) return 'release_evidence_missing';
    if (value.resources.leases.length !== 0) return 'occupancy_active';
    const approval = verifyFeaturePlanApprovalInTransaction(transaction, input.identity.projectId, value.attempt.featureId);
    if (!approval.validity.valid) return 'approval_changed';
    const task = db.prepare<[string], { manual_block: number }>('SELECT manual_block FROM tasks WHERE id = ?').get(input.taskId);
    if (!task || task.manual_block !== 0) return 'approval_changed';
    return null;
  }

  function command(input: WorkspaceCleanerInput, step: string, result: Record<string, unknown>, commandId = input.operationId) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId, principalId: 'core-workspace-clean-' + step,
      operation: 'execution.start', scope: { kind: 'project', projectId: input.identity.projectId },
      requestDigest: createHash('sha256').update(stableStringify({ input, step, result })).digest('hex'),
      issuedAt: timestamp, completedAt: timestamp, result, resultRef: createResultRef(randomBytes(32)) });
  }

  function assertFencing(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent) {
    const value = current(input);
    const op = workspaces.readOperation(input.identity.projectId, input.operationId);
    if (!op || op.status !== 'pending' || op.revision !== intent.commit.operation.revision
      || !isDeepStrictEqual(op.identity, input.identity) || value.workspace.revision !== intent.commit.workspace.revision
      || !isDeepStrictEqual(op.inputSnapshot, intent.commit.operation.inputSnapshot)) fail('stale_cleaner_revision');
    return value;
  }

  function baselineOf(workspace: WorkspaceCleanerIntent['commit']['workspace']): WorkspaceBaseline {
    return validateWorkspaceBaseline({ repositoryBindingId: workspace.repositoryBindingId,
      repositoryBindingRevision: workspace.repositoryBindingRevision, repoIdentity: workspace.repoIdentity,
      canonicalPath: workspace.canonicalPath, gitCommonDir: workspace.gitCommonDir,
      branch: workspace.branch, baseCommit: workspace.baseCommit });
  }

  return {
    begin(raw) {
      const input = validateWorkspaceCleanerInput(raw);
      return atomic.transact('Workspace.clean.intent', transaction => {
        const value = current(input);
        input.evidenceRefs.forEach(ref => transaction.getArtifactInputRef(input.identity.projectId, ref));
        const prior = workspaces.readOperation(input.identity.projectId, input.operationId);
        if (prior && (prior.kind !== 'cleanup' || !isDeepStrictEqual(prior.identity, input.identity)
          || prior.workspaceId !== input.workspaceId || prior.runId !== input.runId)) fail('cleaner_operation_identity_conflict');
        const baseline = baselineOf(value.workspace);
        const binding = state.getRepositoryBinding(input.identity.projectId);
        if (!prior) {
          // A new cleanup intent runs the full gate set; recovery of a pending intent re-runs
          // them via recheckAuthorization immediately before any deletion.
          if (!['ready', 'retained'].includes(value.workspace.status)) fail('workspace_not_cleanable');
          const refusal = gates(transaction, input, value);
          if (refusal) fail(refusal);
          if (value.workspace.revision !== input.expectedWorkspaceRevision) fail('stale_workspace_revision');
          if (db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND status = 'pending' AND id <> ? LIMIT 1")
            .get(input.workspaceId, input.operationId)) fail('unfinished_workspace_operation');
        }
        const commit = workspaces.beginInTransaction({ operationId: input.operationId, workspaceId: input.workspaceId,
          featureId: value.attempt.featureId, kind: 'cleanup', identity: input.identity, executionStage: value.attempt.executionStage,
          expectedWorkspaceRevision: prior ? null : input.expectedWorkspaceRevision, baseline,
          receipt: command(input, 'intent', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            expectedHeadCommit: input.expected.headCommit, evidenceRefs: input.evidenceRefs }) });
        if (commit.operation.status !== 'pending') {
          const receipt = receipts.findReceiptByCommandId('core-workspace-clean-result', input.operationId);
          if (!receipt) fail('missing_cleaner_result_receipt');
          return { commit: { ...commit, receipt: receipt! }, binding, baseline, priorStatus: value.workspace.status };
        }
        return { commit, binding, baseline, priorStatus: value.workspace.status };
      });
    },
    assertCurrent(input, intent) {
      transactSqliteConsistentRead(session, 'Workspace.clean.check', () => assertFencing(input, intent));
    },
    recheckAuthorization(input, intent) {
      return atomic.transact('Workspace.clean.authorize', transaction => gates(transaction, input, assertFencing(input, intent)));
    },
    readJournal(input, intent): WorkspaceCleanerJournal {
      return transactSqliteConsistentRead(session, 'Workspace.clean.journal', () => {
        assertFencing(input, intent);
        const recorded = receipts.findReceiptByCommandId('core-workspace-clean-verified', input.operationId);
        let verified: WorkspaceCleanerJournal['verified'] = null;
        if (recorded) {
          const result = recorded.status === 'completed' ? recorded.result as Record<string, unknown> : null;
          if (recorded.scope.kind !== 'project' || recorded.scope.projectId !== input.identity.projectId
            || !result || result.workspaceId !== input.workspaceId) fail('verified_checkpoint_scope_mismatch');
          verified = validateWorkspaceCleanerVerified(result!.value);
        }
        const rows = db.prepare(`SELECT command_id, result_json FROM command_receipts WHERE principal_id = 'core-workspace-clean-process'
          AND project_id = ? AND json_extract(result_json, '$.workspaceId') = ?`)
          .all(input.identity.projectId, input.workspaceId) as { command_id: string; result_json: string }[];
        const unfinishedProcesses: CommandProcessIdentity[] = [];
        for (const row of rows) {
          const process = validateWorkProcessIdentity((JSON.parse(row.result_json) as { value: unknown }).value);
          const stopped = receipts.findReceiptByCommandId('core-workspace-clean-stop', row.command_id);
          if (!stopped) unfinishedProcesses.push(process);
          else {
            const result = stopped.status === 'completed' ? stopped.result as Record<string, unknown> : null;
            if (!result || result.workspaceId !== input.workspaceId || !isDeepStrictEqual(result.value, process)) fail('stop_checkpoint_mismatch');
          }
        }
        return { verified, unfinishedProcesses };
      });
    },
    recordCheckpoint(rawInput, intent, kind, rawValue) {
      const input = validateWorkspaceCleanerInput(rawInput);
      session.transactWrite('Workspace.clean.checkpoint', () => {
        assertFencing(input, intent);
        const value = kind === 'verified' ? validateWorkspaceCleanerVerified(rawValue) : validateWorkProcessIdentity(rawValue);
        const id = kind === 'verified' ? input.operationId : (value as CommandProcessIdentity).launchId;
        const receipt = command(input, kind, { workspaceOperationId: input.operationId, workspaceId: input.workspaceId, value }, id);
        const old = receipts.findReceiptByCommandId(receipt.principalId, id);
        if (old) {
          if (old.requestDigest !== receipt.requestDigest) fail('checkpoint_identity_conflict');
          return;
        }
        if (kind === 'stop' && !receipts.findReceiptByCommandId('core-workspace-clean-process', id)) fail('process_checkpoint_required');
        receipts.saveReceiptInTransaction(receipt);
      });
    },
    finish(rawInput, intent, outcome, evidenceRef) {
      const input = validateWorkspaceCleanerInput(rawInput);
      return atomic.transact('Workspace.clean.result', transaction => {
        assertFencing(input, intent);
        transaction.getArtifactInputRef(input.identity.projectId, evidenceRef);
        if (typeof outcome.removed !== 'boolean' || typeof outcome.recovered !== 'boolean' || typeof outcome.isolated !== 'boolean'
          || (outcome.removed && (outcome.isolated || outcome.reason !== null))
          || (!outcome.removed && !outcome.isolated && (typeof outcome.reason !== 'string' || !/^[a-z_]+$/.test(outcome.reason)))
          || (outcome.recovered && !outcome.removed)) fail('invalid_cleanup_outcome');
        if (outcome.removed) {
          validateWorkspaceCommit(outcome.removedHeadCommit);
          validateSha256Digest(outcome.removedCodeDigest, { operation: 'Workspace.clean' }, 'removedCodeDigest');
        }
        const done = workspaces.finishInTransaction({ operationId: input.operationId, identity: input.identity,
          expectedRevision: intent.commit.operation.revision, expectedWorkspaceRevision: intent.commit.workspace.revision,
          status: outcome.removed ? 'succeeded' : outcome.isolated ? 'blocked' : 'failed',
          workspaceStatus: outcome.removed ? 'cleaned' : outcome.isolated ? 'quarantined' : intent.priorStatus,
          headCommit: outcome.removed ? outcome.removedHeadCommit : intent.commit.workspace.headCommit,
          codeDigest: outcome.removed ? outcome.removedCodeDigest : intent.commit.workspace.codeDigest,
          result: { ...outcome.result, evidenceRefs: [...input.evidenceRefs, evidenceRef], errorRef: outcome.removed ? null : evidenceRef },
          receipt: command(input, 'result', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            removed: outcome.removed, recovered: outcome.recovered, reason: outcome.reason, isolated: outcome.isolated, evidenceRef }) });
        if (outcome.isolated && options.resources.read(input.identity).leases.length) options.resources.quarantineInTransaction(input.identity);
        return done;
      });
    },
    quarantine(rawInput, intent) {
      const input = validateWorkspaceCleanerInput(rawInput);
      session.transactWrite('Workspace.clean.quarantine', () => {
        const op = workspaces.readOperation(input.identity.projectId, input.operationId);
        if (!op) return;
        if (intent) {
          try { assertFencing(input, intent); }
          catch (error) { if (error instanceof StorageError && ['ownership', 'conflict'].includes(error.kind)) return; throw error; }
        }
        try {
          if (options.resources.read(input.identity).leases.length) options.resources.quarantineInTransaction(input.identity);
        } catch (error) { if (error instanceof StorageError && error.kind === 'ownership') return; throw error; }
      });
    },
  };
}
