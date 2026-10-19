/**
 * P03-8 / F-001 获准的 Feature 最终提交政策与用户 Git 身份校验
 * （ports 契约层：类型、常量、纯校验函数与身份摘要；无任何 I/O）。
 *
 * 设计依据：input/p03-feature-delivery.md FR-1（选定并记录 Task/最终 Feature
 * 提交政策，两个边界不能重复提交同一成果；提交身份用用户配置，runtime 来源
 * 写审计，不冒用官方邮箱；本项不实现 push/PR 或任意分支自动合并）与
 * core-design/07 §"提交作为 operation"（提交身份使用用户明确配置；Runtime
 * 来源保存在审计，可选署名不改变真实身份）。
 *
 * 契约要点（F-001 定案）：
 * - Task 本地提交是放行前提；新配置使用 `task_and_feature`。历史
 *   `feature_final_only` 保留解析兼容，但不能绕过 Task 提交门禁。
 *   其他提交政策（per_task/task_each/manual_only/…）在边界结构化拒绝
 *   （reason='unsupported_commit_mode'），没有默认政策可回落；
 * - 交付动作唯一支持 `commit`（Feature 最终提交本身）。push、PR
 *   （pull_request/merge_request/pr）与自动合并（auto_merge/force_push/deploy
 *   等）请求以 reason='unsupported_delivery_action' 结构化拒绝（P03-8 约束：
 *   不实现 push/PR 或任意分支自动合并）；
 * - 提交所用姓名和邮箱必须由用户明确配置并确认：gitIdentity 必须同时携带
 *   name/email/confirmed===true；缺失、非法形态（无 @/多 @/无域点/空白/控制
 *   字符/前后空白/超长）与未经确认（confirmed 缺失/false/非布尔）全部拒绝
 *   （reason='identity_not_confirmed' 等）。不回落到开发机全局身份、官方邮箱
 *   或任何内置默认身份；
 * - Runtime/provider/model 来源是**独立审计记录**（RuntimeSourceAuditRecord），
 *   与用户 Git 身份分离保存：身份字段只承载用户配置的 name/email，runtime
 *   来源单独校验/保存，两者不混用；审计记录不含凭据，未知键 fail-closed；
 * - 政策身份摘要（computeDeliveryPolicyDigest）锚定独立领域前缀，null 形态、
 *   空段与实配段互不相同；执行输入准备会把当前有效政策段（或显式 null 形态）
 *   固定进不可变 input snapshot，后续配置漂移不改变已固定执行依据；
 * - 本模块只做 JSON 边界校验与摘要计算，不执行 Git 命令、不读仓库、不创建
 *   commit 意图或回执（F-002/F-003 职责），也不解析任何凭据。
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import { stableStringify } from './feature-plan.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** Historical policy spelling, retained for stored snapshot compatibility only. */
export const FEATURE_FINAL_COMMIT_MODE = 'feature_final_only';
/** New executions commit each verified Task locally; final delivery remains separate. */
export const TASK_AND_FEATURE_COMMIT_MODE = 'task_and_feature';
type CommitMode = typeof FEATURE_FINAL_COMMIT_MODE | typeof TASK_AND_FEATURE_COMMIT_MODE;

/** 首版唯一支持的交付动作：Feature 最终 commit 本身。 */
export const SUPPORTED_DELIVERY_ACTIONS = ['commit'] as const;

/** 交付动作类型（词汇冻结；push/PR/自动合并不在其中）。 */
export type DeliveryActionKind = (typeof SUPPORTED_DELIVERY_ACTIONS)[number];

/** Git 提交姓名长度上限（Unicode 码点）。 */
export const GIT_IDENTITY_NAME_MAX_CODE_POINTS = 128;

/** Git 提交邮箱长度上限（Unicode 码点；覆盖 RFC 上界 254）。 */
export const GIT_IDENTITY_EMAIL_MAX_CODE_POINTS = 254;

/** 交付政策身份摘要的领域前缀（与检查政策/计划摘要域隔离，防拼接碰撞）。 */
export const DELIVERY_POLICY_DIGEST_DOMAIN = 'shiploop:feature-delivery-policy:v1';

