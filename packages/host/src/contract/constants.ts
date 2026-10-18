/**
 * F-002 Host 生命周期协议冻结常量（契约纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md
 * - §5.1/§7.1：发现 schemaVersion 与线协议 protocolVersion 独立演进、独立校验；
 * - §5.1：唯一合法监听字面量 127.0.0.1 与三条路由；
 * - §7.2：16 384 B 体积上限与有限客户端预算；
 * - §6：锁获取有限预算；§10.2：quiesce 有限预算；
 * - §8/§10：冻结能力声明（graceful / idle-only）。
 *
 * P02-2（docs/p02-2-commands-events-contract.md §3.1/§15.4）：线消息
 * schemaVersion 显式升 2（握手 capabilities 从两个 unsupported 字面量演进为
 * §11.3 结构化视图，同版本号改形状违反未知键拒绝纪律）；发现 schemaVersion
 * 与线协议 protocolVersion 不变、不联动。§3.2 应用路由与 §13 预算同步冻结于此。
 *
 * 首版数值预算为有限默认值（§17.1 待核对项 3 / P02-2 §15.6）：调整必须有测试
 * 依据并回写契约，不得改为无界，也不得开放为用户可配的监听/安全放宽项。
 */

/** 发现文档结构版本（discovery.json）；未知值拒绝，不猜测降级。 */
export const DISCOVERY_SCHEMA_VERSION = 1 as const;

/**
 * 线消息结构版本（握手/stop/命令信封/回执/查询响应/快照）。与发现
 * schemaVersion 独立校验：未来其中一个升版不自动改变另一个。
 * P02-2 为 2；P02-3 / F-006 起为 3（§3.1/§15.5：握手能力视图新增
 * projects.inspect/overview，集合变化必须显式升版；2/1 → 400
 * unsupported_schema_version，不降级）；P03-1 / F-009 起为 4
 *（docs/p03-1-plan-import-contract.md §5/§9.6：计划域四命令与六查询进入握手
 * 能力集合，同一升版纪律）；P03-2 / F-007 起为 5（docs/p03-2-plan-approval-
 * contract.md：task.strategy.update/feature.plan.decide/execution.input.prepare
 * 三命令与 features.approvals 查询进入能力集合，同一升版纪律；旧 v4/v3/v2/v1
 * → 400，不猜测降级）。
 */
// P03-3 / F-011: execution capabilities are an additive v5 wiring change;
// application envelopes and query results remain on their existing versions.
// P03-4 / F-008：调度诊断/Attempt 审计三查询进入能力集合，同为 v5 内增量
// 接线变化（形状集新增不改动既有字段，同一纪律）。
export const CURRENT_SCHEMA_VERSION = 5 as const;

/** 当前 Host 生命周期线协议版本；本 Feature 只实现 v1。 */
export const CURRENT_PROTOCOL_VERSION = 1 as const;

/** 客户端/服务端共同支持的线协议版本集合（不兼容时 426 回传）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);

/** 唯一合法监听地址字面量；localhost/::1/0.0.0.0/域名/外网 IP 一律拒绝。 */
export const LOOPBACK_LISTEN_ADDRESS = '127.0.0.1';

/** §7.2 /v1/host/* 请求体与响应体字节上限。 */
export const MAX_HTTP_BODY_BYTES = 16_384;

/** P02-2 §3.2/§13：/v1/commands 请求/响应体与查询响应体字节上限（配置 v2 payload 更大）。 */
export const MAX_APP_BODY_BYTES = 65_536;

/** P02-2 §3.2/§13：GET 查询串（不含 `?`）字节上限。 */
export const MAX_QUERY_STRING_BYTES = 8_192;

/** §7.2 路由前缀与三条生命周期路由（无匿名路由、无 /health）。 */
export const HOST_ROUTE_PREFIX = '/v1/host/';
export const HANDSHAKE_ROUTE = '/v1/host/handshake';
export const STATUS_ROUTE = '/v1/host/status';
export const STOP_ROUTE = '/v1/host/stop';

