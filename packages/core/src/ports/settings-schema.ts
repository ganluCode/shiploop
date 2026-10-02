/**
 * F-002 / F-008 当前配置（global_settings / project_settings）Payload 的限定 Schema。
 *
 * 设计依据：core-design/06 §3（RuntimeStrategy / ProjectStrategies）与
 * core-design/11 §3.1（payload 必须通过有 schemaVersion 的结构校验；
 * 凭据只保存引用，不存明文；配置含 defaultStrategy/purposeStrategies/modelMap
 * 与 verification/executionLimits/securityPolicy 等政策段）。
 *
 * F-008 显式升级：schemaVersion 1 → 2（docs/p01-3-application-contract.md §5.1/§9-2）。
 * v2 在 v1 的 strategies 结构之上新增**本阶段确认的政策子集** `policies`；
 * v1 payload 一律拒绝（读取持久数据时为 corrupt），旧版本不被静默误读。
 *
 * 范围边界（本阶段明确不做）：
 * - 顶层仅允许 schemaVersion/strategies/policies，未知键一律拒绝，
 *   任意 JSON 不能冒充可执行配置；
 * - 完整策略条目（RuntimeStrategy）必须同时具备 runtime/provider/model，
 *   缺字段即报错，不从其他条目补全（设计 06 §3）；
 * - 政策子集只含 executionLimits/verification/securityPolicy；
 *   memoryPolicy/deliveryPolicy/Agent 职责模式等未定义段一律拒绝，不静默忽略；
 * - credentialRef/endpointRef 只按**引用字符串**校验（拒绝带凭据 URL、
 *   空白/控制字符与超长引用），不解析内容、不读环境/Keychain；
 * - 本模块只做结构与政策校验；runtime/provider 兼容性检查见
 *   ports/runtime-capabilities.ts（可信装配注入的窄能力描述，应用层组合）。
 */
import { StorageError } from './errors.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  requireSafeRecordKey,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** 本版本 Core 唯一支持的配置 payload 结构版本（F-008 由 1 显式升级为 2）。 */
export const SETTINGS_SCHEMA_VERSION = 2;

/** 完整运行时策略条目：三个必备字段齐全才构成可执行策略。 */
export interface RuntimeStrategyV1 {
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  /** 凭据引用（非明文秘密）；运行时由 CredentialProvider 临近执行解析。 */
  readonly credentialRef?: string;
  /** 端点引用（非带凭据 URL）；运行时由装配侧解析。 */
  readonly endpointRef?: string;
}

export type ModelComplexity = 'low' | 'medium' | 'high';
export type StrategyPurpose = 'planner' | 'judge' | 'review';

export interface ProjectStrategiesV1 {
  readonly defaultStrategy?: RuntimeStrategyV1;
  readonly modelMap?: Partial<Record<ModelComplexity, RuntimeStrategyV1>>;
  readonly purposeStrategies?: Partial<Record<StrategyPurpose, RuntimeStrategyV1>>;
  readonly agentOverrides?: Record<string, RuntimeStrategyV1>;
}

/* ------------------------------------------------------------------ *
 * F-008 政策子集（非敏感政策；数值均为有界整数，越界/非法一律拒绝）。
 * 数值上限是 P01-3 实施契约值（设计未给定），见契约文档 §9-2 请求核对。
 * ------------------------------------------------------------------ */

/** maxConcurrentWorks 取值范围（P01 运行时为全局单并发，配置是上限政策）。 */
export const MAX_CONCURRENT_WORKS_MIN = 1;
export const MAX_CONCURRENT_WORKS_MAX = 16;
/** workTimeoutMs 取值范围：1 秒 .. 24 小时。 */
export const WORK_TIMEOUT_MS_MIN = 1_000;
export const WORK_TIMEOUT_MS_MAX = 86_400_000;
/** maxAttemptsPerTask 取值范围。 */
export const MAX_ATTEMPTS_PER_TASK_MIN = 1;
export const MAX_ATTEMPTS_PER_TASK_MAX = 100;
/** envAllowlist 去重后数量上限。 */
export const ENV_ALLOWLIST_MAX_COUNT = 64;
/** credentialRef/endpointRef 引用字符串长度上限（Unicode 码点）。 */
export const SECRET_REFERENCE_MAX_LENGTH = 256;

/** 首版唯一支持的隔离模式：用户明确授权的可信项目模式（不等于强 OS 沙箱）。 */
export const TRUSTED_PROJECT_ISOLATION = 'trusted_project';

