import type { SqliteStorageSession } from './session.js';
import type {
  BatchFinalizationCandidate,
  BatchFinalizationCandidateStore,
  BatchFinalizationIntegrationResult,
  BatchFinalizationVerificationResult,
} from '../../application/batch-leaf-finalization.js';
import { StorageError } from '../../ports/errors.js';

const OPERATION = 'SqliteBatchFinalizationCandidateStore';

type CandidateRow = {
  id: string;
  created_at: number;
  project_id: string;
  revision: number;
  updated_at: number;
  command_id: string;
  phase_id: string;
  batch_id: string;
  batch_revision: number;
  scope_digest: string;
  input_digest: string;
  target_baseline: string;
  approved_inputs: string;
  leaf_feature_ids: string;
  merge_order: string;
  leaves: string;
  verification_scope: string;
  strategy_summary: string;
  status: BatchFinalizationCandidate['status'];
  integration: string | null;
  verification: string | null;
  workspace_preserved: number;
};

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parse<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new StorageError('corrupt', OPERATION, `交付候选 ${field} JSON 损坏`, { details: { field }, cause });
  }
}

function candidateFromRow(row: CandidateRow): BatchFinalizationCandidate {
  if (row.workspace_preserved !== 0 && row.workspace_preserved !== 1) {
    throw new StorageError('corrupt', OPERATION, '交付候选 workspacePreserved 非法');
  }
  return {
    schemaVersion: 1,
    candidateId: row.id,
    commandId: row.command_id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    batchId: row.batch_id,
    batchRevision: row.batch_revision,
    scopeDigest: row.scope_digest,
    inputDigest: row.input_digest,
    targetBaseline: row.target_baseline,
    approvedInputs: parse(row.approved_inputs, 'approvedInputs'),
    leafFeatureIds: parse(row.leaf_feature_ids, 'leafFeatureIds'),
    mergeOrder: parse(row.merge_order, 'mergeOrder'),
    leaves: parse(row.leaves, 'leaves'),
    verificationScope: parse(row.verification_scope, 'verificationScope'),
    strategySummary: parse(row.strategy_summary, 'strategySummary'),
    status: row.status,
    integration: row.integration === null ? null : parse(row.integration, 'integration'),
    verification: row.verification === null ? null : parse(row.verification, 'verification'),
    workspacePreserved: row.workspace_preserved === 1,
  };
}

function readById(session: SqliteStorageSession, projectId: string, candidateId: string): CandidateRow | undefined {
  return session.database.prepare<[string, string], CandidateRow>(
    'SELECT * FROM phase_delivery_candidates WHERE project_id = ? AND id = ?',
  ).get(projectId, candidateId);
}

function readByCommand(session: SqliteStorageSession, projectId: string, batchId: string, commandId: string): CandidateRow | undefined {
  return session.database.prepare<[string, string, string], CandidateRow>(
    'SELECT * FROM phase_delivery_candidates WHERE project_id = ? AND batch_id = ? AND command_id = ?',
  ).get(projectId, batchId, commandId);
}

function sameCommandIdentity(existing: CandidateRow, candidate: BatchFinalizationCandidate): boolean {
  return existing.id === candidate.candidateId
    && existing.phase_id === candidate.phaseId
    && existing.batch_id === candidate.batchId
    && existing.scope_digest === candidate.scopeDigest
    && existing.input_digest === candidate.inputDigest;
}

export function createSqliteBatchFinalizationCandidateStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): BatchFinalizationCandidateStore {
  if (session === null || typeof session !== 'object' || typeof session.transactWrite !== 'function') {
    throw new TypeError(`${OPERATION}.create: session is required`);
  }
  const now = options.nowUtcMs ?? Date.now;

  return {
    read(projectId, batchId, commandId) {
      const row = readByCommand(session, projectId, batchId, commandId);
      return row === undefined ? null : candidateFromRow(row);
    },

    createCandidate(candidate) {
      return session.transactWrite(`${OPERATION}.create`, () => {
        const existing = readByCommand(session, candidate.projectId, candidate.batchId, candidate.commandId);
        if (existing !== undefined) {
          if (!sameCommandIdentity(existing, candidate)) {
            throw new StorageError('conflict', OPERATION, '交付候选 commandId 已绑定不同冻结输入', {
              details: { reason: 'idempotency_key_reuse' },
            });
          }
          return candidateFromRow(existing);
        }
        const timestamp = now();
        session.database.prepare(
          'INSERT INTO phase_delivery_candidates (id, created_at, project_id, revision, updated_at, command_id, phase_id, batch_id, batch_revision, scope_digest, input_digest, target_baseline, approved_inputs, leaf_feature_ids, merge_order, leaves, verification_scope, strategy_summary, status, integration, verification, workspace_preserved) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)',
        ).run(
          candidate.candidateId, timestamp, candidate.projectId, timestamp, candidate.commandId, candidate.phaseId,
          candidate.batchId, candidate.batchRevision, candidate.scopeDigest, candidate.inputDigest, candidate.targetBaseline,
          json(candidate.approvedInputs), json(candidate.leafFeatureIds), json(candidate.mergeOrder), json(candidate.leaves),
          json(candidate.verificationScope), json(candidate.strategySummary), candidate.status,
        );
        return candidate;
      });
    },

    recordIntegrationResult(candidateId, result: BatchFinalizationIntegrationResult) {
      return session.transactWrite(`${OPERATION}.integration`, () => {
        const row = session.database.prepare<[string], CandidateRow>(
          'SELECT * FROM phase_delivery_candidates WHERE id = ?',
        ).get(candidateId);
        if (row === undefined) throw new StorageError('not_found', OPERATION, '交付候选不存在');
        if (row.integration !== null) {
          const current = parse<BatchFinalizationIntegrationResult>(row.integration, 'integration');
          if (json(current) === json(result)) return candidateFromRow(row);
          throw new StorageError('conflict', OPERATION, '交付候选集成结果已由其他写入者提交', {
            details: { reason: 'candidate_revision_conflict' },
          });
        }
        if (row.status !== 'pending_integration') {
          throw new StorageError('conflict', OPERATION, '交付候选不允许进入集成收尾状态', {
            details: { reason: 'invalid_candidate_transition', status: row.status },
          });
        }
        const nextStatus = result.status === 'succeeded' ? 'awaiting_verification' : result.status === 'unknown' ? 'reconciliation_required' : 'blocked';
        const changed = session.database.prepare(
          'UPDATE phase_delivery_candidates SET revision = revision + 1, updated_at = ?, status = ?, integration = ?, workspace_preserved = ? WHERE id = ? AND revision = ? AND status = ?',
        ).run(now(), nextStatus, json(result), result.workspacePreserved ? 1 : 0, row.id, row.revision, row.status);
        if (changed.changes !== 1) throw new StorageError('conflict', OPERATION, '交付候选 revision CAS 失败', { details: { reason: 'stale_revision' } });
        return candidateFromRow(readById(session, row.project_id, row.id)!);
      });
    },

    recordVerificationResult(candidateId, result: BatchFinalizationVerificationResult) {
      return session.transactWrite(`${OPERATION}.verification`, () => {
        const row = session.database.prepare<[string], CandidateRow>(
          'SELECT * FROM phase_delivery_candidates WHERE id = ?',
        ).get(candidateId);
        if (row === undefined) throw new StorageError('not_found', OPERATION, '交付候选不存在');
        if (row.verification !== null) {
          const current = parse<BatchFinalizationVerificationResult>(row.verification, 'verification');
          if (json(current) === json(result)) return candidateFromRow(row);
          throw new StorageError('conflict', OPERATION, '交付候选验证结果已由其他写入者提交', {
            details: { reason: 'candidate_revision_conflict' },
          });
        }
        if (row.status !== 'awaiting_verification') {
          throw new StorageError('conflict', OPERATION, '交付候选不允许进入验证收尾状态', {
            details: { reason: 'invalid_candidate_transition', status: row.status },
          });
        }
        const changed = session.database.prepare(
          'UPDATE phase_delivery_candidates SET revision = revision + 1, updated_at = ?, status = ?, verification = ? WHERE id = ? AND revision = ? AND status = ?',
        ).run(now(), result.status === 'passed' ? 'ready_for_phase_approval' : 'blocked', json(result), row.id, row.revision, row.status);
        if (changed.changes !== 1) throw new StorageError('conflict', OPERATION, '交付候选 revision CAS 失败', { details: { reason: 'stale_revision' } });
        return candidateFromRow(readById(session, row.project_id, row.id)!);
      });
    },
  };
}
