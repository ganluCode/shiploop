/**
 * F-005 受管子进程（父进程侧，仅测试夹具）。
 *
 * 设计原则（F-005 验收 2/3）：
 * - 只管理本套件真实 spawn 的 Node 子进程：杀进程只针对 ChildProcess 句柄的
 *   OS pid，消息里自报的 pid 仅用于身份核验，绝不作为 kill 目标；
 * - ready/go 同步屏障：子进程先报 ready（含 pid/cwd/HOME/TMPDIR 诊断），
 *   父进程显式 releaseGo() 后才放行；waitMessage/waitReady 全部有界超时；
 * - 退出必须经真实 'exit' 事件核验：confirmProcessExit 的顺序是
 *   IPC close → SIGTERM（有界等待）→ SIGKILL（有界等待），仍拿不到退出
 *   证据就抛 exit_unconfirmed——任何调用方都不得把「无法探测」当成已停止；
 * - 超时/启动失败只让等待 Promise 拒绝，不擅自杀进程；回收统一走
 *   verifyStopped/ProcessSupervisor.dispose，断言失败的 finally 也能回收；
 * - 证据只记录非秘密字段（pid、label、地址、端口、退出码、信号、环境路径），
 *   stderr 仅保存在进程内错误对象尾部供调试，永不进入证据。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, Serializable } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isInsideDirectory } from '../safe-cleanup.ts';
import type { EvidenceLog } from './evidence.ts';

const REGISTER_HOOKS = fileURLToPath(new URL('../node-ts-loader/register.mjs', import.meta.url));

export type ChildReadyMessage = {
  readonly kind: 'ready';
  readonly pid: number;
  readonly cwd: string;
  readonly home: string;
  readonly tmpdir: string;
};

export type GenericIpcMessage = {
  readonly kind: string;
  readonly [field: string]: unknown;
};

export type ProcessExitResult = {
  readonly code: number | null;
  readonly signal: string | null;
  /** 实际采用过的收尾升级步骤（ipc-close / SIGTERM / SIGKILL）。 */
  readonly escalated: string[];
};

export type FixtureProcessFailureReason =
  | 'spawn_failed'
  | 'ready_timeout'
  | 'message_timeout'
  | 'early_exit'
  | 'identity_mismatch'
  | 'environment_escape'
  | 'exit_unconfirmed';

export class FixtureProcessError extends Error {
  readonly reason: FixtureProcessFailureReason;
  readonly label: string;
  readonly pid: number | undefined;
  readonly exit: ProcessExitResult | undefined;
  readonly stderrTail: string | undefined;

  constructor(
    reason: FixtureProcessFailureReason,
    message: string,
    details: {
      label: string;
      pid?: number;
      exit?: ProcessExitResult;
      stderrTail?: string;
    },
  ) {
    super(message);
    this.name = 'FixtureProcessError';
    this.reason = reason;
    this.label = details.label;
    this.pid = details.pid;
    this.exit = details.exit;
    this.stderrTail = details.stderrTail;
  }
}

export interface SpawnManagedChildOptions {
  /** 子进程脚本（.ts，经 node-ts-loader 在 Node 22 类型擦除下运行）。 */
  readonly scriptPath: string;
  /** 作为 argv[2] 传入的 JSON 配置。 */
  readonly config?: Record<string, unknown>;
  readonly cwd: string;
  /** 调用方负责构造隔离 env（isolated-environment 提供白名单 env）。 */
  readonly env: NodeJS.ProcessEnv;
  readonly label?: string;
  /** 等待 ready 的默认预算（毫秒）。 */
  readonly readyTimeoutMs?: number;
  /** 就绪诊断中的 cwd/home/tmpdir 必须全部位于该目录（realpath）之内。 */
  readonly requireInside?: string;
  readonly stderrLimitBytes?: number;
  readonly evidence?: EvidenceLog;
}

export interface StopConfirmationOptions {
  /** 先经 IPC 请求协作关闭（默认开）。 */
  readonly ipcClose?: boolean;
  /** 每个升级步骤的有界等待（毫秒，默认 1000）。 */
  readonly stepMs?: number;
  /** 是否允许 SIGTERM/SIGKILL 升级（默认开）。 */
  readonly escalate?: boolean;
}

/** 最小可等待句柄：真实 ManagedChild 与负向测试的合成句柄都满足。 */
export interface ExitWaitable {
  readonly pid: number;
  isAlive(): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  send?(message: Serializable): void;
  readonly exited: Promise<ProcessExitResult>;
}

