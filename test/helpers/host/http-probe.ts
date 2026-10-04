/**
 * F-005 最小本机 HTTP 探针（仅测试夹具）。
 *
 * 这不是 F-009 的 HostClient：不做发现读取、不做握手核验、不映射错误码，
 * 只负责对 127.0.0.1:<port> 发**单个** HTTP/1.1 请求并完整读取响应：
 * - 绝不跟随重定向（node:http 原生不跟随；3xx 原样返回，调用方据此断言）；
 * - 连接/整体响应有有限超时；响应体有字节上限，超限立即销毁连接；
 * - 只连接字面量 127.0.0.1，不接受主机名/外网地址（伪服务也只绑定回环）；
 * - 返回原始 headers 仅供受控断言；**禁止**把 headers/响应原文写入证据日志。
 */
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';

export interface LoopbackRequestOptions {
  readonly port: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** 发送 `Authorization: Bearer <token>`；undefined 表示不带认证头。 */
  readonly token?: string;
  /** JSON 请求体（与 rawBody 二选一）。 */
  readonly body?: unknown;
  /** 原样请求体（超大/畸形测试用）。 */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface LoopbackResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  json(): unknown;
}

export class LoopbackProbeError extends Error {
  readonly causeCode: string | undefined;
  constructor(message: string, causeCode?: string) {
    super(message);
    this.name = 'LoopbackProbeError';
    this.causeCode = causeCode;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32_768;

export function loopbackRequest(options: LoopbackRequestOptions): Promise<LoopbackResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const payload =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;

  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (payload !== undefined) {
    if (headers['Content-Type'] === undefined && headers['content-type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
    headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'));
  }

  return new Promise<LoopbackResponse>((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host: '127.0.0.1',
        family: 4,
        port: options.port,
        method: options.method,
        path: options.path,
        headers,
        timeout: timeoutMs,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            aborted = true;
            response.destroy();
            req.destroy();
            rejectPromise(new LoopbackProbeError(`响应体超过 ${maxResponseBytes} 字节上限`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (aborted) {
            return;
          }
          const headerMap: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) {
              headerMap[key] = Array.isArray(value) ? value.join(',') : value;
            }
          }
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: headerMap,
            bodyText,
            json(): unknown {
              return JSON.parse(bodyText) as unknown;
            },
          });
        });
        response.on('error', (error) => {
          if (!aborted) {
            rejectPromise(new LoopbackProbeError(error.message, (error as NodeJS.ErrnoException).code));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new LoopbackProbeError(`请求在 ${timeoutMs}ms 内未完成`));
    });
    req.on('error', (error) => {
      rejectPromise(new LoopbackProbeError(error.message, (error as NodeJS.ErrnoException).code));
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}
