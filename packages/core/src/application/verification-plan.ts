/**
 * P03-7 / F-004 Task 检查计划（纯规则 application 契约）。
 *
 * 影响输入来自已经完成权限与工作区核验的路径集合；本模块不扫描 Git、不读取文件、
 * 不启动命令。候选只决定局部目标是否覆盖影响模块，argv/cwd/environment/timeout
 * 始终从用户确认的 CheckDefinition 复制。任何不确定性均进入安全全量分支；全量
 * 回退自身不完整时返回 error/inconclusive，绝不产出空计划或部分放行计划。
 */
import type {
  CheckDefinition,
  ConfirmedTaskVerificationPolicy,
} from '../ports/task-verification-policy.js';
import { validateConfirmedTaskVerificationPolicy } from '../ports/task-verification-policy.js';
import type { VerificationPlan, VerificationPlanCheck, VerificationPlanReasonCode } from '../ports/verification-plan.js';
export { VERIFICATION_PLAN_STATUSES, VERIFICATION_PLAN_MODES } from '../ports/verification-plan.js';
export type { VerificationPlan, VerificationPlanCheck, VerificationPlanReasonCode, VerificationPlanStatus, VerificationPlanMode } from '../ports/verification-plan.js';
import type { TestCandidateSelection, TestCandidateRejection } from './verification-candidates.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
  type ValidationContext,
} from '../ports/validation.js';

export const VERIFICATION_PLAN_OPERATION = 'TaskVerification.plan';
/** 已由 WorkspaceInspector 汇总的真实 tracked/untracked/deleted 路径。 */
export interface VerificationChangedPathInput {
  readonly path: string;
  /** 仅供查询和审计；影响判定对三种状态一视同仁。 */
  readonly state?: 'added' | 'modified' | 'deleted' | 'untracked';
}

export interface VerificationPlanInput {
  readonly policy: unknown;
  /** 可使用字符串简写，或带状态的 tracked/untracked/deleted 记录。 */
  readonly changedPaths: readonly (string | VerificationChangedPathInput)[];
  /** F-003 已完成的选择；null/undefined 表示候选缺失。 */
  readonly candidate?: TestCandidateSelection | TestCandidateRejection | null;
}

const PLAN_INPUT_KEYS = ['policy', 'changedPaths', 'candidate'] as const;
const CHANGE_KEYS = ['path', 'state'] as const;
const MAX_CHANGED_PATHS = 20_000;
const MAX_PATH_LENGTH = 4096;

function context(): ValidationContext {
  return { operation: VERIFICATION_PLAN_OPERATION, entity: { type: 'task' } };
}

function copyCheck(check: CheckDefinition): VerificationPlanCheck {
  return {
    checkKey: check.checkKey,
    scope: check.scope,
    kind: check.kind,
    argv: [...check.argv],
    cwdRef: check.cwdRef,
    environmentRef: check.environmentRef,
    timeout: check.timeout,
    required: check.required,
    requirementRefs: [...check.requirementRefs],
  };
}

function isInsideOrSame(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function invalidPath(path: unknown): boolean {
  return typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH
    || /[\0-\x1f\x7f]/.test(path) || path.startsWith('/') || path.startsWith('~')
    || /^[A-Za-z]:/.test(path) || path.includes('\\')
    || path.split('/').some((part) => part.length === 0 || part === '.' || part === '..');
}

function normalizeChangedPaths(value: unknown): { paths: string[]; invalid: boolean } {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_PATHS) {
    return { paths: [], invalid: true };
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  let invalid = false;
  for (const raw of value) {
    let path: unknown = raw;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const object = raw as Record<string, unknown>;
      if (Object.keys(object).some((key) => !(CHANGE_KEYS as readonly string[]).includes(key))) {
        invalid = true;
        continue;
      }
      path = object.path;
      if (object.state !== undefined && !['added', 'modified', 'deleted', 'untracked'].includes(String(object.state))) {
        invalid = true;
        continue;
      }
    }
    if (invalidPath(path)) {
      invalid = true;
      continue;
    }
    const normalized = path as string;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return { paths, invalid };
}

function basePlan(overrides: Partial<VerificationPlan>): VerificationPlan {
  return {
    status: 'error', mode: 'full_fallback', affectedModules: [], coveredModules: [],
    selectedCheckKeys: [], selectedChecks: [], unselectedCheckKeys: [],
    reasonCode: 'fallback_invalid', reason: '无法生成安全检查计划', candidateDigest: null,
    candidateRejection: null, ...overrides,
  };
}

function candidateRejectionOf(
  candidate: VerificationPlanInput['candidate'],
): VerificationPlan['candidateRejection'] {
  if (candidate === null || candidate === undefined) {
    return { reason: 'candidate_missing', detail: '未提供当前 Attempt 的候选目标' };
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { reason: 'invalid_payload', detail: '候选结果不是可校验的对象' };
  }
  if (candidate.ok === false) {
    if (typeof candidate.reason !== 'string' || typeof candidate.detail !== 'string') {
      return { reason: 'invalid_payload', detail: '候选拒绝结果缺少受控原因' };
    }
    return { reason: candidate.reason, detail: candidate.detail };
  }
  if (
    candidate.ok !== true
    || typeof candidate.candidateDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.candidateDigest)
    || !Array.isArray(candidate.modules)
    || candidate.modules.some((module) => module === null || typeof module !== 'object' || typeof module.moduleKey !== 'string')
  ) {
    return { reason: 'invalid_payload', detail: '候选选择结果结构不完整' };
  }
  return null;
}

