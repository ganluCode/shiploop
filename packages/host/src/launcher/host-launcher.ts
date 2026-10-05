/**
 * F-010 连接或启动编排与独立后台 Host 启动器（契约 §12.4、§6 owner 诊断）。
 *
 * 流程（§12.4 冻结步骤）：
 * 1. 先尝试「发现 → 握手」：成功即返回同一实例（already_running），不启动新进程；
 *    握手/认证/协议失败（unauthorized、protocol_incompatible、instance_mismatch、
 *    data_root_mismatch、redirect_rejected、response_malformed）按 §12.2 直接
 *    抛出对应诊断，绝不自动另起写入者；unsafe_discovery（文件形态不安全）同样
 *    不启动（§5.2：不覆盖可疑位置，新 Host 的发布会整体拒绝，启动是徒劳）。
 * 2. 初始结果为 host_not_found / unreachable / invalid_discovery（无实例或失效
 *    发现）时，仅经正式 Host 启动入口（§13.1）以独立 argv 数组 spawn：
 *    `nodeExecutable [...entryArgv, '--data-root', canonicalRoot]`——不经 shell、
 *    不字符串拼接、不 shell:true；候选 detached + stdio ignore + unref，
 *    不依赖 CLI 的 stdin/stdio/父进程存活；本模块永不打开 SQLite（Core 只能由
 *    获锁的 Host 子进程打开）。
 * 3. 在有限启动预算内轮询重新发现（默认 100ms）并完成握手；任何错误在轮询
 *    期都按瞬态处理（发现/凭据可能被胜者原子替换中），候选已自行退出则提前
 *    进入诊断。
 * 4. 竞争与失败处理：预算耗尽或候选退出后——先回收核验自有候选（SIGTERM →
 *    SIGKILL，有界确认；只针对 spawn 句柄 pid，绝不按发现里的 PID 杀进程），
 *    再做锁所有者诊断（诊断性 acquireWriterLock + probeDiscoveredHost，
 *    获锁即释、绝不打开 Core）：
 *    - owner_active → 以同一发现/凭据最后再连一次，失败则报 owner_active；
 *    - owner_unknown → 抛出（锁被占且无法核验持有者，§12.4.4）；
 *    - 锁空闲且候选曾自行退出 → internal/start_candidate_failed（附退出码）；
 *    - 锁空闲且预算耗尽 → start_timeout。
 *    任何失败路径都不留下未回收的自有候选进程。
 * 5. 连接成功后核对「候选是否即所连实例」（发现 hostInstanceId 与 pid 同时匹配
 *    才算）；落选/多余候选由启动器在有界预算内终止并核验退出——陈旧 PID 指向
 *    无关活进程时绝不终止无关进程（信号只发给自有 spawn 句柄）。
 *
 * 脱敏：错误 details 只含受控 reason/枚举/数值（退出码、预算毫秒），绝不回显
 * 凭据、绝对路径、env 值或原始错误文案。
 *
 * import 本模块无副作用：不 spawn、不联网、不读文件系统；只有
 * ensureHostRunning 显式调用才执行上述编排。
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deriveDefaultDataRoot } from 'shiploop-core';
import { HostProtocolError, isHostProtocolError, isPlainObject } from '../contract/index.js';
import { acquireWriterLock } from '../locking/index.js';
import { connectToHost, probeDiscoveredHost } from '../client/index.js';
import type { HostClient, HostClientTimeouts } from '../client/index.js';
import { createHostFileStore, resolveCanonicalDataRoot } from '../storage/index.js';
import { BIND_OVERRIDE_ENV_KEYS } from '../runtime/index.js';

/** 启动编排的操作身份（与锁/存储/启动模块一致：本地启动与发现关注点）。 */
const OPERATION = 'host.discovery';

/** §13.2：CLI --start-timeout-ms 默认值；库默认与之一致。 */
export const DEFAULT_START_BUDGET_MS = 15_000;
/** 启动预算允许区间（有限，绝不无界；受信注入可取更小值用于测试）。 */
export const MIN_START_BUDGET_MS = 100;
export const MAX_START_BUDGET_MS = 60_000;
/** §12.4.3 建议的重新发现轮询间隔（默认 100ms，允许 20..1 000）。 */
export const DEFAULT_POLL_INTERVAL_MS = 100;
export const MIN_POLL_INTERVAL_MS = 20;
export const MAX_POLL_INTERVAL_MS = 1_000;

