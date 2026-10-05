/**
 * F-008 显式 stop 的 quiesce、幂等、收尾编排与信号收尾（契约 §10 全部、§10.7）。
 *
 * 组成：
 * - HostActivityGate（§10.2 窄活动控制端口，唯一允许接入的活动面，仅两个方法）：
 *   enterQuiesce 关闭新业务入口并返回当时已接受活动数；awaitQuiesce 在有限预算
 *   内等待已接受活动收尾，只有 confirmed === true 才允许进入关闭。
 *   createIdleActivityGate 是 P02-1 生产装配（恒空闲：无 Runner/Verifier/调度器
 *   接入点）；非空闲行为只能来自受信装配/测试注入，不新增执行表、不虚构取消；
 * - createHostStopController：§10.4 幂等矩阵与 §10.5 关闭顺序的进程内编排——
 *   · starting → not_ready(503)；错误实例在传输面先行 409（零副作用）；
 *   · 新 commandId + ready → 唯一一次 enterQuiesce → awaitQuiesce（预算有界）→
 *     prepareTeardown（stopping/关 listener/关 Core/持锁按实例清理）→ 回执
 *     completed/stopping → releaseAfterTeardown（释锁）；
 *   · 进行中同 commandId 同摘要 → 回同一进度 replayed:true（不重复 enterQuiesce、
 *     不重复关闭资源）；同 ID 不同摘要 → conflict(409) 零副作用；
 *   · quiescing/stopping 中另一 commandId → resource_busy stop_in_progress；
 *   · quiesce 未确认 → resource_busy quiesce_not_confirmed：保持 quiescing、
 *     隔离与锁，不报告 stopped、不允许第二写入者；被拒操作以同命令重提可续跑
 *     （不重新 enterQuiesce、不重复关闭，成功回执 replayed:true）；
 *   · prepareTeardown/释锁失败 → internal stop_teardown_unconfirmed：保留锁与
 *     现场，不伪装成功；响应送达失败（客户端断开）不改变收尾语义（§10.4）；
 *   · SIGTERM/SIGINT 经 requestSignalShutdown 走同一安全收尾（无 commandId、无
 *     回执承诺；stop 视图保持 null）；未确认返回 unconfirmed 并保留现场，可重试；
 * - wireHostSignalShutdown：把 process 信号接到 requestSignalShutdown，只在
 *   completed 时调用退出回调（由显式入口 dist/start.js 与测试子进程装配）；
 *   客户端断开/退出绝不触发本模块任何路径。
 *
 * import 本模块无副作用：不监听端口、不读写文件、不读 argv/env；只有工厂
 * 显式调用才编排注入的端口。
 */
import { HostProtocolError, QUIESCE_BUDGET_MS } from '../contract/index.js';
import type {
  LifecycleState,
  StopOperationView,
  ValidatedStopRequest,
} from '../contract/index.js';

const OPERATION = 'host.stop';

/** §10.2 enterQuiesce 返回：关闭新业务入口时仍在收尾的已接受活动数。 */
export interface QuiesceEntryResult {
  readonly accepted: number;
}

/** §10.2 awaitQuiesce 返回：只有 confirmed === true 才允许进入关闭。 */
export interface QuiesceAwaitResult {
  readonly confirmed: boolean;
  readonly pending: readonly string[];
}

/** §10.2 窄活动控制端口（仅两个方法，语义冻结）。 */
export interface HostActivityGate {
  enterQuiesce(): QuiesceEntryResult;
  awaitQuiesce(budgetMs: number): Promise<QuiesceAwaitResult>;
}

/** P02-1 生产恒空闲门控：无 Runner/Verifier/调度器接入点，立即确认。 */
export function createIdleActivityGate(): HostActivityGate {
  return Object.freeze({
    enterQuiesce: (): QuiesceEntryResult => ({ accepted: 0 }),
    awaitQuiesce: (): Promise<QuiesceAwaitResult> =>
      Promise.resolve({ confirmed: true, pending: [] }),
  });
}

/** status 的活动计数视图（§9；由门控返回值得出，产品代码不虚构活动来源）。 */
export interface HostActivityCountsView {
  readonly accepted: number;
  readonly quiescing: number;
}

/** 停止控制器的回执端口（传输面实现；送达失败由控制器吞没，不改变收尾语义）。 */
export interface StopRespond {
  ok(view: StopOperationView): void;
  fail(error: HostProtocolError): void;
}

export type SignalShutdownOutcome = 'completed' | 'unconfirmed' | 'already_in_progress' | 'not_ready';

