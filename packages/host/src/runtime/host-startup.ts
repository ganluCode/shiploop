/**
 * F-006 Host 启动装配（契约 §11 启动顺序、§5.2 发布时机、§13.2/T23 覆盖零容忍、
 * §4 每次启动全新实例与凭据）。
 *
 * 顺序不变量（任一失败即关闭已打开资源、按获取逆序释锁、不发布 ready）：
 * 1. 启动选项形态校验（未知键拒绝；监听地址覆盖键 bind/host/address/port/listen*
 *    一律 bind_address_override_rejected）——在任何 I/O 之前；
 * 2. 环境变量覆盖零容忍（SHIPLOOP_HOST_BIND/HOST/PORT/ADDRESS/LISTEN* 非空即拒）；
 * 3. 平台检查：非 darwin → unsupported_platform（不创建数据根、不降级）；
 * 4. resolveCanonicalDataRoot（仅 start 语义允许创建根目录本身 0700；默认根由
 *    注入用户目录经 P01 deriveDefaultDataRoot 推导，不读真实 HOME 的隐式状态——
 *    userHomeDir 缺省时才取 os.homedir()）；
 * 5. openLockedWriter：先获 macOS flock，获锁后工厂内 openCoreApplication
 *    （打开状态库 + 版本化迁移；未知高版本 Schema 拒写并自动释锁）；
 * 6. 新 hostInstanceId（randomUUID）+ 新凭据（randomBytes(32)，0600，先凭据
 *    后发现）；创建生命周期传输面（F-007，认证从第一个请求起生效）；
 * 7. 监听 127.0.0.1:0（端口 0 = 由系统分配）；核验 server.address() 恰为
 *    127.0.0.1 且取得 1..65535 的实际端口——发现中的端口必须等于该值；
 * 8. 原子发布 discovery.json（发布是“就绪提交点”：发布失败不留下可连接的
 *    半文件——仅存 0600 凭据不构成可连接面，下次启动原子替换）；
 * 9. 生命周期 starting → ready（quiescing/stopping 由 F-008 的停止流程接管）。
 *
 * F-007 起监听器为真实生命周期传输面（createHostLifecycleServer，见
 * http-transport.ts）；F-008 起 stop 路由由停止控制器接线（host-stop.ts，
 * §10.4 幂等矩阵、§10.5 关闭顺序、§10.7 信号收尾）：F-013 生产门控合并
 * 基线和额外活动，获锁后先恢复核对，stop → quiescing → 确认停止 → stopping（关 listener）→ 关 Core → 持锁
 * 按实例清理发现/凭据 → 200 最终视图 → 释锁 → 进程退出。本模块 close()
 * 仍是装配级拆卸（不删除发现/凭据），但会等待在途停止尝试并不重复释锁。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不加载原生模块、不读
 * process.env（只有 startHost 显式调用才读取注入的 env 或 process.env）。
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { createLocalOwnerPrincipal, deriveDefaultDataRoot } from 'shiploop-core';
import type { RuntimeCapabilityCatalog, RuntimeRecoveryCapabilities, RuntimeRecoverySourceReader, WorkToolChannelDeps } from 'shiploop-core';
import { openCoreApplication } from 'shiploop-core/assembly';
import { PI_RUNTIME_RECOVERY_DESCRIPTOR } from './pi-adapter.js';
import type { BatchDeliveryFactory } from 'shiploop-core/assembly';
import type { CoreApplication, WorkRuntimeFactory, FeatureDeliveryFactory, CoreApplicationOptions } from 'shiploop-core/assembly';
import type { FinalizationCompletionPort, FinalizationExecutionPort } from 'shiploop-core';
import {
  HostProtocolError,
  LOOPBACK_LISTEN_ADDRESS,
  QUIESCE_BUDGET_MS,
} from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import { createHostFileStore, resolveCanonicalDataRoot } from '../storage/index.js';
import { openLockedWriter } from '../locking/index.js';
import type { WriterLockOptions } from '../locking/index.js';
import { createHostLifecycleServer } from './http-transport.js';
import { createHostStopController } from './host-stop.js';
import type { HostActivityGate, SignalShutdownOutcome } from './host-stop.js';
import { createEventStreamHub } from './sse-transport.js';
import { createHostWorkToolAccess } from './work-tool-access.js';
import type { HostWorkToolAccess } from './work-tool-access.js';

/** 启动阶段错误的操作身份（与锁/存储模块一致：本地启动/发现关注点）。 */
const OPERATION = 'host.discovery';

