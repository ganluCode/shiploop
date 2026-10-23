/**
 * P05-1 / F-001 一次性规划请求与规划候选纯数据契约（ports 契约层：类型、常量、
 * 纯校验与纯摘要函数；无 I/O、无时钟、无数据库、无模型调用）。
 *
 * 设计依据：input/p05-planning.md FR-1~FR-3（用户以需求制品、约束、验收标准和
 * 批准策略发起一次规划；候选包含 Task 描述、难度、依赖、验收和定向 verification；
 * 校验 schema、归属、引用、无环及策略完整性，批准绑定 candidate digest）、
 * core-design/02 §2（规划不是无限执行队列：plan Run 创建 planning Task，候选
 * 保存为制品、不建 PlanRevision；批准原子应用，拒绝不倒改已结束 Run）、§4
 * （Task kind=planning/coding；规划任务不在交付图中）、core-design/08 §5.1
 * （受限 Agent 调用通道：默认拒绝未列出的操作；模型不得自批通过）。
 * 实施契约：docs/p05-1-planning-candidate-contract.md（本模块契约文档）。
 *
 * 契约要点：
 * - 业务计划面**原样复用** validateFeaturePlanInput（P03-1 冻结的 v1 输入语义与
 *   planDigest）：重复 ID、缺依赖、自依赖、环等 Task DAG 负例全部来自既有校验器，
 *   本模块不另建第二套 DAG 校验，也不改变 feature.plan.import/revise 的输入语义；
 * - 规划候选是**不可信模型输出**的独立封装：只承载业务计划 v1、定向 verification
 *   意图（checkRefs/moduleRefs/impactScope 三类引用）与审批摘要；verification 只
 *   引用受信检查/模块与影响范围，payload 与意图条目均为严格键白名单，任何
 *   argv/shell/environment/vendor/model/credentials/passed 等执行语义字段一律按
 *   未知字段拒绝（PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS 是文档化的冻结
 *   拒绝清单，不是白名单成员）；
 * - 未来由编码 Task 创建的测试文件不要求在规划时已经存在；impactScope 只做词法
 *   校验（复用验证候选的目标词法规则 validateCandidateTarget），引用的检查/模块
 *   是否真实存在在提交/批准/执行期结合当前 checkPolicyDigest 重核（本模块提供
 *   可选 knownChecks/knownModules 上下文供上层注入，未注入时不假装查过）；
 * - 身份与摘要四层区分：不可变 Artifact contentHash（制品内容身份）、
 *   candidateDigest（覆盖候选全部语义：绑定身份 + planDigest + verification +
 *   审批摘要）、既有业务 planDigest（业务计划内容摘要）、checkPolicyDigest
 *   （既有检查政策身份摘要，computeFeatureCheckPolicyDigest）。verification、
 *   输入身份（inputDigest）或目标计划身份变化均使旧候选批准依据失效
 *   （evaluatePlanningCandidateApprovalBasis，冻结原因词汇）；
 * - Run.purpose=plan、Task.kind=planning、Runtime identity.purpose=work：规划
 *   Run 复用 Work 通道执行（identity.purpose 仍为 work），与编码执行
 *   purpose=execute 可区分；既有 candidate.submit 工作工具操作仍表示测试候选，
 *   规划提交使用独立且受限的操作身份 planning.candidate.submit（接线由后续
 *   Task 完成，本模块只冻结身份常量）；
 * - 错误复用 StorageError kind='validation' 纪律：details 只含 field/reason/节点
 *   定位/receivedType，不回显输入正文。
 *
 * 本契约不实现：规划启动命令与预算/派发（F-003/F-005）、候选提交工具通道与
 * Artifact 发布（F-006）、批准应用与原子导入（后续 Task）；不引入 PlanRevision、
 * 第二套 Runtime 或新的通用工作流引擎，不扩展 Phase DAG/Batch 功能。
 */
import { createHash } from 'node:crypto';
import {
  PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH,
  PLAN_TASKS_MAX_COUNT,
  stableStringify,
  validateFeaturePlanInput,
  validatePlanAcceptance,
  validatePlanArtifactRefs,
} from './feature-plan.js';
import type { PlanArtifactRef, ValidatedFeaturePlan } from './feature-plan.js';
import { validateCandidateTarget } from './verification-candidates.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本、身份与领域常量
 * ------------------------------------------------------------------ */