/** 锁所有者诊断预算（ownerProbe 内部上限 1s + 余量；内部常量，不开放配置）。 */
const DIAGNOSIS_LOCK_BUDGET_MS = 1_500;
/** 回收自有候选时每个升级步骤（SIGTERM/SIGKILL）的有界等待。 */
const CANDIDATE_TERMINATE_STEP_MS = 1_000;

/**
 * 初始连接失败中允许继续「启动新 Host」的错误码（§12.4.5：失效发现只能由
 * 获锁的新 Host 原子替换；锁若仍被持有，候选会获锁失败并由诊断给出
 * owner_unknown）。其余错误（认证/协议/假服务/不安全发现）一律不启动。
 */
const INITIAL_LAUNCHABLE_CODES: ReadonlySet<string> = new Set([
  'host_not_found',
  'unreachable',
  'invalid_discovery',
]);

const OPTION_KEYS = [
  'dataRoot',
  'userHomeDir',
  'platform',
  'startBudgetMs',
  'pollIntervalMs',
  'entryArgv',
  'nodeExecutable',
  'childEnv',
  'timeouts',
  'onCandidateSpawned',
] as const;

export interface EnsureHostOptions {
  /** 显式数据根（POSIX 绝对路径；start 语义允许创建根目录本身 0700）。 */
  readonly dataRoot?: string;
  /** 注入的用户目录（推导 P01 默认根）；与 dataRoot 二选一，缺省取 os.homedir()。 */
  readonly userHomeDir?: string;
  /** 平台注入口（默认 process.platform）；仅 'darwin' 受支持。 */
  readonly platform?: string;
  /** 启动预算（默认 15 000 ms；允许 100..60 000，有限且有界）。 */
  readonly startBudgetMs?: number;
  /** 重新发现轮询间隔（默认 100 ms；允许 20..1 000）。 */
  readonly pollIntervalMs?: number;
  /**
   * 受信装配/测试注入：execPath 之后的入口 argv 前缀（默认
   * [dist/start.js]；干净树测试注入 TS 加载器 + 等价 TS 入口）。
   * 绝非来自发现文件/网络输入。
   */
  readonly entryArgv?: readonly string[];
  /** Node 可执行文件（默认 process.execPath；必须是绝对路径）。 */
  readonly nodeExecutable?: string;
  /**
   * 受信注入的后台 Host 子进程完整环境（默认从 process.env 白名单
   * PATH/HOME/TMPDIR 构造）；含 SHIPLOOP_HOST_* 监听覆盖变量一律拒绝
   * （bind_address_override_rejected），与 Host 入口同纪律。
   */
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  /** 复用 HostClient 的有限预算（连接/握手/status/stop）。 */
  readonly timeouts?: HostClientTimeouts;
  /**
   * 受信诊断钩子：候选 spawn 后回调其 pid（可能 undefined=spawn 失败）。
   * 回调异常被吞没，绝不改变编排行为；pid 只用于诊断/回收核验。
   */
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
}

export interface CandidateExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  /** spawn 本身失败（如可执行文件不存在）时为 true。 */
  readonly spawnFailed: boolean;
}

export interface EnsuredHostCandidate {
  /** 自有候选的 spawn 句柄 pid（spawn 失败为 undefined）。 */
  readonly pid: number | undefined;
  /** 该候选是否即本次连接到的 Host（发现 hostInstanceId 与 pid 同时匹配）。 */
  readonly becameHost: boolean;
  /** 未成为 Host 时，启动器已在有界预算内核验其退出（self 退出或被回收）。 */
  readonly exit?: CandidateExitInfo;
}

export interface EnsureHostResult {
  /** already_running：第 1 步直接连接既有实例；started：经候选启动后连接。 */
  readonly outcome: 'already_running' | 'started';
  /** 已完成握手双向核验的客户端会话；close() 只释放本地观察资源。 */
  readonly client: HostClient;
  readonly canonicalRoot: string;
  readonly dataRootIdentity: string;
  /** 本次调用 spawn 过的候选（没有 spawn 则为 undefined）。 */
  readonly candidate?: EnsuredHostCandidate;
}

