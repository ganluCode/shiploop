/**
 * F-004 进程内同步起跑屏障（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 用途：让 N 个命令竞争参与方（如两个并发幂等提交）在同一放行点起跑，
 * 最大化写事务重叠窗口。屏障**只提高竞争重叠概率，正确性不依赖时序**：
 * “同一旧 revision 下恰一个成功”由 BEGIN IMMEDIATE 与 CAS/唯一约束保证
 * （沿用 test/helpers/cas-race-child.ts 同一结论）。
 *
 * 保证：
 * - 全部参与方到达前不放行；最后一方到达后在同一微任务批次放行全部等待；
 * - 等待有界：超时未到齐则全部等待拒绝 BarrierTimeoutError，超时后迟到
 *   的参与方也被拒绝（屏障已关闭）；超时不杀任何资源（与 P02-1
 *   managed-child 同原则，回收由调用方/监督器负责）；
 * - 已放行后新到达者立即放行，状态不可逆。
 */
export class BarrierTimeoutError extends Error {
  readonly parties: number;
  readonly arrived: number;

  constructor(parties: number, arrived: number, timeoutMs: number) {
    super(`起跑屏障在 ${timeoutMs}ms 内未到齐：${arrived}/${parties}`);
    this.name = 'BarrierTimeoutError';
    this.parties = parties;
    this.arrived = arrived;
  }
}

export type StartBarrierState = 'open' | 'released' | 'timed_out';

export interface StartBarrier {
  readonly parties: number;
  readonly state: StartBarrierState;
  readonly arrivedCount: number;
  /** 登记到达；放行后立即 resolve，超时后 reject BarrierTimeoutError。 */
  arrive(): Promise<void>;
}

export interface StartBarrierOptions {
  /** 到齐等待预算（毫秒，正整数，默认 10 000）。 */
  readonly timeoutMs?: number;
}

export const DEFAULT_BARRIER_TIMEOUT_MS = 10_000;

export function createStartBarrier(
  parties: number,
  options: StartBarrierOptions = {},
): StartBarrier {
  if (!Number.isInteger(parties) || parties < 1) {
    throw new TypeError(`createStartBarrier: parties 必须是 ≥1 的整数，实际：${String(parties)}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`createStartBarrier: timeoutMs 必须是正整数，实际：${String(timeoutMs)}`);
  }

  const waiters: Array<() => void> = [];
  const rejecters: Array<(error: Error) => void> = [];
  let arrived = 0;
  let state: StartBarrierState = 'open';

  const failAll = (): void => {
    if (state !== 'open') {
      return;
    }
    state = 'timed_out';
    clearTimeout(timer);
    const error = new BarrierTimeoutError(parties, arrived, timeoutMs);
    const pending = rejecters.splice(0);
    rejecters.length = 0;
    waiters.length = 0;
    for (const reject of pending) {
      reject(error);
    }
  };

  const timer = setTimeout(failAll, timeoutMs);
  // 不阻塞进程退出（与夹具其他有界计时器一致）。
  timer.unref?.();

  const releaseAll = (): void => {
    state = 'released';
    clearTimeout(timer);
    const pending = waiters.splice(0);
    rejecters.length = 0;
    // 同一微任务批次放行全部参与方，最大化起跑重叠。
    queueMicrotask(() => {
      for (const resolve of pending) {
        resolve();
      }
    });
  };

  return {
    parties,
    get state(): StartBarrierState {
      return state;
    },
    get arrivedCount(): number {
      return arrived;
    },
    arrive(): Promise<void> {
      if (state === 'timed_out') {
        return Promise.reject(
          new BarrierTimeoutError(parties, arrived, timeoutMs),
        );
      }
      if (state === 'released') {
        return Promise.resolve();
      }
      arrived += 1;
      return new Promise<void>((resolve, reject) => {
        waiters.push(resolve);
        rejecters.push(reject);
        if (arrived >= parties) {
          releaseAll();
        }
      });
    },
  };
}

/**
 * 以同一起跑屏障并发运行 N 个参与方：全部 thunks 在当前调用栈内同步启动
 * （各自先到达屏障），放行后执行；返回与入参同序的 allSettled 结果。
 * 屏障超时（调用方未启动全部 thunks）时各参与方结果为 rejected。
 */
export async function runWithStartBarrier<T>(
  thunks: readonly (() => Promise<T> | T)[],
  options: StartBarrierOptions = {},
): Promise<PromiseSettledResult<T>[]> {
  if (!Array.isArray(thunks) || thunks.length === 0) {
    throw new TypeError('runWithStartBarrier: 至少需要一个参与方');
  }
  const barrier = createStartBarrier(thunks.length, options);
  const promises = thunks.map(async (thunk) => {
    await barrier.arrive();
    return await thunk();
  });
  return Promise.allSettled(promises);
}
