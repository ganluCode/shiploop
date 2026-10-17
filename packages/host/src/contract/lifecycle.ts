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
  'execution.attempt.cancel',
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
  // P03-2 / F-001：Task 策略副本 CAS 编辑经既有 POST /v1/commands 通用路由
  // 接线（同一命令面；HostClient 入口 F-007，CLI 入口 F-008）。
  'task.strategy.update',
  // P03-2 / F-002：计划批准/拒绝决策经既有 POST /v1/commands 通用路由接线
  //（同一命令面；HostClient 入口 F-007，CLI 入口 F-008）。
  'feature.plan.decide',
  'task.approval.block',
  'task.approval.approve',
  'task.approval.reject',
  'task.approval.unblock',
  'task.verification.continue',
  'feature.verification.continue',
  'git.operation.reconcile',
  // P03-2 / F-006：执行输入制品组准备经既有 POST /v1/commands 通用路由
  // 接线（同一命令面；HostClient 入口 F-007，CLI 入口 F-008）。
  'execution.input.prepare',
  // P03-3 / F-004：单 Feature 执行 prepare 预览经既有 POST /v1/commands 通用
  // 路由接线（同一命令面；只读预览不创建执行实体；HostClient/CLI 入口随后续
  // 任务接入；v5 内增量，升版随接线任务评估）。
  'execution.preview',
  // P03-3 / F-005：显式执行启动经既有 POST /v1/commands 通用路由接线（同一
  // 命令面；短写事务内重核并原子提交 Batch/Run/事件与 Work accepted v6 回执；
  // HostClient/CLI 入口属 F-011/F-012；Run 保留 queued，不伪造已启动）。
  'execution.start',
  // P03-3 / F-009：批次预算显式修订经既有 POST /v1/commands 通用路由接线
  //（同一命令面；短写事务内 CAS+单调判定原子更新当前预算/不可变修订行/脱敏
  // 事件与回执；仅增额不自动启动或恢复 Run；HostClient/CLI 入口属 F-011/F-012）。
  'execution.budget.revise',
  // P03-5 / F-011：人工丢弃预览/确认经既有 POST /v1/commands 通用路由接线
  //（同一信封/回执/幂等命令面；预览发布不可变证据，确认走 F-010 专属幂等
  // 通道；HostClient/CLI 入口属 F-012）。
  'workspace.discard',
  'workspace.discard.preview',
] as const;

/** P02-2 §11.3：Host 实际接线的应用查询（含回执/结果读取与快照；P02-3 / F-006 新增静态接入两项；F-014 新增基线分页/详情/证据正文三项；P03-1 / F-009 新增计划层级/详情/DAG 六项；P03-2 / F-007 新增审批决策查询一项；P03-4 / F-008 新增调度诊断/Attempt 审计三项）。 */
export const APPLICATION_QUERY_CAPABILITIES = [
  'execution.sessions.list',
  'execution.session.get',
  'execution.session.evidence.get',
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
  // P03-2 / F-007：Feature 审批决策查询（能力位复用 project.read；与 Core
  // PLAN_APPROVAL_QUERY_OPERATION 同步，不漂移）。
  'features.approvals',
  'execution.budget.get',
  'execution.budget.revisions',
  // P03-4 / F-008：Run 调度诊断与 Attempt/通知诊断审计只读查询真实接线
  //（能力位复用 project.read；与 Core EXECUTION_SCHEDULE_QUERY_OPERATIONS
  // 同步，不漂移）。
  'execution.run.schedule',
  'execution.attempts.list',
  'execution.attempt.diagnostics',
  // P03-7 / F-013：Task 机器证据/人审事项/有限返工链只读查询真实接线（能力位
  // 复用 project.read；与 Core TASK_EVIDENCE_QUERY_OPERATIONS 同步，不漂移）。
  'execution.task.verification.get',
  'execution.task.approvals.list',
  'execution.task.rework-chain.list',
  // P03-5 / F-011：工作区状态只读查询真实接线（能力位复用 project.read；
  // 与 Core WORKSPACE_QUERY_OPERATIONS 同步，不漂移）。
  'workspaces.list',
  'workspaces.get',
  'workspace.operations.list',
  'workspace.operations.get',
  // P03-8 / F-009：Git 意图/实际提交/操作回执只读查询真实接线（能力位复用
  // project.read；与 Core GIT_OPERATION_QUERY_OPERATIONS 同步，不漂移）。
  'git.operations.list',
  'git.operations.get',
  // P03-8 / F-010：Feature 分轴结果只读查询真实接线（能力位复用
  // project.read；与 Core FEATURE_DELIVERY_QUERY_OPERATIONS 同步，不漂移）。
  'features.delivery.get',
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

/** Optional delivery capabilities must be assembled and advertised as a pair. */
export const FEATURE_DELIVERY_COMMAND_CAPABILITIES = ['feature.verification.continue', 'git.operation.reconcile'] as const;

/** Additive v5 capability pair: production defaults stay honest without adapters. */
export function hostCapabilitiesForDelivery(available: boolean): HostCapabilities {
  if (!available) return CURRENT_HOST_CAPABILITIES;
  return deepFreeze({ ...CURRENT_HOST_CAPABILITIES, application: {
    ...CURRENT_HOST_CAPABILITIES.application, commands: [...APPLICATION_COMMAND_CAPABILITIES],
  } });
}

export const CURRENT_HOST_CAPABILITIES: HostCapabilities = deepFreeze({
  lifecycleRoutes: [...LIFECYCLE_ROUTE_NAMES],
  stop: {
    modes: [...SUPPORTED_STOP_MODES],
    idempotency: IDEMPOTENCY_SCHEME,
    activityScope: ACTIVITY_SCOPE_IDLE_ONLY,
  },
  application: {
    commands: APPLICATION_COMMAND_CAPABILITIES.filter(command =>
      command !== 'feature.verification.continue' && command !== 'git.operation.reconcile'),
    queries: [...APPLICATION_QUERY_CAPABILITIES],
    events: { transport: 'sse', route: EVENTS_ROUTE, scopes: ['project', 'global'] },
  },
});
