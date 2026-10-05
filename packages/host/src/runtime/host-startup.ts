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
 * http-transport.ts）：握手/status 认证路由按 §7.2/§8/§9 生效；stop 路由在
 * F-008 接线前经完整传输与认证校验后返回 501 unsupported。SIGTERM 安全收尾
 * 与按实例清理属 F-008；本模块 close() 是装配级拆卸（关监听 → 关 Core →
 * 释锁），不删除发现/凭据（§10.5 第 5 步归 F-008）。
 *
 * import 本模块无副作用：不监听端口、不读文件系统、不加载原生模块、不读
 * process.env（只有 startHost 显式调用才读取注入的 env 或 process.env）。
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { deriveDefaultDataRoot } from 'shiploop-core';
import type { RuntimeCapabilityCatalog } from 'shiploop-core';
import { openCoreApplication } from 'shiploop-core/assembly';
import type { CoreApplication } from 'shiploop-core/assembly';
import {
  HostProtocolError,
  LOOPBACK_LISTEN_ADDRESS,
} from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import { createHostFileStore, resolveCanonicalDataRoot } from '../storage/index.js';
import { openLockedWriter } from '../locking/index.js';
import type { WriterLockOptions } from '../locking/index.js';
import { createHostLifecycleServer } from './http-transport.js';

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
const BIND_OVERRIDE_ENV_KEYS = [
  'SHIPLOOP_HOST_BIND',
  'SHIPLOOP_HOST_HOST',
  'SHIPLOOP_HOST_PORT',
  'SHIPLOOP_HOST_ADDRESS',
  'SHIPLOOP_HOST_LISTEN',
  'SHIPLOOP_HOST_LISTEN_ADDRESS',
] as const;

const ALLOWED_OPTION_KEYS = [
  'dataRoot',
  'userHomeDir',
  'capabilityCatalog',
  'platform',
  'env',
  'nativeAddonPath',
  'lockTimeoutMs',
  'ownerProbe',
] as const;

export interface HostStartOptions {
  /** 显式数据根（POSIX 绝对路径）；与 userHomeDir 二选一。 */
  readonly dataRoot?: string;
  /** 注入的用户目录（推导 P01 默认根）；与 dataRoot 二选一，缺省取 os.homedir()。 */
  readonly userHomeDir?: string;
  /** 可信装配注入的只读能力目录（空目录 = 不装配任何 runtime，fail-closed）。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
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
}

export interface RunningHost {
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
   * 装配级拆卸：关闭监听 → 关闭 Core → 释放 OS 锁；幂等，并发合并。
   * 不是 §10 的停止流程（quiesce/按实例清理/回执归 F-008）；不删除发现/凭据。
   */
  close(): Promise<void>;
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
  const catalog = options.capabilityCatalog as RuntimeCapabilityCatalog | undefined;
  if (
    catalog === null ||
    catalog === undefined ||
    typeof catalog !== 'object' ||
    typeof catalog.resolve !== 'function'
  ) {
    throw invalidInput('invalid_capability_catalog', { field: 'capabilityCatalog' });
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
  const locked = await openLockedWriter<CoreApplication>(lockOptions, () =>
    openCoreApplication({
      dataRoot: canonicalRoot,
      capabilityCatalog: options.capabilityCatalog,
    }),
  );

  let server: Server | undefined;
  let lifecycle: LifecycleState = 'starting';
  try {
    const store = createHostFileStore({ canonicalRoot });
    const hostInstanceId = randomUUID();
    const startedAt = new Date().toISOString();
    // 凭据先于监听与发现发布：传输面从第一个请求起即可做 timingSafeEqual
    // 比较；仅存 0600 凭据不构成可连接面（§5.2），失败由下次启动原子替换。
    const authToken = store.issueAuthToken();
    server = createHostLifecycleServer({
      hostInstanceId,
      dataRootIdentity,
      startedAt,
      pid: process.pid,
      authToken,
      getLifecycleState: () => lifecycle,
      // P02-1 生产装配恒空闲（无 Scheduler/Runner）；stop 视图在 F-008 接线前恒 null。
      getActivities: () => ({ accepted: 0, quiescing: 0 }),
      getStopView: () => null,
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

    const listeningServer = server;
    const port = address.port;
    let closed = false;
    let inFlight: Promise<void> | undefined;
    const host: RunningHost = {
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
          lifecycle = 'stopping';
          await closeServer(listeningServer);
          await locked.close();
          closed = true;
        })();
        return inFlight;
      },
    };
    return host;
  } catch (error) {
    // 失败拆卸：监听（若已建立）→ Core → 释锁；不发布 ready。
    if (server !== undefined) {
      await closeServer(server).catch(() => {
        // 拆卸失败以原始启动错误为准（锁仍由 locked.close 释放/保留规则处理）。
      });
    }
    await locked.close();
    throw error;
  }
}
