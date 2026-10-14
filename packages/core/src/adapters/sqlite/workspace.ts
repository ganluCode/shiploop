import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../../ports/errors.js';
import type { CommandReceipt } from '../../ports/commands.js';
import { validatePersistableCommandReceipt } from '../../ports/command-receipts.js';
import {
  validateWorkspaceOperationResult, validateWorkspaceBaseline,
  WORKSPACE_STATUSES, WORKSPACE_OPERATION_STATUSES, WORKSPACE_OPERATION_KINDS, workspaceMember,
  validateBeginWorkspaceOperation, validateFinishWorkspaceOperation, validateWorkspacePage,
  type BeginWorkspaceOperationInput, type FinishWorkspaceOperationInput, type ManagedWorkspaceRecord,
  type WorkspaceOperationAccess, type WorkspaceOperationCommit, type WorkspaceOperationRecord,
  type WorkspaceOperationResult, type WorkspacePage,
} from '../../ports/workspace.js';
import { validateWorkResourceIdentity, type WorkResourceAccess, type WorkResourceIdentity } from '../../ports/work-resources.js';
import { ATTEMPT_EXECUTION_STAGES } from '../../ports/attempt-store.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';

interface WorkspaceRow { [key: string]: unknown; }
const WORKSPACE_COLUMNS = `id, created_at, project_id, revision, updated_at, feature_id, repository_binding_id,
 repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit, head_commit,
 code_digest, status, preparation_operation_id, owner_id, host_instance_id, execution_version, run_id, attempt_id`;
const OPERATION_COLUMNS = `id, created_at, project_id, revision, updated_at, feature_id, workspace_id, run_id, attempt_id,
 owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest,
 input_snapshot, status, result_json, receipt_id, finish_snapshot`;

function rowFailure(kind: 'conflict' | 'ownership' | 'corrupt' | 'not_found', message: string, details?: Record<string, unknown>): never {
  throw new StorageError(kind, 'Workspace', message, { entity: { type: 'workspace' }, details });
}
function rowJson(value: unknown, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return rowFailure('corrupt', `${field} is not a JSON object`);
    return parsed as Record<string, unknown>;
  } catch (cause) { throw new StorageError('corrupt', 'Workspace', `${field} is invalid JSON`, { cause }); }
}
function operationResultFromRow(value: unknown): WorkspaceOperationResult | null {
  if (value === null) return null;
  try { return validateWorkspaceOperationResult(rowJson(value, 'result_json')); }
  catch (cause) { throw new StorageError('corrupt', 'Workspace', 'Invalid persisted workspace result', { cause }); }
}
/** P03-5 / F-011：行→记录映射提取为模块级纯函数，供只读查询装配复用（同一校验规则，不另立第二套）。 */
export function mapManagedWorkspaceRow(row: WorkspaceRow | undefined): ManagedWorkspaceRecord | null {
  if (row === undefined) return null;
  workspaceMember(row.status, WORKSPACE_STATUSES, 'status');
  validateWorkspaceBaseline({ repositoryBindingId: row.repository_binding_id, repositoryBindingRevision: row.repository_binding_revision,
    repoIdentity: row.repo_identity, canonicalPath: row.canonical_path, gitCommonDir: row.git_common_dir, branch: row.branch, baseCommit: row.base_commit });
  return { id: String(row.id), createdAtUtcMs: Number(row.created_at), projectId: String(row.project_id), revision: Number(row.revision), updatedAtUtcMs: Number(row.updated_at),
    featureId: String(row.feature_id), repositoryBindingId: String(row.repository_binding_id), repositoryBindingRevision: Number(row.repository_binding_revision), repoIdentity: String(row.repo_identity),
    canonicalPath: String(row.canonical_path), gitCommonDir: String(row.git_common_dir), branch: String(row.branch), baseCommit: String(row.base_commit), headCommit: row.head_commit as string | null,
    codeDigest: row.code_digest as string | null, status: row.status as ManagedWorkspaceRecord['status'], preparationOperationId: String(row.preparation_operation_id),
    ownerId: String(row.owner_id), hostInstanceId: String(row.host_instance_id), executionVersion: Number(row.execution_version), runId: String(row.run_id), attemptId: String(row.attempt_id) };
}
/** P03-5 / F-011：operation 行→记录映射（同一校验规则；含 work 身份重建）。 */
export function mapWorkspaceOperationRow(row: WorkspaceRow | undefined): WorkspaceOperationRecord | null {
  if (row === undefined) return null;
  workspaceMember(row.status, WORKSPACE_OPERATION_STATUSES, 'status');
  workspaceMember(row.kind, WORKSPACE_OPERATION_KINDS, 'kind');
  workspaceMember(row.execution_stage, ATTEMPT_EXECUTION_STAGES, 'executionStage');
  const identity: WorkResourceIdentity = { projectId: String(row.project_id), attemptId: String(row.attempt_id), owner: String(row.owner_id), hostInstanceId: String(row.host_instance_id), executionVersion: Number(row.execution_version) };
  return { id: String(row.id), projectId: String(row.project_id), featureId: String(row.feature_id), workspaceId: String(row.workspace_id), runId: String(row.run_id), identity,
    kind: row.kind as WorkspaceOperationRecord['kind'], executionStage: row.execution_stage as WorkspaceOperationRecord['executionStage'], principalId: String(row.principal_id), commandId: String(row.command_id), requestDigest: String(row.request_digest),
    inputSnapshot: rowJson(row.input_snapshot, 'input_snapshot'), status: row.status as WorkspaceOperationRecord['status'], result: operationResultFromRow(row.result_json), revision: Number(row.revision), createdAtUtcMs: Number(row.created_at), updatedAtUtcMs: Number(row.updated_at) };
}

