/**
 * F-003 P02-3 进程/摘要/证据工具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 复用既有积木（不另立一套），并按 F-003 验收 3 补齐三块能力：
 *
 * 1. 有界竞争屏障 + 进程身份/退出核验：直接复用 P02-2 的进程内起跑屏障与
 *    P02-1 host 的 confirmProcessExit（IPC close → SIGTERM → SIGKILL 有界升级，
 *    仍无法核验即抛 exit_unconfirmed），并以 SampleProcess 为「普通 Node 样例
 *    命令」（非 IPC 子进程）提供同一套身份/退出核验与有界输出采集；
 * 2. 文件内容摘要：digestFile / digestWorkingTree 计算工作树内容身份（排除
 *    .git/node_modules/dist/build/.cache，不跟随符号链接），对齐 §6.3 workingTreeDigest；
 * 3. 只清理已核验的自有资源：SampleProcessGuard 只管理本次真实 spawn 的句柄，
 *    dispose 时逐个核验退出，任何未确认项聚合抛出——绝不把「探测失败」当成
 *    「进程已停止」，也绝不去杀未持有的进程。
 *
 * 安全约束：只管理本套件真实 spawn 的 Node 子进程（杀进程只针对句柄 OS pid）；
 * 摘要只读文件系统；不读凭据、不联网、不调用模型。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { confirmProcessExit } from '../host/managed-child.ts';
import type { ExitWaitable, ProcessExitResult, StopConfirmationOptions } from '../host/managed-child.ts';

/* ------------------------------------------------------------------ *
 * 复用：有界竞争屏障与进程退出核验（同一实现，不重写）
 * ------------------------------------------------------------------ */
export {
  createStartBarrier,
  runWithStartBarrier,
  BarrierTimeoutError,
  DEFAULT_BARRIER_TIMEOUT_MS,
  type StartBarrier,
  type StartBarrierOptions,
  type StartBarrierState,
} from '../p02-2/race-barrier.ts';
export {
  confirmProcessExit,
  FixtureProcessError,
  type ExitWaitable,
  type ProcessExitResult,
  type StopConfirmationOptions,
  type FixtureProcessFailureReason,
} from '../host/managed-child.ts';

/* ------------------------------------------------------------------ *
 * 普通 Node 样例命令：有界输出采集 + 身份/退出核验
 * ------------------------------------------------------------------ */

export interface SampleProcessOptions {
  /** 完整 argv（argv[0] 为可执行文件，通常是 process.execPath）。 */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** 调用方负责构造隔离 env（如 isolated-environment.childEnv()）。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly label?: string;
  /** stdout 采集上限（字节，默认 64 KiB）；超出即截断并标记 outputOverflow。 */
  readonly stdoutLimitBytes?: number;
  /** stderr 采集上限（字节，默认 64 KiB）。 */
  readonly stderrLimitBytes?: number;
}

export interface SampleProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly escalated: string[];
}

export interface SampleProcess {
  readonly pid: number;
  readonly label: string;
  /** spawn 期错误（如 ENOENT 缺命令）；未发生为 undefined。 */
  readonly spawnError: NodeJS.ErrnoException | undefined;
  isAlive(): boolean;
  /** 已采集的 stdout/stderr 文本（超限即截断，完整字节数见 *Bytes）。 */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** stdout+stderr 任一超过采集上限。 */
  readonly outputOverflow: boolean;
  readonly exited: Promise<SampleProcessExit>;
  /** 有界等待退出；超时返回 null（探测失败 ≠ 已停止，不抛错、不杀进程）。 */
  waitExit(timeoutMs: number): Promise<SampleProcessExit | null>;
  kill(signal?: NodeJS.Signals): boolean;
  /** IPC 不适用（无 ipc 通道）→ SIGTERM → SIGKILL 升级；仍无法核验抛 exit_unconfirmed。 */
  verifyStopped(options?: StopConfirmationOptions): Promise<SampleProcessExit>;
}

const DEFAULT_CAPTURE_LIMIT_BYTES = 65_536;

