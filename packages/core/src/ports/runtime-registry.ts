/**
 * P03-6 / F-001 Runtime 适配器可信静态注册（ports 契约层：描述符校验与
 * 注册表工厂，无任何 I/O）。
 *
 * 设计依据：core-design/05（稳定 runtime ID 与组合根显式装配，重复/未注册 ID
 * 明确报错，不静默回退，不默认 Claude/Pi，不热加载模块）与
 * input/p03-fake-runtime.md FR-1（契约为 ShipLoop 自定义；稳定 runtime ID
 * 静态解析）。
 *
 * 契约要点：
 * - RuntimeAdapterDescriptor 声明适配器契约版本、provider/model 面、可落实的
 *   权限授予与隔离模式；契约版本不等于 RUNTIME_ADAPTER_CONTRACT_VERSION 一律
 *   拒绝（contract_version_incompatible），不静默兼容；
 * - createStaticRuntimeRegistry 以可信装配注入的 { descriptor, adapter } 数组
 *   构建内存注册表：adapter 必须是带 start 函数的注入对象——字符串/模块路径
 *   一律拒绝（adapter_must_be_injected），不从项目脚本或任意模块说明符加载；
 * - 描述符必须与既有 RuntimeCapabilityCatalog（配置兼容性目录）一致：重复或
 *   目录未知的 runtimeId、provider/model 面不一致（provider_mismatch）都拒绝；
 *   配置目录仍是独立构件，注册不修改它；
 * - 注册失败抛 StorageError(kind='validation') 并带 details.field/reason，
 *   发生在任何适配器调用之前。
 */
import type { ProviderCapabilityDescriptor, RuntimeCapabilityCatalog } from './runtime-capabilities.js';
import { stableStringify } from './feature-plan.js';
import type { RuntimeAdapter } from './runtime-execution.js';
import { requireNonEmptyString, rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/** 适配器契约版本：句柄/事件/结果/停止证据协议代次，严格相等才兼容。 */
export const RUNTIME_ADAPTER_CONTRACT_VERSION = 1;

/** 适配器描述符：稳定 ID、契约版本与实际可落实的 provider/权限/隔离面。 */
export interface RuntimeAdapterDescriptor {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly contractVersion: typeof RUNTIME_ADAPTER_CONTRACT_VERSION;
  readonly adapterVersion: string;
  /** 适配器所绑定的外部 SDK 版本；无外部 SDK 时省略。 */
  readonly sdkVersion?: string;
  readonly providers: readonly ProviderCapabilityDescriptor[];
  readonly permissionGrants: readonly string[];
  readonly isolationModes: readonly string[];
}

export interface RuntimeRegistryEntry {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly adapter: RuntimeAdapter;
}

export interface RuntimeRegistry {
  resolve(runtimeId: string): RuntimeRegistryEntry | undefined;
}

const context: ValidationContext = { operation: 'RuntimeRegistry.create' };

function descriptorError(field: string, reason: string): never {
  throw validationError(context, field, reason);
}

function tokenArray(value: unknown, field: string, duplicateReason: string): string[] {
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是字符串数组');
  }
  const tokens = value.map((entry, index) => validateStableId(entry, context, `${field}[${index}]`));
  if (new Set(tokens).size !== tokens.length) {
    descriptorError(field, duplicateReason);
  }
  return tokens;
}

function providerDescriptors(value: unknown, field: string): ProviderCapabilityDescriptor[] {
  if (!Array.isArray(value)) throw validationError(context, field, '必须是 provider 能力描述数组');
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const raw = requirePlainObject(item, context, itemField);
    rejectUnknownKeys(raw, ['providerId', 'models'], context, itemField);
    const providerId = requireNonEmptyString(raw.providerId, context, `${itemField}.providerId`);
    if (raw.models === undefined) return { providerId };
    if (!Array.isArray(raw.models) ||
        raw.models.some((model) => typeof model !== 'string' || model.trim().length === 0)) {
      throw validationError(context, `${itemField}.models`, '必须是非空字符串数组（模型标识）');
    }
    return { providerId, models: [...raw.models] };
  });
}

