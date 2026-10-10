/**
 * Host 传输面共享底层原语（runtime 内部基础设施；P02-1 F-007 抽取，
 * P02-2 F-011 起由生命周期传输面与应用传输面共用）。
 *
 * 规则落实（契约 §7.2 / P02-2 §3.2）：
 * - 有界请求体读取：超过上限即停止收集并标记（继续排空由连接关闭承担）；
 * - 响应永不发 CORS 头、永不含 3xx；`cache-control: no-store`、
 *   `connection: close`（不留持久空闲连接，拆卸与资源占用有界）；
 * - 凭据只从 `Authorization: Bearer <token>` 读取，timingSafeEqual 比较；
 *   缺失/方案错误/长度不符/值不符全部返回 false（子原因不可区分），
 *   凭据绝不进入任何返回值、日志或响应。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不读 argv/env。
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 传输面拒绝：携带已脱敏响应体的内部控制流（绝不携带秘密/原文/路径）。
 * 由生命周期传输面与应用传输面（含 F-012 SSE）共用；抛出方负责只放受控
 * details（白名单 reason/field/snapshotRoute 等），捕获方统一序列化。
 */
export class RouteReject extends Error {
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
    this.name = 'RouteReject';
    this.status = status;
    this.code = code;
    this.operation = operation;
    this.detailMessage = detailMessage;
    this.details = details;
  }
}

/** 抛出 RouteReject（控制流拒绝；不产生任何业务副作用）。 */
export function rejectRoute(
  status: number,
  code: string,
  operation: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new RouteReject(status, code, operation, message, details);
}

/** 有界请求体读取：超过上限即停止收集并标记（继续排空由连接关闭承担）。 */
export function readLimitedBody(
  request: IncomingMessage,
  limit: number,
): Promise<{ body: Buffer; exceeded: boolean }> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
    };
    const finish = (exceeded: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRead({ body: exceeded ? Buffer.alloc(0) : Buffer.concat(chunks), exceeded });
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRead(error);
    };
    const onAborted = () => onError(new Error('请求体读取被中断'));
    const onEnd = () => finish(false);
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        // Stop consuming now; the caller sends 413 before closing the socket.
        request.pause();
        finish(true);
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
    // Keep the error handler until close to absorb late errors after a 413.
    request.once('close', () => {
      cleanup();
      request.off('error', onError);
    });
  });
}

/** 发送 JSON 响应（已序列化文本）；每响应关闭连接，永不带 CORS 头。 */
export function sendJsonText(response: ServerResponse, status: number, text: string): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 每响应关闭连接：不留持久空闲连接，拆卸与资源占用有界（§7.2）。
    connection: 'close',
  });
  response.end(text);
}

/** 序列化并发送 JSON 响应。 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  sendJsonText(response, status, JSON.stringify(payload));
}

/**
 * 发送脱敏证据正文（text/plain；P02-3 / F-014 artifacts.get）：正文由 Core
 * 授权与完整性核验后提供；每响应关闭连接，永不带 CORS 头。
 */
export function sendTextContent(response: ServerResponse, status: number, content: Uint8Array): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    // 每响应关闭连接：不留持久空闲连接，拆卸与资源占用有界（§7.2）。
    connection: 'close',
    'content-length': content.length,
  });
  response.end(content);
}

/**
 * Bearer 凭据比较：任何子原因（缺失/方案/长度/值）都是同一 false。
 * 凭据只用于 timingSafeEqual 比较，从不进入响应。
 */
export function bearerCredentialMatches(request: IncomingMessage, authToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const match = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (match === null) {
    return false;
  }
  const provided = Buffer.from(match[1] as string, 'utf8');
  const expected = Buffer.from(authToken, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
