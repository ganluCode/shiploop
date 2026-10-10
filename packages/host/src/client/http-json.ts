/**
 * F-009 HostClient 的回环 JSON 传输原语（client/ 非契约基础设施面）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §7.2/§12.1：
 * - 只连接字面量 127.0.0.1（发现文件给出的固定端口）；不解析主机名、不连接
 *   其他地址；绝不跟随重定向（3xx 一律 redirect_rejected，不向新地址重发
 *   凭据）；
 * - 有限预算：TCP 连接预算与请求整体预算分离，任何超时/断连都是
 *   unreachable 的可区分子原因，不折算成「发现不存在」；
 * - 响应体上限 16 384 B，超限即销毁连接并判 response_malformed；
 * - 每请求独立连接（agent:false，服务端 connection: close），客户端不保留
 *   空闲套接字；close 语义见 host-client.ts（本模块无全局状态）；
 * - 凭据只经 Authorization 头发送；错误消息/details 只含受控 reason 与
 *   errno 码，绝不回显凭据、请求头或响应原文。
 *
 * 本模块只做单请求传输与传输级错误分类；握手/status/stop 的结构校验与
 * 双向核验由 host-client.ts 调用契约纯函数完成。
 */
import { request, type ClientRequest } from 'node:http';
import {
  MAX_HTTP_BODY_BYTES,
  HostProtocolError,
  type HostErrorCode,
  type HostOperation,
} from '../contract/index.js';

export interface LoopbackJsonRequestOptions {
  readonly port: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly operation: HostOperation;
  /** Bearer 凭据；只进入 Authorization 请求头。 */
  readonly token: string;
  /** JSON 请求体（POST）；GET 不允许携带。 */
  readonly body?: unknown;
  /** TCP 连接建立预算（毫秒）。 */
  readonly connectTimeoutMs: number;
  /** 请求整体预算（含完整响应体读取，毫秒）。 */
  readonly overallTimeoutMs: number;
  /** 响应体字节上限（默认 §7.2 的 16 384）。 */
  readonly maxResponseBytes?: number;
  /** 中止信号（owner 探测等场景）；中止按 unreachable/aborted 处理。 */
  readonly signal?: AbortSignal;
}

export interface LoopbackJsonResponse {
  readonly statusCode: number;
  /** 已解析的 JSON 响应体（空体/畸形 JSON 在本层即拒绝）。 */
  readonly json: unknown;
}

/** P02-3 / F-014（§7.6）：text/plain 正文响应（artifacts.get；空体合法）。 */
export type LoopbackTextResponse =
  | { readonly statusCode: number; readonly ok: true; readonly text: string; readonly byteSize: number }
  | { readonly statusCode: number; readonly ok: false; readonly json: unknown };

function unreachable(
  operation: HostOperation,
  reason: string,
  cause?: unknown,
): HostProtocolError {
  const causeCode = (cause as NodeJS.ErrnoException | null)?.code;
  return new HostProtocolError('unreachable', operation, '无法在有限预算内完成 Host 请求', {
    details: causeCode ? { reason, causeCode } : { reason },
    cause,
  });
}

function malformedResponse(operation: HostOperation, reason: string): HostProtocolError {
  return new HostProtocolError('response_malformed', operation, 'Host 响应不符合线协议', {
    details: { reason },
  });
}

/**
 * 对 127.0.0.1:<port> 发单个 HTTP/1.1 请求并完整读取响应体（字节级）。
 * 任何失败都以 HostProtocolError 拒绝；不抛未分类异常。JSON/文本的解析与
 * 内容类型把关由调用方完成。
 */
