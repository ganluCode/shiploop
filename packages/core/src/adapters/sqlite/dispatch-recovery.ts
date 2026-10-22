import { createHash } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import { computeRunDispatchAuthorizationDigest } from '../../ports/execution-dispatch.js';
import type { SqliteStorageSession } from './session.js';

interface Claim {
  id: string; project_id: string; feature_id: string; run_id: string; claim_version: number;
  owner_id: string; host_instance_id: string; state: string; lease_until: number;
}
interface Slot extends Claim { claim_id: string }
interface Attempt {
  id: string; project_id: string; feature_id: string; run_id: string; owner_id: string;
  host_instance_id: string; execution_version: number;
}
const LIMIT = 128;
const active = "('held', 'quarantined')";
function recoveryConflict(reason: string): never {
  throw new StorageError('conflict', 'WorkRecovery.dispatch', reason, { details: { reason } });
}

/** Adapter-private recovery authority. Call mutations only inside the caller's recovery transaction. */
export function createSqliteDispatchRecovery(session: SqliteStorageSession) {
  const db = session.database;
  function claims(runId: string): Claim[] {
    const rows = db.prepare<[string], Claim>(`SELECT * FROM run_dispatch_claims WHERE run_id = ? ORDER BY claim_version LIMIT ${LIMIT + 1}`).all(runId);
    if (rows.length > LIMIT) recoveryConflict('dispatch_history_limit');
    return rows;
  }
  function slots(claimId: string): Slot[] {
    const rows = db.prepare<[string], Slot>(`SELECT * FROM execution_slot_claims WHERE claim_id = ? ORDER BY id LIMIT ${LIMIT + 1}`).all(claimId);
    if (rows.length > LIMIT) recoveryConflict('dispatch_history_limit');
    return rows;
  }
  function assertWrite() {
    if (!db.inTransaction) throw new TypeError('Dispatch recovery requires a transaction');
  }
  function quarantine(claim: Claim, reason: string, timestamp: number) {
    assertWrite();
    // Wall-clock rollback cannot abort fencing or move durable timestamps before acquisition/prior updates.
    db.prepare(`UPDATE execution_slot_claims SET state = 'quarantined', reason = ?, revision = revision + 1,
      updated_at = MAX(?, acquired_at, updated_at) WHERE claim_id = ? AND state = 'held'`).run(reason, timestamp, claim.id);
    db.prepare(`UPDATE run_dispatch_claims SET state = 'quarantined', reason = ?, settled_at = MAX(?, acquired_at, updated_at),
      revision = revision + 1, updated_at = MAX(?, acquired_at, updated_at) WHERE id = ? AND state = 'held'`).run(reason, timestamp, timestamp, claim.id);
  }
  function release(claim: Claim, timestamp: number, reason = 'startup_reconciled') {
    assertWrite();
    // Expiry does not authorize this path. The caller has proved unstarted or matched stop/reconciliation evidence.
    db.prepare(`UPDATE execution_slot_claims SET state = 'released', reason = ?, released_at = MAX(?, acquired_at, updated_at),
      revision = revision + 1, updated_at = MAX(?, acquired_at, updated_at) WHERE claim_id = ? AND state IN ${active}`)
      .run(reason, timestamp, timestamp, claim.id);
    db.prepare(`UPDATE run_dispatch_claims SET state = 'released', reason = ?, settled_at = MAX(?, acquired_at, updated_at),
      revision = revision + 1, updated_at = MAX(?, acquired_at, updated_at) WHERE id = ? AND state IN ${active}`)
      .run(reason, timestamp, timestamp, claim.id);
  }
  function authorization(runId: string): boolean {
    const run = db.prepare<[string], { project_id: string; feature_id: string; batch_id: string; id: string;
      purpose: string; scope_digest: string; work_key: string; dispatch_ordinal: number }>(
      'SELECT * FROM runs WHERE id = ?').get(runId);
    const intent = db.prepare<[string], { authorization_digest: string; project_id: string; feature_id: string; batch_id: string }>(
      'SELECT * FROM run_dispatch_intents WHERE run_id = ? LIMIT 1').get(runId);
    return run !== undefined && intent !== undefined && intent.project_id === run.project_id
      && intent.feature_id === run.feature_id && intent.batch_id === run.batch_id
      && intent.authorization_digest === computeRunDispatchAuthorizationDigest({ projectId: run.project_id,
        featureId: run.feature_id, batchId: run.batch_id, runId: run.id, purpose: run.purpose,
        scopeDigest: run.scope_digest, workKey: run.work_key, dispatchOrdinal: run.dispatch_ordinal });
  }
  function link(attempt: Attempt): { claim: Claim | null; gaps: string[] } {
    const history = claims(attempt.run_id);
    const receipt = db.prepare<[string], { receipt: string }>('SELECT receipt FROM task_claim_receipts WHERE attempt_id = ?').get(attempt.id);
    let parsed: { dispatch?: { claimId: string; claimVersion: number; slotId: string }; attempt?: {
      id: string; projectId: string; featureId: string; runId: string; owner: string; hostInstanceId: string; executionVersion: number } };
    if (receipt === undefined) return { claim: null, gaps: ['dispatch_receipt_missing'] };
    try {
      parsed = JSON.parse(receipt.receipt);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Invalid receipt');
    } catch { return { claim: null, gaps: ['dispatch_receipt_corrupt'] }; }
    const receiptMatches = parsed.attempt?.id === attempt.id && parsed.attempt.projectId === attempt.project_id
      && parsed.attempt.featureId === attempt.feature_id && parsed.attempt.runId === attempt.run_id
      && parsed.attempt.owner === attempt.owner_id
      && parsed.attempt.hostInstanceId === attempt.host_instance_id
      && parsed.attempt.executionVersion === attempt.execution_version;
    // Pre-v33 Attempts have no dispatch link, but still require their immutable Core claim receipt.
    if (history.length === 0 && !parsed.dispatch) return { claim: null, gaps: receiptMatches ? [] : ['dispatch_attempt_link_invalid'] };
    const claim = history.find(row => row.id === parsed.dispatch?.claimId) ?? null;
    const slot = claim === null ? undefined : slots(claim.id).find(row => row.id === parsed.dispatch?.slotId);
    const gaps: string[] = [];
    if (!claim || !slot || claim.claim_version !== parsed.dispatch?.claimVersion
      || claim.owner_id !== attempt.owner_id || claim.host_instance_id !== attempt.host_instance_id
      || claim.project_id !== attempt.project_id || claim.feature_id !== attempt.feature_id
      || slot.run_id !== attempt.run_id || slot.project_id !== attempt.project_id
      || slot.feature_id !== attempt.feature_id || slot.claim_version !== claim.claim_version
      || slot.owner_id !== claim.owner_id || slot.host_instance_id !== claim.host_instance_id
      || !receiptMatches) gaps.push('dispatch_attempt_link_invalid');
    if (!authorization(attempt.run_id)) gaps.push('dispatch_authorization_missing_or_changed');
    const current = history.find(row => row.state !== 'released');
    if (current && current.id !== claim?.id) gaps.push('dispatch_generation_changed');
    if (slot?.state === 'released' && claim?.state !== 'released') gaps.push('dispatch_slot_not_retained');
    return { claim, gaps };
  }
  return {
    link,
    resumeBlocked(runId: string, timestamp: number): boolean {
      const current = claims(runId).find(row => row.state !== 'released');
      const occupied = db.prepare<[string], Slot>(`SELECT * FROM execution_slot_claims WHERE run_id = ? AND state IN ${active} LIMIT 1`).get(runId);
      if (!current) return occupied !== undefined;
      if (current.state !== 'held' || current.lease_until <= timestamp || !occupied || occupied.state !== 'held'
        || occupied.lease_until <= timestamp || occupied.claim_id !== current.id) return true;
      const latest = db.prepare<[string], Attempt>('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(runId);
      // Graceful paused holders may continue through the existing stopped-attempt transfer path.
      // An unexplained no-Attempt claim must first pass the trusted startup census.
      return !latest || link(latest).gaps.length > 0;
    },
    /** Census includes claims with no Attempt, slots and legacy orphan resource groups. */
    fence(timestamp: number) {
      assertWrite();
      const rows = db.prepare<[], Claim>(`SELECT * FROM run_dispatch_claims WHERE state IN ${active} ORDER BY id LIMIT ${LIMIT + 1}`).all();
      let blocked = false;
      const attemptIds: string[] = [];
      const gaps = new Map<string, readonly string[]>();
      for (const claim of rows.slice(0, LIMIT)) {
        const attempts = db.prepare<[string], Attempt>(`SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${LIMIT + 1}`).all(claim.run_id);
        if (attempts.length === 0) {
          // No Attempt means no trusted launch could have occurred. Reject contradictory durable facts.
          const invalidSlot = slots(claim.id).some(slot => slot.project_id !== claim.project_id
            || slot.run_id !== claim.run_id || slot.feature_id !== claim.feature_id || slot.claim_version !== claim.claim_version
            || slot.owner_id !== claim.owner_id || slot.host_instance_id !== claim.host_instance_id);
          const uncertain = invalidSlot || !authorization(claim.run_id)
            || db.prepare('SELECT id FROM runtime_start_reservations WHERE run_id = ? LIMIT 1').get(claim.run_id)
            || db.prepare('SELECT id FROM managed_workspaces WHERE run_id = ? LIMIT 1').get(claim.run_id)
            || db.prepare('SELECT id FROM git_operations WHERE run_id = ? LIMIT 1').get(claim.run_id)
            || db.prepare('SELECT id FROM workspace_operations WHERE run_id = ? LIMIT 1').get(claim.run_id)
            || db.prepare('SELECT id FROM workspace_leases WHERE project_id = ? LIMIT 1').get(claim.project_id);
          if (uncertain) { quarantine(claim, 'dispatch_unstarted_evidence_incomplete', timestamp); blocked = true; }
          else {
            release(claim, timestamp, 'startup_unstarted_verified');
            db.prepare(`UPDATE runs SET status = 'paused', reason = 'restart_recovery', revision = revision + 1,
              updated_at = ? WHERE id = ? AND status IN ('running', 'pausing')`).run(timestamp, claim.run_id);
          }
          continue;
        }
        const related = attempts.filter(attempt => link(attempt).claim?.id === claim.id);
        if (related.length === 0 || attempts.length > LIMIT) {
          quarantine(claim, 'dispatch_attempt_link_invalid', timestamp);
          blocked = true;
          for (const attempt of attempts.slice(0, LIMIT)) {
            attemptIds.push(attempt.id); gaps.set(attempt.id, ['dispatch_attempt_link_invalid']);
          }
          continue;
        }
        // The latest Attempt in this generation owns the recovery decision. Also census any retained older groups.
        const target = related[0]!;
        const result = link(target);
        const terminalStopped = result.gaps.length === 0 && db.prepare(`SELECT a.id FROM attempts a
          JOIN sessions s ON s.attempt_id = a.id
          JOIN managed_workspaces w ON w.attempt_id = a.id AND w.run_id = a.run_id
          WHERE a.id = ? AND a.status IN ('succeeded', 'failed', 'cancelled')
            AND s.status = 'stopped' AND s.recording_watermark IS NOT NULL
            AND (s.recording_gaps IS NULL OR s.recording_gaps = '[]') AND w.status = 'retained'
            AND NOT EXISTS (SELECT 1 FROM attempts n WHERE n.run_id = a.run_id AND n.status IN ('preparing', 'executing', 'verifying'))
            AND NOT EXISTS (SELECT 1 FROM workspace_leases l JOIN attempts n ON n.id = l.owner_id WHERE n.run_id = a.run_id)
            AND NOT EXISTS (SELECT 1 FROM git_operations g WHERE g.run_id = a.run_id AND g.status = 'pending')
            AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.run_id = a.run_id AND o.status = 'pending')`).get(target.id);
        if (terminalStopped) {
          // The existing terminal/retention transaction already proved stop. Only settle its stranded consumer;
          // keep Task/Attempt versions, verification results and controlled Git receipts byte-for-byte.
          release(claim, timestamp, 'startup_terminal_stopped');
          db.prepare(`UPDATE runs SET status = 'paused', reason = 'restart_recovery', revision = revision + 1,
            updated_at = ? WHERE id = ? AND status IN ('running', 'pausing')`).run(timestamp, claim.run_id);
          continue;
        }
        quarantine(claim, result.gaps[0] ?? 'startup_recovery_required', timestamp);
        attemptIds.push(target.id);
        gaps.set(target.id, result.gaps);
      }
      const orphanSlot = db.prepare(`SELECT s.id FROM execution_slot_claims s LEFT JOIN run_dispatch_claims c
        ON c.id = s.claim_id WHERE s.state IN ${active} AND (c.id IS NULL OR c.state = 'released') LIMIT 1`).get();
      const orphanLease = db.prepare(`SELECT l.id FROM workspace_leases l LEFT JOIN attempts a ON a.id = l.owner_id
        WHERE a.id IS NULL LIMIT 1`).get();
      return { attemptIds, gaps, blocked: blocked || !!orphanSlot || !!orphanLease, limited: rows.length > LIMIT };
    },
    releaseForAttempt(attempt: Attempt, timestamp: number) {
      assertWrite();
      const result = link(attempt);
      if (result.gaps.length > 0) recoveryConflict(result.gaps[0]!);
      if (result.claim === null) return; // legacy resource groups use the same stop/workspace checks
      if (db.prepare(`SELECT id FROM attempts WHERE run_id = ? AND status IN ('preparing', 'executing', 'verifying') LIMIT 1`).get(attempt.run_id)
        || db.prepare(`SELECT l.id FROM workspace_leases l JOIN attempts a ON a.id = l.owner_id WHERE a.run_id = ? LIMIT 1`).get(attempt.run_id)) {
        recoveryConflict('dispatch_occupancy_unresolved');
      }
      release(result.claim, timestamp);
    },
  };
}

/** Compare all recovery-relevant durable facts again after process/Git/Artifact I/O. New Artifacts are not mutable authority. */
export function workRecoveryFingerprint(session: SqliteStorageSession, attemptId: string): string {
  const db = session.database;
  const attempt = db.prepare<[string], Attempt>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) return recoveryConflict('attempt_missing');
  const runId = attempt.run_id;
  const queries = [
    ['attempts', 'run_id = ?', runId],
    ['tasks', 'feature_id = ?', attempt.feature_id],
    ['runs', 'id = ?', runId],
    ['execution_batches', 'id = (SELECT batch_id FROM runs WHERE id = ?)', runId],
    ['run_dispatch_claims', 'run_id = ?', runId],
    ['execution_slot_claims', 'run_id = ?', runId],
    ['run_dispatch_intents', 'run_id = ?', runId],
    ['managed_workspaces', 'feature_id = ?', attempt.feature_id],
    ['workspace_leases', 'owner_id IN (SELECT id FROM attempts WHERE run_id = ?)', runId],
    ['sessions', 'attempt_id IN (SELECT id FROM attempts WHERE run_id = ?)', runId],
    ['task_claim_receipts', 'attempt_id IN (SELECT id FROM attempts WHERE run_id = ?)', runId],
    ['runtime_start_reservations', 'run_id = ?', runId],
    ['verification_batches', 'run_id = ?', runId],
    ['check_results', 'batch_id IN (SELECT id FROM verification_batches WHERE run_id = ?)', runId],
    ['artifacts', `id IN (SELECT ref FROM (
      SELECT run_id, code_ref AS ref FROM attempts UNION ALL SELECT run_id, diagnostic_ref AS ref FROM attempts
      UNION ALL SELECT run_id, input_ref AS ref FROM attempts
      UNION ALL SELECT a.run_id, s.result_ref AS ref FROM sessions s JOIN attempts a ON a.id = s.attempt_id
      ) WHERE run_id = ?)`, runId],
    ['git_operations', 'run_id = ?', runId],
    ['workspace_operations', 'workspace_id IN (SELECT id FROM managed_workspaces WHERE feature_id = ?)', attempt.feature_id],
    ['workspace_operations', 'run_id = ?', runId],
  ];
  const facts = queries.map(([table, where, id]) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id LIMIT ${LIMIT + 1}`).all(id!);
    if (rows.length > LIMIT) recoveryConflict('recovery_history_limit');
    return [table, rows];
  });
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
