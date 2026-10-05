/**
 * F-010 启动器驱动子进程（仅测试夹具脚本，不进 packages/）。
 *
 * 用途：在独立真实子进程中扮演「CLI 客户端进程」运行生产启动器
 * ensureHostRunning，验证后台 Host 不依赖客户端 stdin/stdio/父进程存活：
 * - 父进程可以在 ensure_result 之后发送 close 让驱动正常退出（客户端退出），
 *   或直接 SIGKILL（客户端中途崩溃），Host 都必须继续存活；
 * - 驱动的 env 由 spawn 白名单决定；启动器为后台 Host 构造的子进程 env 默认
 *   从驱动 env 再做白名单（PATH/HOME/TMPDIR），不透传其他变量。
 *
 * 协议（与 managed-child.ts 父进程侧对应）：
 * 1. 启动后发送 {kind:'ready', pid, cwd, home, tmpdir}；
 * 2. 等待 'go'（有界，超时退出码 9；放行前收到 close 直接退出码 0）；
 * 3. 放行后以 config 调用 ensureHostRunning：
 *    config = { dataRoot, entryArgv: string[], childEnv?, startBudgetMs?,
 *               pollIntervalMs? }
 *    - 候选 spawn 后发送 {kind:'candidate_spawned', pid}（父进程据此可在
 *      启动中途 SIGKILL 驱动，制造确定性的「客户端中途退出」窗口）；
 *    - 成功发送 {kind:'ensure_result', outcome, hostInstanceId, port,
 *      candidatePid, becameHost}（全部为非秘密字段）；
 *    - 失败发送 {kind:'ensure_failed', code}（只发错误码，不发消息原文）；
 * 4. 此后等待 {kind:'close'} → 退出码 0（**绝不**停止已启动的 Host，
 *    模拟客户端退出不影响 Host）；watchdog 120s 兜底退出码 9。
 */
import { ensureHostRunning, isHostProtocolError } from '../../../packages/host/src/index.ts';
import { readChildConfig } from './child-runtime.ts';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('launcher-driver-child 必须以 IPC 通道启动');
}

const config = readChildConfig();
const dataRoot = config.dataRoot;
const entryArgv = config.entryArgv;
if (typeof dataRoot !== 'string' || !Array.isArray(entryArgv) || entryArgv.some((a) => typeof a !== 'string')) {
  throw new Error('config.dataRoot 必须是字符串且 config.entryArgv 必须是字符串数组');
}
const childEnv = config.childEnv;
if (childEnv !== undefined && (typeof childEnv !== 'object' || childEnv === null || Array.isArray(childEnv))) {
  throw new Error('config.childEnv 必须是对象');
}
const startBudgetMs = config.startBudgetMs;
if (startBudgetMs !== undefined && !Number.isInteger(startBudgetMs)) {
  throw new Error('config.startBudgetMs 必须是整数毫秒');
}
const pollIntervalMs = config.pollIntervalMs;
if (pollIntervalMs !== undefined && !Number.isInteger(pollIntervalMs)) {
  throw new Error('config.pollIntervalMs 必须是整数毫秒');
}

const watchdog = setTimeout(() => {
  process.stderr.write('launcher-driver-child: watchdog 超时\n');
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
      rejectGate(new Error('launcher-driver-child: 等待父进程消息超时'));
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

try {
  const result = await ensureHostRunning({
    dataRoot,
    entryArgv: entryArgv as string[],
    ...(childEnv !== undefined ? { childEnv: childEnv as Record<string, string> } : {}),
    ...(startBudgetMs !== undefined ? { startBudgetMs: startBudgetMs as number } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs: pollIntervalMs as number } : {}),
    onCandidateSpawned: (pid) => {
      try {
        send({ kind: 'candidate_spawned', pid });
      } catch {
        // IPC 已断开（父进程退出）：诊断回调绝不改变编排行为。
      }
    },
  });
  // 不调用 client.close() 以外的任何动作，更不停止 Host：客户端语义是
  // 「观察结束」，Host 存活由父进程用另一客户端认证 status 证明。
  result.client.close();
  send({
    kind: 'ensure_result',
    pid: process.pid,
    outcome: result.outcome,
    hostInstanceId: result.client.hostInstanceId,
    port: result.client.port,
    candidatePid: result.candidate?.pid ?? null,
    becameHost: result.candidate?.becameHost ?? null,
  });
} catch (error) {
  send({
    kind: 'ensure_failed',
    pid: process.pid,
    code: isHostProtocolError(error) ? error.code : 'unexpected',
  });
}

const after = await waitForGate(30_000);
clearTimeout(watchdog);
process.exit(after === 'close' ? 0 : 9);
