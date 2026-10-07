/**
 * F-013 CLI 驱动子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 用途：在独立真实子进程中扮演「CLI 客户端进程」，运行生产 CLI 执行层
 * runHostCli（与 dist/bin.js 相同的执行路径，argv/env/io 注入形态一致），
 * 配合 managed-child 的 ready/go 同步屏障制造真实多 CLI 竞争：
 *
 * 协议（与 managed-child.ts 父进程侧对应）：
 * 1. 启动后发送 {kind:'ready', pid, cwd, home, tmpdir}；
 * 2. 等待 'go'（有界 30s；放行前收到 close 直接退出码 0；超时退出码 9）；
 * 3. 放行后以 config 调用 runHostCli：
 *    config = { args: string[], entryArgv: string[], childEnv?: Record<string,string>,
 *               pollIntervalMs?: number }
 *    - 候选 spawn 经 onCandidateSpawned 钩子记录/上报 pid（只传 pid，非秘密）；
 *    - 结束（成功或失败）发送 {kind:'cli_result', pid, exitCode, runKind,
 *      command, envelope, candidatePids}——envelope 为 CLI 层 §13.3 脱敏信封，
 *      非 JSON 模式为 null；绝不上报 stdout/stderr 原文（可能含诊断文本）；
 * 4. 等待 {kind:'close'} → 以 CLI 退出码 process.exit（客户端退出绝不停止
 *    Host）；watchdog 120s 兜底退出码 9 防泄漏。
 */
import { runHostCli } from '../../../packages/cli/src/host/execute.ts';
import { readChildConfig } from './child-runtime.ts';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('cli-driver-child 必须以 IPC 通道启动');
}

const config = readChildConfig();
const args = config.args;
if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
  throw new Error('config.args 必须是字符串数组');
}
const entryArgv = config.entryArgv;
if (!Array.isArray(entryArgv) || entryArgv.some((item) => typeof item !== 'string')) {
  throw new Error('config.entryArgv 必须是字符串数组');
}
const childEnv = config.childEnv;
if (
  childEnv !== undefined &&
  (typeof childEnv !== 'object' || childEnv === null || Array.isArray(childEnv))
) {
  throw new Error('config.childEnv 必须是对象');
}
const pollIntervalMs = config.pollIntervalMs;
if (pollIntervalMs !== undefined && !Number.isInteger(pollIntervalMs)) {
  throw new Error('config.pollIntervalMs 必须是整数毫秒');
}

const watchdog = setTimeout(() => {
  process.stderr.write('cli-driver-child: watchdog 超时\n');
  process.exit(9);
}, 120_000);

send({
  kind: 'ready',
  pid: process.pid,
  cwd: process.cwd(),
  home: process.env.HOME ?? '',
  tmpdir: process.env.TMPDIR ?? '',
});

function waitForGate(timeoutMs: number): Promise<'go' | 'close'> {
  return new Promise((resolveGate, rejectGate) => {
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      rejectGate(new Error('cli-driver-child: 等待父进程消息超时'));
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

const gate = await waitForGate(30_000);
if (gate === 'close') {
  clearTimeout(watchdog);
  process.exit(0);
}

const candidatePids: number[] = [];
const result = await runHostCli({
  args: args as string[],
  env: {},
  io: {
    stdout: () => undefined,
    stderr: () => undefined,
  },
  launch: {
    entryArgv: entryArgv as string[],
    ...(childEnv !== undefined ? { childEnv: childEnv as Record<string, string> } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs: pollIntervalMs as number } : {}),
    onCandidateSpawned: (pid: number | undefined) => {
      if (pid !== undefined) {
        candidatePids.push(pid);
        try {
          send({ kind: 'candidate_spawned', pid });
        } catch {
          // IPC 已断开（父进程退出）：诊断回调绝不改变编排行为。
        }
      }
    },
  },
});

send({
  kind: 'cli_result',
  pid: process.pid,
  exitCode: result.exitCode,
  runKind: result.kind,
  command: result.command,
  envelope: result.envelope ?? null,
  candidatePids,
});

const after = await waitForGate(30_000);
clearTimeout(watchdog);
process.exit(after === 'close' ? result.exitCode : 9);
