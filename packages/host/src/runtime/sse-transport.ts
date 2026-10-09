/**
 * F-012 Host SSE 事件订阅传输面（P02-2 契约 §9.4 订阅语义、§13 背压预算）。
 *
 * 规则落实：
 * - 唯一事件来源是持久 state_events：建连恢复位置经 Core
 *   QueryService.resolveEventResume 解析（§9.4 优先级 Last-Event-ID →
 *   ?cursor= → 缺省 cursor_required），此后每批经 readEventBatch 从持久表
 *   补读（sequence 升序、排他下界、有界分页）；内存定时器只是唤醒读取，
 *   不充当事件正文；事件至少一次投递，客户端按 eventId 去重；
 * - 授权在 Core 应用层执行（建连与每一批轮询都重新核验）：越权订阅在发送
 *   任何业务帧之前以 403 拒绝，绝不发送正文；本层不从请求数据取身份；
 * - 可续读下界（§9.4）：生产库全保留（下界恒 0）；受控测试装配可经
 *   getReplayLowerBound 注入保留下界水位。建连时游标低于下界 → HTTP 409
 *   snapshot_required（JSON 错误体，details 含 reason 与 snapshotRoute）；
 *   建连后下界越过当前位置 → 一帧 event: error（code snapshot_required）
 *   后正常结束；绝不为测试删除/篡改持久审计行；
 * - 背压（§13 冻结值）：单连接待发送缓冲（response.writableLength）上限
 *   1 048 576 B，超限或 drain 预算耗尽 → 发送一帧 event: error
 *   （code stream_overflow，含 snapshotRoute）后结束该流；单批最多 500 条
 *   且序列化不超过 262 144 B（超出部分留下批，持久来源不丢）；慢客户端
 *   不阻塞其他连接（每连接独立定时器与缓冲核算）；
 * - 帧格式：业务帧 `id: <eventId>\nevent: state-event\ndata: <单行 JSON>`；
 *   心跳：无写入超过 15 000 ms 时一行 `: ping`；
 * - 生命周期：连接关闭只清理本连接的定时器/登记；客户端断开不回滚或取消
 *   已提交命令、不停止 Host；Host 进入 quiescing/stopping 时新订阅 503
 *   not_ready（app-transport 与本层双重把关），在途流由 closeAll 在 §10.5
 *   收尾预算内结束；游标只绑定数据根身份与 scope，不依赖内存状态，Host
 *   重启后原游标可续读；
 * - SSE 是长连接：建连后解除 socket 的 requestTimeout（request.setTimeout(0)），
 *   响应仍带 cache-control: no-store 与 connection: close，不发 CORS/3xx。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不读 argv/env；只有
 * createEventStreamHub 显式调用才创建定时器管理结构（仍不启动任何定时器，
 * 定时器随 handle 建连创建、随连接结束销毁）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertTrustedPrincipal, isPublicError } from 'shiploop-core';
import type {
  PublicStateEvent,
  PublicEventScope,
  QueryService,
  TrustedPrincipal,
} from 'shiploop-core';
import { SNAPSHOT_ROUTE } from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import { RouteReject, rejectRoute } from './http-primitives.js';

/** §13：无业务/心跳写入超过该间隔发送一行 `: ping` 心跳。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** 持久事件轮询间隔（实施契约值，§15.6 登记；内存唤醒，不充当事件来源）。 */
export const SSE_POLL_INTERVAL_MS = 250;
/** §13：单连接待发送缓冲上限（response.writableLength 核算）。 */
export const SSE_MAX_PENDING_BYTES = 1_048_576;
/** §13：单批序列化上限。 */
export const SSE_MAX_BATCH_BYTES = 262_144;
/** §13：单批事件条数上限（与 §9.3 补读分页上限一致）。 */
export const SSE_BATCH_LIMIT = 500;
/** drain 有界等待预算（实施契约值，§15.6 登记）；耗尽按 stream_overflow 结束。 */
export const SSE_DRAIN_WAIT_MS = 2_000;

const OPERATION = 'events.subscribe';

/** 可信装配注入的可续读下界读取缝（仅测试；生产缺省 = 0 全保留）。 */
export type ReplayLowerBoundReader = (scope: PublicEventScope) => number;

