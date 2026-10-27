import { createHash } from 'node:crypto';
import type { BatchFinalizationCandidate } from './batch-leaf-finalization.js';
import { StorageError } from '../ports/errors.js';
import { stableStringify } from '../ports/feature-plan.js';
import { validateStableId } from '../ports/validation.js';

const OPERATION = 'PhaseDeliveryApproval';

export type PhaseDeliveryApprovalCandidateSnapshot = BatchFinalizationCandidate;

export interface PhaseDeliveryApprovalBatchSnapshot {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly revision: number;
  readonly status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  readonly approved: boolean;
  readonly scopeDigest: string;
  readonly inputDigest: string;
  readonly budgetSummary: Readonly<Record<string, unknown>>;
  readonly stopSummary: Readonly<{ readonly status: 'confirmed' | 'active' | 'unknown' | 'not_required'; readonly digest?: string }>;
  readonly codeSummary: Readonly<Record<string, unknown>>;
  readonly planSummary: Readonly<Record<string, unknown>>;
  readonly manualBlock: boolean;
}

export interface PhaseDeliveryApprovalSnapshot {
  readonly candidate: PhaseDeliveryApprovalCandidateSnapshot;
  readonly batch: PhaseDeliveryApprovalBatchSnapshot;
}

export type PhaseDeliveryApprovalStatus = 'approved' | 'invalidated';

export interface PhaseDeliveryApprovalRecord {
  /** Only supplied by the trusted versioned command channel; not a persisted summary. */
  readonly commandContext?: { readonly requestDigest: string; readonly issuedAt: string };
  readonly deliveryFeatureIds?: readonly string[];
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly commandId: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly batchRevision: number;
  readonly scopeDigest: string;
  readonly inputDigest: string;
  readonly targetBaseline: string;
  readonly integrationCommitSha: string;
  readonly integrationTreeSha: string;
  readonly treeSha: string;
  readonly leafCommitShas: readonly string[];
  readonly integrationEvidenceId: string;
  readonly integrationEvidenceDigest: string;
  readonly verificationEvidenceId: string;
  readonly verificationEvidenceDigest: string;
  readonly budgetDigest: string;
  readonly budgetSummary: Readonly<Record<string, unknown>>;
  readonly codeSummary: Readonly<Record<string, unknown>>;
  readonly planSummary: Readonly<Record<string, unknown>>;
  readonly summaryDigest: string;
  readonly status: PhaseDeliveryApprovalStatus;
  readonly invalidationReason: string | null;
}

export interface PhaseDeliveryApprovalStore {
  read(projectId: string, phaseId: string, candidateId: string): PhaseDeliveryApprovalRecord | null;
  create(record: PhaseDeliveryApprovalRecord): PhaseDeliveryApprovalRecord;
  invalidate(record: PhaseDeliveryApprovalRecord, reason: string): PhaseDeliveryApprovalRecord;
}

export interface PhaseDeliveryApprovalSnapshotSource {
  read(projectId: string, phaseId: string, batchId: string, candidateId: string): PhaseDeliveryApprovalSnapshot | null;
}

export interface PhaseDeliveryApprovalRequest {
  readonly commandContext?: { readonly requestDigest: string; readonly issuedAt: string };
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly candidateId: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly expectedBatchRevision: number;
  readonly expectedCandidateRevision: number;
}

export type PhaseDeliveryApprovalRejectionReason =
  | 'candidate_not_found'
  | 'cross_project'
  | 'cross_phase'
  | 'batch_identity_mismatch'
  | 'candidate_identity_mismatch'
  | 'stale_revision'
  | 'candidate_not_ready'
  | 'integration_not_verified'
  | 'verification_not_passed'
  | 'batch_not_succeeded'
  | 'batch_not_approved'
  | 'scope_digest_mismatch'
  | 'input_digest_mismatch'
  | 'budget_not_consistent'
  | 'stop_not_confirmed'
  | 'manual_block'
  | 'empty_summary'
  | 'already_approved'
  | 'approval_conflict';

export type PhaseDeliveryApprovalResult =
  | { readonly status: 'approved'; readonly approval: PhaseDeliveryApprovalRecord }
  | { readonly status: 'replayed'; readonly approval: PhaseDeliveryApprovalRecord }
  | { readonly status: 'rejected'; readonly reason: PhaseDeliveryApprovalRejectionReason; readonly approval: PhaseDeliveryApprovalRecord | null };

