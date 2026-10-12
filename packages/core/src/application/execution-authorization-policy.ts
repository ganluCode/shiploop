/**
 * P03-3 / F-001 执行授权并发政策（application 层纯函数）。
 *
 * 设计依据：core-design/04 §6.1（首版执行控制为全局单并发；并发 Work 上限是
 * 配置中的**政策**，不代表当前执行能力）与 P03-3 边界（本阶段只实现单 Feature
 * 单并发闭环）。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件/网络，不创建执行实体；
 * - 「保存政策 ≠ 执行支持」：配置面允许保存 maxConcurrentWorks ∈ [1,16]
 *   （settings-schema 契约），但执行授权对**有效并发大于一**一律明确拒绝
 *   （concurrency_not_supported），不静默降级为串行、不悄悄放行；
 * - 有效并发解析：项目 executionLimits 段（整段覆盖）> 全局段；两段均未配置时
 *   为缺省单并发（1）；
 * - 输入为 mergeEffectiveSettings 产出的有效政策集合形态（结构校验 fail-closed，
 *   非法输入拒绝，不默认为单并发放行）。
 *
 * 本模块不实现：预算校验（ports/execution-budget）、预览/启动命令（F-004/F-005）、
 * Runtime 装配与调度。
 */
import { StorageError } from '../ports/errors.js';
import { isPlainObject } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 并发授权操作名（结构化错误 operation；纯函数保持操作身份一致）。 */
export const EXECUTION_AUTHORIZATION_POLICY_OPERATION = 'ExecutionAuthorizationPolicy.concurrency';

/** 有效并发缺省：首版全局单并发（未配置并发政策时即单并发）。 */
export const EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT = 1;

/** 有效并发来源：项目段 / 全局段 / 缺省。 */
export type EffectiveConcurrencySource = 'project_default' | 'global_default' | 'default';

export interface EffectiveConcurrency {
  readonly maxConcurrentWorks: number;
  readonly source: EffectiveConcurrencySource;
}

function concurrencyError(field: string, reason: string, message: string): StorageError {
  return new StorageError(
    'validation',
    EXECUTION_AUTHORIZATION_POLICY_OPERATION,
    `${EXECUTION_AUTHORIZATION_POLICY_OPERATION}: ${field} ${message}`,
    { details: { field, reason } },
  );
}

/** 读取有效政策集合中的 executionLimits.maxConcurrentWorks（缺省 1；结构非法拒绝）。 */
function readConfiguredMaxConcurrentWorks(policies: unknown): {
  value: number | undefined;
  sourceKind: 'project_default' | 'global_default';
} {
  if (!isPlainObject(policies)) {
    throw concurrencyError('policies', 'invalid_type', '必须是有效政策集合对象（mergeEffectiveSettings.policies）');
  }
  if (policies.executionLimits === undefined) {
    return { value: undefined, sourceKind: 'global_default' };
  }
  const section = policies.executionLimits;
  if (!isPlainObject(section)) {
    throw concurrencyError('policies.executionLimits', 'invalid_type', '必须是政策段对象');
  }
  if (!isPlainObject(section.source) || typeof section.source.kind !== 'string') {
    throw concurrencyError('policies.executionLimits.source', 'invalid_type', '必须是段来源说明对象');
  }
  if (section.source.kind !== 'project_default' && section.source.kind !== 'global_default') {
    throw concurrencyError('policies.executionLimits.source.kind', 'invalid_type', "必须是 'project_default' 或 'global_default'");
  }
  if (!isPlainObject(section.value)) {
    throw concurrencyError('policies.executionLimits.value', 'invalid_type', '必须是政策段值对象');
  }
  const raw = section.value.maxConcurrentWorks;
  if (raw === undefined) {
    return { value: undefined, sourceKind: section.source.kind };
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > 16
  ) {
    throw concurrencyError(
      'policies.executionLimits.value.maxConcurrentWorks',
      'out_of_range',
      '必须是 1..16 的整数（配置契约范围；非法有效值不被默认放行）',
    );
  }
  return { value: raw, sourceKind: section.source.kind };
}

/**
 * 解析有效并发（纯函数）：项目段 > 全局段 > 缺省单并发。
 * 输入为 mergeEffectiveSettings 的 policies 结果形态（结构非法拒绝）。
 */
export function resolveEffectiveMaxConcurrentWorks(policies: unknown): EffectiveConcurrency {
  const configured = readConfiguredMaxConcurrentWorks(policies);
  if (configured.value === undefined) {
    return { maxConcurrentWorks: EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT, source: 'default' };
  }
  return { maxConcurrentWorks: configured.value, source: configured.sourceKind };
}

/**
 * 执行授权单并发断言（纯函数）：有效并发大于一即明确拒绝
 * （concurrency_not_supported）。保存的并发政策不等于执行支持——配置面允许
 * 保存较高并发政策，但本阶段执行授权只放行单并发。
 */
export function assertSingleWorkConcurrencyAuthorization(
  policies: unknown,
  context?: ValidationContext,
): void {
  const effective = resolveEffectiveMaxConcurrentWorks(policies);
  if (effective.maxConcurrentWorks > EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT) {
    throw new StorageError(
      'validation',
      context?.operation ?? EXECUTION_AUTHORIZATION_POLICY_OPERATION,
      `${EXECUTION_AUTHORIZATION_POLICY_OPERATION}: 有效并发 ${effective.maxConcurrentWorks}（来源 ${effective.source}）超过本阶段执行支持` +
        '（首版仅支持单并发；配置允许保存的并发政策不等于执行支持）',
      {
        entity: context?.entity,
        details: {
          field: 'policies.executionLimits.value.maxConcurrentWorks',
          reason: 'concurrency_not_supported',
          effectiveMaxConcurrentWorks: effective.maxConcurrentWorks,
          source: effective.source,
        },
      },
    );
  }
}
