/**
 * F-008 受控假活动门控（仅测试夹具；实现契约 §10.2 的唯一活动接入面）。
 *
 * 用途：P02-1 生产装配恒空闲门控（createIdleActivityGate），本夹具以**真实受管
 * 子进程**充当「已接受活动」，供 F-008/F-013 测试 quiesce 顺序、有限等待与
 * 停止未确认分支：
 * - enterQuiesce 返回当时仍存活的活动数（不杀任何进程）；
 * - awaitQuiesce 在有限预算内轮询真实子进程退出（isAlive 来自 ChildProcess
 *   句柄的 exitCode/signalCode，绝不按消息自报判定）；预算耗尽仍有存活活动
 *   → { confirmed:false, pending: 存活活动 label }，绝不把无法探测当已收尾；
 * - 活动的生死完全由测试经 managed-child 句柄控制（close/SIGKILL + 退出核验）。
 *
 * 另一个 createDeferredActivityGate 提供纯内存可放行门控（无子进程），用于
 * 制造确定性的「quiescing 进行中」窗口（重复 stop/断连/status 竞争用例）。
 */
import type { HostActivityGate } from '../../../packages/host/src/index.ts';
import type { ManagedChild } from './managed-child.ts';

export interface ChildActivityGate {
  readonly gate: HostActivityGate;
  /** 登记一个真实受管子进程为「已接受活动」（幂等按句柄去重）。 */
  track(child: ManagedChild): void;
  stats(): { enterQuiesceCalls: number; awaitBudgetsMs: number[] };
}

export function createChildActivityGate(): ChildActivityGate {
  const activities = new Set<ManagedChild>();
  let enterQuiesceCalls = 0;
  const awaitBudgetsMs: number[] = [];
  return {
    gate: {
      enterQuiesce() {
        enterQuiesceCalls += 1;
        let alive = 0;
        for (const child of activities) {
          if (child.isAlive()) {
            alive += 1;
          }
        }
        return { accepted: alive };
      },
      async awaitQuiesce(budgetMs: number) {
        awaitBudgetsMs.push(budgetMs);
        const deadline = Date.now() + budgetMs;
        for (;;) {
          const pending = [...activities].filter((child) => child.isAlive()).map((child) => child.label);
          if (pending.length === 0) {
            return { confirmed: true, pending: [] };
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return { confirmed: false, pending };
          }
          await new Promise((resolveTick) => setTimeout(resolveTick, Math.min(20, remaining)));
        }
      },
    },
    track(child: ManagedChild): void {
      activities.add(child);
    },
    stats: () => ({ enterQuiesceCalls, awaitBudgetsMs: [...awaitBudgetsMs] }),
  };
}

export interface DeferredActivityGate {
  readonly gate: HostActivityGate;
  /** 已挂起的 awaitQuiesce 调用数（>0 表示控制器已进入 quiescing 等待）。 */
  pendingAwaits(): number;
  /** 放行当前挂起的 awaitQuiesce（confirmed）。无挂起调用时抛错（测试纪律）。 */
  confirm(): void;
  /** finally 清理用：有挂起才放行，无挂起静默返回（不掩盖原始断言失败）。 */
  confirmIfPending(): void;
  stats(): { enterQuiesceCalls: number; awaitBudgetsMs: number[] };
}

export function createDeferredActivityGate(acceptedOnEntry = 0): DeferredActivityGate {
  let enterQuiesceCalls = 0;
  const awaitBudgetsMs: number[] = [];
  const resolvers: Array<(outcome: { confirmed: boolean; pending: string[] }) => void> = [];
  return {
    gate: {
      enterQuiesce() {
        enterQuiesceCalls += 1;
        return { accepted: acceptedOnEntry };
      },
      awaitQuiesce(budgetMs: number) {
        awaitBudgetsMs.push(budgetMs);
        return new Promise<{ confirmed: boolean; pending: string[] }>((resolveAwait) => {
          resolvers.push(resolveAwait);
        });
      },
    },
    pendingAwaits: () => resolvers.length,
    confirm(): void {
      const resolveAwait = resolvers.shift();
      if (resolveAwait === undefined) {
        throw new Error('deferred gate：没有挂起的 awaitQuiesce 可放行');
      }
      resolveAwait({ confirmed: true, pending: [] });
    },
    confirmIfPending(): void {
      const resolveAwait = resolvers.shift();
      if (resolveAwait !== undefined) {
        resolveAwait({ confirmed: true, pending: [] });
      }
    },
    stats: () => ({ enterQuiesceCalls, awaitBudgetsMs: [...awaitBudgetsMs] }),
  };
}