/**
 * 监听地址覆盖零容忍（§13.2/T23）：这些选项键一旦出现即拒，无论取值；
 * 产品不提供修改监听地址的能力。
 */
const BIND_OVERRIDE_OPTION_KEYS = [
  'bind',
  'bindAddress',
  'bind_address',
  'host',
  'hostname',
  'address',
  'listen',
  'listenAddress',
  'listen_address',
  'port',
  'publicAddress',
  'advertiseAddress',
] as const;

/** 环境变量形式的监听覆盖（§13.2 列名 + listen/address 变体）；非空即拒。 */
export const BIND_OVERRIDE_ENV_KEYS = [
  'SHIPLOOP_HOST_BIND',
  'SHIPLOOP_HOST_HOST',
  'SHIPLOOP_HOST_PORT',
  'SHIPLOOP_HOST_ADDRESS',
  'SHIPLOOP_HOST_LISTEN',
  'SHIPLOOP_HOST_LISTEN_ADDRESS',
] as const;

const ALLOWED_OPTION_KEYS = [
  'workToolAuthority',
  'workRuntimeFactory',
  'workRecordingMode',
  'batchDeliveryFactory',
  'featureDeliveryFactory',
  'integrationPlanFactory',
  'finalizationExecution',
  'finalizationCompletion',
  'dataRoot',
  'userHomeDir',
  'capabilityCatalog',
  'runtimeRecoveryDescriptors',
  'runtimeRecoverySources',
  'projectResourceSources',
  'platform',
  'env',
  'nativeAddonPath',
  'lockTimeoutMs',
  'ownerProbe',
  'activityGate',
  'baselineStopPolicy',
  'quiesceBudgetMs',
] as const;

export interface HostStartOptions {
  /** Trusted live Work/policy lookup; never populated from CLI, HTTP, env or native session data. */
  readonly workToolAuthority?: Pick<WorkToolChannelDeps, 'currentBinding' | 'candidateContext'>;
  /** Trusted code injection only; not accepted from CLI, environment or discovery. */
  readonly workRuntimeFactory?: WorkRuntimeFactory;
  /** Explicit trusted recording policy; omitted means required. Not a request/env/CLI option. */
  readonly workRecordingMode?: CoreApplicationOptions['workRecordingMode'];
  /** Static trusted adapters only; never read from argv, env or request fields. */
  readonly batchDeliveryFactory?: BatchDeliveryFactory;
  readonly featureDeliveryFactory?: FeatureDeliveryFactory;
  /** Trusted finalization-only execution consumer; absent keeps the scheduler capability gap. */
  readonly finalizationExecution?: FinalizationExecutionPort;
  /** Trusted integration facts and delivery evidence readers. */
  readonly integrationPlanFactory?: CoreApplicationOptions['integrationPlanFactory'];
  /** Trusted finalization approval/commit/completion consumer; absent keeps the capability gap. */
  readonly finalizationCompletion?: FinalizationCompletionPort;
  /** 显式数据根（POSIX 绝对路径）；与 userHomeDir 二选一。 */
  readonly dataRoot?: string;
  /** 注入的用户目录（推导 P01 默认根）；与 dataRoot 二选一，缺省取 os.homedir()。 */
  readonly userHomeDir?: string;
  /** 可信装配注入的只读能力目录（空目录 = 不装配任何 runtime，fail-closed）。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  /** 可信恢复能力证据；仅静态装配，不能由 CLI、环境或请求提供。 */
  readonly runtimeRecoveryDescriptors?: readonly RuntimeRecoveryCapabilities[];
  /** Trusted source resolver supplied by the embedding application, never argv or HTTP. */
  readonly projectResourceSources?: CoreApplicationOptions['projectResourceSources'];
  /** Core 恢复来源权威；缺省时恢复来源请求保持拒绝。 */
  readonly runtimeRecoverySources?: RuntimeRecoverySourceReader;
  /** 平台注入口（默认 process.platform）；仅 'darwin' 受支持。 */
  readonly platform?: string;
  /** 环境检查注入口（默认 process.env）；只读，不修改。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 受信装配/测试注入的原生锁适配器路径；绝非 argv/env/发现字段。 */
  readonly nativeAddonPath?: string;
  /** 锁获取有限预算（内部常量上限内；0 = 单次非阻塞尝试）。 */
  readonly lockTimeoutMs?: number;
  /** owner 诊断可信探测端口（F-004 定义；F-007 起由传输层提供真实实现）。 */
  readonly ownerProbe?: WriterLockOptions['ownerProbe'];
  /**
   * §10.2 额外窄活动控制端口（受信装配/测试注入），与生产基线门控合并。
   * 绝非 argv/env/发现字段；任何注入门控都不能覆盖或越过基线占用。
   */
  readonly activityGate?: HostActivityGate;
  /** Trusted explicit stop strategy; wait never implicitly cancels project scripts. */
  readonly baselineStopPolicy?: 'wait' | 'cancel';
  /** quiesce 有限预算（默认 10 000 ms；注入只允许 0..QUIESCE_BUDGET_MS）。 */
  readonly quiesceBudgetMs?: number;
}