/** 用户明确配置并确认的 Git 提交身份（不回落到开发机全局身份或官方邮箱）。 */
export interface ConfirmedGitIdentity {
  /** 提交署名姓名（用户明确配置；1..128 码点，无控制字符/前后空白/尖括号）。 */
  readonly name: string;
  /** 提交署名邮箱（用户明确配置；保守格式校验，无空白/控制字符）。 */
  readonly email: string;
  /** 用户明确确认标记：恒为字面 true（缺失/false/非布尔一律拒绝）。 */
  readonly confirmed: true;
}

/** 完整获准的 Feature 最终提交政策（可执行形态；缺任一必需成分即不可用）。 */
export interface ConfirmedDeliveryPolicy {
  /** 新配置使用 task_and_feature；旧名称不豁免 Task 本地提交。 */
  readonly commitMode: CommitMode;
  /** 用户明确配置并确认的提交身份。 */
  readonly gitIdentity: ConfirmedGitIdentity;
  /** 显式声明的交付动作；缺省即仅 Feature 最终 commit。 */
  readonly deliveryActions?: readonly DeliveryActionKind[];
}

/**
 * 配置体系中的交付政策段形态（settings payload `policies.deliveryPolicy`）：
 * 字段全部可选（空段 `{}` 表示不覆盖/继承全局——段级语义由有效配置合并决定），
 * 但存在的字段全部校验；段不完整时由 resolveDeliveryPolicyForUse 在使用边界
 * fail-closed 拒绝，不存在默认提交政策。
 */
export interface DeliveryPolicySection {
  readonly commitMode?: CommitMode;
  readonly gitIdentity?: ConfirmedGitIdentity;
  readonly deliveryActions?: readonly DeliveryActionKind[];
}

/** Runtime/provider/model 来源独立审计记录（与用户 Git 身份分离保存）。 */
export interface RuntimeSourceAuditRecord {
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  /** 策略来源说明（有效配置合并的来源身份；仅审计，不是执行时动态引用）。 */
  readonly source: {
    readonly kind: 'global_default' | 'project_default';
    readonly sourceKey: string;
  };
}

/** 使用时解析的拒绝原因（冻结词汇；缺失/非法一律明确拒绝，不降级）。 */
export type DeliveryPolicyRejectionReason =
  | 'delivery_policy_not_configured'
  | 'commit_mode_missing'
  | 'commit_mode_unsupported'
  | 'git_identity_missing'
  | 'git_identity_not_confirmed'
  | 'git_identity_invalid';

/** 交付政策使用时解析结果：ready（可授权 Feature 最终提交）或结构化拒绝。 */
export type DeliveryPolicyUseResolution =
  | { readonly status: 'ready'; readonly policy: ConfirmedDeliveryPolicy }
  | { readonly status: 'rejected'; readonly reason: DeliveryPolicyRejectionReason };

const GIT_IDENTITY_KEYS = ['name', 'email', 'confirmed'] as const;
const CONFIRMED_POLICY_KEYS = ['commitMode', 'gitIdentity', 'deliveryActions'] as const;
const RUNTIME_SOURCE_KEYS = ['runtime', 'provider', 'model', 'source'] as const;
const RUNTIME_SOURCE_SOURCE_KEYS = ['kind', 'sourceKey'] as const;

/** Unicode 码点计数（String.length 会把 emoji 记为 2）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * 提交姓名校验：1..128 码点；无控制字符/NUL；不允许前后空白；不允许尖括号
 * （防把「姓名 <邮箱>」合并形态当作姓名注入）。姓名只承载用户配置的署名，
 * 不承载 runtime/provider/model 来源信息（来源单独审计保存）。
 */
