/**
 * P01-3 / F-009 有效配置合并（application 层纯函数）：全局默认与项目当前覆盖
 * 的键级继承、完整策略条目整体替换与逐项来源解释。
 *
 * 设计依据：docs/p01-3-application-contract.md §4.4 / §5.3（键级继承、完整
 * 条目整体替换、不跨来源拼接执行身份、未配置不注入默认、来源说明）与
 * core-design/06 §3（RuntimeStrategy / ProjectStrategies）。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件系统/网络/环境，不解析凭据引用，不创建 Task、不写
 *   执行快照；import 本模块无副作用；
 * - 两个来源的 payload 在合并前重新经 `validateSettingsPayload` 运行时校验
 *   （含 schemaVersion=2 门槛）：未知版本、未知键、不完整策略条目、非法政策
 *   数值一律带字段定位拒绝——无效项目覆盖不悄悄忽略或降级成全局配置，无效
 *   全局配置也不被合法项目覆盖掩盖；
 * - 完整策略条目整体替换：`defaultStrategy` 与 `modelMap` / `purposeStrategies` /
 *   `agentOverrides` 的同名键以项目完整条目替换全局条目，绝不跨来源拼接
 *   runtime/provider/model（项目条目缺字段在校验阶段即报错，不会借全局字段
 *   拼成另一个「有效策略」）；其余未覆盖键继续继承全局；
 * - 政策段按段整体覆盖（见契约 §5.3 F-009 定案）：项目提供某政策段即以项目
 *   段整体替换全局段，段内字段不跨来源继承；数组（envAllowlist）随段整体
 *   替换，不做并集/拼接；空政策段对象 `{}` 与空 `modelMap: {}` 一样表示
 *   不覆盖、继承全局；null 条目/段被拒绝（无「null=清除」语义）；
 * - 合并不修改原始 payload：输出全部为新对象（校验器返回规范化新对象，
 *   本模块只读输入并组装新结构）；不注入默认 Claude/API——双方均无任一策略
 *   时返回 `configured: false` 的明确未配置结果；
 * - 来源解释：每个有效策略条目/政策段附 `global_default` / `project_default`
 *   来源、`sourceKey`（如 `modelMap.low`、`policies.executionLimits`）与来源
 *   scope 的 `scopeRevision`；来源仅说明出处，不是执行时动态引用。
 *
 * 本模块不实现（后续任务）：从 StateStore 读取持久记录并组装来源输入
 * （F-011 `ConfigurationService.getEffectiveSettings`）、一致性视图内的写入
 * （F-010）、导出（F-011）、Task 策略复制（T24 后续）。
 */
import {
  SETTINGS_SCHEMA_VERSION,
  validateSettingsPayload,
} from '../ports/settings-schema.js';
import type {
  ExecutionLimitsPolicyV2,
  ModelComplexity,
  RuntimeStrategyV1,
  SecurityPolicyV2,
  SettingsPayload,
  StrategyPurpose,
  VerificationPolicyV2,
} from '../ports/settings-schema.js';
import type { StorageEntityRef } from '../ports/errors.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 合并操作名（结构化错误的 operation；本模块为纯函数，仍保持操作身份一致）。 */
export const EFFECTIVE_SETTINGS_MERGE_OPERATION = 'EffectiveSettings.merge';

/** 有效配置条目的来源：全局默认或项目当前覆盖。 */
export type EffectiveSourceKind = 'global_default' | 'project_default';

/**
 * 单项来源身份：来源种类、来源 scope 的 revision 与来源键
 * （如 `modelMap.low`、`purposeStrategies.planner`、`policies.executionLimits`）。
 * 来源仅说明出处，不是执行时动态引用。
 */
export interface EffectiveSource {
  readonly kind: EffectiveSourceKind;
  readonly scopeRevision: number;
  readonly sourceKey: string;
}

/** 一条有效策略条目：完整 RuntimeStrategyV1 + 来源。 */
export interface EffectiveStrategyEntry {
  readonly strategy: RuntimeStrategyV1;
  readonly source: EffectiveSource;
}

/** 有效策略集合：未提供的键缺省（不是 null）。 */
export interface EffectiveStrategies {
  readonly defaultStrategy?: EffectiveStrategyEntry;
  readonly modelMap: Partial<Record<ModelComplexity, EffectiveStrategyEntry>>;
  readonly purposeStrategies: Partial<Record<StrategyPurpose, EffectiveStrategyEntry>>;
  readonly agentOverrides: Record<string, EffectiveStrategyEntry>;
}

/** 一段有效政策：整段值 + 来源（段级整体覆盖，段内不跨来源继承）。 */
export interface EffectivePolicySection<T> {
  readonly value: T;
  readonly source: EffectiveSource;
}