export function createSqliteWorkspaceAccess(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly nowUtcMs?: () => number;
  /** Trusted retention store only; it separately verifies release evidence and resource/Attempt CAS. */
  readonly allowRetentionFinalization?: boolean;
  /** Trusted cleaner store only; it separately verifies success, stop/release evidence and approval gates. */
  readonly allowCleanupFinalization?: boolean;
  /** Trusted discard store only; it separately re-verifies the preview binding, occupancy and stop gates. */
  readonly allowDiscardFinalization?: boolean;
}): WorkspaceOperationAccess {
  const db = session.database;
  const receipts = createSqliteCommandReceiptAccess(session);
  const now = () => {
    const value = options.nowUtcMs?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new StorageError('validation', 'Workspace', 'Invalid timestamp');
    return value;
  };
  const write = () => {
    if (!session.isOpen() || !db.inTransaction) throw new TypeError('Workspace mutation requires an open write transaction');
  };
  const fail = (kind: 'conflict' | 'ownership' | 'corrupt' | 'not_found', message: string, details?: Record<string, unknown>): never => {
    throw new StorageError(kind, 'Workspace', message, { entity: { type: 'workspace' }, details });
  };
  const json = (value: unknown, field: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(String(value));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('corrupt', `${field} is not a JSON object`);
      return parsed as Record<string, unknown>;
    } catch (cause) { throw new StorageError('corrupt', 'Workspace', `${field} is invalid JSON`, { cause }); }
  };
  const workspace = mapManagedWorkspaceRow;
  const operation = mapWorkspaceOperationRow;
  function readReceiptById(id: string): CommandReceipt {
    const row = db.prepare<[string], { principal_id: string; command_id: string }>('SELECT principal_id, command_id FROM command_receipts WHERE id = ?').get(id);
    if (!row) return fail('corrupt', 'workspace operation receipt is missing');
    const value = receipts.findReceiptByCommandId(row.principal_id, row.command_id);
    if (!value) return fail('corrupt', 'workspace operation receipt is unreadable');
    return value;
  }
  function event(projectId: string, featureId: string, operationId: string, runId: string, attemptId: string, stage: string, status: string, revision: number, timestamp: number): void {
    const sequence = (db.prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()?.next ?? 1);
    db.prepare(`INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, operation_id, run_id, attempt_id, execution_stage)
      VALUES (?, ?, 1, ?, ?, ?, 'workspace.operation_updated', 'feature', ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), timestamp, timestamp, projectId, sequence, featureId, revision,
      JSON.stringify({ schemaVersion: 1, operationId, status, executionStage: stage }), timestamp, operationId, runId, attemptId, stage);
  }
  function ensureIdentity(identity: WorkResourceIdentity): void {
    const snapshot = options.resources.read(identity);
    if (snapshot.leases.length !== 3 || snapshot.leases.some(lease => lease.state !== 'held' || lease.leaseUntilUtcMs <= now())) fail('ownership', 'workspace resource is not held by this owner/version');
  }
  function operationById(projectId: string, id: string): WorkspaceOperationRecord | null {
    return operation(db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE project_id = ? AND id = ?`).get(projectId, id) as WorkspaceRow | undefined);
  }
  function commitResult(input: BeginWorkspaceOperationInput | FinishWorkspaceOperationInput, ws: ManagedWorkspaceRecord, op: WorkspaceOperationRecord, receipt: CommandReceipt, replay: boolean): WorkspaceOperationCommit {
    return { workspace: ws, operation: op, receipt, replay };
  }
  const trustedFinalization = (kind: 'prepare' | 'retain' | 'cleanup' | 'discard') =>
    (kind === 'retain' && options.allowRetentionFinalization) || (kind === 'cleanup' && options.allowCleanupFinalization)
    || (kind === 'discard' && options.allowDiscardFinalization);
  function begin(raw: unknown): WorkspaceOperationCommit {
    write(); const input = validateBeginWorkspaceOperation(raw);
    const prior = receipts.findReceiptByCommandId(input.receipt.principalId, input.receipt.commandId);
    if (prior) {
      if (prior.requestDigest !== input.receipt.requestDigest) fail('conflict', 'commandId is already used with a different digest');
      const priorOp = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE principal_id = ? AND command_id = ?`).get(input.receipt.principalId, input.receipt.commandId) as WorkspaceRow | undefined;
      if (!priorOp) fail('conflict', 'command receipt exists without workspace operation');
      const mapped = operation(priorOp)!;
      if (mapped.id !== input.operationId || mapped.workspaceId !== input.workspaceId || !isDeepStrictEqual(mapped.identity, input.identity)) fail('conflict', 'commandId replay identity differs');
      const existingInput = JSON.stringify(mapped.inputSnapshot);
      const requestedInput = JSON.stringify({ schemaVersion: 1, featureId: input.featureId, kind: input.kind, executionStage: input.executionStage, baseline: input.baseline });
      if (existingInput !== requestedInput) fail('conflict', 'commandId replay input differs');
      return commitResult(input, workspace(db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE project_id = ? AND id = ?`).get(input.identity.projectId, mapped.workspaceId) as WorkspaceRow)!, mapped, prior, true);
    }
    if (trustedFinalization(input.kind)) options.resources.read(input.identity);
    else ensureIdentity(input.identity);
    const attempt = db.prepare<[string, string], { run_id: string; feature_id: string; owner_id: string; host_instance_id: string; execution_version: number }>(`SELECT a.run_id, t.feature_id, a.owner_id, a.host_instance_id, a.execution_version
      FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE a.project_id = ? AND a.id = ?`).get(input.identity.projectId, input.identity.attemptId);
    if (!attempt) fail('ownership', 'attempt execution identity mismatch');
    const attemptRow = attempt!;
    if (attemptRow.run_id === undefined || attemptRow.owner_id !== input.identity.owner || attemptRow.host_instance_id !== input.identity.hostInstanceId || attemptRow.execution_version !== input.identity.executionVersion) fail('ownership', 'attempt execution identity mismatch');
    if (attemptRow.feature_id !== input.featureId) fail('ownership', 'attempt belongs to another Feature');
    const binding = db.prepare<[string, string], { binding_revision: number; project_id: string; repo_identity: string; git_common_dir: string | null }>('SELECT binding_revision, project_id, repo_identity, git_common_dir FROM repository_bindings WHERE project_id = ? AND id = ?').get(input.identity.projectId, input.baseline.repositoryBindingId);
    if (!binding || binding.project_id !== input.identity.projectId || binding.binding_revision !== input.baseline.repositoryBindingRevision) fail('conflict', 'repository binding revision changed');
    if (binding!.repo_identity !== input.baseline.repoIdentity || binding!.git_common_dir !== input.baseline.gitCommonDir) fail('ownership', 'repository metadata mismatch');
    const resourceKey = `workspace:${createHash('sha256').update(JSON.stringify([input.baseline.repoIdentity, input.baseline.canonicalPath])).digest('hex')}`;
    const occupied = options.resources.read(input.identity);
    if ((!trustedFinalization(input.kind) || occupied.leases.length !== 0)
      && !occupied.leases.some(lease => lease.resourceKind === 'workspace' && lease.resourceKey === resourceKey)) fail('ownership', 'workspace path does not match held resource');
    if (input.kind === 'retain' && db.prepare('SELECT id FROM workspace_leases WHERE owner_id <> ? LIMIT 1').get(input.identity.attemptId)) fail('conflict', 'another execution occupies work resources');
    const existing = db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE project_id = ? AND feature_id = ?`).get(input.identity.projectId, input.featureId) as WorkspaceRow | undefined;
    if (existing && input.kind === 'prepare' && input.expectedWorkspaceRevision === null) fail('conflict', 'Feature already has a managed workspace');
    if (existing && input.kind === 'prepare' && !['ready', 'retained', 'quarantined'].includes(String(existing.status))) fail('conflict', 'workspace cannot be prepared again');
    if (!existing && input.kind !== 'prepare') fail('not_found', 'workspace is required for retain or cleanup');
    const existingWorkspace = workspace(existing);
    if (existingWorkspace && existingWorkspace.id !== input.workspaceId) fail('conflict', 'workspace identity differs');
    if (!existingWorkspace && input.expectedWorkspaceRevision !== null) fail('conflict', 'new workspace cannot have an expected revision');
    if (existingWorkspace && input.expectedWorkspaceRevision !== existingWorkspace.revision) fail('conflict', 'workspace revision conflict', { expectedWorkspaceRevision: input.expectedWorkspaceRevision, actualRevision: existingWorkspace.revision });
    if (existingWorkspace && JSON.stringify(input.baseline) !== JSON.stringify({ repositoryBindingId: existingWorkspace.repositoryBindingId, repositoryBindingRevision: existingWorkspace.repositoryBindingRevision, repoIdentity: existingWorkspace.repoIdentity, canonicalPath: existingWorkspace.canonicalPath, gitCommonDir: existingWorkspace.gitCommonDir, branch: existingWorkspace.branch, baseCommit: existingWorkspace.baseCommit })) fail('conflict', 'workspace baseline cannot be changed');
    const pathOwner = db.prepare('SELECT project_id FROM managed_workspaces WHERE canonical_path = ?').get(input.baseline.canonicalPath) as { project_id: string } | undefined;
    if (pathOwner && (!existingWorkspace || pathOwner.project_id !== input.identity.projectId)) fail(pathOwner.project_id === input.identity.projectId ? 'conflict' : 'ownership', 'canonical workspace path is already owned');
    const timestamp = now(); const inputSnapshot = { schemaVersion: 1, featureId: input.featureId, kind: input.kind, executionStage: input.executionStage, baseline: input.baseline };
    receipts.saveReceiptInTransaction(input.receipt);
    if (!existingWorkspace) db.prepare(`INSERT INTO managed_workspaces (${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.workspaceId, timestamp, input.identity.projectId, timestamp, input.featureId, input.baseline.repositoryBindingId, input.baseline.repositoryBindingRevision, input.baseline.repoIdentity, input.baseline.canonicalPath, input.baseline.gitCommonDir, input.baseline.branch, input.baseline.baseCommit, null, null, 'preparing', input.operationId, input.identity.owner, input.identity.hostInstanceId, input.identity.executionVersion, attemptRow.run_id, input.identity.attemptId);
    const workspaceRevision = existingWorkspace ? existingWorkspace.revision + 1 : 1;
    if (existingWorkspace) {
      const changed = db.prepare('UPDATE managed_workspaces SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(timestamp, existingWorkspace.id, existingWorkspace.revision);
      if (changed.changes !== 1) fail('conflict', 'workspace revision conflict');
    }
    const receiptRow = db.prepare<[string, string], { id: string }>('SELECT id FROM command_receipts WHERE principal_id = ? AND command_id = ?').get(input.receipt.principalId, input.receipt.commandId)!;
    db.prepare(`INSERT INTO workspace_operations (id, created_at, project_id, revision, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, result_json, receipt_id)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`).run(input.operationId, timestamp, input.identity.projectId, timestamp, input.featureId, input.workspaceId, attemptRow.run_id, input.identity.attemptId, input.identity.owner, input.identity.hostInstanceId, input.identity.executionVersion, input.kind, input.executionStage, input.receipt.principalId, input.receipt.commandId, input.receipt.requestDigest, JSON.stringify(inputSnapshot), receiptRow.id);
    event(input.identity.projectId, input.featureId, input.operationId, attemptRow.run_id, input.identity.attemptId, input.executionStage, 'pending', workspaceRevision, timestamp);
    return commitResult(input, workspace(db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE id = ?`).get(input.workspaceId) as WorkspaceRow)!, operation(db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE id = ?`).get(input.operationId) as WorkspaceRow)!, input.receipt, false);
  }
  function finish(raw: unknown): WorkspaceOperationCommit {
    write(); const input = validateFinishWorkspaceOperation(raw);
    const current = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE project_id = ? AND id = ?`).get(input.identity.projectId, input.operationId) as WorkspaceRow | undefined;
    if (!current) fail('not_found', 'workspace operation not found');
    const currentRow = current!;
    const op = operation(currentRow)!;
    if (!isDeepStrictEqual(op.identity, input.identity)) fail('ownership', 'stale workspace operation identity');
    const ws = workspace(db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE project_id = ? AND id = ?`).get(input.identity.projectId, op.workspaceId) as WorkspaceRow)!;
    const finishSnapshot = { status: input.status, workspaceStatus: input.workspaceStatus, headCommit: input.headCommit, codeDigest: input.codeDigest, result: input.result };
    if (op.status !== 'pending') {
      const terminalReceipt = readReceiptById(String(currentRow.receipt_id));
      if (terminalReceipt.principalId !== input.receipt.principalId || terminalReceipt.commandId !== input.receipt.commandId || terminalReceipt.requestDigest !== input.receipt.requestDigest) fail('conflict', 'workspace operation is already finalized');
      if (!isDeepStrictEqual(json(currentRow.finish_snapshot, 'finish_snapshot'), finishSnapshot)) fail('conflict', 'terminal workspace result differs');
      return commitResult(input, ws, op, terminalReceipt, true);
    }
    if (input.status !== 'blocked' && !trustedFinalization(op.kind)) ensureIdentity(input.identity);
    else options.resources.read(input.identity);
    if (input.status === 'succeeded' && ((op.kind === 'prepare' && input.workspaceStatus !== 'ready') || (op.kind === 'retain' && input.workspaceStatus !== 'retained') || (op.kind === 'cleanup' && input.workspaceStatus !== 'cleaned') || (op.kind === 'discard' && input.workspaceStatus !== 'cleaned'))) fail('conflict', 'workspace status does not match operation kind');
    if (op.revision !== input.expectedRevision || ws.revision !== input.expectedWorkspaceRevision) fail('conflict', 'workspace revision conflict', { expectedRevision: input.expectedRevision, actualRevision: op.revision });
    const receiptExisting = receipts.findReceiptByCommandId(input.receipt.principalId, input.receipt.commandId);
    if (receiptExisting && (receiptExisting.requestDigest !== input.receipt.requestDigest || !isDeepStrictEqual(receiptExisting.scope, input.receipt.scope)
      || db.prepare('SELECT id FROM workspace_operations WHERE receipt_id = (SELECT id FROM command_receipts WHERE principal_id = ? AND command_id = ?)').get(input.receipt.principalId, input.receipt.commandId))) fail('conflict', 'finish command is already used');
    if (!receiptExisting) receipts.saveReceiptInTransaction(input.receipt);
    const timestamp = now(); const result = JSON.stringify(input.result);
    const finalReceiptRow = db.prepare<[string, string], { id: string }>('SELECT id FROM command_receipts WHERE principal_id = ? AND command_id = ?').get(input.receipt.principalId, input.receipt.commandId)!;
    const changed = db.prepare(`UPDATE workspace_operations SET revision = revision + 1, updated_at = ?, status = ?, result_json = ?, receipt_id = ?, finish_snapshot = ? WHERE id = ? AND revision = ? AND status = 'pending'`).run(timestamp, input.status, result, finalReceiptRow.id, JSON.stringify(finishSnapshot), input.operationId, input.expectedRevision);
    if (changed.changes !== 1) fail('conflict', 'workspace operation revision conflict');
    const workspaceChanged = db.prepare(`UPDATE managed_workspaces SET revision = revision + 1, updated_at = ?, status = ?, head_commit = ?, code_digest = ? WHERE id = ? AND revision = ?`).run(timestamp, input.workspaceStatus, input.headCommit, input.codeDigest, op.workspaceId, input.expectedWorkspaceRevision);
    if (workspaceChanged.changes !== 1) fail('conflict', 'workspace revision conflict');
    event(input.identity.projectId, op.featureId, input.operationId, op.runId, input.identity.attemptId, op.executionStage, input.status, input.expectedWorkspaceRevision + 1, timestamp);
    return commitResult(input, workspace(db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE id = ?`).get(op.workspaceId) as WorkspaceRow)!, operation(db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE id = ?`).get(input.operationId) as WorkspaceRow)!, input.receipt, false);
  }
  function readWorkspace(projectId: unknown, featureId: unknown): ManagedWorkspaceRecord | null {
    const p = validateStableId(projectId, { operation: 'Workspace.read' }, 'projectId'), f = validateStableId(featureId, { operation: 'Workspace.read' }, 'featureId'); const row = db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM managed_workspaces WHERE project_id = ? AND feature_id = ?`).get(p, f) as WorkspaceRow | undefined; return workspace(row);
  }
  function readOperation(projectId: unknown, operationId: unknown): WorkspaceOperationRecord | null {
    const p = validateStableId(projectId, { operation: 'Workspace.read' }, 'projectId'), id = validateStableId(operationId, { operation: 'Workspace.read' }, 'operationId'); const foreign = db.prepare('SELECT project_id FROM workspace_operations WHERE id = ?').get(id) as { project_id: string } | undefined;
    if (foreign && foreign.project_id !== p) fail('ownership', 'operation belongs to another project');
    return operation(db.prepare(`SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE project_id = ? AND id = ?`).get(p, id) as WorkspaceRow | undefined);
  }
  function page(input: unknown, table: 'workspace' | 'operation'): WorkspacePage<ManagedWorkspaceRecord | WorkspaceOperationRecord> {
    const pageInput = validateWorkspacePage(input); const cursor = pageInput.cursor;
    const where = `project_id = ? AND (? IS NULL OR feature_id = ?) AND (? IS NULL OR id > ?)`;
    const params = [pageInput.projectId, pageInput.featureId, pageInput.featureId, cursor, cursor, pageInput.limit + 1];
    const rows = db.prepare(`SELECT ${table === 'workspace' ? WORKSPACE_COLUMNS : OPERATION_COLUMNS} FROM ${table === 'workspace' ? 'managed_workspaces' : 'workspace_operations'} WHERE ${where} ORDER BY id LIMIT ?`).all(...params) as WorkspaceRow[];
    const more = rows.length > pageInput.limit; const items = rows.slice(0, pageInput.limit).map(row => table === 'workspace' ? workspace(row)! : operation(row)!);
    return { items, nextCursor: more ? items.at(-1)!.id : null };
  }
  return { readWorkspace, readOperation, listWorkspaces: input => page(input, 'workspace') as WorkspacePage<ManagedWorkspaceRecord>, listOperations: input => page(input, 'operation') as WorkspacePage<WorkspaceOperationRecord>, beginInTransaction: begin, finishInTransaction: finish };
}
