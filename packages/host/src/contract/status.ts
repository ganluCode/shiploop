/**
 * F-002 状态契约（GET /v1/host/status）：响应类型与运行时校验（纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §9（只读、零副作用状态查询）。
 *
 * status 永远是服务端响应（请求侧无请求体）；客户端对其做与握手相同的版本门禁
 * 与实例/数据根双向核验，结构畸形归 response_malformed。P02-1 生产 activities
 * 恒为 0，但校验接受非负整数（F-008 受控假活动经真实 HTTP 返回非 0 值）。
 */
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js';
import { HostProtocolError } from './errors.js';
import type { HandshakeResponseExpectation } from './handshake.js';
import { isIsoUtcDateTime, isSha256Hex, isUuidV4 } from './identifiers.js';
import { isLifecycleState, type LifecycleState } from './lifecycle.js';
import { MAX_PID } from './discovery.js';
import {
  isPlainObject,
  requireBoolean,
  requireExactKeys,
  requireFieldPresent,
  requireInteger,
  requireObject,
  requireString,
  type ValidationSurface,
} from './validation.js';

/** 停止操作状态（§9/§10.4）。 */
export const STOP_OPERATION_STATUSES = ['accepted', 'completed', 'rejected'] as const;
export type StopOperationStatus = (typeof STOP_OPERATION_STATUSES)[number];

/** 停止操作所处阶段（§9）。 */
export const STOP_STATES = ['quiescing', 'stopping', 'resource_busy'] as const;
export type StopState = (typeof STOP_STATES)[number];

/** stop.reasonCode 受控枚举（§7.3 details 只含受控枚举）。 */
export const STOP_REASON_CODES = ['quiesce_not_confirmed', 'stop_in_progress'] as const;
export type StopReasonCode = (typeof STOP_REASON_CODES)[number];

/** §9 停止操作视图。 */
export interface StopOperationView {
  readonly commandId: string;
  readonly status: StopOperationStatus;
  readonly stopState: StopState;
  readonly replayed: boolean;
  readonly reasonCode?: StopReasonCode;
}

/** §9 status 成功响应体。 */
export interface HostStatusResponse {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly lifecycleState: LifecycleState;
  readonly pid: number;
  readonly startedAt: string;
  readonly activities: { readonly accepted: number; readonly quiescing: number };
  readonly stop: StopOperationView | null;
}

const STATUS_SURFACE: ValidationSurface = {
  operation: 'host.status',
  malformedCode: 'response_malformed',
  subject: 'response',
};

const STATUS_RESPONSE_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'hostInstanceId',
  'dataRootIdentity',
  'lifecycleState',
  'pid',
  'startedAt',
  'activities',
  'stop',
] as const;

function validateStopOperationView(input: unknown): StopOperationView {
  const surface = STATUS_SURFACE;
  if (!isPlainObject(input)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'stop 视图必须是 JSON 对象', {
      details: { field: 'response.stop', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.stop' }, input, [
    'commandId',
    'status',
    'stopState',
    'replayed',
    'reasonCode',
  ]);

  const commandId = requireString(
    { ...surface, subject: 'response.stop' },
    'commandId',
    requireFieldPresent({ ...surface, subject: 'response.stop' }, input, 'commandId'),
  );
  if (!isUuidV4(commandId)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'commandId 必须是规范 UUID v4', {
      details: { field: 'response.stop.commandId', reason: 'invalid_uuid_v4' },
    });
  }

  const status = requireString(
    { ...surface, subject: 'response.stop' },
    'status',
    requireFieldPresent({ ...surface, subject: 'response.stop' }, input, 'status'),
  );
  if (!(STOP_OPERATION_STATUSES as readonly string[]).includes(status)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'stop.status 不是受控枚举', {
      details: { field: 'response.stop.status', reason: 'invalid_enum' },
    });
  }

  const stopState = requireString(
    { ...surface, subject: 'response.stop' },
    'stopState',
    requireFieldPresent({ ...surface, subject: 'response.stop' }, input, 'stopState'),
  );
  if (!(STOP_STATES as readonly string[]).includes(stopState)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'stop.stopState 不是受控枚举', {
      details: { field: 'response.stop.stopState', reason: 'invalid_enum' },
    });
  }

  const replayed = requireBoolean(
    { ...surface, subject: 'response.stop' },
    'replayed',
    requireFieldPresent({ ...surface, subject: 'response.stop' }, input, 'replayed'),
  );

  const view: StopOperationView = {
    commandId,
    status: status as StopOperationStatus,
    stopState: stopState as StopState,
    replayed,
  };

  if (input.reasonCode !== undefined) {
    if (
      typeof input.reasonCode !== 'string' ||
      !(STOP_REASON_CODES as readonly string[]).includes(input.reasonCode)
    ) {
      throw new HostProtocolError('response_malformed', surface.operation, 'stop.reasonCode 不是受控枚举', {
        details: { field: 'response.stop.reasonCode', reason: 'invalid_enum' },
      });
    }
    return { ...view, reasonCode: input.reasonCode as StopReasonCode };
  }
  return view;
}

/**
 * 客户端侧严格校验 status 响应（§9 只读零副作用；与握手相同的版本与身份核验）。
 */
export function validateStatusResponse(
  input: unknown,
  expectation: HandshakeResponseExpectation,
): HostStatusResponse {
  const surface = STATUS_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, STATUS_RESPONSE_FIELDS);

  const schemaVersion = requireInteger(
    surface,
    'schemaVersion',
    requireFieldPresent(surface, value, 'schemaVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', 'host.status', '对端返回了不支持的 schema 版本', {
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
    throw new HostProtocolError('protocol_incompatible', 'host.status', '对端返回了不兼容的协议版本', {
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
    throw new HostProtocolError('instance_mismatch', 'host.status', '响应实例与发现文件实例不一致', {
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
    throw new HostProtocolError('data_root_mismatch', 'host.status', '响应数据根身份与本地规范根不一致', {
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

  const pid = requireInteger(surface, 'pid', requireFieldPresent(surface, value, 'pid'), {
    min: 1,
    max: MAX_PID,
  });

  const startedAt = requireString(surface, 'startedAt', requireFieldPresent(surface, value, 'startedAt'));
  if (!isIsoUtcDateTime(startedAt)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'startedAt 必须是以 Z 结尾的 ISO 8601 UTC 时间', {
      details: { field: 'response.startedAt', reason: 'invalid_iso_utc_datetime' },
    });
  }

  const activitiesInput = requireFieldPresent(surface, value, 'activities');
  if (!isPlainObject(activitiesInput)) {
    throw new HostProtocolError('response_malformed', surface.operation, 'activities 必须是 JSON 对象', {
      details: { field: 'response.activities', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...surface, subject: 'response.activities' }, activitiesInput, [
    'accepted',
    'quiescing',
  ]);
  const accepted = requireInteger(
    { ...surface, subject: 'response.activities' },
    'accepted',
    activitiesInput.accepted,
    { min: 0, max: 2 ** 31 - 1 },
  );
  const quiescing = requireInteger(
    { ...surface, subject: 'response.activities' },
    'quiescing',
    activitiesInput.quiescing,
    { min: 0, max: 2 ** 31 - 1 },
  );

  const stopInput = requireFieldPresent(surface, value, 'stop');
  const stop = stopInput === null ? null : validateStopOperationView(stopInput);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId,
    dataRootIdentity,
    lifecycleState,
    pid,
    startedAt,
    activities: { accepted, quiescing },
    stop,
  };
}
