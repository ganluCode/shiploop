/** Shared verification plan contract. Pure types/constants, no application dependency. */
import type { CheckDefinition } from './task-verification-policy.js';
import type { TestCandidateRejectionReason } from './verification-candidates.js';

export const VERIFICATION_PLAN_STATUSES = ['ready', 'error', 'inconclusive'] as const;
export type VerificationPlanStatus = (typeof VERIFICATION_PLAN_STATUSES)[number];
export const VERIFICATION_PLAN_MODES = ['candidates', 'full_fallback'] as const;
export type VerificationPlanMode = (typeof VERIFICATION_PLAN_MODES)[number];

export type VerificationPlanReasonCode =
  | 'candidate_covered'
  | 'candidate_missing'
  | 'candidate_invalid'
  | 'candidate_missing_module'
  | 'candidate_extra_module'
  | 'shared_high_risk_change'
  | 'impact_input_invalid'
  | 'impact_unknown'
  | 'local_checks_unavailable'
  | 'fallback_unavailable'
  | 'fallback_invalid'
  | 'fallback_missing_required_check'
  | 'fallback_missing_module';

export interface VerificationPlanCheck {
  readonly checkKey: string;
  readonly scope: CheckDefinition['scope'];
  readonly kind: CheckDefinition['kind'];
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeout: number;
  readonly required: boolean;
  readonly requirementRefs: readonly string[];
}

export interface VerificationPlan {
  readonly status: VerificationPlanStatus;
  readonly mode: VerificationPlanMode;
  /** 影响判定按政策模块顺序稳定输出。 */
  readonly affectedModules: readonly string[];
  /** 候选实际覆盖或全量回退声明覆盖的模块。 */
  readonly coveredModules: readonly string[];
  /** 只包含最终允许启动的检查；error/inconclusive 必须为空。 */
  readonly selectedCheckKeys: readonly string[];
  readonly selectedChecks: readonly VerificationPlanCheck[];
  /** 可信定义中本计划不会启动的检查，便于断言未启动不相关检查。 */
  readonly unselectedCheckKeys: readonly string[];
  readonly reasonCode: VerificationPlanReasonCode;
  readonly reason: string;
  readonly candidateDigest: string | null;
  readonly candidateRejection: {
    readonly reason: TestCandidateRejectionReason | 'candidate_missing';
    readonly detail: string;
  } | null;
}

