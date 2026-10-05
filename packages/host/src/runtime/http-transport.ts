/**
 * F-007 Host 生命周期 HTTP 传输面（契约 §7.2 传输规则、§8 握手校验顺序、
 * §9 只读状态、§14 错误码与 HTTP 映射）。
 *
 * 规则落实：
 * - 仅三条生命周期路由；未知路由 404、方法不允许 405（details 给允许方法），
 *   无匿名路由、无 /health 类免认证端点；
 * - 握手校验顺序按 §8 冻结：传输层（方法/路由/Host/Origin/体积/JSON）→
 *   严格结构 → 凭据（timingSafeEqual，缺失/错误/陈旧不可区分 401）→
 *   schema 版本（400）→ 协议版本（426）→ 实例（409）→ 数据根（409）；
 * - Host 头必须恰为 `127.0.0.1:<实际端口>`；携带任何 Origin 一律 401；
 *   无 Origin 的合法 CLI 请求可通过；响应永不发 CORS 头、永不含 3xx；
 * - 凭据只从 `Authorization: Bearer <token>` 读取；URL/query、请求体、错误
 *   响应均不携带、不回显凭据；
 * - 体积上限 16 384 B（413），超限停止读取并关闭连接；GET 带体 400；
 *   POST content-type 必须 application/json（字符集后缀允许）；畸形 JSON 400
 *   且不回显原文；
 * - 有界资源：headersTimeout/requestTimeout 为内部常量（§17.1 预算项，
 *   requestTimeout 覆盖 §10 的 10 s quiesce 预算）；每个响应
 *   `connection: close`，不留持久空闲连接；
 * - status 只读零副作用：只读装配上下文（内存值），不写库、不改文件、
 *   不触发 quiesce；
 * - stop 路由在 F-008 接线前：经完整传输与认证校验后返回 501 unsupported
 *   （details.reason = stop_not_wired；§14「请求未实现能力」），绝不触发
 *   停止、文件删除或数据库写入；
 * - 未预期异常统一 500 internal 脱敏（不回显原始消息/堆栈/路径）；仅客户端
 *   错误码（httpStatus undefined）逃逸到传输面同样折算 500，不外泄内部细节。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不读 argv/env；只有
 * createHostLifecycleServer 显式调用才创建（未监听的）Server。
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HostProtocolError,
  LOOPBACK_LISTEN_ADDRESS,
  MAX_HTTP_BODY_BYTES,
  STATUS_ROUTE,
  STOP_ROUTE,
  ensureHandshakeVersionCompatibility,
  parseJsonBody,
  validateHandshakeRequestShape,
} from '../contract/index.js';
import type {
  HandshakeResponse,
  HostOperation,
  HostStatusResponse,
  LifecycleState,
  StopOperationView,
} from '../contract/index.js';

/**
 * §7.2 服务端有界资源（内部常量，§17.1 数值预算项）：
 * 完整请求头接收上限 5 s；整个请求（含 F-008 stop 的 quiesce 等待）上限 15 s。
 */
export const SERVER_HEADERS_TIMEOUT_MS = 5_000;
export const SERVER_REQUEST_TIMEOUT_MS = 15_000;

/** status 的活动计数来源（P02-1 生产恒 {0,0}；F-008 受控假活动经注入覆盖）。 */
export interface HostActivityCounts {
  readonly accepted: number;
  readonly quiescing: number;
}

/**
 * 传输面只读装配上下文：全部为内存值/取值器，传输面自身不做任何文件、
 * 数据库或进程 I/O。authToken 只用于 timingSafeEqual 比较，从不进入响应。
 */
export interface HostLifecycleContext {
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly authToken: string;
  getLifecycleState(): LifecycleState;
  getActivities(): HostActivityCounts;
  getStopView(): StopOperationView | null;
}

interface ResolvedRoute {
  readonly operation: HostOperation;
  readonly method: 'GET' | 'POST';
}