interface ResolvedEnsureOptions {
  readonly dataRoot?: string;
  readonly userHomeDir?: string;
  readonly platform: string;
  readonly startBudgetMs: number;
  readonly pollIntervalMs: number;
  readonly entryArgv: readonly string[];
  readonly nodeExecutable: string;
  readonly childEnv: NodeJS.ProcessEnv;
  readonly timeouts?: HostClientTimeouts;
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
}

function invalidInput(reason: string, details: Record<string, unknown> = {}): HostProtocolError {
  return new HostProtocolError('invalid_input', OPERATION, '启动器选项未通过校验', {
    details: { reason, ...details },
  });
}

/** 生产默认入口：dist/start.js（契约 §13.1）；模块加载时只计算路径字符串。 */
function defaultEntryArgv(): readonly string[] {
  return [fileURLToPath(new URL('../start.js', import.meta.url))];
}

/** 默认子进程环境：白名单 PATH/HOME/TMPDIR，不透传任何其他父进程变量。 */
function defaultChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const value = source[key];
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function requireBoundedInteger(
  value: number | undefined,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidInput('invalid_budget', { field });
  }
  return value;
}

/** 纯形态校验（零 I/O）：任何拒绝都发生在文件系统/网络/进程动作之前。 */
function resolveEnsureOptions(options: EnsureHostOptions): ResolvedEnsureOptions {
  // input 只做形态校验（unknown 面）；typed 字段读取走未被收窄的 options。
  const input: unknown = options;
  if (!isPlainObject(input)) {
    throw invalidInput('invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('unknown_option_key', { field: key });
    }
  }
  if (options.dataRoot !== undefined && options.userHomeDir !== undefined) {
    throw invalidInput('root_source_ambiguous', { field: 'dataRoot' });
  }
  if (options.dataRoot !== undefined) {
    if (typeof options.dataRoot !== 'string' || options.dataRoot.length === 0) {
      throw invalidInput('invalid_root_type', { field: 'dataRoot' });
    }
    if (options.dataRoot.includes('\0') || !isAbsolute(options.dataRoot)) {
      throw invalidInput('not_absolute', { field: 'dataRoot' });
    }
  }
  if (
    options.userHomeDir !== undefined &&
    (typeof options.userHomeDir !== 'string' || options.userHomeDir.length === 0)
  ) {
    throw invalidInput('invalid_home_type', { field: 'userHomeDir' });
  }
  if (options.platform !== undefined && typeof options.platform !== 'string') {
    throw invalidInput('invalid_platform_type', { field: 'platform' });
  }
  const entryArgvInput: unknown = options.entryArgv ?? defaultEntryArgv();
  if (!Array.isArray(entryArgvInput) || entryArgvInput.length === 0) {
    throw invalidInput('invalid_entry_argv', { field: 'entryArgv' });
  }
  for (const argument of entryArgvInput) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.includes('\0')) {
      throw invalidInput('invalid_entry_argv', { field: 'entryArgv' });
    }
  }
  const entryArgv: readonly string[] = entryArgvInput as readonly string[];
  const nodeExecutable: string = options.nodeExecutable ?? process.execPath;
  if (
    typeof nodeExecutable !== 'string' ||
    nodeExecutable.length === 0 ||
    nodeExecutable.includes('\0') ||
    !isAbsolute(nodeExecutable)
  ) {
    throw invalidInput('invalid_node_executable', { field: 'nodeExecutable' });
  }
  let childEnv: NodeJS.ProcessEnv;
  if (options.childEnv !== undefined) {
    if (!isPlainObject(options.childEnv)) {
      throw invalidInput('invalid_child_env', { field: 'childEnv' });
    }
    childEnv = {};
    for (const [key, value] of Object.entries(options.childEnv)) {
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string') {
        throw invalidInput('invalid_child_env', { field: 'childEnv' });
      }
      childEnv[key] = value;
    }
  } else {
    childEnv = defaultChildEnv(process.env);
  }
  // 监听地址覆盖零容忍（§13.2）：传给后台 Host 的 env 里出现覆盖变量即拒，
  // details 只含变量名（受控枚举），绝不回显取值。
  for (const name of BIND_OVERRIDE_ENV_KEYS) {
    const value = childEnv[name];
    if (typeof value === 'string' && value.length > 0) {
      throw new HostProtocolError(
        'bind_address_override_rejected',
        OPERATION,
        '拒绝监听地址覆盖：Host 只监听 127.0.0.1，不提供公网监听能力',
        { details: { reason: 'listen_override_env_rejected', variable: name } },
      );
    }
  }
  if (
    options.onCandidateSpawned !== undefined &&
    typeof options.onCandidateSpawned !== 'function'
  ) {
    throw invalidInput('invalid_candidate_hook', { field: 'onCandidateSpawned' });
  }
  const timeouts = options.timeouts as HostClientTimeouts | undefined;
  const onCandidateSpawned = options.onCandidateSpawned as
    | ((pid: number | undefined) => void)
    | undefined;
  return {
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.userHomeDir !== undefined ? { userHomeDir: options.userHomeDir } : {}),
    platform: (options.platform ?? process.platform) as string,
    startBudgetMs: requireBoundedInteger(
      options.startBudgetMs,
      'startBudgetMs',
      DEFAULT_START_BUDGET_MS,
      MIN_START_BUDGET_MS,
      MAX_START_BUDGET_MS,
    ),
    pollIntervalMs: requireBoundedInteger(
      options.pollIntervalMs,
      'pollIntervalMs',
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
    entryArgv,
    nodeExecutable,
    childEnv,
    ...(timeouts !== undefined ? { timeouts } : {}),
    ...(onCandidateSpawned !== undefined ? { onCandidateSpawned } : {}),
  };
}

