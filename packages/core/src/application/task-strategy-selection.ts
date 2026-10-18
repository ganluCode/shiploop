/**
 * P03-1 / F-003 创建 Task 时的完整策略副本与来源选择（application 层纯函数）。
 *
 * 设计依据：core-design/06 §3（创建编码 Task 时按「复杂度策略 → … → 默认策略」
 * 解析整体条目；选定完整策略复制到 Task.executionConfig；无匹配即配置错误，不偷偷
 * 注入任何默认厂商/模型）、core-design/11 §3.1（execution_config 含 schemaVersion
 * 与完整策略字段；config_source 为 project_default/global_default/user_override，
 * config_source_key 记录 modelMap.low 等来源，仅供说明，不是执行时动态引用）与
 * docs/p03-1-task-strategy-selection.md（本模块契约文档；含回退优先级的张力记录
 * 与请求核对）。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件系统/网络/环境，不解析凭据引用，不创建 Task、不写快照；
 * - 复用既有校验，不另立第二套：来源 payload 经 mergeEffectiveSettings 重新以
 *   schemaVersion=2 校验（未知键、不完整条目、秘密正文字段、非法引用一律拒绝），
 *   userOverride 与副本语义经 settings-schema 的完整条目校验 validateRuntimeStrategy；
 * - P03-3 / F-001 起，副本可选携带代码尝试上限 maxCodeAttempts（配置了
 *   policies.executionLimits.maxCodeAttempts 即捕获进快照；未配置不注入字段，
 *   使用时按 ports/execution-budget 缺省解析含首次共三次）。政策解析与策略条目
 *   来源正交（userOverride 路径同样从有效配置捕获）；快照不可变，后续默认配置
 *   变化不追溯改写既有副本，也不改写已保存 Task 的 execution_config；
 * - 选择整体条目，绝不跨来源拼接 runtime/provider/model；输出为全新独立副本
 *   （调用方输入对象后续变化不改变已生成副本；重复调用不共享引用）；
 * - 覆盖优先级：明确完整用户覆盖 userOverride > modelMap.<复杂度> > defaultStrategy
 *   （复杂度缺省或无对应条目回退 defaultStrategy）；无匹配（no_strategy_match）
 *   明确拒绝，不猜复杂度、不猜模型；
 * - 来源（configSource/configSourceKey）仅作解释字符串，不是运行时动态路由；
 * - 合法 ≠ 可执行：本模块只产结构合法的完整策略副本，不声明可执行
 *   （assessSettingsConfiguration 在执行能力未装配时恒 executable:false）。
 *
 * 本模块不实现（见契约文档范围边界）：Task 策略编辑、重新应用默认、凭据解析、
 * Attempt 快照，以及 agentOverrides / purposeStrategies（planner/judge/review）
 * 参与的用途选择（需要 Agent/用途身份，另行定案）。
 */
import { mergeEffectiveSettings } from './effective-settings.js';
import type { EffectiveStrategyEntry } from './effective-settings.js';
import {
  SETTINGS_SCHEMA_VERSION,
  TOOL_TIMEOUT_MS_MAX,
  TOOL_TIMEOUT_MS_MIN,
  WORK_TIMEOUT_MS_MAX,
  WORK_TIMEOUT_MS_MIN,
  validateRuntimeStrategy,
} from '../ports/settings-schema.js';
import type { ModelComplexity, RuntimeStrategyV1 } from '../ports/settings-schema.js';
import { TASK_MAX_CODE_ATTEMPTS_MAX, TASK_MAX_CODE_ATTEMPTS_MIN } from '../ports/execution-budget.js';
import { TASK_COMPLEXITY_VALUES } from '../ports/plan-store.js';
import { StorageError } from '../ports/errors.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 选择操作名（结构化错误的 operation；纯函数仍保持操作身份一致）。 */
export const TASK_STRATEGY_SELECTION_OPERATION = 'TaskStrategySelection.select';

/**
 * Task 策略来源词汇（F-003 定案，与 tasks.config_source 注释同源）：
 * project_default（项目当前配置条目）/ global_default（全局默认条目）/
 * user_override（创建时明确完整的用户覆盖）。
 */
