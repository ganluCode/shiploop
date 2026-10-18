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

  function identity(snapshot: { attempt: ReturnType<typeof attempts.getAttempt> }) {
    return { projectId: snapshot.attempt.projectId, attemptId: snapshot.attempt.id,
      owner: snapshot.attempt.owner, hostInstanceId: snapshot.attempt.hostInstanceId,
      executionVersion: snapshot.attempt.executionVersion };
  }

  function updateAttemptDiagnostic(attemptId: string, evidenceRef: string, timestamp: number): void {
    const changed = db.prepare(`UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'interrupted'`).run(evidenceRef, timestamp, attemptId);
    if (changed.changes !== 1) fail('attempt_not_interrupted');
  }

  function updateWorkspace(workspace: ManagedWorkspaceRecord, status: 'retained' | 'quarantined',
    evidence: WorkRecoveryReconciliationEvidence, timestamp: number): void {
    if (workspace.status === 'cleaned') fail('workspace_cleaned');
    const headCommit = evidence.workspace?.headCommit ?? workspace.headCommit;
    const codeDigest = evidence.workspace?.codeDigest ?? workspace.codeDigest;
    if (workspace.status === status && workspace.headCommit === headCommit && workspace.codeDigest === codeDigest) return;
    const changed = db.prepare(`UPDATE managed_workspaces SET status = ?, head_commit = ?, code_digest = ?,
      revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND status <> 'cleaned'`)
      .run(status, headCommit, codeDigest, timestamp, workspace.projectId, workspace.id, workspace.revision);
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
        const pendingWorkspace = workspace === null ? [] : loadPendingWorkspaceOperations(source.projectId, source.runId, workspace.id);
        for (const operation of pendingWorkspace) {
          refs.push(...operation.result?.evidenceRefs ?? []);
          if (operation.result?.errorRef !== null && operation.result?.errorRef !== undefined) refs.push(operation.result.errorRef);
        }
        const alreadyReconciled = run.status === 'paused' && workspace?.status === 'retained'
          && resources.leases.length === 0;
        return {
          attempt, runStatus: run.status, workspace, session: sessionRecord, resources,
          artifacts: loadArtifacts(source.projectId, refs),
          pendingGitOperations: loadPendingGitOperations(source.projectId, source.runId),
          pendingWorkspaceOperations: pendingWorkspace,
          alreadyReconciled,
          priorEvidenceRef: attempt.diagnosticRef,
        };
      }
    },

    finish(source, evidence, evidenceRef, release: WorkRecoveryRelease) {
      session.transactWrite('WorkRecovery.finish', () => {
        const attempt = attempts.getAttempt(source.projectId, source.attemptId);
        assertSourceIdentity(source, attempt);
        if (attempt.status !== 'interrupted') fail('attempt_not_interrupted');
        const run = db.prepare<[string, string], { status: string; revision: number }>(
          'SELECT status, revision FROM runs WHERE project_id = ? AND id = ?').get(source.projectId, source.runId);
        if (run === undefined) fail('run_missing');
        if (['succeeded', 'failed', 'cancelled'].includes(run!.status)) fail('run_terminal');
        const workspace = loadWorkspace(source.projectId, attempt.featureId);
        if (workspace === null) fail('workspace_missing');
        if (workspace!.id !== evidence.workspace?.id) fail('workspace_identity_changed');
        const timestamp = now();
        updateAttemptDiagnostic(attempt.id, evidenceRef, timestamp);
        if (run!.status !== 'paused') {
          const changed = db.prepare(`UPDATE runs SET status = 'paused', reason = 'restart_recovery',
            revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?`)
            .run(timestamp, source.projectId, source.runId, run!.revision);
          if (changed.changes !== 1) fail('run_changed');
        }
        updateWorkspace(workspace!, 'retained', evidence, timestamp);
        const resourceIdentity = identity({ attempt });
        if (release.mode === 'stopped') options.resources.releaseRecoveredStoppedInTransaction(resourceIdentity, release.token);
        else if (release.mode === 'unstarted') options.resources.releaseRecoveredUnstartedInTransaction(resourceIdentity);
        else if (options.resources.readForRecovery(resourceIdentity).leases.length > 0) fail('recovered_occupancy_still_held');
      });
    },

    quarantine(source, evidence, evidenceRef) {
      session.transactWrite('WorkRecovery.quarantine', () => {
        const attempt = attempts.getAttempt(source.projectId, source.attemptId);
        assertSourceIdentity(source, attempt);
        if (attempt.status !== 'interrupted') fail('attempt_not_interrupted');
        const timestamp = now();
        updateAttemptDiagnostic(attempt.id, evidenceRef, timestamp);
        const workspace = loadWorkspace(source.projectId, attempt.featureId);
        if (workspace !== null) updateWorkspace(workspace, 'quarantined', evidence, timestamp);
        const resourceIdentity = identity({ attempt });
        const resources = options.resources.readForRecovery(resourceIdentity);
        if (resources.leases.length > 0) options.resources.quarantineRecoveredInTransaction(resourceIdentity);
      });
    },
  };
}