function fallbackPlan(
  policy: ConfirmedTaskVerificationPolicy,
  affectedModules: readonly string[],
  reasonCode: VerificationPlanReasonCode,
  reason: string,
  candidateDigest: string | null,
  candidateRejection: VerificationPlan['candidateRejection'],
): VerificationPlan {
  const checks = policy.checkDefinitions ?? [];
  const fallback = policy.fullFallback;
  const allCheckKeys = checks.map((check) => check.checkKey);
  const common = {
    mode: 'full_fallback' as const,
    affectedModules: [...affectedModules],
    candidateDigest,
    candidateRejection,
    reasonCode,
    reason,
  };
  if (fallback === undefined || fallback.checkRefs.length === 0) {
    return basePlan({ ...common, reasonCode: 'fallback_unavailable', reason: `${reason}；未配置安全全量回退` });
  }
  const byKey = new Map(checks.map((check) => [check.checkKey, check]));
  const selected = fallback.checkRefs.map((key) => byKey.get(key)).filter((check): check is CheckDefinition => check !== undefined);
  if (selected.length !== fallback.checkRefs.length) {
    return basePlan({ ...common, status: 'inconclusive', reasonCode: 'fallback_invalid', reason: `${reason}；全量回退引用不可用` });
  }
  const requiredMissing = checks.filter((check) => check.required && !fallback.checkRefs.includes(check.checkKey));
  if (requiredMissing.length > 0) {
    return basePlan({
      ...common,
      status: 'inconclusive',
      reasonCode: 'fallback_missing_required_check',
      reason: `${reason}；全量回退缺少必需检查：${requiredMissing.map((check) => check.checkKey).join(',')}`,
    });
  }
  const allModules = (policy.modules ?? []).map((module) => module.moduleKey);
  const coveredModules = fallback.moduleRefs === undefined ? allModules : [...fallback.moduleRefs];
  if (new Set(coveredModules).size !== allModules.length || allModules.some((module) => !coveredModules.includes(module))) {
    return basePlan({
      ...common,
      status: 'inconclusive',
      reasonCode: 'fallback_missing_module',
      reason: `${reason}；全量回退未覆盖全部确认模块`,
    });
  }
  const selectedKeys = selected.map((check) => check.checkKey);
  return {
    status: 'ready',
    ...common,
    coveredModules,
    selectedCheckKeys: selectedKeys,
    selectedChecks: selected.map(copyCheck),
    unselectedCheckKeys: allCheckKeys.filter((key) => !selectedKeys.includes(key)),
  };
}

function validatePlanInput(value: unknown): VerificationPlanInput {
  const inputContext = context();
  const object = requirePlainObject(value, inputContext, 'input');
  rejectUnknownKeys(object, PLAN_INPUT_KEYS, inputContext, 'input');
  if (!Object.prototype.hasOwnProperty.call(object, 'policy')) {
    throw validationError(inputContext, 'input.policy', '缺少已确认检查政策');
  }
  if (!Object.prototype.hasOwnProperty.call(object, 'changedPaths')) {
    throw validationError(inputContext, 'input.changedPaths', '缺少工作区变更路径集合');
  }
  return {
    policy: object.policy,
    changedPaths: object.changedPaths as VerificationPlanInput['changedPaths'],
    candidate: object.candidate as VerificationPlanInput['candidate'],
  };
}

/**
 * 依据已确认政策生成一次可查询的检查计划。返回 ready 才允许后续执行器启动检查。
 * 输入结构错误抛结构化 validation；工作区影响不确定或候选不可信则尝试安全全量。
 */
