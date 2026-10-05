/**
 * F-009 HostClient（契约 §12）：CLI 可复用的 Host 客户端。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §12：
 * - §12.1：读取并核验受保护发现与凭据（复用 F-003 存储的 fail-closed 核验），
 *   本地计算 dataRootIdentity；只连接发现指向的 127.0.0.1 固定端口；
 * - §12.2：先发握手，响应必须同时通过 HTTP 200、协议版本支持集、
 *   hostInstanceId === 发现实例、dataRootIdentity === 本地计算值与能力冻结形态；
 *   握手通过前不发 status/stop；握手失败不自动另起写入者、不绕过锁；
 * - §12.3：close()/超时/连接断开只释放本地观察资源，绝不调用 stop；
 *   输出不含凭据；
 * - §14：错误精确分类（unauthorized/protocol_incompatible/instance_mismatch/
 *   data_root_mismatch/unreachable/host_not_found/redirect_rejected/
 *   response_malformed/…），互不折算。
 *
 * 本模块不读取 argv/环境变量，不启动进程，不打开 SQLite；发现与凭据只经
 * F-003 受保护存储读取。
 */
import { randomUUID } from 'node:crypto';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HANDSHAKE_TIMEOUT_MS,
  STATUS_ROUTE,
  STATUS_TIMEOUT_MS,
  STOP_ROUTE,
  STOP_TIMEOUT_MS,
  TCP_CONNECT_TIMEOUT_MS,
  HostProtocolError,
  computeStopRequestDigest,
  isPlainObject,
  isSha256Hex,
  isUuidV4,
  validateDiscoveryRecord,
  validateHandshakeResponse,
  validateStatusResponse,
  validateStopResultView,
  type HandshakeResponse,
  type HostDiscoveryRecord,
  type HostOperation,
  type HostStatusResponse,
  type StopResultView,
} from '../contract/index.js';
import { createHostFileStore } from '../storage/index.js';
import { mapErrorResponse, requestLoopbackJson } from './http-json.js';

/** §7.2 客户端有限预算（毫秒，全部有界；覆盖仅允许区间内的更小/更大有限值）。 */
export interface HostClientTimeouts {
  /** TCP 连接预算（默认 2 000；允许 50..10 000）。 */
  readonly connectMs?: number;
  /** 握手整体预算（默认 10 000；允许 100..60 000）。 */
  readonly handshakeMs?: number;
  /** status 整体预算（默认 10 000；允许 100..60 000）。 */
  readonly statusMs?: number;
  /** stop 整体预算（默认 15 000 = 10s quiesce + 5s 余量；允许 100..60 000）。 */
  readonly stopMs?: number;
}

export interface ConnectHostClientOptions {
  /** 已 realpath 固定的规范根（resolveCanonicalDataRoot 的输出）。 */
  readonly canonicalRoot: string;
  /** 平台注入口（默认 process.platform）；仅 'darwin' 受支持。 */
  readonly platform?: string;
  /** 有限预算覆盖（受信装配/测试注入；绝非 argv/env/发现字段）。 */
  readonly timeouts?: HostClientTimeouts;
}

export interface HostClientStopOptions {
  /** §10.4 幂等操作身份；必须是 UUID v4，省略时客户端生成。 */
  readonly commandId?: string;
}

/**
 * 已完成双向核验的 Host 会话。status/stop 仅在本会话身份（握手核验过的
 * hostInstanceId 与 dataRootIdentity）下发送；close() 只释放本地观察资源。
 */
export interface HostClient {
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly listenAddress: '127.0.0.1';
  readonly port: number;
  /** 握手成功响应（已通过 validateHandshakeResponse 双向核验）。 */
  readonly handshake: HandshakeResponse;
  /** §9 只读状态查询（响应经版本/实例/数据根核验）。 */
  status(): Promise<HostStatusResponse>;
  /** §10 版本化显式停止；返回的 completed/stopping 不等于进程已退出（§10.6）。 */
  stop(options?: HostClientStopOptions): Promise<StopResultView>;
  /** 幂等；只释放本地观察资源，绝不调用 stop、不影响 Host 存活。 */
  close(): void;
}

interface ResolvedTimeouts {
  readonly connectMs: number;
  readonly handshakeMs: number;
  readonly statusMs: number;
  readonly stopMs: number;
}

const OPTION_KEYS = ['canonicalRoot', 'platform', 'timeouts'] as const;
const TIMEOUT_KEYS = ['connectMs', 'handshakeMs', 'statusMs', 'stopMs'] as const;

function invalidInput(operation: HostOperation, reason: string, field?: string): HostProtocolError {
  return new HostProtocolError('invalid_input', operation, 'HostClient 输入未通过校验', {
    details: field === undefined ? { reason } : { reason, field },
  });
}

