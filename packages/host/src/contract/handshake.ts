/**
 * F-002 握手契约（POST /v1/host/handshake）：请求/响应类型与运行时校验（纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §8（握手）、§7.1（版本）。
 *
 * 服务端校验顺序由 F-007 传输层编排（传输层 → 凭据 → 版本 → 实例 → 数据根），
 * 因此本模块把「结构/格式」与「版本兼容」拆成两个函数，避免结构校验越过认证
 * 先暴露版本存在性；结构问题一律 invalid_input(400)。
 *
 * 客户端侧响应校验对假服务零容忍：身份/根必须与预期一致，能力声明必须等于
 * 冻结能力集（P02-2 §11.3 结构化视图），任何伪造或畸形都拒绝（不发送后续业务请求）。
 */
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  EVENTS_ROUTE,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js';
import { HostProtocolError } from './errors.js';
import { isIsoUtcDateTime, isSha256Hex, isUuidV4 } from './identifiers.js';
import {
  CURRENT_HOST_CAPABILITIES,
  FEATURE_DELIVERY_COMMAND_CAPABILITIES,
  BATCH_DELIVERY_COMMAND_CAPABILITIES,
  KNOWLEDGE_QUERY_CAPABILITIES,
  hostCapabilitiesForDelivery,
  LIFECYCLE_ROUTE_NAMES,
  isLifecycleState,
  type HostCapabilities,
  type LifecycleState,
} from './lifecycle.js';
import {
  isPlainObject,
  requireExactKeys,
  requireFieldPresent,
  requireInteger,
  requireObject,
  requireString,
  type ValidationSurface,
} from './validation.js';

const HANDSHAKE_REQUEST_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'hostInstanceId',
  'dataRootIdentity',
] as const;

/** §8 握手请求体（严格 4 字段）。 */
export interface HandshakeRequest {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
}

const REQUEST_SURFACE: ValidationSurface = {
  operation: 'host.handshake',
  malformedCode: 'invalid_input',
  subject: 'request',
};

/**
 * 结构/格式校验（§8 顺序第 2 步）：精确键、整数版本、UUID、64 hex。
 * 不做版本值门禁，以便服务端先完成凭据校验。
 */
export function validateHandshakeRequestShape(input: unknown): HandshakeRequest {
  const surface = REQUEST_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, HANDSHAKE_REQUEST_FIELDS);

  const schemaVersion = requireInteger(
    surface,
    'schemaVersion',
    requireFieldPresent(surface, value, 'schemaVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  const protocolVersion = requireInteger(
    surface,
    'protocolVersion',
    requireFieldPresent(surface, value, 'protocolVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );

  const hostInstanceId = requireString(
    surface,
    'hostInstanceId',
    requireFieldPresent(surface, value, 'hostInstanceId'),
  );
  if (!isUuidV4(hostInstanceId)) {
    throw new HostProtocolError('invalid_input', surface.operation, 'hostInstanceId 必须是规范 UUID v4', {
      details: { field: 'request.hostInstanceId', reason: 'invalid_uuid_v4' },
    });
  }

  const dataRootIdentity = requireString(
    surface,
    'dataRootIdentity',
    requireFieldPresent(surface, value, 'dataRootIdentity'),
  );
  if (!isSha256Hex(dataRootIdentity)) {
    throw new HostProtocolError('invalid_input', surface.operation, 'dataRootIdentity 必须是 64 位小写十六进制 SHA-256', {
      details: { field: 'request.dataRootIdentity', reason: 'invalid_sha256_hex' },
    });
  }

  return { schemaVersion, protocolVersion, hostInstanceId, dataRootIdentity };
}

/** §8 顺序第 4/5 步：schema 未知 → 400；协议不兼容 → 426（details 给支持版本）。 */
export function ensureHandshakeVersionCompatibility(request: HandshakeRequest): void {
  // v5 is the immediately previous lifecycle schema. It remains accepted for
  // already deployed clients; the response echoes that request version so the
  // client and Host keep the same capability shape during the handshake.
  if (request.schemaVersion !== CURRENT_SCHEMA_VERSION && request.schemaVersion !== 5) {
    throw new HostProtocolError(
      'unsupported_schema_version',
      'host.handshake',
      '不支持的消息 schema 版本',
      { details: { supportedSchemaVersions: [CURRENT_SCHEMA_VERSION, 5] } },
    );
  }
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(request.protocolVersion)) {
    throw new HostProtocolError(
      'protocol_incompatible',
      'host.handshake',
      'Host 协议版本不兼容',
      { details: { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] } },
    );
  }
}