function requestLoopbackRaw(
  options: LoopbackJsonRequestOptions,
): Promise<{ statusCode: number; contentType: string | undefined; body: Buffer }> {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_HTTP_BODY_BYTES;
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    let req: ClientRequest | undefined;

    const cleanup = (): void => {
      clearTimeout(overallTimer);
      clearTimeout(connectTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: HostProtocolError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      req?.destroy();
      rejectPromise(error);
    };
    const overallTimer = setTimeout(() => {
      fail(unreachable(options.operation, connected ? 'request_timeout' : 'connect_timeout'));
    }, options.overallTimeoutMs);
    const connectTimer = setTimeout(() => {
      fail(unreachable(options.operation, 'connect_timeout'));
    }, options.connectTimeoutMs);
    const onAbort = (): void => {
      fail(unreachable(options.operation, 'aborted'));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      fail(unreachable(options.operation, 'aborted'));
      return;
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      host: `127.0.0.1:${options.port}`,
    };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload, 'utf8'));
    }

    req = request(
      {
        host: '127.0.0.1',
        family: 4,
        port: options.port,
        method: options.method,
        path: options.path,
        agent: false,
        headers,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        // §7.2/§12.1：绝不跟随重定向；不向新地址重发凭据。
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          fail(
            new HostProtocolError('redirect_rejected', options.operation, '拒绝重定向（不会向新地址发送凭据）', {
              details: { reason: 'redirect_rejected', statusCode },
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            response.destroy();
            fail(malformedResponse(options.operation, 'response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          const contentType = response.headers['content-type'];
          resolvePromise({
            statusCode,
            contentType: typeof contentType === 'string' ? contentType : undefined,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', (error) => {
          fail(unreachable(options.operation, 'connection_lost', error));
        });
      },
    );
    req.on('socket', (socket) => {
      socket.once('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });
    req.on('error', (error) => {
      fail(unreachable(options.operation, connected ? 'connection_lost' : 'connect_failed', error));
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * 对 127.0.0.1:<port> 发单个 HTTP/1.1 JSON 请求并完整读取响应。
 * 任何失败都以 HostProtocolError 拒绝；不抛未分类异常。
 */
export async function requestLoopbackJson(options: LoopbackJsonRequestOptions): Promise<LoopbackJsonResponse> {
  const raw = await requestLoopbackRaw(options);
  const bodyText = raw.body.toString('utf8');
  if (bodyText.length === 0) {
    throw malformedResponse(options.operation, 'empty_body');
  }
  try {
    return { statusCode: raw.statusCode, json: JSON.parse(bodyText) as unknown };
  } catch {
    throw malformedResponse(options.operation, 'invalid_json');
  }
}

/**
 * P02-3 / F-014（§7.6）：text/plain 正文请求（artifacts.get）。2xx 的
 * content-type 必须是 text/plain（否则 response_malformed，绝不把
 * JSON/HTML 当证据正文）；非 2xx 按 JSON 错误体返回（调用方走
 * mapErrorResponse），空体/非 JSON → response_malformed。
 */
export async function requestLoopbackText(options: LoopbackJsonRequestOptions): Promise<LoopbackTextResponse> {
  const raw = await requestLoopbackRaw(options);
  if (raw.statusCode < 200 || raw.statusCode >= 300) {
    // 非 2xx：正文必须是 JSON 错误体（交回调用方走 mapErrorResponse）。
    const bodyText = raw.body.toString('utf8');
    if (bodyText.length === 0) {
      throw malformedResponse(options.operation, 'empty_body');
    }
    try {
      return { statusCode: raw.statusCode, ok: false, json: JSON.parse(bodyText) as unknown };
    } catch {
      throw malformedResponse(options.operation, 'invalid_json');
    }
  }
  const contentType = raw.contentType?.toLowerCase() ?? '';
  if (!contentType.startsWith('text/plain')) {
    throw malformedResponse(options.operation, 'content_type_not_text_plain');
  }
  return {
    statusCode: raw.statusCode,
    ok: true,
    text: raw.body.toString('utf8'),
    byteSize: raw.body.length,
  };
}

/** §14：响应体中的服务端错误码白名单（仅服务端码；客户端码不可能来自线上）。 */
const SERVER_ERROR_CODE_SET: ReadonlySet<string> = new Set([
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
  // P02-2 应用面（§5.7 公开码 + §9.4 SSE 建连前拒绝）。
  'command_expired',
  'not_found',
  'corrupt_state',
  'snapshot_required',
]);

/** 允许从服务端错误体透传的受控 details 键（§7.3；其余一律丢弃）。 */
const SAFE_DETAIL_KEYS = [
  'reason',
  'reasonCode',
  'field',
  'receivedType',
  'supportedProtocolVersions',
  'supportedSchemaVersions',
  'supportedModes',
  'activityScope',
  'unsupportedCapability',
  'commandId',
  // P02-2：CAS 冲突修订号与 snapshot_required 的重取快照指引（§9.4）。
  'expectedRevision',
  'actualRevision',
  'snapshotRoute',
] as const;

function sanitizeDetailValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.length <= 16 && value.every((item) => typeof item === 'string')) {
    return (value as string[]).map((item) => (item.length > 200 ? item.slice(0, 200) : item));
  }
  return undefined;
}

/**
 * 非 2xx 响应 → 结构化错误。只信任白名单错误码与受控 details 键；
 * 服务端 message 不透传（防对端在文案中夹带秘密），错误文案以客户端
 * 受控默认文案为准。形态不符 → response_malformed。
 */
export function mapErrorResponse(
  statusCode: number,
  json: unknown,
  operation: HostOperation,
): HostProtocolError {
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const error = (json as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code;
      if (typeof code === 'string' && SERVER_ERROR_CODE_SET.has(code)) {
        const rawDetails = (error as Record<string, unknown>).details;
        const details: Record<string, unknown> = { httpStatus: statusCode };
        if (typeof rawDetails === 'object' && rawDetails !== null && !Array.isArray(rawDetails)) {
          for (const key of SAFE_DETAIL_KEYS) {
            const sanitized = sanitizeDetailValue((rawDetails as Record<string, unknown>)[key]);
            if (sanitized !== undefined) {
              details[key] = sanitized;
            }
          }
        }
        return new HostProtocolError(code as HostErrorCode, operation, undefined, { details });
      }
    }
  }
  return malformedResponse(operation, 'error_body_malformed');
}
