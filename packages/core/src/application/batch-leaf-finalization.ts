import { createHash } from 'node:crypto';
import { StorageError } from '../ports/errors.js';
import { stableStringify } from '../ports/feature-plan.js';
import { validateSha256Digest, validateStableId } from '../ports/validation.js';

const OPERATION = 'BatchLeafFinalization';

export interface BatchFinalizationInputRef {
  readonly inputId: string;
  readonly digest: string;
}

export interface BatchFinalizationDependency {
  /** The node receiving the dependency edge. */
  readonly featureId: string;
  /** The predecessor node. */
  readonly dependsOnId: string;
}

/** Immutable facts read from the approved Batch scope. */
export interface BatchFinalizationBatchSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly revision: number;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  readonly approved: boolean;
  readonly featureIds: readonly string[];
  readonly dependencies: readonly BatchFinalizationDependency[];
  readonly targetBaseline: string;
  readonly approvedInputs: readonly BatchFinalizationInputRef[];
  readonly verificationScope: readonly string[];
  readonly strategySummary: Readonly<Record<string, unknown>>;
}

/** Fixed delivery evidence for one Feature; branchHead is observation only. */
export interface BatchFinalizationLeafEvidence {
  readonly featureId: string;
  readonly featureStatus: 'completed' | 'failed' | 'partial' | 'cancelled' | 'running' | 'awaiting_approval';
  readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed';
  readonly revision: number;
  readonly commitSha: string | null;
  readonly repoIdentity: string;
  readonly coveredInputs: readonly BatchFinalizationInputRef[];
  readonly evidenceId: string | null;
  readonly evidenceDigest: string | null;
  readonly evidenceFresh: boolean;
  readonly commitExists: boolean;
  /** Current branch observation. It is compared with commitSha and never substituted into the candidate. */
  readonly branchHead: string | null;
  readonly conflictReason?: string | null;
}