/** P02-2 §3.2 应用路由（全部 Bearer 认证；事件路由在 F-012 接线前 501）。 */
export const COMMANDS_ROUTE = '/v1/commands';
export const RECEIPTS_ROUTE_PREFIX = '/v1/receipts/';
export const RESULTS_ROUTE_PREFIX = '/v1/results/';
export const PROJECTS_ROUTE = '/v1/projects';
export const PROJECT_LABEL_COUNTS_ROUTE = '/v1/projects/label-counts';
/** P02-3 / F-006 §3.2/§7.2：注册前只读仓库检查（字面量优先于 :projectId 形态）。 */
export const PROJECTS_INSPECT_ROUTE = '/v1/projects/inspect';
export const SETTINGS_GLOBAL_ROUTE = '/v1/settings/global';
export const SETTINGS_GLOBAL_EXPORT_ROUTE = '/v1/settings/global/export';
export const SNAPSHOT_ROUTE = '/v1/snapshot';
export const EVENTS_ROUTE = '/v1/events';
/** P02-3 / F-014 §3.2：基线分页/详情/证据正文路由（全部 GET + Bearer）。 */
export const BASELINES_ROUTE_PREFIX = '/v1/baselines/';
export const ARTIFACTS_ROUTE_PREFIX = '/v1/artifacts/';
export const ARTIFACT_CONTENT_ROUTE_SUFFIX = '/content';

/**
 * P03-1 / F-009 §6.6：计划域查询路由（全部 GET + Bearer；docs/p03-1-plan-import-
 * contract.md）。层级列表为集合根 + 查询参数（projectId/phaseId/featureId 是
 * Core 查询服务的显式输入，Host 不解析层级、不读 SQLite）；详情为单段路径
 * 参数。任何嵌套形态（如 /v1/phases/:id/features）未冻结 → 404 unknown_operation。
 */
export const PHASES_ROUTE = '/v1/phases';
export const PHASES_ROUTE_PREFIX = '/v1/phases/';
export const FEATURES_ROUTE = '/v1/features';
export const FEATURES_ROUTE_PREFIX = '/v1/features/';
/** P03-2 / F-007：Feature 审批决策子资源（GET /v1/features/:featureId/approvals）。 */
export const FEATURE_APPROVALS_ROUTE_SUFFIX = '/approvals';
/** P03-8 / F-010：Feature 分轴结果子资源（GET /v1/features/:featureId/delivery）。 */
export const FEATURE_DELIVERY_ROUTE_SUFFIX = '/delivery';
export const TASKS_ROUTE = '/v1/tasks';
export const TASKS_ROUTE_PREFIX = '/v1/tasks/';
/**
 * P03-7 / F-013：Task 机器证据/人审事项/有限返工链唯一冻结子资源形态
 * （GET /v1/tasks/:taskId/verification|approvals|rework-chain）；其他嵌套/
 * 多段形态一律未匹配 → 404 unknown_operation。
 */
export const TASK_VERIFICATION_ROUTE_SUFFIX = 'verification';
export const TASK_APPROVALS_ROUTE_SUFFIX = 'approvals';
export const TASK_REWORK_CHAIN_ROUTE_SUFFIX = 'rework-chain';
/** F-011: GET :batchId/budget and :batchId/budget/revisions; projectId is required. */
export const BATCHES_ROUTE_PREFIX = '/v1/batches/';
/**
 * P03-4 / F-008：Run 调度诊断与 Attempt/通知诊断审计只读查询路由（全部
 * GET + Bearer；与 Core EXECUTION_SCHEDULE_QUERY_OPERATIONS 一一对应）。
 * - GET /v1/runs/:runId/schedule?projectId=（单段路径参数 + 必填 projectId；
 *   与 /v1/batches/:batchId/budget 同一冻结形态）；
 * - GET /v1/attempts?projectId=&taskId=（集合根 + 父级身份查询参数，与
 *   /v1/tasks 列表同一纪律；分页 limit/cursor 复用计划规范）；
 * - GET /v1/attempts/:attemptId/diagnostics?projectId=（唯一冻结的 Attempt
 *   子资源形态）；其他嵌套/多段形态一律未匹配 → 404 unknown_operation。
 */
export const RUNS_ROUTE_PREFIX = '/v1/runs/';
export const RUN_SCHEDULE_ROUTE_SUFFIX = 'schedule';
/**
 * P03-9 / F-013：Run/Batch 控制进度、恢复诊断与 finalization 收尾结果只读
 * 查询路由（全部 GET + Bearer；与 Core EXECUTION_CONTROL_QUERY_OPERATIONS
 * 一一对应）。
 * - GET /v1/runs/:runId/control?projectId=（Run 控制进度；与 schedule 同一
 *   冻结形态）;
 * - GET /v1/batches/:batchId/control?projectId=（Batch 控制进度；与 budget
 *   同一冻结形态）；
 * - GET /v1/runs/:runId/recovery?projectId=（恢复诊断与 finalization 收尾
 *   结果）；其他嵌套/多段形态一律未匹配 → 404 unknown_operation。
 */
