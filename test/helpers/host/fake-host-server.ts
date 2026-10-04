/**
 * F-005 可编排伪 Host 服务（仅测试夹具，运行在测试进程内的真实 node:http）。
 *
 * 用途：给 F-007/F-009/F-013 的传输与客户端测试提供一个**真实监听 127.0.0.1**
 * 但行为可编排的对端，覆盖 F-005 验收 2 要求的全部负例：错误/缺失 token、
 * 旧实例、错误协议/schema、错误数据根、畸形响应、能力撒谎、3xx 重定向、延迟。
 *
 * 安全纪律：
 * - 只绑定字面量 127.0.0.1，端口由内核分配；不提供任何覆盖绑定地址的参数；
 * - 收到的 Authorization 头只做相等比较与分类（bearer/absent/other-scheme），
 *   原值不进 observations、不进证据、不进错误消息；
 * - 证据事件只记录方法/路由/HTTP 状态/分类/字节数等非秘密字段；请求体可经
 *   协议（握手/status/stop 体本就不含凭据）留在进程内 observations 供断言，
 *   但绝不写入 EvidenceLog；
 * - close() 有界关闭服务与全部连接，不留下监听套接字。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HostProtocolError,
  MAX_HTTP_BODY_BYTES,
  STATUS_ROUTE,
  STOP_ROUTE,
  assertStopTargetsCurrentInstance,
  ensureStopRequestSupported,
  validateStopRequestShape,
  verifyStopRequestDigest,
  type HostOperation,
  type LifecycleState,
  type StopOperationView,
  type ValidatedStopRequest,
} from '../../../packages/host/src/index.ts';
import type { EvidenceLog } from './evidence.ts';
import { redactRequestHeaders } from './evidence.ts';
import { loopbackRequest, type LoopbackRequestOptions, type LoopbackResponse } from './http-probe.ts';

const WRONG_TOKEN_COMPARISON = '0'.repeat(64);
const STALE_INSTANCE = '33333333-3333-4333-8333-333333333333';

export type HandshakeFault =
  | 'valid'
  | 'wrong-token'
  | 'missing-token'
  | 'stale-instance'
  | 'wrong-protocol'
  | 'wrong-schema'
  | 'wrong-data-root'
  | 'bad-lifecycle-state'
  | 'capability-lie'
  | 'malformed-json'
  | 'redirect'
  | 'delay';

export interface FakeServerBehavior {
  readonly expectedToken: string;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly lifecycleState?: LifecycleState;
  readonly handshakeFault?: HandshakeFault;
  readonly redirectTargetUrl?: string;
  readonly delayMs?: number;
  readonly startedAt?: string;
  /** status 响应中的活动计数（默认 0/0；F-008 受控假活动测试可覆盖）。 */
  readonly activities?: { readonly accepted: number; readonly quiescing: number };
  /** status 响应中的 stop 视图（默认 null）。 */
  readonly stopView?: StopOperationView | null;
  /** 伪服务自己上报的 pid（默认测试进程 pid）。 */
  readonly pidOverride?: number;
}

export interface FakeRequestObservation {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly httpStatus: number;
  readonly auth: 'bearer' | 'absent' | 'other-scheme';
  readonly originPresent: boolean;
  readonly hostMatched: boolean;
  readonly requestBytes: number;
  readonly contentType?: string;
  /** 仅在 JSON 成功解析时存在；协议请求体不含凭据，但仍禁止写入证据日志。 */
  readonly body?: unknown;
}

export interface FakeHostServer {
  readonly address: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  readonly requests: readonly FakeRequestObservation[];
  setBehavior(patch: Partial<FakeServerBehavior>): void;
  jsonRequest(
    method: 'GET' | 'POST',
    path: string,
    options?: Omit<LoopbackRequestOptions, 'port' | 'method' | 'path'>,
  ): Promise<LoopbackResponse>;
  close(): Promise<void>;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readLimitedBody(request: IncomingMessage, limit: number): Promise<{ body: Buffer; exceeded: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return; // 超限后停止收集（继续排空以允许 413 响应先发出）
      }
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise({ body: Buffer.concat(chunks), exceeded }));
    request.on('error', rejectPromise);
  });
}