/** 结构 + 版本门禁（传输层在凭据校验通过后调用）。 */
export function validateHandshakeRequest(input: unknown): HandshakeRequest {
  const request = validateHandshakeRequestShape(input);
  ensureHandshakeVersionCompatibility(request);
  return request;
}

/** §8 握手成功响应体。 */
export interface HandshakeResponse {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly lifecycleState: LifecycleState;
  readonly startedAt: string;
  readonly capabilities: HostCapabilities;
}

export interface HandshakeResponseExpectation {
  readonly expectedHostInstanceId: string;
  readonly expectedDataRootIdentity: string;
}

const RESPONSE_SURFACE: ValidationSurface = {
  operation: 'host.handshake',
  malformedCode: 'response_malformed',
  subject: 'response',
};

const HANDSHAKE_RESPONSE_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'hostInstanceId',
  'dataRootIdentity',
  'lifecycleState',
  'startedAt',
  'capabilities',
] as const;

function requireStringSetEqual(
  surface: ValidationSurface,
  field: string,
  value: unknown,
  expected: readonly string[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HostProtocolError('response_malformed', surface.operation, `${field} 必须是字符串数组`, {
      details: { field: `response.${field}`, reason: 'invalid_string_array' },
    });
  }
  const actual = value as string[];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (actual.length !== actualSet.size || actual.some((item) => !expectedSet.has(item)) || actualSet.size !== expectedSet.size) {
    throw new HostProtocolError('response_malformed', surface.operation, `${field} 与冻结能力声明不一致`, {
      details: { field: `response.${field}`, reason: 'capability_mismatch' },
    });
  }
}

function validateCapabilities(input: unknown): HostCapabilities {
  const surface = RESPONSE_SURFACE;
  if (!isPlainObject(input)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities 必须是 JSON 对象', {
      details: { field: 'response.capabilities', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.capabilities' }, input, [
    'lifecycleRoutes',
    'stop',
    'application',
  ]);

  requireStringSetEqual(
    surface,
    'capabilities.lifecycleRoutes',
    input.lifecycleRoutes,
    LIFECYCLE_ROUTE_NAMES,
  );

  if (!isPlainObject(input.stop)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.stop 必须是 JSON 对象', {
      details: { field: 'response.capabilities.stop', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.capabilities.stop' }, input.stop, [
    'modes',
    'idempotency',
    'activityScope',
  ]);
  requireStringSetEqual(
    surface,
    'capabilities.stop.modes',
    input.stop.modes,
    CURRENT_HOST_CAPABILITIES.stop.modes,
  );
  if (input.stop.idempotency !== CURRENT_HOST_CAPABILITIES.stop.idempotency) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.stop.idempotency 与冻结声明不一致', {
      details: { field: 'response.capabilities.stop.idempotency', reason: 'capability_mismatch' },
    });
  }
  if (input.stop.activityScope !== CURRENT_HOST_CAPABILITIES.stop.activityScope) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.stop.activityScope 与冻结声明不一致', {
      details: { field: 'response.capabilities.stop.activityScope', reason: 'capability_mismatch' },
    });
  }

  // P02-2 §11.3 结构化应用能力视图：只接受 Host 实际接线的冻结清单；
  // F-012 起 events 为冻结的 SSE 结构化形态，任何伪称一律拒绝。
  const application = input.application;
  if (!isPlainObject(application)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.application 必须是 JSON 对象', {
      details: { field: 'response.capabilities.application', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.capabilities.application' }, application, [
    'commands',
    'queries',
    'events',
  ]);
  requireStringSetEqual(
    surface,
    'capabilities.application.commands',
    application.commands,
    hostCapabilitiesForDelivery(Array.isArray(application.commands) &&
      FEATURE_DELIVERY_COMMAND_CAPABILITIES.some(command => (application.commands as unknown[]).includes(command)),
      Array.isArray(application.commands) && BATCH_DELIVERY_COMMAND_CAPABILITIES.some(command => (application.commands as unknown[]).includes(command))).application.commands,
  );
  requireStringSetEqual(
    surface,
    'capabilities.application.queries',
    application.queries,
    hostCapabilitiesForDelivery(false, false, Array.isArray(application.queries) && application.queries.includes('execution.batch.delivery.get'),
      KNOWLEDGE_QUERY_CAPABILITIES.filter(query => Array.isArray(application.queries) && application.queries.includes(query))).application.queries,
  );
  if (Array.isArray(application.commands) && BATCH_DELIVERY_COMMAND_CAPABILITIES.some(command => (application.commands as unknown[]).includes(command))
    && (!Array.isArray(application.queries) || !application.queries.includes('execution.batch.delivery.get'))) {
    throw new HostProtocolError('response_malformed', surface.operation, 'Batch 命令缺少配套查询能力', { details: { reason: 'capability_mismatch' } });
  }
  const events = application.events;
  if (!isPlainObject(events)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.application.events 必须是 JSON 对象', {
      details: { field: 'response.capabilities.application.events', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.capabilities.application.events' }, events, [
    'transport',
    'route',
    'scopes',
  ]);
  if (events.transport !== 'sse' || events.route !== EVENTS_ROUTE) {
    throw new HostProtocolError('response_malformed', surface.operation, 'capabilities.application.events 与冻结能力声明不一致', {
      details: { field: 'response.capabilities.application.events', reason: 'capability_mismatch' },
    });
  }
  requireStringSetEqual(
    surface,
    'capabilities.application.events.scopes',
    events.scopes,
    CURRENT_HOST_CAPABILITIES.application.events.scopes,
  );

  return JSON.parse(JSON.stringify(input)) as HostCapabilities;
}