const ROUTES: Readonly<Record<string, ResolvedRoute>> = Object.freeze({
  [HANDSHAKE_ROUTE]: Object.freeze({ operation: 'host.handshake' as const, method: 'POST' as const }),
  [STATUS_ROUTE]: Object.freeze({ operation: 'host.status' as const, method: 'GET' as const }),
  [STOP_ROUTE]: Object.freeze({ operation: 'host.stop' as const, method: 'POST' as const }),
});

function unauthorized(operation: HostOperation): HostProtocolError {
  // §4.2/§14：缺失/错误/陈旧 token 与 Origin/Host 不符共用不可区分的 401。
  return new HostProtocolError('unauthorized', operation, '认证失败', {
    details: { reason: 'authentication_failed' },
  });
}

/** 有界请求体读取：超过上限即停止收集并标记（继续排空由连接关闭承担）。 */
function readLimitedBody(
  request: IncomingMessage,
  limit: number,
): Promise<{ body: Buffer; exceeded: boolean }> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveRead({ body: Buffer.concat(chunks), exceeded }));
    request.on('error', rejectRead);
  });
}

/** timingSafeEqual 凭据比较：任何子原因（缺失/方案/长度/值）都是同一 401。 */
function authenticate(request: IncomingMessage, context: HostLifecycleContext, operation: HostOperation): void {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    throw unauthorized(operation);
  }
  const match = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (match === null) {
    throw unauthorized(operation);
  }
  const provided = Buffer.from(match[1] as string, 'utf8');
  const expected = Buffer.from(context.authToken, 'utf8');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw unauthorized(operation);
  }
}

function actualPort(server: Server, operation: HostOperation): number {
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new HostProtocolError('internal', operation, '监听地址不可用（已脱敏）', {
      details: { reason: 'address_unavailable' },
    });
  }
  return address.port;
}

function buildHandshakeResponse(context: HostLifecycleContext): HandshakeResponse {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: context.hostInstanceId,
    dataRootIdentity: context.dataRootIdentity,
    lifecycleState: context.getLifecycleState(),
    startedAt: context.startedAt,
    capabilities: CURRENT_HOST_CAPABILITIES,
  };
}

function buildStatusResponse(context: HostLifecycleContext): HostStatusResponse {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: context.hostInstanceId,
    dataRootIdentity: context.dataRootIdentity,
    lifecycleState: context.getLifecycleState(),
    pid: context.pid,
    startedAt: context.startedAt,
    activities: context.getActivities(),
    stop: context.getStopView(),
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) {
    return;
  }
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 每响应关闭连接：不留持久空闲连接，拆卸与资源占用有界（§7.2）。
    connection: 'close',
  });
  response.end(text);
}