export const TASK_STRATEGY_CONFIG_SOURCES = ['project_default', 'global_default', 'user_override'] as const;
export type TaskStrategyConfigSource = (typeof TASK_STRATEGY_CONFIG_SOURCES)[number];

/** user_override 来源的 sourceKey（来源键路径：选择输入的 userOverride 键）。 */
export const TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY = 'userOverride';

/**
 * tasks.execution_config 的完整策略独立副本：schemaVersion=2 标记 + 完整条目
 * 扁平副本（core-design/11 §3.1 的执行配置字段子集；推理参数/环境参数在当前
 * schemaVersion=2 策略条目中未定义，不在副本中编造）。
 *
 * P03-3 / F-001 起可选携带 maxCodeAttempts（代码尝试上限，含首次）：创建时从
 * 当前有效配置捕获（旧快照无此字段仍有效，使用时按缺省含首次共三次解析；
 * 显式调整复用 task.strategy.update 整体替换 CAS 通道，不另建配置体系）。
 */
export interface TaskExecutionConfigV1 {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialRef?: string;
  readonly endpointRef?: string;
  readonly maxCodeAttempts?: number;
  /** P03-9 / F-004：Session/单次 Work 总时长上限（创建时从政策副本冻结）。 */
  readonly workTimeoutMs?: number;
  /** P03-9 / F-004：单工具调用上限（创建时从政策副本冻结）。 */
  readonly toolTimeoutMs?: number;
}

/** 一次纯选择的结果：完整策略独立副本 + 来源说明（仅解释用途）。 */
export interface TaskStrategySelection {
  readonly executionConfig: TaskExecutionConfigV1;
  readonly configSource: TaskStrategyConfigSource;
  readonly configSourceKey: string;
}

const SELECT_TASK_STRATEGY_KEYS = ['global', 'project', 'complexity', 'userOverride'] as const;
const TASK_EXECUTION_CONFIG_KEYS = [
  'schemaVersion',
  'runtime',
  'provider',
  'model',
  'credentialRef',
  'endpointRef',
  'maxCodeAttempts',
  'workTimeoutMs',
  'toolTimeoutMs',
] as const;

/** P03-9 / F-004：从有效政策捕获的冻结时间上限（未配置不注入字段）。 */
interface CapturedTimeLimits {
  readonly workTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

/** 由完整策略条目构造全新独立副本（不与任何输入共享引用；可选携带政策副本）。 */
function copyExecutionConfig(
  strategy: RuntimeStrategyV1,
  maxCodeAttempts?: number,
  timeLimits: CapturedTimeLimits = {},
): TaskExecutionConfigV1 {
  const copy: {
    schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
    runtime: string;
    provider: string;
    model: string;
    credentialRef?: string;
    endpointRef?: string;
    maxCodeAttempts?: number;
    workTimeoutMs?: number;
    toolTimeoutMs?: number;
  } = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    runtime: strategy.runtime,
    provider: strategy.provider,
    model: strategy.model,
  };
  if (strategy.credentialRef !== undefined) {
    copy.credentialRef = strategy.credentialRef;
  }
  if (strategy.endpointRef !== undefined) {
    copy.endpointRef = strategy.endpointRef;
  }
  if (maxCodeAttempts !== undefined) {
    copy.maxCodeAttempts = maxCodeAttempts;
  }
  if (timeLimits.workTimeoutMs !== undefined) {
    copy.workTimeoutMs = timeLimits.workTimeoutMs;
  }
  if (timeLimits.toolTimeoutMs !== undefined) {
    copy.toolTimeoutMs = timeLimits.toolTimeoutMs;
  }
  return copy;
}

/** 把有效配置中的整体条目转为选择结果（副本 + 既有来源说明；可选携带政策）。 */
function selectionFromEntry(
  entry: EffectiveStrategyEntry,
  maxCodeAttempts?: number,
  timeLimits: CapturedTimeLimits = {},
): TaskStrategySelection {
  return {
    executionConfig: copyExecutionConfig(entry.strategy, maxCodeAttempts, timeLimits),
    configSource: entry.source.kind,
    configSourceKey: entry.source.sourceKey,
  };
}

