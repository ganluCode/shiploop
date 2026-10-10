/**
 * F-002 真实 dist CLI 驱动子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 用途：在 managed-child 的 ready/go 同步屏障内，于同一起跑点启动**真实**
 * `packages/cli/dist/bin.js` 子进程（argv 由调用方给出，env 为夹具白名单），
 * 供两个及以上 CLI 竞争连接同一数据根；驱动本身只做放行、有界采集与结果上报。
 *
 * 协议（与 managed-child.ts / dist-cli-session.ts 父进程侧对应）：
 * 1. 启动后发送 {kind:'ready', pid, cwd, home, tmpdir}（身份/环境诊断）；
 * 2. 等待 'go'（有界 30 s；放行前收到 close 直接退出码 0；超时退出码 9）；
 * 3. 放行后 spawn 真实入口 argv：立即上报 {kind:'dist_cli_grandchild', pid}；
 *    stdout/stderr 有界采集（超限截断并标记 outputOverflow）；
 * 4. 真实入口 'close'（实际退出证据）后上报 {kind:'dist_cli_result', …}：
 *    exitCode/signal/spawnError/输出（截断文本 + 真实字节数）/耗时；
 * 5. 等待 {kind:'close'} → 以真实入口退出码退出；close 早到则先终止真实入口
 *    （SIGTERM → SIGKILL 有界）再退出；watchdog 300 s 兜底退出码 9 防泄漏。
 *
 * 绝不上报凭据/环境原文；不拼接 shell（argv 直接 spawn）；不调用模型。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readChildConfig } from '../host/child-runtime.ts';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('dist-cli-driver-child 必须以 IPC 通道启动');
}

const config = readChildConfig();

function stringArray(field: string): readonly string[] {
  const value = config[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`config.${field} 必须是字符串数组`);
  }
  return value as string[];
}

const entryArgv = stringArray('entryArgv');
if (entryArgv.length === 0) {
  throw new Error('config.entryArgv 必须非空（argv[0] 为可执行文件）');
}
const args = stringArray('args');
const cwd = config.cwd;
if (typeof cwd !== 'string' || cwd.length === 0) {
  throw new Error('config.cwd 必须是非空字符串');
}
const childEnvRaw = config.childEnv;
if (
  childEnvRaw !== undefined &&
  (typeof childEnvRaw !== 'object' || childEnvRaw === null || Array.isArray(childEnvRaw))
) {
  throw new Error('config.childEnv 必须是对象');
}
const childEnv = childEnvRaw as Record<string, string> | undefined;
const stdoutLimit = typeof config.stdoutLimitBytes === 'number' ? config.stdoutLimitBytes : 65_536;
const stderrLimit = typeof config.stderrLimitBytes === 'number' ? config.stderrLimitBytes : 65_536;

let closeRequested = false;
const closeWaiters: Array<() => void> = [];
/** 真实入口句柄（close 早到时先终止它，绝不留下未管理进程）。 */
let grandchildHandle: ChildProcess | undefined;
let grandchildAlive = false;

function terminateGrandchild(): void {
  const handle = grandchildHandle;
  if (!handle || !grandchildAlive) {
    return;
  }
  handle.kill('SIGTERM');
  const escalate = setTimeout(() => {
    if (grandchildAlive) {
      handle.kill('SIGKILL');
    }
  }, 2_000);
  escalate.unref?.();
}

// close 全程监听（任意阶段都可请求收尾）；'go' 由 waitForGate 各自消费。
process.on('message', (message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === 'close'
  ) {
    closeRequested = true;
    terminateGrandchild();
    for (const wake of closeWaiters.splice(0)) {
      wake();
    }
  }
});

function waitForGate(timeoutMs: number): Promise<'go' | 'close'> {
  return new Promise((resolveGate, rejectGate) => {
    if (closeRequested) {
      resolveGate('close');
      return;
    }
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      rejectGate(new Error('dist-cli-driver-child: 等待父进程消息超时'));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (message === 'go') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolveGate('go');
        return;
      }
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { kind?: unknown }).kind === 'close'
      ) {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolveGate('close');
      }
    };
    process.on('message', onMessage);
  });
}

function waitForCloseRequest(timeoutMs: number): Promise<'close' | 'timeout'> {
  if (closeRequested) {
    return Promise.resolve('close');
  }
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      const index = closeWaiters.indexOf(wake);
      if (index >= 0) {
        closeWaiters.splice(index, 1);
      }
      resolveWait('timeout');
    }, timeoutMs);
    const wake = (): void => {
      clearTimeout(timer);
      resolveWait('close');
    };
    closeWaiters.push(wake);
  });
}

const watchdog = setTimeout(() => {
  process.stderr.write('dist-cli-driver-child: watchdog 超时\n');
  process.exit(9);
}, 300_000);

send({
  kind: 'ready',
  pid: process.pid,
  cwd: process.cwd(),
  home: process.env.HOME ?? '',
  tmpdir: process.env.TMPDIR ?? '',
});

const gate = await waitForGate(30_000);
if (gate === 'close') {
  clearTimeout(watchdog);
  process.exit(0);
}

const startedAt = Date.now();
let stdout = '';
let stderr = '';
let stdoutBytes = 0;
let stderrBytes = 0;
let outputOverflow = false;
let spawnError: string | null = null;

const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
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

const [command, ...commandArgs] = [...entryArgv, ...args] as [string, ...string[]];
const grandchild: ChildProcess = spawn(command, commandArgs, {
  cwd,
  env: childEnv ?? process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
grandchildHandle = grandchild;
grandchildAlive = true;
grandchild.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
grandchild.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
grandchild.on('error', (error: Error) => {
  spawnError = error.message;
});
if (closeRequested) {
  terminateGrandchild();
}

send({ kind: 'dist_cli_grandchild', pid: grandchild.pid ?? null });

const grandchildExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolveExit) => {
    // 'close' 为实际退出证据（'error'（如 ENOENT）后 'exit' 可能不触发）。
    grandchild.once('close', (code, signal) => {
      grandchildAlive = false;
      resolveExit({ code, signal });
    });
  },
);

send({
  kind: 'dist_cli_result',
  grandchildPid: grandchild.pid ?? null,
  exitCode: grandchildExit.code,
  signal: grandchildExit.signal,
  spawnError,
  stdout,
  stderr,
  stdoutBytes,
  stderrBytes,
  outputOverflow,
  elapsedMs: Date.now() - startedAt,
});

const after = await waitForCloseRequest(30_000);
clearTimeout(watchdog);
process.exit(after === 'close' ? (grandchildExit.code ?? (spawnError !== null ? 127 : 0)) : 9);