/** 收尾步骤端口（由启动装配提供；步骤与顺序冻结在 §10.5）。 */
export interface HostStopControllerDeps {
  readonly activityGate: HostActivityGate;
  readonly getLifecycleState: () => LifecycleState;
  readonly setLifecycleState: (next: 'quiescing' | 'stopping') => void;
  /**
   * §10.5 第 3–5 步：转 stopping、关闭 HTTP listener（不再接受新连接）、
   * 关闭 Core、持锁按实例清理发现/凭据。抛出 = 收尾未确认（调用方保锁、
   * 不报告 stopped）；实现内部不得释放 OS 锁。
   */
  readonly prepareTeardown: () => Promise<void>;
  /** §10.5 第 6 步（最终响应送达之后）：释放 OS 锁。 */
  readonly releaseAfterTeardown: () => Promise<void>;
  /** quiesce 有限预算（默认 §10.2 的 10 000 ms；受信注入只允许更小的有界值）。 */
  readonly quiesceBudgetMs?: number;
}

export interface HostStopController {
  /** §10.4 编排：已校验（结构/版本/摘要/实例）的 stop 请求 → 回执或脱敏错误。 */
  requestStop(request: ValidatedStopRequest, respond: StopRespond): Promise<void>;
  /** §9 停止操作视图（无停止操作时为 null；信号收尾无 commandId 不产生视图）。 */
  getStopView(): StopOperationView | null;
  /** §9 活动计数（由门控返回值跟踪得出）。 */
  getActivities(): HostActivityCountsView;
  /** §10.7 信号收尾：同一安全顺序，无 commandId 与回执承诺；可重试未确认。 */
  requestSignalShutdown(): Promise<SignalShutdownOutcome>;
  /** 等待当前在途停止/收尾尝试结束（无在途立即返回；装配级 close 协调用）。 */
  whenSettled(): Promise<void>;
}

type StopSettled = 'in_progress' | 'completed' | 'rejected';

interface StopRecord {
  readonly commandId: string;
  readonly requestDigest: string;
  view: StopOperationView;
  settled: StopSettled;
}

function invalidInput(reason: string, field: string): HostProtocolError {
  return new HostProtocolError('invalid_input', OPERATION, `停止控制器依赖未通过校验（${field}）`, {
    details: { reason, field },
  });
}

/** 响应送达失败（客户端断开/连接重置）不改变 §10.4 语义：吞没并继续收尾。 */
function safely(deliver: () => void): void {
  try {
    deliver();
  } catch {
    // 送达通道失败无进一步可做的恢复；完成判据只在客户端/外部证据侧。
  }
}

/**
 * 创建停止控制器。依赖在构造时校验（非法即 invalid_input，零副作用）；
 * 运行期只做内存编排与注入端口调用，自身不做任何文件/网络/进程 I/O。
 */
