/**
 * F-011 应用命令/查询传输面（P02-2 契约 §3.2 路由总表、§5 命令/回执、
 * §7 查询与分页、§8 快照、§11.1 装配）。
 *
 * 规则落实：
 * - 只装配 §3.2 表内应用路由：POST /v1/commands、GET /v1/receipts/:commandId、
 *   GET /v1/results/:resultRef、项目/配置/快照 GET 查询与 P02-3 / F-014 基线
 *   查询（GET /v1/projects/:projectId/baselines、GET /v1/baselines/:operationId、
 *   GET /v1/artifacts/:artifactId/content）；表外路径（含 /v1/files 与任何
 *   path/locator 形态）由调用方落到 404 unknown_operation；唯一的正文返回
 *   是 artifacts.get——只输出经 Core 授权与完整性核验的正式基线证据正文
 *   （有界 8 MiB，text/plain），本层绝不按请求路径读文件；
 * - /v1/events 由 F-012 SSE Hub（sse-transport.ts）接管为长连接事件流；
 *   未装配 Hub 的上下文保持已认证后的 501 unsupported（防御纵深）；
 * - Host 不做业务授权：Bearer 认证通过后把可信装配固定绑定的 principal
 *   （生产恒 local-owner；受限主体仅测试装配，绝非请求数据）传给 Core 应用
 *   服务，全部能力/可见性判定由 Core 应用层完成；Host 不直接写库；
 * - POST /v1/commands 校验顺序（§5.1 冻结）：传输层 → 信封严格结构与字段类型
 *   （400，凭据之前）→ 凭据（401，timingSafeEqual 不可区分）→ schema 版本/未知
 *   操作（400/501，凭据之后）→ quiescing 拒绝新变更（503 not_ready，业务状态
 *   不变）→ Core 原子提交；completed → 200，业务 rejected → 按 §5.7 唯一映射
 *   （403/409），响应体仍是同一 CommandReceipt 形状；
 * - 查询参数白名单（未知/重复参数 400 invalid_input 定位到 query.<字段>）；
 *   查询串（不含 `?`）超过 8 192 字节 400；GET 不带体；路径参数
 *   （projectId/commandId/resultRef）原样传入 Core 校验（非法 400 且不做任何
 *   查询），本层不做百分号解码，不接受任何文件路径语义；
 * - /v1/commands 请求/响应体与查询响应体上限 65 536 字节（413/500 有界拒绝，
 *   超限响应不含业务内容）；/v1/host/* 仍 16 384（由生命周期传输面执行）；
 * - Host/Origin 校验、无 CORS、无 3xx、cache-control: no-store、
 *   connection: close、错误体脱敏（不回显 token/原文/路径/堆栈）沿用 P02-1；
 *   未预期异常统一 500 internal 固定文案。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不读 argv/env。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateKnowledgeQueryResponse, MAX_KNOWLEDGE_SEARCH_RESPONSE_BYTES, MAX_KNOWLEDGE_READ_RESPONSE_BYTES } from 'shiploop-core/protocol';
import {
  toPublicTaskStrategyReapplicationPreview,
  isPublicError,
  PublicError as CorePublicError,
  WorkAccessError,
  isStorageError,
  publicErrorHttpStatus,
  validateCommandEnvelope,
} from 'shiploop-core';
import type {
  BaselineExecutionService,
  BaselineComparisonService,
  BaselineQueryService,
  CommandReceiptsService,
  CommandService,
  OnboardingService,
  PlanningQueryService,
  PublicError,
  QueryService,
  TrustedPrincipal,
} from 'shiploop-core';
import {
  ATTEMPTS_ROUTE,
  ATTEMPTS_ROUTE_PREFIX,
  ATTEMPT_DIAGNOSTICS_ROUTE_SUFFIX,
  BATCHES_ROUTE_PREFIX,
  ARTIFACT_CONTENT_ROUTE_SUFFIX,
  ARTIFACTS_ROUTE_PREFIX,
  BASELINE_COMPARE_ROUTE,
  BASELINES_ROUTE_PREFIX,
  COMMANDS_ROUTE,
  DISPATCH_QUEUE_ROUTE,
  EXECUTION_RESOURCES_ROUTE,
  EVENTS_ROUTE,
  FEATURE_APPROVALS_ROUTE_SUFFIX,
  FEATURE_DELIVERY_ROUTE_SUFFIX,
  FEATURE_REPORT_ROUTE_SUFFIX,
  MAX_FEATURE_REPORT_RESPONSE_BYTES,
  FEATURES_ROUTE,
  FEATURES_ROUTE_PREFIX,
  GIT_OPERATIONS_ROUTE,
  GIT_OPERATIONS_ROUTE_PREFIX,
  GIT_REPAIRS_ROUTE,
  GIT_REPAIRS_ROUTE_PREFIX,
  INTEGRATION_PLANS_ROUTE_PREFIX,
  MAX_APP_BODY_BYTES,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_QUERY_STRING_BYTES,
  PHASES_ROUTE,
  PHASES_ROUTE_PREFIX,
  PLANNING_CONTEXTS_ROUTE,
  PLANNING_CONTEXTS_ROUTE_PREFIX,
  PLANNING_CANDIDATE_ROUTE_SUFFIX,
  PROJECTS_INSPECT_ROUTE,
  PROJECTS_ROUTE,
  PROJECT_REPOSITORY_MOVE_CONFIRM_ROUTE_SUFFIX,
  PROJECT_REPOSITORY_MOVE_PREVIEW_ROUTE_SUFFIX,
  PROJECT_RESOURCE_CANDIDATES_ROUTE_SUFFIX,
  PROJECT_RESOURCE_PREVIEW_ROUTE_SUFFIX,
  PROJECT_RESOURCE_ROUTE_SUFFIX,
  PROJECT_LABEL_COUNTS_ROUTE,
  RECEIPTS_ROUTE_PREFIX,
  RESULTS_ROUTE_PREFIX,
  RUNS_ROUTE,
  RUNS_ROUTE_PREFIX,
  LABEL_COUNTS_ROUTE,
  RUN_SCHEDULE_ROUTE_SUFFIX,
  RUN_CONTROL_ROUTE_SUFFIX,
  RUN_RECOVERY_ROUTE_SUFFIX,
  WORKSPACES_ROUTE,
  WORKSPACES_ROUTE_PREFIX,
  WORKSPACE_OPERATIONS_ROUTE,
  WORKSPACE_OPERATIONS_ROUTE_PREFIX,
  SETTINGS_GLOBAL_EXPORT_ROUTE,
  SETTINGS_GLOBAL_ROUTE,
  SNAPSHOT_ROUTE,
  TASKS_ROUTE,
  TASKS_ROUTE_PREFIX,
  TASK_STRATEGY_REAPPLICATION_ROUTE,
  TASK_APPROVALS_ROUTE_SUFFIX,
  TASK_REWORK_CHAIN_ROUTE_SUFFIX,
  TASK_VERIFICATION_ROUTE_SUFFIX,
} from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import {
  bearerCredentialMatches,
  readLimitedBody,
  rejectRoute,
  RouteReject,
  sendJson,
  sendJsonText,
  sendTextContent,
} from './http-primitives.js';
import type { EventStreamHub } from './sse-transport.js';
import type { HostWorkToolAuthentication } from './work-tool-access.js';

/** 应用操作身份字面量（与 §3.2 路由总表一一对应；错误体 operation）。 */
export type ApplicationOperation =
  | 'knowledge.search' | 'knowledge.read' | 'memory.search'
  | 'work.tools.invoke'
  | 'execution.sessions.list'
  | 'execution.session.get'
  | 'execution.session.evidence.get'
  // P04-5 / F-007：Work 公开记录索引/有界正文只读查询（与 Core
  // WORK_RECORDING_LIST_OPERATION / WORK_RECORDING_BODY_OPERATION 同源）。
  | 'execution.recording.list'
  | 'execution.recording.body.get'
  | 'commands.submit'
  | 'receipts.get'
  | 'results.resolve'
  | 'projects.list'
  | 'projects.get'
  | 'projects.binding.get'
  | 'projects.labelCounts'
  | 'projects.inspect'
  | 'projects.overview'
  | 'projects.profile.get'
  | 'projects.profile.match'
  | 'settings.global.get'
  | 'settings.global.export'
  | 'settings.project.get'
  | 'settings.project.effective'
  | 'settings.project.export'
  | 'snapshot.get'
  | 'baselines.list'
  | 'baselines.get'
  | 'baselines.compare'
  | 'artifacts.get'
  | 'events.subscribe'
  // P03-1 / F-009 §6.6：计划域查询操作身份（与 Core PLAN_QUERY_OPERATIONS 同源）。
  | 'phases.list'
  | 'phases.get'
  | 'phases.graph.get'
  | 'features.list'
  | 'features.get'
  | 'tasks.list'
  | 'tasks.get'
  // P06-6 / F-007：四层标签 Run 列表与实体标签计数只读查询（与 Core
  // runs.list / labels.counts 操作身份同源）。
  | 'runs.list'
  | 'labels.counts'
  | 'task.strategy.reapply.preview'
  // P03-2 / F-007：Feature 审批决策查询（与 Core PLAN_APPROVAL_QUERY_OPERATION 同源）。
  | 'features.approvals'
  | 'execution.budget.get'
  | 'execution.budget.revisions'
  // P03-4 / F-008：Run 调度诊断与 Attempt/通知诊断审计只读查询（与 Core
  // EXECUTION_SCHEDULE_QUERY_OPERATIONS 同源）。
  | 'execution.run.schedule'
  | 'execution.attempts.list'
  | 'execution.attempt.diagnostics'
  // P03-7 / F-013：Task 机器证据/人审事项/有限返工链查询（与 Core
  // TASK_EVIDENCE_QUERY_OPERATIONS 同源）。
  | 'execution.task.verification.get'
  | 'execution.task.approvals.list'
  | 'execution.task.rework-chain.list'
  // P03-5 / F-011：工作区状态只读查询（与 Core WORKSPACE_QUERY_OPERATIONS 同源）。
  | 'workspaces.list'
  | 'workspaces.get'
  | 'workspace.operations.list'
  | 'workspace.operations.get'
  // P03-8 / F-009：Git 意图/实际提交/操作回执只读查询（与 Core
  // GIT_OPERATION_QUERY_OPERATIONS 同源）。
  | 'git.operations.list'
  | 'git.operations.get'
  | 'git.repairs.list'
  | 'git.repairs.get'
  // P03-8 / F-010：Feature 分轴结果只读查询（与 Core
  // FEATURE_DELIVERY_QUERY_OPERATIONS 同源）。
  | 'features.delivery.get'
  | 'features.report.get'
  // P05-6 / F-005：固定成果/基线/顺序/状态只读投影。
  | 'integration.plan.get'
  // 查询（与 Core EXECUTION_CONTROL_QUERY_OPERATIONS 同源）。
  | 'execution.run.control.get'
  | 'execution.batch.control.get'
  | 'execution.batch.delivery.get'
  | 'execution.run.recovery.get'
  // P04-9 / F-009：派发队列与执行槽位只读投影（与 Core
  // EXECUTION_DISPATCH_QUERY_OPERATIONS 同源；无写入口）。
  | 'execution.dispatch.list'
  | 'execution.resources.list'
  // P05-1 / F-012：规划上下文/候选只读查询（与 Core PLANNING_QUERY_OPERATIONS
  // 同源；候选正文经受管内容接口核验读取）。
  | 'planning.contexts.list'
  | 'planning.context.get'
  | 'planning.candidate.get'
  | 'project.resources.list'
  | 'project.resources.candidates'
  | 'project.resources.preview'
  | 'project.resources.sources.configure'
  | 'repository.move.preview'
  | 'repository.move.confirm';

