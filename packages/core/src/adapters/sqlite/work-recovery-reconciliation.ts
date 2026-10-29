import { createSqliteVerificationStore } from './verification-store.js';
import { createSqliteDispatchRecovery, workRecoveryFingerprint } from './dispatch-recovery.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { GIT_OPERATION_COLUMNS, gitOperationRecordFromRow } from './git-operations.js';
import { SESSION_COLUMNS, workSessionRecordFromRow } from './work-session-store.js';
import { mapManagedWorkspaceRow, mapWorkspaceOperationRow } from './workspace.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';
import type { ArtifactRecord } from '../../ports/artifact-store.js';
import { StorageError } from '../../ports/errors.js';
import type { GitOperationRecord } from '../../ports/git-operations.js';
import type { WorkRecoveryReconciliationEvidence, WorkRecoveryReconciliationSnapshot,
  WorkRecoveryReconciliationStore, WorkRecoveryRelease } from '../../ports/work-recovery-reconciliation.js';
import type { WorkResourceAccess, WorkResourceSnapshot } from '../../ports/work-resources.js';
import type { WorkStartupRecoveryEvidence } from '../../ports/work-startup-recovery.js';
import type { ManagedWorkspaceRecord, WorkspaceOperationRecord } from '../../ports/workspace.js';

interface ArtifactRow {
  id: string; project_id: string; kind: string; media_type: string; status: string; expected_hash: string;
  content_hash: string | null; size_bytes: number | null; storage_locator: string; version: number;
  failure_reason: string | null; revision: number; created_at: number; updated_at: number;
}

const ARTIFACT_LIMIT = 64;
const GIT_OPERATION_LIMIT = 16;
const WORKSPACE_OPERATION_LIMIT = 16;

function artifactFromRow(row: ArtifactRow, operation = 'WorkRecovery.artifacts'): ArtifactRecord {
  if (!['pending', 'ready', 'failed'].includes(row.status)) {
    throw new StorageError('corrupt', operation, 'Invalid stored artifact status', {
      entity: { type: 'artifact', id: row.id, projectId: row.project_id },
    });
  }
  return {
    id: row.id, projectId: row.project_id, kind: row.kind, mediaType: row.media_type,
    status: row.status as ArtifactRecord['status'], expectedHash: row.expected_hash,
    contentHash: row.content_hash, sizeBytes: row.size_bytes, locator: row.storage_locator,
    version: row.version, failureReason: row.failure_reason, revision: row.revision,
    createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
  };
}

function fail(reason: string): never {
  throw new StorageError('conflict', 'WorkRecovery', reason, { details: { reason } });
}

