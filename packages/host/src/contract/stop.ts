/**
 * F-002 显式停止契约（POST /v1/host/stop）：请求/视图类型、运行时校验与摘要。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §10（版本化 stop）：
 * - §10.1 请求形状：commandId（UUID v4）、hostInstanceId（必填预期实例）、
 *   requestDigest（64 hex）、options 可省略（等价 {mode:'graceful'}）；
 * - §10.1 命名未实现能力（mode 非 graceful、cancelWorkers、killProcessTree、
 *   cancelWork）→ unsupported(501)，绝不默默执行其他控制行为；其他未知字段
 *   仍为 invalid_input(400)；
 * - §10.3 服务端必须重新计算 requestDigest 并核对，不信任客户端自报；
 * - §10.4/§10.5 停止视图枚举与最终形态；幂等去重是 F-008 的进程内行为，
 *   本模块只提供形状/摘要校验，不建持久回执表。
 */
import {
  CURRENT_SCHEMA_VERSION,
  STOP_MODE_GRACEFUL,
  SUPPORTED_STOP_MODES,
} from './constants.js';
import { HostProtocolError } from './errors.js';
import { computeStopRequestDigest, isSha256Hex, isUuidV4, type StopOptions } from './identifiers.js';
import { STOP_OPERATION_STATUSES, STOP_REASON_CODES, STOP_STATES } from './status.js';
import type { StopOperationStatus, StopReasonCode, StopState } from './status.js';
import {
  isPlainObject,
  requireExactKeys,
  requireFieldPresent,
  requireInteger,
  requireObject,
  requireString,
  type ValidationSurface,
} from './validation.js';

const STOP_SURFACE: ValidationSurface = {
  operation: 'host.stop',
  malformedCode: 'invalid_input',
  subject: 'request',
};

/**
 * 协议中被点名、但 P02-1 不实现的停止能力名（§10.1）。
 * 出现在请求顶层或 options 中 → 501 unsupported（而非 400 未知字段）。
 */
export const RECOGNIZED_UNSUPPORTED_STOP_CAPABILITIES = [
  'cancelWorkers',
  'killProcessTree',
  'cancelWork',
] as const;

const STOP_REQUEST_FIELDS = [
  'schemaVersion',
  'commandId',
  'hostInstanceId',
  'requestDigest',
  'options',
  ...RECOGNIZED_UNSUPPORTED_STOP_CAPABILITIES,
] as const;

const STOP_OPTIONS_FIELDS = ['mode', ...RECOGNIZED_UNSUPPORTED_STOP_CAPABILITIES] as const;

/** 通过结构与能力校验的 stop 请求（options 已缺省补全）。 */
export interface ValidatedStopRequest {
  readonly schemaVersion: number;
  readonly commandId: string;
  readonly hostInstanceId: string;
  readonly requestDigest: string;
  readonly options: StopOptions;
}

function unsupportedStopCapability(operation: 'host.stop', capability: string): never {
  throw new HostProtocolError('unsupported', operation, `请求命名了未实现的停止能力：${capability}`, {
    details: {
      unsupportedCapability: capability,
      supportedModes: [...SUPPORTED_STOP_MODES],
      activityScope: 'idle-only',
    },
  });
}

function normalizeStopOptions(input: unknown): StopOptions {
  if (input === undefined) {
    return { mode: STOP_MODE_GRACEFUL };
  }
  if (!isPlainObject(input)) {
    throw new HostProtocolError('invalid_input', 'host.stop', 'options 必须是 JSON 对象', {
      details: { field: 'request.options', reason: 'invalid_object' },
    });
  }
  requireExactKeys({ ...STOP_SURFACE, subject: 'request.options' }, input, STOP_OPTIONS_FIELDS);
  for (const capability of RECOGNIZED_UNSUPPORTED_STOP_CAPABILITIES) {
    if (Object.prototype.hasOwnProperty.call(input, capability)) {
      unsupportedStopCapability('host.stop', capability);
    }
  }
  const mode = requireFieldPresent({ ...STOP_SURFACE, subject: 'request.options' }, input, 'mode');
  if (typeof mode !== 'string') {
    throw new HostProtocolError('invalid_input', 'host.stop', 'options.mode 必须是字符串', {
      details: { field: 'request.options.mode', reason: 'invalid_type' },
    });
  }
  if (mode !== STOP_MODE_GRACEFUL) {
    unsupportedStopCapability('host.stop', `mode:${mode}`);
  }
  return { mode: STOP_MODE_GRACEFUL };
}

