/**
 * F-002 Host 生命周期协议结构化错误（契约纯模块，无 I/O、无网络、无进程）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §7.3（结构化脱敏错误）、
 * §14（错误码与 HTTP 映射总表）。
 *
 * 约定：
 * - 每个错误携带 code、operation（操作身份）与受控 details（reasonCode、
 *   supported 列表、field/reason 等非秘密值），Host 与 CLI 只按 code 分支，
 *   不依赖错误文案匹配；
 * - 错误体绝不回显 token、Authorization 头、请求体原文、绝对路径、环境变量或
 *   堆栈；校验层 details 最多记录 field/reason/receivedType，不记录收到的值；
 * - 服务端码有唯一 HTTP 映射（§14）；仅客户端侧码没有 HTTP 状态（httpStatus
 *   为 undefined），不得把不同客户端错误折算成「发现不存在」；
 * - 本模块只定义错误类型与序列化形状，不导入 node:http（HTTP 适配在 F-007
 *   的非契约区），错误类自身不做任何 I/O。
 */

/** Host 生命周期操作身份（§7.3 错误体 operation；discovery 为本地读取操作）。 */
export const HOST_LIFECYCLE_OPERATIONS = [
  'host.discovery',
  'host.handshake',
  'host.status',
  'host.stop',
] as const;

/**
 * P02-2 §3.2 应用操作身份（与路由总表一一对应；F-013 起 HostClient 应用方法
 * 的客户端侧错误也使用这些身份；P02-3 / F-006 新增静态接入两项）。
 */
export const APP_OPERATIONS = [
  'knowledge.search', 'knowledge.read', 'memory.search',
  'work.tools.invoke',
  'commands.submit',
  'receipts.get',
  'results.resolve',
  'projects.list',
  'projects.get',
  'projects.binding.get',
  'projects.labelCounts',
  'projects.inspect',
  'projects.overview',
  'projects.profile.get',
  'projects.profile.match',
  'settings.global.get',
  'settings.global.export',
  'settings.project.get',
  'settings.project.effective',
  'settings.project.export',
  'snapshot.get',
  'events.subscribe',
  // P02-3 / F-014（§3.2/§7.4-§7.6）：基线分页、单次详情与有界证据正文读取。
  'baselines.list',
  'baselines.get',
  'baselines.compare',
  'artifacts.get',
  // P03-1 / F-009（§6.6）：计划域层级列表/详情/Task DAG 查询。
  'phases.list',
  'phases.get',
  'phases.graph.get',
  'features.list',
  'features.get',
  'tasks.list',
  'tasks.get',
  // P06-6 / F-007：四层标签 Run 列表与实体标签计数只读查询（能力位复用
  // project.read；与 Core runs.list / labels.counts 同步，不漂移）。
  'runs.list',
  'labels.counts',
  'task.strategy.reapply.preview',
  // P03-2 / F-007：Feature 审批决策查询（当前决定 vs 历史 + 有效批准核验）。
  'features.approvals',
  'execution.budget.get',
  'execution.budget.revisions',
  // P03-4 / F-008：Run 调度诊断与 Attempt/通知诊断审计只读查询。
  'execution.run.schedule',
  'execution.sessions.list',
  'execution.session.get',
  'execution.session.evidence.get',
  // P04-5 / F-007：Work 公开记录索引/有界正文只读查询（能力位复用
  // project.read；与 Core WORK_RECORDING_*_OPERATION 同步，不漂移）。
  'execution.recording.list',
  'execution.recording.body.get',
  'execution.attempts.list',
  'execution.attempt.diagnostics',
  // P03-7 / F-013：Task 机器证据/人审事项/有限返工链授权只读查询（能力位复用
  // project.read；与 Core TASK_EVIDENCE_QUERY_OPERATIONS 同步，不漂移）。
  'execution.task.verification.get',
  'execution.task.approvals.list',
  'execution.task.rework-chain.list',
  // P03-5 / F-011/F-012：工作区状态只读查询（服务端路由 F-011 已接线；
  // HostClient 入口属 F-012）。
  'workspaces.list',
  'workspaces.get',
  'workspace.operations.list',
  'workspace.operations.get',
  // P03-8 / F-009：Git 意图/实际提交/操作回执授权只读查询（能力位复用
  // project.read；与 Core GIT_OPERATION_QUERY_OPERATIONS 同步，不漂移）。
  'git.operations.list',
  'git.operations.get',
  'git.repairs.list',
  'git.repairs.get',
  // P03-8 / F-010：Feature 分轴结果授权只读查询（能力位复用 project.read；
  // 与 Core FEATURE_DELIVERY_QUERY_OPERATIONS 同步，不漂移）。
  'features.delivery.get',
  'features.report.get',
  // P05-6 / F-005：固定集成计划只读查询。
  'integration.plan.get',
  // P03-9 / F-013：Run/Batch 控制进度、恢复诊断与 finalization 收尾结果授权
  // 只读查询（能力位复用 project.read；与 Core
  // EXECUTION_CONTROL_QUERY_OPERATIONS 同步，不漂移）。
  'execution.run.control.get',
  'execution.batch.control.get',
  'execution.batch.delivery.get',
  'execution.run.recovery.get',
  // P04-9 / F-009：派发队列与执行槽位只读投影查询（无写入口；不提供 SQL、
  // 直接设置 owner/version 或释放槽位的外部接口）。
  'execution.dispatch.list',
  'execution.resources.list',
  // P05-1 / F-012：规划上下文/候选只读查询（与 Core PLANNING_QUERY_OPERATIONS
  // 同步，能力位复用 project.read，不漂移）。
  'planning.contexts.list',
  'planning.context.get',
  'planning.candidate.get',
  'project.resources.list',
  'project.resources.candidates',
  'project.resources.preview',
  'project.resources.sources.configure',
  'repository.move.confirm',
  'repository.move.preview',
] as const;