export const RUN_CONTROL_ROUTE_SUFFIX = 'control';
export const RUN_RECOVERY_ROUTE_SUFFIX = 'recovery';
export const BATCH_CONTROL_ROUTE_SUFFIX = 'control';
export const ATTEMPTS_ROUTE = '/v1/attempts';
export const ATTEMPTS_ROUTE_PREFIX = '/v1/attempts/';
export const ATTEMPT_DIAGNOSTICS_ROUTE_SUFFIX = 'diagnostics';
/**
 * P03-5 / F-011：工作区状态只读查询路由（全部 GET + Bearer；与 Core
 * WORKSPACE_QUERY_OPERATIONS 一一对应，docs/p03-5-workspace-host-integration-contract.md §4）。
 * - GET /v1/workspaces?projectId=&featureId?=&limit?=&cursor?=（集合根 +
 *   查询参数；Host 不解析归属、不读 SQLite）；
 * - GET /v1/workspaces/:featureId?projectId=（单段路径参数 + 必填 projectId）；
 * - GET /v1/workspace-operations?projectId=&featureId?=&limit?=&cursor?=；
 * - GET /v1/workspace-operations/:operationId?projectId=；
 * 其他嵌套/多段形态一律未匹配 → 404 unknown_operation。
 */
export const WORKSPACES_ROUTE = '/v1/workspaces';
export const WORKSPACES_ROUTE_PREFIX = '/v1/workspaces/';
export const WORKSPACE_OPERATIONS_ROUTE = '/v1/workspace-operations';
export const WORKSPACE_OPERATIONS_ROUTE_PREFIX = '/v1/workspace-operations/';
/**
 * P03-8 / F-009：Git 意图/实际提交/操作回执只读查询路由（全部 GET + Bearer；
 * 与 Core GIT_OPERATION_QUERY_OPERATIONS 一一对应）。
 * - GET /v1/git-operations?projectId=&featureId=|runId=&limit?=&cursor?=（集合根 +
 *   父级身份查询参数；父级二选一，分页 limit/cursor 复用计划规范）；
 * - GET /v1/git-operations/:operationId?projectId=（单段路径参数 + 必填
 *   projectId）；其他嵌套/多段形态一律未匹配 → 404 unknown_operation。
 */
export const GIT_OPERATIONS_ROUTE = '/v1/git-operations';
export const GIT_OPERATIONS_ROUTE_PREFIX = '/v1/git-operations/';

/** §7.2 客户端有限预算（毫秒）。 */
export const TCP_CONNECT_TIMEOUT_MS = 2_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const STATUS_TIMEOUT_MS = 10_000;
/** stop 整体预算 = 10 000 ms quiesce + 5 000 ms 余量（§7.2/§10.2）。 */
export const STOP_TIMEOUT_MS = 15_000;

/** §10.2 enterQuiesce 后等待活动收尾的有限预算。 */
export const QUIESCE_BUDGET_MS = 10_000;

/** P02-2 §13：客户端应用命令/查询单请求整体预算（毫秒）。 */
export const APP_REQUEST_TIMEOUT_MS = 10_000;

/**
 * P02-3 / F-014 §7.6/§13：artifacts.get 响应体上限（= 基线输出制品上限
 * 8 MiB；正文只来自已核验的正式制品，服务端 Core 保证不超限）。
 */
export const MAX_ARTIFACT_CONTENT_BYTES = 8_388_608;

/** Work evidence is JSON encoded base64 plus bounded metadata. */
export const MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES = Math.ceil(MAX_ARTIFACT_CONTENT_BYTES / 3) * 4 + MAX_APP_BODY_BYTES;

/**
 * P02-2 §11.2/§13：客户端提交一个逻辑命令（含超时后查回执与有限重发）的
 * 整体预算（毫秒）；耗尽仍未知 → outcome_unknown（§15.6 登记的实施值）。
 */
export const SUBMIT_COMMAND_BUDGET_MS = 30_000;

/** §6 每规范根 OS 排他锁获取的有限等待预算。 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

/** §10.1 唯一支持的停止模式与能力声明字面量。 */
export const STOP_MODE_GRACEFUL = 'graceful';
export const SUPPORTED_STOP_MODES: readonly string[] = Object.freeze([STOP_MODE_GRACEFUL]);
export const IDEMPOTENCY_SCHEME = 'commandId+requestDigest';
export const ACTIVITY_SCOPE_IDLE_ONLY = 'idle-only';
