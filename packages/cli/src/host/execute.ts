/**
 * F-012 CLI 纵向命令执行层（契约 §13 全部、§12.4、§10.6）。
 *
 * 与 F-011 纯面层的边界：
 * - 本模块允许 I/O：经 shiploop-host 公共面调用 ensureHostRunning（start）、
 *   connectToHost（status/stop）、受保护存储（stop 的 pid/发现证据）与
 *   acquireWriterLock（§10.6 锁释放证据）；不直连 shiploop-core、不打开
 *   SQLite、不内联启动 Host（后台 Host 只由启动器以独立 argv spawn）；
 * - 解析仍由纯面层 parseHostCliArgs 完成；解析失败在任何 I/O 之前返回退出码 2；
 * - start 才允许连接或启动（ensureHostRunning）；status/stop 永不启动 Host，
 *   无实例直接 host_not_found（退出码 3）；
 * - stop 绝不把 HTTP accepted/completed 回执或连接断开当已退出：必须取得
 *   §10.6 三条外部证据（进程退出、锁可被新候选获取、发现删除或被新实例替换）
 *   才报告 stopped，否则 stop_not_confirmed（退出码 1）并保留现场；
 * - 输出纪律：--json 时 stdout 只输出一个信封 JSON；人类诊断走 stderr；
 *   任何输出都不含 token、Authorization 头、绝对路径或堆栈。
 *
 * import 本模块即把 node:os/node:timers 与 Host 公共面装入图（有 I/O 能力），
 * 但不读 argv、不访问网络、不 spawn——只有 runHostCli 显式调用才执行；
 * packages/cli/src/index.ts 公共入口不 re-export 本模块（显式入口 bin.ts 专用）。
 */
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquireWriterLock,
  connectToHost,
  createHostFileStore,
  ensureHostRunning,
  isHostProtocolError,
  resolveConnectDataRoot,
  HostProtocolError,
  type HostClientTimeouts,
  type HostStatusResponse,
} from 'shiploop-host';
import { HostCliParseError, parseHostCliArgs } from './args.js';
import type {
  HostCliCommandId,
  HostCliSubcommand,
  ParsedHostCliCommand,
  ParsedStartCliCommand,
  ParsedStatusCliCommand,
  ParsedStopCliCommand,
} from './args.js';
import { getHostCliHelp } from './help.js';
import {
  CLI_EXIT_OK,
  buildHostCliFailureEnvelope,
  buildHostCliSuccessEnvelope,
  exitCodeForHostErrorCode,
  formatHostCliParseError,
} from './output.js';
import type {
  CliExitCode,
  HostCliFailureEnvelope,
  HostCliSuccessEnvelope,
} from './output.js';

export type { HostCliFailureEnvelope, HostCliSuccessEnvelope } from './output.js';

/** 输出端口：bin.ts 接 process.stdout/stderr；测试收集为字符串。 */
export interface HostCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 受信测试注入：启动器装配覆盖（干净树用 TS 入口；生产默认 dist/start.js）。 */
export interface HostCliLaunchOverrides {
  readonly entryArgv?: readonly string[];
  readonly nodeExecutable?: string;
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
  readonly pollIntervalMs?: number;
}

export interface RunHostCliOptions {
  /** process.argv.slice(2) 形态；不直接读 process.argv。 */
  readonly args: readonly string[];
  /** 显式注入的环境（bin.ts 传 process.env）；监听覆盖在此解析。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io: HostCliIo;
  /** 平台注入口（默认 process.platform）；非 darwin 在任何 I/O 前拒绝。 */
  readonly platform?: string;
  /** 用户目录注入口（默认 os.homedir()）；仅用于省略 --data-root 时推导默认根。 */
  readonly userHomeDir?: string;
  /** HostClient 有限预算覆盖（受信装配/测试注入；绝非 argv/env）。 */
  readonly timeouts?: HostClientTimeouts;
  /** 仅 start 使用的启动器覆盖（entryArgv/子进程 env 等）。 */
  readonly launch?: HostCliLaunchOverrides;
}