function validateGitIdentityName(value: unknown, context: ValidationContext, field: string): string {
  const name = requireNonEmptyString(value, context, field);
  if (codePointLength(name) > GIT_IDENTITY_NAME_MAX_CODE_POINTS) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${GIT_IDENTITY_NAME_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
    );
  }
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw validationError(context, field, '不允许包含控制字符');
  }
  if (name.trim() !== name || name.trim().length === 0) {
    throw validationError(context, field, '不允许前后空白或仅空白');
  }
  if (name.includes('<') || name.includes('>')) {
    throw validationError(context, field, '不允许包含 < 或 >（姓名与邮箱是分开的字段）');
  }
  return name;
}

/**
 * 提交邮箱校验（保守形态）：单个 @、非空本地部分、域含点、标签为字母数字
 * 连字符（不以连字符开头/结尾）、无空白/控制字符、无前后点/连续点；总长
 * 3..254 码点。这是结构校验，不是投递可达性承诺；邮箱也绝不承载 runtime
 * 来源或系统默认值。
 */
function validateGitIdentityEmail(value: unknown, context: ValidationContext, field: string): string {
  const email = requireNonEmptyString(value, context, field);
  if (codePointLength(email) > GIT_IDENTITY_EMAIL_MAX_CODE_POINTS) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${GIT_IDENTITY_EMAIL_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
    );
  }
  if (/[\s\u0000-\u001F\u007F]/.test(email)) {
    throw validationError(context, field, '不允许包含空白或控制字符');
  }
  const atCount = [...email.matchAll(/@/g)].length;
  if (atCount !== 1) {
    throw validationError(context, field, '必须恰好包含一个 @（本地部分@域）');
  }
  const [localPart, domain] = email.split('@') as [string, string];
  if (localPart.length === 0 || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
    throw validationError(context, field, '本地部分不能为空或以点开头/结尾/含连续点');
  }
  if (domain.length === 0 || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw validationError(context, field, '域不能为空或以点开头/结尾/含连续点');
  }
  const labels = domain.split('.');
  if (labels.length < 2) {
    throw validationError(context, field, '域必须至少包含一个点（不接受裸主机名）');
  }
  for (const [index, label] of labels.entries()) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      throw validationError(
        context,
        field,
        `域标签 ${index + 1} 必须是字母数字连字符（不以连字符开头/结尾）`,
      );
    }
  }
  const tld = labels[labels.length - 1] as string;
  if (!/^[A-Za-z]{2,}$/.test(tld)) {
    throw validationError(context, field, '顶级域必须是至少两个字母');
  }
  return email;
}

/**
 * 用户 Git 身份校验：name/email 必须明确提供且 confirmed 恒为字面 true。
 * 未经确认（缺失/false/非布尔）以 reason='identity_not_confirmed' 结构化拒绝
 * ——「写入过配置」不等于「用户明确确认可用于提交」。
 */
export function validateConfirmedGitIdentity(
  value: unknown,
  context: ValidationContext,
  field: string,
): ConfirmedGitIdentity {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, GIT_IDENTITY_KEYS, context, field);
  const name = validateGitIdentityName(object.name, context, `${field}.name`);
  const email = validateGitIdentityEmail(object.email, context, `${field}.email`);
  if (object.confirmed !== true) {
    throw new StorageError(
      'validation',
      context.operation,
      `${context.operation}: ${field}.confirmed 必须为 true（提交身份必须由用户明确配置并确认，不回落到开发机全局身份或官方邮箱）`,
      {
        entity: context.entity,
        details: { field: `${field}.confirmed`, reason: 'identity_not_confirmed' },
      },
    );
  }
  return { name, email, confirmed: true };
}

function validateDeliveryActions(
  value: unknown,
  context: ValidationContext,
  field: string,
): readonly DeliveryActionKind[] {
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是交付动作字符串数组（首版仅支持 commit）', value);
  }
  const result: DeliveryActionKind[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (typeof item !== 'string') {
      throw validationError(context, itemField, '必须是字符串交付动作', item);
    }
    if (!(SUPPORTED_DELIVERY_ACTIONS as readonly string[]).includes(item)) {
      throw new StorageError(
        'validation',
        context.operation,
        `${context.operation}: ${itemField} 是未经支持的交付动作「${item}」（首版仅支持 ${SUPPORTED_DELIVERY_ACTIONS.join('/')}；push、PR、自动合并不在本阶段范围）`,
        {
          entity: context.entity,
          details: { field: itemField, reason: 'unsupported_delivery_action' },
        },
      );
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item as DeliveryActionKind);
    }
  }
  return result;
}

