/**
 * F-004 原始 loopback SSE 测试客户端（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 与 F-013 产品 HostClient 的区别：本客户端是**传输层工具**，供 F-012/F-018
 * 在真实 127.0.0.1 HTTP 上验证服务端 SSE 语义（背压、断线、重连），刻意不做
 * 业务事件封套校验、发现/握手或重试策略；只解析 SSE 帧线格式。
 *
 * 能力（F-004 验收 2/4）：
 * - 真实 TCP（node:http），默认 127.0.0.1，不跟随重定向，不连接非环回地址；
 * - pauseConsumption()/resumeConsumption()：暂停读取 socket，制造真实 TCP
 *   背压（服务端 write() 返回 false / writableNeedDrain），用于 stream_overflow；
 * - close()：立即 destroy 连接（突然断开），有界等待底层 socket 关闭；
 * - reconnect()：销毁当前连接后以 Last-Event-ID（最后帧 id）+ 原 query 游标重连；
 * - 帧解析跨 chunk、跨多字节 UTF-8 边界（TextDecoder stream 模式）与 CRLF；
 *   心跳/注释行忽略；id/event/data 多行 data 按 SSE 规范以 \n 连接；
 * - 全部预算有界（建连/响应头/待解析帧缓冲/帧队列），失败也清理 socket 与定时器；
 * - 错误文本只含地址/路径/状态码，绝不含 Authorization/token。
 */
import { request, type IncomingMessage } from 'node:http';

export type SseClientErrorCode =
  | 'connect_failed'
  | 'connect_timeout'
  | 'headers_timeout'
  | 'non_sse_response'
  | 'buffer_overflow'
  | 'connection_reset'
  | 'aborted';

export class SseClientError extends Error {
  readonly code: SseClientErrorCode;
  readonly statusCode?: number;

  constructor(code: SseClientErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'SseClientError';
    this.code = code;
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
  }
}

export interface SseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

export interface SseConnectOptions {
  readonly port: number;
  readonly host?: string;
  readonly path?: string;
  /** Bearer 令牌；仅进入 Authorization 头，不进入错误/日志文本。 */
  readonly token?: string;
  /** 建连时携带的 Last-Event-ID 头（重连默认取最后帧 id）。 */
  readonly lastEventId?: string;
  /** query 参数 cursor= 的值。 */
  readonly cursor?: string;
  readonly extraHeaders?: Record<string, string>;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  /** 不完整帧待解析字节上限（默认 1 048 576，对齐契约服务端缓冲）。 */
  readonly maxBufferedBytes?: number;
  readonly abortSignal?: AbortSignal;
}

