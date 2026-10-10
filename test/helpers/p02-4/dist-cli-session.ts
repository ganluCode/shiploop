/**
 * F-002 真实 dist CLI 会话（父进程侧，仅测试夹具，不进 packages/）。
 *
 * 复用既有积木（不另立一套）：
 * - managed-child ready/go 同步屏障与身份核验（ready 诊断、有限等待、
 *   confirmProcessExit 的实际退出核验）；
 * - p02-2 race-barrier 的同点放行竞争（runWithStartBarrier）；
 * - dist-cli-driver-child：屏障放行后 spawn **真实** `packages/cli/dist/bin.js`。
 *
 * 能力（F-002 验收 2）：
 * - spawnDistCliSession：ready（身份/环境诊断核验）、身份查询（driver/grandchild
 *   pid + ready）、releaseGo 放行、waitResult 有限等待、verifyStopped 实际退出核验
 *   （driver 退出 + grandchild pid 真实消失，未确认即 exit_unconfirmed，绝不报 stopped）；
 * - raceDistCliSessions：多个会话在同一微任务批次放行竞争连接同一数据根；
 * - stdout/stderr 采集有大小上限（超出截断 + outputOverflow + 真实字节数）；
 * - parseJsonEnvelopes / singleEnvelope：结构化信封解析——业务完成以退出码 +
 *   信封 + 状态查询判定，绝不以成功文本替代。
 *
 * 安全约束：argv 直接 spawn（无 shell）；env 由调用方以白名单构造；杀进程只针对
 * 本套件真实 spawn 的 driver/grandchild pid；不读凭据、不联网、不调用模型。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FixtureProcessError } from '../host/managed-child.ts';
import type {
  ChildReadyMessage,
  ManagedChild,
  ProcessSupervisor,
  StopConfirmationOptions,
} from '../host/managed-child.ts';
import { runWithStartBarrier } from '../p02-2/race-barrier.ts';

/** 真实 dist CLI 可执行入口（`npm run build` 产物，与生产同一入口）。 */
export const DIST_CLI_BIN = fileURLToPath(new URL('../../../packages/cli/dist/bin.js', import.meta.url));

const DRIVER_SCRIPT = fileURLToPath(new URL('./dist-cli-driver-child.ts', import.meta.url));

/** 必需产物核验：dist 不存在即失败（不 skip），给出构建命令。 */
export function assertDistCliBuilt(): string {
  if (!existsSync(DIST_CLI_BIN)) {
    throw new Error(`真实 dist CLI 入口不存在：${DIST_CLI_BIN}；请先运行 npm run build`);
  }
  return DIST_CLI_BIN;
}

export interface DistCliInput {
  /** CLI 参数（追加在 entryArgv 之后）。 */
  readonly args: readonly string[];
  readonly label?: string;
  /** 驱动/CLI 工作目录（默认夹具沙箱根；须位于 requireInside 内）。 */
  readonly cwd?: string;
  /** 白名单 env（默认夹具 childEnv()；真实凭据环境不透传）。 */
  readonly childEnv?: NodeJS.ProcessEnv;
  /** 真实入口 argv（默认 [process.execPath, dist/bin.js]）。 */
  readonly entryArgv?: readonly string[];
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  /** 就绪诊断 cwd/home/tmpdir 必须位于该目录（realpath）之内。 */
  readonly requireInside?: string;
}

export interface DistCliResult {
  readonly label: string;
  readonly grandchildPid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: string | null;
  /** 截断后的 stdout/stderr 文本（完整字节数见 *Bytes）。 */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputOverflow: boolean;
  readonly elapsedMs: number;
}

export interface DistCliIdentity {
  readonly driverPid: number;
  readonly grandchildPid: number | null;
  readonly ready: ChildReadyMessage | undefined;
}