export function validateRuntimeAdapterDescriptor(value: unknown): RuntimeAdapterDescriptor {
  const field = 'descriptor';
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, [
    'schemaVersion', 'runtimeId', 'contractVersion', 'adapterVersion', 'sdkVersion',
    'providers', 'permissionGrants', 'isolationModes',
  ], context, field);
  if (raw.schemaVersion !== 1) {
    descriptorError(`${field}.schemaVersion`, 'unsupported_schema_version');
  }
  if (raw.contractVersion !== RUNTIME_ADAPTER_CONTRACT_VERSION) {
    descriptorError(`${field}.contractVersion`, 'contract_version_incompatible');
  }
  return {
    schemaVersion: 1,
    runtimeId: validateStableId(raw.runtimeId, context, `${field}.runtimeId`),
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterVersion: requireNonEmptyString(raw.adapterVersion, context, `${field}.adapterVersion`),
    ...(raw.sdkVersion === undefined
      ? {}
      : { sdkVersion: requireNonEmptyString(raw.sdkVersion, context, `${field}.sdkVersion`) }),
    providers: providerDescriptors(raw.providers, `${field}.providers`),
    permissionGrants: tokenArray(raw.permissionGrants, `${field}.permissionGrants`, 'duplicate_permission_grant'),
    isolationModes: tokenArray(raw.isolationModes, `${field}.isolationModes`, 'duplicate_isolation_mode'),
  };
}

/** provider 面的规范化比较（顺序无关）：catalog 与适配器描述必须完全一致。 */
function normalizedProviders(providers: readonly ProviderCapabilityDescriptor[]): string {
  const normalized = providers
    .map((provider) => ({
      providerId: provider.providerId,
      models: provider.models === undefined ? null : [...provider.models].sort(),
    }))
    .sort((left, right) => (left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0));
  return stableStringify(normalized);
}

/**
 * 从可信装配注入的条目数组构建静态注册表。无任何模块加载/文件读取：
 * adapter 必须是注入对象；重复/未知 runtimeId、契约版本不兼容、
 * provider/model 与配置目录不一致一律拒绝。
 */
export function createStaticRuntimeRegistry(
  entries: unknown,
  configuration: RuntimeCapabilityCatalog,
): RuntimeRegistry {
  if (!Array.isArray(entries)) throw validationError(context, 'entries', '必须是注册条目数组');
  const registered = new Map<string, RuntimeRegistryEntry>();
  for (const [index, item] of entries.entries()) {
    const field = `entries[${index}]`;
    const raw = requirePlainObject(item, context, field);
    rejectUnknownKeys(raw, ['descriptor', 'adapter'], context, field);
    const descriptor = validateRuntimeAdapterDescriptor(raw.descriptor);
    const adapter = raw.adapter;
    if (typeof adapter !== 'object' || adapter === null ||
        typeof (adapter as RuntimeAdapter).start !== 'function') {
      descriptorError(`${field}.adapter`, 'adapter_must_be_injected');
    }
    if (registered.has(descriptor.runtimeId)) {
      descriptorError(`${field}.descriptor.runtimeId`, 'duplicate_runtime_id');
    }
    const catalog = configuration.resolve(descriptor.runtimeId);
    if (catalog === undefined) {
      descriptorError(`${field}.descriptor.runtimeId`, 'unknown_runtime');
    }
    if (normalizedProviders(catalog.providers) !== normalizedProviders(descriptor.providers)) {
      descriptorError(`${field}.descriptor.providers`, 'provider_mismatch');
    }
    if (catalog.contractVersion !== undefined && catalog.contractVersion !== descriptor.contractVersion) {
      descriptorError(`${field}.descriptor.contractVersion`, 'contract_version_mismatch');
    }
    for (const [key, reason] of [['permissionGrants', 'permission_grants_mismatch'], ['isolationModes', 'isolation_modes_mismatch']] as const) {
      if (catalog[key] !== undefined && stableStringify([...catalog[key]].sort()) !== stableStringify([...descriptor[key]].sort())) {
        descriptorError(`${field}.descriptor.${key}`, reason);
      }
    }
    registered.set(descriptor.runtimeId, { descriptor, adapter: adapter as RuntimeAdapter });
  }
  return {
    resolve(runtimeId: string): RuntimeRegistryEntry | undefined {
      return registered.get(runtimeId);
    },
  };
}