export function createSqliteWorkRecoveryReconciliationStore(session: SqliteStorageSession, options: {
  readonly resources: WorkResourceAccess;
  readonly nowUtcMs?: () => number;
}): WorkRecoveryReconciliationStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const dispatch = createSqliteDispatchRecovery(session);
  const attempts = createSqliteAttemptAccess(session);

  function loadWorkspace(projectId: string, featureId: string): ManagedWorkspaceRecord | null {
    const row = db.prepare('SELECT * FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
      .get(projectId, featureId) as Record<string, unknown> | undefined;
    return mapManagedWorkspaceRow(row);
  }

  function loadSession(attemptId: string) {
    const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE attempt_id = ?`)
      .get(attemptId) as Parameters<typeof workSessionRecordFromRow>[0] | undefined;
    return row === undefined ? null : workSessionRecordFromRow(row);
  }

  function loadArtifacts(projectId: string, ids: readonly string[]): ArtifactRecord[] {
    const unique = [...new Set(ids)].slice(0, ARTIFACT_LIMIT);
    if (unique.length === 0) return [];
    const rows = db.prepare(`SELECT id, project_id, kind, media_type, status, expected_hash, content_hash,
      size_bytes, storage_locator, version, failure_reason, revision, created_at, updated_at
      FROM artifacts WHERE project_id = ? AND id IN (${unique.map(() => '?').join(',')}) ORDER BY id`)
      .all(projectId, ...unique) as ArtifactRow[];
    return rows.map(row => artifactFromRow(row));
  }

  function loadPendingGitOperations(projectId: string, runId: string): GitOperationRecord[] {
    const rows = db.prepare(`SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations
      WHERE project_id = ? AND run_id = ? AND status = 'pending' ORDER BY id LIMIT ${GIT_OPERATION_LIMIT}`)
      .all(projectId, runId) as Parameters<typeof gitOperationRecordFromRow>[0][];
    return rows.map(row => gitOperationRecordFromRow(row));
  }

  function loadPendingWorkspaceOperations(projectId: string, runId: string,
    workspaceId: string | null): WorkspaceOperationRecord[] {
    const rows = db.prepare(`SELECT * FROM workspace_operations WHERE project_id = ? AND status = 'pending'
      AND (run_id = ? ${workspaceId === null ? '' : 'OR workspace_id = ?'}) ORDER BY id LIMIT ${WORKSPACE_OPERATION_LIMIT}`)
      .all(projectId, runId, ...(workspaceId === null ? [] : [workspaceId])) as Record<string, unknown>[];
    return rows.map(row => mapWorkspaceOperationRow(row)!);
  }

  function assertSourceIdentity(source: WorkStartupRecoveryEvidence, attempt: ReturnType<typeof attempts.getAttempt>): void {
    if (attempt.projectId !== source.projectId || attempt.runId !== source.runId
      || attempt.owner !== source.owner || attempt.hostInstanceId !== source.hostInstanceId
      || attempt.executionVersion !== source.executionVersion) fail('source_identity_changed');
  }

  function dispatchAttempt(attempt: ReturnType<typeof attempts.getAttempt>) {
    return { id: attempt.id, project_id: attempt.projectId, feature_id: attempt.featureId, run_id: attempt.runId,
      owner_id: attempt.owner, host_instance_id: attempt.hostInstanceId, execution_version: attempt.executionVersion };
  }

  function assertFingerprint(attemptId: string, expected: string | undefined) {
    if (expected === undefined || expected !== workRecoveryFingerprint(session, attemptId)) fail('recovery_snapshot_changed');
  }

  function identity(snapshot: { attempt: ReturnType<typeof attempts.getAttempt> }) {
    return { projectId: snapshot.attempt.projectId, attemptId: snapshot.attempt.id,
      owner: snapshot.attempt.owner, hostInstanceId: snapshot.attempt.hostInstanceId,
      executionVersion: snapshot.attempt.executionVersion };
  }

  function assertEvidenceRef(evidenceRef: string, projectId: string): void {
    const artifact = db.prepare<[string], { project_id: string; status: string }>(
      'SELECT project_id, status FROM artifacts WHERE id = ?',
    ).get(evidenceRef);
    if (artifact === undefined || artifact.project_id !== projectId || artifact.status !== 'ready') {
      fail('evidence_reference_invalid');
    }
  }

  function assertEvidenceIdentity(source: WorkStartupRecoveryEvidence,
    attempt: ReturnType<typeof attempts.getAttempt>, evidence: WorkRecoveryReconciliationEvidence,
    expectedStatus: WorkRecoveryReconciliationEvidence['status']): void {
    if (evidence.schemaVersion !== 1 || evidence.kind !== 'work-recovery-reconciliation'
      || evidence.status !== expectedStatus || evidence.projectId !== source.projectId
      || evidence.featureId !== attempt.featureId || evidence.runId !== source.runId
      || evidence.taskId !== attempt.taskId || evidence.attemptId !== attempt.id
      || evidence.owner !== attempt.owner || evidence.hostInstanceId !== attempt.hostInstanceId
      || evidence.executionVersion !== attempt.executionVersion) {
      fail('recovery_evidence_identity_changed');
    }
    const workspace = loadWorkspace(source.projectId, attempt.featureId);
    if (evidence.workspace !== null && (workspace === null || evidence.workspace.id !== workspace.id)) {
      fail('workspace_identity_changed');
    }
  }

  function assertCurrentWorkspaceOwner(workspace: ManagedWorkspaceRecord, attempt: ReturnType<typeof attempts.getAttempt>): void {
    if (workspace.projectId !== attempt.projectId || workspace.featureId !== attempt.featureId
      || workspace.runId !== attempt.runId || workspace.attemptId !== attempt.id
      || workspace.ownerId !== attempt.owner || workspace.hostInstanceId !== attempt.hostInstanceId
      || workspace.executionVersion !== attempt.executionVersion) fail('workspace_identity_changed');
  }

  function updateAttemptDiagnostic(attemptId: string, evidenceRef: string, timestamp: number): void {
    const changed = db.prepare(`UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'interrupted'`).run(evidenceRef, timestamp, attemptId);
    if (changed.changes !== 1) fail('attempt_not_interrupted');
  }

  function updateWorkspace(workspace: ManagedWorkspaceRecord, attempt: ReturnType<typeof attempts.getAttempt>,
    status: 'retained' | 'quarantined', evidence: WorkRecoveryReconciliationEvidence, timestamp: number): void {
    assertCurrentWorkspaceOwner(workspace, attempt);
    if (workspace.status === 'cleaned') fail('workspace_cleaned');
    const headCommit = evidence.workspace?.headCommit ?? workspace.headCommit;
    const codeDigest = evidence.workspace?.codeDigest ?? workspace.codeDigest;
    if (workspace.status === status && workspace.headCommit === headCommit && workspace.codeDigest === codeDigest) return;
    const changed = db.prepare(`UPDATE managed_workspaces SET status = ?, head_commit = ?, code_digest = ?,
      revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND status <> 'cleaned'
      AND feature_id = ? AND run_id = ? AND attempt_id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ?`)
      .run(status, headCommit, codeDigest, timestamp, workspace.projectId, workspace.id, workspace.revision,
        attempt.featureId, attempt.runId, attempt.id, attempt.owner, attempt.hostInstanceId, attempt.executionVersion);
    if (changed.changes !== 1) fail('workspace_identity_changed');
  }

  return {
    load(source) {
      return session.database.inTransaction ? load() : transactSqliteConsistentRead(session, 'WorkRecovery.load', load);
      function load(): WorkRecoveryReconciliationSnapshot {
        const attempt = attempts.getAttempt(source.projectId, source.attemptId);
        assertSourceIdentity(source, attempt);
        const run = db.prepare<[string, string], { status: string }>('SELECT status FROM runs WHERE project_id = ? AND id = ?')
          .get(source.projectId, source.runId);
        if (run === undefined) fail('run_missing');
        const workspace = loadWorkspace(source.projectId, attempt.featureId);
        const sessionRecord = loadSession(attempt.id);
        const resources: WorkResourceSnapshot = options.resources.readForRecovery({
          projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
          hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
        });
        const recoverySelection = attempt.inputSnapshot.rework?.recovery.selection;
        const recoverySource = recoverySelection !== undefined && recoverySelection.mode !== 'new'
          ? recoverySelection.source : undefined;
        // The immutable Task input snapshot is validated by the execution input path;
        // recovery verifies its own diagnosis, code and Recorder/result Artifacts.
        const refs = [attempt.codeRef, attempt.diagnosticRef,
          sessionRecord?.resultRef ?? null,
          recoverySource?.nativeArchiveRef ?? null].filter((value): value is string => value !== null);
        const verificationGaps: string[] = [];
        const verification = createSqliteVerificationStore(session);
        const verificationBatches = verification.listAttemptVerificationBatches(source.projectId, attempt.id);
        if (verificationBatches.length > 64) verificationGaps.push('verification_history_limit');
        for (const batch of verificationBatches.slice(0, 64)) {
          if (batch.status === 'running') verificationGaps.push('verification_batch_incomplete');
          if (batch.taskId !== attempt.taskId || batch.runId !== attempt.runId || batch.featureId !== attempt.featureId
            || batch.executionVersion !== attempt.executionVersion
            || batch.policyDigest !== attempt.inputSnapshot.approval?.checkPolicyDigest) verificationGaps.push('verification_identity_mismatch');
          const results = verification.listCheckResults(source.projectId, batch.id);
          if (batch.checkSnapshot.some(check => (check.required || batch.selection.selectedCheckKeys.includes(check.checkKey))
            && !results.some(result => result.checkKey === check.checkKey))) verificationGaps.push('verification_checks_missing');
          for (const check of results) {
            const evidence = verification.readCheckResultEvidence(source.projectId, check.id);
            if (evidence.status !== 'complete') verificationGaps.push('verification_output_incomplete');
            else refs.push(evidence.artifactId);
          }
        }
        const pendingWorkspace = workspace === null ? [] : loadPendingWorkspaceOperations(source.projectId, source.runId, workspace.id);
        for (const operation of pendingWorkspace) {
          refs.push(...operation.result?.evidenceRefs ?? []);
          if (operation.result?.errorRef !== null && operation.result?.errorRef !== undefined) refs.push(operation.result.errorRef);
        }
        if (new Set(refs).size > 64) verificationGaps.push('verification_artifact_limit');
        const dispatchLink = dispatch.link(dispatchAttempt(attempt));
        const alreadyReconciled = run.status === 'paused' && workspace?.status === 'retained'
          && resources.leases.length === 0 && dispatchLink.gaps.length === 0
          && (dispatchLink.claim === null || dispatchLink.claim.state === 'released');
        return {
          verificationGaps, verificationCodeDigests: verificationBatches.map(batch => batch.codeDigest),
          recoveryFingerprint: workRecoveryFingerprint(session, attempt.id), dispatchGaps: dispatchLink.gaps,
          attempt, runStatus: run.status, workspace, session: sessionRecord, resources,
          artifacts: loadArtifacts(source.projectId, refs),
          pendingGitOperations: loadPendingGitOperations(source.projectId, source.runId),
          pendingWorkspaceOperations: pendingWorkspace,
          alreadyReconciled,
          priorEvidenceRef: attempt.diagnosticRef,
        };
      }
    },

    finish(source, evidence, evidenceRef, release: WorkRecoveryRelease, expectedFingerprint) {
      session.transactWrite('WorkRecovery.finish', () => {
        assertFingerprint(source.attemptId, expectedFingerprint);
        const attempt = attempts.getAttempt(source.projectId, source.attemptId);
        assertSourceIdentity(source, attempt);
        assertEvidenceRef(evidenceRef, source.projectId);
        assertEvidenceIdentity(source, attempt, evidence, 'reconciled');
        if (attempt.status !== 'interrupted') fail('attempt_not_interrupted');
        const run = db.prepare<[string, string], { status: string; revision: number }>(
          'SELECT status, revision FROM runs WHERE project_id = ? AND id = ?').get(source.projectId, source.runId);
        if (run === undefined) fail('run_missing');
        if (!['interrupted', 'paused'].includes(run!.status)) fail('run_not_recoverable');
        const batch = db.prepare<[string], { status: string }>(
          'SELECT b.status FROM execution_batches b JOIN runs r ON r.batch_id = b.id WHERE r.id = ?').get(source.runId);
        if (!batch || !['queued', 'running', 'pausing', 'paused'].includes(batch.status)) fail('batch_not_recoverable');
        const task = db.prepare<[string], { execution_version: number }>('SELECT execution_version FROM tasks WHERE id = ?').get(attempt.taskId);
        if (task?.execution_version !== attempt.executionVersion + 1) fail('stale_recovery_identity');
        if (evidence.status !== 'reconciled' || evidence.gaps.length !== 0) fail('reconciliation_incomplete');
        const workspace = loadWorkspace(source.projectId, attempt.featureId);
        if (workspace === null) fail('workspace_missing');
        assertCurrentWorkspaceOwner(workspace, attempt);
        if (workspace.id !== evidence.workspace?.id) fail('workspace_identity_changed');
        const timestamp = now();
        updateAttemptDiagnostic(attempt.id, evidenceRef, timestamp);
        if (run!.status !== 'paused') {
          const changed = db.prepare(`UPDATE runs SET status = 'paused', reason = 'restart_recovery',
            revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?`)
            .run(timestamp, source.projectId, source.runId, run!.revision);
          if (changed.changes !== 1) fail('run_changed');
        }
        updateWorkspace(workspace!, attempt, 'retained', evidence, timestamp);
        // F-016：恢复核对成功后，遗留 Attempt 已确认停止且无其他活动 Attempt；
        // Task 不能继续停留在 running，否则显式 resume 的 DAG 预演会把历史执行
        // 误判为 resource_busy。这里只回退未通过、无活动占用的 Task，不触碰已
        // passed/failed 记录，也不恢复旧 executionVersion 的写资格。
        db.prepare(`UPDATE tasks SET status = 'pending', revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND id = ? AND status = 'running'
            AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.project_id = tasks.project_id
              AND attempts.task_id = tasks.id AND attempts.status IN ('preparing', 'executing', 'verifying'))`)
          .run(timestamp, source.projectId, attempt.taskId);
        const resourceIdentity = identity({ attempt });
        if (release.mode === 'stopped') options.resources.releaseRecoveredStoppedInTransaction(resourceIdentity, release.token);
        else if (release.mode === 'unstarted') options.resources.releaseRecoveredUnstartedInTransaction(resourceIdentity);
        else if (options.resources.readForRecovery(resourceIdentity).leases.length > 0) fail('recovered_occupancy_still_held');
        dispatch.releaseForAttempt(dispatchAttempt(attempt), timestamp);
      });
    },

    quarantine(source, evidence, evidenceRef, expectedFingerprint) {
      session.transactWrite('WorkRecovery.quarantine', () => {
        assertFingerprint(source.attemptId, expectedFingerprint);
        const attempt = attempts.getAttempt(source.projectId, source.attemptId);
        assertSourceIdentity(source, attempt);
        assertEvidenceRef(evidenceRef, source.projectId);
        assertEvidenceIdentity(source, attempt, evidence, 'quarantined');
        const task = db.prepare<[string], { execution_version: number }>('SELECT execution_version FROM tasks WHERE id = ?').get(attempt.taskId);
        if (task?.execution_version !== attempt.executionVersion + 1
          || dispatch.link(dispatchAttempt(attempt)).gaps.includes('dispatch_generation_changed')) fail('stale_recovery_identity');
        if (attempt.status !== 'interrupted') fail('attempt_not_interrupted');
        const timestamp = now();
        updateAttemptDiagnostic(attempt.id, evidenceRef, timestamp);
        const workspace = loadWorkspace(source.projectId, attempt.featureId);
        if (workspace !== null) {
          assertCurrentWorkspaceOwner(workspace, attempt);
          updateWorkspace(workspace, attempt, 'quarantined', evidence, timestamp);
        }
        const resourceIdentity = identity({ attempt });
        const resources = options.resources.readForRecovery(resourceIdentity);
        if (resources.leases.length > 0) options.resources.quarantineRecoveredInTransaction(resourceIdentity);
      });
    },
  };
}