/**
 * 创建 Task 时按已确认复杂度/defaultStrategy 解析契约选择整体条目并复制完整策略
 * 与来源（纯函数；输入边界为 unknown）。
 *
 * 输入键（未知键拒绝）：
 * - `global` / `project`：与 mergeEffectiveSettings 相同的来源 scope 输入
 *   （{ scopeRevision, payload }，可缺省/null）；payload 重新经 schemaVersion=2
 *   校验，无效来源不被静默忽略或降级；
 * - `complexity`：Task 已确认复杂度（low/medium/high；缺省/null 表示未确认）；
 *   非法取值拒绝；
 * - `userOverride`：明确完整的用户覆盖（完整策略条目；缺任一必需策略字段、
 *   未知字段、秘密正文字段、非法引用一律拒绝，不从默认条目拼补）。null 不是
 *   「未提供」（无 null=清除语义），同样拒绝。
 *
 * 覆盖优先级：userOverride > modelMap.<complexity> > defaultStrategy；无任何命中
 * 即 no_strategy_match 拒绝（不猜复杂度、不注入任何默认厂商/模型）。
 */
export function selectTaskStrategy(input: unknown): TaskStrategySelection {
  const context: ValidationContext = {
    operation: TASK_STRATEGY_SELECTION_OPERATION,
    entity: { type: 'task' },
  };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, SELECT_TASK_STRATEGY_KEYS, context, 'input');

  let complexity: ModelComplexity | null = null;
  const complexityValue = object.complexity;
  if (complexityValue !== undefined && complexityValue !== null) {
    if (
      typeof complexityValue !== 'string' ||
      !TASK_COMPLEXITY_VALUES.includes(complexityValue as ModelComplexity)
    ) {
      throw validationError(
        context,
        'complexity',
        `必须是 ${TASK_COMPLEXITY_VALUES.join(' / ')} 或 null/省略（复用配置复杂度取值）`,
        complexityValue,
      );
    }
    complexity = complexityValue as ModelComplexity;
  }

  // 0) 有效政策解析（与策略条目来源正交）：配置了 maxCodeAttempts 即捕获进副本；
  //    未配置不注入字段（使用时按 ports/execution-budget 缺省解析含首次共三次）。
  //    userOverride 路径同样解析（来源非法仍 fail-closed 拒绝，不因覆盖而忽略）。
  const effective = mergeEffectiveSettings({ global: object.global, project: object.project });
  const maxCodeAttempts = effective.policies.executionLimits?.value.maxCodeAttempts;
  const timeLimits: CapturedTimeLimits = {
    ...(effective.policies.executionLimits?.value.workTimeoutMs === undefined
      ? {}
      : { workTimeoutMs: effective.policies.executionLimits.value.workTimeoutMs }),
    ...(effective.policies.executionLimits?.value.toolTimeoutMs === undefined
      ? {}
      : { toolTimeoutMs: effective.policies.executionLimits.value.toolTimeoutMs }),
  };

  // 1) 明确完整用户覆盖：优先于全部默认解析；不完整/未知键/秘密正文/非法引用在
  //    条目校验阶段明确拒绝，不回退、不从默认条目拼补。
  if (object.userOverride !== undefined) {
    const strategy = validateRuntimeStrategy(object.userOverride, context, 'userOverride');
    return {
      executionConfig: copyExecutionConfig(strategy, maxCodeAttempts, timeLimits),
      configSource: 'user_override',
      configSourceKey: TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY,
    };
  }

  // 2/3) 有效配置解析（复用 mergeEffectiveSettings：来源重新经 schemaVersion=2 校验，
  //      完整条目整体替换已在合并层保证不跨来源拼接）。
  if (complexity !== null) {
    const complexityEntry = effective.strategies.modelMap[complexity];
    if (complexityEntry !== undefined) {
      return selectionFromEntry(complexityEntry, maxCodeAttempts, timeLimits);
    }
  }
  const fallback = effective.strategies.defaultStrategy;
  if (fallback !== undefined) {
    return selectionFromEntry(fallback, maxCodeAttempts, timeLimits);
  }

  // 4) 无匹配的已确认默认：明确的配置错误，不猜复杂度、不猜模型。
  throw new StorageError(
    'validation',
    TASK_STRATEGY_SELECTION_OPERATION,
    `${TASK_STRATEGY_SELECTION_OPERATION}: 无匹配的已确认默认策略` +
      `（复杂度 ${complexity === null ? '未确认' : complexity} 无 modelMap 条目且无 defaultStrategy；` +
      '不注入任何默认厂商/模型）',
    {
      entity: context.entity,
      details: { field: 'strategies', reason: 'no_strategy_match' },
    },
  );
}

