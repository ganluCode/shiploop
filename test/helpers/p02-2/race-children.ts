/**
 * F-004 跨进程竞争屏障运行器（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 在 P02-1 managed-child（ready/go IPC 屏障、有界等待、退出核验）之上提供
 * N 路竞争的统一编排：
 * 1. 经隔离环境的进程监督器 spawn N 个真实 Node 子进程（同一脚本、各自 config）；
 * 2. 全部核验 ready（pid/cwd/HOME/TMPDIR 隔离）后，在同一调用栈依次 releaseGo；
 * 3. 有界等待每个子进程的结果消息（默认 kind='race-result'）；
 * 4. 结果到齐或超时/失败，都协作关闭并核验**全部**子进程退出后才返回/拒绝。
 *
 * 屏障只提高竞争重叠概率；幂等/CAS 正确性由 BEGIN IMMEDIATE 与唯一约束保证，
 * 不依赖子进程调度顺序。
 */
import type {
  IsolatedHostEnvironment,
  ManagedChild,
  ProcessExitResult,
  StopConfirmationOptions,
} from '../host/index.ts';
import type { GenericIpcMessage } from '../host/managed-child.ts';

export interface BarrierChildrenOptions {
  /** 子进程脚本（.ts，经 node-ts-loader 运行）。 */
  readonly scriptPath: string;
  /** 每个子进程一份 config（同时决定参与方数量，至少 1）。 */
  readonly configs: readonly Record<string, unknown>[];
  /** 结果消息 kind，默认 race-result。 */
  readonly resultKind?: string;
  readonly labelPrefix?: string;
  readonly readyTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
  /** 回收升级选项（默认沿用隔离环境的有界步骤）。 */
  readonly stop?: StopConfirmationOptions;
}

export interface BarrierChildResult {
  readonly label: string;
  readonly pid: number;
  readonly result: GenericIpcMessage;
  readonly exit: ProcessExitResult;
}

export class BarrierChildrenError extends Error {
  readonly partial: readonly BarrierChildResult[];

  constructor(message: string, partial: readonly BarrierChildResult[]) {
    super(message);
    this.name = 'BarrierChildrenError';
    this.partial = partial;
  }
}

/**
 * 运行 N 路屏障子进程。任何一路 ready/结果超时或异常，都在有界回收全部子进程
 * （并核验退出）后聚合拒绝；调用方 finally 无需再次清理本运行器的进程。
 */
export async function runBarrierChildren(
  environment: IsolatedHostEnvironment,
  options: BarrierChildrenOptions,
): Promise<BarrierChildResult[]> {
  if (!Array.isArray(options.configs) || options.configs.length === 0) {
    throw new TypeError('runBarrierChildren: configs 至少需要一份参与方配置');
  }
  const resultKind = options.resultKind ?? 'race-result';
  const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
  const resultTimeoutMs = options.resultTimeoutMs ?? 10_000;
  const prefix = options.labelPrefix ?? 'p02-2-racer';

  const children: ManagedChild[] = options.configs.map((config, index) =>
    environment.processes.spawn({
      scriptPath: options.scriptPath,
      config,
      cwd: environment.sandboxRoot,
      env: environment.childEnv(),
      label: `${prefix}-${index}`,
      readyTimeoutMs,
      requireInside: environment.sandboxRoot,
      evidence: environment.evidence,
    }),
  );

  const collectExits = async (): Promise<ProcessExitResult[]> => {
    const exits = await Promise.allSettled(
      children.map(async (child) =>
        child.isAlive() ? child.verifyStopped(options.stop) : child.exited,
      ),
    );
    const failures = exits.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((outcome) => outcome.reason),
        `竞争子进程退出未确认：${failures.length}/${children.length}`,
      );
    }
    return exits.map((outcome) => (outcome as PromiseFulfilledResult<ProcessExitResult>).value);
  };

  // 阶段 1：全部 ready（任何失败 → 回收全部 → 拒绝）。
  try {
    await Promise.all(children.map((child) => child.waitReady(readyTimeoutMs)));
  } catch (error) {
    await collectExits().catch(() => {});
    throw new BarrierChildrenError(
      `竞争子进程 ready 阶段失败：${error instanceof Error ? error.message : String(error)}`,
      [],
    );
  }

  // 阶段 2：同批放行（go 消息在当前调用栈内逐条发出）。
  for (const child of children) {
    child.releaseGo();
  }

  // 阶段 3：有界等待结果（allSettled 不抛出，统一在阶段 4 回收后判定）。
  const outcomes: PromiseSettledResult<GenericIpcMessage>[] = await Promise.allSettled(
    children.map((child) => child.waitMessage(resultKind, resultTimeoutMs)),
  );
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  // 阶段 4：无论成败，协作关闭全部子进程并核验退出。
  let exits: ProcessExitResult[];
  try {
    exits = await collectExits();
  } catch (error) {
    throw new BarrierChildrenError(
      `竞争子进程回收未确认：${error instanceof Error ? error.message : String(error)}`,
      [],
    );
  }

  if (failures.length > 0) {
    const messages = failures
      .map((outcome) => (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)))
      .join('; ');
    throw new BarrierChildrenError(
      `竞争子进程结果等待失败（${failures.length}/${children.length}）：${messages}`,
      [],
    );
  }

  return outcomes.map((outcome, index) => ({
    label: children[index]!.label,
    pid: children[index]!.pid,
    result: (outcome as PromiseFulfilledResult<GenericIpcMessage>).value,
    exit: exits[index]!,
  }));
}