export interface ManagedChild extends ExitWaitable {
  readonly label: string;
  waitReady(timeoutMs?: number): Promise<ChildReadyMessage>;
  /** 放行 go 屏障；在 ready 之前调用会被拒绝（屏障顺序不可跳过）。 */
  releaseGo(): void;
  send(message: Serializable): void;
  waitMessage(kind: string | readonly string[], timeoutMs?: number): Promise<GenericIpcMessage>;
  verifyStopped(options?: StopConfirmationOptions): Promise<ProcessExitResult>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIpcMessage(value: unknown): value is GenericIpcMessage {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

/**
 * 有界等待真实退出；按 IPC close → SIGTERM → SIGKILL 升级。
 * 任何信号后仍无法在预算内核验退出，即抛 exit_unconfirmed。
 */
export async function confirmProcessExit(
  handle: ExitWaitable,
  options: StopConfirmationOptions = {},
): Promise<ProcessExitResult> {
  const stepMs = options.stepMs ?? 1_000;
  if (!handle.isAlive()) {
    const result = await handle.exited;
    return { ...result, escalated: [] };
  }
  const steps: string[] = [];
  const waitStep = async (): Promise<boolean> => {
    const winner = await Promise.race([
      handle.exited.then((): 'exit' => 'exit'),
      delay(stepMs).then((): 'timeout' => 'timeout'),
    ]);
    return winner === 'exit' || !handle.isAlive();
  };

  if (options.ipcClose !== false && handle.send) {
    steps.push('ipc-close');
    handle.send({ kind: 'close' });
    if (await waitStep()) {
      return { ...(await handle.exited), escalated: steps };
    }
  }
  if (options.escalate !== false) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!handle.isAlive()) {
        break;
      }
      handle.kill(signal);
      steps.push(signal);
      if (await waitStep()) {
        break;
      }
    }
  }
  if (handle.isAlive()) {
    throw new FixtureProcessError(
      'exit_unconfirmed',
      `子进程 ${handle.pid} 在全部收尾步骤后仍无法确认退出`,
      { pid: handle.pid, label: '' },
    );
  }
  return { ...(await handle.exited), escalated: steps };
}

