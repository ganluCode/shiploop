/**
 * F-008 Runtime 能力兼容性校验：可信装配注入的窄能力描述（ports 契约层，纯函数，无 I/O）。
 *
 * 设计依据：core-design/05（Host 可信装配入口接受外部 RuntimeAdapter 及稳定
 * runtime ID；重复 ID、未注册 ID 明确报错，不静默回退）与
 * docs/p01-3-application-contract.md §5.1（配置合法性 ≠ 执行能力可用性）。
 *
 * 不变量：
 * - 兼容性判断**只**依赖组合根注入的只读能力目录：不存在封闭厂商枚举、
 *   不查询网络模型清单、不导入 Pi SDK、不建设 Runtime 热加载平台；
 * - 未知 runtime、runtime 不支持的 provider、描述符枚举模型之外的 model
 *   一律以带字段定位的 validation 错误拒绝，不从其他策略补齐；
 * - provider 未枚举模型时 model 作不透明字符串透传（模型清单可能不可枚举，
 *   但 runtime/provider 必须已知）；
 * - 能力目录未装配任何 runtime 时 fail-closed：任何策略条目都报未知 runtime，
 *   未装配能力不被伪装为可运行；
 * - 本模块不做持久化、不读时钟/文件系统/网络；校验失败天然零副作用。
 */