export type HostCliRunKind = 'success' | 'failure' | 'help';

export interface HostCliRunResult {
  readonly exitCode: CliExitCode;
  readonly kind: HostCliRunKind;
  /** 失败且命令不可识别时为 null；帮助为 null。 */
  readonly command: HostCliCommandId | null;
  /** --json 时即打印到 stdout 的信封；非 JSON/帮助时为 undefined。 */
  readonly envelope?: HostCliSuccessEnvelope<unknown> | HostCliFailureEnvelope;
}

/** start 成功结果（握手已双向核验的实例事实；不含 pid/token）。 */
export interface HostStartResult {
  readonly outcome: 'already_running' | 'started';
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly listenAddress: '127.0.0.1';
  readonly port: number;
  readonly protocolVersion: number;
  readonly lifecycleState: string;
  readonly startedAt: string;
}

/** §10.6 stop 成功结果：status 固定 stopped（证据判据，非 HTTP 回执状态）。 */
export interface HostStopResult {
  readonly commandId: string;
  readonly status: 'stopped';
  readonly hostInstanceId: string;
  readonly replayed: boolean;
  readonly evidence: {
    readonly processExit: 'confirmed';
    readonly lock: 'acquirable' | 'superseded';
    readonly discovery: 'removed' | 'replaced';
  };
}

/** 根来源二选一：显式 --data-root 优先，省略时才用注入用户目录推导默认根。 */
function rootSource(
  dataRoot: string | undefined,
  userHomeDir: string | undefined,
): { dataRoot?: string } | { userHomeDir?: string } {
  if (dataRoot !== undefined) {
    return { dataRoot };
  }
  return userHomeDir !== undefined ? { userHomeDir } : {};
}

const SUPPORTED_PLATFORM = 'darwin';
/** §10.6 证据轮询间隔（内部常量，不开放配置；整体由 --confirm-timeout-ms 有界化）。 */
const STOP_EVIDENCE_POLL_MS = 50;

function commandIdOf(command: HostCliSubcommand | null): HostCliCommandId | null {
  return command === null ? null : (`host.${command}` as HostCliCommandId);
}