/**
 * §10.1 结构与能力校验（不含实例身份比对与版本门禁顺序编排）：
 * 精确键、UUID、64 hex；未实现能力 → unsupported；未知字段 → invalid_input。
 * options 缺省时补全为 {mode:'graceful'}。
 */
export function validateStopRequestShape(input: unknown): ValidatedStopRequest {
  const surface = STOP_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, STOP_REQUEST_FIELDS);

  // 被点名的未实现能力即使类型/位置怪异也优先返回 unsupported（不默默执行）。
  for (const capability of RECOGNIZED_UNSUPPORTED_STOP_CAPABILITIES) {
    if (Object.prototype.hasOwnProperty.call(value, capability)) {
      unsupportedStopCapability('host.stop', capability);
    }
  }

  const schemaVersion = requireInteger(
    surface,
    'schemaVersion',
    requireFieldPresent(surface, value, 'schemaVersion'),
    { min: 1, max: 2 ** 31 - 1 },
  );
  const commandId = requireString(surface, 'commandId', requireFieldPresent(surface, value, 'commandId'));
  if (!isUuidV4(commandId)) {
    throw new HostProtocolError('invalid_input', 'host.stop', 'commandId 必须是规范 UUID v4', {
      details: { field: 'request.commandId', reason: 'invalid_uuid_v4' },
    });
  }
  const hostInstanceId = requireString(
    surface,
    'hostInstanceId',
    requireFieldPresent(surface, value, 'hostInstanceId'),
  );
  if (!isUuidV4(hostInstanceId)) {
    throw new HostProtocolError('invalid_input', 'host.stop', 'hostInstanceId 必须是规范 UUID v4', {
      details: { field: 'request.hostInstanceId', reason: 'invalid_uuid_v4' },
    });
  }
  const requestDigest = requireString(
    surface,
    'requestDigest',
    requireFieldPresent(surface, value, 'requestDigest'),
  );
  if (!isSha256Hex(requestDigest)) {
    throw new HostProtocolError('invalid_input', 'host.stop', 'requestDigest 必须是 64 位小写十六进制 SHA-256', {
      details: { field: 'request.requestDigest', reason: 'invalid_sha256_hex' },
    });
  }

  const options = normalizeStopOptions(value.options);

  return { schemaVersion, commandId, hostInstanceId, requestDigest, options };
}

/** 消息 schema 版本门禁（未知 → unsupported_schema_version，不降级）。 */
export function ensureStopRequestSupported(request: ValidatedStopRequest): void {
  if (request.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', 'host.stop', '不支持的消息 schema 版本', {
      details: { supportedSchemaVersions: [CURRENT_SCHEMA_VERSION] },
    });
  }
}

/**
 * §10.1 预期实例核对：stop 请求的 hostInstanceId 必须是当前持锁实例。
 * 错误实例不能停止当前 Host（零副作用），由调用方（F-008）在任何收尾动作前执行。
 * 这是纯比对，不读取运行态之外的任何信息。
 */
export function assertStopTargetsCurrentInstance(
  request: Pick<ValidatedStopRequest, 'hostInstanceId'>,
  currentHostInstanceId: string,
): void {
  if (!isUuidV4(currentHostInstanceId)) {
    throw new HostProtocolError('internal', 'host.stop', '当前 Host 实例身份非法', {
      details: { reason: 'invalid_current_instance' },
    });
  }
  if (request.hostInstanceId !== currentHostInstanceId) {
    throw new HostProtocolError('instance_mismatch', 'host.stop', '停止请求的目标实例与当前 Host 不一致', {
      details: { reason: 'instance_mismatch' },
    });
  }
}