/** 一次性规划请求 payload 结构版本（当前唯一支持；未知/更高版本拒绝）。 */
export const PLANNING_REQUEST_SCHEMA_VERSION = 1;

/** 规划候选 payload 结构版本（当前唯一支持；未知/更高版本拒绝）。 */
export const PLANNING_CANDIDATE_SCHEMA_VERSION = 1;

/** 规划 Run 的执行用途（Run.purpose；与编码执行 purpose='execute' 可区分）。 */
export const PLANNING_RUN_PURPOSE = 'plan' as const;

/** 规划 Task 的种类（Task.kind；规划任务不在交付图中）。 */
export const PLANNING_TASK_KIND = 'planning' as const;

/** 规划 Run 复用 Work 通道：Runtime identity.purpose 恒为 work。 */
export const PLANNING_RUNTIME_IDENTITY_PURPOSE = 'work' as const;

/**
 * 规划候选提交的独立且受限的操作身份。既有 `candidate.submit`（工作工具操作）
 * 仍表示测试候选；规划提交不得复用该身份。本任务只冻结常量与文档，工具通道
 * 接线由后续 Task 完成。
 */
export const PLANNING_CANDIDATE_SUBMIT_OPERATION = 'planning.candidate.submit' as const;

/** 规划输入身份摘要（inputDigest）的领域前缀：锚定「一次性规划请求 v1」语义。 */
export const PLANNING_INPUT_DIGEST_DOMAIN = 'shiploop:planning-request:v1';

/** 候选身份摘要（candidateDigest）的领域前缀：锚定「规划候选 v1」语义。 */
export const PLANNING_CANDIDATE_DIGEST_DOMAIN = 'shiploop:planning-candidate:v1';

/* ------------------------------------------------------------------ *
 * 边界常量（实施契约值，记录于 docs/p05-1-planning-candidate-contract.md）
 * ------------------------------------------------------------------ */

/** 请求需求制品引用数量上限（去重后；与 Feature 级来源引用同量级）。 */
export const PLANNING_REQUEST_REQUIREMENT_REFS_MAX_COUNT = 16;
/** 请求约束条目数量上限（去重后）。 */
export const PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT = 16;
/** 策略任务数上限上限值（复用业务计划 PLAN_TASKS_MAX_COUNT，不另立数值）。 */
export const PLANNING_STRATEGY_TASK_LIMIT_MAX = PLAN_TASKS_MAX_COUNT;
/** 审批摘要长度上限（Unicode 码点；与验收正文同量级）。 */
export const PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS = 2000;
/** 单 Task 意图受信检查引用数量上限。 */
export const PLANNING_TASK_CHECK_REFS_MAX_COUNT = 16;
/** 单 Task 意图受信模块引用数量上限。 */
export const PLANNING_TASK_MODULE_REFS_MAX_COUNT = 16;
/** 单 Task 意图影响范围目标数量上限。 */
export const PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT = 32;

/**
 * verification 意图的冻结拒绝清单（文档化安全边界，非白名单成员）：模型提交的
 * 候选携带以下任一执行语义字段时，均因键白名单之外的未知字段被拒绝。命令/
 * shell/环境/凭据只能来自用户确认的受信检查定义（task-verification-policy），
 * 厂商/模型选择来自配置策略，通过标志只能由人工决策写入。
 */
export const PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS = [
  'argv',
  'command',
  'shell',
  'environment',
  'env',
  'vendor',
  'provider',
  'model',
  'credentials',
  'token',
  'secret',
  'passed',
  'pass',
  'approved',
] as const;

/** 受信检查引用的词法规则（与 task-verification-policy 的 checkKey 同一形态）。 */
const CHECK_REF_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
/** 受信模块引用长度上限（与 task-verification-policy 的引用长度同数值）。 */
const MODULE_REF_MAX_LENGTH = 256;