export const HOST_OPERATIONS = [
  ...HOST_LIFECYCLE_OPERATIONS,
  ...APP_OPERATIONS,
] as const;

export type HostOperation = (typeof HOST_OPERATIONS)[number];

/** §14 表中由服务端经 HTTP 返回的错误码（均有唯一状态码映射）。 */
export const SERVER_ERROR_CODES = [
  'invalid_input',
  'unsupported_schema_version',
  'request_digest_mismatch',
  'request_too_large',
  'unauthorized',
  'forbidden',
  'instance_mismatch',
  'data_root_mismatch',
  'conflict',
  'resource_busy',
  'not_ready',
  'protocol_incompatible',
  'unsupported',
  'unknown_operation',
  'method_not_allowed',
  'internal',
  // P02-2 应用面（§5.7 公开码经 HTTP 透传；F-011/F-012 服务端已产出）。
  'command_expired',
  'not_found',
  'corrupt_state',
  'snapshot_required',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/** §14 表中仅客户端侧存在、没有 HTTP 响应的错误码。 */
export const CLIENT_ONLY_ERROR_CODES = [
  'host_not_found',
  'unreachable',
  'response_malformed',
  'redirect_rejected',
  'owner_active',
  'owner_unknown',
  'unsafe_discovery',
  'invalid_discovery',
  'start_timeout',
  'stop_not_confirmed',
  'bind_address_override_rejected',
  'unsupported_platform',
  // P02-2 F-013：命令提交预算耗尽仍无法确定结果（客户端侧，保留 commandId 供查回执）。
  'outcome_unknown',
] as const;

export type ClientOnlyErrorCode = (typeof CLIENT_ONLY_ERROR_CODES)[number];

export type HostErrorCode = ServerErrorCode | ClientOnlyErrorCode;

/** §14 HTTP 状态映射（仅服务端码；键缺失即表示该码无 HTTP 状态）。 */
const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ServerErrorCode, number>> = Object.freeze({
  invalid_input: 400,
  unsupported_schema_version: 400,
  request_digest_mismatch: 400,
  request_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  instance_mismatch: 409,
  data_root_mismatch: 409,
  conflict: 409,
  resource_busy: 409,
  not_ready: 503,
  protocol_incompatible: 426,
  unsupported: 501,
  unknown_operation: 404,
  method_not_allowed: 405,
  internal: 500,
  command_expired: 400,
  not_found: 404,
  corrupt_state: 500,
  snapshot_required: 409,
});

/** 不含秘密的人类可读默认原因；具体调用可以覆盖，但覆盖文案同样不得含秘密。 */
const DEFAULT_MESSAGE_BY_CODE: Readonly<Record<HostErrorCode, string>> = Object.freeze({
  invalid_input: '请求未通过结构校验',
  unsupported_schema_version: '不支持的 schema 版本',
  request_digest_mismatch: '停止请求摘要核对失败',
  request_too_large: '请求体超过大小上限',
  unauthorized: '认证失败',
  forbidden: '授权被拒绝',
  instance_mismatch: 'Host 实例身份不匹配',
  data_root_mismatch: '数据根身份不匹配',
  conflict: '请求冲突',
  resource_busy: 'Host 资源占用中',
  not_ready: 'Host 尚未就绪',
  protocol_incompatible: 'Host 协议版本不兼容',
  unsupported: '请求的能力未实现',
  unknown_operation: '未知操作',
  method_not_allowed: '请求方法不允许',
  internal: 'Host 内部错误',
  command_expired: '命令已过期',
  not_found: '资源不存在',
  corrupt_state: '持久状态损坏或版本不受支持',
  snapshot_required: '恢复位置低于可续读下界，必须重取快照',
  host_not_found: '未发现运行中的 Host',
  unreachable: '无法连接到 Host',
  response_malformed: 'Host 响应结构不合法',
  redirect_rejected: '拒绝重定向（不会向新地址发送凭据）',
  owner_active: '已有可核验的活跃 Host 持有写入锁',
  owner_unknown: '写入锁被持有但无法核验持有者',
  unsafe_discovery: '发现文件不安全，拒绝信任',
  invalid_discovery: '发现文件无效',
  start_timeout: '等待 Host 启动超时',
  stop_not_confirmed: '无法确认 Host 已停止',
  bind_address_override_rejected: '拒绝覆盖监听地址（仅允许 127.0.0.1）',
  unsupported_platform: '当前平台不受支持（首版仅正式支持 macOS）',
  outcome_unknown: '命令提交结果不确定（预算耗尽；请按 commandId 查询回执）',
});

export interface HostProtocolErrorOptions {
  /** 受控诊断字段：只允许 reason 码、支持列表、field/reason、非秘密标识。 */
  readonly details?: Readonly<Record<string, unknown>>;
  /** 因果链保留在进程内，绝不进入错误体序列化。 */
  readonly cause?: unknown;
}

/** §7.3 错误体形状（toErrorBody 的返回类型）。 */
export interface HostErrorBody {
  readonly error: {
    readonly code: HostErrorCode;
    readonly message: string;
    readonly operation: HostOperation;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Host 生命周期协议唯一错误类型。
 *
 * 注意：`stack` 仅用于进程内诊断，`toErrorBody()`/JSON 序列化路径不包含堆栈；
 * 构造与抛出都不执行任何 I/O。
 */
export class HostProtocolError extends Error {
  readonly code: HostErrorCode;
  readonly operation: HostOperation;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: HostErrorCode,
    operation: HostOperation,
    message?: string,
    options: HostProtocolErrorOptions = {},
  ) {
    const finalMessage = message ?? DEFAULT_MESSAGE_BY_CODE[code];
    super(finalMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HostProtocolError';
    this.code = code;
    this.operation = operation;
    this.details = options.details;
  }

  /** 服务端码返回 §14 的 HTTP 状态；仅客户端码返回 undefined。 */
  get httpStatus(): number | undefined {
    return HTTP_STATUS_BY_ERROR_CODE[this.code as ServerErrorCode];
  }

  /**
   * 序列化为 §7.3 错误体：仅 code/message/operation/details，
   * 绝不包含 stack、cause、凭据或请求原文。
   */
  toErrorBody(): HostErrorBody {
    const body: HostErrorBody['error'] = {
      code: this.code,
      message: this.message,
      operation: this.operation,
    };
    if (this.details !== undefined) {
      (body as { details?: Readonly<Record<string, unknown>> }).details = this.details;
    }
    return { error: body };
  }
}

export function isHostProtocolError(value: unknown): value is HostProtocolError;
export function isHostProtocolError<C extends HostErrorCode>(
  value: unknown,
  code: C,
): value is HostProtocolError & { readonly code: C };
export function isHostProtocolError(value: unknown, code?: HostErrorCode): boolean {
  return (
    value instanceof HostProtocolError && (code === undefined || value.code === code)
  );
}