interface SpawnedCandidate {
  readonly pid: number | undefined;
  /** 已观察到的退出结果（exit 或 spawn error，先到先得）。 */
  observed(): CandidateExitInfo | undefined;
  /** 等待退出观测（exit/spawn-error 均 resolve）。 */
  readonly exited: Promise<CandidateExitInfo>;
  /** SIGTERM →（有界等待）→ SIGKILL →（有界等待）；仍无法核验则抛 internal。 */
  terminate(): Promise<CandidateExitInfo>;
}

/**
 * §12.4.2：detached + stdio ignore + unref 的独立后台候选；独立 argv 数组，
 * 不经 shell、不字符串拼接。CLI/调用方进程自身不打开 SQLite。
 */
function spawnHostCandidate(resolved: ResolvedEnsureOptions, canonicalRoot: string): SpawnedCandidate {
  const argv = [...resolved.entryArgv, '--data-root', canonicalRoot];
  const child = spawn(resolved.nodeExecutable, argv, {
    detached: true,
    stdio: 'ignore',
    env: resolved.childEnv,
  });
  // 父进程退出不影响候选；事件监听不阻止父进程自然退出。
  child.unref();

  let observedExit: CandidateExitInfo | undefined;
  let resolveExited: (exit: CandidateExitInfo) => void = () => undefined;
  const exited = new Promise<CandidateExitInfo>((resolveExit) => {
    resolveExited = resolveExit;
  });
  const observe = (exit: CandidateExitInfo): void => {
    if (observedExit === undefined) {
      observedExit = exit;
      resolveExited(exit);
    }
  };
  child.once('error', () => {
    observe({ code: null, signal: null, spawnFailed: true });
  });
  child.once('exit', (code, signal) => {
    observe({ code, signal, spawnFailed: false });
  });

  return {
    pid: child.pid,
    exited,
    observed: () => observedExit,
    async terminate(): Promise<CandidateExitInfo> {
      if (observedExit !== undefined) {
        return observedExit;
      }
      const waitStep = async (): Promise<boolean> =>
        Promise.race([exited.then(() => true), delay(CANDIDATE_TERMINATE_STEP_MS).then(() => false)]);
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (observedExit !== undefined) {
          break;
        }
        try {
          // 只发信号给自有 spawn 句柄 pid；发现文件里的 PID 从不作为信号目标。
          child.kill(signal);
        } catch {
          // 句柄已失效时继续等待 exit 观测。
        }
        if (await waitStep()) {
          break;
        }
      }
      if (observedExit === undefined) {
        throw new HostProtocolError(
          'internal',
          OPERATION,
          '无法核验启动候选已退出，保留现场（不冒充已回收）',
          {
            details: {
              reason: 'candidate_exit_unconfirmed',
              ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
            },
          },
        );
      }
      return observedExit;
    },
  };
}