interface FailureResult {
  readonly exitCode: 1 | 2 | 3;
  readonly command: HostCliCommandId | null;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 失败输出：JSON 信封到 stdout（--json）；人类诊断始终到 stderr。 */
function emitFailure(io: HostCliIo, json: boolean, failure: FailureResult): HostCliRunResult {
  const envelope = buildHostCliFailureEnvelope(
    failure.command,
    failure.code,
    failure.message,
    failure.details,
  );
  if (json) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  io.stderr(`shiploop: ${failure.code}: ${failure.message}\n`);
  return {
    exitCode: failure.exitCode,
    kind: 'failure',
    command: failure.command,
    ...(json ? { envelope } : {}),
  };
}

function protocolFailure(
  command: HostCliSubcommand,
  error: HostProtocolError,
): FailureResult {
  return {
    exitCode: exitCodeForHostErrorCode(error.code),
    command: commandIdOf(command),
    code: error.code,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

function startHumanLine(result: HostStartResult): string {
  const action = result.outcome === 'already_running' ? '已连接既有 Host' : 'Host 已启动并通过握手';
  return `shiploop host start: ${action} ${result.hostInstanceId}（${result.listenAddress}:${result.port}，${result.lifecycleState}）\n`;
}

function statusHumanLine(status: HostStatusResponse): string {
  return (
    `shiploop host status: ${status.lifecycleState} host=${status.hostInstanceId} pid=${status.pid} ` +
    `accepted=${status.activities.accepted} quiescing=${status.activities.quiescing} startedAt=${status.startedAt}\n`
  );
}

function stopHumanLine(result: HostStopResult): string {
  return (
    `shiploop host stop: stopped host=${result.hostInstanceId} command=${result.commandId} ` +
    `（证据：进程退出/锁${result.evidence.lock === 'acquirable' ? '可获' : '已被新实例接管'}/发现${result.evidence.discovery === 'removed' ? '删除' : '替换'}）\n`
  );
}

/** 成功输出：--json 信封到 stdout；否则人类行到 stdout。 */
function emitSuccess(
  io: HostCliIo,
  command: ParsedHostCliCommand,
  result: unknown,
  human: string,
): HostCliRunResult {
  const commandId = command.commandId;
  if (command.json) {
    const envelope = buildHostCliSuccessEnvelope(commandId, result);
    io.stdout(`${JSON.stringify(envelope)}\n`);
    return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId, envelope };
  }
  io.stdout(human);
  return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId };
}

/**
 * §10.6 证据快照（单轮，无循环）：
 * - processExited：ESRCH 才算退出；EPERM/其他 = 存活或不可判定，一律不确认；
 * - discoveryState：缺失=removed；实例不一致=replaced；同实例仍在=present；
 * - lockAcquirable：timeoutMs 0 的非阻塞 flock 尝试（无 ownerProbe，绝不联网），
 *   获锁即释、绝不打开 Core。发现已替换时不尝试获锁（避免打扰新写入者）。
 */
async function collectStopEvidence(
  canonicalRoot: string,
  platform: string,
  targetInstanceId: string,
  pid: number,
): Promise<{
  processExited: boolean;
  discoveryState: 'removed' | 'replaced' | 'present';
  lockAcquirable: boolean;
}> {
  let processExited = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      processExited = true;
    }
  }

  const store = createHostFileStore({ canonicalRoot, platform });
  let discoveryState: 'removed' | 'replaced' | 'present' = 'present';
  try {
    const record = store.readTrustedDiscovery();
    discoveryState = record.hostInstanceId === targetInstanceId ? 'present' : 'replaced';
  } catch (error) {
    if (isHostProtocolError(error, 'host_not_found')) {
      discoveryState = 'removed';
    }
    // 其余（invalid_discovery/unsafe_discovery/IO 错误）保守留在 present：不确认。
  }

  let lockAcquirable = false;
  if (discoveryState !== 'replaced') {
    try {
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0, platform });
      lock.releaseAfterWritesClosed();
      lockAcquirable = true;
    } catch {
      // 锁仍被持有或无法核验：不确认（不吞为成功）。
    }
  }
  return { processExited, discoveryState, lockAcquirable };
}

function evidenceComplete(
  evidence: { processExited: boolean; discoveryState: 'removed' | 'replaced' | 'present'; lockAcquirable: boolean },
): evidence is {
  processExited: true;
  discoveryState: 'removed' | 'replaced';
  lockAcquirable: boolean;
} {
  if (!evidence.processExited) {
    return false;
  }
  if (evidence.discoveryState === 'removed') {
    return evidence.lockAcquirable;
  }
  if (evidence.discoveryState === 'replaced') {
    // 新实例已能发布发现：旧锁必然已经 OS 释放并被新写入者获取。
    return true;
  }
  return false;
}

/** §10.6：在有限预算内轮询外部证据；预算 0 = 只做一次即时核验。 */
async function confirmStopped(
  canonicalRoot: string,
  platform: string,
  targetInstanceId: string,
  pid: number,
  budgetMs: number,
): Promise<HostStopResult['evidence'] | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const evidence = await collectStopEvidence(canonicalRoot, platform, targetInstanceId, pid);
    if (evidenceComplete(evidence)) {
      return {
        processExit: 'confirmed',
        lock: evidence.discoveryState === 'replaced' ? 'superseded' : 'acquirable',
        discovery: evidence.discoveryState,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return null;
    }
    await delay(Math.min(STOP_EVIDENCE_POLL_MS, remaining));
  }
}

