/**
 * P03-8 / F-002：受控 Git 提交意图与操作回执（SQLite 适配器，迁移 v26）。
 *
 * 只做持久化：不执行 Git、不读文件系统、不等待审批。注册与终态写回均在既有
 * BEGIN IMMEDIATE（原子命令事务）内完成；Git/文件 I/O 由 F-003 在事务外执行，
 * 因此事务内不包含任何外部副作用。
 *
 * 核验规则（端口语义的真实执行）：
 * - 注册核对 Project → RepositoryBinding → Feature → Run → 适用 Attempt 的
 *   同项目/同 Feature/同 Run 归属链；Feature revision 与 Attempt executionVersion
 *   必须匹配调用方固定的前置条件（陈旧身份 conflict）；
 * - 同 operationId 同意图幂等返回原记录（created=false），不重复写事件；不同
 *   意图复用 ID conflict（details.reason='intent_conflict'），既有记录不变；
 * - 终态写回只允许 pending → 终态一次 CAS；状态、actual commit/tree、回执、
 *   Feature deliveryStatus 与 state_events 在同一事务内原子落库；相同终态事实
 *   幂等重放不重复写事件，不同事实 conflict；
 * - 未知退出码/耗时保持 null；行读取 fail-closed（损坏 JSON/不一致回执抛
 *   corrupt，不泄漏原始内容）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import {
  GIT_OPERATION_REGISTERED_EVENT_TYPE,
  GIT_OPERATION_SETTLED_EVENT_TYPE,
} from '../../ports/events.js';
import {
  GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT,
  GIT_OPERATION_TYPE_TASK_COMMIT,
  isIntegrationGitOperationType,
  assertFinalizationMatchesIntent,
  buildGitOperationReceipt,
  computeGitOperationIntentDigest,
  isSameGitOperationFinalization,
  isSameGitOperationIntent,
  stripPrecondition,
  validateGitOperationFinalizeInput,
  validateGitOperationRecord,
  validateGitOperationRegisterInput,
  type GitOperationFinalization,
  type GitOperationFinalizeInput,
  type GitOperationIntent,
  type GitOperationMutation,
  type GitOperationRecord,
  type GitOperationRegisterInput,
  type GitOperationStore,
} from '../../ports/git-operations.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';

export interface GitOperationRow {
  id: string;
  created_at: number;
  updated_at: number;
  revision: number;
  project_id: string;
  feature_id: string;
  run_id: string;
  attempt_id: string | null;
  execution_version: number;
  operation_type: string;
  repository_binding_id: string;
  repo_identity: string;
  worktree_path: string;
  expected_head: string;
  candidate_tree: string | null;
  integration_plan: string | null;
  budget_snapshot: string | null;
  code_digest: string;
  verification_refs: string;
  approval_refs: string;
  message: string;
  identity_name: string;
  identity_email: string;
  delivery_policy_digest: string;
  runtime_source: string | null;
  owner_id: string;
  host_instance_id: string;
  intent_digest: string;
  status: string;
  actual_commit: string | null;
  actual_tree: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  reason_code: string | null;
  receipt: string | null;
  integration_result: string | null;
  recovery_state: string | null;
  workspace_preserved: number;
  delivery_status: string | null;
  settled_at: number | null;
}

export const GIT_OPERATION_COLUMNS = `id, created_at, updated_at, revision, project_id,
  feature_id, run_id, attempt_id, execution_version, operation_type, repository_binding_id,
  repo_identity, worktree_path, expected_head, candidate_tree, integration_plan, budget_snapshot, code_digest, verification_refs,
  approval_refs, message, identity_name, identity_email, delivery_policy_digest, runtime_source,
  owner_id, host_instance_id, intent_digest, status, actual_commit, actual_tree, exit_code,
  duration_ms, reason_code, receipt, integration_result, recovery_state, workspace_preserved, delivery_status, settled_at`;

const LEGACY_GIT_OPERATION_COLUMNS = `id, created_at, updated_at, revision, project_id,
  feature_id, run_id, attempt_id, execution_version, operation_type, repository_binding_id,
  repo_identity, worktree_path, expected_head, candidate_tree,
  NULL AS integration_plan, NULL AS budget_snapshot, code_digest, verification_refs,
  approval_refs, message, identity_name, identity_email, delivery_policy_digest, runtime_source,
  owner_id, host_instance_id, intent_digest, status, actual_commit, actual_tree, exit_code,
  duration_ms, reason_code, receipt, NULL AS integration_result, 'none' AS recovery_state,
  0 AS workspace_preserved, delivery_status, settled_at`;


/** 行列 → 记录（fail-closed：损坏 JSON/不一致回执抛 corrupt，不泄漏原始内容）。 */
export function gitOperationRecordFromRow(
  row: GitOperationRow,
  operation = 'GitOperationStore.read',
): GitOperationRecord {
  try {
    const intent: GitOperationIntent = {
      operationId: row.id,
      projectId: row.project_id,
      featureId: row.feature_id,
      runId: row.run_id,
      attemptId: row.attempt_id,
      executionVersion: row.execution_version,
      operationType: row.operation_type as GitOperationIntent['operationType'],
      repositoryBindingId: row.repository_binding_id,
      repoIdentity: row.repo_identity,
      worktreePath: row.worktree_path,
      expectedHead: row.expected_head,
      candidateTree: row.candidate_tree ?? row.expected_head,
      integrationPlan: row.integration_plan === null ? null : JSON.parse(row.integration_plan),
      budgetSnapshot: row.budget_snapshot === null ? null : JSON.parse(row.budget_snapshot),
      codeDigest: row.code_digest,
      verificationRefs: JSON.parse(row.verification_refs),
      approvalRefs: JSON.parse(row.approval_refs),
      message: row.message,
      gitIdentity: {
        name: row.identity_name,
        email: row.identity_email,
        confirmed: true,
      },
      deliveryPolicyDigest: row.delivery_policy_digest,
      runtimeSource: row.runtime_source === null ? null : JSON.parse(row.runtime_source),
      ownerId: row.owner_id,
      hostInstanceId: row.host_instance_id,
    };
    return validateGitOperationRecord(
      {
        intent,
        intentDigest: row.intent_digest,
        status: row.status,
        actualCommit: row.actual_commit,
        actualTree: row.actual_tree,
        exitCode: row.exit_code,
        durationMs: row.duration_ms,
        reasonCode: row.reason_code,
        receipt: row.receipt === null ? null : JSON.parse(row.receipt),
        integrationResult: row.integration_result === null ? null : JSON.parse(row.integration_result),
        recoveryState: row.recovery_state === null ? null : row.recovery_state,
        workspacePreserved: row.workspace_preserved === 1,
        deliveryStatus: row.delivery_status,
        settledAtUtcMs: row.settled_at,
        revision: row.revision,
        createdAtUtcMs: row.created_at,
        updatedAtUtcMs: row.updated_at,
      },
      operation,
    );
  } catch (error) {
    if (error instanceof StorageError && error.kind === 'corrupt') {
      throw error;
    }
    throw new StorageError('corrupt', operation, 'Invalid stored git operation row', {
      entity: { type: 'git_operation', id: row.id, projectId: row.project_id },
    });
  }
}