export function createHostStopController(deps: HostStopControllerDeps): HostStopController {
  if (deps === null || typeof deps !== 'object') {
    throw invalidInput('invalid_deps_type', 'deps');
  }
  const gate = deps.activityGate as HostActivityGate | undefined;
  if (
    gate === null ||
    gate === undefined ||
    typeof gate !== 'object' ||
    typeof gate.enterQuiesce !== 'function' ||
    typeof gate.awaitQuiesce !== 'function'
  ) {
    throw invalidInput('invalid_activity_gate', 'activityGate');
  }
  for (const [field, value] of [
    ['getLifecycleState', deps.getLifecycleState],
    ['setLifecycleState', deps.setLifecycleState],
    ['prepareTeardown', deps.prepareTeardown],
    ['releaseAfterTeardown', deps.releaseAfterTeardown],
  ] as const) {
    if (typeof value !== 'function') {
      throw invalidInput('invalid_teardown_port', field);
    }
  }
  const budgetMs = deps.quiesceBudgetMs ?? QUIESCE_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > QUIESCE_BUDGET_MS) {
    throw invalidInput('invalid_quiesce_budget', 'quiesceBudgetMs');
  }

  let record: StopRecord | null = null;
  let quiesceEntered = false;
  let activities: HostActivityCountsView = { accepted: 0, quiescing: 0 };
  let signalState: 'none' | 'in_flight' | 'unconfirmed' | 'completed' = 'none';
  let currentAttempt: Promise<unknown> | null = null;

  const stopInProgress = (): HostProtocolError =>
    new HostProtocolError('resource_busy', OPERATION, '已有停止流程在进行，不接受第二个停止流程', {
      details: {
        reasonCode: 'stop_in_progress',
        ...(record !== null ? { commandId: record.commandId } : {}),
      },
    });

  const buildView = (
    rec: StopRecord,
    status: StopOperationView['status'],
    stopState: StopOperationView['stopState'],
    replayed: boolean,
    reasonCode?: StopOperationView['reasonCode'],
  ): StopOperationView => ({
    commandId: rec.commandId,
    status,
    stopState,
    replayed,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  });

  /**
   * quiesce → 收尾 → 释锁 的一次尝试（HTTP 停止或信号收尾共用）。
   * rec 为 null 表示信号路径（无 commandId、无回执承诺）。
   */
  async function runAttempt(rec: StopRecord | null, isReplay: boolean): Promise<'completed' | 'unconfirmed'> {
    try {
      if (!quiesceEntered) {
        quiesceEntered = true;
        const entry = deps.activityGate.enterQuiesce();
        activities = { accepted: entry.accepted, quiescing: entry.accepted };
        deps.setLifecycleState('quiescing');
      }
      const outcome = await deps.activityGate.awaitQuiesce(budgetMs);
      activities = { accepted: activities.accepted, quiescing: outcome.pending.length };
      if (!outcome.confirmed) {
        if (rec !== null) {
          rec.view = buildView(rec, 'rejected', 'resource_busy', isReplay, 'quiesce_not_confirmed');
          rec.settled = 'rejected';
        }
        return 'unconfirmed';
      }
      if (rec !== null) {
        rec.view = buildView(rec, 'accepted', 'stopping', isReplay);
      }
      await deps.prepareTeardown();
      activities = { accepted: activities.accepted, quiescing: 0 };
      if (rec !== null) {
        rec.view = buildView(rec, 'completed', 'stopping', isReplay);
        rec.settled = 'completed';
      }
      await deps.releaseAfterTeardown();
      return 'completed';
    } catch {
      // 收尾未确认（quiesce 等待异常/teardown 失败/释锁失败）：保留锁与现场，
      // 不报告 stopped、不允许第二写入者。原始错误可能含路径/内部细节，不外泄。
      if (rec !== null && rec.settled !== 'completed') {
        rec.view = buildView(rec, 'rejected', 'resource_busy', isReplay);
        rec.settled = 'rejected';
      }
      return rec !== null && rec.settled === 'completed' ? 'completed' : 'unconfirmed';
    }
  }

  /** HTTP 停止尝试：runAttempt + 回执/错误送达（送达失败不改变语义）。 */
  async function runHttpAttempt(rec: StopRecord, isReplay: boolean, respond: StopRespond): Promise<void> {
    rec.view = buildView(rec, 'accepted', 'quiescing', isReplay);
    rec.settled = 'in_progress';
    const attempt = (async () => {
      try {
        if (!quiesceEntered) {
          quiesceEntered = true;
          const entry = deps.activityGate.enterQuiesce();
          activities = { accepted: entry.accepted, quiescing: entry.accepted };
          deps.setLifecycleState('quiescing');
        }
        const outcome = await deps.activityGate.awaitQuiesce(budgetMs);
        activities = { accepted: activities.accepted, quiescing: outcome.pending.length };
        if (!outcome.confirmed) {
          rec.view = buildView(rec, 'rejected', 'resource_busy', isReplay, 'quiesce_not_confirmed');
          rec.settled = 'rejected';
          safely(() =>
            respond.fail(
              new HostProtocolError(
                'resource_busy',
                OPERATION,
                '活动收尾未在预算内确认；Host 保持 quiescing 并保留锁与隔离',
                {
                  details: {
                    reasonCode: 'quiesce_not_confirmed',
                    commandId: rec.commandId,
                    pendingCount: outcome.pending.length,
                    stop: rec.view,
                  },
                },
              ),
            ),
          );
          return;
        }
        rec.view = buildView(rec, 'accepted', 'stopping', isReplay);
        await deps.prepareTeardown();
        activities = { accepted: activities.accepted, quiescing: 0 };
        rec.view = buildView(rec, 'completed', 'stopping', isReplay);
        rec.settled = 'completed';
        // §10.5 第 6 步：最终响应先送达，随后才释放 OS 锁。
        safely(() => respond.ok(rec.view));
        await deps.releaseAfterTeardown();
      } catch (error) {
        if (rec.settled === 'completed') {
          // 回执已发出后仅释锁失败：不改变已送达语义；锁保留由外部证据判读。
          return;
        }
        rec.view = buildView(rec, 'rejected', 'resource_busy', isReplay);
        rec.settled = 'rejected';
        const failure =
          error instanceof HostProtocolError && error.httpStatus !== undefined
            ? error
            : new HostProtocolError('internal', OPERATION, '停止收尾未确认，保留锁与现场（已脱敏）', {
                details: { reason: 'stop_teardown_unconfirmed' },
              });
        safely(() => respond.fail(failure));
      }
    })();
    currentAttempt = attempt;
    await attempt;
  }

  return Object.freeze({
    async requestStop(request: ValidatedStopRequest, respond: StopRespond): Promise<void> {
      const lifecycle = deps.getLifecycleState();
      if (lifecycle === 'starting') {
        safely(() =>
          respond.fail(
            new HostProtocolError('not_ready', OPERATION, 'Host 尚未就绪，不接受停止请求', {
              details: { reason: 'lifecycle_starting' },
            }),
          ),
        );
        return;
      }
      if (record === null) {
        // quiescing/stopping 只可能来自信号收尾或装配级拆卸；不接受第二个流程。
        if (signalState !== 'none' || lifecycle === 'quiescing' || lifecycle === 'stopping') {
          safely(() => respond.fail(stopInProgress()));
          return;
        }
        const rec: StopRecord = {
          commandId: request.commandId,
          requestDigest: request.requestDigest,
          view: {
            commandId: request.commandId,
            status: 'accepted',
            stopState: 'quiescing',
            replayed: false,
          },
          settled: 'in_progress',
        };
        record = rec;
        await runHttpAttempt(rec, false, respond);
        return;
      }
      const existing = record;
      if (existing.commandId !== request.commandId) {
        // quiescing/stopping 中另一 commandId：不接受第二个停止流程（零副作用）。
        safely(() => respond.fail(stopInProgress()));
        return;
      }
      if (existing.requestDigest !== request.requestDigest) {
        // 同 commandId 不同摘要：conflict，零副作用（不改变在途/已登记操作）。
        safely(() =>
          respond.fail(
            new HostProtocolError('conflict', OPERATION, '同 commandId 携带了不同请求摘要', {
              details: { reason: 'command_digest_conflict', commandId: existing.commandId },
            }),
          ),
        );
        return;
      }
      if (existing.settled === 'in_progress' || existing.settled === 'completed') {
        // 重放：回同一停止结果/当前进度，不重复 enterQuiesce、不重复关闭资源。
        safely(() => respond.ok({ ...existing.view, replayed: true }));
        return;
      }
      // 被拒（quiesce_not_confirmed/teardown 未确认）的操作：同命令同摘要续跑。
      await runHttpAttempt(existing, true, respond);
    },

    getStopView(): StopOperationView | null {
      return record === null ? null : record.view;
    },

    getActivities(): HostActivityCountsView {
      return activities;
    },

    async requestSignalShutdown(): Promise<SignalShutdownOutcome> {
      if (record !== null || signalState === 'in_flight' || signalState === 'completed') {
        return 'already_in_progress';
      }
      const lifecycle = deps.getLifecycleState();
      if (lifecycle === 'starting') {
        return 'not_ready';
      }
      if (signalState === 'none' && (lifecycle === 'quiescing' || lifecycle === 'stopping')) {
        return 'already_in_progress';
      }
      signalState = 'in_flight';
      const attempt = runAttempt(null, false);
      currentAttempt = attempt;
      const outcome = await attempt;
      signalState = outcome === 'completed' ? 'completed' : 'unconfirmed';
      return outcome;
    },

    async whenSettled(): Promise<void> {
      await currentAttempt;
    },
  });
}

/** 可被信号收尾装配的最小结构（RunningHost 满足；避免反向类型依赖）。 */
export interface SignalShutdownCapable {
  requestSignalShutdown(): Promise<SignalShutdownOutcome>;
}

/**
 * 把 SIGTERM/SIGINT 接到 Host 的安全收尾（§10.7）：只在收尾 completed 时
 * 调用 onCompleted（显式入口据此以退出码 0 退出）；unconfirmed 保留进程、
 * 锁与现场，后续信号可重试；already_in_progress 不重复收尾。
 */
export function wireHostSignalShutdown(host: SignalShutdownCapable, onCompleted: () => void): void {
  if (host === null || typeof host !== 'object' || typeof host.requestSignalShutdown !== 'function') {
    throw invalidInput('invalid_signal_host', 'host');
  }
  if (typeof onCompleted !== 'function') {
    throw invalidInput('invalid_completion_callback', 'onCompleted');
  }
  const handler = (): void => {
    void host.requestSignalShutdown().then(
      (outcome) => {
        if (outcome === 'completed') {
          onCompleted();
        }
      },
      () => {
        // 信号路径无回执承诺；失败保留进程/锁现场，不伪装已停止。
      },
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