async function runStart(
  parsed: ParsedStartCliCommand,
  options: RunHostCliOptions,
  platform: string,
): Promise<HostStartResult | HostProtocolError> {
  try {
    const ensured = await ensureHostRunning({
      ...rootSource(parsed.dataRoot, options.userHomeDir),
      platform,
      startBudgetMs: parsed.startTimeoutMs,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      ...(options.launch?.entryArgv !== undefined ? { entryArgv: options.launch.entryArgv } : {}),
      ...(options.launch?.nodeExecutable !== undefined
        ? { nodeExecutable: options.launch.nodeExecutable }
        : {}),
      ...(options.launch?.childEnv !== undefined ? { childEnv: options.launch.childEnv } : {}),
      ...(options.launch?.onCandidateSpawned !== undefined
        ? { onCandidateSpawned: options.launch.onCandidateSpawned }
        : {}),
      ...(options.launch?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.launch.pollIntervalMs }
        : {}),
    });
    const handshake = ensured.client.handshake;
    const result: HostStartResult = {
      outcome: ensured.outcome,
      hostInstanceId: ensured.client.hostInstanceId,
      dataRootIdentity: ensured.dataRootIdentity,
      listenAddress: '127.0.0.1',
      port: ensured.client.port,
      protocolVersion: handshake.protocolVersion,
      lifecycleState: handshake.lifecycleState,
      startedAt: handshake.startedAt,
    };
    ensured.client.close();
    return result;
  } catch (error) {
    if (isHostProtocolError(error)) {
      return error;
    }
    return new HostProtocolError('internal', 'host.discovery', '启动 Host 时发生未预期错误（已脱敏）');
  }
}

async function runStatus(
  parsed: ParsedStatusCliCommand,
  options: RunHostCliOptions,
  platform: string,
): Promise<HostStatusResponse | HostProtocolError> {
  try {
    const root = resolveConnectDataRoot(rootSource(parsed.dataRoot, options.userHomeDir));
    const client = await connectToHost({
      canonicalRoot: root.canonicalRoot,
      platform,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
    });
    try {
      return await client.status();
    } finally {
      client.close();
    }
  } catch (error) {
    if (isHostProtocolError(error)) {
      return error;
    }
    return new HostProtocolError('internal', 'host.status', '查询 Host 状态时发生未预期错误（已脱敏）');
  }
}

async function runStop(
  parsed: ParsedStopCliCommand,
  options: RunHostCliOptions,
  platform: string,
): Promise<HostStopResult | HostProtocolError> {
  try {
    const root = resolveConnectDataRoot(rootSource(parsed.dataRoot, options.userHomeDir));
    // 先经受保护存储取预期实例与 pid（仅用于 §10.6 进程退出证据；绝不按 pid 发信号）。
    const discovery = createHostFileStore({
      canonicalRoot: root.canonicalRoot,
      platform,
    }).readTrustedDiscovery();
    const client = await connectToHost({
      canonicalRoot: root.canonicalRoot,
      platform,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
    });
    let view: Awaited<ReturnType<typeof client.stop>>;
    try {
      // 省略 commandId 时由 HostClient 生成 UUID v4（解析层不生成）。
      view = await client.stop(
        parsed.stopCommandId !== undefined ? { commandId: parsed.stopCommandId } : {},
      );
    } finally {
      // close 只释放本地观察资源，绝不调用 stop（§12.3）。
      client.close();
    }

    const evidence = await confirmStopped(
      root.canonicalRoot,
      platform,
      discovery.hostInstanceId,
      discovery.pid,
      parsed.confirmTimeoutMs,
    );
    if (evidence === null) {
      const last = await collectStopEvidence(
        root.canonicalRoot,
        platform,
        discovery.hostInstanceId,
        discovery.pid,
      );
      return new HostProtocolError(
        'stop_not_confirmed',
        'host.stop',
        '停止请求已受理，但无法在预算内确认进程退出/锁释放/发现移除；保留现场，不报告 stopped',
        {
          details: {
            reason: 'stop_evidence_incomplete',
            confirmTimeoutMs: parsed.confirmTimeoutMs,
            httpViewStatus: view.status,
            evidence: {
              processExited: last.processExited,
              lockAcquirable: last.lockAcquirable,
              discoveryState: last.discoveryState,
            },
          },
        },
      );
    }
    return {
      commandId: view.commandId,
      status: 'stopped',
      hostInstanceId: discovery.hostInstanceId,
      replayed: view.replayed,
      evidence,
    };
  } catch (error) {
    if (isHostProtocolError(error)) {
      return error;
    }
    return new HostProtocolError('internal', 'host.stop', '停止 Host 时发生未预期错误（已脱敏）');
  }
}