/** 锁所有者诊断（§6）：诊断性获取，绝不打开 Core/写库；获锁即释。 */
async function diagnoseLockOwnership(
  canonicalRoot: string,
  platform: string,
): Promise<'free' | 'owner_active' | 'owner_unknown'> {
  try {
    const lock = await acquireWriterLock({
      canonicalRoot,
      timeoutMs: DIAGNOSIS_LOCK_BUDGET_MS,
      platform,
      ownerProbe: (discovery, token, signal) =>
        probeDiscoveredHost({ discovery, token, signal }),
    });
    lock.releaseAfterWritesClosed();
    return 'free';
  } catch (error) {
    if (isHostProtocolError(error, 'owner_active')) {
      return 'owner_active';
    }
    if (isHostProtocolError(error, 'owner_unknown')) {
      return 'owner_unknown';
    }
    throw error;
  }
}

/**
 * 连接成功后核对「自有候选是否即所连实例」：仅当受保护发现同时匹配
 * hostInstanceId 与候选 pid 才成立；无法证明时按「多余候选」回收（保守方向
 * 是回收自有进程，绝不误杀发现里的 PID）。
 */
function isCandidateTheConnectedHost(
  canonicalRoot: string,
  connectedInstanceId: string,
  candidatePid: number | undefined,
): boolean {
  if (candidatePid === undefined) {
    return false;
  }
  try {
    const record = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
    return record.hostInstanceId === connectedInstanceId && record.pid === candidatePid;
  } catch {
    return false;
  }
}

/**
 * §12.4 连接或启动：有效既有实例直接连接；否则经正式入口 spawn 后台候选并
 * 在有限预算内重新发现胜者；失败路径回收自有候选并给出 owner_unknown /
 * start_timeout / start_candidate_failed 等精确诊断。
 */
