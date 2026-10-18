/**
 * F-004 可信测试装配 principal 工厂（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md §4.1/§4.2：
 * - 生产只有固定本机主体 `local-owner`（全部九项能力、projectScope=all），
 *   绑定发生在 Host 可信装配/传输层；
 * - 受限主体 `test-restricted:<uuid-v4>` **只能由可信测试装配显式构造**，
 *   产品代码不存在经网络/argv/env/请求体创建或提权主体的入口（该不变量由
 *   test/modules/commands/p02-2-fixture-kit.test.ts 的源码扫描固定）；
 * - 请求信封/查询中的 actorId/principal/principalId/capabilities/scope
 *   提权字段在 F-002 已按未知键拒绝；本模块只产出结构，绝不读取任何请求数据。
 *
 * 本模块的 TestTrustedPrincipal 与契约 §4.2 的 TrustedPrincipal 结构逐字段
 * 一致；F-005 在 ports 层落定产品类型后，两者必须保持结构兼容（可直接赋值）。
 */
import { randomUUID } from 'node:crypto';
import {
  APP_CAPABILITIES,
  LOCAL_OWNER_CAPABILITIES,
  LOCAL_OWNER_PRINCIPAL_ID,
  isUuidV4,
  type AppCapability,
} from '../../../packages/core/src/ports/commands.ts';

/** 受限主体 id 前缀（冻结字面量；产品源码不得出现，见契约 §4.1）。 */
export const TEST_RESTRICTED_PRINCIPAL_PREFIX = 'test-restricted:';

export type TestPrincipalScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'allowlist'; readonly projectIds: readonly string[] };

export interface TestTrustedPrincipal {
  readonly principalId: string;
  readonly capabilities: ReadonlySet<AppCapability>;
  readonly projectScope: TestPrincipalScope;
}

function freezeScope(scope: TestPrincipalScope): TestPrincipalScope {
  if (scope.kind === 'all') {
    return Object.freeze({ kind: 'all' }) as TestPrincipalScope;
  }
  if (!Array.isArray(scope.projectIds)) {
    throw new TypeError('projectScope.allowlist: projectIds 必须是数组');
  }
  if (scope.projectIds.length === 0) {
    throw new TypeError('projectScope.allowlist: projectIds 不允许为空（显式构造可见范围）');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const projectId of scope.projectIds) {
    if (!isUuidV4(projectId)) {
      throw new TypeError(`projectScope.allowlist: projectId 必须是 UUID v4，实际类型 ${typeof projectId}`);
    }
    if (seen.has(projectId)) {
      throw new TypeError(`projectScope.allowlist: projectId 重复：${projectId}`);
    }
    seen.add(projectId);
    normalized.push(projectId);
  }
  return Object.freeze({
    kind: 'allowlist',
    projectIds: Object.freeze(normalized),
  }) as TestPrincipalScope;
}

/**
 * 把能力集包装成真正只读：Object.freeze 对 Set 无效（add 改的是内部槽），
 * 因此用 Proxy 拒绝 add/delete/clear；读取（has/size/迭代）原样委托。
 */
function freezeCapabilitySet(
  capabilities: ReadonlySet<AppCapability>,
): ReadonlySet<AppCapability> {
  const deny = (): never => {
    throw new TypeError('principal.capabilities 是冻结只读集合');
  };
  return new Proxy(capabilities as Set<AppCapability>, {
    get(target, property) {
      if (property === 'add' || property === 'delete' || property === 'clear') {
        return deny;
      }
      // 直接从 target 取值并绑定：Set.prototype.size 与迭代器依赖内部槽，
      // 不能把 Proxy 自身作为 receiver 传入（会抛 incompatible receiver）。
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** local-owner 固定主体（每次返回同一冻结能力集；scope 为新冻结对象）。 */
export function createLocalOwnerPrincipal(): TestTrustedPrincipal {
  return Object.freeze({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    capabilities: freezeCapabilitySet(LOCAL_OWNER_CAPABILITIES),
    projectScope: Object.freeze({ kind: 'all' }) as TestPrincipalScope,
  });
}

export function isTestRestrictedPrincipalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(TEST_RESTRICTED_PRINCIPAL_PREFIX) &&
    isUuidV4(value.slice(TEST_RESTRICTED_PRINCIPAL_PREFIX.length))
  );
}

export interface CreateRestrictedPrincipalOptions {
  /** 显式能力组合；必须全部来自九项冻结能力，不允许重复，不提供产品默认模板。 */
  readonly capabilities: readonly AppCapability[];
  /** 可见范围：all 或非空 UUID v4 允许列表。 */
  readonly projectScope: TestPrincipalScope;
  /** 默认 test-restricted:<randomUUID()>；显式提供时必须同形态。 */
  readonly principalId?: string;
}

/**
 * 构造受限主体（仅可信测试装配调用）：
 * - 能力逐项核验属于 APP_CAPABILITIES，重复/未知一律抛出（不静默收窄）；
 * - 允许列表项目经 UUID v4 校验、去重校验后冻结；主体对象整体冻结。
 */
export function createRestrictedPrincipal(
  options: CreateRestrictedPrincipalOptions,
): TestTrustedPrincipal {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createRestrictedPrincipal: options 必须是对象');
  }
  if (!Array.isArray(options.capabilities)) {
    throw new TypeError('createRestrictedPrincipal: capabilities 必须是数组');
  }
  const knownCapabilities: ReadonlySet<string> = new Set<string>(APP_CAPABILITIES);
  const capabilities = new Set<AppCapability>();
  for (const rawCapability of options.capabilities) {
    if (typeof rawCapability !== 'string' || !knownCapabilities.has(rawCapability)) {
      throw new TypeError(`createRestrictedPrincipal: 未知能力 ${String(rawCapability)}`);
    }
    const capability = rawCapability as AppCapability;
    if (capabilities.has(capability)) {
      throw new TypeError(`createRestrictedPrincipal: 能力重复：${capability}`);
    }
    capabilities.add(capability);
  }

  let principalId: string;
  if (options.principalId === undefined) {
    principalId = `${TEST_RESTRICTED_PRINCIPAL_PREFIX}${randomUUID()}`;
  } else {
    if (!isTestRestrictedPrincipalId(options.principalId)) {
      throw new TypeError(
        `createRestrictedPrincipal: principalId 必须是 ${TEST_RESTRICTED_PRINCIPAL_PREFIX}<uuid-v4>`,
      );
    }
    principalId = options.principalId;
  }

  if (options.projectScope === null || typeof options.projectScope !== 'object') {
    throw new TypeError('createRestrictedPrincipal: projectScope 必须是对象');
  }
  const projectScope = freezeScope(options.projectScope);

  return Object.freeze({
    principalId,
    capabilities: freezeCapabilitySet(capabilities),
    projectScope,
  });
}

export function scopeAll(): TestPrincipalScope {
  return Object.freeze({ kind: 'all' }) as TestPrincipalScope;
}

export function scopeAllowlist(projectIds: readonly string[]): TestPrincipalScope {
  return freezeScope({ kind: 'allowlist', projectIds });
}