export interface DistCliSession {
  readonly label: string;
  readonly driver: ManagedChild;
  /** 已取得的真实结果（waitResult 之后）。 */
  readonly result: DistCliResult | undefined;
  /** 身份查询：driver/grandchild pid 与 ready 诊断。 */
  identity(): DistCliIdentity;
  /** ready（有界等待 + pid/环境身份核验）。 */
  waitReady(timeoutMs?: number): Promise<ChildReadyMessage>;
  /** 同步屏障放行（须先 waitReady）。 */
  releaseGo(): void;
  /** 有限等待真实入口退出结果（超时即失败，不把等待当作完成）。 */
  waitResult(timeoutMs?: number): Promise<DistCliResult>;
  /** 实际退出核验：driver 收尾退出 + grandchild pid 真实消失。 */
  verifyStopped(options?: StopConfirmationOptions): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGone(pid: number, stepMs: number): Promise<boolean> {
  const deadline = Date.now() + stepMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !pidAlive(pid);
}

export interface SpawnDistCliSessionOptions extends DistCliInput {
  readonly readyTimeoutMs?: number;
}

export function spawnDistCliSession(
  supervisor: ProcessSupervisor,
  options: SpawnDistCliSessionOptions,
): DistCliSession {
  const label = options.label ?? 'p02-4-dist-cli';
  assertDistCliBuilt();
  const entryArgv = options.entryArgv ?? [process.execPath, DIST_CLI_BIN];
  const driver = supervisor.spawn({
    scriptPath: DRIVER_SCRIPT,
    config: {
      entryArgv: [...entryArgv],
      args: [...options.args],
      cwd: options.cwd ?? process.cwd(),
      ...(options.childEnv !== undefined ? { childEnv: options.childEnv } : {}),
      ...(options.stdoutLimitBytes !== undefined ? { stdoutLimitBytes: options.stdoutLimitBytes } : {}),
      ...(options.stderrLimitBytes !== undefined ? { stderrLimitBytes: options.stderrLimitBytes } : {}),
    },
    cwd: options.cwd ?? process.cwd(),
    env: options.childEnv ?? process.env,
    label,
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    ...(options.requireInside !== undefined ? { requireInside: options.requireInside } : {}),
  });

  let grandchildPid: number | null = null;
  let result: DistCliResult | undefined;
  let readyMessage: ChildReadyMessage | undefined;

  async function readGrandchildPid(timeoutMs: number): Promise<number | null> {
    if (grandchildPid !== null) {
      return grandchildPid;
    }
    const message = await driver.waitMessage('dist_cli_grandchild', timeoutMs);
    const pid = message.pid;
    grandchildPid = typeof pid === 'number' ? pid : null;
    return grandchildPid;
  }

  return {
    label,
    driver,
    get result(): DistCliResult | undefined {
      return result;
    },

    identity(): DistCliIdentity {
      return { driverPid: driver.pid, grandchildPid, ready: readyMessage };
    },

    async waitReady(timeoutMs?: number): Promise<ChildReadyMessage> {
      readyMessage = await driver.waitReady(timeoutMs);
      return readyMessage;
    },

    releaseGo(): void {
      driver.releaseGo();
    },

    async waitResult(timeoutMs = 120_000): Promise<DistCliResult> {
      if (result !== undefined) {
        return result;
      }
      const pid = await readGrandchildPid(timeoutMs);
      const message = await driver.waitMessage('dist_cli_result', timeoutMs);
      result = {
        label,
        grandchildPid: pid,
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : null,
        signal: typeof message.signal === 'string' ? message.signal : null,
        spawnError: typeof message.spawnError === 'string' ? message.spawnError : null,
        stdout: typeof message.stdout === 'string' ? message.stdout : '',
        stderr: typeof message.stderr === 'string' ? message.stderr : '',
        stdoutBytes: typeof message.stdoutBytes === 'number' ? message.stdoutBytes : -1,
        stderrBytes: typeof message.stderrBytes === 'number' ? message.stderrBytes : -1,
        outputOverflow: message.outputOverflow === true,
        elapsedMs: typeof message.elapsedMs === 'number' ? message.elapsedMs : -1,
      };
      return result;
    },

    async verifyStopped(stopOptions?: StopConfirmationOptions): Promise<void> {
      // driver 的实际退出（IPC close → SIGTERM → SIGKILL 有界升级）。
      await driver.verifyStopped(stopOptions);
      // grandchild（真实 dist CLI）退出核验：结果未见证据时按自有进程收尾并核验。
      const confirmed = result !== undefined && (result.exitCode !== null || result.signal !== null);
      if (confirmed) {
        return;
      }
      let pid = grandchildPid;
      if (pid === null) {
        try {
          pid = await readGrandchildPid(stopOptions?.stepMs ?? 1_000);
        } catch {
          pid = null; // 从未启动真实入口：无自有 grandchild 需回收。
        }
      }
      if (pid === null || !pidAlive(pid)) {
        return;
      }
      const stepMs = stopOptions?.stepMs ?? 1_000;
      process.kill(pid, 'SIGTERM');
      if (await waitGone(pid, stepMs)) {
        return;
      }
      process.kill(pid, 'SIGKILL');
      if (await waitGone(pid, stepMs)) {
        return;
      }
      throw new FixtureProcessError('exit_unconfirmed', `真实 dist CLI 进程 ${pid} 收尾后仍无法确认退出`, {
        label,
        pid,
      });
    },
  };
}

export interface DistCliRaceOptions {
  readonly readyTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
  readonly barrierTimeoutMs?: number;
}

/**
 * 让已准备的会话在同一起跑点竞争（同一微任务批次放行），有限等待全部结果。
 * 任一参与方失败/超时即聚合抛出（会话保持受管状态，由夹具 dispose 回收）。
 */
export async function raceDistCliSessions(
  sessions: readonly DistCliSession[],
  options: DistCliRaceOptions = {},
): Promise<DistCliResult[]> {
  if (sessions.length === 0) {
    throw new TypeError('raceDistCliSessions: 至少需要一个会话');
  }
  await Promise.all(sessions.map((session) => session.waitReady(options.readyTimeoutMs ?? 15_000)));
  const settled = await runWithStartBarrier(
    sessions.map((session) => async () => {
      session.releaseGo();
      return await session.waitResult(options.resultTimeoutMs ?? 120_000);
    }),
    { timeoutMs: options.barrierTimeoutMs ?? 10_000 },
  );
  const failures = settled
    .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    .map((entry) => entry.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `dist CLI 竞争参与方未全部完成（${failures.length}/${sessions.length} 失败）`);
  }
  return settled.map((entry) => (entry as PromiseFulfilledResult<DistCliResult>).value);
}

/* ------------------------------------------------------------------ *
 * 结构化信封（业务完成以退出码 + 信封判定，不以成功文本替代）
 * ------------------------------------------------------------------ */

export interface CliEnvelope {
  readonly ok: boolean;
  readonly command: string | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string; readonly [field: string]: unknown };
}

/** 解析 `--json` 输出的全部信封行（每行一个 JSON 对象）。 */
export function parseJsonEnvelopes(stdout: string): CliEnvelope[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CliEnvelope);
}

/** 取唯一信封（行数不符即失败，附真实输出尾部便于诊断）。 */
export function singleEnvelope(result: DistCliResult): CliEnvelope {
  const envelopes = parseJsonEnvelopes(result.stdout);
  if (envelopes.length !== 1) {
    throw new Error(
      `期望恰好 1 个 JSON 信封，实际 ${envelopes.length} 个；exitCode=${String(result.exitCode)} ` +
        `stdout尾部=${result.stdout.slice(-200)} stderr尾部=${result.stderr.slice(-200)}`,
    );
  }
  return envelopes[0] as CliEnvelope;
}