export interface ExecutionLimitsPolicyV2 {
  /** 并发 Work 上限政策（有界整数）。 */
  readonly maxConcurrentWorks?: number;
  /** 单次 Work 超时上限（毫秒，有界整数）。 */
  readonly workTimeoutMs?: number;
  /** 每 Task 最大 Attempt 数（有界整数）。 */
  readonly maxAttemptsPerTask?: number;
  /**
   * 允许透传给执行环境的**非敏感环境变量名**允许列表（只含变量名，绝不含值；
   * 设计 06 §3「环境变量按允许列表，不继承整个 Host 环境」）。秘密形态名称
   * （SECRET/TOKEN/PASSWORD/CREDENTIAL/KEY/PRIVATE/AUTH 等分段）一律拒绝。
   */
  readonly envAllowlist?: readonly string[];
}

export interface VerificationPolicyV2 {
  /** 完成前是否必须通过检查（布尔；不含执行编排语义）。 */
  readonly requireChecksBeforeDone?: boolean;
}

export interface SecurityPolicyV2 {
  /**
   * 隔离模式：首版仅支持 trusted_project。要求强隔离（strong_sandbox 等）
   * 一律明确拒绝，不静默降级为可信项目执行。
   */
  readonly isolation?: typeof TRUSTED_PROJECT_ISOLATION;
}

/** 本阶段确认的政策子集；未列出的政策段（memoryPolicy/deliveryPolicy 等）未定义即非法。 */
export interface SettingsPoliciesV2 {
  readonly executionLimits?: ExecutionLimitsPolicyV2;
  readonly verification?: VerificationPolicyV2;
  readonly securityPolicy?: SecurityPolicyV2;
}

export interface SettingsPayloadV2 {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly strategies?: ProjectStrategiesV1;
  readonly policies?: SettingsPoliciesV2;
}

/** 当前唯一支持的 payload 形态；未来版本以判别联合扩展。 */
export type SettingsPayload = SettingsPayloadV2;

/**
 * 配置作用域（契约文档 §4.4）：global 为单例默认；project 携带稳定 projectId，
 * 每项目一条覆盖。scope 校验在写入/读取边界完成，非法 scope 先于任何 I/O 拒绝。
 */
export type SettingsScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

const PAYLOAD_KEYS = ['schemaVersion', 'strategies', 'policies'] as const;
const STRATEGIES_KEYS = ['defaultStrategy', 'modelMap', 'purposeStrategies', 'agentOverrides'] as const;
const STRATEGY_ENTRY_KEYS = ['runtime', 'provider', 'model', 'credentialRef', 'endpointRef'] as const;
const MODEL_MAP_KEYS = ['low', 'medium', 'high'] as const;
const PURPOSE_KEYS = ['planner', 'judge', 'review'] as const;
const POLICIES_KEYS = ['executionLimits', 'verification', 'securityPolicy'] as const;
const EXECUTION_LIMITS_KEYS = ['maxConcurrentWorks', 'workTimeoutMs', 'maxAttemptsPerTask', 'envAllowlist'] as const;
const VERIFICATION_KEYS = ['requireChecksBeforeDone'] as const;
const SECURITY_POLICY_KEYS = ['isolation'] as const;

/** 以 Unicode 码点计数（String.length 会把 emoji 记为 2）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * 凭据/端点引用字符串校验：非空、长度有界、不含空白与控制字符；
 * 拒绝带凭据的 URL（scheme://user[:pass]@host）——凭据只保存引用，
 * 绝不把明文或内嵌凭据当作引用存入（设计 11 §3.1）。
 * 错误不回显引用原文（details 只含 field/reason）。
 */
function validateSecretReference(value: unknown, context: ValidationContext, field: string): string {
  const reference = requireNonEmptyString(value, context, field);
  if (codePointLength(reference) > SECRET_REFERENCE_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `引用长度不得超过 ${SECRET_REFERENCE_MAX_LENGTH} 个字符（Unicode 码点）`,
    );
  }
  if (/[\s\u0000-\u001F\u007F]/.test(reference)) {
    throw validationError(context, field, '引用不允许包含空白或控制字符');
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(reference)) {
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw validationError(context, field, 'URL 形态的引用不是合法 URL');
    }
    if (url.username !== '' || url.password !== '') {
      throw new StorageError(
        'validation',
        context.operation,
        `${context.operation}: ${field} 不允许携带凭据的 URL（凭据只保存引用，不存明文/内嵌凭据）`,
        { entity: context.entity, details: { field, reason: 'credential_in_url' } },
      );
    }
  }
  return reference;
}

