/**
 * F-006 Host 启动入口受管子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 用途：在独立真实子进程中运行生产入口逻辑 runHostStartEntry（argv 由父进程
 * 经 config 受控注入，env 由 spawn 白名单决定），配合 managed-child 的
 * ready/go 屏障制造真实锁竞争，并核验退出码/信号。
 *
 * 协议（与 managed-child.ts 父进程侧对应）：
 * 1. 启动后立即发送 {kind:'ready', pid, cwd, home, tmpdir}；
 * 2. 等待 'go'（有界，超时退出码 9；放行前收到 close 直接退出码 0）；
 * 3. 放行后以 config.argv 调用 runHostStartEntry：
 *    - 成功：发送 {kind:'host_ready', result, stdoutLines}（result 为入口
 *      打印的脱敏结果，绝不含凭据），随后等待 {kind:'close'} → host.close()
 *      → {kind:'closed'} → 退出码 0；
 *    - 失败：发送 {kind:'host_start_failed', exitCode, stdoutLines, stderrLines}
 *      并以入口退出码退出；
 * 4. config.lockTimeoutMs（可选）仅作受信测试注入的锁预算，非 argv/env 行为。
 */
import { runHostStartEntry, wireHostSignalShutdown } from '../../../packages/host/src/runtime/index.ts';
import { readChildConfig } from './child-runtime.ts';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('host-entry-child 必须以 IPC 通道启动');
}

const config = readChildConfig();
const argv = config.argv;
if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) {
  throw new Error('config.argv 必须是字符串数组');
}
const lockTimeoutMs = config.lockTimeoutMs;
if (lockTimeoutMs !== undefined && !Number.isInteger(lockTimeoutMs)) {
  throw new Error('config.lockTimeoutMs 必须是整数毫秒');
}
const lockBudget = lockTimeoutMs as number | undefined;

const watchdog = setTimeout(() => {
  process.stderr.write('host-entry-child: watchdog 超时\n');
  process.exit(9);
}, 60_000);

send({
  kind: 'ready',
  pid: process.pid,
  cwd: process.cwd(),
  home: process.env.HOME ?? '',
  tmpdir: process.env.TMPDIR ?? '',
});

function waitForGate(timeoutMs: number): Promise<'go' | 'close'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      reject(new Error('host-entry-child: 等待父进程消息超时'));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (message === 'go') {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('go');
        return;
      }
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { kind?: unknown }).kind === 'close'
      ) {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve('close');
      }
    };
    process.on('message', onMessage);
  });
}

const gate = await waitForGate(30_000);
if (gate === 'close') {
  clearTimeout(watchdog);
  process.exit(0);
}

const stdoutLines: string[] = [];
const stderrLines: string[] = [];
const outcome = await runHostStartEntry(
  ['node', 'start.js', ...(argv as string[])],
  {
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
  },
  lockBudget === undefined ? undefined : { startOptions: { lockTimeoutMs: lockBudget } },
);

if (outcome.host === undefined) {
  send({
    kind: 'host_start_failed',
    pid: process.pid,
    exitCode: outcome.exitCode,
    stdoutLines,
    stderrLines,
  });
  process.exit(outcome.exitCode);
}

send({ kind: 'host_ready', pid: process.pid, result: outcome.result, stdoutLines });
// F-008（§10.7）：与 dist/start.js 相同的信号收尾装配——SIGTERM/SIGINT 走
// §10.5 安全顺序（quiesce→收尾→按实例清理→释锁），完成后以退出码 0 退出。
wireHostSignalShutdown(outcome.host, () => process.exit(0));
await waitForGate(30_000);
await outcome.host.close();
clearTimeout(watchdog);
send({ kind: 'closed', pid: process.pid });
process.exit(0);