const REQUEST_KEYS = [
  'schemaVersion',
  'projectId',
  'phaseId',
  'featureId',
  'requirementRefs',
  'constraints',
  'acceptance',
  'strategy',
] as const;
const STRATEGY_KEYS = ['approvalMode', 'taskLimit'] as const;
const CANDIDATE_KEYS = [
  'schemaVersion',
  'projectId',
  'featureId',
  'runId',
  'candidateId',
  'plan',
  'taskVerification',
  'summary',
] as const;
const TASK_VERIFICATION_KEYS = ['taskId', 'checkRefs', 'moduleRefs', 'impactScope'] as const;
const IDENTITY_KEYS = ['projectId', 'featureId', 'runId', 'candidateId', 'artifactRef'] as const;
const ARTIFACT_REF_KEYS = ['artifactId', 'contentHash'] as const;

/** 以 Unicode 码点计数（与 feature-plan/validation 同一计数规则）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/**
 * 用户批准的规划策略（请求输入）：v1 只支持显式人工决策（approvalMode='manual'）；
 * taskLimit 约束候选计划的任务数上限（省略/null 归一为 null，不设上限）。
 */
export interface PlanningStrategy {
  readonly approvalMode: 'manual';
  readonly taskLimit: number | null;
}

/** 规划请求的规范化语义内容（inputDigest 的输入）。 */
export interface PlanningRequestContent {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly requirementRefs: readonly PlanArtifactRef[];
  readonly constraints: readonly string[];
  readonly acceptance: { readonly criteria: readonly string[] };
  readonly strategy: PlanningStrategy;
}

/** 已校验的一次性规划请求（含确定性输入身份摘要）。 */
export interface ValidatedPlanningRequest extends PlanningRequestContent {
  readonly schemaVersion: typeof PLANNING_REQUEST_SCHEMA_VERSION;
  readonly inputDigest: string;
}

/** 候选内单 Task 的定向 verification 意图（只含受信引用与影响范围）。 */
export interface PlanningTaskVerificationIntent {
  readonly taskId: string;
  /** 受信检查引用（checkKey 词法；存在性由提交/批准/执行期结合政策身份重核）。 */
  readonly checkRefs: readonly string[];
  /** 受信模块引用（moduleKey 词法；同上，不内联 allowedTargets 定义）。 */
  readonly moduleRefs: readonly string[];
  /** 影响范围（仓库内相对目标词法；不要求编码期测试文件已存在）。 */
  readonly impactScope: readonly string[];
}

/** 规划候选的规范化语义内容（candidateDigest 的输入）。 */
export interface PlanningCandidateContent {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  /** 稳定候选身份；生成前候选记录允许尚无 Artifact 引用。 */
  readonly candidateId: string;
  /** 既有业务计划 v1（原样复用 validateFeaturePlanInput 的规范化输出与 planDigest）。 */
  readonly plan: ValidatedFeaturePlan;
  readonly taskVerification: readonly PlanningTaskVerificationIntent[];
  /** 审批摘要（供人工决策阅读；不是批准依据，批准绑定 candidateDigest）。 */
  readonly summary: string;
}

/** 已校验的规划候选 payload（含覆盖全部候选语义的 candidateDigest）。 */
export interface ValidatedPlanningCandidate extends PlanningCandidateContent {
  readonly schemaVersion: typeof PLANNING_CANDIDATE_SCHEMA_VERSION;
  readonly candidateDigest: string;
}

/** 候选身份封装：生成前允许无 Artifact 引用（artifactRef=null）。 */
export interface PlanningCandidateIdentity {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly artifactRef: PlanArtifactRef | null;
}

export interface PlanningRequestValidationOptions {
  /** 发生校验的操作名（写入 StorageError.operation）；默认 'PlanningRequest.validate'。 */
  readonly operation?: string;
}