/**
 * tasks.execution_config 副本形态的完整语义校验（F-003 定案）：schemaVersion=2
 * 标记 + 完整条目字段。复用 settings-schema 的完整条目校验（缺任一必需策略字段、
 * 未知字段、秘密正文字段、非法引用一律拒绝）；返回规范化新对象。
 * P03-3 / F-001 起 maxCodeAttempts 为可选字段（旧快照无该字段仍有效）；
 * 提供时必须是 1..100 的整数（与 settings/execution-budget 契约同源）。
 */
export function validateTaskExecutionConfig(value: unknown, operation: string): TaskExecutionConfigV1 {
  const context: ValidationContext = { operation, entity: { type: 'task' } };
  const object = requirePlainObject(value, context, 'executionConfig');
  rejectUnknownKeys(object, TASK_EXECUTION_CONFIG_KEYS, context, 'executionConfig');
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw validationError(
      context,
      'executionConfig.schemaVersion',
      `必须是 ${SETTINGS_SCHEMA_VERSION}（schemaVersion=2 标记的完整策略副本）`,
      object.schemaVersion,
    );
  }
  const entry: Record<string, unknown> = {
    runtime: object.runtime,
    provider: object.provider,
    model: object.model,
  };
  if (object.credentialRef !== undefined) {
    entry.credentialRef = object.credentialRef;
  }
  if (object.endpointRef !== undefined) {
    entry.endpointRef = object.endpointRef;
  }
  let maxCodeAttempts: number | undefined;
  if (object.maxCodeAttempts !== undefined) {
    if (
      typeof object.maxCodeAttempts !== 'number' ||
      !Number.isInteger(object.maxCodeAttempts) ||
      object.maxCodeAttempts < TASK_MAX_CODE_ATTEMPTS_MIN ||
      object.maxCodeAttempts > TASK_MAX_CODE_ATTEMPTS_MAX
    ) {
      throw validationError(
        context,
        'executionConfig.maxCodeAttempts',
        `必须是 ${TASK_MAX_CODE_ATTEMPTS_MIN}..${TASK_MAX_CODE_ATTEMPTS_MAX} 的整数（代码尝试上限，含首次）`,
        object.maxCodeAttempts,
      );
    }
    maxCodeAttempts = object.maxCodeAttempts;
  }
  const timeLimits: {
    workTimeoutMs?: number;
    toolTimeoutMs?: number;
  } = {};
  if (object.workTimeoutMs !== undefined) {
    if (
      typeof object.workTimeoutMs !== 'number' ||
      !Number.isInteger(object.workTimeoutMs) ||
      object.workTimeoutMs < WORK_TIMEOUT_MS_MIN ||
      object.workTimeoutMs > WORK_TIMEOUT_MS_MAX
    ) {
      throw validationError(
        context,
        'executionConfig.workTimeoutMs',
        `必须是 ${WORK_TIMEOUT_MS_MIN}..${WORK_TIMEOUT_MS_MAX} 的整数（Session 总时长上限）`,
        object.workTimeoutMs,
      );
    }
    timeLimits.workTimeoutMs = object.workTimeoutMs;
  }
  if (object.toolTimeoutMs !== undefined) {
    if (
      typeof object.toolTimeoutMs !== 'number' ||
      !Number.isInteger(object.toolTimeoutMs) ||
      object.toolTimeoutMs < TOOL_TIMEOUT_MS_MIN ||
      object.toolTimeoutMs > TOOL_TIMEOUT_MS_MAX
    ) {
      throw validationError(
        context,
        'executionConfig.toolTimeoutMs',
        `必须是 ${TOOL_TIMEOUT_MS_MIN}..${TOOL_TIMEOUT_MS_MAX} 的整数（单工具上限）`,
        object.toolTimeoutMs,
      );
    }
    timeLimits.toolTimeoutMs = object.toolTimeoutMs;
  }
  return copyExecutionConfig(validateRuntimeStrategy(entry, context, 'executionConfig'), maxCodeAttempts, timeLimits);
}