/** 有效政策集合：未提供的段缺省。 */
export interface EffectivePolicies {
  readonly executionLimits?: EffectivePolicySection<ExecutionLimitsPolicyV2>;
  readonly verification?: EffectivePolicySection<VerificationPolicyV2>;
  readonly securityPolicy?: EffectivePolicySection<SecurityPolicyV2>;
}

/**
 * 有效配置合并结果。`configured=false` 表示双方均无任一策略条目
 * （明确未配置/不可执行），此时 strategies/policies 为空集合；
 * 合法 ≠ 可执行（P01 未装配 Runner/认证/模型执行能力，见 F-008
 * `assessSettingsConfiguration`）。
 */
export interface EffectiveSettings {
  readonly configured: boolean;
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly strategies: EffectiveStrategies;
  readonly policies: EffectivePolicies;
}

/**
 * 一个来源 scope 的合并输入：payload 为边界 unknown（合并前重新校验），
 * scopeRevision 为该 scope 当前记录的 revision（≥1 整数，用于来源身份）。
 * 缺省/传 null 表示该 scope 无配置记录。
 */
export interface EffectiveSettingsScopeInput {
  readonly scopeRevision: unknown;
  readonly payload: unknown;
}

/** 合并输入：全局默认与项目当前覆盖均可缺省（三类输入均合法）。 */
export interface MergeEffectiveSettingsInput {
  readonly global?: EffectiveSettingsScopeInput | null;
  readonly project?: EffectiveSettingsScopeInput | null;
}

const MODEL_COMPLEXITY_KEYS = ['low', 'medium', 'high'] as const satisfies readonly ModelComplexity[];
const STRATEGY_PURPOSE_KEYS = ['planner', 'judge', 'review'] as const satisfies readonly StrategyPurpose[];

interface ValidatedScopeInput {
  readonly scopeRevision: number;
  readonly payload: SettingsPayload;
}

/**
 * 校验一个来源 scope 输入：白名单键 + scopeRevision（≥1 整数）+
 * payload 重新经 schemaVersion=2 结构校验。任何非法输入带字段定位拒绝；
 * 无效来源不被静默忽略或降级。
 */
function validateScopeInput(
  value: unknown,
  scopeField: 'global' | 'project',
  entity: StorageEntityRef,
): ValidatedScopeInput {
  const context: ValidationContext = { operation: EFFECTIVE_SETTINGS_MERGE_OPERATION, entity };
  const object = requirePlainObject(value, context, scopeField);
  rejectUnknownKeys(object, ['scopeRevision', 'payload'], context, scopeField);
  if (object.scopeRevision === undefined) {
    throw validationError(context, `${scopeField}.scopeRevision`, '必须提供来源 scope 的 revision');
  }
  const scopeRevision = validatePositiveInteger(object.scopeRevision, context, `${scopeField}.scopeRevision`);
  if (object.payload === undefined) {
    throw validationError(context, `${scopeField}.payload`, '必须提供来源 scope 的配置 payload');
  }
  const payload = validateSettingsPayload(object.payload, context);
  return { scopeRevision, payload };
}

/** 组装一条带来源的策略条目（项目优先，整体替换；否则继承全局；都没有则缺省）。 */
function pickStrategyEntry(
  sourceKey: string,
  projectStrategy: RuntimeStrategyV1 | undefined,
  projectScope: ValidatedScopeInput | undefined,
  globalStrategy: RuntimeStrategyV1 | undefined,
  globalScope: ValidatedScopeInput | undefined,
): EffectiveStrategyEntry | undefined {
  if (projectScope !== undefined && projectStrategy !== undefined) {
    return {
      strategy: projectStrategy,
      source: { kind: 'project_default', scopeRevision: projectScope.scopeRevision, sourceKey },
    };
  }
  if (globalScope !== undefined && globalStrategy !== undefined) {
    return {
      strategy: globalStrategy,
      source: { kind: 'global_default', scopeRevision: globalScope.scopeRevision, sourceKey },
    };
  }
  return undefined;
}

/** 段级整体覆盖：项目提供了**非空**段即以项目段整体替换；空段对象 `{}` 表示不覆盖、继承全局。 */
function pickPolicySection<T extends object>(
  sourceKey: string,
  projectSection: T | undefined,
  projectScope: ValidatedScopeInput | undefined,
  globalSection: T | undefined,
  globalScope: ValidatedScopeInput | undefined,
): EffectivePolicySection<T> | undefined {
  if (projectScope !== undefined && projectSection !== undefined && Object.keys(projectSection).length > 0) {
    return {
      value: projectSection,
      source: { kind: 'project_default', scopeRevision: projectScope.scopeRevision, sourceKey },
    };
  }
  if (globalScope !== undefined && globalSection !== undefined && Object.keys(globalSection).length > 0) {
    return {
      value: globalSection,
      source: { kind: 'global_default', scopeRevision: globalScope.scopeRevision, sourceKey },
    };
  }
  return undefined;
}