function validateRuntimeStrategy(
  value: unknown,
  context: ValidationContext,
  field: string,
): RuntimeStrategyV1 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, STRATEGY_ENTRY_KEYS, context, field);
  const runtime = requireNonEmptyString(object.runtime, context, `${field}.runtime`);
  const provider = requireNonEmptyString(object.provider, context, `${field}.provider`);
  const model = requireNonEmptyString(object.model, context, `${field}.model`);
  const result: {
    runtime: string;
    provider: string;
    model: string;
    credentialRef?: string;
    endpointRef?: string;
  } = { runtime, provider, model };
  if (object.credentialRef !== undefined) {
    result.credentialRef = validateSecretReference(object.credentialRef, context, `${field}.credentialRef`);
  }
  if (object.endpointRef !== undefined) {
    result.endpointRef = validateSecretReference(object.endpointRef, context, `${field}.endpointRef`);
  }
  return result;
}

function validateKeyedStrategies(
  value: unknown,
  allowedKeys: readonly string[],
  context: ValidationContext,
  field: string,
): Record<string, RuntimeStrategyV1> {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, allowedKeys, context, field);
  const result: Record<string, RuntimeStrategyV1> = {};
  for (const key of allowedKeys) {
    if (object[key] !== undefined) {
      result[key] = validateRuntimeStrategy(object[key], context, `${field}.${key}`);
    }
  }
  return result;
}

function validateAgentOverrides(
  value: unknown,
  context: ValidationContext,
  field: string,
): Record<string, RuntimeStrategyV1> {
  const object = requirePlainObject(value, context, field);
  const result: Record<string, RuntimeStrategyV1> = {};
  for (const key of Object.keys(object)) {
    requireSafeRecordKey(key, context, `${field}.${key}`);
    result[key] = validateRuntimeStrategy(object[key], context, `${field}.${key}`);
  }
  return result;
}

function validateProjectStrategies(
  value: unknown,
  context: ValidationContext,
  field: string,
): ProjectStrategiesV1 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, STRATEGIES_KEYS, context, field);
  const result: {
    defaultStrategy?: RuntimeStrategyV1;
    modelMap?: Record<string, RuntimeStrategyV1>;
    purposeStrategies?: Record<string, RuntimeStrategyV1>;
    agentOverrides?: Record<string, RuntimeStrategyV1>;
  } = {};
  if (object.defaultStrategy !== undefined) {
    result.defaultStrategy = validateRuntimeStrategy(object.defaultStrategy, context, `${field}.defaultStrategy`);
  }
  if (object.modelMap !== undefined) {
    result.modelMap = validateKeyedStrategies(object.modelMap, MODEL_MAP_KEYS, context, `${field}.modelMap`);
  }
  if (object.purposeStrategies !== undefined) {
    result.purposeStrategies = validateKeyedStrategies(
      object.purposeStrategies,
      PURPOSE_KEYS,
      context,
      `${field}.purposeStrategies`,
    );
  }
  if (object.agentOverrides !== undefined) {
    result.agentOverrides = validateAgentOverrides(object.agentOverrides, context, `${field}.agentOverrides`);
  }
  return result;
}

/** 有界整数政策值：整数且在 [min, max] 内，否则带字段定位拒绝。 */
function validateBoundedInteger(
  value: unknown,
  context: ValidationContext,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw validationError(context, field, `必须是 ${min}..${max} 的整数`, value);
  }
  return value;
}

/**
 * 秘密形态环境变量名分段（保守启发式）：按 _ 分段后命中任一分段即拒绝。
 * envAllowlist 只允许非敏感变量名（名称而非值）；宁可误拒（如 SSH_AUTH_SOCK）
 * 也不放行疑似秘密名称。
 */
