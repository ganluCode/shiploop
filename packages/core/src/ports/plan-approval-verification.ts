/**
 * P03-2 / F-003 有效批准核验纯契约（ports 层：检查政策身份摘要与有效批准
 * 评估纯规则；无 I/O、无时钟、无数据库）。
 *
 * 设计依据：p03-plan-approval PRD（版本 0.3）FR-1「批准前后实质要求变化必须
 * 使旧批准过期」与可验证验收标准 2「批准绑定 planDigest；需求或检查政策改动
 * 后不能用旧批准执行；标签变化不导致无关失效」、core-design/02 §10（修改要求
 * 或依赖更新当前计划并使旧批准失效）、core-design/11 §7（approvals 只批准
 * 具体版本，主体摘要变更使旧批准失效）。
 * 实施契约：docs/p03-2-plan-approval-verification-contract.md（本模块契约文档）。
 *
 * 审批覆盖的实质输入身份（F-003 定案）：
 * - 要求、完整 acceptance、依赖：由前序确定性 planDigest（P03-1 冻结的业务
 *   摘要，computeFeaturePlanDigest）覆盖，本模块不改变其计算；
 * - 适用检查政策：以**显式绑定核验值**覆盖——决策时把当前有效
 *   `policies.verification` 段的内容摘要（computeFeatureCheckPolicyDigest）
 *   随决策记录持久化（approvals.check_policy_digest，迁移 v8）。核验值是政策
 *   内容的确定性函数：不依赖可变配置路径、不依赖通用配置 revision、不依赖
 *   labels；策略段（modelMap/defaultStrategy 等路由）不在检查政策身份内，
 *   项目默认路由变化不使批准失效（设计 02 §9：不追溯 Task 策略）。
 *
 * 有效性是纯计算（不在配置变更时回写实体）：评估输入取自同一权威状态视图
 * （Feature 当前 planDigest/planStatus、全部决策记录、当前适用检查政策摘要），
 * 旧决策行永不改写（历史证据保留）。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import type { VerificationPolicyV2 } from './settings-schema.js';
import type { FeaturePlanStatus, PlanApprovalStatus } from './plan-store.js';

/**
 * 检查政策身份摘要的领域前缀：把摘要锚定到「Feature 计划适用检查政策 v1」
 * 语义，防止与 planDigest 或其他领域的规范化串碰撞。
 */
export const CHECK_POLICY_DIGEST_DOMAIN = 'shiploop:feature-plan-check-policy:v1';

/**
 * 适用检查政策身份摘要：SHA-256(`${CHECK_POLICY_DIGEST_DOMAIN}\n${canonical}`)，
 * 64 位小写十六进制。canonical 是有效 verification 政策段的规范化 JSON
 * （对象键递归排序、undefined 键省略；与 planDigest 同一稳定序列化规则）；
 * 双方均未配置 verification 段时摘要锚定显式 null 形态（`null` 与 `{}`/缺省
 * 可区分，且与任何实配政策不碰撞）。输入必须先经 settings-schema 校验
 * （有效配置合并输出），本函数只接收已校验的政策段值。
 */
