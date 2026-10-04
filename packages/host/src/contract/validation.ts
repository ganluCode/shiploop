/**
 * F-002 契约运行时校验原语（纯函数，无 I/O）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §5.1（未知字段一律拒绝）、
 * §7.3（脱敏结构化错误）。TypeScript 类型不能替代运行时校验：所有跨越进程边界
 * 的外部 JSON（unknown）必须先经本模块断言，校验失败抛 HostProtocolError。
 *
 * 脱敏约定：details 只携带 field/reason/receivedType，绝不记录收到的值，
 * 错误消息为固定模板，不回显请求体、发现文件原文或任何凭据。
 */
import { MAX_HTTP_BODY_BYTES } from './constants.js';
import { HostProtocolError } from './errors.js';
import type { HostErrorCode, HostOperation } from './errors.js';

/**
 * 校验面：不同输入面的「结构非法」使用不同错误码：
 * - HTTP 请求体：invalid_input（400）；
 * - 本地发现文件：invalid_discovery（仅客户端码，退出码 2 类）；
 * - 对端响应体：response_malformed（仅客户端码）。
 */
export interface ValidationSurface {
  readonly operation: HostOperation;
  readonly malformedCode: HostErrorCode;
  /** 顶层对象名，用于 field 前缀（discovery/request/response/options）。 */
  readonly subject: string;
}

export function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** 抛出带 field/reason 的结构化错误；默认用该面的结构错误码，可指定更精确的码。 */
export function failValidation(
  surface: ValidationSurface,
  field: string,
  reason: string,
  received?: unknown,
  code: HostErrorCode = surface.malformedCode,
): never {
  throw new HostProtocolError(code, surface.operation, `${surface.subject}.${field} ${reason}`, {
    details: {
      field: `${surface.subject}.${field}`,
      reason,
      ...(received !== undefined ? { receivedType: describeValueType(received) } : {}),
    },
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireObject(
  surface: ValidationSurface,
  value: unknown,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    failValidation(surface, '', '必须是 JSON 对象', value);
  }
  return value;
}

/** 精确白名单：未知键（含 __proto__/constructor 自身属性）一律拒绝。 */
export function requireExactKeys(
  surface: ValidationSurface,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      failValidation(surface, key, '包含未知字段（版本契约不接受前向宽容字段）');
    }
  }
}

export function requireFieldPresent(
  surface: ValidationSurface,
  value: Record<string, unknown>,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    failValidation(surface, field, '缺少必填字段');
  }
  return value[field];
}

export function requireString(
  surface: ValidationSurface,
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string') {
    failValidation(surface, field, '必须是字符串', value);
  }
  return value;
}

export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

export function requireInteger(
  surface: ValidationSurface,
  field: string,
  value: unknown,
  range: IntegerRange,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    failValidation(surface, field, '必须是整数', value);
  }
  if (value < range.min || value > range.max) {
    failValidation(surface, field, `必须是 ${range.min}..${range.max} 范围内的整数`, value);
  }
  return value;
}

export function requireBoolean(
  surface: ValidationSurface,
  field: string,
  value: unknown,
): boolean {
  if (typeof value !== 'boolean') {
    failValidation(surface, field, '必须是布尔值', value);
  }
  return value;
}

/**
 * 解析 JSON 文本（HTTP 请求体）：畸形 JSON → invalid_input（400），
 * 不回显原文。非字符串输入同样拒绝。
 */
export function parseJsonBody(text: unknown, operation: HostOperation): unknown {
  if (typeof text !== 'string') {
    throw new HostProtocolError('invalid_input', operation, '请求体必须是 UTF-8 JSON 文本', {
      details: { reason: 'invalid_body_type' },
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HostProtocolError('invalid_input', operation, '请求体不是合法 JSON', {
      details: { reason: 'malformed_json' },
    });
  }
}

/** §7.2 体积预算：超限 → request_too_large(413)，details 只含非秘密数值。 */
export function assertBodyWithinLimit(byteLength: number, operation: HostOperation): void {
  if (typeof byteLength !== 'number' || byteLength < 0 || !Number.isFinite(byteLength)) {
    throw new HostProtocolError('invalid_input', operation, '请求体长度非法', {
      details: { reason: 'invalid_length' },
    });
  }
  if (byteLength > MAX_HTTP_BODY_BYTES) {
    throw new HostProtocolError(
      'request_too_large',
      operation,
      `请求体超过 ${MAX_HTTP_BODY_BYTES} 字节上限`,
      { details: { limitBytes: MAX_HTTP_BODY_BYTES, receivedBytes: byteLength } },
    );
  }
}