export interface PlanningCandidateValidationOptions {
  /** 发生校验的操作名；默认 'PlanningCandidate.validate'。 */
  readonly operation?: string;
  /**
   * 受信检查解析上下文（可选；checkKey 集合）。提供时 checkRefs 引用不存在的
   * 检查按字段拒绝；未提供时只做词法校验，存在性由上层在提交/批准/执行期结合
   * 当前 checkPolicyDigest 重核（本模块不查、不假装查过）。
   */
  readonly knownChecks?: ReadonlySet<string>;
  /** 受信模块解析上下文（可选；moduleKey 集合），语义同 knownChecks。 */
  readonly knownModules?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ *
 * 审批依据评估（纯规则）
 * ------------------------------------------------------------------ */

/** 候选批准依据的冻结原因词汇（确定性顺序：候选 → 输入 → 计划 → 检查政策）。 */
export const PLANNING_CANDIDATE_BASIS_REASONS = [
  'basis_intact',
  'candidate_changed',
  'input_changed',
  'plan_changed',
  'check_policy_changed',
] as const;
export type PlanningCandidateBasisReason = (typeof PLANNING_CANDIDATE_BASIS_REASONS)[number];

/** 一次候选批准绑定的完整依据身份（四类摘要各司其职）。 */
export interface PlanningCandidateApprovalBasis {
  readonly candidateDigest: string;
  readonly inputDigest: string;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
}

/** 审批依据评估结果（fail-closed：valid=false 恒携带明确原因词汇）。 */
export interface PlanningCandidateBasisEvaluation {
  readonly valid: boolean;
  readonly reason: PlanningCandidateBasisReason;
}

/**
 * 评估旧候选批准依据是否仍然有效：verification（candidateDigest 覆盖）、输入
 * 身份（inputDigest）、目标计划身份（planDigest）或适用检查政策身份
 * （checkPolicyDigest）任一变化均使旧批准依据失效。纯比较，不改写任何记录。
 */
export function evaluatePlanningCandidateApprovalBasis(
  approved: PlanningCandidateApprovalBasis,
  current: PlanningCandidateApprovalBasis,
): PlanningCandidateBasisEvaluation {
  if (approved.candidateDigest !== current.candidateDigest) {
    return { valid: false, reason: 'candidate_changed' };
  }
  if (approved.inputDigest !== current.inputDigest) {
    return { valid: false, reason: 'input_changed' };
  }
  if (approved.planDigest !== current.planDigest) {
    return { valid: false, reason: 'plan_changed' };
  }
  if (approved.checkPolicyDigest !== current.checkPolicyDigest) {
    return { valid: false, reason: 'check_policy_changed' };
  }
  return { valid: true, reason: 'basis_intact' };
}

/* ------------------------------------------------------------------ *
 * 摘要计算
 * ------------------------------------------------------------------ */

/**
 * 规划输入身份摘要：SHA-256(`${PLANNING_INPUT_DIGEST_DOMAIN}\n${stableStringify(content)}`)。
 * 覆盖绑定实体（Project/Phase/Feature）、需求制品引用（含 contentHash）、约束、
 * 验收与用户批准策略。输入身份变化（需求内容、约束、验收或策略改变）即改变，
 * 使旧候选批准依据失效。
 */
export function computePlanningInputDigest(content: PlanningRequestContent): string {
  const canonical = stableStringify({
    projectId: content.projectId,
    phaseId: content.phaseId,
    featureId: content.featureId,
    requirementRefs: [...content.requirementRefs],
    constraints: [...content.constraints],
    acceptance: { criteria: [...content.acceptance.criteria] },
    strategy: { approvalMode: content.strategy.approvalMode, taskLimit: content.strategy.taskLimit },
  });
  return createHash('sha256').update(`${PLANNING_INPUT_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/**
 * 候选身份摘要：SHA-256(`${PLANNING_CANDIDATE_DIGEST_DOMAIN}\n${stableStringify(...)}`)，
 * 覆盖候选全部语义：绑定身份（projectId/featureId/runId/candidateId）、业务计划
 * 内容（复合既有 planDigest，不重复序列化计划正文）、定向 verification 意图与
 * 审批摘要。verification、计划内容、审批摘要或绑定身份任一变化即改变。批准
 * 绑定 candidateDigest（不是 planDigest：后者只覆盖计划业务内容）。
 */
export function computePlanningCandidateDigest(content: PlanningCandidateContent): string {
  const canonical = stableStringify({
    projectId: content.projectId,
    featureId: content.featureId,
    runId: content.runId,
    candidateId: content.candidateId,
    planDigest: content.plan.planDigest,
    taskVerification: content.taskVerification.map((intent) => ({
      taskId: intent.taskId,
      checkRefs: [...intent.checkRefs],
      moduleRefs: [...intent.moduleRefs],
      impactScope: [...intent.impactScope],
    })),
    summary: content.summary,
  });
  return createHash('sha256').update(`${PLANNING_CANDIDATE_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * 规划请求校验
 * ------------------------------------------------------------------ */

function planningContext(operation: string): ValidationContext {
  return { operation, entity: { type: 'feature' } };
}

/**
 * 校验一次性规划请求（unknown → 规范化请求 + inputDigest）。
 *
 * 结构（键白名单）：schemaVersion/projectId/phaseId/featureId/requirementRefs/
 * constraints/acceptance/strategy。需求制品引用与结构化验收复用业务计划 v1 的
 * 同一规则（validatePlanArtifactRefs/validatePlanAcceptance）；策略 v1 只接受
 * 显式人工决策（approvalMode='manual'）。未知版本、未知字段、非法结构均返回
 * 带 field 定位的脱敏 StorageError(kind='validation')。实体归属与引用存在性由
 * 启动命令事务（F-003）重核，本模块不查。
 */
export function validatePlanningRequest(
  value: unknown,
  options: PlanningRequestValidationOptions = {},
): ValidatedPlanningRequest {
  const operation = options.operation ?? 'PlanningRequest.validate';
  const context = planningContext(operation);

  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, REQUEST_KEYS, context, 'input');

  if (object.schemaVersion !== PLANNING_REQUEST_SCHEMA_VERSION) {
    throw validationError(
      context,
      'schemaVersion',
      `必须是 ${PLANNING_REQUEST_SCHEMA_VERSION}（当前唯一支持的规划请求结构版本，未知/更高版本拒绝）`,
      object.schemaVersion,
    );
  }

  const constraints = validateConstraintList(object.constraints, context);
  const strategy = validateStrategy(object.strategy, context);

  const content: PlanningRequestContent = {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    phaseId: validateStableId(object.phaseId, context, 'phaseId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    requirementRefs: validatePlanArtifactRefs(
      object.requirementRefs,
      context,
      'requirementRefs',
      PLANNING_REQUEST_REQUIREMENT_REFS_MAX_COUNT,
    ),
    constraints,
    acceptance: validatePlanAcceptance(object.acceptance, context, 'acceptance'),
    strategy,
  };
  return { schemaVersion: PLANNING_REQUEST_SCHEMA_VERSION, ...content, inputDigest: computePlanningInputDigest(content) };
}

/** 约束清单：省略/null/[] 归一为空数组；条目非空、trim 保留、有界；去重保持首现顺序。 */
function validateConstraintList(value: unknown, context: ValidationContext): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw validationError(context, 'constraints', '必须是字符串数组', value);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const field = `constraints[${index}]`;
    if (typeof item !== 'string') {
      throw validationError(context, field, '必须是字符串', item);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw validationError(context, field, '不允许为空或全空白', item);
    }
    if (codePointLength(trimmed) > PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH) {
      throw validationError(
        context,
        field,
        `长度不得超过 ${PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH} 个字符（Unicode 码点）`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  if (result.length > PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT) {
    throw validationError(
      context,
      'constraints',
      `约束条目数量不得超过 ${PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT} 条（去重后）`,
    );
  }
  return result;
}

/** 用户批准的规划策略：v1 仅 approvalMode='manual'；taskLimit 省略/null → null。 */
function validateStrategy(value: unknown, context: ValidationContext): PlanningStrategy {
  const object = requirePlainObject(value, context, 'strategy');
  rejectUnknownKeys(object, STRATEGY_KEYS, context, 'strategy');
  if (object.approvalMode !== 'manual') {
    throw validationError(
      context,
      'strategy.approvalMode',
      "必须是 'manual'（首版仅支持显式人工决策，不自动批准）",
      object.approvalMode,
    );
  }
  let taskLimit: number | null = null;
  if (object.taskLimit !== undefined && object.taskLimit !== null) {
    if (
      typeof object.taskLimit !== 'number' ||
      !Number.isInteger(object.taskLimit) ||
      object.taskLimit < 1 ||
      object.taskLimit > PLANNING_STRATEGY_TASK_LIMIT_MAX
    ) {
      throw validationError(
        context,
        'strategy.taskLimit',
        `必须是 1..${PLANNING_STRATEGY_TASK_LIMIT_MAX} 的整数或 null/省略`,
        object.taskLimit,
      );
    }
    taskLimit = object.taskLimit;
  }
  return { approvalMode: 'manual', taskLimit };
}

/* ------------------------------------------------------------------ *
 * 规划候选校验
 * ------------------------------------------------------------------ */

/**
 * 校验规划候选 payload（unknown → 规范化候选 + candidateDigest）。
 *
 * 结构（键白名单）：schemaVersion/projectId/featureId/runId/candidateId/plan/
 * taskVerification/summary。plan 原样交给 validateFeaturePlanInput（v1 语义与
 * DAG 负例定位不变）；taskVerification 条目只含 taskId/checkRefs/moduleRefs/
 * impactScope，执行语义字段（PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS 及
 * 任何白名单外字段）一律按未知字段拒绝。
 */
export function validatePlanningCandidatePayload(
  value: unknown,
  options: PlanningCandidateValidationOptions = {},
): ValidatedPlanningCandidate {
  const operation = options.operation ?? 'PlanningCandidate.validate';
  const context = planningContext(operation);

  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CANDIDATE_KEYS, context, 'input');

  if (object.schemaVersion !== PLANNING_CANDIDATE_SCHEMA_VERSION) {
    throw validationError(
      context,
      'schemaVersion',
      `必须是 ${PLANNING_CANDIDATE_SCHEMA_VERSION}（当前唯一支持的规划候选结构版本，未知/更高版本拒绝）`,
      object.schemaVersion,
    );
  }

  const projectId = validateStableId(object.projectId, context, 'projectId');
  const featureId = validateStableId(object.featureId, context, 'featureId');
  const runId = validateStableId(object.runId, context, 'runId');
  const candidateId = validateStableId(object.candidateId, context, 'candidateId');

  // 业务计划 v1 原样复用：所有 DAG/结构负例（重复 ID、缺依赖、自依赖、环）的
  // 定位错误来自 validateFeaturePlanInput，本模块不重复实现也不改写其语义。
  const plan = validateFeaturePlanInput(object.plan, { operation });

  const taskVerification = validateTaskVerification(object.taskVerification, context, plan, options);
  const summary = validateSummary(object.summary, context);

  const content: PlanningCandidateContent = {
    projectId,
    featureId,
    runId,
    candidateId,
    plan,
    taskVerification,
    summary,
  };
  return {
    schemaVersion: PLANNING_CANDIDATE_SCHEMA_VERSION,
    ...content,
    candidateDigest: computePlanningCandidateDigest(content),
  };
}

/** 审批摘要：非空字符串，trim 保留，长度有界（Unicode 码点）。 */
function validateSummary(value: unknown, context: ValidationContext): string {
  if (typeof value !== 'string') {
    throw validationError(context, 'summary', '必须是字符串', value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError(context, 'summary', '不允许为空或全空白', value);
  }
  if (codePointLength(trimmed) > PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS) {
    throw validationError(
      context,
      'summary',
      `长度不得超过 ${PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
    );
  }
  return trimmed;
}

/** 受信引用清单：词法校验、去重拒绝、排序输出、有上限；可选上下文做存在性核验。 */
function validateTrustedRefList(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxCount: number,
  validateItem: (item: unknown, context: ValidationContext, field: string) => string,
  known?: ReadonlySet<string>,
  knownLabel?: string,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是字符串数组', value);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const reference = validateItem(item, context, itemField);
    if (seen.has(reference)) {
      throw validationError(context, itemField, '实体内不允许重复引用', item);
    }
    seen.add(reference);
    if (known !== undefined && !known.has(reference)) {
      throw validationError(
        context,
        itemField,
        `引用了未定义的${knownLabel ?? '目标'}（受信清单内不存在）`,
        item,
      );
    }
    result.push(reference);
  }
  if (result.length > maxCount) {
    throw validationError(context, field, `引用数量不得超过 ${maxCount} 个`);
  }
  return result.sort();
}

function validateCheckRef(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !CHECK_REF_PATTERN.test(value)) {
    throw validationError(context, field, '必须是小写受信检查身份（^[a-z][a-z0-9._-]{0,127}$）', value);
  }
  return value;
}

function validateModuleRef(value: unknown, context: ValidationContext, field: string): string {
  const reference = validateStableId(value, context, field);
  if (reference.length > MODULE_REF_MAX_LENGTH) {
    throw validationError(context, field, `受信模块身份长度不得超过 ${MODULE_REF_MAX_LENGTH}`);
  }
  return reference;
}

/**
 * 定向 verification 意图清单：条目只含 taskId/checkRefs/moduleRefs/impactScope；
 * taskId 必须是候选计划内任务且条目不重复；引用与影响范围排序输出。未来由编码
 * Task 创建的测试不要求在规划时已经存在（impactScope 只做词法校验）。
 */
function validateTaskVerification(
  value: unknown,
  context: ValidationContext,
  plan: ValidatedFeaturePlan,
  options: PlanningCandidateValidationOptions,
): PlanningTaskVerificationIntent[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw validationError(context, 'taskVerification', '必须是 verification 意图对象数组', value);
  }
  const planTaskIds = new Set(plan.tasks.map((task) => task.id));
  const seenTaskIds = new Set<string>();
  const intents: PlanningTaskVerificationIntent[] = [];
  for (const [index, raw] of value.entries()) {
    const field = `taskVerification[${index}]`;
    const object = requirePlainObject(raw, context, field);
    rejectUnknownKeys(object, TASK_VERIFICATION_KEYS, context, field);
    const taskId = validateStableId(object.taskId, context, `${field}.taskId`);
    if (!planTaskIds.has(taskId)) {
      throw validationError(context, `${field}.taskId`, '引用了候选计划中不存在的任务（意图只能指向计划内 Task）', object.taskId);
    }
    if (seenTaskIds.has(taskId)) {
      throw validationError(context, `${field}.taskId`, '同一任务的 verification 意图重复', object.taskId);
    }
    seenTaskIds.add(taskId);
    intents.push({
      taskId,
      checkRefs: validateTrustedRefList(
        object.checkRefs,
        context,
        `${field}.checkRefs`,
        PLANNING_TASK_CHECK_REFS_MAX_COUNT,
        validateCheckRef,
        options.knownChecks,
        '检查身份',
      ),
      moduleRefs: validateTrustedRefList(
        object.moduleRefs,
        context,
        `${field}.moduleRefs`,
        PLANNING_TASK_MODULE_REFS_MAX_COUNT,
        validateModuleRef,
        options.knownModules,
        '模块身份',
      ),
      impactScope: validateTrustedRefList(
        object.impactScope,
        context,
        `${field}.impactScope`,
        PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT,
        validateCandidateTarget,
      ),
    });
  }
  return intents.sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * 候选身份封装校验
 * ------------------------------------------------------------------ */

/**
 * 校验候选身份封装：candidateId 是稳定候选身份；生成前允许无 Artifact 引用
 * （artifactRef 省略/null → null）。携带 artifactRef 时必须是身份级制品引用
 * （artifactId 必填，contentHash 可选 64 位小写十六进制）。
 */
export function validatePlanningCandidateIdentity(
  value: unknown,
  options: PlanningRequestValidationOptions = {},
): PlanningCandidateIdentity {
  const operation = options.operation ?? 'PlanningCandidateIdentity.validate';
  const context = planningContext(operation);

  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, IDENTITY_KEYS, context, 'input');

  let artifactRef: PlanArtifactRef | null = null;
  if (object.artifactRef !== undefined && object.artifactRef !== null) {
    const ref = requirePlainObject(object.artifactRef, context, 'artifactRef');
    rejectUnknownKeys(ref, ARTIFACT_REF_KEYS, context, 'artifactRef');
    artifactRef = {
      artifactId: validateStableId(ref.artifactId, context, 'artifactRef.artifactId'),
      ...(ref.contentHash === undefined
        ? {}
        : { contentHash: validateSha256Digest(ref.contentHash, context, 'artifactRef.contentHash') }),
    };
  }

  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    runId: validateStableId(object.runId, context, 'runId'),
    candidateId: validateStableId(object.candidateId, context, 'candidateId'),
    artifactRef,
  };
}