export interface RunningHost {
  /** Trusted controller only. Pass just an issued restricted token through a controlled tool channel. */
  readonly workTools: HostWorkToolAccess;
  readonly hostInstanceId: string;
  readonly canonicalRoot: string;
  readonly dataRootIdentity: string;
  readonly listenAddress: typeof LOOPBACK_LISTEN_ADDRESS;
  /** 套接字实际分配端口（与发现文件一致）。 */
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  /** 实时生命周期状态（F-006：ready；close 后 stopping）。 */
  readonly lifecycleState: LifecycleState;
  /** 已装配 Core（F-007 起的认证路由与后续能力复用；不经本面暴露会话/驱动）。 */
  readonly core: CoreApplication;
  /**
   * 装配级拆卸：等待在途停止尝试 → 关闭监听 → 关闭 Core → 释放 OS 锁；
   * 幂等，并发合并，活动或持久隔离未确认时拒绝并保留锁。不是 §10 的停止流程
   * （不删除发现/凭据）；若 §10.5
   * 收尾已完成（HTTP stop/SIGTERM），close() 不再重复关闭或释锁。
   */
  close(): Promise<void>;
  /**
   * §10.7 信号收尾（SIGTERM/SIGINT 同一路径）：quiesce → 收尾 → 按实例清理
   * → 释锁；无 commandId 与回执承诺。未确认返回 unconfirmed 并保留现场；
   * 已有停止流程时返回 already_in_progress，不重复关闭资源。
   */
  requestSignalShutdown(): Promise<SignalShutdownOutcome>;
}

function invalidInput(reason: string, details: Record<string, unknown>): HostProtocolError {
  return new HostProtocolError('invalid_input', OPERATION, 'Host 启动选项未通过校验', {
    details: { reason, ...details },
  });
}

function bindOverrideRejected(details: Record<string, unknown>): HostProtocolError {
  return new HostProtocolError(
    'bind_address_override_rejected',
    OPERATION,
    '拒绝监听地址覆盖：Host 只监听 127.0.0.1，不提供公网监听能力',
    { details },
  );
}