import { StorageError } from './errors.js';
import { listStrategyEntries } from './settings-schema.js';
import type { SettingsPayload } from './settings-schema.js';
import { isPlainObject, requireNonEmptyString, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/** 单个 provider 的窄能力描述。 */
export interface ProviderCapabilityDescriptor {
  readonly providerId: string;
  /**
   * 装配侧已确认的模型标识列表；省略或空数组表示**不枚举模型**
   * （model 仅作不透明字符串透传，兼容性只核验 runtime/provider）。
   */
  readonly models?: readonly string[];
}

/** 单个 runtime 的窄能力描述（稳定 runtime ID + 其支持的 provider 列表）。 */
export interface RuntimeCapabilityDescriptor {
  readonly runtimeId: string;
  readonly providers: readonly ProviderCapabilityDescriptor[];
}

/**
 * 可信装配在组合根注入的只读能力目录：按稳定 runtime ID 解析窄能力描述。
 * 实现为内存静态表；不查询网络、不导入 Pi SDK、不热加载。
 */
export interface RuntimeCapabilityCatalog {
  resolve(runtimeId: string): RuntimeCapabilityDescriptor | undefined;
}

/** 带机器可读 reason 码的 capability 校验错误（details 只含 field/reason，不回显输入值）。 */
function capabilityError(
  context: ValidationContext,
  field: string,
  reason: string,
  message: string,
): StorageError {
  return new StorageError('validation', context.operation, `${context.operation}: ${field} ${message}`, {
    entity: context.entity,
    details: { field, reason },
  });
}

/**
 * 从可信装配提供的描述符数组构建内存能力目录（纯函数）。
 * 描述符形态非法、重复 runtimeId、同一 runtime 内重复 providerId 一律
 * validation 拒绝——不静默覆盖/回退（设计 05：重复 ID 明确报错）。
 */
export function createStaticRuntimeCapabilityCatalog(descriptors: unknown): RuntimeCapabilityCatalog {
  const context: ValidationContext = { operation: 'RuntimeCapabilityCatalog.create' };
  if (!Array.isArray(descriptors)) {
    throw validationError(context, 'descriptors', '必须是能力描述符数组', descriptors);
  }
  const runtimes = new Map<string, RuntimeCapabilityDescriptor>();
  for (const [index, item] of descriptors.entries()) {
    const field = `descriptors[${index}]`;
    if (!isPlainObject(item)) {
      throw validationError(context, field, '能力描述符必须是对象', item);
    }
    const runtimeId = requireNonEmptyString(item.runtimeId, context, `${field}.runtimeId`);
    if (runtimes.has(runtimeId)) {
      throw capabilityError(context, `${field}.runtimeId`, 'duplicate_runtime_id', `重复的能力描述 runtimeId '${runtimeId}'`);
    }
    if (!Array.isArray(item.providers)) {
      throw validationError(context, `${field}.providers`, '必须是 provider 能力描述数组', item.providers);
    }
    const providers: ProviderCapabilityDescriptor[] = [];
    const providerIds = new Set<string>();
    for (const [providerIndex, providerItem] of item.providers.entries()) {
      const providerField = `${field}.providers[${providerIndex}]`;
      if (!isPlainObject(providerItem)) {
        throw validationError(context, providerField, 'provider 能力描述必须是对象', providerItem);
      }
      const providerId = requireNonEmptyString(providerItem.providerId, context, `${providerField}.providerId`);
      if (providerIds.has(providerId)) {
        throw capabilityError(
          context,
          `${providerField}.providerId`,
          'duplicate_provider_id',
          `runtime '${runtimeId}' 内重复的 providerId '${providerId}'`,
        );
      }
      providerIds.add(providerId);
      if (providerItem.models === undefined) {
        providers.push({ providerId });
      } else {
        if (
          !Array.isArray(providerItem.models) ||
          providerItem.models.some((model) => typeof model !== 'string' || model.trim().length === 0)
        ) {
          throw validationError(
            context,
            `${providerField}.models`,
            '必须是非空字符串数组（模型标识）',
            providerItem.models,
          );
        }
        providers.push({ providerId, models: [...providerItem.models] });
      }
    }
    runtimes.set(runtimeId, { runtimeId, providers });
  }
  return {
    resolve(runtimeId: string): RuntimeCapabilityDescriptor | undefined {
      return runtimes.get(runtimeId);
    },
  };
}

/**
 * 兼容性校验（纯函数）：payload 中**每个提供的策略条目**的 runtime/provider/model
 * 必须被注入能力目录确认；任何未知/不兼容都带字段定位拒绝，不从其他策略补齐。
 * payload 无策略条目时平凡通过（未配置由 assessSettingsConfiguration 表达）。
 */
export function validateStrategyCapabilities(
  payload: SettingsPayload,
  catalog: RuntimeCapabilityCatalog,
  context: ValidationContext,
): void {
  for (const { field, strategy } of listStrategyEntries(payload.strategies)) {
    const descriptor = catalog.resolve(strategy.runtime);
    if (descriptor === undefined) {
      throw capabilityError(
        context,
        `${field}.runtime`,
        'unknown_runtime',
        `未知 runtime '${strategy.runtime}'（可信能力目录未装配该 runtime）`,
      );
    }
    const provider = descriptor.providers.find((candidate) => candidate.providerId === strategy.provider);
    if (provider === undefined) {
      throw capabilityError(
        context,
        `${field}.provider`,
        'incompatible_provider',
        `provider '${strategy.provider}' 不在 runtime '${strategy.runtime}' 的能力描述中（不兼容或未注册）`,
      );
    }
    if (provider.models !== undefined && provider.models.length > 0 && !provider.models.includes(strategy.model)) {
      throw capabilityError(
        context,
        `${field}.model`,
        'unsupported_model',
        `model '${strategy.model}' 不在 provider '${strategy.provider}' 已确认的模型列表中`,
      );
    }
  }
}

/**
 * 配置与可执行性评估（区分「配置合法性」与「执行能力可用性」）：
 * - configured：payload 是否提供了至少一个完整策略条目；
 * - executable：P01 **恒为 false**——Runner、认证与模型执行能力尚未装配，
 *   策略结构合法不代表可运行，未装配能力不得伪装为可执行。
 */
export interface SettingsConfigurationAssessment {
  readonly configured: boolean;
  readonly executable: false;
  readonly reason: 'no_strategy_configured' | 'execution_capability_not_assembled';
}

export function assessSettingsConfiguration(payload: SettingsPayload): SettingsConfigurationAssessment {
  if (listStrategyEntries(payload.strategies).length === 0) {
    return { configured: false, executable: false, reason: 'no_strategy_configured' };
  }
  return { configured: true, executable: false, reason: 'execution_capability_not_assembled' };
}