export async function ensureHostRunning(options: EnsureHostOptions): Promise<EnsureHostResult> {
  const resolved = resolveEnsureOptions(options);
  if (resolved.platform !== 'darwin') {
    throw new HostProtocolError('unsupported_platform', OPERATION, '首版仅正式支持 macOS', {
      details: { reason: 'platform_not_darwin' },
    });
  }
  // start 语义：仅 start 允许创建数据根目录本身（0700），status/stop 不经本流程。
  const { canonicalRoot, dataRootIdentity } = resolveCanonicalDataRoot(
    resolved.dataRoot !== undefined
      ? { dataRoot: resolved.dataRoot, createIfMissing: true }
      : {
          defaultDataRoot: deriveDefaultDataRoot(resolved.userHomeDir ?? homedir()),
          createIfMissing: true,
        },
  );
  const connect = (): Promise<HostClient> =>
    connectToHost({
      canonicalRoot,
      platform: resolved.platform,
      ...(resolved.timeouts !== undefined ? { timeouts: resolved.timeouts } : {}),
    });

  // §12.4 第 1 步：先发现→握手；成功即同一实例，不启动新进程。
  try {
    const client = await connect();
    return { outcome: 'already_running', client, canonicalRoot, dataRootIdentity };
  } catch (error) {
    if (!isHostProtocolError(error)) {
      throw error;
    }
    if (!INITIAL_LAUNCHABLE_CODES.has(error.code)) {
      // §12.2/§5.2：认证/协议/假服务/不安全发现一律不自动另起写入者。
      throw error;
    }
  }

  // §12.4 第 2 步：独立 argv spawn 正式入口候选（detached，不依赖父进程）。
  const candidate = spawnHostCandidate(resolved, canonicalRoot);
  try {
    resolved.onCandidateSpawned?.(candidate.pid);
  } catch {
    // 诊断钩子异常不改变编排行为。
  }

  const deadline = Date.now() + resolved.startBudgetMs;
  try {
    // §12.4 第 3 步：预算内轮询重新发现胜者并完成握手。
    while (Date.now() < deadline) {
      if (candidate.observed() !== undefined) {
        break; // 候选已自行退出（如锁被占 owner_unknown）：提前进入诊断。
      }
      try {
        const client = await connect();
        return await finalizeStarted(client, candidate, canonicalRoot, dataRootIdentity);
      } catch (error) {
        if (!isHostProtocolError(error)) {
          throw error;
        }
        // 轮询期的发现/凭据不一致与连接失败都可能是原子替换中的瞬态；
        // 预算内有界重试，不折算为「发现不存在」之外的结论。
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await delay(Math.min(resolved.pollIntervalMs, remaining));
      }
    }
    // 预算边界上的最后一次直连（候选可能恰好刚发布）。
    try {
      const client = await connect();
      return await finalizeStarted(client, candidate, canonicalRoot, dataRootIdentity);
    } catch (error) {
      if (!isHostProtocolError(error)) {
        throw error;
      }
    }

    // §12.4 第 4/6 步：先回收核验自有候选（有界），再诊断锁所有者。
    const selfExited = candidate.observed() !== undefined;
    await candidate.terminate();
    const ownership = await diagnoseLockOwnership(canonicalRoot, resolved.platform);
    if (ownership === 'owner_active') {
      // 可核验持有者：探测与连接使用同一受保护发现/凭据，最后再连一次。
      try {
        const client = await connect();
        return {
          outcome: 'started',
          client,
          canonicalRoot,
          dataRootIdentity,
          candidate: { pid: candidate.pid, becameHost: false, exit: candidate.observed() },
        };
      } catch {
        throw new HostProtocolError('owner_active', OPERATION, '已有可认证的 Host 持有写入锁', {
          details: { reason: 'authenticated_owner', dataRootIdentity },
        });
      }
    }
    if (ownership === 'owner_unknown') {
      throw new HostProtocolError(
        'owner_unknown',
        OPERATION,
        '写入锁被占用，无法核验当前实例；拒绝接管（候选已回收）',
        { details: { reason: 'lock_busy_owner_unverified', dataRootIdentity } },
      );
    }
    if (!selfExited) {
      throw new HostProtocolError('start_timeout', OPERATION, '等待 Host 启动超时（候选已回收）', {
        details: { reason: 'start_budget_exhausted', startBudgetMs: resolved.startBudgetMs },
      });
    }
    const exit = candidate.observed();
    throw new HostProtocolError('internal', OPERATION, 'Host 启动候选失败且写入锁空闲（已脱敏）', {
      details: {
        reason: 'start_candidate_failed',
        exitCode: exit?.code ?? null,
        exitSignal: exit?.signal ?? null,
        ...(exit?.spawnFailed === true ? { spawnFailed: true } : {}),
      },
    });
  } catch (terminal) {
    // 兜底：任何失败路径都不留下未回收的自有候选进程。
    if (candidate.observed() === undefined) {
      await candidate.terminate().catch(() => undefined);
    }
    throw terminal;
  }
}

/** 成功收尾：落选/多余候选必须被有界回收并核验退出，才允许返回成功。 */
async function finalizeStarted(
  client: HostClient,
  candidate: SpawnedCandidate,
  canonicalRoot: string,
  dataRootIdentity: string,
): Promise<EnsureHostResult> {
  if (isCandidateTheConnectedHost(canonicalRoot, client.hostInstanceId, candidate.pid)) {
    return {
      outcome: 'started',
      client,
      canonicalRoot,
      dataRootIdentity,
      candidate: { pid: candidate.pid, becameHost: true },
    };
  }
  // 竞争者胜出（或不可核验）：回收自有落选候选并核验退出，不留未管理进程。
  const exit = await candidate.terminate();
  return {
    outcome: 'started',
    client,
    canonicalRoot,
    dataRootIdentity,
    candidate: { pid: candidate.pid, becameHost: false, exit },
  };
}