export interface SseConnection {
  readonly port: number;
  readonly host: string;
  readonly path: string;
  readonly statusCode: number;
  readonly bytesReceived: number;
  readonly eventsReceived: number;
  readonly lastEventId: string | undefined;
  readonly consumptionPaused: boolean;
  /** SSE 帧异步迭代（心跳已过滤）；连接错误以 SseClientError reject。 */
  events(): AsyncIterableIterator<SseFrame>;
  pauseConsumption(): void;
  resumeConsumption(): void;
  /** 用最后帧 id 作为 Last-Event-ID 重连；原连接被突然关闭。 */
  reconnect(overrides?: Partial<SseConnectOptions>): Promise<SseConnection>;
  /** 突然销毁 TCP 连接并有界等待底层 socket 关闭；幂等。 */
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/v1/events';
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const CLOSE_WAIT_MS = 1_000;
/** 帧队列高水位：消费者不及时取帧时自动暂停 socket，防止客户端无界缓冲。 */
const QUEUE_HIGH_WATERMARK = 256;
const QUEUE_LOW_WATERMARK = 64;

function buildRequestPath(path: string, cursor: string | undefined): string {
  if (cursor === undefined) {
    return path;
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}cursor=${encodeURIComponent(cursor)}`;
}

export function connectSseLoopback(inputOptions: SseConnectOptions): Promise<SseConnection> {
  const options = inputOptions;
  const host = options.host ?? DEFAULT_HOST;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    return Promise.reject(
      new SseClientError('connect_failed', `SSE 夹具只允许环回地址，实际：${host}`),
    );
  }
  const path = options.path ?? DEFAULT_PATH;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

  return new Promise<SseConnection>((resolveConnect, rejectConnect) => {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(options.extraHeaders ?? {}),
    };
    if (options.token !== undefined) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (options.lastEventId !== undefined) {
      headers['Last-Event-ID'] = options.lastEventId;
    }

    const req = request({
      hostname: host,
      port: options.port,
      method: 'GET',
      path: buildRequestPath(path, options.cursor),
      headers,
      // 每条连接独立 agent，destroy 即关闭，不借用共享 keep-alive 池。
      agent: false,
    });

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clearAllTimers = (): void => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };

    let settled = false;
    let socketClosed = false;
    let abortSignaled = options.abortSignal?.aborted === true;

    const failConnect = (code: SseClientErrorCode, message: string, statusCode?: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      req.destroy();
      rejectConnect(new SseClientError(code, message, statusCode));
    };

    const connectTimer = setTimeout(() => {
      failConnect('connect_timeout', `SSE 建连超时（${connectTimeoutMs}ms）${host}:${options.port}`);
    }, connectTimeoutMs);
    timers.add(connectTimer);
    const headersTimer = setTimeout(() => {
      failConnect('headers_timeout', `SSE 响应头超时（${headersTimeoutMs}ms）${host}:${options.port}`);
    }, headersTimeoutMs);
    timers.add(headersTimer);

    req.on('socket', (socket) => {
      socket.on('connect', () => {
        clearTimeout(connectTimer);
        timers.delete(connectTimer);
      });
      socket.on('close', () => {
        socketClosed = true;
      });
    });

    req.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (abortSignaled) {
        failConnect('aborted', 'SSE 连接被 AbortSignal 中断');
        return;
      }
      failConnect('connect_failed', `SSE 连接失败（${code ?? 'error'}）${host}:${options.port}`);
    });

    if (options.abortSignal && !options.abortSignal.aborted) {
      options.abortSignal.addEventListener(
        'abort',
        () => {
          abortSignaled = true;
          failConnect('aborted', 'SSE 连接被 AbortSignal 中断');
        },
        { once: true },
      );
    }
    if (abortSignaled) {
      failConnect('aborted', 'SSE 连接被 AbortSignal 中断');
      return;
    }

    req.on('response', (res) => {
      clearTimeout(headersTimer);
      timers.delete(headersTimer);
      if (settled) {
        res.destroy();
        return;
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200 || !contentType.includes('text/event-stream')) {
        res.resume();
        failConnect(
          'non_sse_response',
          `SSE 响应非事件流：HTTP ${res.statusCode ?? 0} ${host}:${options.port}${path}`,
          res.statusCode ?? undefined,
        );
        return;
      }
      settled = true;
      resolveConnect(
        createStreamConnection(res, {
          host,
          port: options.port,
          path,
          cursor: options.cursor,
          token: options.token,
          maxBufferedBytes,
          clearAllTimers,
          isSocketClosed: () => socketClosed,
          abortSignal: options.abortSignal,
        }),
      );
    });

    req.end();
  });
}

interface StreamConnectionInternals {
  host: string;
  port: number;
  path: string;
  cursor: string | undefined;
  /** 仅用于重连时重建 Authorization 头；不进错误文本/对外属性。 */
  token: string | undefined;
  maxBufferedBytes: number;
  clearAllTimers(): void;
  isSocketClosed(): boolean;
  abortSignal?: AbortSignal;
}

function parseFrame(rawFrame: string): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of rawFrame.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue; // 空行/注释心跳
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // 其余字段（retry 等）忽略。
  }
  if (dataLines.length === 0) {
    return undefined; // 无 data 的帧不计业务帧。
  }
  return { id, event, data: dataLines.join('\n') };
}

function createStreamConnection(
  res: IncomingMessage,
  internals: StreamConnectionInternals,
): SseConnection {
  const queue: SseFrame[] = [];
  const waiters: Array<(result: IteratorResult<SseFrame>) => void> = [];
  let terminalError: SseClientError | undefined;
  let streamEnded = false;
  let pendingText = '';
  let bytesReceived = 0;
  let eventsReceived = 0;
  let lastEventId: string | undefined;
  let manualPaused = false;
  let autoPaused = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const decoder = new TextDecoder('utf-8');

  const isPaused = (): boolean => manualPaused || autoPaused;

  const parseAvailable = (): void => {
    if (pendingText.includes('\r')) {
      pendingText = pendingText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    let boundary: number;
    while ((boundary = pendingText.indexOf('\n\n')) !== -1) {
      const rawFrame = pendingText.slice(0, boundary);
      pendingText = pendingText.slice(boundary + 2);
      const frame = parseFrame(rawFrame);
      if (frame) {
        if (Buffer.byteLength(frame.data, 'utf8') > internals.maxBufferedBytes) {
          fail(
            new SseClientError(
              'buffer_overflow',
              `SSE 单帧超过 ${internals.maxBufferedBytes}B 上限 ${internals.host}:${internals.port}`,
            ),
          );
          return;
        }
        eventsReceived += 1;
        if (frame.id !== undefined) {
          lastEventId = frame.id;
        }
        queue.push(frame);
      }
    }
    if (Buffer.byteLength(pendingText, 'utf8') > internals.maxBufferedBytes) {
      fail(
        new SseClientError(
          'buffer_overflow',
          `SSE 待解析帧超过 ${internals.maxBufferedBytes}B 上限 ${internals.host}:${internals.port}`,
        ),
      );
      return;
    }
    pump();
  };

  const pump = (): void => {
    while (queue.length > 0 && waiters.length > 0) {
      const frame = queue.shift()!;
      waiters.shift()!({ value: frame, done: false });
    }
    if (autoPaused && !manualPaused && queue.length <= QUEUE_LOW_WATERMARK) {
      autoPaused = false;
      if (!closed) {
        res.resume();
      }
    }
  };

  function fail(error: SseClientError): void {
    if (terminalError || streamEnded) {
      return;
    }
    terminalError = error;
    const pendingWaiters = waiters.splice(0);
    for (const waiter of pendingWaiters) {
      queueMicrotask(() => waiter({ value: undefined, done: true }));
    }
    if (!closed) {
      res.destroy();
    }
  }

  res.on('data', (chunk: Buffer) => {
    if (closed || terminalError) {
      return;
    }
    bytesReceived += chunk.length;
    pendingText += decoder.decode(chunk, { stream: true });
    parseAvailable();
    if (!isPaused() && queue.length >= QUEUE_HIGH_WATERMARK) {
      autoPaused = true;
      res.pause();
    }
  });
  res.on('end', () => {
    streamEnded = true;
    const pendingWaiters = waiters.splice(0);
    for (const waiter of pendingWaiters) {
      waiter({ value: undefined, done: true });
    }
  });
  res.on('error', (error) => {
    if (closed) {
      return; // 本端主动 destroy，不视为服务端重置。
    }
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      new SseClientError(
        'connection_reset',
        `SSE 连接中断（${code ?? 'reset'}）${internals.host}:${internals.port}`,
      ),
    );
  });

  internals.abortSignal?.addEventListener(
    'abort',
    () => {
      fail(new SseClientError('aborted', 'SSE 观察被 AbortSignal 中断'));
    },
    { once: true },
  );

  const iterator: AsyncIterableIterator<SseFrame> = {
    next(): Promise<IteratorResult<SseFrame>> {
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      if (queue.length > 0) {
        const frame = queue.shift()!;
        pump();
        return Promise.resolve({ value: frame, done: false });
      }
      if (streamEnded) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<SseFrame>>((resolveNext, rejectNext) => {
        waiters.push((result) => {
          if (result.done) {
            if (terminalError) {
              rejectNext(terminalError);
              return;
            }
            resolveNext(result);
            return;
          }
          resolveNext(result);
        });
      });
    },
    return(): Promise<IteratorResult<SseFrame>> {
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<SseFrame> {
      return this;
    },
  };

  return {
    port: internals.port,
    host: internals.host,
    path: internals.path,
    statusCode: res.statusCode ?? 0,
    get bytesReceived(): number {
      return bytesReceived;
    },
    get eventsReceived(): number {
      return eventsReceived;
    },
    get lastEventId(): string | undefined {
      return lastEventId;
    },
    get consumptionPaused(): boolean {
      return isPaused();
    },
    events(): AsyncIterableIterator<SseFrame> {
      return iterator;
    },
    pauseConsumption(): void {
      manualPaused = true;
      if (!closed) {
        res.pause();
      }
    },
    resumeConsumption(): void {
      manualPaused = false;
      autoPaused = false;
      if (!closed) {
        res.resume();
      }
      pump();
    },
    reconnect(overrides?: Partial<SseConnectOptions>): Promise<SseConnection> {
      return this.close().then(() =>
        connectSseLoopback({
          port: internals.port,
          host: internals.host,
          path: internals.path,
          cursor: internals.cursor,
          token: internals.token,
          lastEventId,
          ...overrides,
        }),
      );
    },
    close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      manualPaused = false;
      autoPaused = false;
      internals.clearAllTimers();
      closePromise = new Promise<void>((resolveClose) => {
        if (internals.isSocketClosed()) {
          resolveClose();
          return;
        }
        const timer = setTimeout(resolveClose, CLOSE_WAIT_MS);
        res.socket.on('close', () => {
          clearTimeout(timer);
          resolveClose();
        });
        res.destroy();
      });
      return closePromise;
    },
  };
}
