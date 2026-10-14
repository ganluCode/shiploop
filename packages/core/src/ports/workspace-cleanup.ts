/**
 * F-008 工作区清理资格判定端口（ports 契约层，纯类型 + 运行时校验，无 I/O）。
 *
 * 验收边界：
 * - 输入为已核验工作区（F-004 清单）、Core 执行/验收结论、停止证据、当前占用、
 *   提交/交付政策与内容清单；输出保留/隔离/可清理与结构化原因；
 * - 纯判定不删目录、不运行 Git、不变更 Task 或 Feature 结果；
 * - 默认无自动清理授权则保留；Runtime completed 或 git status 干净本身均不足；
 * - ignored 内容只有明确确认可再生（regenerable_confirmed）才可能允许清理，
 *   未分类（unclassified）默认保护；
 * - 证据是门槛的一部分：未提供/非法/过期证据不能被当作安全输入（语义判定在
 *   application 层政策中 fail-closed，本层只拒绝结构非法输入）。
 *
 * 本模块不实现：目录删除、Git 操作、清理 operation 登记（F-009）、人工丢弃
 * （F-010）、Task/Feature 状态变更。
 */
import {
  rejectUnknownKeys, requirePlainObject, validateStableId,
  validateNonNegativeInteger, validatePositiveInteger, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORKSPACE_CLEANUP_GATES = ['inspection', 'execution', 'stop', 'occupancy', 'delivery', 'contents', 'authorization'] as const;
export type WorkspaceCleanupGate = typeof WORKSPACE_CLEANUP_GATES[number];

export const WORKSPACE_CLEANUP_REASONS = [
  // 通过依据（可清理时给出）
  'safe_complete_success', 'cleanup_authorized',
  // 核验与扫描
  'workspace_unverified', 'scan_incomplete',
  // 执行/验收结论
  'execution_partial', 'execution_failed', 'execution_unknown',
  'acceptance_pending', 'acceptance_failed', 'acceptance_unknown',
  'manual_review_waiting',
  // 停止证据与占用
  'stop_unknown', 'process_active', 'occupancy_active', 'occupancy_quarantined',
  // 提交/交付政策
  'commit_not_assembled', 'commit_failed', 'commit_pending',
  'artifact_policy_unconfirmed', 'artifacts_not_saved', 'delivery_incomplete',
  // 内容清单保护
  'tracked_changes', 'untracked_changes', 'ignored_protected', 'ignored_unclassified',
  // 清理授权
  'authorization_missing',
  // 证据有效性（逐门槛复用）
  'evidence_missing', 'evidence_invalid', 'evidence_expired',
] as const;
export type WorkspaceCleanupReason = typeof WORKSPACE_CLEANUP_REASONS[number];

/** 证据引用带有效期；判定按 nowUtcMs 核对新鲜度，过期/非法即不作为安全输入。 */
export interface WorkspaceCleanupEvidence {
  readonly ref: string;
  readonly observedAtUtcMs: number;
  readonly expiresAtUtcMs: number;
}
export type WorkspaceCleanupEvidenceGroup = readonly WorkspaceCleanupEvidence[];

export interface WorkspaceCleanupInspectionInput {
  readonly verified: boolean;
  readonly scanComplete: boolean;
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export interface WorkspaceCleanupExecutionInput {
  readonly runtimeOutcome: 'completed' | 'failed' | 'partial' | 'unknown';
  readonly acceptance: 'passed' | 'failed' | 'pending' | 'unknown';
  readonly manualReview: 'none' | 'waiting';
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export type WorkspaceCleanupStopState = 'not_started' | 'confirmed' | 'unknown';
export interface WorkspaceCleanupStopInput {
  readonly state: WorkspaceCleanupStopState;
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export interface WorkspaceCleanupOccupancyInput {
  readonly activeLeases: number;
  readonly processActive: boolean;
  readonly quarantined: boolean;
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export interface WorkspaceCleanupDeliveryInput {
  /** 成果保存政策必须是已确认政策；unconfirmed 一律拒绝。 */
  readonly artifactsPolicy: 'unconfirmed' | 'not_required' | 'save_required';
  readonly artifactsSaved: boolean;
  /** 未装配 P03-8 提交能力时保守保留，不伪造提交成功。 */
  readonly commitCapability: 'assembled' | 'not_assembled';
  readonly commitStatus: 'not_required' | 'succeeded' | 'failed' | 'pending';
  readonly requiredDeliveriesComplete: boolean;
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export type WorkspaceCleanupIgnoredClassification = 'regenerable_confirmed' | 'protected' | 'unclassified';
export interface WorkspaceCleanupIgnoredGroup {
  readonly classification: WorkspaceCleanupIgnoredClassification;
  readonly count: number;
}
export interface WorkspaceCleanupContentsInput {
  readonly trackedChanges: number;
  readonly untrackedChanges: number;
  readonly ignored: readonly WorkspaceCleanupIgnoredGroup[];
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export interface WorkspaceCleanupAuthorizationInput {
  readonly autoCleanup: boolean;
  readonly grantedBy: string | null;
  readonly evidence: WorkspaceCleanupEvidenceGroup;
}
export interface WorkspaceCleanupInput {
  readonly nowUtcMs: number;
  readonly inspection: WorkspaceCleanupInspectionInput;
  readonly execution: WorkspaceCleanupExecutionInput;
  readonly stop: WorkspaceCleanupStopInput;
  readonly occupancy: WorkspaceCleanupOccupancyInput;
  readonly delivery: WorkspaceCleanupDeliveryInput;
  readonly contents: WorkspaceCleanupContentsInput;
  readonly authorization: WorkspaceCleanupAuthorizationInput;
}

export type WorkspaceCleanupOutcome = 'retain' | 'quarantine' | 'cleanable';
export interface WorkspaceCleanupGateResult {
  readonly gate: WorkspaceCleanupGate;
  readonly status: 'passed' | 'refused';
  readonly reasons: readonly WorkspaceCleanupReason[];
}
export interface WorkspaceCleanupDecision {
  readonly schemaVersion: 1;
  readonly outcome: WorkspaceCleanupOutcome;
  /** 非空、按门槛顺序排列的结构化原因；可清理时为通过依据。 */
  readonly reasons: readonly WorkspaceCleanupReason[];
  readonly gates: readonly WorkspaceCleanupGateResult[];
  readonly checkedAtUtcMs: number;
}

const EVIDENCE_MAX_COUNT = 49;
const IGNORED_MAX_GROUPS = 16;

function validateEvidenceGroup(value: unknown, context: ValidationContext, field: string): WorkspaceCleanupEvidenceGroup {
  if (!Array.isArray(value) || value.length > EVIDENCE_MAX_COUNT) {
    throw validationError(context, field, `必须是长度 0..${EVIDENCE_MAX_COUNT} 的证据数组`);
  }
  return value.map((entry, index) => {
    const entryContext = { operation: context.operation };
    const raw = requirePlainObject(entry, entryContext, `${field}[${index}]`);
    rejectUnknownKeys(raw, ['ref', 'observedAtUtcMs', 'expiresAtUtcMs'], entryContext, `${field}[${index}]`);
    return {
      ref: validateStableId(raw.ref, entryContext, `${field}[${index}].ref`),
      observedAtUtcMs: validatePositiveInteger(raw.observedAtUtcMs, entryContext, `${field}[${index}].observedAtUtcMs`),
      expiresAtUtcMs: validatePositiveInteger(raw.expiresAtUtcMs, entryContext, `${field}[${index}].expiresAtUtcMs`),
    };
  });
}

function validateOneOf<T extends string>(value: unknown, allowed: readonly T[], context: ValidationContext, field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationError(context, field, `必须是 ${allowed.join('/')}`, value);
  }
  return value as T;
}

function validateBoolean(value: unknown, context: ValidationContext, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(context, field, '必须是布尔值', value);
  return value;
}

/** 结构校验 fail-closed：非法输入拒绝，不默认为可清理。语义不足由判定返回结构化原因。 */
export function validateWorkspaceCleanupInput(value: unknown): WorkspaceCleanupInput {
  const context: ValidationContext = { operation: 'Workspace.cleanupEligibility' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['nowUtcMs', 'inspection', 'execution', 'stop', 'occupancy', 'delivery', 'contents', 'authorization'], context, 'input');

  const inspectionRaw = requirePlainObject(raw.inspection, context, 'inspection');
  rejectUnknownKeys(inspectionRaw, ['verified', 'scanComplete', 'evidence'], context, 'inspection');
  const executionRaw = requirePlainObject(raw.execution, context, 'execution');
  rejectUnknownKeys(executionRaw, ['runtimeOutcome', 'acceptance', 'manualReview', 'evidence'], context, 'execution');
  const stopRaw = requirePlainObject(raw.stop, context, 'stop');
  rejectUnknownKeys(stopRaw, ['state', 'evidence'], context, 'stop');
  const occupancyRaw = requirePlainObject(raw.occupancy, context, 'occupancy');
  rejectUnknownKeys(occupancyRaw, ['activeLeases', 'processActive', 'quarantined', 'evidence'], context, 'occupancy');
  const deliveryRaw = requirePlainObject(raw.delivery, context, 'delivery');
  rejectUnknownKeys(deliveryRaw, ['artifactsPolicy', 'artifactsSaved', 'commitCapability', 'commitStatus', 'requiredDeliveriesComplete', 'evidence'], context, 'delivery');
  const contentsRaw = requirePlainObject(raw.contents, context, 'contents');
  rejectUnknownKeys(contentsRaw, ['trackedChanges', 'untrackedChanges', 'ignored', 'evidence'], context, 'contents');
  const authorizationRaw = requirePlainObject(raw.authorization, context, 'authorization');
  rejectUnknownKeys(authorizationRaw, ['autoCleanup', 'grantedBy', 'evidence'], context, 'authorization');

  const ignored = contentsRaw.ignored;
  if (!Array.isArray(ignored) || ignored.length > IGNORED_MAX_GROUPS) {
    throw validationError(context, 'contents.ignored', `必须是长度 0..${IGNORED_MAX_GROUPS} 的 ignored 分组数组`);
  }
  const ignoredGroups = ignored.map((entry, index) => {
    const raw = requirePlainObject(entry, context, `contents.ignored[${index}]`);
    rejectUnknownKeys(raw, ['classification', 'count'], context, `contents.ignored[${index}]`);
    return {
      classification: validateOneOf(raw.classification, ['regenerable_confirmed', 'protected', 'unclassified'] as const, context, `contents.ignored[${index}].classification`),
      count: validateNonNegativeInteger(raw.count, context, `contents.ignored[${index}].count`),
    };
  });

  const autoCleanup = validateBoolean(authorizationRaw.autoCleanup, context, 'authorization.autoCleanup');
  let grantedBy: string | null = null;
  if (authorizationRaw.grantedBy !== null && authorizationRaw.grantedBy !== undefined) {
    grantedBy = validateStableId(authorizationRaw.grantedBy, context, 'authorization.grantedBy');
  }
  if (autoCleanup && grantedBy === null) {
    throw validationError(context, 'authorization.grantedBy', '自动清理授权必须记录授权主体');
  }

  return {
    nowUtcMs: validatePositiveInteger(raw.nowUtcMs, context, 'nowUtcMs'),
    inspection: {
      verified: validateBoolean(inspectionRaw.verified, context, 'inspection.verified'),
      scanComplete: validateBoolean(inspectionRaw.scanComplete, context, 'inspection.scanComplete'),
      evidence: validateEvidenceGroup(inspectionRaw.evidence, context, 'inspection.evidence'),
    },
    execution: {
      runtimeOutcome: validateOneOf(executionRaw.runtimeOutcome, ['completed', 'failed', 'partial', 'unknown'] as const, context, 'execution.runtimeOutcome'),
      acceptance: validateOneOf(executionRaw.acceptance, ['passed', 'failed', 'pending', 'unknown'] as const, context, 'execution.acceptance'),
      manualReview: validateOneOf(executionRaw.manualReview, ['none', 'waiting'] as const, context, 'execution.manualReview'),
      evidence: validateEvidenceGroup(executionRaw.evidence, context, 'execution.evidence'),
    },
    stop: {
      state: validateOneOf(stopRaw.state, ['not_started', 'confirmed', 'unknown'] as const, context, 'stop.state'),
      evidence: validateEvidenceGroup(stopRaw.evidence, context, 'stop.evidence'),
    },
    occupancy: {
      activeLeases: validateNonNegativeInteger(occupancyRaw.activeLeases, context, 'occupancy.activeLeases'),
      processActive: validateBoolean(occupancyRaw.processActive, context, 'occupancy.processActive'),
      quarantined: validateBoolean(occupancyRaw.quarantined, context, 'occupancy.quarantined'),
      evidence: validateEvidenceGroup(occupancyRaw.evidence, context, 'occupancy.evidence'),
    },
    delivery: {
      artifactsPolicy: validateOneOf(deliveryRaw.artifactsPolicy, ['unconfirmed', 'not_required', 'save_required'] as const, context, 'delivery.artifactsPolicy'),
      artifactsSaved: validateBoolean(deliveryRaw.artifactsSaved, context, 'delivery.artifactsSaved'),
      commitCapability: validateOneOf(deliveryRaw.commitCapability, ['assembled', 'not_assembled'] as const, context, 'delivery.commitCapability'),
      commitStatus: validateOneOf(deliveryRaw.commitStatus, ['not_required', 'succeeded', 'failed', 'pending'] as const, context, 'delivery.commitStatus'),
      requiredDeliveriesComplete: validateBoolean(deliveryRaw.requiredDeliveriesComplete, context, 'delivery.requiredDeliveriesComplete'),
      evidence: validateEvidenceGroup(deliveryRaw.evidence, context, 'delivery.evidence'),
    },
    contents: {
      trackedChanges: validateNonNegativeInteger(contentsRaw.trackedChanges, context, 'contents.trackedChanges'),
      untrackedChanges: validateNonNegativeInteger(contentsRaw.untrackedChanges, context, 'contents.untrackedChanges'),
      ignored: ignoredGroups,
      evidence: validateEvidenceGroup(contentsRaw.evidence, context, 'contents.evidence'),
    },
    authorization: {
      autoCleanup,
      grantedBy,
      evidence: validateEvidenceGroup(authorizationRaw.evidence, context, 'authorization.evidence'),
    },
  };
}