export function computeFeatureCheckPolicyDigest(verification: VerificationPolicyV2 | undefined): string {
  const canonical = stableStringify({ verificationPolicy: verification ?? null });
  return createHash('sha256').update(`${CHECK_POLICY_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * 有效批准评估（纯规则）
 * ------------------------------------------------------------------ */

/**
 * 有效批准核验原因词汇（冻结）：
 * - approved：当前身份（planDigest + 检查政策摘要）有 approved 决策且
 *   planStatus=approved——可作为后续显式执行授权的审批依据（仍不是启动授权）；
 * - no_plan：无当前计划摘要（从未导入有效计划）；
 * - no_tasks：零 Task 不可执行计划（与 FEATURE_NOT_EXECUTABLE_REASONS 同词汇）；
 * - not_approved：当前身份从未被决定（未批准）；
 * - rejected：当前计划摘要存在 rejected 决策（拒绝不提供执行依据；政策变化
 *   不赦免同摘要拒绝）；
 * - plan_changed：实质计划变化（要求/验收/依赖等摘要输入）使旧批准过期——
 *   当前摘要无 approved 决策但有旧摘要 approved 决策，或决策后计划被修订
 *   （planStatus 已回 draft）；
 * - check_policy_changed：适用检查政策变化使旧批准过期——当前摘要存在
 *   approved 决策但绑定的检查政策摘要不是当前值（含 v7 遗留 NULL 绑定）；
 * - approval_state_inconsistent：planStatus=approved 但当前身份无 approved
 *   决策记录（fail-closed 防御桶；正常命令通道不可达）。
 */
export const PLAN_APPROVAL_VERIFICATION_REASONS = [
  'approved',
  'no_plan',
  'no_tasks',
  'not_approved',
  'rejected',
  'plan_changed',
  'check_policy_changed',
  'approval_state_inconsistent',
] as const;
export type PlanApprovalVerificationReason = (typeof PLAN_APPROVAL_VERIFICATION_REASONS)[number];

/** 评估输入所需的最小决策记录面（id + 绑定身份 + 状态）。 */
export interface PlanApprovalDecisionIdentity {
  readonly id: string;
  readonly subjectDigest: string;
  /** 决策绑定的检查政策摘要（v7 遗留升级为 null——不等于任何当前身份）。 */
  readonly checkPolicyDigest: string | null;
  readonly status: PlanApprovalStatus;
}

/**
 * 有效批准评估输入：全部取自同一权威状态视图（同一读事务或同一写事务内），
 * 不混合不同时刻的读结果。
 */
export interface PlanApprovalValidityInput {
  /** Feature 当前计划业务摘要（可空）。 */
  readonly planDigest: string | null;
  /** Feature 当前权威审批状态。 */
  readonly planStatus: FeaturePlanStatus;
  /** 当前计划任务数（零 Task 不可执行）。 */
  readonly taskCount: number;
  /** 该 Feature 的全部决策记录（含历史；同主体同身份至多一条）。 */
  readonly decisions: readonly PlanApprovalDecisionIdentity[];
  /** 当前适用检查政策摘要（computeFeatureCheckPolicyDigest 输出）。 */
  readonly currentCheckPolicyDigest: string;
}

/** 有效批准评估结果（fail-closed：valid=false 恒携带明确原因词汇）。 */
export interface PlanApprovalValidity {
  readonly valid: boolean;
  readonly reason: PlanApprovalVerificationReason;
  readonly planDigest: string | null;
  readonly checkPolicyDigest: string;
  /** 绑定当前身份（planDigest + 当前检查政策摘要）的决策记录 ID；无则 null。 */
  readonly currentDecisionId: string | null;
}

/**
 * 有效批准评估纯规则（确定性顺序，fail-closed）：
 * 1. 无当前摘要 → no_plan；零 Task → no_tasks；
 * 2. 当前身份（planDigest + 当前检查政策摘要）决策：rejected → rejected；
 *    approved 且 planStatus=approved → valid；approved 但 planStatus≠approved
 *    （决策后计划被修订重置）→ plan_changed；
 * 3. 当前摘要（任意政策绑定）有 rejected 决策 → rejected（政策变化不赦免
 *    同摘要拒绝）；有 approved 决策但绑定非当前检查政策 → check_policy_changed
 *   （过期；v7 遗留 NULL 绑定同）；
 * 4. planStatus=approved 但无当前身份 approved 决策 → approval_state_inconsistent；
 * 5. 存在旧摘要 approved 决策 → plan_changed；否则 → not_approved。
 */
export function evaluatePlanApprovalValidity(input: PlanApprovalValidityInput): PlanApprovalValidity {
  const base = {
    planDigest: input.planDigest,
    checkPolicyDigest: input.currentCheckPolicyDigest,
  };
  const invalid = (reason: PlanApprovalVerificationReason, currentDecisionId: string | null = null): PlanApprovalValidity => ({
    valid: false,
    reason,
    ...base,
    currentDecisionId,
  });
  if (input.planDigest === null) {
    return invalid('no_plan');
  }
  if (input.taskCount === 0) {
    return invalid('no_tasks');
  }
  const identityDecision = input.decisions.find(
    (decision) =>
      decision.subjectDigest === input.planDigest &&
      decision.checkPolicyDigest === input.currentCheckPolicyDigest,
  );
  if (identityDecision !== undefined) {
    if (identityDecision.status === 'rejected') {
      return invalid('rejected', identityDecision.id);
    }
    if (identityDecision.status === 'approved') {
      if (input.planStatus === 'approved') {
        return { valid: true, reason: 'approved', ...base, currentDecisionId: identityDecision.id };
      }
      return invalid('plan_changed', identityDecision.id);
    }
    return invalid('not_approved', identityDecision.id);
  }
  const sameDigest = input.decisions.filter((decision) => decision.subjectDigest === input.planDigest);
  const sameDigestRejected = sameDigest.find((decision) => decision.status === 'rejected');
  if (sameDigestRejected !== undefined) {
    return invalid('rejected', sameDigestRejected.id);
  }
  const sameDigestApproved = sameDigest.find((decision) => decision.status === 'approved');
  if (sameDigestApproved !== undefined) {
    return invalid('check_policy_changed', sameDigestApproved.id);
  }
  if (input.planStatus === 'approved') {
    return invalid('approval_state_inconsistent');
  }
  const staleApproved = input.decisions.find((decision) => decision.status === 'approved');
  if (staleApproved !== undefined) {
    return invalid('plan_changed', staleApproved.id);
  }
  return invalid('not_approved');
}
