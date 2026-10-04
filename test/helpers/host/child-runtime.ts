/**
 * F-005 子进程侧 ready/go 屏障运行时（仅测试夹具脚本使用）。
 *
 * 协议（与 managed-child.ts 父进程侧严格对应）：
 * 1. 启动后立即发送 {kind:'ready', pid, cwd, home, tmpdir}——父进程据此核验
 *    OS pid 身份与环境隔离（HOME/TMPDIR/cwd 必须落在沙箱内）；
 * 2. 等待父进程 'go' 放行；屏障有界（goTimeoutMs），超时以退出码 9 失败，
 *    避免父进程异常时留下常驻进程；放行前若先收到 close 也直接退出码 0；
 * 3. 放行后执行场景；场景通过 reportListening 回传真实 127.0.0.1 监听；
 * 4. 收到 {kind:'close'} → closeRequested resolve，场景收尾后退出码 0；
 * 5. 场景抛错 → {kind:'rejected', code} 后退出码 1；另有 watchdog 兜底退出码 9。
 *
 * 本文件不定义任何产品行为，不导入 packages/（纯 node:内置模块）。
 */
export interface BarrierContext {
  /** argv[2] 解析出的场景配置（无参数时为空对象）。 */
  readonly config: Record<string, unknown>;
  /** 报告真实监听地址；只能报告 127.0.0.1（夹具不允许公开监听）。 */
  reportListening(port: number, address?: string): void;
  /** 收到 close 请求时 resolve；场景应在此后关闭监听并返回。 */
  readonly closeRequested: Promise<void>;
}

export interface BarrierScenario {
  readonly name: string;
  onGo(context: BarrierContext): Promise<void>;
}

export interface RunBarrierOptions {
  readonly scenario: BarrierScenario;
  readonly goTimeoutMs?: number;
  readonly watchdogMs?: number;
}

export function readChildConfig(): Record<string, unknown> {
  const raw = process.argv[2];
  if (raw === undefined) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('子进程配置必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export async function runBarrierChild(options: RunBarrierOptions): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) {
    throw new Error('屏障子进程必须以 IPC 通道启动');
  }
  const goTimeoutMs = options.goTimeoutMs ?? 30_000;
  const watchdogMs = options.watchdogMs ?? 60_000;

  const watchdog = setTimeout(() => {
    process.stderr.write(`fixture-child(${options.scenario.name}): watchdog 超时\n`);
    process.exit(9);
  }, watchdogMs);
  // 引用态计时器作为兜底：即便所有服务器/句柄都关闭，超时仍会强制失败退出。

  send({
    kind: 'ready',
    pid: process.pid,
    cwd: process.cwd(),
    home: process.env.HOME ?? '',
    tmpdir: process.env.TMPDIR ?? '',
  });

  let resolveGo: () => void = () => {};
  let resolveClose: () => void = () => {};
  const goGate = new Promise<void>((resolve) => {
    resolveGo = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const goTimer = setTimeout(() => {
    process.stderr.write(`fixture-child(${options.scenario.name}): 等待 go 屏障超时\n`);
    process.exit(9);
  }, goTimeoutMs);

  const onMessage = (message: unknown): void => {
    if (message === 'go') {
      clearTimeout(goTimer);
      resolveGo();
      return;
    }
    if (typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'close') {
      clearTimeout(goTimer);
      // 放行前收到协作关闭：直接 0 退出（父进程在做有界回收）。
      resolveClose();
      resolveGo();
    }
  };
  process.on('message', onMessage);

  await goGate;

  const context: BarrierContext = {
    config: readChildConfig(),
    reportListening(port: number, address = '127.0.0.1'): void {
      if (address !== '127.0.0.1') {
        throw new Error('夹具子进程只允许报告 127.0.0.1 监听');
      }
      send({ kind: 'listening', pid: process.pid, address, port });
    },
    closeRequested: closeGate,
  };

  try {
    await options.scenario.onGo(context);
    clearTimeout(watchdog);
    send({ kind: 'closed', pid: process.pid });
    process.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    send({
      kind: 'rejected',
      code: error instanceof Error && error.name ? error.name : 'unexpected',
    });
    process.stderr.write(
      `fixture-child(${options.scenario.name}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
