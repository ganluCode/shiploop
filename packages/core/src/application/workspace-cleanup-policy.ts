/**
 * F-008 工作区清理资格判定政策（application 层纯函数）。
 *
 * 不变量：
 * - 纯判定：不删目录、不运行 Git、不读写存储、不变更 Task 或 Feature 结果；
 *   输入结构校验 fail-closed（StorageError kind='validation'），语义不足不抛错，
 *   而是返回保留/隔离/可清理与结构化原因；
 * - 默认保留：仅当全部门槛通过且存在明确自动清理授权才返回 cleanable；
 *   Runtime completed 或 git status 干净本身均不足以授权清理；
 * - 逐项拒绝：失败、partial、人审等待、提交失败/缺证据、必需交付未完成、
 *   tracked/untracked 改动、未知/受保护 ignored 内容、不完整扫描全部列出原因；
 * - 停止/占用/隔离未确认 → quarantine（隔离现场），其余门槛失败 → retain；
 * - 证据门槛：每组证据必须全部有效且未过期（相对 nowUtcMs），未提供/非法/过期
 *   一律不作为安全输入；
 * - 未装配 P03-8 提交能力（commitCapability='not_assembled'）时保守保留，
 *   即使声称提交成功也不采信，不伪造提交成功；
 * - ignored 内容仅 regenerable_confirmed 允许，protected/unclassified 默认保护。
 *
 * 判定结果只描述资格；实际清理由 F-009 清理 operation 在删除前重核后执行。
 */
import type {
  WorkspaceCleanupDecision, WorkspaceCleanupEvidenceGroup, WorkspaceCleanupGate,
  WorkspaceCleanupGateResult, WorkspaceCleanupInput, WorkspaceCleanupReason,
} from '../ports/workspace-cleanup.js';
import { validateWorkspaceCleanupInput } from '../ports/workspace-cleanup.js';

/** 停止/占用/隔离门槛失败表示现场仍可能被写入，只能隔离，不能清理或普通保留。 */
const QUARANTINE_GATES: readonly WorkspaceCleanupGate[] = ['stop', 'occupancy'];

/**
 * 证据语义核对：整组必须非空、全部有效（时间关系成立且不来自未来）且未过期。
 * 返回 null 表示该组证据可作为安全输入，否则给出结构化拒绝原因。
 */
function evaluateEvidence(evidence: WorkspaceCleanupEvidenceGroup, nowUtcMs: number): WorkspaceCleanupReason | null {
  if (evidence.length === 0) return 'evidence_missing';
  for (const entry of evidence) {
    if (entry.observedAtUtcMs > nowUtcMs || entry.expiresAtUtcMs <= entry.observedAtUtcMs) return 'evidence_invalid';
  }
  for (const entry of evidence) {
    if (nowUtcMs > entry.expiresAtUtcMs) return 'evidence_expired';
  }
  return null;
}

function gate(gateName: WorkspaceCleanupGate, refusals: readonly WorkspaceCleanupReason[], evidenceReason: WorkspaceCleanupReason | null):
  WorkspaceCleanupGateResult {
  const reasons = evidenceReason === null ? [...refusals] : [...refusals, evidenceReason];
  return { gate: gateName, status: reasons.length === 0 ? 'passed' : 'refused', reasons };
}