/** 启动选项形态校验（在任何 I/O 之前）；监听覆盖键与其他未知键区分错误码。 */
function validateStartOptions(options: HostStartOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidInput('invalid_options_type', {});
  }
  for (const key of Object.keys(options)) {
    if ((BIND_OVERRIDE_OPTION_KEYS as readonly string[]).includes(key)) {
      // 只记录被禁键名（受控枚举），绝不回显覆盖值。
      throw bindOverrideRejected({ reason: 'listen_override_option_rejected', field: key });
    }
    if (!(ALLOWED_OPTION_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('unknown_option_key', { field: key });
    }
  }
  if (options.workRecordingMode !== undefined && options.workRecordingMode !== 'required' && options.workRecordingMode !== 'best_effort') {
    throw invalidInput('required_or_best_effort', { field: 'workRecordingMode' });
  }
  if (options.workToolAuthority !== undefined && (options.workToolAuthority === null
    || typeof options.workToolAuthority.currentBinding !== 'function' || typeof options.workToolAuthority.candidateContext !== 'function')) {
    throw invalidInput('trusted_authority_required', { field: 'workToolAuthority' });
  }
  const catalog = options.capabilityCatalog as RuntimeCapabilityCatalog | undefined;
  if (
    catalog === null ||
    catalog === undefined ||
    typeof catalog !== 'object' ||
    typeof catalog.resolve !== 'function'
  ) {
    throw invalidInput('invalid_capability_catalog', { field: 'capabilityCatalog' });
  }
  if (options.runtimeRecoveryDescriptors !== undefined && !Array.isArray(options.runtimeRecoveryDescriptors)) {
    throw invalidInput('invalid_recovery_descriptors', { field: 'runtimeRecoveryDescriptors' });
  }
  if (options.projectResourceSources !== undefined && (options.projectResourceSources === null
    || typeof options.projectResourceSources !== 'object' || typeof options.projectResourceSources.getSource !== 'function')) {
    throw invalidInput('trusted_resource_source_required', { field: 'projectResourceSources' });
  }
  if (options.runtimeRecoverySources !== undefined && (
    options.runtimeRecoverySources === null || typeof options.runtimeRecoverySources !== 'object'
    || typeof options.runtimeRecoverySources.readCurrent !== 'function'
    || typeof options.runtimeRecoverySources.readSource !== 'function'
  )) {
    throw invalidInput('trusted_recovery_source_required', { field: 'runtimeRecoverySources' });
  }
  if (options.batchDeliveryFactory !== undefined && typeof options.batchDeliveryFactory !== 'function') {
    throw invalidInput('trusted_factory_required', { field: 'batchDeliveryFactory' });
  }
  if (options.featureDeliveryFactory !== undefined && typeof options.featureDeliveryFactory !== 'function') {
    throw invalidInput('trusted_factory_required', { field: 'featureDeliveryFactory' });
  }
  if (options.integrationPlanFactory !== undefined && typeof options.integrationPlanFactory !== 'function') {
    throw invalidInput('trusted_factory_required', { field: 'integrationPlanFactory' });
  }
  if (options.finalizationExecution !== undefined && (
    options.finalizationExecution === null || typeof options.finalizationExecution !== 'object'
    || typeof options.finalizationExecution.execute !== 'function'
  )) {
    throw invalidInput('trusted_execution_port_required', { field: 'finalizationExecution' });
  }
  if (options.finalizationCompletion !== undefined && (
    options.finalizationCompletion === null || typeof options.finalizationCompletion !== 'object'
    || typeof options.finalizationCompletion.execute !== 'function'
  )) {
    throw invalidInput('trusted_execution_port_required', { field: 'finalizationCompletion' });
  }
  if (options.dataRoot !== undefined && options.userHomeDir !== undefined) {
    throw invalidInput('root_source_ambiguous', { field: 'dataRoot' });
  }
  if (
    options.env !== undefined &&
    (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env))
  ) {
    throw invalidInput('invalid_env', { field: 'env' });
  }
  if (options.baselineStopPolicy !== undefined && options.baselineStopPolicy !== 'wait' && options.baselineStopPolicy !== 'cancel') {
    throw invalidInput('invalid_baseline_stop_policy', { field: 'baselineStopPolicy' });
  }
  if (options.activityGate !== undefined) {
    const gate = options.activityGate as HostActivityGate;
    if (
      gate === null ||
      typeof gate !== 'object' ||
      typeof gate.enterQuiesce !== 'function' ||
      typeof gate.awaitQuiesce !== 'function'
    ) {
      throw invalidInput('invalid_activity_gate', { field: 'activityGate' });
    }
  }
  if (
    options.quiesceBudgetMs !== undefined &&
    (!Number.isInteger(options.quiesceBudgetMs) ||
      options.quiesceBudgetMs < 0 ||
      options.quiesceBudgetMs > QUIESCE_BUDGET_MS)
  ) {
    throw invalidInput('invalid_quiesce_budget', { field: 'quiesceBudgetMs' });
  }
}

/** 环境变量覆盖零容忍：任一被禁变量非空即拒；details 只含变量名，不回显值。 */
function assertNoEnvironmentOverride(env: NodeJS.ProcessEnv): void {
  for (const name of BIND_OVERRIDE_ENV_KEYS) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) {
      throw bindOverrideRejected({ reason: 'listen_override_env_rejected', variable: name });
    }
  }
}

/**
 * F-007 起由 createHostLifecycleServer 提供真实生命周期传输面（握手/status
 * 认证路由，stop 待 F-008 接线）；此处只保留监听与有界拆卸工具。
 */

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: unknown): void => {
      rejectListen(error);
    };
    server.once('error', onError);
    server.listen(0, LOOPBACK_LISTEN_ADDRESS, () => {
      server.removeListener('error', onError);
      resolveListen();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    // 占位面 connection: close；兜底强制断开残余连接，保证拆卸有界。
    server.closeAllConnections();
  });
}

