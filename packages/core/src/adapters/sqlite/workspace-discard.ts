/**
 * F-010 人工丢弃 preview/confirm 的 SQLite 存储适配器。
 *
 * 边界：
 * - 复用既有 workspace_operations/managed_workspaces、命令回执、Artifact 引用
 *   与三组资源租约；operation kind='discard'（迁移 v19）与 F-009 自动清理
 *   （kind='cleanup'）在审计层可区分，两套授权互不通用；
 * - 确认意图登记（begin）在短事务内完成：previewDigest 重算绑定（workspaceId/
 *   branch/revision/HEAD/内容摘要/有效期）、预览有效期、workspace 状态
 *   （ready/retained）、占用为空、停止证据与未完成 operation 检查；拒绝在任何
 *   写入之前抛出，零业务副作用；
 * - 停止证据只接受持久事实：可信生命周期回执（previouslyReleased）、已成功的
 *   retain operation，或「从未启动 + 准备进程整组已确认停止」；
 * - 目标 Attempt 身份派生自该 Feature 最新 workspace 写入者（state_events），
 *   不是调用方自报；pending 恢复只做 fencing，门禁在删除前由
 *   recheckAuthorization 重核；
 * - 用户回执（真实 principalId + commandId）是 operation 的幂等锚点；内部
 *   检查点/结果回执使用 core-workspace-discard-* 主体，不冒充用户命令；
 * - Git/文件 I/O 不在本层事务内；本层只持久化意图、检查点、结果与审计事件。
 */
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCompletedReceipt } from '../../ports/commands.js';
import { createResultRef } from '../../ports/command-receipts.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { computeWorkspaceDiscardRequestDigest } from '../../ports/workspace-discard.js';
import { validateWorkProcessIdentity, validateWorkResourceIdentity } from '../../ports/work-resources.js';
import type { WorkResourceAccess, WorkResourceIdentity } from '../../ports/work-resources.js';
import { validateSha256Digest, validateStableId } from '../../ports/validation.js';
import { validateWorkspaceBaseline, validateWorkspaceCommit } from '../../ports/workspace.js';
import type { ManagedWorkspaceRecord, WorkspaceBaseline, WorkspaceOperationCommit } from '../../ports/workspace.js';
import { validateWorkspaceCleanerVerified } from '../../ports/workspace-cleaner.js';
import type { WorkspaceCleanerVerified } from '../../ports/workspace-cleaner.js';
import {
  computeWorkspaceDiscardPreviewDigest, validateWorkspaceDiscardInput, WORKSPACE_DISCARD_OPERATION,
} from '../../ports/workspace-discard.js';
import type { WorkspaceDiscardBlocker, WorkspaceDiscardInput, WorkspaceDiscardIntent, WorkspaceDiscardJournal,
  WorkspaceDiscardOutcome, WorkspaceDiscardPreviewStore, WorkspaceDiscardPreviewTarget, WorkspaceDiscardStore } from '../../ports/workspace-discard.js';
import type { CommandProcessIdentity } from '../../ports/command-process.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { AttemptRecord } from '../../ports/attempt-store.js';
import { createSqliteWorkspaceAccess } from './workspace.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteStateAccess, transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

interface DiscardContext {
  readonly identity: WorkResourceIdentity;
  readonly attempt: AttemptRecord;
  readonly workspace: ManagedWorkspaceRecord;
  readonly resources: ReturnType<WorkResourceAccess['read']>;
}

export function createSqliteWorkspaceDiscardStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly nowUtcMs?: () => number;
}): WorkspaceDiscardStore {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const workspaces = createSqliteWorkspaceAccess(session, { resources: options.resources, nowUtcMs: options.nowUtcMs, allowDiscardFinalization: true });
  const attempts = createSqliteAttemptAccess(session);
  const receipts = createSqliteCommandReceiptAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const state = createSqliteStateAccess(session);
  const fail = (reason: string): never => { throw new StorageError('conflict', 'Workspace.discard', reason); };

  /** 目标身份 = 该 Feature 最新 workspace 写入者（回退到登记的准备 Attempt）。 */
  function deriveAttemptId(projectId: string, featureId: string, workspace: ManagedWorkspaceRecord): string {
    const writer = db.prepare(`SELECT attempt_id FROM state_events WHERE project_id = ? AND aggregate_id = ?
      AND event_type = 'workspace.operation_updated' ORDER BY sequence DESC LIMIT 1`)
      .get(projectId, featureId) as { attempt_id: string } | undefined;
    return writer?.attempt_id ?? workspace.attemptId;
  }

  function current(projectId: string, featureId: string, workspaceId: string): DiscardContext {
    const workspace = workspaces.readWorkspace(projectId, featureId);
    if (!workspace || workspace.id !== workspaceId) return fail('workspace_scope_mismatch');
    const attempt = attempts.getAttempt(projectId, deriveAttemptId(projectId, featureId, workspace));
    const identity = validateWorkResourceIdentity({ projectId, attemptId: attempt.id, owner: attempt.owner,
      hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion });
    if (db.prepare('SELECT id FROM workspace_leases WHERE owner_id <> ? LIMIT 1').get(attempt.id)) fail('another_execution_occupies_resources');
    return { identity, attempt, workspace, resources: options.resources.read(identity) };
  }

  /** Durable lifecycle proof that the Runtime result was saved with a confirmed stop and released occupancy. */
  function previouslyReleased(attemptId: string): boolean {
    const rows = db.prepare('SELECT receipt FROM attempt_notifications WHERE attempt_id = ?').all(attemptId) as { receipt: string }[];
    return rows.some(row => {
      const receipt = JSON.parse(row.receipt) as { disposition?: string; resultSaved?: boolean; stopConfirmed?: boolean };
      return receipt.disposition === 'applied' && receipt.resultSaved === true && receipt.stopConfirmed === true;
    });
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

  /** A succeeded retain operation attests a verified stop (or proven not_started) at retention time. */
  function retainedWithVerifiedStop(workspaceId: string): boolean {
    return db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND kind = 'retain' AND status = 'succeeded' LIMIT 1")
      .get(workspaceId) !== undefined;
  }

  function stopEvidence(value: DiscardContext): boolean {
    if (previouslyReleased(value.attempt.id)) return true;
    if (retainedWithVerifiedStop(value.workspace.id)) return true;
    return value.attempt.invocationId === null && value.attempt.startedAtUtcMs === null
      && preparationStopped(value.workspace.id, value.identity.projectId);
  }

  function gates(input: WorkspaceDiscardInput, value: DiscardContext): string | null {
    if (!['ready', 'retained'].includes(value.workspace.status)) return 'workspace_status_not_discardable';
    if (input.preview.expiresAtUtcMs <= now()) return 'preview_expired';
    if (value.resources.leases.length !== 0) return 'occupancy_active';
    if (!stopEvidence(value)) return 'stop_evidence_missing';
    return null;
  }

  function command(input: WorkspaceDiscardInput, step: string, result: Record<string, unknown>, commandId = input.operationId) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId, principalId: 'core-workspace-discard-' + step,
      operation: WORKSPACE_DISCARD_OPERATION, scope: { kind: 'project', projectId: input.projectId },
      requestDigest: createHash('sha256').update(stableStringify({ input, step, result })).digest('hex'),
      issuedAt: timestamp, completedAt: timestamp, result, resultRef: createResultRef(randomBytes(32)) });
  }

  /** The user-facing intent receipt: real principal + commandId idempotency anchor. */
  function userReceipt(input: WorkspaceDiscardInput) {
    const timestamp = new Date(now()).toISOString();
    return createCompletedReceipt({ commandId: input.commandId, principalId: input.principalId,
      operation: WORKSPACE_DISCARD_OPERATION, scope: { kind: 'project', projectId: input.projectId },
      requestDigest: computeWorkspaceDiscardRequestDigest(input),
      issuedAt: timestamp, completedAt: timestamp,
      result: { workspaceOperationId: input.operationId, workspaceId: input.workspaceId, previewDigest: input.preview.previewDigest },
      resultRef: createResultRef(randomBytes(32)) });
  }

  function recomputePreviewDigest(input: WorkspaceDiscardInput, workspace: ManagedWorkspaceRecord): string {
    return computeWorkspaceDiscardPreviewDigest({ projectId: input.projectId, featureId: input.featureId,
      workspaceId: input.workspaceId, branch: workspace.branch, workspaceRevision: input.preview.workspaceRevision,
      headCommit: input.preview.headCommit, codeDigest: input.preview.codeDigest,
      ignoredDigest: input.preview.ignoredDigest, expiresAtUtcMs: input.preview.expiresAtUtcMs });
  }

  function assertFencing(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent): DiscardContext {
    const value = current(input.projectId, input.featureId, input.workspaceId);
    const op = workspaces.readOperation(input.projectId, input.operationId);
    if (!op || op.status !== 'pending' || op.revision !== intent.commit.operation.revision
      || !isDeepStrictEqual(op.identity, value.identity) || value.workspace.revision !== intent.commit.workspace.revision
      || !isDeepStrictEqual(op.inputSnapshot, intent.commit.operation.inputSnapshot)) fail('stale_discard_revision');
    return value;
  }

  function baselineOf(workspace: ManagedWorkspaceRecord): WorkspaceBaseline {
    return validateWorkspaceBaseline({ repositoryBindingId: workspace.repositoryBindingId,
      repositoryBindingRevision: workspace.repositoryBindingRevision, repoIdentity: workspace.repoIdentity,
      canonicalPath: workspace.canonicalPath, gitCommonDir: workspace.gitCommonDir,
      branch: workspace.branch, baseCommit: workspace.baseCommit });
  }

  return {
    begin(raw) {
      const input = validateWorkspaceDiscardInput(raw);
      return atomic.transact('Workspace.discard.intent', transaction => {
        const value = current(input.projectId, input.featureId, input.workspaceId);
        input.evidenceRefs.forEach(ref => transaction.getArtifactInputRef(input.projectId, ref));
        if (recomputePreviewDigest(input, value.workspace) !== input.preview.previewDigest) fail('preview_digest_mismatch');
        const prior = workspaces.readOperation(input.projectId, input.operationId);
        if (prior && (prior.kind !== 'discard' || prior.workspaceId !== input.workspaceId
          || prior.principalId !== input.principalId || prior.commandId !== input.commandId)) fail('discard_operation_identity_conflict');
        const baseline = baselineOf(value.workspace);
        const binding = state.getRepositoryBinding(input.projectId);
        if (!prior) {
          // A new discard intent runs the full gate set; recovery of a pending intent re-runs
          // them via recheckAuthorization immediately before any deletion.
          if (value.workspace.revision !== input.expectedWorkspaceRevision
            || value.workspace.revision !== input.preview.workspaceRevision) fail('stale_workspace_revision');
          const refusal = gates(input, value);
          if (refusal) fail(refusal);
          if (db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND status = 'pending' AND id <> ? LIMIT 1")
            .get(input.workspaceId, input.operationId)) fail('unfinished_workspace_operation');
        }
        const commit = workspaces.beginInTransaction({ operationId: input.operationId, workspaceId: input.workspaceId,
          featureId: input.featureId, kind: 'discard', identity: value.identity, executionStage: value.attempt.executionStage,
          expectedWorkspaceRevision: prior ? null : input.expectedWorkspaceRevision, baseline,
          receipt: userReceipt(input) });
        if (commit.operation.status !== 'pending') {
          const receipt = receipts.findReceiptByCommandId('core-workspace-discard-result', input.operationId);
          if (!receipt) fail('missing_discard_result_receipt');
          return { commit: { ...commit, receipt: receipt! }, binding, baseline, priorStatus: value.workspace.status };
        }
        return { commit, binding, baseline, priorStatus: value.workspace.status };
      });
    },
    assertCurrent(input, intent) {
      transactSqliteConsistentRead(session, 'Workspace.discard.check', () => assertFencing(input, intent));
    },
    recheckAuthorization(rawInput, intent) {
      const input = validateWorkspaceDiscardInput(rawInput);
      return atomic.transact('Workspace.discard.authorize', () => gates(input, assertFencing(input, intent)));
    },
    readJournal(rawInput, intent): WorkspaceDiscardJournal {
      const input = validateWorkspaceDiscardInput(rawInput);
      return transactSqliteConsistentRead(session, 'Workspace.discard.journal', () => {
        assertFencing(input, intent);
        const recorded = receipts.findReceiptByCommandId('core-workspace-discard-verified', input.operationId);
        let verified: WorkspaceDiscardJournal['verified'] = null;
        if (recorded) {
          const result = recorded.status === 'completed' ? recorded.result as Record<string, unknown> : null;
          if (recorded.scope.kind !== 'project' || recorded.scope.projectId !== input.projectId
            || !result || result.workspaceId !== input.workspaceId) fail('verified_checkpoint_scope_mismatch');
          verified = validateWorkspaceCleanerVerified(result!.value);
        }
        const rows = db.prepare(`SELECT command_id, result_json FROM command_receipts WHERE principal_id = 'core-workspace-discard-process'
          AND project_id = ? AND json_extract(result_json, '$.workspaceId') = ?`)
          .all(input.projectId, input.workspaceId) as { command_id: string; result_json: string }[];
        const unfinishedProcesses: CommandProcessIdentity[] = [];
        for (const row of rows) {
          const process = validateWorkProcessIdentity((JSON.parse(row.result_json) as { value: unknown }).value);
          const stopped = receipts.findReceiptByCommandId('core-workspace-discard-stop', row.command_id);
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
      const input = validateWorkspaceDiscardInput(rawInput);
      session.transactWrite('Workspace.discard.checkpoint', () => {
        assertFencing(input, intent);
        const value = kind === 'verified' ? validateWorkspaceCleanerVerified(rawValue) : validateWorkProcessIdentity(rawValue);
        const id = kind === 'verified' ? input.operationId : (value as CommandProcessIdentity).launchId;
        const receipt = command(input, kind, { workspaceOperationId: input.operationId, workspaceId: input.workspaceId, value }, id);
        const old = receipts.findReceiptByCommandId(receipt.principalId, id);
        if (old) {
          if (old.requestDigest !== receipt.requestDigest) fail('checkpoint_identity_conflict');
          return;
        }
        if (kind === 'stop' && !receipts.findReceiptByCommandId('core-workspace-discard-process', id)) fail('process_checkpoint_required');
        receipts.saveReceiptInTransaction(receipt);
      });
    },
    finish(rawInput, intent, outcome, evidenceRef) {
      const input = validateWorkspaceDiscardInput(rawInput);
      return atomic.transact('Workspace.discard.result', transaction => {
        assertFencing(input, intent);
        transaction.getArtifactInputRef(input.projectId, evidenceRef);
        if (typeof outcome.removed !== 'boolean' || typeof outcome.recovered !== 'boolean' || typeof outcome.isolated !== 'boolean'
          || (outcome.removed && (outcome.isolated || outcome.reason !== null))
          || (!outcome.removed && !outcome.isolated && (typeof outcome.reason !== 'string' || !/^[a-z_]+$/.test(outcome.reason)))
          || (outcome.recovered && !outcome.removed)) fail('invalid_discard_outcome');
        if (outcome.removed) {
          validateWorkspaceCommit(outcome.removedHeadCommit);
          validateSha256Digest(outcome.removedCodeDigest, { operation: 'Workspace.discard' }, 'removedCodeDigest');
        }
        const done = workspaces.finishInTransaction({ operationId: input.operationId, identity: intent.commit.operation.identity,
          expectedRevision: intent.commit.operation.revision, expectedWorkspaceRevision: intent.commit.workspace.revision,
          status: outcome.removed ? 'succeeded' : outcome.isolated ? 'blocked' : 'failed',
          workspaceStatus: outcome.removed ? 'cleaned' : outcome.isolated ? 'quarantined' : intent.priorStatus,
          headCommit: outcome.removed ? outcome.removedHeadCommit : intent.commit.workspace.headCommit,
          codeDigest: outcome.removed ? outcome.removedCodeDigest : intent.commit.workspace.codeDigest,
          result: { ...outcome.result, evidenceRefs: [...input.evidenceRefs, evidenceRef], errorRef: outcome.removed ? null : evidenceRef },
          receipt: command(input, 'result', { workspaceOperationId: input.operationId, workspaceId: input.workspaceId,
            removed: outcome.removed, recovered: outcome.recovered, reason: outcome.reason, isolated: outcome.isolated, evidenceRef }) });
        if (outcome.isolated && options.resources.read(intent.commit.operation.identity).leases.length) {
          options.resources.quarantineInTransaction(intent.commit.operation.identity);
        }
        return done;
      });
    },
    quarantine(rawInput, intent) {
      const input = validateWorkspaceDiscardInput(rawInput);
      session.transactWrite('Workspace.discard.quarantine', () => {
        const op = workspaces.readOperation(input.projectId, input.operationId);
        if (!op) return;
        if (intent) {
          try { assertFencing(input, intent); }
          catch (error) { if (error instanceof StorageError && ['ownership', 'conflict'].includes(error.kind)) return; throw error; }
        }
        try {
          if (options.resources.read(op.identity).leases.length) options.resources.quarantineInTransaction(op.identity);
        } catch (error) { if (error instanceof StorageError && error.kind === 'ownership') return; throw error; }
      });
    },
  };
}

export function createSqliteWorkspaceDiscardPreviewStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
}): WorkspaceDiscardPreviewStore {
  const db = session.database;
  const workspaces = createSqliteWorkspaceAccess(session, { resources: options.resources });
  const attempts = createSqliteAttemptAccess(session);
  const receipts = createSqliteCommandReceiptAccess(session);
  const state = createSqliteStateAccess(session);

  function previouslyReleased(attemptId: string): boolean {
    const rows = db.prepare('SELECT receipt FROM attempt_notifications WHERE attempt_id = ?').all(attemptId) as { receipt: string }[];
    return rows.some(row => {
      const receipt = JSON.parse(row.receipt) as { disposition?: string; resultSaved?: boolean; stopConfirmed?: boolean };
      return receipt.disposition === 'applied' && receipt.resultSaved === true && receipt.stopConfirmed === true;
    });
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

  return {
    loadPreviewTarget(rawProjectId, rawFeatureId): WorkspaceDiscardPreviewTarget | null {
      const projectId = validateStableId(rawProjectId, { operation: 'Workspace.discard.preview' }, 'projectId');
      const featureId = validateStableId(rawFeatureId, { operation: 'Workspace.discard.preview' }, 'featureId');
      return transactSqliteConsistentRead(session, 'Workspace.discard.previewTarget', () => {
        const workspace = workspaces.readWorkspace(projectId, featureId);
        if (!workspace) return null;
        const writer = db.prepare(`SELECT attempt_id FROM state_events WHERE project_id = ? AND aggregate_id = ?
          AND event_type = 'workspace.operation_updated' ORDER BY sequence DESC LIMIT 1`)
          .get(projectId, featureId) as { attempt_id: string } | undefined;
        const attempt = attempts.getAttempt(projectId, writer?.attempt_id ?? workspace.attemptId);
        const identity: WorkResourceIdentity = { projectId, attemptId: attempt.id, owner: attempt.owner,
          hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
        const blockers: WorkspaceDiscardBlocker[] = [];
        if (!['ready', 'retained'].includes(workspace.status)) blockers.push('workspace_status_not_discardable');
        if (options.resources.read(identity).leases.length !== 0
          || db.prepare('SELECT id FROM workspace_leases WHERE owner_id <> ? LIMIT 1').get(attempt.id)) blockers.push('occupancy_active');
        const released = previouslyReleased(attempt.id)
          || db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND kind = 'retain' AND status = 'succeeded' LIMIT 1").get(workspace.id) !== undefined
          || (attempt.invocationId === null && attempt.startedAtUtcMs === null && preparationStopped(workspace.id, projectId));
        if (!released) blockers.push('stop_evidence_missing');
        if (db.prepare("SELECT id FROM workspace_operations WHERE workspace_id = ? AND status = 'pending' LIMIT 1").get(workspace.id)) {
          blockers.push('unfinished_workspace_operation');
        }
        return { workspace, binding: state.getRepositoryBinding(projectId), blockers };
      });
    },
  };
}