export function spawnManagedChild(options: SpawnManagedChildOptions): ManagedChild {
  const label = options.label ?? 'host-fixture-child';
  const stderrLimit = options.stderrLimitBytes ?? 16_384;
  const args = ['--import', REGISTER_HOOKS, options.scriptPath];
  if (options.config !== undefined) {
    args.push(JSON.stringify(options.config));
  }
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });

  const messages: GenericIpcMessage[] = [];
  const waiters = new Set<(message?: GenericIpcMessage) => void>();
  let stderrTail = '';
  let spawnError: Error | undefined;
  let readiness: ChildReadyMessage | undefined;
  let goReleased = false;

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + String(chunk)).slice(-stderrLimit);
  });
  child.on('message', (message: unknown) => {
    if (!isIpcMessage(message)) {
      return;
    }
    messages.push(message);
    for (const wake of waiters) {
      wake(message);
    }
  });
  child.on('error', (error: Error) => {
    spawnError = error;
    for (const wake of waiters) {
      wake(undefined);
    }
  });

  const exited = new Promise<ProcessExitResult>((resolve) => {
    child.once('exit', (code, signal) => {
      const result: ProcessExitResult = { code, signal, escalated: [] };
      for (const wake of waiters) {
        wake(undefined);
      }
      options.evidence?.record('child.exit', {
        label,
        pid: child.pid,
        code,
        signal,
      });
      resolve(result);
    });
  });

  const fail = (
    reason: FixtureProcessFailureReason,
    message: string,
    extra?: { exit?: ProcessExitResult },
  ): FixtureProcessError =>
    new FixtureProcessError(reason, message, {
      label,
      pid: child.pid,
      exit: extra?.exit,
      stderrTail: stderrTail.length > 0 ? stderrTail : undefined,
    });

  function findMessage(kind: string | readonly string[]): GenericIpcMessage | undefined {
    const wanted = typeof kind === 'string' ? [kind] : kind;
    return messages.find((message) => wanted.includes(message.kind));
  }

  function verifyReady(message: GenericIpcMessage): ChildReadyMessage {
    const claimedPid = message.pid;
    if (typeof claimedPid !== 'number' || claimedPid !== child.pid) {
      options.evidence?.record('child.identity_rejected', {
        label,
        pid: child.pid,
        claimedPid: typeof claimedPid === 'number' ? claimedPid : null,
      });
      throw fail('identity_mismatch', `ready.pid(${String(claimedPid)}) 与 spawn 句柄 pid(${child.pid}) 不一致`);
    }
    const ready = message as unknown as ChildReadyMessage;
    if (options.requireInside) {
      let boundary: string;
      try {
        boundary = realpathSync(options.requireInside);
      } catch {
        throw fail('environment_escape', '隔离边界目录不存在或不可 realpath');
      }
      for (const [name, observed] of [
        ['cwd', ready.cwd],
        ['home', ready.home],
        ['tmpdir', ready.tmpdir],
      ] as const) {
        if (typeof observed !== 'string' || !isInsideDirectory(realpathSync(observed), boundary)) {
          options.evidence?.record('child.environment_escape', { label, pid: child.pid, scope: name });
          throw fail('environment_escape', `ready.${name} 不在隔离沙箱之内`);
        }
      }
    }
    readiness = ready;
    options.evidence?.record('child.ready', {
      label,
      pid: ready.pid,
    });
    return ready;
  }

  function waitFor(kind: string | readonly string[], timeoutMs: number): Promise<GenericIpcMessage> {
    const existing = findMessage(kind);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<GenericIpcMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        rejectPromise(fail(typeof kind === 'string' && kind === 'ready' ? 'ready_timeout' : 'message_timeout', `等待 IPC 消息 ${String(kind)} 超时`));
      }, timeoutMs);
      const check = (incoming?: GenericIpcMessage): void => {
        if (spawnError) {
          clearTimeout(timer);
          waiters.delete(check);
          rejectPromise(fail('spawn_failed', spawnError.message));
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          waiters.delete(check);
          void exited.then((exitResult) => {
            rejectPromise(fail('early_exit', '子进程在等待消息期间提前退出', { exit: exitResult }));
          });
          return;
        }
        if (incoming && findMessage(kind)) {
          clearTimeout(timer);
          waiters.delete(check);
          resolvePromise(findMessage(kind)!);
        }
      };
      waiters.add(check);
      check(undefined);
    });
  }

  return {
    pid: child.pid!,
    label,
    isAlive: () => child.exitCode === null && child.signalCode === null && child.pid !== undefined,
    send(message: Serializable): void {
      child.send(message);
    },
    releaseGo(): void {
      if (!readiness) {
        throw fail('identity_mismatch', 'releaseGo 之前必须先核验 ready（屏障顺序不可跳过）');
      }
      if (!goReleased) {
        goReleased = true;
        child.send('go');
      }
    },
    async waitReady(timeoutMs?: number): Promise<ChildReadyMessage> {
      if (readiness) {
        return readiness; // 幂等：重复等待不重复核验/记证据
      }
      const message = await waitFor('ready', timeoutMs ?? options.readyTimeoutMs ?? 5_000);
      return verifyReady(message);
    },
    waitMessage(kind: string | readonly string[], timeoutMs = 5_000): Promise<GenericIpcMessage> {
      return waitFor(kind, timeoutMs);
    },
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      return child.kill(signal);
    },
    verifyStopped(stopOptions?: StopConfirmationOptions): Promise<ProcessExitResult> {
      return confirmProcessExit(this, stopOptions);
    },
    exited,
  };
}

export interface ProcessSupervisor {
  spawn(options: SpawnManagedChildOptions): ManagedChild;
  readonly tracked: readonly ManagedChild[];
  /** 回收全部受管进程：升级收尾并核验退出；任何未确认都在全部尝试后聚合抛出。 */
  dispose(options?: StopConfirmationOptions): Promise<void>;
}

export function createProcessSupervisor(supervisorOptions: {
  evidence?: EvidenceLog;
  defaultStop?: StopConfirmationOptions;
} = {}): ProcessSupervisor {
  const tracked: ManagedChild[] = [];
  return {
    tracked,
    spawn(options: SpawnManagedChildOptions): ManagedChild {
      const child = spawnManagedChild({ evidence: supervisorOptions.evidence, ...options });
      tracked.push(child);
      return child;
    },
    async dispose(options?: StopConfirmationOptions): Promise<void> {
      const merged = { ...supervisorOptions.defaultStop, ...options };
      const results = await Promise.allSettled(
        tracked.map((child) =>
          child.isAlive() ? child.verifyStopped(merged) : Promise.resolve(),
        ),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, `受管子进程回收未确认：${failures.length} 个`);
      }
    },
  };
}