export interface EventStreamHubOptions {
  /** Core 授权事件服务（恢复解析 + 轮询补读；Host 不直接读库）。 */
  readonly queryService: Pick<QueryService, 'resolveEventResume' | 'readEventBatch'>;
  /** 可信装配固定绑定的 principal（生产恒 local-owner；绝非请求数据）。 */
  readonly principal: TrustedPrincipal;
  /** 生命周期状态读取：quiescing/stopping/starting 拒绝新订阅并收束在途流。 */
  getLifecycleState(): LifecycleState;
  /** 可续读下界读取（受控测试缝，§9.4(a)）；缺省恒 0（全保留库）。 */
  getReplayLowerBound?: ReplayLowerBoundReader;
  /** 以下为受信装配/测试注入的预算覆盖；缺省全部为 §13/§15.6 冻结值。 */
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxPendingBytes?: number;
  readonly maxBatchBytes?: number;
  readonly batchLimit?: number;
  readonly drainWaitMs?: number;
}

/** 由 app-transport 完成查询串白名单/形态转换后的订阅输入。 */
export interface EventStreamRequestInput {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  /** §9.4 scope（{kind:'project',projectId} 或 {kind:'global'}）；Core 复核。 */
  readonly scope: unknown;
  /** ?cursor= 恢复游标（Last-Event-ID 优先）。 */
  readonly cursor?: string;
  /** Last-Event-ID 头值（eventId）。 */
  readonly lastEventId?: string;
}

export interface EventStreamHub {
  /**
   * 处理一个已通过 Bearer/Host/Origin/方法/查询串校验的订阅请求。
   * 发送 SSE 头之前的拒绝以 RouteReject/PublicError 抛出（由 app-transport
   * 统一序列化为 JSON 错误体）；发送 SSE 头之后的一切失败都以
   * event: error 帧 + 结束流呈现，不再抛出。流建立后本方法即返回，
   * 连接生命周期由 Hub 的定时器与 close 事件管理。
   */
  handle(input: EventStreamRequestInput): Promise<void>;
  /** §10.5 收尾/装配拆卸：结束全部在途流（有界等待，超时 destroy）；幂等。 */
  closeAll(): Promise<void>;
  /** 当前在途流数量（测试断言资源清理用）。 */
  activeCount(): number;
}

interface StreamState {
  readonly scope: PublicEventScope;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  lastSequence: number;
  closed: boolean;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastWriteAt: number;
}

function serializeEventFrame(event: PublicStateEvent): string {
  return `id: ${event.eventId}\nevent: state-event\ndata: ${JSON.stringify(event)}\n\n`;
}

function serializeErrorFrame(payload: Record<string, unknown>): string {
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

function validateBudgetOverride(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`createEventStreamHub: ${name} 必须是 ≥${min} 的安全整数（受信装配）`);
  }
}

