import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';
import { GLOBAL_SETTINGS_ID } from '../../ports/state-store.js';
import { mapStateEvent, type PersistedStateEventRow } from '../../ports/events.js';
import type { WorkStartupRecoveryEvidence, WorkStartupRecoveryStore, WorkStartupRecoveryTarget } from '../../ports/work-startup-recovery.js';
import type { SqliteStorageSession } from './session.js';

const LIMIT = 128;
type RecoveryPhase = 'fenced' | 'observed' | 'recorded' | 'run_interrupted' | 'scan_limited' | 'failed';
interface AttemptRow {
  id: string; project_id: string; run_id: string; task_id: string; feature_id: string;
  owner_id: string; host_instance_id: string; execution_version: number; execution_stage: string;
  status: string; revision: number; started_at: number | null; created_at: number;
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
  return {
    fence() {
      return session.transactWrite('Work.startupRecovery.fence', () => {
        const timestamp = now();
        const rows = db.prepare<[], AttemptRow>(`SELECT a.* FROM attempts a WHERE
          a.status IN ('preparing', 'executing', 'verifying') OR EXISTS
            (SELECT 1 FROM workspace_leases l WHERE l.owner_id = a.id)
          ORDER BY a.id LIMIT ${LIMIT + 1}`).all();
        const runs = db.prepare<[], { id: string; project_id: string; revision: number; status: string }>(`SELECT id, project_id, revision, status
          FROM runs WHERE status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted') ORDER BY id LIMIT ${LIMIT + 1}`).all();
        const limited = rows.length > LIMIT || runs.length > LIMIT;
        const targets: WorkStartupRecoveryTarget[] = [];
        for (const row of rows.slice(0, LIMIT)) {
          const leases = db.prepare<[string], LeaseRow>('SELECT * FROM workspace_leases WHERE owner_id = ? ORDER BY resource_kind, resource_key LIMIT 4').all(row.id);
          const gaps: string[] = [];
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
          const workspace = db.prepare<[string, string], { owner_id: string; host_instance_id: string; execution_version: number; run_id: string; attempt_id: string }>(
            'SELECT owner_id, host_instance_id, execution_version, run_id, attempt_id FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
            .get(row.project_id, row.feature_id);
          if (workspace && (workspace.owner_id !== row.owner_id || workspace.host_instance_id !== row.host_instance_id
            || workspace.execution_version !== row.execution_version || workspace.run_id !== row.run_id
            || workspace.attempt_id !== row.id)) gaps.push('workspace_identity_mismatch');
          const target: WorkStartupRecoveryTarget = { projectId: row.project_id, runId: row.run_id, attemptId: row.id,
            owner: row.owner_id, hostInstanceId: row.host_instance_id, executionVersion: row.execution_version,
            executionStage: row.execution_stage, processIdentity, gaps };
          const fenced = findEvent('fenced', row.id);
          if (fenced) {
            const previous = JSON.parse(fenced.payload);
            if (!isDeepStrictEqual(previous.processIdentity, processIdentity) || !Array.isArray(previous.gaps)) {
              throw new TypeError('Persisted recovery fence changed');
            }
            gaps.push(...previous.gaps);
          } else {
            // Advance the Task fence, never mutate the immutable historical Attempt identity.
            const changed = db.prepare(`UPDATE tasks SET execution_version = execution_version + 1,
              revision = revision + 1, updated_at = ? WHERE id = ? AND execution_version = ? AND execution_version < ${Number.MAX_SAFE_INTEGER}`)
              .run(timestamp, row.task_id, row.execution_version);
            if (changed.changes === 0) gaps.push('task_version_mismatch');
            if (['preparing', 'executing', 'verifying'].includes(row.status)) {
              db.prepare(`UPDATE attempts SET status = 'interrupted', error_kind = COALESCE(error_kind, 'runtime'),
                ended_at = COALESCE(ended_at, ?), revision = revision + 1, updated_at = ? WHERE id = ?`)
                .run(Math.max(timestamp, row.started_at ?? row.created_at), timestamp, row.id);
            }
            event('fenced', row.project_id, row.run_id,
              { schemaVersion: 1, ...target, stopConfirmed: false, workspaceReconciled: false }, row.id, row.execution_stage);
          }
          db.prepare(`UPDATE workspace_leases SET state = 'quarantined', revision = revision + 1, updated_at = ?
            WHERE owner_id = ? AND state <> 'quarantined'`).run(timestamp, row.id);
          db.prepare(`UPDATE managed_workspaces SET status = 'quarantined', revision = revision + 1, updated_at = ?
            WHERE project_id = ? AND feature_id = ? AND status <> 'quarantined' AND status <> 'cleaned'`)
            .run(timestamp, row.project_id, row.feature_id);
          if (!findEvent('recorded', row.id)) targets.push(target);
        }
        for (const run of runs.slice(0, LIMIT)) {
          // A queued authorization with no claim has no old execution to resume. Keep it
          // available after the gate; scanning itself never dispatches it or starts Runtime.
          const hasAttempt = db.prepare('SELECT id FROM attempts WHERE run_id = ? LIMIT 1').get(run.id);
          if ((run.status === 'queued' && !hasAttempt) || run.status === 'paused' || run.status === 'interrupted') continue;
          db.prepare(`UPDATE runs SET status = 'interrupted', reason = 'restart_recovery',
            revision = revision + 1, updated_at = ? WHERE id = ?`).run(timestamp, run.id);
          event('run_interrupted', run.project_id, run.id,
            { schemaVersion: 1, reason: 'restart_recovery' });
        }
        if (limited && !findEvent('scan_limited', 'work-startup-recovery')) {
          event('scan_limited', null, null, { schemaVersion: 1, limit: LIMIT });
        }
        // F-006: recorded stop evidence still needs Git/worktree/recording reconciliation
        // after a Host restart. Exclude the durable success shape (paused + retained + no leases).
        const recordedRows = db.prepare<[], { payload: string }>(`SELECT e.payload FROM state_events e
          JOIN attempts a ON a.id = e.attempt_id
          JOIN runs r ON r.project_id = a.project_id AND r.id = a.run_id
          LEFT JOIN managed_workspaces w ON w.project_id = a.project_id AND w.feature_id = a.feature_id
          WHERE e.event_type = 'work.recovery.updated' AND json_extract(e.payload, '$.phase') = 'recorded'
            AND a.status = 'interrupted'
            AND NOT (r.status = 'paused' AND w.status = 'retained'
              AND NOT EXISTS (SELECT 1 FROM workspace_leases l WHERE l.owner_id = a.id))
          ORDER BY e.sequence LIMIT ${LIMIT}`).all();
        const reconcilable = recordedRows.map(row => JSON.parse(row.payload) as WorkStartupRecoveryEvidence);
        return { targets, limited, retained: rows.length > 0, reconcilable };
      });
    },
    readObservation(target) {
      const row = findEvent('observed', target.attemptId);
      if (!row) return null;
      const { phase: _phase, evidenceRef: _ref, ...evidence } = JSON.parse(row.payload) as WorkStartupRecoveryEvidence & { phase: string; evidenceRef: null };
      const { schemaVersion: _schema, kind: _kind, stopConfirmed: _stopped, observedAtUtcMs: _at,
        workspaceReconciled: _workspace, gaps, ...identity } = evidence;
      const { gaps: currentGaps, ...currentIdentity } = target;
      if (!isDeepStrictEqual(identity, currentIdentity) || currentGaps.some(gap => !gaps.includes(gap))) {
        throw new TypeError('Recovery observation identity changed');
      }
      return evidence;
    },
    observed(evidence: WorkStartupRecoveryEvidence, evidenceRef: string | null) {
      session.transactWrite('Work.startupRecovery.observed', () => {
        const row = db.prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?').get(evidence.attemptId);
        if (!row || row.project_id !== evidence.projectId || row.owner_id !== evidence.owner
          || row.host_instance_id !== evidence.hostInstanceId || row.execution_version !== evidence.executionVersion) {
          throw new TypeError('Recovery observation identity changed');
        }
        const phase = evidenceRef === null ? 'observed' : 'recorded';
        if (findEvent(phase, row.id)) return;
        const fenced = findEvent('fenced', row.id);
        if (!fenced || !isDeepStrictEqual(JSON.parse(fenced.payload).processIdentity, evidence.processIdentity)) {
          throw new TypeError('Recovery process identity changed');
        }
        if (evidenceRef !== null && row.status === 'interrupted') {
          db.prepare('UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            .run(evidenceRef, now(), row.id);
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
  };
}