/** 纯判定入口：外部 unknown 输入先经端口结构校验，再按门槛评估。 */
export function decideWorkspaceCleanup(raw: unknown): WorkspaceCleanupDecision {
  const input: WorkspaceCleanupInput = validateWorkspaceCleanupInput(raw);
  const { nowUtcMs } = input;

  const gates: WorkspaceCleanupGateResult[] = [];

  const inspectionRefusals: WorkspaceCleanupReason[] = [];
  if (!input.inspection.verified) inspectionRefusals.push('workspace_unverified');
  if (!input.inspection.scanComplete) inspectionRefusals.push('scan_incomplete');
  gates.push(gate('inspection', inspectionRefusals, evaluateEvidence(input.inspection.evidence, nowUtcMs)));

  const executionRefusals: WorkspaceCleanupReason[] = [];
  if (input.execution.runtimeOutcome === 'partial') executionRefusals.push('execution_partial');
  else if (input.execution.runtimeOutcome === 'failed') executionRefusals.push('execution_failed');
  else if (input.execution.runtimeOutcome === 'unknown') executionRefusals.push('execution_unknown');
  if (input.execution.acceptance === 'pending') executionRefusals.push('acceptance_pending');
  else if (input.execution.acceptance === 'failed') executionRefusals.push('acceptance_failed');
  else if (input.execution.acceptance === 'unknown') executionRefusals.push('acceptance_unknown');
  if (input.execution.manualReview === 'waiting') executionRefusals.push('manual_review_waiting');
  gates.push(gate('execution', executionRefusals, evaluateEvidence(input.execution.evidence, nowUtcMs)));

  const stopRefusals: WorkspaceCleanupReason[] = [];
  if (input.stop.state === 'unknown') stopRefusals.push('stop_unknown');
  gates.push(gate('stop', stopRefusals, evaluateEvidence(input.stop.evidence, nowUtcMs)));

  const occupancyRefusals: WorkspaceCleanupReason[] = [];
  if (input.occupancy.processActive) occupancyRefusals.push('process_active');
  if (input.occupancy.activeLeases > 0) occupancyRefusals.push('occupancy_active');
  if (input.occupancy.quarantined) occupancyRefusals.push('occupancy_quarantined');
  gates.push(gate('occupancy', occupancyRefusals, evaluateEvidence(input.occupancy.evidence, nowUtcMs)));

  const deliveryRefusals: WorkspaceCleanupReason[] = [];
  if (input.delivery.artifactsPolicy === 'unconfirmed') deliveryRefusals.push('artifact_policy_unconfirmed');
  else if (input.delivery.artifactsPolicy === 'save_required' && !input.delivery.artifactsSaved) deliveryRefusals.push('artifacts_not_saved');
  if (input.delivery.commitCapability === 'not_assembled') deliveryRefusals.push('commit_not_assembled');
  else if (input.delivery.commitStatus === 'failed') deliveryRefusals.push('commit_failed');
  else if (input.delivery.commitStatus === 'pending') deliveryRefusals.push('commit_pending');
  if (!input.delivery.requiredDeliveriesComplete) deliveryRefusals.push('delivery_incomplete');
  gates.push(gate('delivery', deliveryRefusals, evaluateEvidence(input.delivery.evidence, nowUtcMs)));

  const contentsRefusals: WorkspaceCleanupReason[] = [];
  if (input.contents.trackedChanges > 0) contentsRefusals.push('tracked_changes');
  if (input.contents.untrackedChanges > 0) contentsRefusals.push('untracked_changes');
  for (const group of input.contents.ignored) {
    if (group.count === 0) continue;
    if (group.classification === 'protected') contentsRefusals.push('ignored_protected');
    else if (group.classification === 'unclassified') contentsRefusals.push('ignored_unclassified');
  }
  gates.push(gate('contents', contentsRefusals, evaluateEvidence(input.contents.evidence, nowUtcMs)));

  const authorizationRefusals: WorkspaceCleanupReason[] = [];
  if (!input.authorization.autoCleanup) authorizationRefusals.push('authorization_missing');
  gates.push(gate('authorization', authorizationRefusals, evaluateEvidence(input.authorization.evidence, nowUtcMs)));

  const refused = gates.filter(g => g.status === 'refused');
  if (refused.length === 0) {
    return {
      schemaVersion: 1,
      outcome: 'cleanable',
      reasons: ['safe_complete_success', 'cleanup_authorized'],
      gates,
      checkedAtUtcMs: nowUtcMs,
    };
  }

  const reasons: WorkspaceCleanupReason[] = [];
  for (const result of refused) {
    for (const reason of result.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  const quarantine = refused.some(g => QUARANTINE_GATES.includes(g.gate));
  return {
    schemaVersion: 1,
    outcome: quarantine ? 'quarantine' : 'retain',
    reasons,
    gates,
    checkedAtUtcMs: nowUtcMs,
  };
}
