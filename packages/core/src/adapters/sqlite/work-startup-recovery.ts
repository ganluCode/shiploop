import { readVerificationProcesses } from './verification-processes.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';
import { GLOBAL_SETTINGS_ID } from '../../ports/state-store.js';
import { mapStateEvent, type PersistedStateEventRow } from '../../ports/events.js';
import type { WorkStartupRecoveryEvidence, WorkStartupRecoveryStore, WorkStartupRecoveryTarget } from '../../ports/work-startup-recovery.js';
import { createSqliteDispatchRecovery } from './dispatch-recovery.js';
import type { SqliteStorageSession } from './session.js';

const LIMIT = 128;
type RecoveryPhase = 'fenced' | 'observed' | 'recorded' | 'reprobed' | 'run_interrupted' | 'scan_limited' | 'failed';
interface AttemptRow {
  id: string; project_id: string; run_id: string; task_id: string; feature_id: string;
  owner_id: string; host_instance_id: string; execution_version: number; execution_stage: string;
  status: string; revision: number; started_at: number | null; created_at: number;
  input_snapshot: string;
}
interface LeaseRow {
  project_id: string; owner_id: string; host_instance_id: string; execution_version: number;
  process_identity: string | null; resource_kind: string; resource_key: string;
}

/** Reuses domain rows, diagnostic Artifact refs and transactional events; no second recovery database. */
export function createSqliteWorkStartupRecoveryStore(session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {}): WorkStartupRecoveryStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const dispatch = createSqliteDispatchRecovery(session, { nowUtcMs: now });
  function findEvent(phase: RecoveryPhase, id: string) {
    const row = db.prepare<[string, string], Omit<PersistedStateEventRow, 'payload'> & { payload: string }>(`SELECT
      id, sequence, event_type AS eventType, aggregate_type AS aggregateType, aggregate_id AS aggregateId,
      aggregate_revision AS aggregateRevision, project_id AS projectId, payload, occurred_at AS occurredAtUtcMs
      FROM state_events WHERE event_type IN ('work.recovery.updated', 'work.recovery.blocked')
      AND json_extract(payload, '$.phase') = ? AND COALESCE(attempt_id, aggregate_id) = ? LIMIT 1`)
      .get(phase, id === 'work-startup-recovery' ? GLOBAL_SETTINGS_ID : id);
    if (row) mapStateEvent({ ...row, payload: JSON.parse(row.payload) }, 'Work.startupRecovery.events');
    return row;
  }
  function findLatestObservation(id: string) {
    const row = db.prepare<[string], Omit<PersistedStateEventRow, 'payload'> & { payload: string }>(`SELECT
      id, sequence, event_type AS eventType, aggregate_type AS aggregateType, aggregate_id AS aggregateId,
      aggregate_revision AS aggregateRevision, project_id AS projectId, payload, occurred_at AS occurredAtUtcMs
      FROM state_events WHERE event_type IN ('work.recovery.updated', 'work.recovery.blocked')
      AND json_extract(payload, '$.phase') IN ('observed', 'recorded', 'reprobed')
      AND attempt_id = ? ORDER BY sequence DESC LIMIT 1`).get(id);
    if (row) mapStateEvent({ ...row, payload: JSON.parse(row.payload) }, 'Work.startupRecovery.events');
    return row;
  }
  function hasRecordedObservation(id: string): boolean {
    return db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM state_events
      WHERE event_type IN ('work.recovery.updated', 'work.recovery.blocked')
      AND json_extract(payload, '$.phase') IN ('recorded', 'reprobed') AND attempt_id = ?`).get(id)!.n > 0;
  }
  function event(phase: RecoveryPhase, projectId: string | null, runId: string | null,
    payload: object, attemptId: string | null = null, stage: string | null = null) {
    const timestamp = now();
    const aggregateId = runId ?? GLOBAL_SETTINGS_ID;
    const revision = projectId === null
      ? db.prepare<[string], { revision: number }>('SELECT revision FROM global_settings WHERE id = ?').get(GLOBAL_SETTINGS_ID)?.revision ?? 1
      : db.prepare<[string], { revision: number }>('SELECT revision FROM runs WHERE id = ?').get(aggregateId)!.revision;
    db.prepare(`INSERT INTO state_events (id, created_at, updated_at, revision, project_id, sequence,
      event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, run_id, attempt_id, execution_stage)
      VALUES (?, ?, ?, 1, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM state_events), ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), timestamp, timestamp, projectId, projectId === null ? 'work.recovery.blocked' : 'work.recovery.updated',
        projectId === null ? 'global_settings' : 'run', aggregateId,
        revision, JSON.stringify({ ...payload, phase }), timestamp, runId, attemptId, stage);
  }
  function assertRecoveryArtifact(id: string, projectId: string): void {
    const artifact = db.prepare<[string], { project_id: string; status: string }>(
      'SELECT project_id, status FROM artifacts WHERE id = ?',
    ).get(id);
    if (artifact === undefined || artifact.project_id !== projectId || artifact.status !== 'ready') {
      throw new TypeError('Recovery evidence Artifact is not ready in the same project');
    }
  }

  function isDeeplyEqualProcessIdentity(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right);
  }
  return {
    fence() {
      return session.transactWrite('Work.startupRecovery.fence', () => {
        const timestamp = now();
        const census = dispatch.fence(timestamp);
        const rows = db.prepare<string[], AttemptRow>(`SELECT a.* FROM attempts a WHERE
          a.status IN ('preparing', 'executing', 'verifying') OR EXISTS
            (SELECT 1 FROM workspace_leases l WHERE l.owner_id = a.id)
          ${census.attemptIds.length === 0 ? '' : `OR a.id IN (${census.attemptIds.map(() => '?').join(',')})`}
          ORDER BY a.id LIMIT ${LIMIT + 1}`).all(...census.attemptIds);
        const runs = db.prepare<[], { id: string; project_id: string; revision: number; status: string }>(`SELECT id, project_id, revision, status
          FROM runs WHERE status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted') ORDER BY id LIMIT ${LIMIT + 1}`).all();
        let limited = census.limited || rows.length > LIMIT || runs.length > LIMIT;
        const targets: WorkStartupRecoveryTarget[] = [];
        for (const row of rows.slice(0, LIMIT)) {
          const leases = db.prepare<[string], LeaseRow>('SELECT * FROM workspace_leases WHERE owner_id = ? ORDER BY resource_kind, resource_key LIMIT 4').all(row.id);
          const gaps: string[] = [...(census.gaps.get(row.id) ?? dispatch.link(row).gaps)];
          if (leases.length !== 3 || leases[0]?.resource_key !== 'global:execution'
            || leases[1]?.resource_key !== `project:${row.project_id}:work` || leases[2]?.resource_kind !== 'workspace') gaps.push('incomplete_resource_group');
          if (leases.some(l => l.project_id !== row.project_id || l.owner_id !== row.id
            || l.host_instance_id !== row.host_instance_id || l.execution_version !== row.execution_version)) gaps.push('lease_identity_mismatch');
          if (leases.some(l => l.process_identity !== leases[0]?.process_identity)) gaps.push('process_identity_mismatch');
          let processIdentity = null;
          try {
            const raw = leases[0]?.process_identity;
            if (raw !== null && raw !== undefined) {
              const { schemaVersion, ...identity } = JSON.parse(raw);
              if (schemaVersion !== 2) throw new Error('unsupported_process_identity');
              processIdentity = validateWorkProcessIdentity(identity);
            }
          } catch { gaps.push('invalid_process_identity'); }
          /* P05-1 / F-010：planning Attempt 额外核对输入快照绑定、候选发布与审计
           * 水位（任一漂移都作为 gap 保留隔离，不从原生历史或租约过期推断安全）。 */
          try {
            const snapshot = JSON.parse(row.input_snapshot) as { candidateId?: unknown; purpose?: unknown };
            if (snapshot?.purpose === 'planning' && typeof snapshot.candidateId === 'string') {
              const context = db.prepare<[string, string], { planning_task_id: string; candidate_id: string;
                status: string; candidate_artifact_id: string | null }>(
                'SELECT planning_task_id, candidate_id, status, candidate_artifact_id FROM planning_contexts WHERE project_id = ? AND run_id = ?',
              ).get(row.project_id, row.run_id);
              if (context === undefined || context.planning_task_id !== row.task_id
                || context.candidate_id !== snapshot.candidateId) gaps.push('planning_context_binding_mismatch');
              else if (context.candidate_artifact_id !== null
                && !db.prepare<[string, string], { n: number }>(
                  "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND id = ? AND status = 'ready'",
                ).get(row.project_id, context.candidate_artifact_id)!.n) gaps.push('planning_candidate_artifact_missing');
              const sessionRow = db.prepare<[string], { status: string; recording_watermark: number | null }>(
                'SELECT status, recording_watermark FROM sessions WHERE attempt_id = ?').get(row.id);
              if (sessionRow !== undefined && sessionRow.status !== 'reserved' && sessionRow.recording_watermark === null) {
                gaps.push('planning_recording_watermark_missing');
              }
            }
          } catch { gaps.push('planning_input_snapshot_invalid'); }
          const workspace = db.prepare<[string, string], { id: string; project_id: string; owner_id: string; host_instance_id: string; execution_version: number; revision: number; run_id: string; attempt_id: string }>(
            'SELECT id, project_id, revision, owner_id, host_instance_id, execution_version, run_id, attempt_id FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
            .get(row.project_id, row.feature_id);
          if (workspace && (workspace.owner_id !== row.owner_id || workspace.host_instance_id !== row.host_instance_id
            || workspace.execution_version !== row.execution_version || workspace.run_id !== row.run_id
            || workspace.attempt_id !== row.id)) gaps.push('workspace_identity_mismatch');
          let verificationProcesses: ReturnType<typeof readVerificationProcesses> | undefined = undefined;
          try { verificationProcesses = readVerificationProcesses(session, row.project_id, row.id); }
          catch { gaps.push('verifier_process_census_incomplete'); }
          const target: WorkStartupRecoveryTarget = { projectId: row.project_id, runId: row.run_id, attemptId: row.id,
            ...(verificationProcesses?.length ? { verificationProcesses } : {}),
            owner: row.owner_id, hostInstanceId: row.host_instance_id, executionVersion: row.execution_version,
            executionStage: row.execution_stage, processIdentity, gaps };
          const fenced = findEvent('fenced', row.id);
          if (fenced) {
            const previous = JSON.parse(fenced.payload) as WorkStartupRecoveryTarget & { processIdentity: unknown; gaps: unknown };
            if (previous.projectId !== target.projectId || previous.runId !== target.runId
              || previous.attemptId !== target.attemptId || previous.owner !== target.owner
              || previous.hostInstanceId !== target.hostInstanceId || previous.executionVersion !== target.executionVersion
              || previous.executionStage !== target.executionStage
              || !isDeepStrictEqual(previous.processIdentity, processIdentity)
              || !isDeepStrictEqual(previous.verificationProcesses, target.verificationProcesses) || !Array.isArray(previous.gaps)) {
              throw new TypeError('Persisted recovery fence changed');
            }
            gaps.push(...previous.gaps);
          } else {
            // Advance the Task fence, never mutate the immutable historical Attempt identity.
            const terminal = !['preparing', 'executing', 'verifying', 'interrupted'].includes(row.status);
            const changed = terminal ? { changes: 0 } : db.prepare(`UPDATE tasks SET execution_version = execution_version + 1,
              revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND execution_version = ?
                AND execution_version < ${Number.MAX_SAFE_INTEGER}`)
              .run(timestamp, row.project_id, row.task_id, row.execution_version);
            if (terminal) gaps.push('terminal_attempt_reconciliation_required');
            else if (changed.changes === 0) gaps.push('task_version_mismatch');
            if (['preparing', 'executing', 'verifying'].includes(row.status)) {
              db.prepare(`UPDATE attempts SET status = 'interrupted', error_kind = COALESCE(error_kind, 'runtime'),
                ended_at = COALESCE(ended_at, ?), revision = revision + 1, updated_at = ?
                WHERE project_id = ? AND id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ?`)
                .run(Math.max(timestamp, row.started_at ?? row.created_at), timestamp, row.project_id, row.id,
                  row.owner_id, row.host_instance_id, row.execution_version);
            }
            event('fenced', row.project_id, row.run_id,
              { schemaVersion: 1, ...target, stopConfirmed: false, workspaceReconciled: false }, row.id, row.execution_stage);
          }
          db.prepare(`UPDATE workspace_leases SET state = 'quarantined', revision = revision + 1, updated_at = ?
            WHERE project_id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND state <> 'quarantined'`)
            .run(timestamp, row.project_id, row.id, row.host_instance_id, row.execution_version);
          const workspaceOwnerActive = workspace !== undefined && db.prepare<[string], { id: string }>(
            "SELECT id FROM attempts WHERE id = ? AND status IN ('preparing', 'executing', 'verifying') LIMIT 1",
          ).get(workspace.attempt_id) !== undefined;
          if (workspace && !workspaceOwnerActive) {
            db.prepare(`UPDATE managed_workspaces SET status = 'quarantined', revision = revision + 1, updated_at = ?
              WHERE project_id = ? AND id = ? AND revision = ? AND status <> 'cleaned'`)
              .run(timestamp, workspace.project_id, workspace.id, workspace.revision);
          }
          if (!hasRecordedObservation(row.id)) targets.push(target);
        }
        for (const run of runs.slice(0, LIMIT)) {
          // A queued authorization with no claim has no old execution to resume. Keep it
          // available after the gate; scanning itself never dispatches it or starts Runtime.
          const hasAttempt = db.prepare('SELECT id FROM attempts WHERE run_id = ? LIMIT 1').get(run.id);
          if ((run.status === 'queued' && !hasAttempt) || run.status === 'paused' || run.status === 'interrupted' || run.status === 'cancelling') continue;
          db.prepare(`UPDATE runs SET status = 'interrupted', reason = 'restart_recovery',
            revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ?`).run(timestamp, run.project_id, run.id);
          event('run_interrupted', run.project_id, run.id,
            { schemaVersion: 1, reason: 'restart_recovery' });
        }
        // Reuse durable stop observations until Git/workspace/recording reconciliation has completed.
        // Historical observations for a different current workspace or dispatch generation grant no authority.
        const recordedRows = db.prepare<[], { payload: string }>(`SELECT e.payload FROM state_events e
          JOIN attempts a ON a.id = e.attempt_id
          JOIN runs r ON r.project_id = a.project_id AND r.id = a.run_id
          LEFT JOIN managed_workspaces w ON w.project_id = a.project_id AND w.feature_id = a.feature_id
          WHERE e.event_type = 'work.recovery.updated' AND json_extract(e.payload, '$.phase') IN ('recorded', 'reprobed')
            AND e.sequence = (SELECT MAX(latest.sequence) FROM state_events latest
              WHERE latest.event_type = 'work.recovery.updated' AND latest.attempt_id = e.attempt_id
                AND json_extract(latest.payload, '$.phase') IN ('recorded', 'reprobed'))
            AND a.status = 'interrupted'
            AND (w.attempt_id IS NULL OR w.attempt_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM run_dispatch_claims c WHERE c.run_id = a.run_id
              AND c.state IN ('held', 'quarantined') AND c.id IS NOT json_extract(
                (SELECT receipt FROM task_claim_receipts WHERE attempt_id = a.id), '$.dispatch.claimId'))
            AND NOT (r.status = 'paused' AND COALESCE(w.status, '') = 'retained'
              AND NOT EXISTS (SELECT 1 FROM workspace_leases l WHERE l.owner_id = a.id))
          ORDER BY e.sequence LIMIT ${LIMIT + 1}`).all();
        limited ||= recordedRows.length > LIMIT;
        if (limited && !findEvent('scan_limited', 'work-startup-recovery')) {
          event('scan_limited', null, null, { schemaVersion: 1, limit: LIMIT });
        }
        const reconcilable = recordedRows.slice(0, LIMIT).map(row => JSON.parse(row.payload) as WorkStartupRecoveryEvidence);
        const pendingIds = new Set([...targets, ...reconcilable].map(target => target.attemptId));
        const missingEvidence = rows.slice(0, LIMIT).some(row => !pendingIds.has(row.id));
        return { targets, limited, retained: rows.length > 0, dispatchBlocked: census.blocked || missingEvidence, reconcilable };
      });
    },
    readObservation(target) {
      const row = findLatestObservation(target.attemptId);
      if (!row) return null;
      const { phase: _phase, evidenceRef: _ref, ...evidence } = JSON.parse(row.payload) as WorkStartupRecoveryEvidence & { phase: string; evidenceRef: string | null };
      const { schemaVersion: _schema, kind: _kind, stopConfirmed: _stopped, observedAtUtcMs: _at,
        workspaceReconciled: _workspace, observationRevision: _revision, observationKind: _observationKind,
        previousObservationAtUtcMs: _previousObservationAt, gaps, ...identity } = evidence;
      const { gaps: currentGaps, ...currentIdentity } = target;
      if (!isDeepStrictEqual(identity, currentIdentity) || currentGaps.some(gap => !gaps.includes(gap))) {
        throw new TypeError('Recovery observation identity changed');
      }
      return evidence;
    },
    observed(evidence: WorkStartupRecoveryEvidence, evidenceRef: string | null) {
      session.transactWrite('Work.startupRecovery.observed', () => {
        const row = db.prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?').get(evidence.attemptId);
        if (!row || row.project_id !== evidence.projectId
          || row.run_id !== evidence.runId
          || row.owner_id !== evidence.owner || row.host_instance_id !== evidence.hostInstanceId
          || row.execution_version !== evidence.executionVersion || row.execution_stage !== evidence.executionStage
          || evidence.schemaVersion !== 1 || evidence.kind !== 'work-startup-recovery'
          || evidence.workspaceReconciled !== false || !Array.isArray(evidence.gaps)
          || (evidence.observationKind !== undefined && !['initial', 'reprobe'].includes(evidence.observationKind))) {
          throw new TypeError('Recovery observation identity changed');
        }
        const phase = (evidence.observationRevision ?? 1) > 1 || evidence.observationKind === 'reprobe'
          ? 'reprobed' : evidenceRef === null ? 'observed' : 'recorded';
        if (phase !== 'reprobed' && findEvent(phase, row.id)) return;
        const fenced = findEvent('fenced', row.id);
        if (!fenced) throw new TypeError('Recovery fence is missing');
        const fencedPayload = JSON.parse(fenced.payload) as WorkStartupRecoveryTarget & { processIdentity: unknown; gaps: unknown };
        if (fencedPayload.projectId !== evidence.projectId || fencedPayload.runId !== evidence.runId
          || fencedPayload.attemptId !== evidence.attemptId || fencedPayload.owner !== evidence.owner
          || fencedPayload.hostInstanceId !== evidence.hostInstanceId
          || fencedPayload.executionVersion !== evidence.executionVersion
          || fencedPayload.executionStage !== evidence.executionStage
          || !isDeeplyEqualProcessIdentity(fencedPayload.processIdentity, evidence.processIdentity)
          || !isDeepStrictEqual(fencedPayload.verificationProcesses, evidence.verificationProcesses)
          || !Array.isArray(fencedPayload.gaps) || fencedPayload.gaps.some(gap => !evidence.gaps.includes(String(gap)))) {
          throw new TypeError('Recovery process identity changed');
        }
        if (evidenceRef !== null) {
          assertRecoveryArtifact(evidenceRef, evidence.projectId);
          if (row.status === 'interrupted') {
            db.prepare('UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ?')
              .run(evidenceRef, now(), row.project_id, row.id, row.owner_id, row.host_instance_id, row.execution_version);
          }
        }
        event(phase, row.project_id, row.run_id,
          { ...evidence, evidenceRef }, row.id, row.execution_stage);
      });
    },
    failed() {
      session.transactWrite('Work.startupRecovery.failed', () => {
        event('failed', null, null, { schemaVersion: 1, reason: 'recovery_failed' });
      });
    },
    /** P05-1 / F-010：规划恢复已补完（或已判定证据不足）的终态 planning Run/
     * Attempt——终态现场由规划窗口诊断拥有，通用逐个核对不再改写。 */
    planningCompletionFinalized(attemptId: string): boolean {
      const row = db.prepare<[string], AttemptRow & { run_status?: string }>('SELECT a.* FROM attempts a WHERE a.id = ?').get(attemptId);
      if (row === undefined || !['succeeded', 'failed', 'cancelled'].includes(row.status)) return false;
      try {
        const snapshot = JSON.parse(row.input_snapshot) as { purpose?: unknown };
        if (snapshot?.purpose !== 'planning') return false;
      } catch { return false; }
      const run = db.prepare<[string], { status: string }>('SELECT status FROM runs WHERE id = ?').get(row.run_id);
      return run !== undefined && ['succeeded', 'failed', 'cancelled'].includes(run.status);
    },
  };
}