/**
 * 客户端侧严格校验握手响应（§12.2 握手通过前不发业务请求）：
 * 版本门禁 → 实例/数据根双向核验 → 生命周期/能力冻结形态。
 */
export function validateHandshakeResponse(
  input: unknown,
  expectation: HandshakeResponseExpectation,
): HandshakeResponse {
  const surface = RESPONSE_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, HANDSHAKE_RESPONSE_FIELDS);

  const schemaVersion = requireInteger(
    surface,
    'schemaVersion',
    requireFieldPresent(surface, value, 'schemaVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', 'host.handshake', '对端返回了不支持的 schema 版本', {
      details: { supportedSchemaVersions: [CURRENT_SCHEMA_VERSION] },
    });
  }
  const protocolVersion = requireInteger(
    surface,
    'protocolVersion',
    requireFieldPresent(surface, value, 'protocolVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(protocolVersion)) {
    throw new HostProtocolError('protocol_incompatible', 'host.handshake', '对端返回了不兼容的协议版本', {
      details: { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
    });
  }

  const hostInstanceId = requireString(
    surface,
    'hostInstanceId',
    requireFieldPresent(surface, value, 'hostInstanceId'),
  );
  if (!isUuidV4(hostInstanceId)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'hostInstanceId 必须是规范 UUID v4', {
      details: { field: 'response.hostInstanceId', reason: 'invalid_uuid_v4' },
    });
  }
  if (hostInstanceId !== expectation.expectedHostInstanceId) {
    throw new HostProtocolError('instance_mismatch', 'host.handshake', '响应实例与发现文件实例不一致', {
      details: { reason: 'instance_mismatch' },
    });
  }

  const dataRootIdentity = requireString(
    surface,
    'dataRootIdentity',
    requireFieldPresent(surface, value, 'dataRootIdentity'),
  );
  if (!isSha256Hex(dataRootIdentity)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'dataRootIdentity 必须是 64 位小写十六进制 SHA-256', {
      details: { field: 'response.dataRootIdentity', reason: 'invalid_sha256_hex' },
    });
  }
  if (dataRootIdentity !== expectation.expectedDataRootIdentity) {
    throw new HostProtocolError('data_root_mismatch', 'host.handshake', '响应数据根身份与本地规范根不一致', {
      details: { reason: 'data_root_mismatch' },
    });
  }

  const lifecycleState = requireString(
    surface,
    'lifecycleState',
    requireFieldPresent(surface, value, 'lifecycleState'),
  );
  if (!isLifecycleState(lifecycleState)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'lifecycleState 不是受支持的线协议状态', {
      details: { field: 'response.lifecycleState', reason: 'invalid_lifecycle_state' },
    });
  }

  const startedAt = requireString(surface, 'startedAt', requireFieldPresent(surface, value, 'startedAt'));
  if (!isIsoUtcDateTime(startedAt)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'startedAt 必须是以 Z 结尾的 ISO 8601 UTC 时间', {
      details: { field: 'response.startedAt', reason: 'invalid_iso_utc_datetime' },
    });
  }

  const capabilities = validateCapabilities(requireFieldPresent(surface, value, 'capabilities'));

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId,
    dataRootIdentity,
    lifecycleState,
    startedAt,
    capabilities,
  };
}