export interface PhaseDeliveryApprovalService {
  approve(request: PhaseDeliveryApprovalRequest): Promise<PhaseDeliveryApprovalResult>;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\n${stableStringify(value)}`, 'utf8').digest('hex');
}

function rejection(reason: PhaseDeliveryApprovalRejectionReason, approval: PhaseDeliveryApprovalRecord | null = null): PhaseDeliveryApprovalResult {
  return { status: 'rejected', reason, approval };
}

function validateRequest(request: PhaseDeliveryApprovalRequest): PhaseDeliveryApprovalRequest {
  validateStableId(request?.projectId, { operation: `${OPERATION}.validate` }, 'projectId');
  validateStableId(request?.phaseId, { operation: `${OPERATION}.validate` }, 'phaseId');
  validateStableId(request?.batchId, { operation: `${OPERATION}.validate` }, 'batchId');
  validateStableId(request?.candidateId, { operation: `${OPERATION}.validate` }, 'candidateId');
  validateStableId(request?.commandId, { operation: `${OPERATION}.validate` }, 'commandId');
  validateStableId(request?.actorId, { operation: `${OPERATION}.validate` }, 'actorId');
  if (!Number.isSafeInteger(request.expectedBatchRevision) || request.expectedBatchRevision < 1
    || !Number.isSafeInteger(request.expectedCandidateRevision) || request.expectedCandidateRevision < 1) {
    throw new StorageError('validation', OPERATION, '批准请求 revision 非法');
  }
  return request;
}

function buildSummaryDigest(snapshot: PhaseDeliveryApprovalSnapshot): string {
  return digest('shiploop:phase-delivery-approval-summary:v1', {
    projectId: snapshot.batch.projectId,
    phaseId: snapshot.batch.phaseId,
    batchId: snapshot.batch.batchId,
    candidateId: snapshot.candidate.candidateId,
    candidateRevision: snapshot.candidate.revision,
    batchRevision: snapshot.batch.revision,
    scopeDigest: snapshot.candidate.scopeDigest,
    inputDigest: snapshot.candidate.inputDigest,
    targetBaseline: snapshot.candidate.targetBaseline,
    leaves: snapshot.candidate.leaves,
    mergeOrder: snapshot.candidate.mergeOrder,
    integration: snapshot.candidate.integration,
    verification: snapshot.candidate.verification,
    budgetSummary: snapshot.batch.budgetSummary,
    stopSummary: snapshot.batch.stopSummary,
    codeSummary: snapshot.batch.codeSummary,
    planSummary: snapshot.batch.planSummary,
  });
}

function validateSnapshot(request: PhaseDeliveryApprovalRequest, snapshot: PhaseDeliveryApprovalSnapshot): PhaseDeliveryApprovalRejectionReason | null {
  const { candidate, batch } = snapshot;
  if (candidate.projectId !== request.projectId || batch.projectId !== request.projectId) return 'cross_project';
  if (candidate.phaseId !== request.phaseId || batch.phaseId !== request.phaseId) return 'cross_phase';
  if (candidate.batchId !== request.batchId || batch.batchId !== request.batchId) return 'batch_identity_mismatch';
  if (candidate.candidateId !== request.candidateId) return 'candidate_identity_mismatch';
  if (candidate.revision !== request.expectedCandidateRevision || batch.revision !== request.expectedBatchRevision) return 'stale_revision';
  if (candidate.status !== 'ready_for_phase_approval') return 'candidate_not_ready';
  if (candidate.leafFeatureIds.length === 0 || candidate.leaves.length === 0 || candidate.mergeOrder.length === 0) return 'empty_summary';
  if (candidate.leafFeatureIds.length !== candidate.leaves.length || candidate.mergeOrder.length !== candidate.leafFeatureIds.length) return 'empty_summary';
  if (candidate.integration?.status !== 'succeeded' || candidate.integration.commitSha === null || candidate.integration.treeSha === null
    || candidate.integration.evidenceId === null || candidate.integration.evidenceDigest === null) return 'integration_not_verified';
  if (candidate.verification?.status !== 'passed' || candidate.verification.evidenceId === null || candidate.verification.evidenceDigest === null) return 'verification_not_passed';
  if (batch.status !== 'succeeded') return 'batch_not_succeeded';
  if (!batch.approved) return 'batch_not_approved';
  if (batch.scopeDigest !== candidate.scopeDigest) return 'scope_digest_mismatch';
  if (batch.inputDigest !== candidate.inputDigest) return 'input_digest_mismatch';
  if (batch.manualBlock) return 'manual_block';
  if (batch.stopSummary.status !== 'confirmed' && batch.stopSummary.status !== 'not_required') return 'stop_not_confirmed';
  if (Object.keys(batch.budgetSummary).length === 0) return 'budget_not_consistent';
  return null;
}

function buildRecord(request: PhaseDeliveryApprovalRequest, snapshot: PhaseDeliveryApprovalSnapshot, now: number): PhaseDeliveryApprovalRecord {
  const { candidate, batch } = snapshot;
  const integration = candidate.integration!;
  const verification = candidate.verification!;
  const leafCommitShas = candidate.leaves.map(leaf => leaf.commitSha);
  const budgetDigest = digest('shiploop:phase-delivery-approval-budget:v1', batch.budgetSummary);
  const summaryDigest = buildSummaryDigest(snapshot);
  return {
    ...(request.commandContext === undefined ? {} : { commandContext: request.commandContext, deliveryFeatureIds: [...candidate.leafFeatureIds] }),
    schemaVersion: 1,
    approvalId: digest('shiploop:phase-delivery-approval:v1', { projectId: request.projectId, phaseId: request.phaseId, candidateId: request.candidateId, summaryDigest }),
    revision: 1,
    createdAtUtcMs: now,
    updatedAtUtcMs: now,
    commandId: request.commandId,
    actorId: request.actorId,
    projectId: request.projectId,
    phaseId: request.phaseId,
    batchId: request.batchId,
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    batchRevision: batch.revision,
    scopeDigest: candidate.scopeDigest,
    inputDigest: candidate.inputDigest,
    targetBaseline: candidate.targetBaseline,
    integrationCommitSha: integration.commitSha!,
    integrationTreeSha: integration.treeSha!,
    treeSha: integration.treeSha!,
    leafCommitShas,
    integrationEvidenceId: integration.evidenceId!,
    integrationEvidenceDigest: integration.evidenceDigest!,
    verificationEvidenceId: verification.evidenceId!,
    verificationEvidenceDigest: verification.evidenceDigest!,
    budgetDigest,
    budgetSummary: structuredClone(batch.budgetSummary),
    codeSummary: structuredClone(batch.codeSummary),
    planSummary: structuredClone(batch.planSummary),
    summaryDigest,
    status: 'approved',
    invalidationReason: null,
  };
}

export function createPhaseDeliveryApprovalService(deps: {
  readonly snapshots: PhaseDeliveryApprovalSnapshotSource;
  readonly approvals: PhaseDeliveryApprovalStore;
  readonly nowUtcMs?: () => number;
}): PhaseDeliveryApprovalService {
  if (!deps?.snapshots || !deps.approvals) throw new TypeError(`${OPERATION}.create: dependencies missing`);
  const now = deps.nowUtcMs ?? Date.now;
  return {
    async approve(rawRequest) {
      const request = validateRequest(rawRequest);
      const existing = deps.approvals.read(request.projectId, request.phaseId, request.candidateId);
      const snapshot = deps.snapshots.read(request.projectId, request.phaseId, request.batchId, request.candidateId);
      if (snapshot === null) return rejection('candidate_not_found', existing);
      const identityError = validateSnapshot(request, snapshot);
      if (identityError !== null) {
        if (existing?.status === 'approved') {
          const invalidated = deps.approvals.invalidate(existing, identityError);
          return rejection(identityError, invalidated);
        }
        return rejection(identityError, existing);
      }
      if (existing?.status === 'approved') {
        if (existing.commandId === request.commandId) return { status: 'replayed', approval: existing };
        return rejection('already_approved', existing);
      }
      if (existing?.status === 'invalidated' && existing.summaryDigest === buildSummaryDigest(snapshot)) {
        return rejection('approval_conflict', existing);
      }
      const record = buildRecord(request, snapshot, now());
      return { status: 'approved', approval: deps.approvals.create(record) };
    },
  };
}

export { buildSummaryDigest as computePhaseDeliveryApprovalSummaryDigest };