/**
 * 配置段校验：字段全部可选（空段 `{}` 合法，段级继承由合并层决定），存在的
 * 字段全部 fail-closed 校验（未知键、非法身份、未经支持政策/动作一律拒绝）。
 */
export function validateDeliveryPolicySection(
  value: unknown,
  context: ValidationContext,
  field: string,
): DeliveryPolicySection {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, CONFIRMED_POLICY_KEYS, context, field);
  const result: {
    commitMode?: CommitMode;
    gitIdentity?: ConfirmedGitIdentity;
    deliveryActions?: readonly DeliveryActionKind[];
  } = {};
  if (object.commitMode !== undefined) {
    if (object.commitMode !== FEATURE_FINAL_COMMIT_MODE && object.commitMode !== TASK_AND_FEATURE_COMMIT_MODE) {
      throw new StorageError(
        'validation',
        context.operation,
        `${context.operation}: ${field}.commitMode 是未经支持的提交政策「${String(object.commitMode)}」（使用 task_and_feature；历史 feature_final_only 仅保留兼容）`,
        {
          entity: context.entity,
          details: { field: `${field}.commitMode`, reason: 'unsupported_commit_mode' },
        },
      );
    }
    result.commitMode = object.commitMode;
  }
  if (object.gitIdentity !== undefined) {
    result.gitIdentity = validateConfirmedGitIdentity(object.gitIdentity, context, `${field}.gitIdentity`);
  }
  if (object.deliveryActions !== undefined) {
    result.deliveryActions = validateDeliveryActions(object.deliveryActions, context, `${field}.deliveryActions`);
  }
  return result;
}

/**
 * 完整获准政策校验（可执行形态）：commitMode 与 gitIdentity 都是必需成分。
 * 缺任一成分在使用边界由 resolveDeliveryPolicyForUse 给出明确拒绝原因；
 * 本函数用于已声明「完整政策」的形态（如后续提交意图固定）。
 */
export function validateConfirmedDeliveryPolicy(
  value: unknown,
  context: ValidationContext,
  field: string,
): ConfirmedDeliveryPolicy {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, CONFIRMED_POLICY_KEYS, context, field);
  if (object.commitMode === undefined) {
    throw validationError(context, `${field}.commitMode`, '完整政策必须显式携带 commitMode（没有默认提交政策）');
  }
  if (object.gitIdentity === undefined) {
    throw validationError(context, `${field}.gitIdentity`, '完整政策必须显式携带用户确认的提交身份');
  }
  const section = validateDeliveryPolicySection(object, context, field);
  return {
    commitMode: section.commitMode as CommitMode,
    gitIdentity: section.gitIdentity as ConfirmedGitIdentity,
    ...(section.deliveryActions === undefined ? {} : { deliveryActions: section.deliveryActions }),
  };
}

/**
 * 使用时解析（fail-closed 纯函数）：把配置段解析为可授权 Feature 最终提交的
 * 完整政策，或给出冻结词汇的拒绝原因。未配置/不完整/非法一律 rejected，
 * 不注入默认政策、不借全局身份补全。防御性地重新校验成分（调用方可能未经
 * schema 校验即传入原始 JSON）。
 */
