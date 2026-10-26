import { randomUUID } from 'node:crypto';
import type { SqliteStorageSession } from './session.js';
import { StorageError } from '../../ports/errors.js';
import type {
  PhaseDeliveryApprovalRecord,
  PhaseDeliveryApprovalStore,
} from '../../application/phase-delivery-approval.js';

const OPERATION = 'SqlitePhaseDeliveryApprovalStore';

type ApprovalRow = {
  id: string; created_at: number; project_id: string; revision: number; updated_at: number;
  command_id: string; actor_id: string; phase_id: string; batch_id: string; candidate_id: string;
  candidate_revision: number; batch_revision: number; scope_digest: string; input_digest: string;
  target_baseline: string; integration_commit_sha: string; integration_tree_sha: string; leaf_commit_shas: string;
  integration_evidence_id: string; integration_evidence_digest: string; verification_evidence_id: string;
  verification_evidence_digest: string; budget_digest: string; budget_summary: string; code_summary: string;
  plan_summary: string; summary_digest: string; status: PhaseDeliveryApprovalRecord['status']; invalidation_reason: string | null;
};

function parse<T>(value: string, field: string): T {
  try { return JSON.parse(value) as T; }
  catch (cause) { throw new StorageError('corrupt', OPERATION, `Phase 交付批准 ${field} JSON 损坏`, { details: { field }, cause }); }
}

function json(value: unknown): string { return JSON.stringify(value); }

function fromRow(row: ApprovalRow): PhaseDeliveryApprovalRecord {
  return {
    schemaVersion: 1, approvalId: row.id, revision: row.revision, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
    commandId: row.command_id, actorId: row.actor_id, projectId: row.project_id, phaseId: row.phase_id, batchId: row.batch_id,
    candidateId: row.candidate_id, candidateRevision: row.candidate_revision, batchRevision: row.batch_revision,
    scopeDigest: row.scope_digest, inputDigest: row.input_digest, targetBaseline: row.target_baseline,
    integrationCommitSha: row.integration_commit_sha, integrationTreeSha: row.integration_tree_sha, treeSha: row.integration_tree_sha,
    leafCommitShas: parse(row.leaf_commit_shas, 'leafCommitShas'), integrationEvidenceId: row.integration_evidence_id,
    integrationEvidenceDigest: row.integration_evidence_digest, verificationEvidenceId: row.verification_evidence_id,
    verificationEvidenceDigest: row.verification_evidence_digest, budgetDigest: row.budget_digest,
    budgetSummary: parse(row.budget_summary, 'budgetSummary'), codeSummary: parse(row.code_summary, 'codeSummary'),
    planSummary: parse(row.plan_summary, 'planSummary'), summaryDigest: row.summary_digest, status: row.status,
    invalidationReason: row.invalidation_reason,
  };
}

function readCandidate(db: SqliteStorageSession['database'], projectId: string, phaseId: string, candidateId: string): ApprovalRow | undefined {
  return db.prepare<[string, string, string], ApprovalRow>(
    'SELECT * FROM phase_delivery_approvals WHERE project_id = ? AND phase_id = ? AND candidate_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
  ).get(projectId, phaseId, candidateId);
}

function appendEvent(session: SqliteStorageSession, record: PhaseDeliveryApprovalRecord, phaseRevision: number, status: string): void {
  const db = session.database;
  const timestamp = record.updatedAtUtcMs;
  const sequence = (db.prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()?.next ?? 1);
  db.prepare(
    `INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'phase', ?, ?, ?, ?)`,
  ).run(
    randomUUID(), timestamp, timestamp, record.projectId, sequence,
    status === 'approved' ? 'phase.delivery.approved' : 'phase.delivery.invalidated',
    record.phaseId, phaseRevision,
    json({ schemaVersion: 1, approvalId: record.approvalId, candidateId: record.candidateId, batchId: record.batchId, summaryDigest: record.summaryDigest, status, reason: record.invalidationReason }),
    timestamp,
  );
}

export function createSqlitePhaseDeliveryApprovalStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): PhaseDeliveryApprovalStore {
  if (session === null || typeof session !== 'object' || typeof session.transactWrite !== 'function') {
    throw new TypeError(`${OPERATION}.create: session is required`);
  }
  const now = options.nowUtcMs ?? Date.now;
  return {
    read(projectId, phaseId, candidateId) {
      const row = readCandidate(session.database, projectId, phaseId, candidateId);
      return row === undefined ? null : fromRow(row);
    },
    create(record) {
      return session.transactWrite(`${OPERATION}.create`, () => {
        const existingCommand = session.database.prepare<[string, string], ApprovalRow>(
          'SELECT * FROM phase_delivery_approvals WHERE project_id = ? AND command_id = ?',
        ).get(record.projectId, record.commandId);
        if (existingCommand !== undefined) {
          if (existingCommand.id === record.approvalId && json(fromRow(existingCommand)) === json(record)) return fromRow(existingCommand);
          throw new StorageError('conflict', OPERATION, 'Phase 交付批准 commandId 已绑定其他事实', { details: { reason: 'duplicate_command_id' } });
        }
        const existingCandidate = readCandidate(session.database, record.projectId, record.phaseId, record.candidateId);
        if (existingCandidate?.status === 'approved') {
          throw new StorageError('conflict', OPERATION, 'Phase 交付候选已经批准', { details: { reason: 'already_approved' } });
        }
        const timestamp = now();
        session.database.prepare(
          `INSERT INTO phase_delivery_approvals
           (id, created_at, project_id, revision, updated_at, command_id, actor_id, phase_id, batch_id, candidate_id,
            candidate_revision, batch_revision, scope_digest, input_digest, target_baseline, integration_commit_sha,
            integration_tree_sha, leaf_commit_shas, integration_evidence_id, integration_evidence_digest,
            verification_evidence_id, verification_evidence_digest, budget_digest, budget_summary, code_summary,
            plan_summary, summary_digest, status, invalidation_reason)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', NULL)`,
        ).run(
          record.approvalId, timestamp, record.projectId, timestamp, record.commandId, record.actorId, record.phaseId,
          record.batchId, record.candidateId, record.candidateRevision, record.batchRevision, record.scopeDigest,
          record.inputDigest, record.targetBaseline, record.integrationCommitSha, record.integrationTreeSha,
          json(record.leafCommitShas), record.integrationEvidenceId, record.integrationEvidenceDigest,
          record.verificationEvidenceId, record.verificationEvidenceDigest, record.budgetDigest, json(record.budgetSummary),
          json(record.codeSummary), json(record.planSummary), record.summaryDigest,
        );
        session.database.prepare(
          `INSERT INTO command_receipts
           (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation,
            request_digest, status, operation_id, receipt_version, batch_id, run_id, planning_task_id, candidate_id,
            result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at)
           VALUES (?, ?, 1, ?, ?, ?, 'project', ?, 'phase.delivery.approve', ?, 'completed', NULL, 5, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
        ).run(
          randomUUID(), timestamp, timestamp, record.actorId, record.commandId, record.projectId, record.summaryDigest,
          json({ schemaVersion: 1, approvalId: record.approvalId, phaseId: record.phaseId, batchId: record.batchId, candidateId: record.candidateId, summaryDigest: record.summaryDigest }),
          record.approvalId, timestamp, timestamp,
        );
        const phase = session.database.prepare<[string, string], { revision: number }>(
          'SELECT revision FROM phases WHERE project_id = ? AND id = ?',
        ).get(record.projectId, record.phaseId);
        if (phase === undefined) throw new StorageError('not_found', OPERATION, 'Phase 不存在');
        const changed = session.database.prepare(
          `UPDATE phases SET delivery_status = 'approved', delivery_approval_id = ?, delivery_candidate_id = ?, delivery_batch_id = ?, delivery_summary_digest = ?, revision = revision + 1, updated_at = ?
           WHERE project_id = ? AND id = ? AND revision = ?`,
        ).run(record.approvalId, record.candidateId, record.batchId, record.summaryDigest, timestamp, record.projectId, record.phaseId, phase.revision);
        if (changed.changes !== 1) throw new StorageError('conflict', OPERATION, 'Phase 交付批准 revision CAS 未命中', { details: { reason: 'stale_revision' } });
        const saved = fromRow(session.database.prepare<[string], ApprovalRow>('SELECT * FROM phase_delivery_approvals WHERE id = ?').get(record.approvalId)!);
        appendEvent(session, saved, phase.revision + 1, 'approved');
        return saved;
      });
    },
    invalidate(record, reason) {
      if (record.status === 'invalidated' && record.invalidationReason === reason) return record;
      return session.transactWrite(`${OPERATION}.invalidate`, () => {
        const current = session.database.prepare<[string], ApprovalRow>('SELECT * FROM phase_delivery_approvals WHERE id = ?').get(record.approvalId);
        if (current === undefined) throw new StorageError('not_found', OPERATION, 'Phase 交付批准不存在');
        if (current.status === 'invalidated' && current.invalidation_reason === reason) return fromRow(current);
        const timestamp = now();
        const changed = session.database.prepare(
          `UPDATE phase_delivery_approvals SET revision = revision + 1, updated_at = ?, status = 'invalidated', invalidation_reason = ?
           WHERE id = ? AND revision = ? AND status = 'approved'`,
        ).run(timestamp, reason, current.id, current.revision);
        if (changed.changes !== 1) throw new StorageError('conflict', OPERATION, 'Phase 交付批准 revision CAS 未命中', { details: { reason: 'stale_revision' } });
        const phase = session.database.prepare<[string, string], { revision: number }>('SELECT revision FROM phases WHERE project_id = ? AND id = ?').get(current.project_id, current.phase_id);
        if (phase === undefined) throw new StorageError('not_found', OPERATION, 'Phase 不存在');
        const phaseChanged = session.database.prepare(
          `UPDATE phases SET delivery_status = 'invalidated', revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND delivery_approval_id = ? AND revision = ?`,
        ).run(timestamp, current.project_id, current.phase_id, current.id, phase.revision);
        if (phaseChanged.changes !== 1) throw new StorageError('conflict', OPERATION, 'Phase 交付失效 revision CAS 未命中', { details: { reason: 'stale_revision' } });
        const saved = fromRow(session.database.prepare<[string], ApprovalRow>('SELECT * FROM phase_delivery_approvals WHERE id = ?').get(current.id)!);
        appendEvent(session, saved, phase.revision + 1, 'invalidated');
        return saved;
      });
    },
  };
}