function requireTimeout(
  timeouts: HostClientTimeouts,
  key: (typeof TIMEOUT_KEYS)[number],
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = timeouts[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidInput('host.handshake', 'invalid_timeout', `timeouts.${key}`);
  }
  return value;
}

/** 纯输入校验（零 I/O）：精确键、超时整数区间。 */
function resolveOptions(options: ConnectHostClientOptions): { canonicalRoot: string; platform?: string; timeouts: ResolvedTimeouts } {
  if (!isPlainObject(options)) {
    throw invalidInput('host.handshake', 'invalid_options');
  }
  for (const key of Object.keys(options)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('host.handshake', 'unknown_option_key', key);
    }
  }
  if (typeof options.canonicalRoot !== 'string' || options.canonicalRoot.length === 0) {
    throw invalidInput('host.handshake', 'invalid_root_type', 'canonicalRoot');
  }
  if (options.platform !== undefined && typeof options.platform !== 'string') {
    throw invalidInput('host.handshake', 'invalid_platform_type', 'platform');
  }
  const rawTimeouts = options.timeouts;
  if (rawTimeouts !== undefined && !isPlainObject(rawTimeouts)) {
    throw invalidInput('host.handshake', 'invalid_timeouts', 'timeouts');
  }
  const timeoutsInput = (rawTimeouts ?? {}) as HostClientTimeouts;
  for (const key of Object.keys(timeoutsInput)) {
    if (!(TIMEOUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('host.handshake', 'unknown_timeout_key', `timeouts.${key}`);
    }
  }
  const timeouts: ResolvedTimeouts = {
    connectMs: requireTimeout(timeoutsInput, 'connectMs', TCP_CONNECT_TIMEOUT_MS, 50, 10_000),
    handshakeMs: requireTimeout(timeoutsInput, 'handshakeMs', HANDSHAKE_TIMEOUT_MS, 100, 60_000),
    statusMs: requireTimeout(timeoutsInput, 'statusMs', STATUS_TIMEOUT_MS, 100, 60_000),
    stopMs: requireTimeout(timeoutsInput, 'stopMs', STOP_TIMEOUT_MS, 100, 60_000),
  };
  return {
    canonicalRoot: options.canonicalRoot,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    timeouts,
  };
}

/** 200 → 契约校验；非 200 → §14 错误映射（脱敏）。 */
function complete<T>(operation: HostOperation, statusCode: number, json: unknown, validate: () => T): T {
  if (statusCode !== 200) {
    throw mapErrorResponse(statusCode, json, operation);
  }
  return validate();
}

interface ProbeTarget {
  readonly discovery: HostDiscoveryRecord;
  readonly token: string;
  readonly connectMs: number;
  readonly handshakeMs: number;
  readonly signal?: AbortSignal;
}

/** §12.2 握手：认证 + 协议/实例/数据根双向核验（含能力冻结形态）。 */
async function performHandshake(target: ProbeTarget): Promise<HandshakeResponse> {
  const { discovery, token } = target;
  const response = await requestLoopbackJson({
    port: discovery.port,
    method: 'POST',
    path: HANDSHAKE_ROUTE,
    operation: 'host.handshake',
    token,
    body: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      hostInstanceId: discovery.hostInstanceId,
      dataRootIdentity: discovery.dataRootIdentity,
    },
    connectTimeoutMs: target.connectMs,
    overallTimeoutMs: target.handshakeMs,
    ...(target.signal !== undefined ? { signal: target.signal } : {}),
  });
  return complete('host.handshake', response.statusCode, response.json, () =>
    validateHandshakeResponse(response.json, {
      expectedHostInstanceId: discovery.hostInstanceId,
      expectedDataRootIdentity: discovery.dataRootIdentity,
    }),
  );
}

export interface ProbeDiscoveredHostOptions {
  /** 发现记录（跨信任边界，重新按 §5.1 校验）。 */
  readonly discovery: HostDiscoveryRecord;
  /** 受保护凭据（64 位小写 hex）。 */
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly timeouts?: Pick<HostClientTimeouts, 'connectMs' | 'handshakeMs'>;
}

/**
 * 只做一次握手核验的窄探测（F-010 启动器 owner 诊断 / F-004 ownerProbe 的
 * 真实实现端口）：成功返回已核验握手响应，否则拒绝（unauthorized /
 * unreachable / response_malformed / …），绝不发送 status/stop。
 */
