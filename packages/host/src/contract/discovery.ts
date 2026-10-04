/**
 * F-002 发现文件契约（discovery.json）：类型与运行时校验（纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §5（发现文件契约）、
 * §3.2（dataRootIdentity）、§7.1（版本）。
 *
 * 发现文件是本地受保护文件（0600），从不经 HTTP 传输；因此其结构问题使用
 * 仅客户端码 invalid_discovery（CLI 映射到退出码 2），未知版本以 details.reason
 * 精确区分，不猜测降级。文件权限/属主/符号链接核验属于 F-003（存储层），
 * 本模块只负责内容结构。
 */
import {
  CURRENT_PROTOCOL_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  LOOPBACK_LISTEN_ADDRESS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js';
import { HostProtocolError } from './errors.js';
import { isIsoUtcDateTime, isSha256Hex, isUuidV4 } from './identifiers.js';
import {
  requireExactKeys,
  requireFieldPresent,
  requireInteger,
  requireObject,
  requireString,
  type ValidationSurface,
} from './validation.js';

/** PID 上限 2^31-1（§5.1；仅诊断字段）。 */
export const MAX_PID = 2 ** 31 - 1;

const DISCOVERY_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'hostInstanceId',
  'dataRootIdentity',
  'listenAddress',
  'port',
  'pid',
  'startedAt',
] as const;

/** §5.1 schemaVersion 1 的唯一允许形态。 */
export interface HostDiscoveryRecord {
  readonly schemaVersion: typeof DISCOVERY_SCHEMA_VERSION;
  readonly protocolVersion: typeof CURRENT_PROTOCOL_VERSION;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly listenAddress: typeof LOOPBACK_LISTEN_ADDRESS;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
}

const DISCOVERY_SURFACE: ValidationSurface = {
  operation: 'host.discovery',
  malformedCode: 'invalid_discovery',
  subject: 'discovery',
};

/**
 * 严格校验发现对象：未知字段、缺字段、类型/格式错误、未知版本、非回环地址、
 * 非法端口/PID/时间一律拒绝。返回冻结字段的只读记录。
 */
export function validateDiscoveryRecord(input: unknown): HostDiscoveryRecord {
  const surface = DISCOVERY_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, DISCOVERY_FIELDS);

  const schemaVersion = requireInteger(surface, 'schemaVersion', requireFieldPresent(surface, value, 'schemaVersion'), {
    min: 1,
    max: 2 ** 31 - 1,
  });
  if (schemaVersion !== DISCOVERY_SCHEMA_VERSION) {
    throw new HostProtocolError('invalid_discovery', surface.operation, '不支持的发现 schema 版本', {
      details: {
        field: 'discovery.schemaVersion',
        reason: 'unsupported_schema_version',
        supportedSchemaVersions: [DISCOVERY_SCHEMA_VERSION],
      },
    });
  }

  const protocolVersion = requireInteger(
    surface,
    'protocolVersion',
    requireFieldPresent(surface, value, 'protocolVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(protocolVersion)) {
    throw new HostProtocolError('invalid_discovery', surface.operation, '不支持的发现协议版本', {
      details: {
        field: 'discovery.protocolVersion',
        reason: 'unsupported_protocol_version',
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    });
  }

  const hostInstanceId = requireString(
    surface,
    'hostInstanceId',
    requireFieldPresent(surface, value, 'hostInstanceId'),
  );
  if (!isUuidV4(hostInstanceId)) {
    throw new HostProtocolError('invalid_discovery', surface.operation, 'hostInstanceId 必须是规范 UUID v4', {
      details: { field: 'discovery.hostInstanceId', reason: 'invalid_uuid_v4' },
    });
  }

  const dataRootIdentity = requireString(
    surface,
    'dataRootIdentity',
    requireFieldPresent(surface, value, 'dataRootIdentity'),
  );
  if (!isSha256Hex(dataRootIdentity)) {
    throw new HostProtocolError('invalid_discovery', surface.operation, 'dataRootIdentity 必须是 64 位小写十六进制 SHA-256', {
      details: { field: 'discovery.dataRootIdentity', reason: 'invalid_sha256_hex' },
    });
  }

  const listenAddress = requireString(
    surface,
    'listenAddress',
    requireFieldPresent(surface, value, 'listenAddress'),
  );
  if (listenAddress !== LOOPBACK_LISTEN_ADDRESS) {
    throw new HostProtocolError('invalid_discovery', surface.operation, 'listenAddress 必须恰为 127.0.0.1', {
      details: { field: 'discovery.listenAddress', reason: 'listen_address_must_be_loopback' },
    });
  }

  const port = requireInteger(surface, 'port', requireFieldPresent(surface, value, 'port'), {
    min: 1,
    max: 65_535,
  });
  const pid = requireInteger(surface, 'pid', requireFieldPresent(surface, value, 'pid'), {
    min: 1,
    max: MAX_PID,
  });

  const startedAt = requireString(surface, 'startedAt', requireFieldPresent(surface, value, 'startedAt'));
  if (!isIsoUtcDateTime(startedAt)) {
    throw new HostProtocolError('invalid_discovery', surface.operation, 'startedAt 必须是以 Z 结尾的 ISO 8601 UTC 时间', {
      details: { field: 'discovery.startedAt', reason: 'invalid_iso_utc_datetime' },
    });
  }

  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId,
    dataRootIdentity,
    listenAddress: LOOPBACK_LISTEN_ADDRESS,
    port,
    pid,
    startedAt,
  };
}

/**
 * 解析发现文件文本：畸形 JSON → invalid_discovery（malformed_json，不回显原文）；
 * 合法 JSON 再走严格结构校验。
 */
export function parseDiscoveryText(text: unknown): HostDiscoveryRecord {
  if (typeof text !== 'string') {
    throw new HostProtocolError('invalid_discovery', 'host.discovery', '发现文件内容必须是 UTF-8 JSON 文本', {
      details: { reason: 'invalid_discovery_type' },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HostProtocolError('invalid_discovery', 'host.discovery', '发现文件不是合法 JSON', {
      details: { reason: 'malformed_json' },
    });
  }
  return validateDiscoveryRecord(parsed);
}

/**
 * 本地根身份核验（§5.2 读取信任条件之一）：发现记录的 dataRootIdentity 必须等于
 * 客户端对本地规范根的计算值，否则该发现不属于此根，拒绝连接。
 */
export function assertDiscoveryForLocalRoot(
  record: HostDiscoveryRecord,
  expectedDataRootIdentity: string,
): void {
  if (!isSha256Hex(expectedDataRootIdentity)) {
    throw new HostProtocolError('invalid_discovery', 'host.discovery', '本地数据根身份计算结果非法', {
      details: { field: 'local.dataRootIdentity', reason: 'invalid_sha256_hex' },
    });
  }
  if (record.dataRootIdentity !== expectedDataRootIdentity) {
    throw new HostProtocolError('invalid_discovery', 'host.discovery', '发现文件的数据根身份与本地规范根不一致', {
      details: { field: 'discovery.dataRootIdentity', reason: 'data_root_mismatch' },
    });
  }
}