export interface BatchFinalizationLeafSnapshot {
  readonly featureId: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly repoIdentity: string;
  readonly coveredInputs: readonly BatchFinalizationInputRef[];
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

export type BatchFinalizationCandidateStatus =
  | 'pending_integration'
  | 'awaiting_verification'
  | 'reconciliation_required'
  | 'blocked'
  | 'ready_for_phase_approval';

export interface BatchFinalizationCandidate {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly batchRevision: number;
  readonly scopeDigest: string;
  readonly inputDigest: string;
  readonly targetBaseline: string;
  readonly approvedInputs: readonly BatchFinalizationInputRef[];
  readonly leafFeatureIds: readonly string[];
  readonly mergeOrder: readonly string[];
  readonly leaves: readonly BatchFinalizationLeafSnapshot[];
  readonly verificationScope: readonly string[];
  readonly strategySummary: Readonly<Record<string, unknown>>;
  readonly status: BatchFinalizationCandidateStatus;
  readonly integration: BatchFinalizationIntegrationResult | null;
  readonly verification: BatchFinalizationVerificationResult | null;
  readonly workspacePreserved: boolean;
}

export interface BatchFinalizationIntegrationResult {
  readonly status: 'succeeded' | 'blocked' | 'unknown';
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly evidenceId: string | null;
  readonly evidenceDigest: string | null;
  readonly reason?: string | null;
  /** A failed/unknown result keeps the integration workspace for reconciliation. */
  readonly workspacePreserved: boolean;
}

export interface BatchFinalizationVerificationResult {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly evidenceId: string | null;
  readonly evidenceDigest: string | null;
  readonly reason?: string | null;
}

export interface BatchFinalizationCandidateStore {
  read(projectId: string, batchId: string, commandId: string): BatchFinalizationCandidate | null;
  createCandidate(candidate: BatchFinalizationCandidate): BatchFinalizationCandidate;
  recordIntegrationResult(candidateId: string, result: BatchFinalizationIntegrationResult): BatchFinalizationCandidate;
  recordVerificationResult(candidateId: string, result: BatchFinalizationVerificationResult): BatchFinalizationCandidate;
}

export interface BatchFinalizationIntegrationExecutor {
  integrate(candidate: BatchFinalizationCandidate): Promise<BatchFinalizationIntegrationResult>;
}

export interface BatchFinalizationVerificationExecutor {
  verify(
    candidate: BatchFinalizationCandidate,
    integration: BatchFinalizationIntegrationResult,
  ): Promise<BatchFinalizationVerificationResult>;
}

export interface BatchFinalizationPrepareRequest {
  readonly projectId: string;
  readonly batchId: string;
  readonly commandId: string;
}

export interface BatchFinalizationRunRequest extends BatchFinalizationPrepareRequest {}

export type BatchFinalizationPrepareResult =
  | { readonly status: 'blocked'; readonly blockReasons: readonly string[]; readonly candidate: null }
  | { readonly status: 'candidate_created' | 'candidate_replayed'; readonly blockReasons: readonly []; readonly candidate: BatchFinalizationCandidate };

export interface BatchFinalizationRunResult {
  readonly status: BatchFinalizationCandidateStatus | 'blocked';
  readonly blockReasons: readonly string[];
  readonly candidate: BatchFinalizationCandidate | null;
}

export interface BatchLeafFinalizationService {
  prepare(request: BatchFinalizationPrepareRequest): Promise<BatchFinalizationPrepareResult>;
  run(request: BatchFinalizationRunRequest): Promise<BatchFinalizationRunResult>;
}

function fail(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('conflict', `${OPERATION}.prepare`, 'Batch 叶子汇总不可继续', {
    details: { reason, ...details },
  });
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\n${stableStringify(value)}`, 'utf8').digest('hex');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRequest(request: BatchFinalizationPrepareRequest): BatchFinalizationPrepareRequest {
  validateStableId(request?.projectId, { operation: `${OPERATION}.validate` }, 'projectId');
  validateStableId(request?.batchId, { operation: `${OPERATION}.validate` }, 'batchId');
  validateStableId(request?.commandId, { operation: `${OPERATION}.validate` }, 'commandId');
  return request;
}

function validateInput(input: BatchFinalizationInputRef, field: string): BatchFinalizationInputRef {
  return {
    inputId: validateStableId(input.inputId, { operation: `${OPERATION}.validate` }, `${field}.inputId`),
    digest: validateSha256Digest(input.digest, { operation: `${OPERATION}.validate` }, `${field}.digest`),
  };
}

function scopeDigest(snapshot: BatchFinalizationBatchSnapshot): string {
  return digest('shiploop:batch-finalization-scope:v1', {
    schemaVersion: snapshot.schemaVersion,
    projectId: snapshot.projectId,
    phaseId: snapshot.phaseId,
    batchId: snapshot.batchId,
    revision: snapshot.revision,
    featureIds: [...snapshot.featureIds],
    dependencies: [...snapshot.dependencies],
    targetBaseline: snapshot.targetBaseline,
    approvedInputs: [...snapshot.approvedInputs],
    verificationScope: [...snapshot.verificationScope],
    strategySummary: snapshot.strategySummary,
  });
}

function inputDigest(
  snapshot: BatchFinalizationBatchSnapshot,
  leaves: readonly BatchFinalizationLeafSnapshot[],
  mergeOrder: readonly string[],
): string {
  return digest('shiploop:batch-finalization-input:v1', {
    scopeDigest: scopeDigest(snapshot),
    targetBaseline: snapshot.targetBaseline,
    approvedInputs: [...snapshot.approvedInputs],
    leaves: [...leaves],
    mergeOrder: [...mergeOrder],
    verificationScope: [...snapshot.verificationScope],
    strategySummary: snapshot.strategySummary,
  });
}

function candidateId(projectId: string, batchId: string, frozenInputDigest: string): string {
  return digest('shiploop:batch-finalization-candidate:v1', { projectId, batchId, inputDigest: frozenInputDigest });
}

function validateSnapshot(snapshot: BatchFinalizationBatchSnapshot, request: BatchFinalizationPrepareRequest): void {
  if (snapshot.schemaVersion !== 1 || snapshot.projectId !== request.projectId || snapshot.batchId !== request.batchId) {
    fail('batch_identity_mismatch');
  }
  if (snapshot.approved !== true) fail('batch_not_approved');
  if (snapshot.status === 'failed' || snapshot.status === 'cancelled' || snapshot.status === 'interrupted') {
    fail('batch_not_successful', { status: snapshot.status });
  }
  if (snapshot.featureIds.length === 0) fail('empty_batch');
  if (new Set(snapshot.featureIds).size !== snapshot.featureIds.length) fail('duplicate_batch_feature');
  validateStableId(snapshot.phaseId, { operation: `${OPERATION}.validate` }, 'phaseId');
  validateStableId(snapshot.batchId, { operation: `${OPERATION}.validate` }, 'batchId');
  validateStableId(snapshot.projectId, { operation: `${OPERATION}.validate` }, 'projectId');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) fail('invalid_batch_revision');
  const members = new Set(snapshot.featureIds);
  for (const edge of snapshot.dependencies) {
    if (!members.has(edge.featureId) || !members.has(edge.dependsOnId) || edge.featureId === edge.dependsOnId) {
      fail('invalid_batch_dependency', { featureId: edge.featureId, dependsOnId: edge.dependsOnId });
    }
  }
}

function leafIds(snapshot: BatchFinalizationBatchSnapshot): string[] {
  const hasSuccessor = new Set(snapshot.dependencies.map(edge => edge.dependsOnId));
  return snapshot.featureIds.filter(featureId => !hasSuccessor.has(featureId)).sort(compare);
}

function blockedReasons(
  snapshot: BatchFinalizationBatchSnapshot,
  leaves: readonly string[],
  evidenceByFeature: ReadonlyMap<string, BatchFinalizationLeafEvidence | undefined>,
): string[] {
  const reasons: string[] = [];
  if (leaves.length < 2) reasons.push('no_parallel_leaf_set');
  const approvedById = new Map(snapshot.approvedInputs.map(input => [input.inputId, input]));
  const covered = new Set<string>();
  for (const featureId of leaves) {
    const evidence = evidenceByFeature.get(featureId);
    if (evidence === undefined) {
      reasons.push(`missing_leaf_evidence:${featureId}`);
      continue;
    }
    if (evidence.featureId !== featureId) reasons.push(`leaf_identity_mismatch:${featureId}`);
    if (evidence.featureStatus === 'failed' || evidence.featureStatus === 'partial') reasons.push(`feature_failed:${featureId}`);
    if (evidence.featureStatus === 'cancelled') reasons.push(`feature_cancelled:${featureId}`);
    if (evidence.deliveryStatus !== 'succeeded') reasons.push(`delivery_not_succeeded:${featureId}`);
    if (!evidence.commitExists || evidence.commitSha === null) reasons.push(`missing_delivery_commit:${featureId}`);
    if (!evidence.evidenceFresh || evidence.evidenceId === null || evidence.evidenceDigest === null) reasons.push(`stale_delivery_evidence:${featureId}`);
    if (evidence.branchHead !== null && evidence.commitSha !== null && evidence.branchHead !== evidence.commitSha) reasons.push(`input_sha_drift:${featureId}`);
    if (evidence.conflictReason !== undefined && evidence.conflictReason !== null) reasons.push(`unresolved_conflict:${featureId}`);
    for (const input of evidence.coveredInputs) {
      const approved = approvedById.get(input.inputId);
      if (approved === undefined || approved.digest !== input.digest) reasons.push(`input_sha_drift:${featureId}:${input.inputId}`);
      covered.add(input.inputId);
    }
  }
    const identities = new Set<string>();
    for (const featureId of leaves) {
      const evidence = evidenceByFeature.get(featureId);
      if (evidence !== undefined) identities.add(evidence.repoIdentity);
    }
    if (identities.size > 1) reasons.push('repo_identity_mismatch');
  for (const input of snapshot.approvedInputs) if (!covered.has(input.inputId)) reasons.push(`input_coverage_incomplete:${input.inputId}`);
  return [...new Set(reasons)].sort(compare);
}

function buildCandidate(
  request: BatchFinalizationPrepareRequest,
  snapshot: BatchFinalizationBatchSnapshot,
  leaves: readonly string[],
  evidenceByFeature: ReadonlyMap<string, BatchFinalizationLeafEvidence | undefined>,
): BatchFinalizationCandidate {
  const leafSnapshots = leaves.map(featureId => {
    const evidence = evidenceByFeature.get(featureId)!;
    return {
      featureId,
      revision: evidence.revision,
      commitSha: evidence.commitSha!,
      repoIdentity: evidence.repoIdentity,
      coveredInputs: evidence.coveredInputs.map((input, index) => validateInput(input, `leaves.${featureId}.coveredInputs[${index}]`)),
      evidenceId: evidence.evidenceId!,
      evidenceDigest: evidence.evidenceDigest!,
    };
  });
  const mergeOrder = [...leaves];
  const frozenInputDigest = inputDigest(snapshot, leafSnapshots, mergeOrder);
  return {
    schemaVersion: 1,
    candidateId: candidateId(request.projectId, request.batchId, frozenInputDigest),
    commandId: request.commandId,
    projectId: request.projectId,
    phaseId: snapshot.phaseId,
    batchId: request.batchId,
    batchRevision: snapshot.revision,
    scopeDigest: scopeDigest(snapshot),
    inputDigest: frozenInputDigest,
    targetBaseline: snapshot.targetBaseline,
    approvedInputs: snapshot.approvedInputs.map((input, index) => validateInput(input, `approvedInputs[${index}]`)),
    leafFeatureIds: [...leaves],
    mergeOrder,
    leaves: leafSnapshots,
    verificationScope: [...snapshot.verificationScope].sort(compare),
    strategySummary: structuredClone(snapshot.strategySummary),
    status: 'pending_integration',
    integration: null,
    verification: null,
    workspacePreserved: false,
  };
}

function resultStatus(result: BatchFinalizationIntegrationResult): BatchFinalizationCandidateStatus {
  if (result.status === 'succeeded') return 'awaiting_verification';
  if (result.status === 'unknown') return 'reconciliation_required';
  return 'blocked';
}

function validateIntegrationResult(result: BatchFinalizationIntegrationResult): BatchFinalizationIntegrationResult {
  if (!result || !['succeeded', 'blocked', 'unknown'].includes(result.status)
    || typeof result.workspacePreserved !== 'boolean'
    || result.workspacePreserved !== true) {
    throw new StorageError('validation', `${OPERATION}.integration`, '集成结果形状非法', {
      details: { reason: 'integration_evidence_incomplete' },
    });
  }
  if (result.status === 'succeeded'
    && (result.commitSha === null || result.treeSha === null || result.evidenceId === null || result.evidenceDigest === null)) {
    throw new StorageError('validation', `${OPERATION}.integration`, '集成成功结果缺少 commit/tree/证据', {
      details: { reason: 'integration_evidence_incomplete' },
    });
  }
  if (result.evidenceDigest !== null) validateSha256Digest(result.evidenceDigest, { operation: `${OPERATION}.integration` }, 'evidenceDigest');
  return result;
}

function validateVerificationResult(result: BatchFinalizationVerificationResult): BatchFinalizationVerificationResult {
  if (!result || !['passed', 'failed', 'inconclusive'].includes(result.status)) {
    throw new StorageError('validation', `${OPERATION}.verification`, '组合验证结果形状非法', {
      details: { reason: 'verification_evidence_incomplete' },
    });
  }
  if (result.status === 'passed' && (result.evidenceId === null || result.evidenceDigest === null)) {
    throw new StorageError('validation', `${OPERATION}.verification`, '组合验证通过结果缺少证据', {
      details: { reason: 'verification_evidence_incomplete' },
    });
  }
  if (result.evidenceDigest !== null) validateSha256Digest(result.evidenceDigest, { operation: `${OPERATION}.verification` }, 'evidenceDigest');
  return result;
}

export function createBatchLeafFinalizationService(deps: {
  readonly batches: { read(projectId: string, batchId: string): BatchFinalizationBatchSnapshot | undefined };
  readonly leaves: { read(projectId: string, featureId: string): BatchFinalizationLeafEvidence | undefined };
  readonly candidates: BatchFinalizationCandidateStore;
  readonly integrate?: (candidate: BatchFinalizationCandidate) => Promise<BatchFinalizationIntegrationResult>;
  readonly verify?: (candidate: BatchFinalizationCandidate, integration: BatchFinalizationIntegrationResult) => Promise<BatchFinalizationVerificationResult>;
}): BatchLeafFinalizationService {
  if (!deps || !deps.batches || !deps.leaves || !deps.candidates) throw new TypeError(`${OPERATION}.create: dependencies missing`);
  const prepare = async (raw: BatchFinalizationPrepareRequest): Promise<BatchFinalizationPrepareResult> => {
    const request = validateRequest(raw);
    const existing = deps.candidates.read(request.projectId, request.batchId, request.commandId);
    if (existing !== null) return { status: 'candidate_replayed', blockReasons: [], candidate: existing };
    const snapshot = deps.batches.read(request.projectId, request.batchId);
    if (snapshot === undefined) return { status: 'blocked', blockReasons: ['batch_not_found'], candidate: null };
    try { validateSnapshot(snapshot, request); }
    catch (error) {
      if (error instanceof StorageError && typeof error.details?.reason === 'string') {
        return { status: 'blocked', blockReasons: [error.details.reason], candidate: null };
      }
      throw error;
    }
    const leaves = leafIds(snapshot);
    const evidenceByFeature = new Map(leaves.map(featureId => [featureId, deps.leaves.read(request.projectId, featureId)] as const));
    const reasons = blockedReasons(snapshot, leaves, evidenceByFeature);
    if (reasons.length > 0) return { status: 'blocked', blockReasons: reasons, candidate: null };
    const candidate = buildCandidate(request, snapshot, leaves, evidenceByFeature);
    return { status: 'candidate_created', blockReasons: [], candidate: deps.candidates.createCandidate(candidate) };
  };

  const run = async (request: BatchFinalizationRunRequest): Promise<BatchFinalizationRunResult> => {
    const prepared = await prepare(request);
    if (prepared.status === 'blocked' || prepared.candidate === null) return prepared;
    let candidate = prepared.candidate;
    if (prepared.status === 'candidate_replayed') return { status: candidate.status, blockReasons: [], candidate };
    if (deps.integrate === undefined || deps.verify === undefined) {
      return { status: candidate.status, blockReasons: ['integration_executor_unavailable'], candidate };
    }
    let integration: BatchFinalizationIntegrationResult;
    try {
      integration = validateIntegrationResult(await deps.integrate(candidate));
    } catch (error) {
      integration = {
        status: 'unknown', commitSha: null, treeSha: null, evidenceId: null, evidenceDigest: null,
        reason: error instanceof StorageError && typeof error.details?.reason === 'string'
          ? error.details.reason : 'integration_interrupted', workspacePreserved: true,
      };
    }
    candidate = deps.candidates.recordIntegrationResult(candidate.candidateId, integration);
    if (integration.status !== 'succeeded') return { status: resultStatus(integration), blockReasons: [integration.reason ?? resultStatus(integration)], candidate };
    let verification: BatchFinalizationVerificationResult;
    try {
      verification = validateVerificationResult(await deps.verify(candidate, integration));
    } catch (error) {
      verification = {
        status: 'inconclusive', evidenceId: null, evidenceDigest: null,
        reason: error instanceof StorageError && typeof error.details?.reason === 'string'
          ? error.details.reason : 'verification_interrupted',
      };
    }
    candidate = deps.candidates.recordVerificationResult(candidate.candidateId, verification);
    if (verification.status !== 'passed') return { status: candidate.status, blockReasons: [verification.reason ?? 'combined_verification_failed'], candidate };
    return { status: candidate.status, blockReasons: [], candidate };
  };

  return { prepare, run };
}