export function buildVerificationPlan(value: unknown): VerificationPlan {
  const input = validatePlanInput(value);
  let policy: ConfirmedTaskVerificationPolicy;
  try {
    policy = validateConfirmedTaskVerificationPolicy(input.policy, {
      operation: VERIFICATION_PLAN_OPERATION,
      entity: { type: 'project_settings', projectId: 'verification-plan' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '检查政策校验失败';
    return basePlan({ reasonCode: 'fallback_invalid', reason: `全量回退不可用：${detail}` });
  }
  const checks = policy.checkDefinitions ?? [];
  const allCheckKeys = checks.map((check) => check.checkKey);
  const changed = normalizeChangedPaths(input.changedPaths);
  const candidateRejection = candidateRejectionOf(input.candidate);
  const candidateDigest = candidateRejection === null && input.candidate?.ok === true
    ? input.candidate.candidateDigest
    : null;

  if (changed.invalid) {
    return fallbackPlan(policy, [], 'impact_input_invalid', '工作区变更路径校验失败，影响范围不确定', candidateDigest, candidateRejection);
  }

  const modules = policy.modules ?? [];
  const affected = modules.filter((module) => changed.paths.some((path) => module.impactScope.some((scope) => isInsideOrSame(path, scope))));
  const affectedModules = affected.map((module) => module.moduleKey);
  const sharedRisk = modules.some((module) => module.sharedHighRiskFiles.some((file) => changed.paths.some((path) => isInsideOrSame(path, file))));
  if (sharedRisk) {
    return fallbackPlan(policy, modules.map((module) => module.moduleKey), 'shared_high_risk_change', '共享配置、依赖、构建或测试执行器文件发生变更', candidateDigest, candidateRejection);
  }
  if (affectedModules.length === 0) {
    return fallbackPlan(policy, [], 'impact_unknown', '变更未匹配已确认模块影响范围，不能安全局部放行', candidateDigest, candidateRejection);
  }
  if (candidateRejection !== null) {
    const reasonCode = input.candidate === null || input.candidate === undefined ? 'candidate_missing' : 'candidate_invalid';
    return fallbackPlan(policy, affectedModules, reasonCode, candidateRejection.detail, candidateDigest, candidateRejection);
  }

  const candidate = input.candidate as TestCandidateSelection;
  const candidateModuleKeys = candidate.modules.map((module) => module.moduleKey);
  const missing = affectedModules.filter((module) => !candidateModuleKeys.includes(module));
  const extra = candidateModuleKeys.filter((module) => !affectedModules.includes(module));
  if (missing.length > 0) {
    return fallbackPlan(policy, affectedModules, 'candidate_missing_module', `候选未覆盖受影响模块：${missing.join(',')}`, candidate.candidateDigest, null);
  }
  if (extra.length > 0) {
    return fallbackPlan(policy, affectedModules, 'candidate_extra_module', `候选包含非受影响模块：${extra.join(',')}`, candidate.candidateDigest, null);
  }

  // F-001 没有把 checkKey 绑定到模型输出的 moduleKey；关联只能来自确认政策中的
  // cwdRef/allowedTargets 或 requirementRefs/moduleKey。无法建立关联时影响不确定，
  // 直接走全量回退，避免把所有 module 检查误当成局部检查。
  const moduleChecks = checks.filter((check) => check.scope === 'module');
  const checkModules = (check: CheckDefinition): string[] => modules
    .filter((module) => {
      const cwdMatches = check.cwdRef !== null
        && module.allowedTargets.some((target) => isInsideOrSame(check.cwdRef as string, target));
      const requirementMatches = check.requirementRefs.includes(module.moduleKey);
      return cwdMatches || requirementMatches;
    })
    .map((module) => module.moduleKey);
  const uncertainModuleCheck = moduleChecks.some((check) => checkModules(check).length === 0);
  const selectedModuleChecks = moduleChecks.filter((check) => checkModules(check).some((module) => affectedModules.includes(module)));
  const selectedTaskChecks = checks.filter((check) => check.scope === 'task' && check.required);
  if (uncertainModuleCheck || (selectedModuleChecks.length === 0 && selectedTaskChecks.length === 0)) {
    return fallbackPlan(
      policy,
      affectedModules,
      'local_checks_unavailable',
      uncertainModuleCheck ? '模块检查未绑定到明确模块，影响不确定' : '已确认政策没有可用于局部计划的检查',
      candidate.candidateDigest,
      null,
    );
  }
  const selected = [...selectedModuleChecks, ...selectedTaskChecks];
  const selectedKeys = selected.map((check) => check.checkKey);
  const coveredModules = candidate.modules.map((module) => module.moduleKey);
  return {
    status: 'ready',
    mode: 'candidates',
    affectedModules,
    coveredModules,
    selectedCheckKeys: selectedKeys,
    selectedChecks: selected.map(copyCheck),
    unselectedCheckKeys: allCheckKeys.filter((key) => !selectedKeys.includes(key)),
    reasonCode: 'candidate_covered',
    reason: '候选覆盖全部受影响模块，使用局部检查与已确认快速检查',
    candidateDigest: candidate.candidateDigest,
    candidateRejection: null,
  };
}

/** 语义别名：供调度/Verifier 装配代码使用，保持规则实现单一。 */
export const createVerificationPlan = buildVerificationPlan;
export const planVerification = buildVerificationPlan;
