/**
 * F-002 Host 生命周期状态与能力声明（契约纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §11（状态机）、
 * §8（握手 capabilities 只描述真实支持）；P02-2
 * docs/p02-2-commands-events-contract.md §11.3（结构化应用能力视图）。
 *
 * `stopped` 不是网络状态（进程已不存在），不在线协议枚举内；
 * P02-1/P02-2 生产装配的活动数恒为 0（idle-only）。
 * P02-2 / F-011 起 capabilities 按 §11.3 宣告真实接线的应用命令与查询；
 * F-012 起 events 宣告结构化 SSE 能力（transport/route/scopes 冻结）。
 */
import {
  ACTIVITY_SCOPE_IDLE_ONLY,
  EVENTS_ROUTE,
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

/**
 * P02-2 §11.3：Host 实际接线的应用命令（与 §3.2 命令路由一一对应）。
 * 本清单是 Host 的接线宣告，不随 Core 支持面自动增长；新增命令必须先接线
 * 再宣告（测试与 Core 命令操作清单交叉核对，防止漂移）。
 */
export const APPLICATION_COMMAND_CAPABILITIES = [
  'project.register',
  'project.metadata.update',
  'settings.global.create',
  'settings.global.update',
  'settings.project.create',
  'settings.project.update',
  // P02-3：三个基线命令经既有 POST /v1/commands 路由接线（F-008 preview/run；
  // F-014 cancel 随取消/停止核验执行端口接入）。
  'baseline.preview',
  'baseline.run',
  'baseline.cancel',
  // P03-1 / F-004：Phase 创建经既有 POST /v1/commands 通用路由接线
  //（信封/回执/幂等同一命令面；CLI 计划入口仍由后续任务接入）。
  'phase.create',
  // P03-1 / F-005：单 Feature 计划导入经既有 POST /v1/commands 通用路由接线
  //（同一命令面；查询面/CLI 计划入口仍由后续任务接入）。
  'feature.plan.import',
  // P03-1 / F-007：纯标签 CAS 编辑经既有 POST /v1/commands 通用路由接线
  //（同一命令面；CLI 标签编辑入口仍由后续任务接入）。
  'plan.labels.update',
  // P03-1 / F-008：实质计划修订经既有 POST /v1/commands 通用路由接线
  //（同一命令面；CLI 计划修订入口仍由后续任务接入）。
  'feature.plan.revise',
] as const;

/** P02-2 §11.3：Host 实际接线的应用查询（含回执/结果读取与快照；P02-3 / F-006 新增静态接入两项；F-014 新增基线分页/详情/证据正文三项；P03-1 / F-009 新增计划层级/详情/DAG 六项）。 */
export const APPLICATION_QUERY_CAPABILITIES = [
  'projects.list',
  'projects.get',
  'projects.binding.get',
  'projects.labelCounts',
  'projects.inspect',
  'projects.overview',
  'settings.global.get',
  'settings.global.export',
  'settings.project.get',
  'settings.project.effective',
  'settings.project.export',
  'receipts.get',
  'results.resolve',
  'snapshot.get',
  // P02-3 / F-014 §3.2/§7.4-§7.6：基线分页、单次详情与有界证据正文。
  'baselines.list',
  'baselines.get',
  'artifacts.get',
  // P03-1 / F-009 §6.6：计划层级列表/详情/同 Feature Task DAG（能力位复用
  // project.read；与 Core PLAN_QUERY_OPERATIONS 同步，不漂移）。
  'phases.list',
  'phases.get',
  'features.list',
  'features.get',
  'tasks.list',
  'tasks.get',
] as const;

/**
 * §11.3 事件能力视图（F-012 SSE 接线后生效）：真实实现的唯一形态，
 * 任何伪称（其他 transport/route/scopes）都被握手响应校验拒绝。
 */
export interface EventsCapabilityView {
  readonly transport: 'sse';
  readonly route: typeof EVENTS_ROUTE;
  readonly scopes: readonly ['project', 'global'];
}

/**
 * §11.3 应用能力视图。F-012 起 events 为结构化视图（SSE 已接线）。
 */
export interface ApplicationCapabilityView {
  readonly commands: readonly string[];
  readonly queries: readonly string[];
  readonly events: EventsCapabilityView;
}

/** §8/§11.3 握手成功响应 capabilities（深度冻结）。 */
export interface HostCapabilities {
  readonly lifecycleRoutes: readonly LifecycleRouteName[];
  readonly stop: StopCapabilityView;
  readonly application: ApplicationCapabilityView;
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
 * 真实支持的唯一能力集（P02-2 / F-011 接线后的 §11.3 视图）。任何假服务宣称
 * 更多能力都会被响应校验拒绝（客户端以此而非名称猜测判断能力）。
 */
export const CURRENT_HOST_CAPABILITIES: HostCapabilities = deepFreeze({
  lifecycleRoutes: [...LIFECYCLE_ROUTE_NAMES],
  stop: {
    modes: [...SUPPORTED_STOP_MODES],
    idempotency: IDEMPOTENCY_SCHEME,
    activityScope: ACTIVITY_SCOPE_IDLE_ONLY,
  },
  application: {
    commands: [...APPLICATION_COMMAND_CAPABILITIES],
    queries: [...APPLICATION_QUERY_CAPABILITIES],
    events: { transport: 'sse', route: EVENTS_ROUTE, scopes: ['project', 'global'] },
  },
});