export function resolveDeliveryPolicyForUse(section: DeliveryPolicySection | undefined): DeliveryPolicyUseResolution {
  if (section === undefined) {
    return { status: 'rejected', reason: 'delivery_policy_not_configured' };
  }
  const context: ValidationContext = { operation: 'DeliveryPolicy.resolveForUse' };
  if (section.commitMode === undefined) {
    if (section.gitIdentity === undefined && section.deliveryActions === undefined) {
      return { status: 'rejected', reason: 'delivery_policy_not_configured' };
    }
    return { status: 'rejected', reason: 'commit_mode_missing' };
  }
  if (section.commitMode !== FEATURE_FINAL_COMMIT_MODE && section.commitMode !== TASK_AND_FEATURE_COMMIT_MODE) {
    return { status: 'rejected', reason: 'commit_mode_unsupported' };
  }
  if (section.gitIdentity === undefined) {
    return { status: 'rejected', reason: 'git_identity_missing' };
  }
  if ((section.gitIdentity as { confirmed?: unknown }).confirmed !== true) {
    return { status: 'rejected', reason: 'git_identity_not_confirmed' };
  }
  try {
    const gitIdentity = validateConfirmedGitIdentity(section.gitIdentity, context, 'gitIdentity');
    const actions = section.deliveryActions === undefined
      ? undefined
      : validateDeliveryActions(section.deliveryActions, context, 'deliveryActions');
    return {
      status: 'ready',
      policy: {
        commitMode: section.commitMode,
        gitIdentity,
        ...(actions === undefined ? {} : { deliveryActions: actions }),
      },
    };
  } catch {
    return { status: 'rejected', reason: 'git_identity_invalid' };
  }
}

/**
 * Runtime/provider/model 来源审计记录校验：三要素非空有界、来源说明限定
 * global_default/project_default + sourceKey；未知键（含任何凭据形态旁路键）
 * 一律拒绝。该记录与用户 Git 身份分离保存，用于提交审计（F-002/F-003 持久化；
 * 可选署名不改变真实身份，也不进入身份字段）。
 */
export function validateRuntimeSourceAuditRecord(
  value: unknown,
  context: ValidationContext,
  field: string,
): RuntimeSourceAuditRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, RUNTIME_SOURCE_KEYS, context, field);
  const runtime = requireNonEmptyString(object.runtime, context, `${field}.runtime`);
  const provider = requireNonEmptyString(object.provider, context, `${field}.provider`);
  const model = requireNonEmptyString(object.model, context, `${field}.model`);
  for (const [key, text] of [
    ['runtime', runtime],
    ['provider', provider],
    ['model', model],
  ] as const) {
    if (codePointLength(text) > 128 || /[\u0000-\u001F\u007F\s]/.test(text)) {
      throw validationError(context, `${field}.${key}`, '必须是 1..128 码点且不含空白/控制字符', text);
    }
  }
  const source = requirePlainObject(object.source, context, `${field}.source`);
  rejectUnknownKeys(source, RUNTIME_SOURCE_SOURCE_KEYS, context, `${field}.source`);
  if (source.kind !== 'global_default' && source.kind !== 'project_default') {
    throw validationError(
      context,
      `${field}.source.kind`,
      "必须是 'global_default' 或 'project_default'",
      source.kind,
    );
  }
  const sourceKey = requireNonEmptyString(source.sourceKey, context, `${field}.source.sourceKey`);
  if (codePointLength(sourceKey) > 256 || /[\u0000-\u001F\u007F]/.test(sourceKey)) {
    throw validationError(context, `${field}.source.sourceKey`, '必须是 1..256 码点且不含控制字符');
  }
  return {
    runtime,
    provider,
    model,
    source: { kind: source.kind, sourceKey },
  };
}

/**
 * 交付政策身份摘要：SHA-256(`${DELIVERY_POLICY_DIGEST_DOMAIN}\n${canonical}`)，
 * 64 位小写十六进制。canonical 是政策段的规范化 JSON（对象键递归排序、
 * undefined 键省略；与 planDigest/checkPolicyDigest 同一稳定序列化规则）；
 * 未配置时摘要锚定显式 null 形态（`null`、`{}` 与任何实配段互不相同）。
 * 输入必须先经 settings-schema 校验（有效配置合并输出）；本函数只接收已
 * 校验的政策段值。
 */
export function computeDeliveryPolicyDigest(section: DeliveryPolicySection | undefined): string {
  const canonical = stableStringify({ deliveryPolicy: section ?? null });
  return createHash('sha256').update(`${DELIVERY_POLICY_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}
