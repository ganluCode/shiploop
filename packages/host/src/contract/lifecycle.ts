/**
 * F-002 Host 生命周期状态与能力声明（契约纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §11（状态机）、
 * §8（握手 capabilities 只描述真实支持）。
 *
 * `stopped` 不是网络状态（进程已不存在），不在线协议枚举内；
 * P02-1 生产装配的活动数恒为 0（idle-only），事件与项目命令均 unsupported。
 */
import {
  ACTIVITY_SCOPE_IDLE_ONLY,
  IDEMPOTENCY_SCHEME,
  SUPPORTED_STOP_MODES,
} from './constants.js';

/** §11 线协议生命周期状态（无 stopped）。 */
export const LIFECYCLE_STATES = ['starting', 'ready', 'quiescing', 'stopping'] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** capabilities.lifecycleRoutes 允许出现的路由名。 */
export const LIFECYCLE_ROUTE_NAMES = ['handshake', 'status', 'stop'] as const;
export type LifecycleRouteName = (typeof LIFECYCLE_ROUTE_NAMES)[number];

/** stop 能力视图（握手响应冻结形态）。 */
export interface StopCapabilityView {
  readonly modes: readonly string[];
  readonly idempotency: typeof IDEMPOTENCY_SCHEME;
  readonly activityScope: typeof ACTIVITY_SCOPE_IDLE_ONLY;
}

/** §8 握手成功响应 capabilities（深度冻结）。 */
export interface HostCapabilities {
  readonly lifecycleRoutes: readonly LifecycleRouteName[];
  readonly stop: StopCapabilityView;
  readonly events: 'unsupported';
  readonly projectCommands: 'unsupported';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * P02-1 真实支持的唯一能力集。任何假服务宣称更多能力都会被响应校验拒绝
 * （客户端以此而非名称猜测判断能力）。
 */
export const CURRENT_HOST_CAPABILITIES: HostCapabilities = deepFreeze({
  lifecycleRoutes: [...LIFECYCLE_ROUTE_NAMES],
  stop: {
    modes: [...SUPPORTED_STOP_MODES],
    idempotency: IDEMPOTENCY_SCHEME,
    activityScope: ACTIVITY_SCOPE_IDLE_ONLY,
  },
  events: 'unsupported',
  projectCommands: 'unsupported',
});