/**
 * 合并全局默认与项目当前覆盖为有效配置（纯函数）。
 *
 * 输入边界为 unknown：外层仅允许 `global` / `project` 键，每个来源输入重新
 * 校验（scopeRevision + schemaVersion=2 payload）；任一来源非法即带字段定位
 * 抛 StorageError(kind='validation')，绝不悄悄忽略或降级成另一来源。
 */
export function mergeEffectiveSettings(input: unknown): EffectiveSettings {
  const context: ValidationContext = { operation: EFFECTIVE_SETTINGS_MERGE_OPERATION };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, ['global', 'project'], context, 'input');

  const globalScope =
    object.global === undefined || object.global === null
      ? undefined
      : validateScopeInput(object.global, 'global', { type: 'global_settings', id: 'global' });
  const projectScope =
    object.project === undefined || object.project === null
      ? undefined
      : validateScopeInput(object.project, 'project', { type: 'project_settings' });

  const globalStrategies = globalScope?.payload.strategies;
  const projectStrategies = projectScope?.payload.strategies;

  const strategies: {
    defaultStrategy?: EffectiveStrategyEntry;
    modelMap: Partial<Record<ModelComplexity, EffectiveStrategyEntry>>;
    purposeStrategies: Partial<Record<StrategyPurpose, EffectiveStrategyEntry>>;
    agentOverrides: Record<string, EffectiveStrategyEntry>;
  } = { modelMap: {}, purposeStrategies: {}, agentOverrides: {} };

  const defaultStrategy = pickStrategyEntry(
    'defaultStrategy',
    projectStrategies?.defaultStrategy,
    projectScope,
    globalStrategies?.defaultStrategy,
    globalScope,
  );
  if (defaultStrategy !== undefined) {
    strategies.defaultStrategy = defaultStrategy;
  }
  for (const key of MODEL_COMPLEXITY_KEYS) {
    const entry = pickStrategyEntry(
      `modelMap.${key}`,
      projectStrategies?.modelMap?.[key],
      projectScope,
      globalStrategies?.modelMap?.[key],
      globalScope,
    );
    if (entry !== undefined) {
      strategies.modelMap[key] = entry;
    }
  }
  for (const key of STRATEGY_PURPOSE_KEYS) {
    const entry = pickStrategyEntry(
      `purposeStrategies.${key}`,
      projectStrategies?.purposeStrategies?.[key],
      projectScope,
      globalStrategies?.purposeStrategies?.[key],
      globalScope,
    );
    if (entry !== undefined) {
      strategies.purposeStrategies[key] = entry;
    }
  }
  // agentOverrides：键并集；同名键以项目完整条目整体替换（不跨来源拼接）。
  const agentKeys = new Set<string>([
    ...Object.keys(globalStrategies?.agentOverrides ?? {}),
    ...Object.keys(projectStrategies?.agentOverrides ?? {}),
  ]);
  for (const key of agentKeys) {
    const entry = pickStrategyEntry(
      `agentOverrides.${key}`,
      projectStrategies?.agentOverrides?.[key],
      projectScope,
      globalStrategies?.agentOverrides?.[key],
      globalScope,
    );
    if (entry !== undefined) {
      strategies.agentOverrides[key] = entry;
    }
  }

  const globalPolicies = globalScope?.payload.policies;
  const projectPolicies = projectScope?.payload.policies;
  const policies: {
    executionLimits?: EffectivePolicySection<ExecutionLimitsPolicyV2>;
    verification?: EffectivePolicySection<VerificationPolicyV2>;
    securityPolicy?: EffectivePolicySection<SecurityPolicyV2>;
  } = {};
  const executionLimits = pickPolicySection(
    'policies.executionLimits',
    projectPolicies?.executionLimits,
    projectScope,
    globalPolicies?.executionLimits,
    globalScope,
  );
  if (executionLimits !== undefined) {
    policies.executionLimits = executionLimits;
  }
  const verification = pickPolicySection(
    'policies.verification',
    projectPolicies?.verification,
    projectScope,
    globalPolicies?.verification,
    globalScope,
  );
  if (verification !== undefined) {
    policies.verification = verification;
  }
  const securityPolicy = pickPolicySection(
    'policies.securityPolicy',
    projectPolicies?.securityPolicy,
    projectScope,
    globalPolicies?.securityPolicy,
    globalScope,
  );
  if (securityPolicy !== undefined) {
    policies.securityPolicy = securityPolicy;
  }

  const configured =
    strategies.defaultStrategy !== undefined ||
    Object.keys(strategies.modelMap).length > 0 ||
    Object.keys(strategies.purposeStrategies).length > 0 ||
    Object.keys(strategies.agentOverrides).length > 0;

  return {
    configured,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    strategies,
    policies,
  };
}