/** §10.3 服务端重算并核对摘要；不匹配 → request_digest_mismatch（不回显任一摘要）。 */
export function verifyStopRequestDigest(request: ValidatedStopRequest): void {
  const expected = computeStopRequestDigest(
    request.commandId,
    request.hostInstanceId,
    request.options,
  );
  if (expected !== request.requestDigest) {
    throw new HostProtocolError('request_digest_mismatch', 'host.stop', '停止请求摘要核对失败', {
      details: { reason: 'request_digest_mismatch' },
    });
  }
}

/**
 * 服务端完整纯校验：结构/能力 → 版本 → 摘要。
 * 实例身份比对（instance_mismatch）、幂等矩阵与生命周期前置条件由 F-008
 * 持当前实例状态编排，本模块不读取任何运行态。
 */
export function validateStopRequest(input: unknown): ValidatedStopRequest {
  const request = validateStopRequestShape(input);
  ensureStopRequestSupported(request);
  verifyStopRequestDigest(request);
  return request;
}

/** §10.5 POST /v1/host/stop 响应视图（停止结果/进度）。 */
export interface StopResultView {
  readonly commandId: string;
  readonly status: StopOperationStatus;
  readonly stopState: StopState;
  readonly replayed: boolean;
  readonly reasonCode?: StopReasonCode;
}

export interface StopResultViewExpectation {
  readonly expectedCommandId?: string;
}

const RESULT_SURFACE: ValidationSurface = {
  operation: 'host.stop',
  malformedCode: 'response_malformed',
  subject: 'response',
};

/** 客户端侧严格校验 stop 响应视图（§10.5 最终形态/§10.4 重放形态）。 */
export function validateStopResultView(
  input: unknown,
  expectation: StopResultViewExpectation = {},
): StopResultView {
  const surface = RESULT_SURFACE;
  const value = requireObject(surface, input);
  requireExactKeys(surface, value, ['commandId', 'status', 'stopState', 'replayed', 'reasonCode']);

  const commandId = requireString(surface, 'commandId', requireFieldPresent(surface, value, 'commandId'));
  if (!isUuidV4(commandId)) {
    throw new HostProtocolError('response_malformed', 'host.stop', 'commandId 必须是规范 UUID v4', {
      details: { field: 'response.commandId', reason: 'invalid_uuid_v4' },
    });
  }
  if (expectation.expectedCommandId !== undefined && commandId !== expectation.expectedCommandId) {
    throw new HostProtocolError('response_malformed', 'host.stop', '响应 commandId 与请求不一致', {
      details: { field: 'response.commandId', reason: 'unexpected_command' },
    });
  }

  const status = requireString(surface, 'status', requireFieldPresent(surface, value, 'status'));
  if (!(STOP_OPERATION_STATUSES as readonly string[]).includes(status)) {
    throw new HostProtocolError('response_malformed', 'host.stop', 'status 不是受控枚举', {
      details: { field: 'response.status', reason: 'invalid_enum' },
    });
  }
  const stopState = requireString(surface, 'stopState', requireFieldPresent(surface, value, 'stopState'));
  if (!(STOP_STATES as readonly string[]).includes(stopState)) {
    throw new HostProtocolError('response_malformed', 'host.stop', 'stopState 不是受控枚举', {
      details: { field: 'response.stopState', reason: 'invalid_enum' },
    });
  }
  const replayedInput = requireFieldPresent(surface, value, 'replayed');
  if (typeof replayedInput !== 'boolean') {
    throw new HostProtocolError('response_malformed', 'host.stop', 'replayed 必须是布尔值', {
      details: { field: 'response.replayed', reason: 'invalid_type' },
    });
  }

  const view: StopResultView = {
    commandId,
    status: status as StopOperationStatus,
    stopState: stopState as StopState,
    replayed: replayedInput,
  };
  if (value.reasonCode !== undefined) {
    if (
      typeof value.reasonCode !== 'string' ||
      !(STOP_REASON_CODES as readonly string[]).includes(value.reasonCode)
    ) {
      throw new HostProtocolError('response_malformed', 'host.stop', 'reasonCode 不是受控枚举', {
        details: { field: 'response.reasonCode', reason: 'invalid_enum' },
      });
    }
    return { ...view, reasonCode: value.reasonCode as StopReasonCode };
  }
  return view;
}