const SENSITIVE_ENV_NAME_SEGMENTS = new Set([
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'KEY',
  'PRIVATE',
  'AUTH',
]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateEnvAllowlist(
  value: unknown,
  context: ValidationContext,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是环境变量名字符串数组', value);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (typeof item !== 'string' || !ENV_NAME_PATTERN.test(item)) {
      throw validationError(context, itemField, '必须是合法环境变量名（[A-Za-z_][A-Za-z0-9_]*）', item);
    }
    const sensitive = item
      .toUpperCase()
      .split('_')
      .some((segment) => SENSITIVE_ENV_NAME_SEGMENTS.has(segment));
    if (sensitive) {
      throw new StorageError(
        'validation',
        context.operation,
        `${context.operation}: ${itemField} 疑似秘密形态环境变量名，envAllowlist 只接受非敏感变量名`,
        { entity: context.entity, details: { field: itemField, reason: 'sensitive_env_name' } },
      );
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  if (result.length > ENV_ALLOWLIST_MAX_COUNT) {
    throw validationError(context, field, `环境变量允许列表去重后不得超过 ${ENV_ALLOWLIST_MAX_COUNT} 项`);
  }
  return result;
}

function validateExecutionLimitsPolicy(
  value: unknown,
  context: ValidationContext,
  field: string,
): ExecutionLimitsPolicyV2 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, EXECUTION_LIMITS_KEYS, context, field);
  const result: {
    maxConcurrentWorks?: number;
    workTimeoutMs?: number;
    maxAttemptsPerTask?: number;
    envAllowlist?: readonly string[];
  } = {};
  if (object.maxConcurrentWorks !== undefined) {
    result.maxConcurrentWorks = validateBoundedInteger(
      object.maxConcurrentWorks,
      context,
      `${field}.maxConcurrentWorks`,
      MAX_CONCURRENT_WORKS_MIN,
      MAX_CONCURRENT_WORKS_MAX,
    );
  }
  if (object.workTimeoutMs !== undefined) {
    result.workTimeoutMs = validateBoundedInteger(
      object.workTimeoutMs,
      context,
      `${field}.workTimeoutMs`,
      WORK_TIMEOUT_MS_MIN,
      WORK_TIMEOUT_MS_MAX,
    );
  }
  if (object.maxAttemptsPerTask !== undefined) {
    result.maxAttemptsPerTask = validateBoundedInteger(
      object.maxAttemptsPerTask,
      context,
      `${field}.maxAttemptsPerTask`,
      MAX_ATTEMPTS_PER_TASK_MIN,
      MAX_ATTEMPTS_PER_TASK_MAX,
    );
  }
  if (object.envAllowlist !== undefined) {
    result.envAllowlist = validateEnvAllowlist(object.envAllowlist, context, `${field}.envAllowlist`);
  }
  return result;
}

function validateVerificationPolicy(
  value: unknown,
  context: ValidationContext,
  field: string,
): VerificationPolicyV2 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, VERIFICATION_KEYS, context, field);
  const result: { requireChecksBeforeDone?: boolean } = {};
  if (object.requireChecksBeforeDone !== undefined) {
    if (typeof object.requireChecksBeforeDone !== 'boolean') {
      throw validationError(context, `${field}.requireChecksBeforeDone`, '必须是布尔值', object.requireChecksBeforeDone);
    }
    result.requireChecksBeforeDone = object.requireChecksBeforeDone;
  }
  return result;
}

function validateSecurityPolicy(
  value: unknown,
  context: ValidationContext,
  field: string,
): SecurityPolicyV2 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, SECURITY_POLICY_KEYS, context, field);
  const result: { isolation?: typeof TRUSTED_PROJECT_ISOLATION } = {};
  if (object.isolation !== undefined) {
    if (object.isolation !== TRUSTED_PROJECT_ISOLATION) {
      throw new StorageError(
        'validation',
        context.operation,
        `${context.operation}: ${field}.isolation 首版仅支持 ${TRUSTED_PROJECT_ISOLATION}（可信项目模式）；` +
          '要求强隔离等未支持能力不会被静默降级',
        { entity: context.entity, details: { field: `${field}.isolation`, reason: 'unsupported_isolation' } },
      );
    }
    result.isolation = TRUSTED_PROJECT_ISOLATION;
  }
  return result;
}

function validateSettingsPolicies(
  value: unknown,
  context: ValidationContext,
  field: string,
): SettingsPoliciesV2 {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, POLICIES_KEYS, context, field);
  const result: {
    executionLimits?: ExecutionLimitsPolicyV2;
    verification?: VerificationPolicyV2;
    securityPolicy?: SecurityPolicyV2;
  } = {};
  if (object.executionLimits !== undefined) {
    result.executionLimits = validateExecutionLimitsPolicy(object.executionLimits, context, `${field}.executionLimits`);
  }
  if (object.verification !== undefined) {
    result.verification = validateVerificationPolicy(object.verification, context, `${field}.verification`);
  }
  if (object.securityPolicy !== undefined) {
    result.securityPolicy = validateSecurityPolicy(object.securityPolicy, context, `${field}.securityPolicy`);
  }
  return result;
}

/**
 * 校验外部输入是否为受支持的当前配置 payload（schemaVersion=2 限定结构）。
 * 返回规范化后的新对象（不与输入共享引用）；失败抛 StorageError(kind='validation')，
 * 错误携带操作与适用实体身份。
 */
