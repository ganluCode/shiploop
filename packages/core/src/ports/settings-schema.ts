/**
 * F-002 当前配置（global_settings / project_settings）Payload 的限定 Schema。
 *
 * 设计依据：core-design/06 §3（RuntimeStrategy / ProjectStrategies）与
 * core-design/11 §3.1（payload 必须通过有 schemaVersion 的结构校验；
 * 凭据只保存引用，不存明文）。
 *
 * 范围边界（本 Feature 明确不做）：
 * - 仓库中尚无完整策略契约实现，这里只为存储校验提供明确限定的 schemaVersion=1
 *   结构：顶层仅允许 schemaVersion 与 strategies，未知键一律拒绝，
 *   任意对象不能冒充可执行策略；
 * - 完整策略条目（RuntimeStrategy）必须同时具备 runtime/provider/model，
 *   缺字段即报错，不从其他条目补全（设计 06 §3）；
 * - verification / executionLimits / securityPolicy / memoryPolicy / deliveryPolicy
 *   等配置段随各自设计落地时以显式结构加入，未定义前不属于合法 payload；
 * - 不做模型路由、配置合并、Task 策略复制或凭据解析（credentialRef/endpointRef
 *   只按引用字符串校验形态，不解析内容）。
 */
import { StorageError } from './errors.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  requireSafeRecordKey,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** 本版本 Core 唯一支持的配置 payload 结构版本。 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** 完整运行时策略条目：三个必备字段齐全才构成可执行策略。 */
export interface RuntimeStrategyV1 {
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  /** 凭据引用（非明文秘密）；运行时由 CredentialProvider 临近执行解析。 */
  readonly credentialRef?: string;
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

export interface SettingsPayloadV1 {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly strategies?: ProjectStrategiesV1;
}

/** 当前唯一支持的 payload 形态；未来版本以判别联合扩展。 */
export type SettingsPayload = SettingsPayloadV1;

const PAYLOAD_KEYS = ['schemaVersion', 'strategies'] as const;
const STRATEGIES_KEYS = ['defaultStrategy', 'modelMap', 'purposeStrategies', 'agentOverrides'] as const;
const STRATEGY_ENTRY_KEYS = ['runtime', 'provider', 'model', 'credentialRef', 'endpointRef'] as const;
const MODEL_MAP_KEYS = ['low', 'medium', 'high'] as const;
const PURPOSE_KEYS = ['planner', 'judge', 'review'] as const;

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
    result.credentialRef = requireNonEmptyString(object.credentialRef, context, `${field}.credentialRef`);
  }
  if (object.endpointRef !== undefined) {
    result.endpointRef = requireNonEmptyString(object.endpointRef, context, `${field}.endpointRef`);
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

/**
 * 校验外部输入是否为受支持的当前配置 payload。
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
  const result: { schemaVersion: typeof SETTINGS_SCHEMA_VERSION; strategies?: ProjectStrategiesV1 } = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  if (object.strategies !== undefined) {
    result.strategies = validateProjectStrategies(object.strategies, context, 'payload.strategies');
  }
  return result;
}

/**
 * 读取路径校验：解析持久化 JSON 文本并重新做结构校验。
 * 非法 JSON 与未知/损坏结构都返回 StorageError(kind='corrupt')——
 * 持久层取出的数据不能未经校验就当作有效配置返回（core-design/11 §3.1）。
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