/** 已解析的应用路由（path 形态匹配；路径参数为未解码原始片段）。 */
export interface ResolvedAppRoute {
  readonly operation: ApplicationOperation;
  readonly method: 'GET' | 'POST';
  readonly pathParam?: {
    readonly name: 'commandId' | 'projectId' | 'resultRef' | 'operationId' | 'integrationId' | 'artifactId' | 'phaseId' | 'featureId' | 'taskId' | 'batchId' | 'runId' | 'attemptId' | 'candidateId';
    readonly value: string;
  };
}

/**
 * 可信应用装配上下文：principal 由装配固定绑定（生产恒 local-owner；受限
 * 主体仅可信测试装配），服务为 shiploop-core 受控 assembly 的窄端口；
 * 本层不从请求数据取身份，不直接访问 SQLite。
 */
export interface HostApplicationContext {
  /** Instance-local restricted credentials; never authenticate against the owner token. */
  readonly workTools?: HostWorkToolAuthentication;
  readonly knowledgeQueryService?: Partial<Pick<import('shiploop-core').KnowledgeQueryService, 'search' | 'read'>>;
  readonly memoryQueryService?: Pick<import('shiploop-core').MemoryQueryService, 'search'>;
  readonly principal: TrustedPrincipal;
  readonly commandService: CommandService;
  readonly queryService: QueryService;
  readonly commandReceiptsService: CommandReceiptsService;
  readonly projectProfileService?: Pick<import('shiploop-core').ProjectProfileService, 'getQuery' | 'matchTaskModules'>;
  /** P02-3 / F-006（§7.2/§7.3）：静态接入用例（inspect/overview）；授权在 Core。 */
  readonly onboardingService: OnboardingService;
  /**
   * P02-3 / F-014（§7.4-§7.6）：基线分页/详情/证据正文只读查询（授权在 Core）。
   * 能力清单宣告 baselines.list/baselines.get/artifacts.get，必须真实接线。
   */
  readonly baselineQueryService: BaselineQueryService;
  /** P06-5：同项目基线身份与逐项状态的只读比较；无写端口。 */
  readonly baselineComparisonService?: Pick<BaselineComparisonService, 'compareBaselines'>;
  /**
   * P05-1 / F-012：规划上下文/候选只读查询（授权/可见性/候选正文完整性全部在
   * Core；能力清单宣告 planning.contexts.list/planning.context.get/
   * planning.candidate.get，必须真实接线）。
   */
  readonly planningQueryService: Pick<PlanningQueryService, 'listPlanningContexts' | 'getPlanningContext' | 'getPlanningCandidate'>;
  readonly projectResourceService?: Pick<import('shiploop-core').ProjectResourceService, 'getConfiguration' | 'discoverCandidates' | 'previewCandidates' | 'configureSource'>;
  readonly repositoryMoveService?: Pick<import('shiploop-core').RepositoryMoveService, 'preview' | 'prepareConfirmation' | 'confirm'>;
  /**
   * P02-3 / F-014（§5.3/§13）：baseline.run 经既有 POST /v1/commands 路由提交
   * 到执行编排（accepted 后异步启动检查）；其余命令仍走 commandService。
   */
  readonly baselineExecutionService: Pick<BaselineExecutionService, 'submit'>;
  /** 生命周期状态读取：quiescing/stopping/starting 拒绝新变更（503）。 */
  getLifecycleState(): LifecycleState;
  /**
   * F-012 SSE 事件订阅 Hub（§9.4）；缺席时 /v1/events 为已认证后的 501
   * unsupported（防御纵深：未装配绝不假装可用）。
   */
  readonly eventStreams?: EventStreamHub;
}

/**
 * §3.2 应用路由解析（只看路径部分；query 不参与路由）。
 * 未匹配返回 undefined（由调用方统一 404 unknown_operation）。
 * 注意：/v1/projects/label-counts 字面量优先于 :projectId 形态（稳定 ID
 * 「label-counts」项目在本路由表下不可经此路径寻址，属冻结路由取舍）。
 */
