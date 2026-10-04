/**
 * F-002 身份与摘要纯函数（契约纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md
 * - §3.2 dataRootIdentity = lower_hex(sha256(utf8Bytes(canonicalRoot)))，
 *   Host 与 CLI 必须共用本实现，禁止两边各写一份；
 * - §4.1 hostInstanceId 为 RFC 4122 UUID v4 规范小写字符串；
 * - §5.1 dataRootIdentity 为 64 位小写 hex；
 * - §10.3 requestDigest 基于 stableCanonicalJson（键按 UTF-16 码点递归升序、
 *   无空白、数组保序）。
 *
 * 本模块只用 node:crypto 的确定性哈希，不读时钟、文件系统或用户目录；
 * 不生成凭据（randomBytes 在 F-003 的存储模块），不做任何 I/O。
 */
import { createHash } from 'node:crypto';
import { STOP_MODE_GRACEFUL } from './constants.js';

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 数据根身份：输入是 realpath 的原样返回字符串。
 * 不做大小写折叠或尾斜杠归一——归一责任只属于 realpath（§3.2）。
 *
 * 非字符串/空串/NUL 是调用方编程错误（此时尚未 realpath 成功），直接抛 TypeError。
 */
export function computeDataRootIdentity(canonicalRoot: string): string {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) {
    throw new TypeError('canonicalRoot 必须是非空字符串（realpath 的原样返回值）');
  }
  if (canonicalRoot.includes('\0')) {
    throw new TypeError('canonicalRoot 不允许包含 NUL 字节');
  }
  return sha256Hex(canonicalRoot);
}

/** 规范 UUID v4（RFC 4122）：仅小写、版本位 4、变体位 8/9/a/b（randomUUID 形态）。 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/** ISO 8601 UTC：必须以 Z 结尾（拒绝时区偏移），且是真实日历时间。 */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isIsoUtcDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** 仅接受 JSON 普通对象（拒绝数组、null、类实例），与 Core 校验约定一致。 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 稳定规范 JSON（§10.3）：
 * - 对象键按 UTF-16 码点递归升序（Array.prototype.sort 默认比较即 UTF-16 码元序）；
 * - 无任何空白、UTF-8 紧凑 JSON；数组保序；
 * - 只接受 JSON 安全的普通数据（非有限数、bigint、函数、符号、非普通对象一律抛错），
 *   不静默把 NaN 序列化成 null。
 */
export function stableCanonicalJson(value: unknown): string {
  return stringifyStable(value);
}

function stringifyStable(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('规范 JSON 不接受非有限数（NaN/Infinity）');
    }
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value === true ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyStable(item)).join(',')}]`;
  }
  if (type === 'object') {
    if (!isPlainJsonObject(value)) {
      throw new TypeError('规范 JSON 只接受普通 JSON 对象');
    }
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stringifyStable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`规范 JSON 不接受 ${type} 值`);
}

/** §10.1 停止选项（P02-1 唯一形态；省略等价于 graceful）。 */
export interface StopOptions {
  readonly mode: typeof STOP_MODE_GRACEFUL;
}

/** §10.3 requestDigest：sha256(stableCanonicalJson({commandId, hostInstanceId, options}))。 */
export function computeStopRequestDigest(
  commandId: string,
  hostInstanceId: string,
  options: StopOptions,
): string {
  const canonical = stableCanonicalJson({ commandId, hostInstanceId, options });
  return sha256Hex(canonical);
}