export function createEventStreamHub(options: EventStreamHubOptions): EventStreamHub {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createEventStreamHub: options 必须是对象');
  }
  if (
    options.queryService === null ||
    typeof options.queryService !== 'object' ||
    typeof options.queryService.resolveEventResume !== 'function' ||
    typeof options.queryService.readEventBatch !== 'function'
  ) {
    throw new TypeError('createEventStreamHub: queryService 必须提供恢复解析与补读方法');
  }
  if (typeof options.getLifecycleState !== 'function') {
    throw new TypeError('createEventStreamHub: getLifecycleState 必须是函数');
  }
  if (
    options.getReplayLowerBound !== undefined &&
    typeof options.getReplayLowerBound !== 'function'
  ) {
    throw new TypeError('createEventStreamHub: getReplayLowerBound 必须是函数');
  }
  // 可信装配边界：principal 形状非法是编程错误（TypeError），绝不从请求取身份。
  assertTrustedPrincipal(options.principal);
  const principal = options.principal;

  const pollIntervalMs = options.pollIntervalMs ?? SSE_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const maxPendingBytes = options.maxPendingBytes ?? SSE_MAX_PENDING_BYTES;
  const maxBatchBytes = options.maxBatchBytes ?? SSE_MAX_BATCH_BYTES;
  const batchLimit = options.batchLimit ?? SSE_BATCH_LIMIT;
  const drainWaitMs = options.drainWaitMs ?? SSE_DRAIN_WAIT_MS;
  validateBudgetOverride('pollIntervalMs', pollIntervalMs, 1);
  validateBudgetOverride('heartbeatIntervalMs', heartbeatIntervalMs, 1);
  validateBudgetOverride('maxPendingBytes', maxPendingBytes, 1);
  validateBudgetOverride('maxBatchBytes', maxBatchBytes, 1);
  validateBudgetOverride('batchLimit', batchLimit, 1);
  validateBudgetOverride('drainWaitMs', drainWaitMs, 0);

  const active = new Set<StreamState>();

  /** 可续读下界：缺省恒 0；注入读取的非法值是可信装配编程错误（TypeError）。 */
  function lowerBoundOf(scope: PublicEventScope): number {
    const value = options.getReplayLowerBound?.(scope) ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('可续读下界读取返回非法值（可信装配编程错误）');
    }
    return value;
  }

  function endStream(state: StreamState, errorFrame?: string): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    active.delete(state);
    try {
      if (errorFrame !== undefined && !state.response.writableEnded) {
        state.response.write(errorFrame);
      }
      state.response.end();
    } catch {
      // 套接字已断：尽力收尾，无进一步可做的恢复。
    }
  }

  /** 有界 drain 等待：true = 已排空；false = 预算耗尽。 */
  function waitForDrain(state: StreamState): Promise<boolean> {
    return new Promise<boolean>((resolveWait) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        state.response.off('drain', onDrain);
        resolveWait(drained);
      };
      const onDrain = (): void => finish(true);
      const timer = setTimeout(() => finish(false), drainWaitMs);
      state.response.on('drain', onDrain);
    });
  }

  /**
   * 写入一段帧文本（业务批次或心跳）。返回 false 表示流已结束
   * （closed/overflow），调用方不得继续调度。
   */
  async function writeWithBackpressure(state: StreamState, text: string): Promise<boolean> {
    if (state.closed || state.response.writableEnded) {
      return false;
    }
    if (state.response.writableLength > maxPendingBytes) {
      endStream(state, serializeErrorFrame({ code: 'stream_overflow', snapshotRoute: SNAPSHOT_ROUTE }));
      return false;
    }
    state.response.write(text);
    state.lastWriteAt = Date.now();
    if (state.response.writableLength <= maxPendingBytes) {
      return true;
    }
    const drained = await waitForDrain(state);
    if (state.closed || state.response.writableEnded) {
      return false;
    }
    if (!drained || state.response.writableLength > maxPendingBytes) {
      // §9.4：慢客户端致缓冲超限 → stream_overflow 帧后结束该流（不丢持久审计）。
      endStream(state, serializeErrorFrame({ code: 'stream_overflow', snapshotRoute: SNAPSHOT_ROUTE }));
      return false;
    }
    return true;
  }

  function arm(state: StreamState): void {
    if (state.closed) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void tick(state);
    }, pollIntervalMs);
  }

  async function tick(state: StreamState): Promise<void> {
    if (state.closed || state.polling) {
      return;
    }
    state.polling = true;
    try {
      // Host 进入 quiescing/stopping：在途流收束（§10.5 收尾由 closeAll 兜底）。
      if (options.getLifecycleState() !== 'ready') {
        endStream(state);
        return;
      }
      // 建连后才发现的下界问题（§9.4）：error 帧 + 正常结束，不伪装空流。
      if (state.lastSequence < lowerBoundOf(state.scope)) {
        endStream(
          state,
          serializeErrorFrame({ code: 'snapshot_required', snapshotRoute: SNAPSHOT_ROUTE }),
        );
        return;
      }
      const batch = await options.queryService.readEventBatch(principal, {
        scope: state.scope,
        afterSequence: state.lastSequence,
        limit: batchLimit,
      });
      if (batch.events.length > 0) {
        // 单批序列化 ≤ maxBatchBytes：超出部分留下批补读（持久来源不丢）。
        const frames: string[] = [];
        let bytes = 0;
        let deliveredTo = state.lastSequence;
        for (const event of batch.events) {
          const frame = serializeEventFrame(event);
          const size = Buffer.byteLength(frame, 'utf8');
          if (frames.length > 0 && bytes + size > maxBatchBytes) {
            break;
          }
          frames.push(frame);
          bytes += size;
          deliveredTo = event.sequence;
        }
        if (!(await writeWithBackpressure(state, frames.join('')))) {
          return;
        }
        state.lastSequence = deliveredTo;
      }
      // 心跳：无写入超过间隔即发一行注释帧，维持连接活性并让客户端可观测。
      if (Date.now() - state.lastWriteAt >= heartbeatIntervalMs) {
        if (!(await writeWithBackpressure(state, ': ping\n\n'))) {
          return;
        }
      }
    } catch (error) {
      // 持久损坏（corrupt_state 等）/未预期：error 帧呈现后结束，绝不把
      // 坏行伪装成空流（§9.2 F-003 定案）；帧只含公开码，不含内部细节。
      const code = isPublicError(error) ? error.code : 'internal';
      endStream(state, serializeErrorFrame({ code }));
      return;
    } finally {
      state.polling = false;
    }
    arm(state);
  }

  function startStream(
    request: IncomingMessage,
    response: ServerResponse,
    scope: PublicEventScope,
    afterSequence: number,
  ): void {
    // SSE 是长连接：解除 socket 闲置/requestTimeout（心跳与业务帧即活性证明）。
    request.setTimeout(0);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // 响应结束时关闭连接：不留持久空闲连接（§7.2 纪律同生命周期面）。
      connection: 'close',
    });
    // writeHead 只排队头部：无首帧数据时不会自动发送，必须显式冲刷，
    // 否则客户端会等到 headers 超时（空库未来游标/纯心跳场景）。
    response.flushHeaders();
    const state: StreamState = {
      scope,
      request,
      response,
      lastSequence: afterSequence,
      closed: false,
      polling: false,
      timer: undefined,
      lastWriteAt: Date.now(),
    };
    active.add(state);
    // 客户端断开/响应结束：只清理本连接资源；不回滚命令、不停止 Host。
    // 注意：服务端 IncomingMessage 的 'close' 在请求接收完成时即触发（GET
    // 立即触发），不能用于判断连接断开；ServerResponse 的 'close' 才表示
    // 底层连接终止（正常 end 或客户端 destroy 都会触发）。
    response.on('close', () => endStream(state));
    // 建连即补读水位之后的已提交事件（不等首个轮询间隔）。
    void tick(state);
  }

  return {
    async handle(input: EventStreamRequestInput): Promise<void> {
      const { request, response } = input;
      // §9.4：Accept 必须允许 text/event-stream（逗号列表逐项匹配）。
      const accept = request.headers.accept;
      const acceptsSse =
        typeof accept === 'string' &&
        accept
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .some((part) => part === 'text/event-stream' || part.startsWith('text/event-stream;'));
      if (!acceptsSse) {
        rejectRoute(400, 'invalid_input', OPERATION, 'Accept 必须允许 text/event-stream', {
          field: 'accept',
          reason: 'accept_not_event_stream',
        });
      }
      // quiescing/stopping/starting：新订阅明确拒绝（503），业务状态不变。
      if (options.getLifecycleState() !== 'ready') {
        rejectRoute(503, 'not_ready', OPERATION, 'Host 正在停止，拒绝新的事件订阅', {
          reason: 'host_quiescing',
        });
      }
      // Core 应用层：授权 + 恢复位置解析（越权在发送任何帧之前拒绝）。
      const resume = await options.queryService.resolveEventResume(principal, {
        scope: input.scope,
        ...(input.lastEventId !== undefined ? { lastEventId: input.lastEventId } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      // 建连前的下界判定（§9.4）：409 snapshot_required + 重取快照指引。
      if (resume.afterSequence < lowerBoundOf(resume.scope)) {
        rejectRoute(409, 'snapshot_required', OPERATION, '恢复位置低于可续读下界，必须重取快照', {
          reason: 'cursor_beyond_replay_lower_bound',
          snapshotRoute: SNAPSHOT_ROUTE,
        });
      }
      startStream(request, response, resume.scope, resume.afterSequence);
    },

    async closeAll(): Promise<void> {
      const states = [...active];
      for (const state of states) {
        endStream(state);
      }
      // 有界等待 socket 关闭；超时强制 destroy（拆卸预算有界）。
      await Promise.all(
        states.map(
          (state) =>
            new Promise<void>((resolveClose) => {
              if (state.response.destroyed || state.response.writableEnded) {
                resolveClose();
                return;
              }
              const timer = setTimeout(() => {
                try {
                  state.response.destroy();
                } catch {
                  // 尽力收尾。
                }
                resolveClose();
              }, drainWaitMs);
              state.response.once('close', () => {
                clearTimeout(timer);
                resolveClose();
              });
            }),
        ),
      );
    },

    activeCount(): number {
      return active.size;
    },
  };
}

/** app-transport 的错误映射需要识别 SSE 建连前拒绝（与 RouteReject 同类）。 */
export { RouteReject };