interface AttemptIdentityRow {
  project_id: string;
  feature_id: string;
  run_id: string;
  execution_version: number;
  task_id: string;
  owner_id: string;
  host_instance_id: string;
}

interface BindingIdentityRow {
  project_id: string;
  repo_identity: string;
}

export function createSqliteGitOperationStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): GitOperationStore {
  const db = session.database;
  const now = options.nowUtcMs ?? (() => Date.now());

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('conflict', operation, 'Storage session is closed');
    }
  }

  function fail(
    kind: 'validation' | 'not_found' | 'conflict' | 'ownership' | 'corrupt',
    operation: string,
    message: string,
    entity?: StorageEntityRef,
    reason?: string,
    extra?: Readonly<Record<string, unknown>>,
  ): never {
    throw new StorageError(kind, operation, message, {
      ...(entity === undefined ? {} : { entity }),
      ...(reason === undefined ? {} : { details: { reason, ...extra } }),
    });
  }

  function supportsIntegrationColumns(): boolean {
    const columns = db.pragma('table_info(git_operations)') as { name: string }[];
    return columns.some(column => column.name === 'integration_plan');
  }

  function readRow(operationId: string): GitOperationRow | undefined {
    const columns = supportsIntegrationColumns() ? GIT_OPERATION_COLUMNS : LEGACY_GIT_OPERATION_COLUMNS;
    return db
      .prepare<[string], GitOperationRow>(
        `SELECT ${columns} FROM git_operations WHERE id = ?`,
      )
      .get(operationId);
  }

  function insertRow(
    input: GitOperationRegisterInput,
    intentDigest: string,
    timestamp: number,
  ): void {
    if (!supportsIntegrationColumns()) {
      db.prepare(`INSERT INTO git_operations
        (id, created_at, updated_at, revision, project_id, feature_id, run_id, attempt_id,
         execution_version, operation_type, repository_binding_id, repo_identity, worktree_path,
         expected_head, candidate_tree, code_digest, verification_refs, approval_refs, message,
         identity_name, identity_email, delivery_policy_digest, runtime_source, owner_id,
         host_instance_id, intent_digest, status, actual_commit, actual_tree, exit_code,
         duration_ms, reason_code, receipt, delivery_status, settled_at)
       VALUES (@id, @createdAt, @updatedAt, 1, @projectId, @featureId, @runId, @attemptId,
         @executionVersion, @operationType, @repositoryBindingId, @repoIdentity, @worktreePath,
         @expectedHead, @candidateTree, @codeDigest, @verificationRefs, @approvalRefs,
         @message, @identityName, @identityEmail, @deliveryPolicyDigest, @runtimeSource,
         @ownerId, @hostInstanceId, @intentDigest, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)
        .run({
          id: input.operationId, createdAt: timestamp, updatedAt: timestamp,
          projectId: input.projectId, featureId: input.featureId, runId: input.runId,
          attemptId: input.attemptId, executionVersion: input.executionVersion,
          operationType: input.operationType, repositoryBindingId: input.repositoryBindingId,
          repoIdentity: input.repoIdentity, worktreePath: input.worktreePath,
          expectedHead: input.expectedHead, candidateTree: input.candidateTree,
          codeDigest: input.codeDigest, verificationRefs: JSON.stringify(input.verificationRefs),
          approvalRefs: JSON.stringify(input.approvalRefs), message: input.message,
          identityName: input.gitIdentity.name, identityEmail: input.gitIdentity.email,
          deliveryPolicyDigest: input.deliveryPolicyDigest,
          runtimeSource: input.runtimeSource === null ? null : JSON.stringify(input.runtimeSource),
          ownerId: input.ownerId, hostInstanceId: input.hostInstanceId, intentDigest,
        });
      return;
    }
    db.prepare(
      `INSERT INTO git_operations (id, created_at, updated_at, revision, project_id,
        feature_id, run_id, attempt_id, execution_version, operation_type,
        repository_binding_id, repo_identity, worktree_path, expected_head, candidate_tree,
        integration_plan, budget_snapshot, code_digest, verification_refs, approval_refs, message,
        identity_name, identity_email, delivery_policy_digest, runtime_source, owner_id,
        host_instance_id, intent_digest, status, actual_commit, actual_tree, exit_code,
        duration_ms, reason_code, receipt, integration_result, recovery_state, workspace_preserved,
        delivery_status, settled_at)
       VALUES (@id, @createdAt, @updatedAt, 1, @projectId, @featureId, @runId, @attemptId,
        @executionVersion, @operationType, @repositoryBindingId, @repoIdentity, @worktreePath,
        @expectedHead, @candidateTree, @integrationPlan, @budgetSnapshot, @codeDigest,
        @verificationRefs, @approvalRefs, @message, @identityName, @identityEmail,
        @deliveryPolicyDigest, @runtimeSource, @ownerId, @hostInstanceId, @intentDigest,
        'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'none', 0, NULL, NULL)`,
    ).run({
      id: input.operationId,
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId: input.projectId,
      featureId: input.featureId,
      runId: input.runId,
      attemptId: input.attemptId,
      executionVersion: input.executionVersion,
      operationType: input.operationType,
      repositoryBindingId: input.repositoryBindingId,
      repoIdentity: input.repoIdentity,
      worktreePath: input.worktreePath,
      expectedHead: input.expectedHead,
      candidateTree: input.candidateTree ?? input.expectedHead,
      integrationPlan: input.integrationPlan == null ? null : JSON.stringify(input.integrationPlan),
      budgetSnapshot: input.budgetSnapshot == null ? null : JSON.stringify(input.budgetSnapshot),
      codeDigest: input.codeDigest,
      verificationRefs: JSON.stringify(input.verificationRefs),
      approvalRefs: JSON.stringify(input.approvalRefs),
      message: input.message,
      identityName: input.gitIdentity.name,
      identityEmail: input.gitIdentity.email,
      deliveryPolicyDigest: input.deliveryPolicyDigest,
      runtimeSource: input.runtimeSource === null ? null : JSON.stringify(input.runtimeSource),
      ownerId: input.ownerId,
      hostInstanceId: input.hostInstanceId,
      intentDigest,
    });
  }

  function appendEvent(
    eventType: string,
    projectId: string,
    operationId: string,
    aggregateRevision: number,
    payload: Record<string, unknown>,
    timestamp: number,
  ): void {
    const nextSequence = db
      .prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events')
      .get();
    db.prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      timestamp,
      timestamp,
      projectId,
      nextSequence?.next ?? 1,
      eventType,
      'git_operation',
      operationId,
      aggregateRevision,
      JSON.stringify(payload),
      timestamp,
    );
  }

  /** 注册前置条件核验（同一事务内；跨项目/身份链/陈旧 revision 结构化拒绝）。 */
  function assertRegistrationPreconditions(
    input: GitOperationRegisterInput,
    operation: string,
    entity: StorageEntityRef,
  ): void {
    const project = db.prepare<[string], { id: string }>('SELECT id FROM projects WHERE id = ?').get(input.projectId);
    if (!project) {
      fail('not_found', operation, 'Project not found', entity);
    }
    const binding = db
      .prepare<[string], BindingIdentityRow>(
        'SELECT project_id, repo_identity FROM repository_bindings WHERE id = ?',
      )
      .get(input.repositoryBindingId);
    if (!binding) {
      fail('not_found', operation, 'Repository binding not found', entity);
    }
    if (binding!.project_id !== input.projectId) {
      fail('ownership', operation, 'Repository binding belongs to another project', entity);
    }
    if (binding!.repo_identity !== input.repoIdentity) {
      fail('conflict', operation, 'Repository identity does not match the binding', entity,
        'repository_identity_mismatch');
    }
    const feature = db
      .prepare<[string], { project_id: string; revision: number }>(
        'SELECT project_id, revision FROM features WHERE id = ?',
      )
      .get(input.featureId);
    if (!feature) {
      fail('not_found', operation, 'Feature not found', entity);
    }
    if (feature!.project_id !== input.projectId) {
      fail('ownership', operation, 'Feature belongs to another project', entity);
    }
    if (feature!.revision !== input.expectedFeatureRevision) {
      fail('conflict', operation, 'Feature revision is stale', entity, 'stale_revision', {
        expectedRevision: input.expectedFeatureRevision,
        actualRevision: feature!.revision,
      });
    }
    const run = db
      .prepare<[string], { project_id: string; feature_id: string }>(
        'SELECT project_id, feature_id FROM runs WHERE id = ?',
      )
      .get(input.runId);
    if (!run) {
      fail('not_found', operation, 'Run not found', entity);
    }
    if (run!.project_id !== input.projectId) {
      fail('ownership', operation, 'Run belongs to another project', entity);
    }
    if (run!.feature_id !== input.featureId) {
      fail('conflict', operation, 'Run does not belong to the declared Feature', entity,
        'run_feature_mismatch');
    }
    if (input.attemptId !== null) {
      const attempt = db
        .prepare<[string], AttemptIdentityRow>(
          'SELECT project_id, feature_id, run_id, execution_version, task_id, owner_id, host_instance_id FROM attempts WHERE id = ?',
        )
        .get(input.attemptId);
      if (!attempt) {
        fail('not_found', operation, 'Attempt not found', entity);
      }
      if (attempt!.project_id !== input.projectId) {
        fail('ownership', operation, 'Attempt belongs to another project', entity);
      }
      if (attempt!.feature_id !== input.featureId || attempt!.run_id !== input.runId) {
        fail('conflict', operation, 'Attempt does not belong to the declared Feature/Run', entity,
          'attempt_identity_mismatch');
      }
      if (attempt!.execution_version !== input.executionVersion) {
        fail('conflict', operation, 'Attempt executionVersion is stale', entity,
          'stale_execution_version', {
            expectedRevision: input.executionVersion,
            actualRevision: attempt!.execution_version,
          });
      }
      if (input.operationType === GIT_OPERATION_TYPE_TASK_COMMIT) {
        assertTaskIdentity(input, operation, entity);
      }
    }
  }

  function assertTaskIdentity(
    intent: GitOperationIntent,
    operation: string,
    entity: StorageEntityRef,
  ): void {
    const current = db.prepare<[string | null, string, string, string, number], { owner_id: string; host_instance_id: string }>(
      `SELECT a.owner_id, a.host_instance_id FROM attempts a
       JOIN tasks t ON t.id = a.task_id AND t.project_id = a.project_id
         AND t.feature_id = a.feature_id AND t.execution_version = a.execution_version
       WHERE a.id = ? AND a.project_id = ? AND a.feature_id = ? AND a.run_id = ?
         AND a.execution_version = ?`,
    );
    const identity = current.get(intent.attemptId, intent.projectId, intent.featureId,
      intent.runId, intent.executionVersion);
    if (!identity) {
      fail('conflict', operation, 'Task/Attempt execution identity is stale', entity,
        'stale_task_identity');
    }
    if (identity!.owner_id !== intent.ownerId || identity!.host_instance_id !== intent.hostInstanceId) {
      fail('ownership', operation, 'Task commit owner/host does not match Attempt', entity,
        'attempt_owner_mismatch');
    }
  }

  function registerInTransaction(raw: unknown): GitOperationMutation {
    const operation = 'GitOperationStore.register';
    assertOpen(operation);
    if (!db.inTransaction) {
      throw new TypeError('Git operation registration requires a write transaction');
    }
    const input = validateGitOperationRegisterInput(raw, operation);
    const entity: StorageEntityRef = {
      type: 'git_operation',
      id: input.operationId,
      projectId: input.projectId,
    };
    const candidate = stripPrecondition(input);
    const candidateDigest = computeGitOperationIntentDigest(candidate);
    const existingRow = readRow(input.operationId);
    if (existingRow) {
      const existing = gitOperationRecordFromRow(existingRow, operation);
      if (existing.intent.projectId !== input.projectId) {
        fail('ownership', operation, 'Git operation belongs to another project', entity,
          'operation_project_mismatch');
      }
      if (!isSameGitOperationIntent(existing, candidate)) {
        fail('conflict', operation, 'operationId replayed with a different intent', entity,
          'intent_conflict');
      }
      return { operation: existing, created: false };
    }
    assertRegistrationPreconditions(input, operation, entity);
    const timestamp = now();
    try {
      insertRow(input, candidateDigest, timestamp);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        const raced = readRow(input.operationId);
        if (raced) {
          const existing = gitOperationRecordFromRow(raced, operation);
          if (isSameGitOperationIntent(existing, candidate)) {
            return { operation: existing, created: false };
          }
          fail('conflict', operation, 'operationId replayed with a different intent', entity,
            'intent_conflict');
        }
      }
      throw error;
    }
    appendEvent(
      GIT_OPERATION_REGISTERED_EVENT_TYPE,
      input.projectId,
      input.operationId,
      1,
      { operationId: input.operationId },
      timestamp,
    );
    const row = readRow(input.operationId);
    if (!row) fail('corrupt', operation, 'Git operation missing after insert', entity);
    return {
      operation: gitOperationRecordFromRow(row!, operation),
      created: true,
    };
  }

  function finalizeInTransaction(raw: unknown): GitOperationFinalization {
    const operation = 'GitOperationStore.finalize';
    assertOpen(operation);
    if (!db.inTransaction) {
      throw new TypeError('Git operation finalization requires a write transaction');
    }
    const input: GitOperationFinalizeInput = validateGitOperationFinalizeInput(raw, operation);
    const entity: StorageEntityRef = {
      type: 'git_operation',
      id: input.operationId,
      projectId: input.projectId,
    };
    const row = readRow(input.operationId);
    if (!row) {
      fail('not_found', operation, 'Git operation not found', entity);
    }
    if (row!.project_id !== input.projectId) {
      fail('ownership', operation, 'Git operation belongs to another project', entity);
    }
    const existing = gitOperationRecordFromRow(row!, operation);
    if (existing.status !== 'pending') {
      if (isSameGitOperationFinalization(existing, input)) {
        return { operation: existing, settled: false };
      }
      fail('conflict', operation, 'Git operation is already terminal', entity,
        'terminal_operation_conflict');
    }
    if (existing.revision !== input.expectedRevision) {
      fail('conflict', operation, 'Git operation revision is stale', entity, 'stale_revision', {
        expectedRevision: input.expectedRevision,
        actualRevision: existing.revision,
      });
    }
    assertFinalizationMatchesIntent(existing.intent, input, operation);
    if (existing.intent.operationType === GIT_OPERATION_TYPE_TASK_COMMIT) {
      assertTaskIdentity(existing.intent, operation, entity);
    }
    // A delayed receipt must never overwrite a newer operation's delivery axis.
    // rowid orders durable registration even when clock timestamps are identical.
    const newer = existing.intent.operationType === GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT
      ? db.prepare<[string, string, string], { id: string }>(
          `SELECT id FROM git_operations WHERE project_id = ? AND feature_id = ?
            AND operation_type = 'feature_final_commit'
            AND rowid > (SELECT rowid FROM git_operations WHERE id = ?) LIMIT 1`,
        ).get(existing.intent.projectId, existing.intent.featureId, input.operationId)
      : undefined;
    if (newer) {
      fail('conflict', operation, 'A newer Git operation owns the delivery projection', entity,
        'superseded_operation');
    }
    const receipt = buildGitOperationReceipt(existing.intent, existing.intentDigest, input);
    const timestamp = now();
    const receiptJson = JSON.stringify(receipt);
    const integrationResultJson = input.integrationResult === undefined || input.integrationResult === null
      ? null : JSON.stringify(input.integrationResult);
    const changed = supportsIntegrationColumns()
      ? db.prepare(`UPDATE git_operations SET status = @status, actual_commit = @actualCommit,
          actual_tree = @actualTree, exit_code = @exitCode, duration_ms = @durationMs,
          reason_code = @reasonCode, receipt = @receipt, integration_result = @integrationResult,
          recovery_state = @recoveryState, workspace_preserved = @workspacePreserved,
          delivery_status = @deliveryStatus, settled_at = @settledAt,
          revision = revision + 1, updated_at = @updatedAt
         WHERE id = @id AND project_id = @projectId AND revision = @revision AND status = 'pending'`)
        .run({ status: input.status, actualCommit: input.actualCommit, actualTree: input.actualTree,
          exitCode: input.exitCode, durationMs: input.durationMs, reasonCode: input.reasonCode,
          receipt: receiptJson, integrationResult: integrationResultJson,
          recoveryState: input.recoveryState ?? 'none', workspacePreserved: input.workspacePreserved === true ? 1 : 0,
          deliveryStatus: input.deliveryStatus, settledAt: input.settledAtUtcMs, updatedAt: timestamp,
          id: input.operationId, projectId: input.projectId, revision: input.expectedRevision })
      : db.prepare(`UPDATE git_operations SET status = @status, actual_commit = @actualCommit,
          actual_tree = @actualTree, exit_code = @exitCode, duration_ms = @durationMs,
          reason_code = @reasonCode, receipt = @receipt, delivery_status = @deliveryStatus,
          settled_at = @settledAt, revision = revision + 1, updated_at = @updatedAt
         WHERE id = @id AND project_id = @projectId AND revision = @revision AND status = 'pending'`)
        .run({ status: input.status, actualCommit: input.actualCommit, actualTree: input.actualTree,
          exitCode: input.exitCode, durationMs: input.durationMs, reasonCode: input.reasonCode,
          receipt: receiptJson, deliveryStatus: input.deliveryStatus, settledAt: input.settledAtUtcMs,
          updatedAt: timestamp, id: input.operationId, projectId: input.projectId,
          revision: input.expectedRevision });
    if (changed.changes !== 1) {
      fail('conflict', operation, 'Git operation CAS did not match a pending row', entity,
        'stale_revision');
    }
    // deliveryStatus 是独立结果轴：不改 Feature revision/计划审批身份，只更新投影。
    if (existing.intent.operationType === GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT) {
      const featureChanged = db
        .prepare(
          'UPDATE features SET delivery_status = ?, updated_at = ? WHERE project_id = ? AND id = ?',
        )
        .run(input.deliveryStatus, timestamp, existing.intent.projectId, existing.intent.featureId);
      if (featureChanged.changes !== 1) {
        fail('corrupt', operation, 'Feature missing while finalizing git operation', entity);
      }
    }
    if (isIntegrationGitOperationType(existing.intent.operationType) && existing.intent.integrationPlan != null
      && input.integrationResult !== undefined && input.integrationResult !== null
      // P05-7/F-004 stores the P05-6 source plan separately. F-005 performs that
      // CAS in the same transaction; writing the execution plan JSON here would
      // mix the two digest domains and make the source row unreadable.
      && typeof existing.intent.budgetSnapshot?.sourcePlanId !== 'string') {
      const planChanged = db.prepare(
        `UPDATE integration_plans SET integration_result = ?, status = ?, revision = revision + 1,
          updated_at = ? WHERE project_id = ? AND id = ?`,
      ).run(
        JSON.stringify(input.integrationResult),
        input.status === 'succeeded' ? 'integration_passed' : 'dependency_passed',
        timestamp,
        existing.intent.projectId,
        existing.intent.integrationPlan.integrationId,
      );
      if (planChanged.changes !== 1) {
        fail('corrupt', operation, 'Integration plan missing while finalizing git operation', entity);
      }
    }
    appendEvent(
      GIT_OPERATION_SETTLED_EVENT_TYPE,
      input.projectId,
      input.operationId,
      input.expectedRevision + 1,
      { operationId: input.operationId, status: input.status },
      timestamp,
    );
    const settledRow = readRow(input.operationId);
    if (!settledRow) fail('corrupt', operation, 'Git operation missing after finalize', entity);
    return {
      operation: gitOperationRecordFromRow(settledRow!, operation),
      settled: true,
    };
  }

  function readById(projectId: string, operationId: string): GitOperationRecord {
    const operation = 'GitOperationStore.read';
    assertOpen(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validOperationId = validateStableId(operationId, { operation }, 'operationId');
    const row = readRow(validOperationId);
    const entity: StorageEntityRef = {
      type: 'git_operation',
      id: validOperationId,
      projectId: validProjectId,
    };
    if (!row) fail('not_found', operation, 'Git operation not found', entity);
    if (row!.project_id !== validProjectId) {
      fail('ownership', operation, 'Git operation belongs to another project', entity);
    }
    return gitOperationRecordFromRow(row!, operation);
  }

  return {
    registerGitOperation(input: unknown): GitOperationMutation {
      assertOpen('GitOperationStore.register');
      return session.transactWrite('GitOperationStore.register', () => registerInTransaction(input));
    },
    finalizeGitOperation(input: unknown): GitOperationFinalization {
      assertOpen('GitOperationStore.finalize');
      return session.transactWrite('GitOperationStore.finalize', () => finalizeInTransaction(input));
    },
    getGitOperation(projectId: string, operationId: string): GitOperationRecord {
      const read = (): GitOperationRecord => readById(projectId, operationId);
      return db.inTransaction ? read() : transactSqliteConsistentRead(session, 'GitOperationStore.read', read);
    },
    findGitOperationsByIntentDigest(
      projectId: string,
      featureId: string,
      intentDigest: string,
    ): readonly GitOperationRecord[] {
      const operation = 'GitOperationStore.findByIntent';
      assertOpen(operation);
      const validProjectId = validateStableId(projectId, { operation }, 'projectId');
      const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
      if (typeof intentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intentDigest)) {
        fail('validation', operation, 'intentDigest must be a lowercase SHA-256', {
          type: 'git_operation',
          projectId: validProjectId,
        });
      }
      const read = (): readonly GitOperationRecord[] =>
        db
          .prepare<[string, string, string], GitOperationRow>(
            `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations
              WHERE project_id = ? AND feature_id = ? AND intent_digest = ?
              ORDER BY created_at, id`,
          )
          .all(validProjectId, validFeatureId, intentDigest)
          .map((row) => gitOperationRecordFromRow(row, operation));
      return db.inTransaction
        ? read()
        : transactSqliteConsistentRead(session, operation, read);
    },
    registerGitOperationInTransaction(
      transaction: CommandTransaction,
      input: unknown,
    ): GitOperationMutation {
      void transaction;
      return registerInTransaction(input);
    },
    finalizeGitOperationInTransaction(
      transaction: CommandTransaction,
      input: unknown,
    ): GitOperationFinalization {
      void transaction;
      return finalizeInTransaction(input);
    },
    getGitOperationInTransaction(
      transaction: CommandTransaction,
      projectId: string,
      operationId: string,
    ): GitOperationRecord {
      void transaction;
      return readById(projectId, operationId);
    },
  };
}