export function validateSettingsPayload(value: unknown, context: ValidationContext): SettingsPayload {
  const object = requirePlainObject(value, context, 'payload');
  rejectUnknownKeys(object, PAYLOAD_KEYS, context, 'payload');
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw validationError(
      context,
      'payload.schemaVersion',
      `未知或不支持的 schemaVersion（本版本仅支持 ${SETTINGS_SCHEMA_VERSION}）`,
      object.schemaVersion,
    );
  }
  const result: {
    schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
    strategies?: ProjectStrategiesV1;
    policies?: SettingsPoliciesV2;
  } = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  if (object.strategies !== undefined) {
    result.strategies = validateProjectStrategies(object.strategies, context, 'payload.strategies');
  }
  if (object.policies !== undefined) {
    result.policies = validateSettingsPolicies(object.policies, context, 'payload.policies');
  }
  return result;
}

/**
 * 读取路径校验：解析持久化 JSON 文本并重新做结构校验。
 * 非法 JSON 与未知/损坏结构都返回 StorageError(kind='corrupt')——
 * 持久层取出的数据不能未经校验就当作有效配置返回（core-design/11 §3.1）；
 * 旧版本（v1）持久数据同样以 corrupt 拒绝，不被新版本静默误读。
 */
export function parseStoredSettingsPayload(jsonText: string, context: ValidationContext): SettingsPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    throw new StorageError(
      'corrupt',
      context.operation,
      `${context.operation}: 持久化配置不是合法 JSON`,
      { entity: context.entity, details: { reason: 'invalid_json' }, cause },
    );
  }
  try {
    return validateSettingsPayload(parsed, context);
  } catch (error) {
    if (error instanceof StorageError && error.kind === 'validation') {
      throw new StorageError(
        'corrupt',
        context.operation,
        `${context.operation}: 持久化配置结构损坏或版本未知`,
        {
          entity: context.entity,
          details: { reason: 'schema_mismatch', field: error.details?.field },
          cause: error,
        },
      );
    }
    throw error;
  }
}

/**
 * 配置 scope 校验：global（单例默认）或 project（携带稳定 projectId）。
 * 未知 kind、project 缺 projectId、global 多带 projectId、未知键均拒绝。
 */
export function validateSettingsScope(value: unknown, context: ValidationContext): SettingsScope {
  const object = requirePlainObject(value, context, 'scope');
  rejectUnknownKeys(object, ['kind', 'projectId'], context, 'scope');
  if (object.kind === 'global') {
    if (object.projectId !== undefined) {
      throw validationError(context, 'scope.projectId', '全局 scope 不允许携带 projectId');
    }
    return { kind: 'global' };
  }
  if (object.kind === 'project') {
    if (object.projectId === undefined) {
      throw validationError(context, 'scope.projectId', '项目 scope 必须携带 projectId');
    }
    return { kind: 'project', projectId: validateStableId(object.projectId, context, 'scope.projectId') };
  }
  throw validationError(context, 'scope.kind', "必须是 'global' 或 'project'", object.kind);
}

/** 已校验 payload 中的一条策略条目及其字段路径（供兼容性检查/审计摘要使用）。 */
export interface StrategyEntryRef {
  /** payload 内字段路径，如 payload.strategies.modelMap.low。 */
  readonly field: string;
  readonly strategy: RuntimeStrategyV1;
}

/**
 * 枚举 payload.strategies 中**实际提供**的全部策略条目，顺序稳定
 * （defaultStrategy → modelMap → purposeStrategies → agentOverrides 键序）。
 * 无任何条目时返回空数组（未配置）。
 */
export function listStrategyEntries(strategies: ProjectStrategiesV1 | undefined): StrategyEntryRef[] {
  if (strategies === undefined) {
    return [];
  }
  const entries: StrategyEntryRef[] = [];
  if (strategies.defaultStrategy !== undefined) {
    entries.push({ field: 'payload.strategies.defaultStrategy', strategy: strategies.defaultStrategy });
  }
  for (const key of MODEL_MAP_KEYS) {
    const strategy = strategies.modelMap?.[key];
    if (strategy !== undefined) {
      entries.push({ field: `payload.strategies.modelMap.${key}`, strategy });
    }
  }
  for (const key of PURPOSE_KEYS) {
    const strategy = strategies.purposeStrategies?.[key];
    if (strategy !== undefined) {
      entries.push({ field: `payload.strategies.purposeStrategies.${key}`, strategy });
    }
  }
  for (const key of Object.keys(strategies.agentOverrides ?? {})) {
    const strategy = strategies.agentOverrides?.[key];
    if (strategy !== undefined) {
      entries.push({ field: `payload.strategies.agentOverrides.${key}`, strategy });
    }
  }
  return entries;
}