async function handleRequest(
  server: Server,
  context: HostLifecycleContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? '';
  // 路由匹配只看路径部分；query 不参与路由（凭据绝不允许出现在 URL，§4.2）。
  const path = (request.url ?? '').split('?')[0] ?? '';
  const route = ROUTES[path];
  // 未知路由的 fallback 操作身份与 F-005 伪服务一致（host.handshake）。
  const operation: HostOperation = route?.operation ?? 'host.handshake';

  try {
    // 传输层第 1 步：体积有界读取（任何路由都先限体积，保证资源占用有界）。
    const { body, exceeded } = await readLimitedBody(request, MAX_HTTP_BODY_BYTES);
    if (exceeded) {
      const tooLarge = new HostProtocolError(
        'request_too_large',
        operation,
        `请求体超过 ${MAX_HTTP_BODY_BYTES} 字节上限`,
        { details: { reason: 'body_limit_exceeded', limitBytes: MAX_HTTP_BODY_BYTES } },
      );
      sendJson(response, 413, tooLarge.toErrorBody());
      // 超限即关闭连接：不继续读取、不处理后续字节。
      response.on('finish', () => request.socket.destroy());
      return;
    }
    if (route === undefined) {
      // 不回显路径（可能夹带敏感材料）。
      throw new HostProtocolError('unknown_operation', operation, '未知操作', {
        details: { reason: 'unknown_route' },
      });
    }
    if (method !== route.method) {
      throw new HostProtocolError('method_not_allowed', operation, `该路由只允许 ${route.method}`, {
        details: { reason: 'method_not_allowed', allowedMethods: [route.method] },
      });
    }
    if (method === 'GET' && body.length > 0) {
      throw new HostProtocolError('invalid_input', operation, 'GET 请求不允许携带请求体', {
        details: { reason: 'get_with_body' },
      });
    }
    // Host 头必须恰为 127.0.0.1:<实际端口>；任何 Origin 一律拒绝（§7.2）。
    if (request.headers.host !== `${LOOPBACK_LISTEN_ADDRESS}:${actualPort(server, operation)}`) {
      throw unauthorized(operation);
    }
    if (request.headers.origin !== undefined) {
      throw unauthorized(operation);
    }

    // POST 传输层校验：content-type 与 JSON 解析（§8 第 1 步；不回显原文）。
    let parsedBody: unknown;
    if (method === 'POST') {
      const contentType = request.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        !contentType.toLowerCase().startsWith('application/json')
      ) {
        throw new HostProtocolError('invalid_input', operation, 'content-type 必须是 application/json', {
          details: { reason: 'invalid_content_type' },
        });
      }
      parsedBody = parseJsonBody(body.toString('utf8'), operation);
    }

    if (route.operation === 'host.handshake') {
      // §8 冻结顺序：结构（2）→ 凭据（3）→ 版本（4/5）→ 实例（6）→ 数据根（7）。
      const shape = validateHandshakeRequestShape(parsedBody);
      authenticate(request, context, operation);
      ensureHandshakeVersionCompatibility(shape);
      if (shape.hostInstanceId !== context.hostInstanceId) {
        throw new HostProtocolError('instance_mismatch', operation, 'Host 实例身份不匹配', {
          details: { reason: 'instance_mismatch' },
        });
      }
      if (shape.dataRootIdentity !== context.dataRootIdentity) {
        throw new HostProtocolError('data_root_mismatch', operation, '数据根身份不匹配', {
          details: { reason: 'data_root_mismatch' },
        });
      }
      sendJson(response, 200, buildHandshakeResponse(context));
      return;
    }

    if (route.operation === 'host.status') {
      // §9：仅认证；只读内存上下文，零副作用（不写库、不改文件、不触发 quiesce）。
      authenticate(request, context, operation);
      sendJson(response, 200, buildStatusResponse(context));
      return;
    }

    // host.stop：F-008 接线的停止流程。当前经完整传输与认证校验后明确拒绝，
    // 绝不触发停止、文件删除或数据库写入。
    authenticate(request, context, operation);
    throw new HostProtocolError('unsupported', operation, '停止流程尚未接线（后续任务提供）', {
      details: { reason: 'stop_not_wired' },
    });
  } catch (error) {
    if (error instanceof HostProtocolError && error.httpStatus !== undefined) {
      sendJson(response, error.httpStatus, error.toErrorBody());
      return;
    }
    // 未预期异常与仅客户端码逃逸：统一 500 脱敏，不回显原始消息/堆栈/路径。
    sendJson(
      response,
      500,
      new HostProtocolError('internal', operation, 'Host 内部错误（已脱敏）', {
        details: { reason: 'unexpected_internal' },
      }).toErrorBody(),
    );
  }
}

/**
 * 创建 Host 生命周期传输面 Server（未监听；监听与地址核验由启动装配完成）。
 * 有界超时在此装配；调用方负责 close()/closeAllConnections() 拆卸。
 */
export function createHostLifecycleServer(context: HostLifecycleContext): Server {
  const server = createServer((request, response) => {
    handleRequest(server, context, request, response).catch(() => {
      // handleRequest 内部已脱敏兜底；此处只防御发送失败（如连接已断）。
      try {
        request.socket.destroy();
      } catch {
        // 忽略：socket 销毁失败无进一步可做的恢复。
      }
    });
  });
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  return server;
}