export async function startFakeHostServer(
  initialBehavior: FakeServerBehavior,
  deps: { evidence?: EvidenceLog } = {},
): Promise<FakeHostServer> {
  let behavior: FakeServerBehavior = { handshakeFault: 'valid', ...initialBehavior };
  const observations: FakeRequestObservation[] = [];
  let seq = 0;
  const sockets = new Set<import('node:net').Socket>();
  const stopHistory = new Map<string, { requestDigest: string; view: StopOperationView }>();
  const startedAt = new Date().toISOString();

  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? '';
    const path = (request.url ?? '').split('?')[0] ?? '';
    const sanitizedHeaders = redactRequestHeaders(request.headers);
    let httpStatus = 0;
    let parsedBody: unknown;
    let requestBytes = 0;

    const send = (status: number, payload: unknown, extraHeaders?: Record<string, string>): void => {
      httpStatus = status;
      const text = payload === null ? '' : JSON.stringify(payload);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
      });
      response.end(text);
    };
    const sendError = (error: HostProtocolError): void => {
      send(error.httpStatus ?? 500, error.toErrorBody());
    };

    try {
      const { body: rawBody, exceeded } = await readLimitedBody(request, MAX_HTTP_BODY_BYTES);
      requestBytes = exceeded ? MAX_HTTP_BODY_BYTES + 1 : rawBody.length;
      if (exceeded) {
        sendError(new HostProtocolError('request_too_large', 'host.handshake', '请求体超过大小上限'));
        response.on('finish', () => request.destroy());
        return;
      }
      if (method === 'GET' && rawBody.length > 0) {
        sendError(new HostProtocolError('invalid_input', 'host.status', 'GET 请求不允许携带请求体'));
        return;
      }

      let operation: HostOperation | undefined;
      if (path === HANDSHAKE_ROUTE) {
        operation = 'host.handshake';
      } else if (path === STATUS_ROUTE) {
        operation = 'host.status';
      } else if (path === STOP_ROUTE) {
        operation = 'host.stop';
      }
      if (!operation) {
        sendError(new HostProtocolError('unknown_operation', 'host.handshake', `未知路由：${path}`));
        return;
      }
      const expectedMethod = operation === 'host.status' ? 'GET' : 'POST';
      if (method !== expectedMethod) {
        sendError(new HostProtocolError('method_not_allowed', operation, `该路由只允许 ${expectedMethod}`));
        return;
      }

      if (behavior.delayMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, behavior.delayMs));
      }

      // §7.2：携带任何 Origin 即拒绝；Host 必须恰为 127.0.0.1:<port>。
      if (sanitizedHeaders.originPresent) {
        sendError(new HostProtocolError('unauthorized', operation, '携带 Origin 的本机请求被拒绝'));
        return;
      }
      const hostMatched = sanitizedHeaders.host === `127.0.0.1:${(server.address() as { port: number }).port}`;
      if (!hostMatched) {
        sendError(new HostProtocolError('unauthorized', operation, 'Host 头与实际监听不一致'));
        return;
      }

      const fault = behavior.handshakeFault ?? 'valid';
      if (fault === 'missing-token' || sanitizedHeaders.auth !== 'bearer') {
        sendError(new HostProtocolError('unauthorized', operation, '认证失败'));
        return;
      }
      const expected = fault === 'wrong-token' ? WRONG_TOKEN_COMPARISON : behavior.expectedToken;
      const provided = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(provided, expected)) {
        sendError(new HostProtocolError('unauthorized', operation, '认证失败'));
        return;
      }

      if (method === 'POST') {
        if (!sanitizedHeaders.contentType || !sanitizedHeaders.contentType.toLowerCase().startsWith('application/json')) {
          sendError(new HostProtocolError('invalid_input', operation, 'content-type 必须是 application/json'));
          return;
        }
        if (rawBody.length > 0) {
          try {
            parsedBody = JSON.parse(rawBody.toString('utf8')) as unknown;
          } catch {
            sendError(new HostProtocolError('invalid_input', operation, '请求体不是合法 JSON'));
            return;
          }
        }
      }

      if (operation === 'host.handshake') {
        if (fault === 'redirect') {
          httpStatus = 302;
          response.writeHead(302, {
            location: behavior.redirectTargetUrl ?? '',
            'cache-control': 'no-store',
          });
          response.end();
          return;
        }
        const success = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          hostInstanceId: behavior.hostInstanceId,
          dataRootIdentity: behavior.dataRootIdentity,
          lifecycleState: (behavior.lifecycleState ?? 'ready') as LifecycleState,
          startedAt: behavior.startedAt ?? startedAt,
          capabilities: CURRENT_HOST_CAPABILITIES,
        };
        if (fault === 'stale-instance') {
          send(200, { ...success, hostInstanceId: STALE_INSTANCE });
          return;
        }
        if (fault === 'wrong-protocol') {
          send(200, { ...success, protocolVersion: 99 });
          return;
        }
        if (fault === 'wrong-schema') {
          send(200, { ...success, schemaVersion: 99 });
          return;
        }
        if (fault === 'wrong-data-root') {
          send(200, { ...success, dataRootIdentity: WRONG_TOKEN_COMPARISON });
          return;
        }
        if (fault === 'bad-lifecycle-state') {
          send(200, { ...success, lifecycleState: 'running' });
          return;
        }
        if (fault === 'capability-lie') {
          send(200, {
            ...success,
            capabilities: { ...CURRENT_HOST_CAPABILITIES, events: 'streaming' },
          });
          return;
        }
        if (fault === 'malformed-json') {
          httpStatus = 200;
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end('{oops');
          return;
        }
        send(200, success);
        return;
      }

      if (operation === 'host.status') {
        const activities = behavior.activities ?? { accepted: 0, quiescing: 0 };
        send(200, {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          hostInstanceId: behavior.hostInstanceId,
          dataRootIdentity: behavior.dataRootIdentity,
          lifecycleState: behavior.lifecycleState ?? 'ready',
          pid: behavior.pidOverride ?? process.pid,
          startedAt: behavior.startedAt ?? startedAt,
          activities,
          stop: behavior.stopView === undefined ? null : behavior.stopView,
        });
        return;
      }

      // host.stop：结构/版本/摘要/实例校验，再做进程内幂等（伪服务回执，
      // 不是产品回执表——契约 §10.4 的真实行为由 F-008 实现）。
      let validated: ValidatedStopRequest;
      try {
        validated = validateStopRequestShape(parsedBody);
        ensureStopRequestSupported(validated);
        verifyStopRequestDigest(validated);
        assertStopTargetsCurrentInstance(validated, behavior.hostInstanceId);
      } catch (error) {
        if (error instanceof HostProtocolError) {
          sendError(error);
          return;
        }
        throw error;
      }
      const previous = stopHistory.get(validated.commandId);
      if (previous && previous.requestDigest !== validated.requestDigest) {
        sendError(new HostProtocolError('conflict', 'host.stop', '同 commandId 携带了不同请求摘要'));
        return;
      }
      const view: StopOperationView = previous
        ? { ...previous.view, replayed: true }
        : {
            commandId: validated.commandId,
            status: 'completed',
            stopState: 'stopping',
            replayed: false,
          };
      if (!previous) {
        stopHistory.set(validated.commandId, { requestDigest: validated.requestDigest, view });
      }
      send(200, view);
    } catch (error) {
      const protocolError = new HostProtocolError(
        'internal',
        'host.handshake',
        error instanceof Error ? error.message : '伪服务内部错误',
      );
      if (httpStatus === 0) {
        sendError(protocolError);
      }
    } finally {
      const hostHeader = sanitizedHeaders.host ?? '';
      const hostMatched = hostHeader === `127.0.0.1:${(server.address() as { port: number } | null)?.port ?? 0}`;
      const observation: FakeRequestObservation = {
        seq: (seq += 1),
        method,
        path,
        httpStatus: httpStatus || 0,
        auth: sanitizedHeaders.auth,
        originPresent: sanitizedHeaders.originPresent,
        hostMatched,
        requestBytes,
        contentType: sanitizedHeaders.contentType,
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      };
      observations.push(observation);
      deps.evidence?.record('fake-http.exchange', {
        seq: observation.seq,
        method,
        path,
        httpStatus: observation.httpStatus,
        auth: observation.auth,
        originPresent: observation.originPresent,
        hostMatched,
        requestBytes,
      });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('伪服务监听地址非法');
  }
  const port = address.port;

  const facade: FakeHostServer = {
    address: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    requests: observations,
    setBehavior(patch: Partial<FakeServerBehavior>): void {
      behavior = { ...behavior, ...patch };
    },
    jsonRequest(method, requestPath, options = {}): Promise<LoopbackResponse> {
      return loopbackRequest({ port, method, path: requestPath, ...options });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections?.();
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
  return facade;
}