/**
 * 装配并启动 Host：成功返回处于 ready 状态的 RunningHost；任一失败都在
 * 关闭已打开资源并按逆序释锁后抛出，绝不发布半成品就绪发现。
 */
export async function startHost(options: HostStartOptions): Promise<RunningHost> {
  validateStartOptions(options);
  assertNoEnvironmentOverride(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new HostProtocolError('unsupported_platform', OPERATION, '首版仅正式支持 macOS', {
      details: { reason: 'platform_not_darwin' },
    });
  }

  const { canonicalRoot, dataRootIdentity } = resolveCanonicalDataRoot(
    options.dataRoot !== undefined
      ? { dataRoot: options.dataRoot, createIfMissing: true }
      : {
          defaultDataRoot: deriveDefaultDataRoot(options.userHomeDir ?? homedir()),
          createIfMissing: true,
        },
  );

  // 获锁先于 Core 打开/迁移与任何业务写入；工厂失败自动释锁（F-004 不变量）。
  const lockOptions: WriterLockOptions = { canonicalRoot };
  if (options.platform !== undefined) {
    (lockOptions as { platform?: string }).platform = options.platform;
  }
  if (options.nativeAddonPath !== undefined) {
    (lockOptions as { nativeAddonPath?: string }).nativeAddonPath = options.nativeAddonPath;
  }
  if (options.lockTimeoutMs !== undefined) {
    (lockOptions as { timeoutMs?: number }).timeoutMs = options.lockTimeoutMs;
  }
  if (options.ownerProbe !== undefined) {
    (lockOptions as { ownerProbe?: WriterLockOptions['ownerProbe'] }).ownerProbe =
      options.ownerProbe;
  }
  const recoveryDescriptors = options.runtimeRecoveryDescriptors ?? (
    options.capabilityCatalog.resolve('pi') === undefined ? [] : [PI_RUNTIME_RECOVERY_DESCRIPTOR]
  );
  const locked = await openLockedWriter<CoreApplication>(lockOptions, () =>
    openCoreApplication({
      dataRoot: canonicalRoot,
      workStartupRecoveryRequired: true,
      capabilityCatalog: options.capabilityCatalog,
      runtimeRecoveryDescriptors: recoveryDescriptors,
      ...(options.runtimeRecoverySources === undefined ? {}
        : { runtimeRecoverySources: options.runtimeRecoverySources }),
      ...(options.projectResourceSources === undefined ? {} : { projectResourceSources: options.projectResourceSources }),
      workRuntimeFactory: options.workRuntimeFactory,
      workRecordingMode: options.workRecordingMode,
      batchDeliveryFactory: options.batchDeliveryFactory,
      featureDeliveryFactory: options.featureDeliveryFactory,
      integrationPlanFactory: options.integrationPlanFactory,
      ...(options.finalizationExecution === undefined
        ? {}
        : { finalizationExecution: options.finalizationExecution }),
      ...(options.finalizationCompletion === undefined
        ? {}
        : { finalizationCompletion: options.finalizationCompletion }),
    }),
  );

  let server: Server | undefined;
  let lifecycle: LifecycleState = 'starting';
  let stopTeardownCompleted = false;
  const authority = options.workToolAuthority;
  const hostInstanceId = randomUUID();
  const workTools = createHostWorkToolAccess(authority === undefined ? undefined : locked.writer.createWorkToolChannel({
    currentBinding(context) {
      const current = authority.currentBinding(context);
      return current?.hostInstanceId === hostInstanceId ? current : null;
    },
    candidateContext: context => authority.candidateContext(context),
  }));
  try {
    // Writer lock is already held. No listener/discovery or new execution is exposed
    // until durable old identities have been reconciled. Unconfirmed resources remain occupied.
    const work = locked.writer.workExecution;
    work.enterRecovery();
    await locked.writer.baselineExecutionService.recover();
    await work.recover();
    const baseline = locked.writer.baselineExecutionService;
    const activityGate: HostActivityGate = {
      enterQuiesce() {
        const local = baseline.enterQuiesce(options.baselineStopPolicy ?? 'wait');
        const runtime = work.enterQuiesce();
        const delivery = locked.writer.commandService.deliveryActivity?.enterQuiesce();
        const additional = options.activityGate?.enterQuiesce();
        return { accepted: local.accepted + runtime.accepted + (delivery?.accepted ?? 0) + (additional?.accepted ?? 0) };
      },
      async awaitQuiesce(budgetMs) {
        const [local, runtime, delivery, additional] = await Promise.all([
          baseline.awaitQuiesce(budgetMs),
          work.awaitQuiesce(budgetMs),
          locked.writer.commandService.deliveryActivity?.awaitQuiesce(budgetMs),
          options.activityGate?.awaitQuiesce(budgetMs),
        ]);
        return { confirmed: local.confirmed && runtime.confirmed && (delivery?.confirmed ?? true) && (additional?.confirmed ?? true),
          pending: [...local.pending, ...runtime.pending, ...(delivery?.pending ?? []), ...(additional?.pending ?? [])] };
      },
    };
    const store = createHostFileStore({ canonicalRoot });
    const startedAt = new Date().toISOString();
    // 凭据先于监听与发现发布：传输面从第一个请求起即可做 timingSafeEqual
    // 比较；仅存 0600 凭据不构成可连接面（§5.2），失败由下次启动原子替换。
    const authToken = store.issueAuthToken();
    // F-008 停止控制器（§10.4/§10.5/§10.7）：收尾端口在此闭包装配，
    // prepareTeardown 只能在 stop/信号路径触发（close() 不走 §10.5 清理）。
    const stopController = createHostStopController({
      activityGate,
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
        workTools.close();
      },
      prepareTeardown: () => {
        // §10.5 第 3–5 步：stopping → 关 listener（在途 stop 响应仍可送达，
        // 连接随 connection: close 自行收尾）→ 关 Core（幂等）→ 持锁按实例
        // 清理发现/凭据。本步骤不释放 OS 锁。
        // F-012：在途 SSE 流先由 Hub 在预算内结束（新订阅已 503）；定时器与
        // 登记随连接清理，不回滚/取消任何已提交命令。
        lifecycle = 'stopping';
        workTools.close();
        const activeServer = server;
        return Promise.resolve()
          .then(() => eventStreams.closeAll())
          .then(() => {
            if (activeServer !== undefined && activeServer.listening) {
              activeServer.close();
            }
          })
          .then(() => locked.writer.close())
          .then(() => {
            const cleanup = store.cleanupInstanceFiles(hostInstanceId);
            // 发现已缺席（外部已移除）等价于清理目标达成；其他跳过/失败形态
            // 一律按未确认处理（保锁、不伪装成功，§10.5）。
            if (cleanup.outcome !== 'cleaned' && cleanup.outcome !== 'skipped_discovery_absent') {
              throw new HostProtocolError(
                'internal',
                'host.stop',
                '按实例清理未确认，保留锁与现场（已脱敏）',
                { details: { reason: 'stop_cleanup_unconfirmed', outcome: cleanup.outcome } },
              );
            }
          });
      },
      releaseAfterTeardown: async () => {
        // §10.5 第 6 步（最终响应送达之后）：释放 OS 锁；writer 已关闭
        // （Core close 幂等），locked.close 只走释锁路径且并发安全。
        await locked.close();
        stopTeardownCompleted = true;
      },
      ...(options.quiesceBudgetMs !== undefined ? { quiesceBudgetMs: options.quiesceBudgetMs } : {}),
    });
    // F-012 SSE 事件订阅 Hub（§9.4/§13）：生产装配固定 local-owner 主体与
    // 契约预算（全保留库下界恒 0，无注入缝）；closeAll 接入 §10.5 收尾与
    // 装配级拆卸，在途流在预算内结束，重启后原持久游标可续读。
    const eventStreams = createEventStreamHub({
      queryService: locked.writer.queryService,
      principal: createLocalOwnerPrincipal(),
      getLifecycleState: () => lifecycle,
    });
    server = createHostLifecycleServer({
      hostInstanceId,
      dataRootIdentity,
      startedAt,
      pid: process.pid,
      authToken,
      featureDeliveryAvailable: options.featureDeliveryFactory !== undefined,
      getLifecycleState: () => lifecycle,
      getActivities: () => stopController.getActivities(),
      stop: stopController,
      // P02-2 / F-011（§3.2/§11.1）：应用命令/查询/回执/快照路由接线。生产
      // 通用应用面固定 local-owner；Work 面使用独立凭据与可信绑定主体。
      // Host 不直接写库，全部业务授权由 Core 再核验。
      application: {
        workTools,
        principal: createLocalOwnerPrincipal(),
        commandService: locked.writer.commandService,
        queryService: locked.writer.queryService,
        commandReceiptsService: locked.writer.commandReceiptsService,
        projectResourceService: locked.writer.projectResourceService,
        repositoryMoveService: locked.writer.repositoryMoveService,
        // P02-3 / F-006（§7.2/§7.3）：静态接入用例只经 Core 窄端口接线。
        onboardingService: locked.writer.onboardingService,
        projectProfileService: locked.writer.projectProfileService,
        // P02-3 / F-014（§3.2/§7.4-§7.6）：基线查询与 baseline.run 执行编排接线
        //（与握手能力清单一致，不宣告未接线接口）。
        baselineQueryService: locked.writer.baselineQueryService,
        baselineComparisonService: locked.writer.baselineComparisonService,
        knowledgeQueryService: locked.writer.knowledgeQueryService,
        memoryQueryService: locked.writer.memoryQueryService,
        baselineExecutionService: locked.writer.baselineExecutionService,
        // P05-1 / F-012：规划上下文/候选只读查询接线（与握手能力清单一致；
        // 授权/可见性/候选正文完整性全部在 Core 复核）。
        planningQueryService: locked.writer.planningQueryService,
        getLifecycleState: () => lifecycle,
        eventStreams,
      },
    });
    await listenOnLoopback(server);
    const address = server.address();
    if (
      address === null ||
      typeof address !== 'object' ||
      address.address !== LOOPBACK_LISTEN_ADDRESS ||
      !Number.isInteger(address.port) ||
      address.port < 1 ||
      address.port > 65_535
    ) {
      throw new HostProtocolError('internal', OPERATION, '回环监听地址核验失败', {
        details: { reason: 'address_verification_failed' },
      });
    }

    // 发现发布是“就绪提交点”（§5.2）：套接字绑定并核验后才原子发布；
    // 发布失败关闭监听/Core 并释锁，不发布 ready。
    store.publishDiscovery({
      schemaVersion: 1,
      protocolVersion: 1,
      hostInstanceId,
      dataRootIdentity,
      listenAddress: LOOPBACK_LISTEN_ADDRESS,
      port: address.port,
      pid: process.pid,
      startedAt,
    });
    lifecycle = 'ready';
    work.start();

    const listeningServer = server;
    const port = address.port;
    let closed = false;
    let inFlight: Promise<void> | undefined;
    const host: RunningHost = {
      workTools,
      hostInstanceId,
      canonicalRoot,
      dataRootIdentity,
      listenAddress: LOOPBACK_LISTEN_ADDRESS,
      port,
      pid: process.pid,
      startedAt,
      get lifecycleState() {
        return lifecycle;
      },
      core: locked.writer,
      close(): Promise<void> {
        if (closed) {
          return inFlight ?? Promise.resolve();
        }
        inFlight ??= (async () => {
          // 与在途停止尝试协调：HTTP stop/信号收尾已在拆时不再重复拆卸；
          // 被拒（未确认）的尝试结束后仍需重新核对活动，不能借 close 释锁。
          await stopController.whenSettled();
          if (!stopTeardownCompleted) {
            // Assembly-level close is not an escape hatch around an unconfirmed stop.
            activityGate.enterQuiesce();
            lifecycle = 'quiescing';
            workTools.close();
            const result = await activityGate.awaitQuiesce(options.quiesceBudgetMs ?? QUIESCE_BUDGET_MS);
            if (!result.confirmed) throw new HostProtocolError('resource_busy', 'host.stop', '基线停止尚未确认', {
              details: { reasonCode: 'quiesce_not_confirmed' },
            });
            lifecycle = 'stopping';
            await eventStreams.closeAll();
            await closeServer(listeningServer);
            await locked.close();
          }
          closed = true;
        })().catch(error => { inFlight = undefined; throw error; });
        return inFlight;
      },
      requestSignalShutdown: () => stopController.requestSignalShutdown(),
    };
    return host;
  } catch (error) {
    workTools.close();
    // 失败拆卸：监听（若已建立）→ Core → 释锁；不发布 ready。
    if (server !== undefined) {
      await closeServer(server).catch(() => {
        // 拆卸失败以原始启动错误为准（锁仍由 locked.close 释放/保留规则处理）。
      });
    }
    await locked.writer.workExecution.close();
    await locked.close();
    throw error;
  }
}