/**
 * 执行一条 Host 生命周期 CLI 意图。解析（纯）→ 平台门禁 → 命令编排 →
 * §13.3 信封/退出码。返回退出码与（JSON 模式）信封；调用方（bin.ts）据此退出。
 */
export async function runHostCli(options: RunHostCliOptions): Promise<HostCliRunResult> {
  if (options === null || typeof options !== 'object' || options.io === null || typeof options.io !== 'object') {
    // 入口装配错误：无可用 io 时无法走正常输出；直接抛出，由 bin.ts 兜底。
    throw new HostProtocolError('internal', 'host.discovery', 'CLI 执行选项未通过校验');
  }
  const io = options.io;
  const jsonFlag = Array.isArray(options.args) && options.args.includes('--json');

  let parsed;
  try {
    parsed = parseHostCliArgs(options.args, options.env ?? {});
  } catch (error) {
    if (error instanceof HostCliParseError) {
      const details: Record<string, unknown> = { reason: error.reason };
      if (error.field !== undefined) {
        details.field = error.field;
      }
      const failure: FailureResult = {
        exitCode: 2,
        command: commandIdOf(error.command),
        code: error.code,
        message: error.message,
        details,
      };
      if (error.json || jsonFlag) {
        const envelope = buildHostCliFailureEnvelope(
          failure.command,
          failure.code,
          failure.message,
          failure.details,
        );
        io.stdout(`${JSON.stringify(envelope)}\n`);
      }
      // 解析失败的人类诊断用 F-011 受控格式（code/reason/参数名，不回显值）。
      io.stderr(formatHostCliParseError(error));
      return {
        exitCode: 2,
        kind: 'failure',
        command: failure.command,
        ...(error.json || jsonFlag
          ? {
              envelope: buildHostCliFailureEnvelope(
                failure.command,
                failure.code,
                failure.message,
                failure.details,
              ),
            }
          : {}),
      };
    }
    return emitFailure(io, jsonFlag, {
      exitCode: 2,
      command: null,
      code: 'invalid_input',
      message: '参数解析失败',
    });
  }

  if (parsed.kind === 'help') {
    io.stdout(getHostCliHelp(parsed.scope));
    return { exitCode: CLI_EXIT_OK, kind: 'help', command: null };
  }

  const command: ParsedHostCliCommand = parsed;
  const platform = options.platform ?? process.platform;
  if (platform !== SUPPORTED_PLATFORM) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'unsupported_platform',
      message: '当前平台不受支持（首版仅正式支持 macOS）',
      details: { reason: 'platform_not_darwin' },
    });
  }

  const outcome =
    command.command === 'start'
      ? await runStart(command, options, platform)
      : command.command === 'status'
        ? await runStatus(command, options, platform)
        : await runStop(command, options, platform);

  if (outcome instanceof HostProtocolError) {
    return emitFailure(io, command.json, protocolFailure(command.command, outcome));
  }

  const human =
    command.command === 'start'
      ? startHumanLine(outcome as HostStartResult)
      : command.command === 'status'
        ? statusHumanLine(outcome as HostStatusResponse)
        : stopHumanLine(outcome as HostStopResult);
  return emitSuccess(io, command, outcome, human);
}