export function spawnSampleProcess(options: SampleProcessOptions): SampleProcess {
  const [command, ...args] = options.argv;
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('spawnSampleProcess: argv[0] 必须是非空可执行文件路径');
  }
  const stdoutLimit = options.stdoutLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
  const label = options.label ?? 'p02-3-sample';

  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  let spawnError: NodeJS.ErrnoException | undefined;

  const capture = (
    chunk: Buffer,
    stream: 'stdout' | 'stderr',
  ): void => {
    if (stream === 'stdout') {
      stdoutBytes += chunk.length;
      if (stdout.length < stdoutLimit) {
        stdout += chunk.toString('utf8').slice(0, stdoutLimit - stdout.length);
      }
      if (stdoutBytes > stdoutLimit) outputOverflow = true;
    } else {
      stderrBytes += chunk.length;
      if (stderr.length < stderrLimit) {
        stderr += chunk.toString('utf8').slice(0, stderrLimit - stderr.length);
      }
      if (stderrBytes > stderrLimit) outputOverflow = true;
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  child.on('error', (error: Error) => {
    spawnError = error as NodeJS.ErrnoException;
  });

  const exited = new Promise<SampleProcessExit>((resolve) => {
    // 以 'close' 收尾：'error'（如 ENOENT）后 'exit' 可能不触发，'close' 一定会。
    child.once('close', (code, signal) => {
      resolve({ code, signal, escalated: [] });
    });
  });

  const handle: SampleProcess = {
    pid: child.pid ?? -1,
    label,
    get spawnError() {
      return spawnError;
    },
    isAlive: () => child.exitCode === null && child.signalCode === null && child.pid !== undefined,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get stdoutBytes() {
      return stdoutBytes;
    },
    get stderrBytes() {
      return stderrBytes;
    },
    get outputOverflow() {
      return outputOverflow;
    },
    exited,
    async waitExit(timeoutMs: number): Promise<SampleProcessExit | null> {
      const winner = await Promise.race([
        exited.then((result): { result: SampleProcessExit } => ({ result })),
        new Promise<{ result: null }>((resolve) => {
          const timer = setTimeout(() => resolve({ result: null }), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return winner.result;
    },
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      return child.kill(signal);
    },
    verifyStopped(stopOptions?: StopConfirmationOptions): Promise<SampleProcessExit> {
      // 无 ipc 通道：confirmProcessExit 会跳过 ipc-close，直接走 SIGTERM→SIGKILL。
      return confirmProcessExit(handle as unknown as ExitWaitable, stopOptions);
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ *
 * 只清理已核验的自有资源
 * ------------------------------------------------------------------ */

export interface SampleProcessGuard {
  readonly tracked: readonly SampleProcess[];
  spawn(options: SampleProcessOptions): SampleProcess;
  /**
   * 核验全部自有样例进程已停止：存活者按 IPC(无)→SIGTERM→SIGKILL 升级并核验退出；
   * 任何未确认项聚合抛出 AggregateError（绝不静默当作已停止）。
   */
  dispose(options?: StopConfirmationOptions): Promise<void>;
}

export function createSampleProcessGuard(): SampleProcessGuard {
  const tracked: SampleProcess[] = [];
  return {
    tracked,
    spawn(options: SampleProcessOptions): SampleProcess {
      const process_ = spawnSampleProcess(options);
      tracked.push(process_);
      return process_;
    },
    async dispose(options?: StopConfirmationOptions): Promise<void> {
      const results = await Promise.allSettled(
        tracked.map((process_) =>
          process_.isAlive() ? process_.verifyStopped(options) : Promise.resolve(),
        ),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, `样例进程回收未确认：${failures.length} 个`);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 文件内容摘要（对齐 §6.3 workingTreeDigest）
 * ------------------------------------------------------------------ */

/** §6.3 工作树摘要默认排除目录（构建产物/依赖/缓存/元数据不参与代码身份）。 */
export const DEFAULT_DIGEST_EXCLUDED_DIRS: readonly string[] = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
]);

export interface DigestTreeOptions {
  /** 排除目录名（默认 DEFAULT_DIGEST_EXCLUDED_DIRS）。 */
  readonly excludeDirs?: readonly string[];
  /** 只摘要这些仓库内相对路径（POSIX 分隔）；不提供则摘要全部。 */
  readonly include?: readonly string[];
}

export interface TreeDigestEntry {
  readonly relativePath: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface TreeDigest {
  readonly algorithm: 'sha256';
  /** 汇总摘要：对全部条目按相对路径排序后稳定拼接再哈希。 */
  readonly digest: string;
  readonly entries: readonly TreeDigestEntry[];
}

/** 单文件内容 sha256（十六进制小写）。 */
export function digestFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 计算工作树内容摘要（§6.3）：遍历受控根内常规文件（不跟随符号链接），
 * 跳过排除目录；按相对路径排序后逐条 sha256，再对 `path\0digest\0` 序列
 * 汇总哈希。内容敏感、路径敏感、与遍历顺序无关（确定性）。
 */
export function digestWorkingTree(root: string, options: DigestTreeOptions = {}): TreeDigest {
  const excludeDirs = new Set(options.excludeDirs ?? DEFAULT_DIGEST_EXCLUDED_DIRS);
  const include = options.include;
  const includeSet = include ? new Set(include) : undefined;
  const entries: TreeDigestEntry[] = [];

  const walk = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) {
        continue; // 不跟随链接（避免逃逸与不确定内容）。
      }
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) {
          continue;
        }
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (includeSet && !includeSet.has(relativePath)) {
        continue;
      }
      const content = readFileSync(absolutePath);
      entries.push({
        relativePath,
        digest: createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length,
      });
    }
  };

  walk(root, '');
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const aggregate = createHash('sha256');
  for (const entry of entries) {
    aggregate.update(`${entry.relativePath}\0${entry.digest}\0`, 'utf8');
  }
  return { algorithm: 'sha256', digest: aggregate.digest('hex'), entries };
}