export async function probeDiscoveredHost(options: ProbeDiscoveredHostOptions): Promise<HandshakeResponse> {
  if (!isPlainObject(options)) {
    throw invalidInput('host.handshake', 'invalid_options');
  }
  // 发现与凭据都按不可信输入重校验（不继承调用方的信任）。
  const discovery = validateDiscoveryRecord(options.discovery);
  if (!isSha256Hex(options.token)) {
    throw invalidInput('host.handshake', 'invalid_token_format', 'token');
  }
  const timeouts = resolveTimeoutsProbe(options.timeouts);
  return performHandshake({
    discovery,
    token: options.token,
    connectMs: timeouts.connectMs,
    handshakeMs: timeouts.handshakeMs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function resolveTimeoutsProbe(input: ProbeDiscoveredHostOptions['timeouts']): { connectMs: number; handshakeMs: number } {
  if (input === undefined) {
    return { connectMs: TCP_CONNECT_TIMEOUT_MS, handshakeMs: HANDSHAKE_TIMEOUT_MS };
  }
  if (!isPlainObject(input)) {
    throw invalidInput('host.handshake', 'invalid_timeouts', 'timeouts');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'connectMs' && key !== 'handshakeMs') {
      throw invalidInput('host.handshake', 'unknown_timeout_key', `timeouts.${key}`);
    }
  }
  return {
    connectMs: requireTimeout(input, 'connectMs', TCP_CONNECT_TIMEOUT_MS, 50, 10_000),
    handshakeMs: requireTimeout(input, 'handshakeMs', HANDSHAKE_TIMEOUT_MS, 100, 60_000),
  };
}

/**
 * §12.1/§12.2：读取受保护发现与凭据 → 握手双向核验 → 返回已核验会话。
 * 失败按 §14 精确分类（host_not_found/unsafe_discovery/invalid_discovery/
 * unreachable/unauthorized/protocol_incompatible/instance_mismatch/
 * data_root_mismatch/redirect_rejected/response_malformed），互不折算，
 * 且绝不另起写入者、不绕过锁、不删文件。
 */
export async function connectToHost(options: ConnectHostClientOptions): Promise<HostClient> {
  const resolved = resolveOptions(options);
  const store = createHostFileStore({
    canonicalRoot: resolved.canonicalRoot,
    ...(resolved.platform !== undefined ? { platform: resolved.platform } : {}),
  });
  const discovery = store.readTrustedDiscovery();
  const token = store.readTrustedAuthToken();
  const handshake = await performHandshake({
    discovery,
    token,
    connectMs: resolved.timeouts.connectMs,
    handshakeMs: resolved.timeouts.handshakeMs,
  });

  const expectation = {
    expectedHostInstanceId: handshake.hostInstanceId,
    expectedDataRootIdentity: handshake.dataRootIdentity,
  };
  let closed = false;
  const assertOpen = (operation: HostOperation): void => {
    if (closed) {
      throw new HostProtocolError('invalid_input', operation, '客户端已关闭（仅释放本地观察资源）', {
        details: { reason: 'client_closed' },
      });
    }
  };

  return {
    hostInstanceId: handshake.hostInstanceId,
    dataRootIdentity: handshake.dataRootIdentity,
    listenAddress: '127.0.0.1',
    port: discovery.port,
    handshake,

    async status(): Promise<HostStatusResponse> {
      assertOpen('host.status');
      const response = await requestLoopbackJson({
        port: discovery.port,
        method: 'GET',
        path: STATUS_ROUTE,
        operation: 'host.status',
        token,
        connectTimeoutMs: resolved.timeouts.connectMs,
        overallTimeoutMs: resolved.timeouts.statusMs,
      });
      return complete('host.status', response.statusCode, response.json, () =>
        validateStatusResponse(response.json, expectation),
      );
    },

    async stop(stopOptions: HostClientStopOptions = {}): Promise<StopResultView> {
      assertOpen('host.stop');
      if (!isPlainObject(stopOptions)) {
        throw invalidInput('host.stop', 'invalid_options');
      }
      for (const key of Object.keys(stopOptions)) {
        if (key !== 'commandId') {
          throw invalidInput('host.stop', 'unknown_option_key', key);
        }
      }
      const commandId = stopOptions.commandId ?? randomUUID();
      if (!isUuidV4(commandId)) {
        throw invalidInput('host.stop', 'invalid_uuid_v4', 'commandId');
      }
      const requestDigest = computeStopRequestDigest(commandId, handshake.hostInstanceId, {
        mode: 'graceful',
      });
      const response = await requestLoopbackJson({
        port: discovery.port,
        method: 'POST',
        path: STOP_ROUTE,
        operation: 'host.stop',
        token,
        body: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          commandId,
          hostInstanceId: handshake.hostInstanceId,
          requestDigest,
        },
        connectTimeoutMs: resolved.timeouts.connectMs,
        overallTimeoutMs: resolved.timeouts.stopMs,
      });
      return complete('host.stop', response.statusCode, response.json, () =>
        validateStopResultView(response.json, { expectedCommandId: commandId }),
      );
    },

    close(): void {
      closed = true;
    },
  };
}
