/**
 * P03-3 / F-001 执行授权并发政策（application 层纯函数）。
 *
 * 设计依据：core-design/04 §6.1（执行控制由批准的 Batch 并发快照驱动）与 P05-4
 * 派发边界。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件/网络，不创建执行实体；
 * - 有效并发解析为 1..16 的有界整数；默认单并发，批准的大于一并发交给
 *   持久槽位和 Task 原子认领执行；
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

/** 执行授权支持断言：有效并发已在解析阶段限制为 1..16 的有界整数。 */
export function assertSingleWorkConcurrencyAuthorization(
  policies: unknown,
  _context?: ValidationContext,
): void {
  resolveEffectiveMaxConcurrentWorks(policies);
}
