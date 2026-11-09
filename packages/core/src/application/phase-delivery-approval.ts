import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BatchFinalizationCandidate, BatchFinalizationInputRef, BatchFinalizationLeafEvidence } from './batch-leaf-finalization.js';
import { StorageError } from '../ports/errors.js';
import { stableStringify } from '../ports/feature-plan.js';
import { validateSha256Digest, validateStableId } from '../ports/validation.js';

/**
 * P08 DAG F-012：Phase 最终交付的叶子集成汇总门禁。
 *
 * Phase 交付入口不信任单一 Batch 候选自身的叶子清单：它依据冻结的
 * Phase revision、获准 Batch revision 与 Feature DAG revision 枚举整个
 * Phase 的获准叶子（无 Phase 内后继的并行叶子），逐叶子核对 delivery
 * commit、集成 commit/tree、验证证据与输入覆盖。缺叶子、缺集成、
 * 证据过期、目标 baseline 或策略漂移都拒绝交付；最后完成的叶子或
 * Feature completed 不构成整阶段成果。
 *
 * 复用边界：Phase 集成与后继 Feature 集成共用同一 BatchFinalization
 * 候选管线（deterministic integration / 受监督 GitAgent 修复路径），
 * 本模块不引入第二套 Git operation、worktree、锁、证据或恢复实现。
 * Feature 验收完成不会自动批准 Phase，也不会自动合并 main：
 * phases.delivery_status 只能由显式人工批准（commandId/actorId）翻转，
 * 实战父分支与失败事实保持独立。
 */
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
  /** 冻结 Phase 范围事实；缺失时 Phase 交付入口拒绝而不是退回单 Batch 视图。 */
  readonly phaseScope: PhaseDeliveryScopeSnapshot;
}

/** Phase 范围 Feature DAG 依赖边（featureId 依赖 dependsOnId）。 */
export interface PhaseDeliveryScopeDependency {
  readonly featureId: string;
  readonly dependsOnId: string;
}

/** Phase 内一个获准执行 Batch 的冻结引用。 */
export interface PhaseDeliveryScopeBatchRef {
  readonly batchId: string;
  readonly revision: number;
  readonly status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  readonly approved: boolean;
  readonly featureIds: readonly string[];
}

/**
 * 冻结的 Phase 级交付范围事实，由可信快照源在同一读取中提供。
 * dagDigest 必须等于 computePhaseDeliveryDagDigest(featureIds, dependencies)，
 * 用于批准 CAS 与持久化时复核，防止批准与读取之间 DAG 被改写。
 */
