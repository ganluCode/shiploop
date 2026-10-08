/**
 * F-011 应用命令/查询传输面（P02-2 契约 §3.2 路由总表、§5 命令/回执、
 * §7 查询与分页、§8 快照、§11.1 装配）。
 *
 * 规则落实：
 * - 只装配 §3.2 表内应用路由：POST /v1/commands、GET /v1/receipts/:commandId、
 *   GET /v1/results/:resultRef、项目/配置/快照 GET 查询；表外路径（含
 *   /v1/files、/v1/artifacts/.../content 与任何 path/locator 形态）由调用方
 *   落到 404 unknown_operation，本模块永不返回文件内容；
 * - /v1/events 在 F-012 SSE 接线前为已认证后的 501 unsupported（不宣告能力）；
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
import {
  isPublicError,
  publicErrorHttpStatus,
  validateCommandEnvelope,
} from 'shiploop-core';
import type {
  CommandReceiptsService,
  CommandService,
  PublicError,
  QueryService,
  TrustedPrincipal,
} from 'shiploop-core';
import {
  COMMANDS_ROUTE,
  EVENTS_ROUTE,
  MAX_APP_BODY_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_QUERY_STRING_BYTES,
  PROJECTS_ROUTE,
  PROJECT_LABEL_COUNTS_ROUTE,
  RECEIPTS_ROUTE_PREFIX,
  RESULTS_ROUTE_PREFIX,
  SETTINGS_GLOBAL_EXPORT_ROUTE,
  SETTINGS_GLOBAL_ROUTE,
  SNAPSHOT_ROUTE,
} from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import {
  bearerCredentialMatches,
  readLimitedBody,
  sendJson,
  sendJsonText,
} from './http-primitives.js';

/** 应用操作身份字面量（与 §3.2 路由总表一一对应；错误体 operation）。 */
export type ApplicationOperation =
  | 'commands.submit'
  | 'receipts.get'
  | 'results.resolve'
  | 'projects.list'
  | 'projects.get'
  | 'projects.binding.get'
  | 'projects.labelCounts'
  | 'settings.global.get'
  | 'settings.global.export'
  | 'settings.project.get'
  | 'settings.project.effective'
  | 'settings.project.export'
  | 'snapshot.get'
  | 'events.subscribe';

/** 已解析的应用路由（path 形态匹配；路径参数为未解码原始片段）。 */
export interface ResolvedAppRoute {
  readonly operation: ApplicationOperation;
  readonly method: 'GET' | 'POST';
  readonly pathParam?: {
    readonly name: 'commandId' | 'projectId' | 'resultRef';
    readonly value: string;
  };
}

/**
 * 可信应用装配上下文：principal 由装配固定绑定（生产恒 local-owner；受限
 * 主体仅可信测试装配），服务为 shiploop-core 受控 assembly 的窄端口；
 * 本层不从请求数据取身份，不直接访问 SQLite。
 */
export interface HostApplicationContext {
  readonly principal: TrustedPrincipal;
  readonly commandService: CommandService;
  readonly queryService: QueryService;
  readonly commandReceiptsService: CommandReceiptsService;
  /** 生命周期状态读取：quiescing/stopping/starting 拒绝新变更（503）。 */
  getLifecycleState(): LifecycleState;
}

/**
 * §3.2 应用路由解析（只看路径部分；query 不参与路由）。
 * 未匹配返回 undefined（由调用方统一 404 unknown_operation）。
 * 注意：/v1/projects/label-counts 字面量优先于 :projectId 形态（稳定 ID
 * 「label-counts」项目在本路由表下不可经此路径寻址，属冻结路由取舍）。
 */
export function resolveAppRoute(path: string): ResolvedAppRoute | undefined {
  switch (path) {
    case COMMANDS_ROUTE:
      return { operation: 'commands.submit', method: 'POST' };
    case PROJECTS_ROUTE:
      return { operation: 'projects.list', method: 'GET' };
    case PROJECT_LABEL_COUNTS_ROUTE:
      return { operation: 'projects.labelCounts', method: 'GET' };
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

/** 传输面拒绝：携带已脱敏响应体的内部控制流（绝不携带秘密/原文）。 */
class AppRouteReject extends Error {
  readonly status: number;
  readonly code: string;
  readonly operation: string;
  readonly detailMessage: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    operation: string,
    detailMessage: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(detailMessage);
    this.name = 'AppRouteReject';
    this.status = status;
    this.code = code;
    this.operation = operation;
    this.detailMessage = detailMessage;
    this.details = details;
  }
}

function reject(
  status: number,
  code: string,
  operation: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new AppRouteReject(status, code, operation, message, details);
}

function rejectBody(error: AppRouteReject): AppErrorBody {
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
  'projects.list': Object.freeze({ allowed: ['limit', 'cursor', 'label', 'match'], repeatable: ['label'] }),
  'snapshot.get': Object.freeze({ allowed: ['scope', 'projectId'], repeatable: [] }),
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

  const receipt = await app.commandService.submit(app.principal, parsedBody);
  // §5.3：completed → 200；业务 rejected → 按 §5.7 唯一映射，响应体仍是回执。
  const status =
    receipt.status === 'completed' ? 200 : publicErrorHttpStatus(receipt.error.code);
  sendBoundedJson(response, status, receipt, MAX_APP_BODY_BYTES, operation);
}

async function handleQuery(input: ApplicationRequestInput): Promise<void> {
  const { app, route, request, response } = input;
  const operation = route.operation;
  authenticateOrReject(request, input.authToken, operation);

  if (operation === 'events.subscribe') {
    // F-012 接线前：已认证后的明确 501（握手能力同样不宣告 events）。
    reject(501, 'unsupported', operation, '事件订阅（SSE）在本版本尚未接线', {
      reason: 'events_unsupported',
    });
  }

  const params = parseQueryParams(input.rawQuery, operation);
  const pathParam = route.pathParam;

  let result: unknown;
  switch (operation) {
    case 'receipts.get':
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
    default:
      // 路由表与本分发必须一一对应；缺失是装配编程错误。
      throw new TypeError(`应用路由未接线：${operation}`);
  }
  sendBoundedJson(response, 200, result, MAX_APP_BODY_BYTES, operation);
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
    if (error instanceof AppRouteReject) {
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