export function resolveAppRoute(path: string): ResolvedAppRoute | undefined {
  switch (path) {
    case '/v1/work/tools':
      return { operation: 'work.tools.invoke', method: 'POST' };
    case COMMANDS_ROUTE:
      return { operation: 'commands.submit', method: 'POST' };
    case PROJECTS_ROUTE:
      return { operation: 'projects.list', method: 'GET' };
    case PROJECT_LABEL_COUNTS_ROUTE:
      return { operation: 'projects.labelCounts', method: 'GET' };
    // P02-3 / F-006：字面量优先于 :projectId 形态（与 label-counts 同一冻结
    // 路由取舍：稳定 ID「inspect」项目不可经此路径寻址）。
    case PROJECTS_INSPECT_ROUTE:
      return { operation: 'projects.inspect', method: 'GET' };
    case SETTINGS_GLOBAL_ROUTE:
      return { operation: 'settings.global.get', method: 'GET' };
    case SETTINGS_GLOBAL_EXPORT_ROUTE:
      return { operation: 'settings.global.export', method: 'GET' };
    case SNAPSHOT_ROUTE:
      return { operation: 'snapshot.get', method: 'GET' };
    case EVENTS_ROUTE:
      return { operation: 'events.subscribe', method: 'GET' };
    default:
      break;
  }
  // P03-5 / F-011：GET /v1/workspaces（集合根 + projectId/可选 featureId/分页
  // 查询参数）与单段路径参数 GET /v1/workspaces/:featureId；其他形态未匹配。
  if (path === WORKSPACES_ROUTE) {
    return { operation: 'workspaces.list', method: 'GET' };
  }
  if (path.startsWith(WORKSPACES_ROUTE_PREFIX)) {
    const segments = path.slice(WORKSPACES_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 1) {
      return {
        operation: 'workspaces.get',
        method: 'GET',
        pathParam: { name: 'featureId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  // P03-5 / F-011：GET /v1/workspace-operations（集合根 + projectId/可选
  // featureId/分页查询参数）与单段路径参数 GET /v1/workspace-operations/:operationId。
  if (path === WORKSPACE_OPERATIONS_ROUTE) {
    return { operation: 'workspace.operations.list', method: 'GET' };
  }
  if (path.startsWith(WORKSPACE_OPERATIONS_ROUTE_PREFIX)) {
    const segments = path.slice(WORKSPACE_OPERATIONS_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 1) {
      return {
        operation: 'workspace.operations.get',
        method: 'GET',
        pathParam: { name: 'operationId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  if (path === GIT_REPAIRS_ROUTE) {
    return { operation: 'git.repairs.list', method: 'GET' };
  }
  if (path.startsWith(GIT_REPAIRS_ROUTE_PREFIX)) {
    const segment = path.slice(GIT_REPAIRS_ROUTE_PREFIX.length);
    if (segment.length > 0 && !segment.includes('/')) {
      return { operation: 'git.repairs.get', method: 'GET', pathParam: { name: 'candidateId', value: segment } };
    }
    return undefined;
  }
  // P03-8 / F-009：GET /v1/git-operations（集合根 + projectId + 父级二选一/
  // 分页查询参数）与单段路径参数 GET /v1/git-operations/:operationId；其他
  // 嵌套/多段形态一律未匹配 → 404 unknown_operation。
  if (path === GIT_OPERATIONS_ROUTE) {
    return { operation: 'git.operations.list', method: 'GET' };
  }
  if (path.startsWith(GIT_OPERATIONS_ROUTE_PREFIX)) {
    const segment = path.slice(GIT_OPERATIONS_ROUTE_PREFIX.length);
    if (segment.length > 0 && !segment.includes('/')) {
      return {
        operation: 'git.operations.get',
        method: 'GET',
        pathParam: { name: 'operationId', value: segment },
      };
    }
    return undefined;
  }
  // P05-1 / F-012：规划上下文/候选查询路由。集合根（必填 projectId + 可选
  // Feature 过滤 + 分页）与单段路径参数详情；唯一冻结的候选子资源形态
  // GET /v1/planning-contexts/:candidateId/candidate；其他嵌套/多段形态一律
  // 未匹配 → 404 unknown_operation。
  if (path === PLANNING_CONTEXTS_ROUTE) {
    return { operation: 'planning.contexts.list', method: 'GET' };
  }
  if (path.startsWith(PLANNING_CONTEXTS_ROUTE_PREFIX)) {
    const segments = path.slice(PLANNING_CONTEXTS_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 1) {
      return {
        operation: 'planning.context.get',
        method: 'GET',
        pathParam: { name: 'candidateId', value: segments[0] as string },
      };
    }
    if (segments.length === 2 && segments[1] === PLANNING_CANDIDATE_ROUTE_SUFFIX) {
      return {
        operation: 'planning.candidate.get',
        method: 'GET',
        pathParam: { name: 'candidateId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  // P06-4 / F-008：GET /v1/runs/:runId/schedule（恰两段；与 batches 同一
  // 冻结形态）。P03-9 / F-013：GET /v1/runs/:runId/control 与
  // /v1/runs/:runId/recovery 同一形态。P06-6 / F-007：GET /v1/runs 集合根
  //（四层标签 Run 列表）。其他 /v1/runs/* 形态一律未匹配 → 404 unknown_operation。
  if (path === RUNS_ROUTE) {
    return { operation: 'runs.list', method: 'GET' };
  }
  if (path.startsWith(RUNS_ROUTE_PREFIX)) {
    const segments = path.slice(RUNS_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 2 && segments[1] === RUN_SCHEDULE_ROUTE_SUFFIX) {
      return {
        operation: 'execution.run.schedule',
        method: 'GET',
        pathParam: { name: 'runId', value: segments[0] as string },
      };
    }
    if (segments.length === 2 && segments[1] === RUN_CONTROL_ROUTE_SUFFIX) {
      return {
        operation: 'execution.run.control.get',
        method: 'GET',
        pathParam: { name: 'runId', value: segments[0] as string },
      };
    }
    if (segments.length === 2 && segments[1] === RUN_RECOVERY_ROUTE_SUFFIX) {
      return {
        operation: 'execution.run.recovery.get',
        method: 'GET',
        pathParam: { name: 'runId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  // P03-4 / F-008：GET /v1/attempts（集合根 + projectId/taskId 查询参数）与
  // 唯一冻结的 Attempt 子资源 GET /v1/attempts/:attemptId/diagnostics。
  if (path === '/v1/work-sessions') return { operation: 'execution.sessions.list', method: 'GET' };
  const sessionPath = /^\/v1\/attempts\/([^/]+)\/session(\/evidence)?$/.exec(path);
  if (sessionPath) return { operation: sessionPath[2] ? 'execution.session.evidence.get' : 'execution.session.get',
    method: 'GET', pathParam: { name: 'attemptId', value: sessionPath[1]! } };
  // P04-5 / F-007：GET /v1/work-recordings（索引分页；父级 Run/Attempt/Session
  // 三选一由 Core 单一权威复核）与 GET /v1/work-recordings/body（有界正文；
  // 成员身份由 Core 校验，绝不接受任意文件路径）。
  if (path === '/v1/work-recordings') return { operation: 'execution.recording.list', method: 'GET' };
  if (path === '/v1/work-recordings/body') return { operation: 'execution.recording.body.get', method: 'GET' };
  // P04-9 / F-009：GET /v1/dispatch-queue（集合根 + 必填 projectId + 分页）；
  // 其他嵌套/多段形态一律未匹配 → 404 unknown_operation（无子资源/写入口）。
  if (path === DISPATCH_QUEUE_ROUTE) return { operation: 'execution.dispatch.list', method: 'GET' };
  if (path === EXECUTION_RESOURCES_ROUTE) return { operation: 'execution.resources.list', method: 'GET' };
  if (path === ATTEMPTS_ROUTE) {
    return { operation: 'execution.attempts.list', method: 'GET' };
  }
  if (path.startsWith(ATTEMPTS_ROUTE_PREFIX)) {
    const segments = path.slice(ATTEMPTS_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 2 && segments[1] === ATTEMPT_DIAGNOSTICS_ROUTE_SUFFIX) {
      return {
        operation: 'execution.attempt.diagnostics',
        method: 'GET',
        pathParam: { name: 'attemptId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  if (path.startsWith(BATCHES_ROUTE_PREFIX)) {
    const segments = path.slice(BATCHES_ROUTE_PREFIX.length).split('/');
    if (segments.length >= 2 && segments[0] !== '' && segments[1] === 'budget') {
      const operation = segments.length === 2 ? 'execution.budget.get'
        : segments.length === 3 && segments[2] === 'revisions' ? 'execution.budget.revisions' : undefined;
      if (operation !== undefined) {
        return { operation, method: 'GET', pathParam: { name: 'batchId', value: segments[0]! } };
      }
    }
    // P03-9 / F-013：GET /v1/batches/:batchId/control（Batch 控制进度；与
    // budget 同一冻结形态）；其他形态一律未匹配 → 404 unknown_operation。
    if (segments.length === 2 && segments[0] !== '' && segments[1] === 'delivery') {
      return { operation: 'execution.batch.delivery.get', method: 'GET', pathParam: { name: 'batchId', value: segments[0]! } };
    }
    if (segments.length === 2 && segments[0] !== '' && segments[1] === 'control') {
      return { operation: 'execution.batch.control.get', method: 'GET', pathParam: { name: 'batchId', value: segments[0]! } };
    }
    return undefined;
  }
  if (path.startsWith(RECEIPTS_ROUTE_PREFIX)) {
    const segment = path.slice(RECEIPTS_ROUTE_PREFIX.length);
    if (segment.length > 0 && !segment.includes('/')) {
      return {
        operation: 'receipts.get',
        method: 'GET',
        pathParam: { name: 'commandId', value: segment },
      };
    }
    return undefined;
  }
  if (path.startsWith(RESULTS_ROUTE_PREFIX)) {
    const segment = path.slice(RESULTS_ROUTE_PREFIX.length);
    if (segment.length > 0 && !segment.includes('/')) {
      return {
        operation: 'results.resolve',
        method: 'GET',
        pathParam: { name: 'resultRef', value: segment },
      };
    }
    return undefined;
  }
  // P06-5：比较是固定字面量，必须先于 baselines/:operationId 解析。
  if (path === BASELINE_COMPARE_ROUTE) {
    return { operation: 'baselines.compare', method: 'GET' };
  }
  // P02-3 / F-014 §3.2：GET /v1/baselines/:operationId（单段路径参数）。
  if (path.startsWith(BASELINES_ROUTE_PREFIX)) {
    const segment = path.slice(BASELINES_ROUTE_PREFIX.length);
    if (segment.length > 0 && !segment.includes('/')) {
      return {
        operation: 'baselines.get',
        method: 'GET',
        pathParam: { name: 'operationId', value: segment },
      };
    }
    return undefined;
  }
  // P03-1 / F-009 §6.6：计划域查询路由。层级列表为集合根（父级身份经查询
  // 参数显式传入，与 Core 查询服务输入一一对应）；详情为单段路径参数；
  // 嵌套/多段形态除 P03-2 / F-007 冻结的 GET /v1/features/:featureId/approvals
  // 外一律未匹配 → 404 unknown_operation。
  if (path === PHASES_ROUTE) {
    return { operation: 'phases.list', method: 'GET' };
  }
  if (path.startsWith(PHASES_ROUTE_PREFIX)) {
    const segment = path.slice(PHASES_ROUTE_PREFIX.length);
    const parts = segment.split('/');
    if (parts.length === 2 && parts[0] && parts[1] === 'graph') {
      return { operation: 'phases.graph.get', method: 'GET', pathParam: { name: 'phaseId', value: parts[0] } };
    }
    if (segment.length > 0 && !segment.includes('/')) {
      return {
        operation: 'phases.get',
        method: 'GET',
        pathParam: { name: 'phaseId', value: segment },
      };
    }
    return undefined;
  }
  if (path === FEATURES_ROUTE) {
    return { operation: 'features.list', method: 'GET' };
  }
  if (path.startsWith(FEATURES_ROUTE_PREFIX)) {
    const rest = path.slice(FEATURES_ROUTE_PREFIX.length);
    const segments = rest.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 1) {
      return {
        operation: 'features.get',
        method: 'GET',
        pathParam: { name: 'featureId', value: segments[0] as string },
      };
    }
    // P03-2 / F-007：唯一冻结的 Feature 子资源形态
    // GET /v1/features/:featureId/approvals；其余多段形态一律未匹配 → 404。
    if (segments.length === 2 && segments[1] === FEATURE_APPROVALS_ROUTE_SUFFIX.slice(1)) {
      return {
        operation: 'features.approvals',
        method: 'GET',
        pathParam: { name: 'featureId', value: segments[0] as string },
      };
    }
    if (segments.length === 2 && segments[1] === FEATURE_REPORT_ROUTE_SUFFIX.slice(1)) {
      return { operation: 'features.report.get', method: 'GET',
        pathParam: { name: 'featureId', value: segments[0] as string } };
    }
    // P03-8 / F-010：GET /v1/features/:featureId/delivery（Feature 分轴结果
    // 子资源）；其余多段形态一律未匹配 → 404 unknown_operation。
    if (segments.length === 2 && segments[1] === FEATURE_DELIVERY_ROUTE_SUFFIX.slice(1)) {
      return {
        operation: 'features.delivery.get',
        method: 'GET',
        pathParam: { name: 'featureId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  if (path.startsWith(INTEGRATION_PLANS_ROUTE_PREFIX)) {
    const segments = path.slice(INTEGRATION_PLANS_ROUTE_PREFIX.length).split('/');
    if (segments.length === 1 && segments[0]!.length > 0) {
      return { operation: 'integration.plan.get', method: 'GET',
        pathParam: { name: 'integrationId', value: segments[0]! } };
    }
    return undefined;
  }
  if (path === TASK_STRATEGY_REAPPLICATION_ROUTE) {
    return { operation: 'task.strategy.reapply.preview', method: 'GET' };
  }
  // P06-6 / F-007：GET /v1/label-counts（四层实体标签去重计数集合根）。
  if (path === LABEL_COUNTS_ROUTE) {
    return { operation: 'labels.counts', method: 'GET' };
  }
  if (path === TASKS_ROUTE) {
    return { operation: 'tasks.list', method: 'GET' };
  }
  if (path.startsWith(TASKS_ROUTE_PREFIX)) {
    const segments = path.slice(TASKS_ROUTE_PREFIX.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    if (segments.length === 1) {
      return {
        operation: 'tasks.get',
        method: 'GET',
        pathParam: { name: 'taskId', value: segments[0] as string },
      };
    }
    // P03-7 / F-013：唯一冻结的 Task 子资源形态（其余多段一律未匹配）。
    if (segments.length === 2) {
      const suffix = segments[1] as string;
      const operation =
        suffix === TASK_VERIFICATION_ROUTE_SUFFIX
          ? 'execution.task.verification.get'
          : suffix === TASK_APPROVALS_ROUTE_SUFFIX
            ? 'execution.task.approvals.list'
            : suffix === TASK_REWORK_CHAIN_ROUTE_SUFFIX
              ? 'execution.task.rework-chain.list'
              : undefined;
      if (operation !== undefined) {
        return {
          operation,
          method: 'GET',
          pathParam: { name: 'taskId', value: segments[0] as string },
        };
      }
    }
    return undefined;
  }
  // P02-3 / F-014 §3.2/§7.6：GET /v1/artifacts/:artifactId/content（恰两段；
  // 其他 /v1/artifacts/* 形态一律未匹配 → 404 unknown_operation）。
  if (path.startsWith(ARTIFACTS_ROUTE_PREFIX)) {
    const rest = path.slice(ARTIFACTS_ROUTE_PREFIX.length);
    const segments = rest.split('/');
    if (
      segments.length === 2 &&
      (segments[0] as string).length > 0 &&
      segments[1] === 'content'
    ) {
      return {
        operation: 'artifacts.get',
        method: 'GET',
        pathParam: { name: 'artifactId', value: segments[0] as string },
      };
    }
    return undefined;
  }
  if (path.startsWith(`${PROJECTS_ROUTE}/`)) {
    const rest = path.slice(PROJECTS_ROUTE.length + 1);
    const segments = rest.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      return undefined;
    }
    const projectId = segments[0] as string;
    const sub = segments.slice(1).join('/');
    switch (sub) {
      case '':
        return {
          operation: 'projects.get',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case 'repository-binding':
        return {
          operation: 'projects.binding.get',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case 'overview':
        return {
          operation: 'projects.overview',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case 'knowledge/search':
        return { operation: 'knowledge.search', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'knowledge/read':
        return { operation: 'knowledge.read', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'memory/search':
        return { operation: 'memory.search', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'profile':
        return { operation: 'projects.profile.get', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'profile/match':
        return { operation: 'projects.profile.match', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'settings':
        return {
          operation: 'settings.project.get',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case 'settings/effective':
        return {
          operation: 'settings.project.effective',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case 'settings/export':
        return {
          operation: 'settings.project.export',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      // P02-3 / F-014 §3.2/§7.4：GET /v1/projects/:projectId/baselines。
      case 'baselines':
        return {
          operation: 'baselines.list',
          method: 'GET',
          pathParam: { name: 'projectId', value: projectId },
        };
      case PROJECT_REPOSITORY_MOVE_PREVIEW_ROUTE_SUFFIX:
        return { operation: 'repository.move.preview', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case PROJECT_REPOSITORY_MOVE_CONFIRM_ROUTE_SUFFIX:
        return { operation: 'repository.move.confirm', method: 'POST', pathParam: { name: 'projectId', value: projectId } };
      case PROJECT_RESOURCE_ROUTE_SUFFIX:
        return { operation: 'project.resources.list', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case PROJECT_RESOURCE_CANDIDATES_ROUTE_SUFFIX:
        return { operation: 'project.resources.candidates', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case PROJECT_RESOURCE_PREVIEW_ROUTE_SUFFIX:
        return { operation: 'project.resources.preview', method: 'GET', pathParam: { name: 'projectId', value: projectId } };
      case 'resources/sources':
        return { operation: 'project.resources.sources.configure', method: 'POST', pathParam: { name: 'projectId', value: projectId } };
      default:
        return undefined;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 错误与响应（全部脱敏：不含 token/请求原文/绝对路径/堆栈）
 * ------------------------------------------------------------------ */

/** 应用路由错误体形状（与 P02-1 §7.3 相同信封，operation 为应用操作身份）。 */
interface AppErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly operation: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function reject(
  status: number,
  code: string,
  operation: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  rejectRoute(status, code, operation, message, details);
}

function rejectBody(error: RouteReject): AppErrorBody {
  const body: AppErrorBody['error'] = {
    code: error.code,
    message: error.detailMessage,
    operation: error.operation,
  };
  if (error.details !== undefined) {
    (body as { details?: Readonly<Record<string, unknown>> }).details = error.details;
  }
  return { error: body };
}

function publicErrorBody(error: PublicError): AppErrorBody {
  const shape = error.toErrorShape();
  const body: AppErrorBody['error'] = {
    code: shape.code,
    message: shape.message,
    operation: error.operation,
  };
  if (shape.details !== undefined) {
    (body as { details?: Readonly<Record<string, unknown>> }).details = shape.details;
  }
  return { error: body };
}

/** §4.2：缺失/错误/陈旧 token 与 Origin/Host 不符共用不可区分的 401。 */
function rejectUnauthorized(operation: string): never {
  reject(401, 'unauthorized', operation, '认证失败', { reason: 'authentication_failed' });
}

function internalBody(operation: string, reason: string): AppErrorBody {
  return {
    error: {
      code: 'internal',
      message: 'Host 内部错误（已脱敏）',
      operation,
      details: { reason },
    },
  };
}

/** 有界响应：序列化超限 → 500 internal（响应不含业务内容，§13 预算）。 */
function sendBoundedJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  limitBytes: number,
  operation: string,
): void {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > limitBytes) {
    sendJson(response, 500, internalBody(operation, 'response_budget_exceeded'));
    return;
  }
  sendJsonText(response, status, text);
}

/* ------------------------------------------------------------------ *
 * 查询参数白名单解析
 * ------------------------------------------------------------------ */

interface QuerySpec {
  readonly allowed: readonly string[];
  readonly repeatable: readonly string[];
}

const QUERY_SPECS: Readonly<Partial<Record<ApplicationOperation, QuerySpec>>> = Object.freeze({
  'knowledge.search': { allowed: ['documentId', 'version', 'keyword', 'title', 'path', 'limit', 'snippetMaxChars', 'maxReadBytes', 'maxCandidates'], repeatable: [] },
  'knowledge.read': { allowed: ['documentId', 'version', 'maxReadBytes'], repeatable: [] },
  'memory.search': { allowed: ['keyword', 'recordKey', 'scope', 'version', 'limit', 'snippetMaxChars', 'maxReadBytes', 'maxCandidates'], repeatable: [] },
  'execution.budget.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.budget.revisions': Object.freeze({ allowed: ['projectId', 'limit', 'cursor'], repeatable: [] }),
  // P03-4 / F-008：调度/审计查询参数白名单（取值规则由 Core 单一权威复核）。
  'execution.run.schedule': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.sessions.list': Object.freeze({ allowed: ['projectId', 'runId', 'taskId', 'limit', 'cursor'], repeatable: [] }),
  'execution.session.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.session.evidence.get': Object.freeze({ allowed: ['projectId', 'artifactId'], repeatable: [] }),
  // P04-5 / F-007：公开记录查询参数白名单（父级三选一/recordType/分页与
  // artifactId 的取值规则由 Core 单一权威复核）。
  'execution.recording.list': Object.freeze({ allowed: ['projectId', 'runId', 'attemptId', 'sessionId', 'recordType', 'limit', 'cursor'], repeatable: [] }),
  'execution.recording.body.get': Object.freeze({ allowed: ['projectId', 'runId', 'attemptId', 'sessionId', 'artifactId'], repeatable: [] }),
  'execution.attempts.list': Object.freeze({
    allowed: ['projectId', 'taskId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'execution.attempt.diagnostics': Object.freeze({
    allowed: ['projectId', 'limit', 'cursor'],
    repeatable: [],
  }),
  // P04-9 / F-009：派发队列查询参数白名单（只读；容量/owner/version/释放
  // 等可写意图不在白名单内，一律 400；取值规则由 Core 单一权威复核）。
  'execution.dispatch.list': Object.freeze({
    allowed: ['projectId', 'batchId', 'featureId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'execution.resources.list': Object.freeze({
    allowed: ['projectId', 'batchId', 'featureId', 'limit', 'cursor'],
    repeatable: [],
  }),
  // P05-1 / F-012：规划上下文/候选查询参数白名单（取值规则由 Core 单一权威
  // 复核；candidateId 只来自冻结路径参数，不接受查询参数重复指定）。
  'planning.contexts.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'planning.context.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'planning.candidate.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  // P03-7 / F-013：Task 证据/人审/返工链查询参数白名单（取值规则由 Core 单一
  // 权威复核；taskId 只来自冻结路径参数，不接受查询参数重复指定）。
  'execution.task.verification.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.task.approvals.list': Object.freeze({
    allowed: ['projectId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'execution.task.rework-chain.list': Object.freeze({
    allowed: ['projectId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'projects.list': Object.freeze({ allowed: ['limit', 'cursor', 'label', 'match'], repeatable: ['label'] }),
  // P02-3 / F-006（§7.2）：path 是唯一例外查询参数（仓库根绝对路径，经
  // RepositoryInspector 校验；不是通用文件读取）。
  'projects.inspect': Object.freeze({ allowed: ['path'], repeatable: [] }),
  'projects.profile.get': Object.freeze({ allowed: [], repeatable: [] }),
  'projects.profile.match': Object.freeze({ allowed: ['directory', 'requiredModuleId', 'language', 'framework', 'scope'], repeatable: ['requiredModuleId', 'language', 'framework', 'scope'] }),

  'snapshot.get': Object.freeze({ allowed: ['scope', 'projectId'], repeatable: [] }),
  // F-012（§9.4）：订阅恢复位置 Last-Event-ID（头）优先于 ?cursor=；缺省 400。
  'events.subscribe': Object.freeze({ allowed: ['scope', 'projectId', 'cursor'], repeatable: [] }),
  // P02-3 / F-014（§7.4）：baselines.list 分页参数（取值规则由 Core 复核）。
  'baselines.list': Object.freeze({ allowed: ['limit', 'cursor'], repeatable: [] }),
  'baselines.compare': Object.freeze({ allowed: ['previousOperationId', 'currentOperationId'], repeatable: [] }),
  'project.resources.list': Object.freeze({ allowed: [], repeatable: [] }),
  'project.resources.candidates': Object.freeze({ allowed: ['sourceId'], repeatable: ['sourceId'] }),
  'project.resources.preview': Object.freeze({ allowed: ['sourceId', 'selectedResourceId'], repeatable: ['sourceId', 'selectedResourceId'] }),
  'repository.move.preview': Object.freeze({ allowed: ['path'], repeatable: [] }),
  // P03-1 / F-009 §6.6：计划层级列表查询参数（父级身份 + 分页；P06-6 /
  // F-007 扩展可重复 label 与 match；取值规则由 Core 单一权威复核）。
  'phases.graph.get': Object.freeze({ allowed: ['projectId', 'limit', 'cursor'], repeatable: [] }),
  'phases.list': Object.freeze({ allowed: ['projectId', 'limit', 'cursor', 'label', 'match'], repeatable: ['label'] }),
  'features.list': Object.freeze({
    allowed: ['projectId', 'phaseId', 'limit', 'cursor', 'label', 'match'],
    repeatable: ['label'],
  }),
  'tasks.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'limit', 'cursor', 'label', 'match'],
    repeatable: ['label'],
  }),
  // P06-6 / F-007：Run 列表与四层标签计数查询参数白名单（父级适用范围/
  // 标签规范化/游标绑定由 Core 单一权威复核；计数不接受分页参数）。
  'runs.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'batchId', 'limit', 'cursor', 'label', 'match'],
    repeatable: ['label'],
  }),
  'labels.counts': Object.freeze({
    allowed: ['entity', 'projectId', 'phaseId', 'featureId', 'batchId', 'label', 'match'],
    repeatable: ['label'],
  }),
  'task.strategy.reapply.preview': Object.freeze({ allowed: ['projectId', 'taskId'], repeatable: ['taskId'] }),
  // P03-5 / F-011：工作区状态查询参数白名单（取值规则由 Core 单一权威复核）。
  'workspaces.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'workspaces.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'workspace.operations.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'workspace.operations.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  // P03-8 / F-009：Git 操作查询参数白名单（父级二选一由 Core 单一权威复核）。
  'git.operations.list': Object.freeze({
    allowed: ['projectId', 'featureId', 'runId', 'limit', 'cursor'],
    repeatable: [],
  }),
  'git.operations.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'git.repairs.list': Object.freeze({ allowed: ['projectId', 'limit', 'cursor'], repeatable: [] }),
  'git.repairs.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  // P03-8 / F-010：Feature 分轴结果查询参数白名单（取值规则由 Core 单一权威复核）。
  'features.delivery.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'features.report.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'integration.plan.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.run.control.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.batch.control.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
  'execution.batch.delivery.get': Object.freeze({ allowed: ['projectId', 'limit', 'cursor'], repeatable: [] }),
  'execution.run.recovery.get': Object.freeze({ allowed: ['projectId'], repeatable: [] }),
});

/** 查询参数白名单校验（未知/重复 → 400，定位 query.<字段>）；空查询串恒合法。 */
function parseQueryParams(
  rawQuery: string,
  operation: ApplicationOperation,
): URLSearchParams {
  const spec = QUERY_SPECS[operation] ?? { allowed: [], repeatable: [] };
  const params = new URLSearchParams(rawQuery);
  const keys = new Set(params.keys());
  for (const key of keys) {
    if (!spec.allowed.includes(key)) {
      reject(400, 'invalid_input', operation, '未知查询参数', {
        field: `query.${key}`,
        reason: 'unknown_query_parameter',
      });
    }
    if (!spec.repeatable.includes(key) && params.getAll(key).length > 1) {
      reject(400, 'invalid_input', operation, '查询参数不允许重复', {
        field: `query.${key}`,
        reason: 'duplicate_query_parameter',
      });
    }
  }
  return params;
}

/**
 * P06-6 / F-007：四层标签列表/计数查询的 label/match 形态转换（与
 * buildProjectListFilter 同一纪律：可重复 label 原样透传，match 不透明透传；
 * 标签规范化、match 枚举、父级适用范围与游标绑定全部由 Core 单一权威复核）。
 */
function withEntityLabelFilter(
  params: URLSearchParams,
  query: Record<string, unknown>,
): Record<string, unknown> {
  const labels = params.getAll('label');
  if (labels.length > 0) {
    query.labels = labels;
  }
  const match = params.get('match');
  if (match !== null) {
    query.match = match;
  }
  return query;
}

/** projects.list 查询串 → Core 筛选对象（形态转换；取值规则仍由 Core 复核）。 */
function buildProjectListFilter(
  params: URLSearchParams,
  operation: ApplicationOperation,
): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    if (!/^(0|[1-9]\d{0,2})$/.test(limitRaw)) {
      reject(400, 'invalid_input', operation, 'limit 必须是十进制整数文本', {
        field: 'query.limit',
        reason: 'invalid_integer',
      });
    }
    // 范围（1..200）由 Core validateProjectListFilter 单一权威复核。
    filter.limit = Number(limitRaw);
  }
  const match = params.get('match');
  if (match !== null) {
    filter.match = match;
  }
  const labels = params.getAll('label');
  if (labels.length > 0) {
    filter.labels = labels;
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    filter.cursor = cursor;
  }
  return Object.keys(filter).length === 0 ? undefined : filter;
}

/** snapshot.get 查询串 → §8 scope 对象（project 必须带 projectId，global 禁止）。 */
function buildSnapshotScope(
  params: URLSearchParams,
  operation: ApplicationOperation,
): { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectId: string } {
  const scopeRaw = params.get('scope');
  if (scopeRaw !== 'project' && scopeRaw !== 'global') {
    reject(400, 'invalid_input', operation, "scope 必须是 'project' 或 'global'", {
      field: 'query.scope',
      reason: 'invalid_scope',
    });
  }
  const projectId = params.get('projectId');
  if (scopeRaw === 'global') {
    if (projectId !== null) {
      reject(400, 'invalid_input', operation, 'global scope 不允许携带 projectId', {
        field: 'query.projectId',
        reason: 'scope_conflict',
      });
    }
    return { kind: 'global' };
  }
  if (projectId === null) {
    reject(400, 'invalid_input', operation, 'project scope 必须携带 projectId', {
      field: 'query.projectId',
      reason: 'missing_project_id',
    });
  }
  return { kind: 'project', projectId: projectId as string };
}

/**
 * P03-1 / F-009 §6.6：计划层级列表查询串 → Core 查询输入（形态转换）。
 * 父级身份必填（缺失是结构错误 400，不是空列表）；limit 必须是十进制整数
 * 文本（范围由 Core 单一权威复核）；cursor 不透明透传（绑定数据根/父级由
 * Core decodePlanListCursor 核验，坏游标绝不当从零读取）。
 */
function buildPlanListQuery(
  params: URLSearchParams,
  operation: ApplicationOperation,
  ...parents: readonly ('projectId' | 'phaseId' | 'featureId' | 'taskId')[]
): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const parent of parents) {
    const value = params.get(parent);
    if (value === null) {
      reject(400, 'invalid_input', operation, `${operation} 必须携带 ${parent} 查询参数`, {
        field: `query.${parent}`,
        // snake_case 受控 reason（与 snapshot.get 的 missing_project_id 同一纪律）。
        reason: `missing_${parent.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)}`,
      });
    }
    query[parent] = value;
  }
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    if (!/^(0|[1-9]\d{0,2})$/.test(limitRaw)) {
      reject(400, 'invalid_input', operation, 'limit 必须是十进制整数文本', {
        field: 'query.limit',
        reason: 'invalid_integer',
      });
    }
    query.limit = Number(limitRaw);
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    query.cursor = cursor;
  }
  return query;
}

/* ------------------------------------------------------------------ *
 * 请求处理
 * ------------------------------------------------------------------ */

export interface ApplicationRequestInput {
  readonly app: HostApplicationContext;
  /** Bearer 凭据（仅用于 timingSafeEqual 比较，绝不进入响应）。 */
  readonly authToken: string;
  /** 套接字实际端口（Host 头精确比对）。 */
  readonly port: number;
  readonly route: ResolvedAppRoute;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  /** 原始查询串（不含 `?`）。 */
  readonly rawQuery: string;
}

function authenticateOrReject(request: IncomingMessage, authToken: string, operation: string): void {
  if (!bearerCredentialMatches(request, authToken)) {
    rejectUnauthorized(operation);
  }
}

/** 宿主/来源校验（§7.2 沿用）：Host 头必须恰为 127.0.0.1:<端口>；任何 Origin 拒绝。 */
function verifyHostAndOrigin(
  request: IncomingMessage,
  port: number,
  operation: string,
): void {
  if (request.headers.host !== `127.0.0.1:${port}`) {
    rejectUnauthorized(operation);
  }
  if (request.headers.origin !== undefined) {
    rejectUnauthorized(operation);
  }
}

async function handleCommandSubmit(
  input: ApplicationRequestInput,
  parsedBody: unknown,
): Promise<void> {
  const { app, request, response } = input;
  const operation: ApplicationOperation = 'commands.submit';

  // §5.1 冻结顺序：信封严格结构与字段类型（400）在凭据之前；schema 版本与
  // 未知操作（400/501）在凭据之后（不跨越认证暴露版本/能力存在性）。
  let deferred: PublicError | undefined;
  try {
    validateCommandEnvelope(parsedBody);
  } catch (error) {
    if (isPublicError(error, 'invalid_input')) {
      reject(error.httpStatus, error.code, error.operation, error.message, error.details);
    }
    if (isPublicError(error)) {
      deferred = error;
    } else {
      throw error;
    }
  }
  authenticateOrReject(request, input.authToken, operation);
  if (deferred !== undefined) {
    reject(deferred.httpStatus, deferred.code, deferred.operation, deferred.message, deferred.details);
  }
  // quiescing/stopping/starting：新变更明确拒绝（503 not_ready），业务状态不变；
  // 只读查询不受影响。accepted 活动计数恒 0（idle-only），无需等待在途命令。
  if (app.getLifecycleState() !== 'ready') {
    reject(503, 'not_ready', operation, 'Host 正在停止，拒绝新的变更命令', {
      reason: 'host_quiescing',
    });
  }

  // P02-3 / F-014（§5.3）：baseline.run 提交到执行编排（accepted 回执提交后
  // 异步启动检查进程）；其余命令仍走 commandService。信封结构已在上方通过
  // 校验（deferred 分支已拒绝），此处仅按已验证的操作名分流。
  let envelopeOperation: string | undefined;
  try {
    envelopeOperation = validateCommandEnvelope(parsedBody).operation;
  } catch {
    envelopeOperation = undefined;
  }
  const receipt =
    envelopeOperation === 'baseline.run'
      ? await app.baselineExecutionService.submit(app.principal, parsedBody)
      : await app.commandService.submit(app.principal, parsedBody);
  // §5.3：accepted → 202（F-008 首次启用，仅 baseline.run authorize）；
  // completed → 200；业务 rejected → 按 §5.7 唯一映射，响应体仍是回执。
  const status =
    receipt.status === 'accepted'
      ? 202
      : receipt.status === 'completed'
        ? 200
        : publicErrorHttpStatus(receipt.error.code);
  sendBoundedJson(response, status, receipt, MAX_APP_BODY_BYTES, operation);
}

async function handleRepositoryMoveConfirm(input: ApplicationRequestInput, parsedBody: unknown): Promise<void> {
  const { app, request, response, route } = input;
  const operation = route.operation;
  authenticateOrReject(request, input.authToken, operation);
  if (input.rawQuery !== '') reject(400, 'invalid_input', operation, '仓库移动确认不接受查询参数');
  if (app.getLifecycleState() !== 'ready') reject(503, 'not_ready', operation, 'Host 未就绪');
  if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    reject(400, 'invalid_input', operation, '仓库移动确认请求必须是对象');
  }
  const body = parsedBody as Record<string, unknown>;
  const allowed = ['projectId', 'preview', 'decision', 'commandId', 'issuedAt', 'expiresAt'];
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    reject(400, 'invalid_input', operation, '仓库移动确认包含未知字段', { field: 'body' });
  }
  if (body.projectId !== route.pathParam?.value) {
    reject(400, 'invalid_input', operation, '仓库移动确认项目不匹配', { field: 'body.projectId' });
  }
  if (typeof body.commandId !== 'string' || typeof body.issuedAt !== 'string') {
    reject(400, 'invalid_input', operation, '仓库移动确认缺少命令身份', { field: 'body.commandId' });
  }
  if (app.repositoryMoveService === undefined) reject(501, 'unsupported', operation, '仓库移动未装配');
  try {
    const plan = await app.repositoryMoveService.prepareConfirmation(app.principal, {
      preview: body.preview,
      decision: {
        schemaVersion: 1,
        projectId: body.projectId,
        oldBinding: (body.preview as { readonly oldBinding?: unknown }).oldBinding,
        previewDigest: (body.preview as { readonly previewDigest?: unknown }).previewDigest,
        decision: body.decision,
      },
    });
    const receipt = await app.commandService.submit(app.principal, {
      schemaVersion: 5,
      commandId: body.commandId,
      issuedAt: body.issuedAt,
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      operation: 'project.repository.rebind',
      scope: { kind: 'project', projectId: plan.projectId },
      expectedRevision: plan.expectedRevision,
      payload: {
        expectedBindingRevision: plan.expectedBindingRevision,
        expectedBindingId: plan.expectedBindingId,
        canonicalPath: plan.canonicalPath,
        gitCommonDir: plan.gitCommonDir,
        repoIdentity: plan.repoIdentity,
      },
    });
    const status = receipt.status === 'completed'
      ? 200
      : receipt.status === 'accepted'
        ? 202
        : publicErrorHttpStatus(receipt.error.code);
    sendBoundedJson(response, status, receipt, MAX_APP_BODY_BYTES, operation);
  } catch (error) {
    if (isStorageError(error)) {
      throw new CorePublicError(
        error.kind === 'conflict' ? 'conflict' : error.kind === 'ownership' ? 'forbidden' : error.kind === 'not_found' ? 'not_found' : error.kind === 'validation' ? 'invalid_input' : 'internal',
        operation,
        undefined,
        { details: { reason: 'repository_move_rejected' } },
      );
    }
    throw error;
  }
}

async function handleQuery(input: ApplicationRequestInput): Promise<void> {
  const { app, route, request, response } = input;
  const operation = route.operation;
  authenticateOrReject(request, input.authToken, operation);

  const params = parseQueryParams(input.rawQuery, operation);
  const pathParam = route.pathParam;

  if (operation === 'events.subscribe') {
    // F-012（§9.4）：装配了 SSE Hub 时接管为长连接事件流（此后响应由 Hub
    // 管理；建连前拒绝仍以 RouteReject/PublicError 抛出由外层序列化）；
    // 未装配保持明确 501（不宣告能力）。
    if (app.eventStreams === undefined) {
      reject(501, 'unsupported', operation, '事件订阅（SSE）未在本装配中启用', {
        reason: 'events_unsupported',
      });
    }
    const scope = buildSnapshotScope(params, operation);
    const cursor = params.get('cursor');
    const lastEventId = request.headers['last-event-id'];
    await app.eventStreams.handle({
      request,
      response,
      scope,
      ...(cursor !== null ? { cursor } : {}),
      ...(typeof lastEventId === 'string' && lastEventId.length > 0
        ? { lastEventId }
        : {}),
    });
    return;
  }

  if (operation === 'artifacts.get') {
    // P02-3 / F-014（§7.6）：正文不是 JSON——授权与完整性核验全部在 Core
    //（readBaselineOutput：能力/可见性/成员/核验失败统一 not_found 或
    // corrupt_state）；本层只做有界输出，绝不按请求路径读文件。
    const content = await app.baselineQueryService.readArtifactContent(
      app.principal,
      pathParam?.value,
    );
    if (content.byteSize > MAX_ARTIFACT_CONTENT_BYTES) {
      // Core 已保证上限；超限即装配不变量破坏，拒绝输出（不回业务内容）。
      sendJson(response, 500, internalBody(operation, 'response_budget_exceeded'));
      return;
    }
    sendTextContent(response, 200, content.content);
    return;
  }

  let result: unknown;
  switch (operation) {    case 'receipts.get':
      result = await app.commandReceiptsService.getReceipt(app.principal, pathParam?.value);
      break;
    case 'results.resolve':
      result = await app.commandReceiptsService.resolveResult(app.principal, pathParam?.value);
      break;
    case 'projects.list':
      result = await app.queryService.listProjects(
        app.principal,
        buildProjectListFilter(params, operation),
      );
      break;
    case 'projects.labelCounts':
      result = await app.queryService.countProjectLabels(app.principal);
      break;
    case 'projects.get':
      result = await app.queryService.getProject(app.principal, pathParam?.value);
      break;
    case 'projects.binding.get':
      result = await app.queryService.getRepositoryBinding(app.principal, pathParam?.value);
      break;
    case 'projects.inspect': {
      // §7.2：path 缺席是结构错误（400），不是 not_found；取值校验/授权/ Git
      // 读取全部在 Core（OnboardingService）完成，本层不解释路径语义。
      const repositoryPath = params.get('path');
      if (repositoryPath === null) {
        reject(400, 'invalid_input', operation, 'projects.inspect 必须携带 path 查询参数', {
          field: 'query.path',
          reason: 'missing_path',
        });
      }
      result = await app.onboardingService.inspectRepository(app.principal, repositoryPath);
      break;
    }
    case 'repository.move.preview': {
      const projectId = pathParam?.value;
      const repositoryPath = params.get('path');
      if (repositoryPath === null) {
        reject(400, 'invalid_input', operation, '仓库移动预览必须携带 path 查询参数', { field: 'query.path', reason: 'missing_path' });
      }
      if (app.repositoryMoveService === undefined) reject(501, 'unsupported', operation, '仓库移动未装配');
      result = await app.repositoryMoveService.preview(app.principal, { projectId, repositoryPath });
      break;
    }
    case 'knowledge.search':
    case 'knowledge.read':
    case 'memory.search': {
      const input: Record<string, unknown> = {};
      for (const [key, value] of params) {
        if (['version', 'limit', 'snippetMaxChars', 'maxReadBytes', 'maxCandidates'].includes(key)) {
          if (!/^[1-9]\d{0,8}$/.test(value)) reject(400, 'invalid_input', operation, '查询预算或版本必须为正整数');
          input[key] = Number(value);
        } else input[key] = value;
      }
      const projectId = pathParam!.value;
      if (operation === 'knowledge.search') {
        if (typeof app.knowledgeQueryService?.search !== 'function') reject(501, 'unsupported', operation, '知识检索未装配');
        result = await app.knowledgeQueryService.search(app.principal, projectId, input);
      } else if (operation === 'knowledge.read') {
        if (typeof app.knowledgeQueryService?.read !== 'function') reject(501, 'unsupported', operation, '知识读取未装配');
        const { documentId, version, ...options } = input;
        result = await app.knowledgeQueryService.read(app.principal, projectId, documentId as string, version as number | undefined, options);
      } else {
        if (typeof app.memoryQueryService?.search !== 'function') reject(501, 'unsupported', operation, '记忆检索未装配');
        result = await app.memoryQueryService.search(app.principal, projectId, input);
      }
      try {
        const checked = validateKnowledgeQueryResponse(operation, result);
        if (checked.projectId !== projectId) throw new Error('query_scope_mismatch');
      }
      catch { reject(500, 'internal', operation, '知识查询响应未通过契约校验'); }
      break;
    }
    case 'projects.profile.get':
      if (app.projectProfileService === undefined) reject(501, 'unsupported', operation, 'Profile 查询未在本装配中启用', { reason: 'profile_unsupported' });
      result = app.projectProfileService.getQuery(app.principal, pathParam?.value);
      break;
    case 'projects.profile.match': {
      if (app.projectProfileService === undefined) reject(501, 'unsupported', operation, 'Profile 匹配未在本装配中启用', { reason: 'profile_unsupported' });
      const projectId = pathParam?.value;
      result = {
        schemaVersion: 1,
        projectId,
        match: app.projectProfileService.matchTaskModules(app.principal, {
          projectId,
          directory: params.get('directory') ?? undefined,
          requiredModuleIds: params.getAll('requiredModuleId'),
          languages: params.getAll('language'),
          frameworks: params.getAll('framework'),
          scope: params.getAll('scope'),
        }),
      };
      break;
    }
    case 'projects.overview':
      result = await app.onboardingService.getProjectOverview(app.principal, pathParam?.value);
      break;
    case 'settings.global.get':
      result = await app.queryService.getGlobalSettings(app.principal);
      break;
    case 'settings.global.export':
      result = await app.queryService.exportGlobalSettings(app.principal);
      break;
    case 'settings.project.get':
      result = await app.queryService.getProjectSettings(app.principal, pathParam?.value);
      break;
    case 'settings.project.effective':
      result = await app.queryService.getEffectiveSettings(app.principal, pathParam?.value);
      break;
    case 'settings.project.export':
      result = await app.queryService.exportProjectSettings(app.principal, pathParam?.value);
      break;
    case 'snapshot.get':
      result = await app.queryService.getSnapshot(app.principal, buildSnapshotScope(params, operation));
      break;
    case 'baselines.list': {
      // §7.4：limit/cursor 形态转换（limit 必须是十进制整数文本；范围与
      // cursor 的 UUID 形态由 Core validateBaselineListQuery 单一权威复核）。
      const query: Record<string, unknown> = {};
      const limitRaw = params.get('limit');
      if (limitRaw !== null) {
        if (!/^(0|[1-9]\d{0,2})$/.test(limitRaw)) {
          reject(400, 'invalid_input', operation, 'limit 必须是十进制整数文本', {
            field: 'query.limit',
            reason: 'invalid_integer',
          });
        }
        query.limit = Number(limitRaw);
      }
      const cursor = params.get('cursor');
      if (cursor !== null) {
        query.cursor = cursor;
      }
      result = app.baselineQueryService.listBaselines(
        app.principal,
        pathParam?.value,
        Object.keys(query).length === 0 ? undefined : query,
      );
      break;
    }
    case 'project.resources.list':
      if (app.projectResourceService === undefined) reject(501, 'unsupported', operation, '项目资源查询未装配');
      result = app.projectResourceService.getConfiguration(app.principal, pathParam?.value as string);
      break;
    case 'project.resources.candidates': {
      if (app.projectResourceService === undefined) reject(501, 'unsupported', operation, '项目资源查询未装配');
      const sourceIds = params.getAll('sourceId');
      result = await app.projectResourceService.discoverCandidates(app.principal, pathParam?.value as string, sourceIds);
      break;
    }
    case 'project.resources.preview': {
      if (app.projectResourceService === undefined) reject(501, 'unsupported', operation, '项目资源查询未装配');
      const sourceIds = params.getAll('sourceId');
      const selectedResourceIds = params.getAll('selectedResourceId');
      result = await app.projectResourceService.previewCandidates(app.principal, pathParam?.value as string, sourceIds, selectedResourceIds);
      break;
    }
    case 'baselines.get':
      result = await app.baselineQueryService.getBaseline(app.principal, pathParam?.value);
      break;
    case 'baselines.compare': {
      const previousOperationId = params.get('previousOperationId');
      const currentOperationId = params.get('currentOperationId');
      if (previousOperationId === null || currentOperationId === null) {
        reject(400, 'invalid_input', operation, '基线比较必须携带 previousOperationId 和 currentOperationId', {
          reason: 'missing_comparison_identity',
        });
      }
      if (app.baselineComparisonService === undefined) reject(501, 'unsupported', operation, '基线比较未在本装配中启用');
      result = await app.baselineComparisonService.compareBaselines(app.principal, previousOperationId, currentOperationId);
      break;
    }
    // P03-1 / F-009 §6.6：计划域查询分发。传输层只做形态转换（父级必填、
    // limit 十进制整数文本）；授权/可见性/分页范围/游标全部由 Core 单一权威复核。
    case 'phases.list':
      result = await app.queryService.listPhases(
        app.principal,
        withEntityLabelFilter(params, buildPlanListQuery(params, operation, 'projectId')),
      );
      break;
    case 'phases.graph.get':
      result = await app.queryService.getPhaseGraph(app.principal, {
        ...buildPlanListQuery(params, operation, 'projectId'), phaseId: pathParam?.value,
      });
      break;
    case 'phases.get':
      result = await app.queryService.getPhase(app.principal, pathParam?.value);
      break;
    case 'features.list':
      result = await app.queryService.listFeatures(
        app.principal,
        withEntityLabelFilter(params, buildPlanListQuery(params, operation, 'projectId', 'phaseId')),
      );
      break;
    case 'features.get':
      result = await app.queryService.getFeature(app.principal, pathParam?.value);
      break;
    case 'tasks.list':
      result = await app.queryService.listTasks(
        app.principal,
        withEntityLabelFilter(params, buildPlanListQuery(params, operation, 'projectId', 'featureId')),
      );
      break;
    // P06-6 / F-007：四层标签 Run 列表（集合根 + 必填 projectId + 可选父级；
    // 取值/可见性/游标绑定全部由 Core 单一权威复核，查询零写入）。
    case 'runs.list': {
      const query = withEntityLabelFilter(params, buildPlanListQuery(params, operation, 'projectId'));
      for (const key of ['featureId', 'batchId']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      result = await app.queryService.listRuns(app.principal, query);
      break;
    }
    // P06-6 / F-007：四层实体标签去重计数（entity 枚举为结构参数；父级适用
    // 范围/标签语义由 Core 单一权威复核；不接受分页参数）。
    case 'labels.counts': {
      const entity = params.get('entity');
      if (entity === null) {
        reject(400, 'invalid_input', operation, 'labels.counts 必须携带 entity 查询参数', {
          field: 'query.entity',
          reason: 'missing_entity',
        });
      }
      if (entity !== 'phase' && entity !== 'feature' && entity !== 'task' && entity !== 'run') {
        reject(400, 'invalid_input', operation, "entity 必须是 'phase' | 'feature' | 'task' | 'run'", {
          field: 'query.entity',
          reason: 'invalid_entity',
        });
      }
      const query: Record<string, unknown> = { entity };
      const projectId = params.get('projectId');
      if (projectId === null) {
        reject(400, 'invalid_input', operation, 'labels.counts 必须携带 projectId 查询参数', {
          field: 'query.projectId',
          reason: 'missing_project_id',
        });
      }
      query.projectId = projectId;
      for (const key of ['phaseId', 'featureId', 'batchId']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      result = await app.queryService.getLabelCounts(app.principal, withEntityLabelFilter(params, query));
      break;
    }
    case 'tasks.get':
      result = await app.queryService.getTask(app.principal, pathParam?.value);
      break;
    case 'task.strategy.reapply.preview': {
      const projectId = params.get('projectId');
      const taskIds = params.getAll('taskId');
      const preview = await app.queryService.previewTaskStrategyReapplication(app.principal, { projectId, taskIds });
      result = toPublicTaskStrategyReapplicationPreview(preview);
      break;
    }
    // P03-2 / F-007：审批决策查询分发（授权/可见性由 Core 单一权威复核；
    // 不可见/不存在统一 not_found，不区分存在性）。
    case 'execution.budget.get':
    case 'execution.budget.revisions': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.batchId = pathParam?.value;
      result = operation === 'execution.budget.get'
        ? await app.queryService.getExecutionBudgetStatus(app.principal, query)
        : await app.queryService.listBatchBudgetRevisions(app.principal, query);
      break;
    }
    // P03-4 / F-008：调度诊断与 Attempt 审计查询分发（本层只做形态转换；
    // 授权/可见性折叠/分页范围/游标绑定全部由 Core 单一权威复核；跨项目与
    // 不存在目标统一 not_found，不区分存在性）。
    case 'execution.run.schedule': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.runId = pathParam?.value;
      result = await app.queryService.getRunScheduleStatus(app.principal, query);
      break;
    }
    case 'execution.sessions.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      for (const key of ['runId', 'taskId']) if (params.has(key)) query[key] = params.get(key);
      result = await app.queryService.listWorkSessions(app.principal, query);
      break;
    }
    case 'execution.session.get':
      result = await app.queryService.getWorkSession(app.principal, { projectId: params.get('projectId'), attemptId: pathParam?.value });
      break;
    case 'execution.session.evidence.get': {
      const evidence = await app.queryService.readWorkSessionEvidence(app.principal, {
        projectId: params.get('projectId'), attemptId: pathParam?.value, artifactId: params.get('artifactId') });
      result = { ...evidence, content: Buffer.from(evidence.content).toString('base64') };
      break;
    }
    // P04-5 / F-007：Work 公开记录分发（本层只做形态转换；授权/可见性折叠/
    // 父级三选一/分页/成员身份/正文完整性全部由 Core 单一权威复核；跨项目与
    // 不存在目标统一 not_found，不区分存在性；正文转 base64 同证据读取）。
    case 'execution.recording.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      for (const key of ['runId', 'attemptId', 'sessionId', 'recordType']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      result = await app.queryService.listWorkRecording(app.principal, query);
      break;
    }
    case 'execution.recording.body.get': {
      const query: Record<string, unknown> = { projectId: params.get('projectId'), artifactId: params.get('artifactId') };
      for (const key of ['runId', 'attemptId', 'sessionId']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      const body = await app.queryService.readWorkRecordingBody(app.principal, query);
      result = { ...body, content: Buffer.from(body.content).toString('base64') };
      break;
    }
    case 'execution.attempts.list':
      result = await app.queryService.listExecutionAttempts(
        app.principal,
        buildPlanListQuery(params, operation, 'projectId', 'taskId'),
      );
      break;
    case 'execution.attempt.diagnostics': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.attemptId = pathParam?.value;
      result = await app.queryService.listAttemptDiagnostics(app.principal, query);
      break;
    }
    // P04-9 / F-009：派发队列与槽位只读投影分发（本层只做形态转换；授权/
    // 可见性折叠/分页范围/游标绑定由 Core 单一权威复核；查询零写入，不认领、
    // 不扣预算、不唤醒执行、不释放槽位）。
    case 'execution.dispatch.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      for (const key of ['batchId', 'featureId']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      result = await app.queryService.listExecutionDispatchQueue(
        app.principal,
        query,
      );
      break;
    }
    case 'execution.resources.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      for (const key of ['batchId', 'featureId']) {
        if (params.has(key)) query[key] = params.get(key);
      }
      result = await app.queryService.listExecutionResources(app.principal, query);
      break;
    }
    // P03-7 / F-013：Task 机器证据/人审/返工链查询分发（本层只做形态转换；
    // 授权/可见性折叠/分页范围/游标绑定全部由 Core 单一权威复核；跨项目与
    // 不存在目标统一 not_found，不区分存在性）。
    case 'execution.task.verification.get':
      result = await app.queryService.getTaskVerification(app.principal, {
        projectId: params.get('projectId'),
        taskId: pathParam?.value,
      });
      break;
    case 'execution.task.approvals.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.taskId = pathParam?.value;
      result = await app.queryService.listTaskApprovalItems(app.principal, query);
      break;
    }
    case 'execution.task.rework-chain.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.taskId = pathParam?.value;
      result = await app.queryService.listTaskReworkChain(app.principal, query);
      break;
    }
    case 'features.approvals':
      result = await app.queryService.getFeatureApprovals(app.principal, pathParam?.value);
      break;
    // P03-8 / F-010：Feature 分轴结果查询分发（本层只做形态转换；授权/
    // 可见性折叠/身份校验全部由 Core 单一权威复核；跨项目与不存在目标
    // 统一 not_found，不区分存在性）。
    case 'features.report.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.featureId = pathParam?.value;
      result = await app.queryService.getFeatureReport(app.principal, query);
      break;
    }
    case 'features.delivery.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.featureId = pathParam?.value;
      result = await app.queryService.getFeatureDelivery(app.principal, query);
      break;
    }
    case 'integration.plan.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.integrationId = pathParam?.value;
      result = await app.queryService.getIntegrationPlan(app.principal, query);
      break;
    }
    // P03-9 / F-013：控制进度/恢复诊断查询分发（本层只做形态转换；授权/
    // 可见性折叠/身份校验全部由 Core 单一权威复核；跨项目与不存在目标
    // 统一 not_found，不区分存在性）。
    case 'execution.run.control.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.runId = pathParam?.value;
      result = await app.queryService.getRunControl(app.principal, query);
      break;
    }
    case 'execution.batch.delivery.get': {
      if (app.queryService.batchDeliveryAvailable !== true || typeof app.queryService.getBatchDelivery !== 'function') reject(501, 'unsupported', operation, 'Batch 收尾查询未装配');
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.batchId = pathParam?.value;
      result = await app.queryService.getBatchDelivery(app.principal, query);
      break;
    }
    case 'execution.batch.control.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.batchId = pathParam?.value;
      result = await app.queryService.getBatchControl(app.principal, query);
      break;
    }
    case 'execution.run.recovery.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.runId = pathParam?.value;
      result = await app.queryService.getRunRecovery(app.principal, query);
      break;
    }
    // P03-5 / F-011：工作区状态查询分发（本层只做形态转换；授权/可见性折叠/
    // 分页范围/游标绑定全部由 Core 单一权威复核；项目可见性失败 forbidden，
    // 项目内实体跨项目/不存在统一 not_found）。
    case 'workspaces.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      const featureId = params.get('featureId');
      if (featureId !== null) {
        query.featureId = featureId;
      }
      result = await app.queryService.listWorkspaces(app.principal, query);
      break;
    }
    case 'workspaces.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.featureId = pathParam?.value;
      result = await app.queryService.getWorkspace(app.principal, query);
      break;
    }
    case 'workspace.operations.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      const featureId = params.get('featureId');
      if (featureId !== null) {
        query.featureId = featureId;
      }
      result = await app.queryService.listWorkspaceOperations(app.principal, query);
      break;
    }
    case 'workspace.operations.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.operationId = pathParam?.value;
      result = await app.queryService.getWorkspaceOperation(app.principal, query);
      break;
    }
    // P03-8 / F-009：Git 操作查询分发（本层只做形态转换；授权/可见性折叠/
    // 父级二选一/分页范围/游标绑定全部由 Core 单一权威复核；跨项目与不存在
    // 目标统一 not_found，不区分存在性）。
    case 'git.repairs.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      result = await app.queryService.listGitAgentRepairs(app.principal, query);
      break;
    }
    case 'git.repairs.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.repairId = pathParam?.value;
      result = await app.queryService.getGitAgentRepair(app.principal, query);
      break;
    }
    case 'git.operations.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      const featureId = params.get('featureId');
      if (featureId !== null) {
        query.featureId = featureId;
      }
      const runId = params.get('runId');
      if (runId !== null) {
        query.runId = runId;
      }
      result = await app.queryService.listGitOperations(app.principal, query);
      break;
    }
    case 'git.operations.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.operationId = pathParam?.value;
      result = await app.queryService.getGitOperation(app.principal, query);
      break;
    }
    // P05-1 / F-012：规划上下文/候选查询分发（本层只做形态转换；授权/可见性
    // 折叠/分页范围/游标绑定/候选正文完整性全部由 Core 单一权威复核；跨项目
    // 与不存在目标统一 not_found，不区分存在性）。
    case 'planning.contexts.list': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      const featureId = params.get('featureId');
      if (featureId !== null) {
        query.featureId = featureId;
      }
      result = await app.planningQueryService.listPlanningContexts(app.principal, query);
      break;
    }
    case 'planning.context.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.candidateId = pathParam?.value;
      result = await app.planningQueryService.getPlanningContext(app.principal, query);
      break;
    }
    case 'planning.candidate.get': {
      const query = buildPlanListQuery(params, operation, 'projectId');
      query.candidateId = pathParam?.value;
      result = await app.planningQueryService.getPlanningCandidate(app.principal, query);
      break;
    }
    default:
      // 路由表与本分发必须一一对应；缺失是装配编程错误。
      throw new TypeError(`应用路由未接线：${operation}`);
  }
  sendBoundedJson(response, 200, result,
    operation === 'knowledge.read' ? MAX_KNOWLEDGE_READ_RESPONSE_BYTES
      : operation === 'knowledge.search' || operation === 'memory.search' ? MAX_KNOWLEDGE_SEARCH_RESPONSE_BYTES
      : operation === 'execution.session.evidence.get' || operation === 'execution.recording.body.get' ? MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES
      : operation === 'features.report.get' ? MAX_FEATURE_REPORT_RESPONSE_BYTES : MAX_APP_BODY_BYTES, operation);
}

/**
 * 应用路由统一处理（由生命周期传输面在路由解析后委派）。负责应用路由的
 * 体积限额读取、方法/查询串/Host/Origin/凭据校验与 Core 窄服务调用；
 * 绝不抛出未脱敏异常（自身兜底 500 internal 固定文案）。
 */
export async function handleApplicationRequest(input: ApplicationRequestInput): Promise<void> {
  const { route, request, response } = input;
  const operation = route.operation;
  try {
    // 传输层第 1 步：按路由限额读取请求体（超限即停读并关闭连接）。
    const bodyLimit = route.method === 'POST' ? MAX_APP_BODY_BYTES : MAX_HTTP_BODY_BYTES;
    const { body, exceeded } = await readLimitedBody(request, bodyLimit);
    if (exceeded) {
      reject(413, 'request_too_large', operation, `请求体超过 ${bodyLimit} 字节上限`, {
        reason: 'body_limit_exceeded',
        limitBytes: bodyLimit,
      });
    }
    if ((request.method ?? '') !== route.method) {
      reject(405, 'method_not_allowed', operation, `该路由只允许 ${route.method}`, {
        reason: 'method_not_allowed',
        allowedMethods: [route.method],
      });
    }
    if (route.method === 'GET' && body.length > 0) {
      reject(400, 'invalid_input', operation, 'GET 请求不允许携带请求体', {
        reason: 'get_with_body',
      });
    }
    if (Buffer.byteLength(input.rawQuery, 'utf8') > MAX_QUERY_STRING_BYTES) {
      reject(400, 'invalid_input', operation, `查询串超过 ${MAX_QUERY_STRING_BYTES} 字节上限`, {
        reason: 'query_string_too_large',
      });
    }
    verifyHostAndOrigin(request, input.port, operation);

    let parsedBody: unknown;
    if (route.method === 'POST') {
      const contentType = request.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        !contentType.toLowerCase().startsWith('application/json')
      ) {
        reject(400, 'invalid_input', operation, 'content-type 必须是 application/json', {
          reason: 'invalid_content_type',
        });
      }
      try {
        parsedBody = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        // 不回显请求体原文（可能夹带敏感材料）。
        reject(400, 'invalid_input', operation, '请求体不是合法 JSON', {
          reason: 'invalid_json',
        });
      }
    }

    if (operation === 'work.tools.invoke') {
      const bridge = input.app.workTools?.authenticate(request);
      if (bridge === undefined || bridge === null) rejectUnauthorized(operation);
      if (input.rawQuery !== '') reject(400, 'invalid_input', operation, '受限入口不接受查询参数');
      if (input.app.getLifecycleState() !== 'ready') reject(503, 'not_ready', operation, 'Host 未就绪');
      try {
        const result = await bridge.invoke(parsedBody);
        const status = 'status' in result && result.status === 'rejected' ? publicErrorHttpStatus(result.error.code) : 200;
        sendBoundedJson(response, status, result, MAX_APP_BODY_BYTES, operation);
      } catch (error) {
        // Core validation errors can contain field names supplied by the caller. The restricted
        // boundary returns controlled categories only, including authority/artifact failures.
        if (error instanceof WorkAccessError) {
          throw new CorePublicError('forbidden', operation, undefined, { details: { reason: error.reason } });
        }
        if (isStorageError(error)) {
          throw new CorePublicError(error.kind === 'validation' ? 'invalid_input'
            : error.kind === 'not_found' || error.kind === 'ownership' ? 'forbidden'
            : error.kind === 'conflict' ? 'conflict' : 'internal', operation);
        }
        if (isPublicError(error)) throw new CorePublicError(error.code, operation);
        throw error;
      }
      return;
    }
    if (operation === 'project.resources.sources.configure') {
      authenticateOrReject(request, input.authToken, operation);
      if (input.rawQuery !== '') reject(400, 'invalid_input', operation, '管理入口不接受查询参数');
      if (input.app.getLifecycleState() !== 'ready') reject(503, 'not_ready', operation, 'Host 未就绪');
      const service = input.app.projectResourceService;
      if (!service) reject(501, 'unsupported', operation, '来源管理未装配');
      if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)
        || (parsedBody as Record<string, unknown>).projectId !== route.pathParam?.value) {
        reject(400, 'invalid_input', operation, '来源管理项目不匹配');
      }
      try {
        sendBoundedJson(response, 200, await service.configureSource(input.app.principal, parsedBody), MAX_APP_BODY_BYTES, operation);
      } catch (error) {
        if (isStorageError(error)) {
          reject(error.kind === 'conflict' ? 409 : error.kind === 'ownership' ? 403 : error.kind === 'validation' ? 400 : 500,
            error.kind === 'conflict' ? 'conflict' : error.kind === 'ownership' ? 'forbidden' : error.kind === 'validation' ? 'invalid_input' : 'internal', operation, '来源管理请求被拒绝');
        }
        throw error;
      }
      return;
    }
    if (operation === 'repository.move.confirm') {
      await handleRepositoryMoveConfirm(input, parsedBody);
      return;
    }
    if (operation === 'commands.submit') {
      await handleCommandSubmit(input, parsedBody);
      return;
    }
    if (route.method !== 'GET') {
      // 当前应用路由除 commands 外全部为 GET；兜底拒绝（防御纵深）。
      reject(405, 'method_not_allowed', operation, `该路由只允许 ${route.method}`, {
        reason: 'method_not_allowed',
        allowedMethods: [route.method],
      });
    }
    await handleQuery(input);
  } catch (error) {
    if (error instanceof RouteReject) {
      sendJson(response, error.status, rejectBody(error));
      if (error.status === 413) {
        // 超限即关闭连接：不继续读取、不处理后续字节（§7.2）。
        response.on('finish', () => request.socket.destroy());
      }
      return;
    }
    if (isPublicError(error)) {
      sendJson(response, error.httpStatus, publicErrorBody(error));
      return;
    }
    // 未预期异常：统一 500 脱敏（不回显原始消息/堆栈/路径）。
    sendJson(response, 500, internalBody(operation, 'unexpected_internal'));
  }
}