export interface PhaseDeliveryScopeSnapshot {
  readonly phase: { readonly projectId: string; readonly phaseId: string; readonly revision: number; readonly status: 'open' | 'closed' | 'archived' };
  readonly dagDigest: string;
  readonly featureIds: readonly string[];
  readonly dependencies: readonly PhaseDeliveryScopeDependency[];
  readonly batches: readonly PhaseDeliveryScopeBatchRef[];
  readonly approvedInputs: readonly BatchFinalizationInputRef[];
  readonly targetBaseline: string;
  readonly strategySummary: Readonly<Record<string, unknown>>;
  /** Phase DAG 每个叶子的当前交付证据；分支观察只用于比对，不替代冻结事实。 */
  readonly leaves: readonly BatchFinalizationLeafEvidence[];
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
  /** 批准依据的冻结 Phase revision；历史行可能为 null。 */
  readonly phaseRevision: number | null;
  /** 批准依据的冻结 Feature DAG 摘要；历史行可能为 null。 */
  readonly dagDigest: string | null;
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
  /** 可选冻结 Phase revision CAS；命令通道接线后由 payload 提供。 */
  readonly expectedPhaseRevision?: number;
  /** 可选冻结 DAG revision 摘要 CAS。 */
  readonly expectedDagDigest?: string;
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
  | 'phase_scope_missing'
  | 'phase_scope_invalid'
  | 'phase_revision_stale'
  | 'dag_revision_stale'
  | 'phase_archived'
  | 'phase_leaf_missing'
  | 'phase_leaf_foreign'
  | 'phase_leaf_not_delivered'
  | 'phase_leaf_outside_approved_batch'
  | 'phase_input_coverage_incomplete'
  | 'target_baseline_drift'
  | 'policy_drift'
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

/** 冻结 Phase Feature DAG revision 摘要；与输入顺序无关，只由节点与依赖边集合决定。 */
export function computePhaseDeliveryDagDigest(
  featureIds: readonly string[],
  dependencies: readonly PhaseDeliveryScopeDependency[],
): string {
  return digest('shiploop:phase-delivery-dag:v1', {
    featureIds: [...featureIds].sort(compare),
    dependencies: [...dependencies].map(edge => ({ featureId: edge.featureId, dependsOnId: edge.dependsOnId })).sort((left, right) =>
      compare(`${left.featureId}\u0000${left.dependsOnId}`, `${right.featureId}\u0000${right.dependsOnId}`)),
  });
}

/** 枚举 Phase DAG 中无 Phase 内后继的叶子（并行叶子集），稳定排序。 */
export function enumeratePhaseDeliveryLeaves(
  featureIds: readonly string[],
  dependencies: readonly PhaseDeliveryScopeDependency[],
): string[] {
  const hasSuccessor = new Set(dependencies.map(edge => edge.dependsOnId));
  return featureIds.filter(featureId => !hasSuccessor.has(featureId)).sort(compare);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  if (request.expectedPhaseRevision !== undefined
    && (!Number.isSafeInteger(request.expectedPhaseRevision) || request.expectedPhaseRevision < 1)) {
    throw new StorageError('validation', OPERATION, '批准请求 Phase revision 非法');
  }
  if (request.expectedDagDigest !== undefined) {
    validateSha256Digest(request.expectedDagDigest, { operation: `${OPERATION}.validate` }, 'expectedDagDigest');
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
    phaseScope: snapshot.phaseScope === undefined ? null : {
      phaseRevision: snapshot.phaseScope.phase.revision,
      dagDigest: snapshot.phaseScope.dagDigest,
      batches: snapshot.phaseScope.batches.map(batch => ({
        batchId: batch.batchId, revision: batch.revision, status: batch.status,
        approved: batch.approved, featureIds: [...batch.featureIds].sort(compare),
      })),
      approvedInputs: snapshot.phaseScope.approvedInputs,
      targetBaseline: snapshot.phaseScope.targetBaseline,
      strategySummary: snapshot.phaseScope.strategySummary,
      leaves: snapshot.phaseScope.leaves.map(leaf => ({
        featureId: leaf.featureId, revision: leaf.revision, commitSha: leaf.commitSha,
        deliveryStatus: leaf.deliveryStatus, evidenceId: leaf.evidenceId,
        evidenceDigest: leaf.evidenceDigest, evidenceFresh: leaf.evidenceFresh,
        commitExists: leaf.commitExists, branchHead: leaf.branchHead,
        repoIdentity: leaf.repoIdentity, coveredInputs: leaf.coveredInputs,
      })),
    },
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
  return validatePhaseScope(request, snapshot);
}

/**
 * Phase 级叶子汇总门禁：依据冻结 Phase/DAG revision 枚举全部获准叶子，
 * 逐叶子核对交付 commit、集成证据与输入覆盖；任何缺失、过期或漂移都拒绝。
 */
function validatePhaseScope(request: PhaseDeliveryApprovalRequest, snapshot: PhaseDeliveryApprovalSnapshot): PhaseDeliveryApprovalRejectionReason | null {
  const scopeValue = snapshot.phaseScope;
  if (scopeValue === undefined || scopeValue === null || typeof scopeValue !== 'object') return 'phase_scope_missing';
  const { candidate } = snapshot;
  if (scopeValue.phase?.projectId !== request.projectId) return 'cross_project';
  if (scopeValue.phase?.phaseId !== request.phaseId) return 'cross_phase';
  if (request.expectedPhaseRevision !== undefined && scopeValue.phase.revision !== request.expectedPhaseRevision) return 'phase_revision_stale';
  if (request.expectedDagDigest !== undefined && scopeValue.dagDigest !== request.expectedDagDigest) return 'dag_revision_stale';
  if (scopeValue.phase.status === 'archived') return 'phase_archived';
  if (!Array.isArray(scopeValue.featureIds) || scopeValue.featureIds.length === 0
    || !Array.isArray(scopeValue.dependencies) || !Array.isArray(scopeValue.batches)
    || !Array.isArray(scopeValue.approvedInputs) || !Array.isArray(scopeValue.leaves)
    || !scopeValue.phase.revision || !Number.isSafeInteger(scopeValue.phase.revision)) return 'phase_scope_invalid';
  const members = new Set(scopeValue.featureIds);
  if (members.size !== scopeValue.featureIds.length) return 'phase_scope_invalid';
  for (const edge of scopeValue.dependencies) {
    if (!members.has(edge.featureId) || !members.has(edge.dependsOnId) || edge.featureId === edge.dependsOnId) return 'phase_scope_invalid';
  }
  if (scopeValue.dagDigest !== computePhaseDeliveryDagDigest(scopeValue.featureIds, scopeValue.dependencies)) return 'phase_scope_invalid';
  for (const batchRef of scopeValue.batches) {
    if (!Array.isArray(batchRef?.featureIds) || batchRef.featureIds.some((id: string) => !members.has(id))) return 'phase_scope_invalid';
  }
  const phaseLeaves = enumeratePhaseDeliveryLeaves(scopeValue.featureIds, scopeValue.dependencies);
  const candidateLeafIds = new Set(candidate.leafFeatureIds);
  const phaseLeafSet = new Set(phaseLeaves);
  for (const leafId of phaseLeaves) if (!candidateLeafIds.has(leafId)) return 'phase_leaf_missing';
  for (const leafId of candidate.leafFeatureIds) if (!phaseLeafSet.has(leafId)) return 'phase_leaf_foreign';
  const evidenceByFeature = new Map(scopeValue.leaves.map(leaf => [leaf.featureId, leaf] as const));
  const frozenByFeature = new Map(candidate.leaves.map(leaf => [leaf.featureId, leaf] as const));
  for (const leafId of phaseLeaves) {
    const evidence = evidenceByFeature.get(leafId);
    if (evidence === undefined) return 'phase_leaf_missing';
    if (!scopeValue.batches.some(batchRef => batchRef.approved === true && batchRef.status === 'succeeded' && batchRef.featureIds.includes(leafId))) {
      return 'phase_leaf_outside_approved_batch';
    }
    if (evidence.featureStatus !== 'completed' || evidence.deliveryStatus !== 'succeeded'
      || evidence.commitSha === null || !evidence.commitExists
      || evidence.evidenceId === null || evidence.evidenceDigest === null || !evidence.evidenceFresh
      || (evidence.branchHead !== null && evidence.branchHead !== evidence.commitSha)
      || (evidence.conflictReason ?? null) !== null) return 'phase_leaf_not_delivered';
    const frozen = frozenByFeature.get(leafId);
    if (frozen === undefined || frozen.commitSha !== evidence.commitSha
      || frozen.evidenceId !== evidence.evidenceId || frozen.evidenceDigest !== evidence.evidenceDigest
      || frozen.repoIdentity !== evidence.repoIdentity) return 'phase_leaf_not_delivered';
  }
  const approvedDigestById = new Map(scopeValue.approvedInputs.map(input => [input.inputId, input.digest] as const));
  const coveredInputs = new Set<string>();
  for (const leaf of candidate.leaves) {
    for (const input of leaf.coveredInputs) {
      if (approvedDigestById.get(input.inputId) !== input.digest) return 'phase_input_coverage_incomplete';
      coveredInputs.add(input.inputId);
    }
  }
  for (const inputId of approvedDigestById.keys()) if (!coveredInputs.has(inputId)) return 'phase_input_coverage_incomplete';
  if (candidate.targetBaseline !== scopeValue.targetBaseline) return 'target_baseline_drift';
  if (!isDeepStrictEqual(candidate.strategySummary, scopeValue.strategySummary)) return 'policy_drift';
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
    phaseRevision: snapshot.phaseScope.phase.revision,
    dagDigest: snapshot.phaseScope.dagDigest,
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
